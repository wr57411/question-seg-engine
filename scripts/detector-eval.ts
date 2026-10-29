// 两源检测器评估：MinerU vs OXR 的分歧 + 结构规则能否低成本发现坏题。
// 不用金标参与检测；金标只用于事后量化（召回 / 复核率 / 误报）。
import { existsSync, readFileSync } from "node:fs";
import { normalizeLayout } from "../src/normalize.js";
import { ruleStrategy } from "../src/strategy.js";
import { normForScore, similarity, type GoldDoc } from "./score.js";
import type { Question } from "../src/types.js";

const DOCS = [
  "教材基础练 磁场",
  "物理_教材基础练 电路",
  "物理_教材基础练 曲线运动",
  "物理_教材基础练万有引力",
  "物理_教材基础练 运动和力",
  "物理_教材基础练机械能守恒定律",
];

function qText(q: Question): string {
  return `${q.stem}\n${(q.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`;
}

function stemBad(q: Question): boolean {
  const lines = (q.stem ?? "").split("\n").slice(1);
  return lines.some((l) => {
    const t = l.trim();
    return /^\d{1,3}\s*[\[【「]/.test(t) || /^[A-D][.、．]/.test(t) || /^(教材|答案|☑|▶|变式|第\s*\d+\s*讲)/.test(t);
  });
}

function optionsBad(q: Question): boolean {
  return (q.options ?? []).some((o) =>
    /^\s*\d{1,3}\s*[\[【「]/m.test(o.text ?? "") ||
    /教材模型|教材素材变式|教材知识萃取|答案\s*P?\d+/.test(o.text ?? ""),
  );
}

function optionsComplete(q: Question): boolean {
  const keys = (q.options ?? []).map((o) => o.key);
  return keys.length >= 3 && keys.length === new Set(keys).size;
}

/** 页内贪心一对一匹配（按归一化题干相似度） */
function matchPage(mineru: Question[], oxr: Question[]): { m: Question; o: Question; sim: number }[] {
  const pairs: { m: Question; o: Question; sim: number }[] = [];
  const usedM = new Set<number>();
  const usedO = new Set<number>();
  const all: { i: number; j: number; sim: number }[] = [];
  for (let i = 0; i < mineru.length; i++) {
    for (let j = 0; j < oxr.length; j++) {
      const sim = similarity(mineru[i]!.stem ?? "", oxr[j]!.stem ?? "");
      if (sim > 0.2) all.push({ i, j, sim });
    }
  }
  all.sort((a, b) => b.sim - a.sim);
  for (const p of all) {
    if (usedM.has(p.i) || usedO.has(p.j)) continue;
    usedM.add(p.i);
    usedO.add(p.j);
    pairs.push({ m: mineru[p.i]!, o: oxr[p.j]!, sim: p.sim });
  }
  return pairs;
}

function detectFlags(mineru: Question[], oxr: Question[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  const add = (q: Question, f: string) => {
    const k = `${q.source.pageIndex}:${q.number}`;
    flags.set(k, [...(flags.get(k) ?? []), f]);
  };
  for (const q of mineru) {
    if (stemBad(q)) add(q, "mineru.stemBad");
    if (optionsBad(q)) add(q, "mineru.optsBad");
    if (!optionsComplete(q)) add(q, "mineru.optsIncomplete");
  }
  for (const q of oxr) {
    if (stemBad(q)) add(q, "oxr.stemBad");
    if (optionsBad(q)) add(q, "oxr.optsBad");
    if (!optionsComplete(q)) add(q, "oxr.optsIncomplete");
  }
  for (const page of new Set([...mineru.map((q) => q.source.pageIndex), ...oxr.map((q) => q.source.pageIndex)])) {
    const mp = mineru.filter((q) => q.source.pageIndex === page);
    const op = oxr.filter((q) => q.source.pageIndex === page);
    const pairs = matchPage(mp, op);
    for (const p of pairs) {
      const sim = similarity(normForScore(p.m.stem ?? ""), normForScore(p.o.stem ?? ""));
      if (sim < STEM_T) {
        add(p.m, "stem.disagree");
        add(p.o, "stem.disagree");
      }
      const mk = new Map((p.m.options ?? []).map((o) => [o.key, o.text]));
      const ok = new Map((p.o.options ?? []).map((o) => [o.key, o.text]));
      if (mk.size !== ok.size) {
        add(p.m, "opts.count");
        add(p.o, "opts.count");
      } else {
        for (const [k, t] of mk) {
          const t2 = ok.get(k);
          if (t2 === undefined || similarity(t ?? "", t2 ?? "") < OPT_T) {
            add(p.m, "opts.disagree");
            add(p.o, "opts.disagree");
            break;
          }
        }
      }
    }
    for (const q of mp) if (!pairs.some((p) => p.m === q)) add(q, "mineru.unmatched");
    for (const q of op) if (!pairs.some((p) => p.o === q)) add(q, "oxr.unmatched");
  }
  return flags;
}

let BAD_T = 0.95;
let STEM_T = 0.9;
let OPT_T = 0.85;
function srcBad(gold: { stem: string; options?: { key: string; text: string }[] }, q: Question | undefined): boolean {
  if (!q) return true;
  const g = `${gold.stem}\n${(gold.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`;
  return similarity(g, qText(q)) < BAD_T;
}

type Row = { doc: string; gold: number; unionBad: number; flagged: number; caught: number; reviewRate: number; recall: number; fp: number };

const rows: Row[] = [];
function first(a: string, b: string): string { return existsSync(a) ? a : existsSync(b) ? b : a; }
for (const badT of [0.8, 0.9, 0.95]) {
  for (const stemT of [0.8, 0.9]) {
    for (const optT of [0.8, 0.85]) {
      BAD_T = badT; STEM_T = stemT; OPT_T = optT;
      let totGold = 0, totBad = 0, totFlag = 0, totCaught = 0, totFpGood = 0, totGood = 0;
      const perDoc: string[] = [];
      for (const doc of DOCS) {
        const gold = JSON.parse(readFileSync(`gold/${doc}.pilot.json`, "utf8")) as GoldDoc;
        const mineru = ruleStrategy.segment(normalizeLayout(JSON.parse(readFileSync(first(`data/out/${doc}-MinerU/layout.json`, `data/out/${doc}/layout.mineru.json`), "utf8")), `${doc}-MinerU`)).questions;
        const oxr = ruleStrategy.segment(normalizeLayout(JSON.parse(readFileSync(first(`data/out/${doc}-OXR/layout.json`, `data/out/${doc}/layout.oxr.json`), "utf8")), `${doc}-OXR`)).questions;
        const flags = detectFlags(mineru, oxr);
        let unionBad = 0, flagged = 0, caught = 0, fpGood = 0, good = 0;
        for (const gq of gold.questions) {
          const key = `${gq.page}:${gq.number}`;
          const m = mineru.find((q) => q.source.pageIndex === gq.page && q.number === gq.number);
          const o = oxr.find((q) => q.source.pageIndex === gq.page && q.number === gq.number);
          const bad = srcBad(gq, m) || srcBad(gq, o);
          const f = (flags.get(key) ?? []).length > 0;
          if (bad) unionBad++; else good++;
          if (f) flagged++;
          if (bad && f) caught++;
          if (!bad && f) fpGood++;
        }
        const g = gold.questions.length;
        perDoc.push(`${doc.slice(0,6)}:${unionBad}/${flagged}/${caught}`);
        totGold += g; totBad += unionBad; totFlag += flagged; totCaught += caught; totFpGood += fpGood; totGood += good;
      }
      console.log(`bad<${badT} stem<${stemT} opt<${optT} | 金标 ${totGold} 真坏 ${totBad} 标记 ${totFlag} 抓到 ${totCaught} | 复核率 ${(totFlag / totGold * 100).toFixed(1)}% 召回 ${totBad ? (totCaught / totBad * 100).toFixed(1) : 100}% 好题误报 ${totGood ? (totFpGood / totGood * 100).toFixed(1) : 0}% | ${perDoc.join(" ")}`);
      rows.push({ doc: "all", gold: totGold, unionBad: totBad, flagged: totFlag, caught: totCaught, reviewRate: +(totFlag / totGold * 100).toFixed(1), recall: totBad ? +(totCaught / totBad * 100).toFixed(1) : 100, fp: totGood ? +(totFpGood / totGood * 100).toFixed(1) : 0 });
    }
  }
}
