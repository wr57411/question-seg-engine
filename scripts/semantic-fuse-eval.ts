// 语义融合最小原型：按题目/字段对齐 OXR + MinerU，用现有小金标做 go/no-go。
// 只读现有产物，不写回生产管线。
import { existsSync, readFileSync } from "node:fs";
import { normalizeLayout } from "../src/normalize.js";
import { ruleStrategy } from "../src/strategy.js";
import { scoreQuestions, type GoldDoc } from "./score.js";
import type { Question } from "../src/types.js";

const DOCS = [
  "教材基础练 磁场",
  "物理_教材基础练 电路",
  "物理_教材基础练 曲线运动",
  "物理_教材基础练万有引力",
  "物理_教材基础练 运动和力",
  "物理_教材基础练机械能守恒定律",
];

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null;
}

function loadLayout(path: string, id: string) {
  return normalizeLayout(JSON.parse(readFileSync(path, "utf8")), id);
}

function questionsFrom(layoutPath: string, id: string): Question[] {
  return ruleStrategy.segment(loadLayout(layoutPath, id)).questions;
}

function fusedQuestions(doc: string): Question[] {
  const backup = `data/out/${doc}/fused-backup/questions.json`;
  return JSON.parse(readFileSync(existsSync(backup) ? backup : `data/out/${doc}/questions.json`, "utf8"));
}

function optionsBad(q: Question): number {
  return (q.options ?? []).filter((o) => {
    const t = o.text ?? "";
    return /^\s*\d{1,3}\s*[\[【「]/m.test(t) || /教材模型|教材素材变式|教材知识萃取|答案\s*P?\d+/.test(t);
  }).length;
}

function stemBad(q: Question): boolean {
  const lines = (q.stem ?? "").split("\n").slice(1);
  return lines.some((l) => {
    const t = l.trim();
    return (
      /^\d{1,3}\s*[\[【「]/.test(t) ||
      /^[A-D][.、．]/.test(t) ||
      /^(教材|答案|☑|▶|变式|第\s*\d+\s*讲)/.test(t)
    );
  });
}

function optionScore(q: Question): { n: number; keys: string; bad: number; chars: number } {
  const opts = q.options ?? [];
  return {
    n: opts.length,
    keys: opts.map((o) => o.key).join(""),
    bad: optionsBad(q),
    chars: opts.reduce((s, o) => s + (o.text?.length ?? 0), 0),
  };
}

function pickStem(cands: Question[]): Question {
  const clean = cands.filter((q) => !stemBad(q));
  const pool = clean.length ? clean : cands;
  const maxLen = Math.max(...pool.map((q) => q.stem?.length ?? 0));
  // OXR 文字通常更准；但不能短到像截断（<70% 最长）
  const oxr = pool.find((q) => q.source?.file?.includes("-OXR"));
  if (oxr && (oxr.stem?.length ?? 0) >= maxLen * 0.7) return oxr;
  return pool.sort((a, b) => (b.stem?.length ?? 0) - (a.stem?.length ?? 0))[0]!;
}

function pickOptions(cands: Question[]): { options: Question["options"]; from: string } {
  const valid = cands.filter((q) => optionScore(q).n > 0 && optionScore(q).bad === 0);
  const pool = valid.length ? valid : cands.filter((q) => optionScore(q).n > 0);
  if (!pool.length) return { options: [], from: "none" };
  const oxr = pool.find((q) => q.source?.file?.includes("-OXR"));
  const best = [...pool].sort((a, b) => {
    const A = optionScore(a);
    const B = optionScore(b);
    return B.n - A.n || B.chars - A.chars;
  })[0]!;
  if (oxr && optionScore(oxr).n >= optionScore(best).n && optionScore(oxr).bad === 0) {
    return { options: oxr.options ?? [], from: "oxr" };
  }
  return { options: best.options ?? [], from: best.source?.file?.includes("-OXR") ? "oxr" : "mineru" };
}

function semanticFuse(oxr: Question[], mineru: Question[]): { questions: Question[]; stemFrom: Record<string, number>; optFrom: Record<string, number> } {
  const byKey = new Map<string, Question[]>();
  for (const q of [...mineru, ...oxr]) {
    const k = `${q.source.pageIndex}:${q.number}`;
    byKey.set(k, [...(byKey.get(k) ?? []), q]);
  }
  const stemFrom: Record<string, number> = { oxr: 0, mineru: 0 };
  const optFrom: Record<string, number> = { oxr: 0, mineru: 0, none: 0 };
  const out: Question[] = [];
  for (const [key, cands] of byKey) {
    const base = pickStem(cands);
    const stemSource = base.source?.file?.includes("-OXR") ? "oxr" : "mineru";
    stemFrom[stemSource]!++;
    const opt = pickOptions(cands);
    optFrom[opt.from] = (optFrom[opt.from] ?? 0) + 1;
    out.push({ ...base, options: opt.options });
  }
  return { questions: out, stemFrom, optFrom };
}

function structural(qs: Question[]) {
  const seen = new Map<string, number>();
  let dup = 0;
  for (const q of qs) {
    const k = `${q.source.pageIndex}:${q.number}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) dup++;
  }
  return { dup, badStem: qs.filter(stemBad).length, badOpts: qs.filter((q) => optionsBad(q) > 0).length };
}

function row(doc: string, source: string, qs: Question[], gold: GoldDoc) {
  const s = scoreQuestions(doc, gold, qs);
  const st = structural(qs);
  if (source === "Semantic" && (s.strictTextMismatches.length || s.unmatchedGold.length)) {
    console.log(`MIS ${doc} strict=${JSON.stringify(s.strictTextMismatches)} unmatched=${JSON.stringify(s.unmatchedGold)}`);
  }
  return {
    doc,
    source,
    n: qs.length,
    R: +(s.recall * 100).toFixed(1),
    S: s.strictTextMatch === null ? null : +(s.strictTextMatch * 100).toFixed(1),
    O: s.optionCompleteness === null ? null : +(s.optionCompleteness * 100).toFixed(1),
    dup: st.dup,
    badStem: st.badStem,
    badOpts: st.badOpts,
  };
}

const rows: ReturnType<typeof row>[] = [];
for (const doc of DOCS) {
  const gold = JSON.parse(readFileSync(`gold/${doc}.pilot.json`, "utf8")) as GoldDoc;
  const oxrPath = firstExisting([`data/out/${doc}-OXR/layout.json`, `data/out/${doc}/layout.oxr.json`]);
  const mineruPath = firstExisting([`data/out/${doc}-MinerU/layout.json`, `data/out/${doc}/layout.mineru.json`]);
  if (!oxrPath || !mineruPath) {
    console.log(`SKIP ${doc}: oxr=${oxrPath} mineru=${mineruPath}`);
    continue;
  }
  const oxr = questionsFrom(oxrPath, `${doc}-OXR`);
  const mineru = questionsFrom(mineruPath, `${doc}-MinerU`);
  const fused = fusedQuestions(doc);
  const sem = semanticFuse(oxr, mineru);
  for (const [name, qs] of [
    ["MinerU", mineru],
    ["OXR", oxr],
    ["Fused", fused],
    ["Semantic", sem.questions],
  ] as const) {
    rows.push(row(doc, name, qs, gold));
  }
  console.log(
    `SEM ${doc}: stem=${JSON.stringify(sem.stemFrom)} options=${JSON.stringify(sem.optFrom)}`,
  );
}
console.log("\n=== 对照 ===");
console.log("doc | source | n | R | S | O | dup | badStem | badOpts");
for (const r of rows) {
  console.log(`${r.doc} | ${r.source} | ${r.n} | ${r.R} | ${r.S ?? "—"} | ${r.O ?? "—"} | ${r.dup} | ${r.badStem} | ${r.badOpts}`);
}
