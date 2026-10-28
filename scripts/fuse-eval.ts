// scripts/fuse-eval.ts —— 两源融合原型评估：MinerU 几何 + OXR 文本。
//
// 对现有 8 对（data/out/<doc> 与 <doc>-OXR）：
// - 分别跑 MinerU-only / OXR-only / 融合（fuseDocuments）切题；
// - 输出题数/组数/待复核/对齐统计；
// - 对已有金标的文档（gold/*.json）算 recall/严格文本/选项完整；
// - 不写 data/out；结果落 data/fuse/。
//
// 用法：npm run fuse:eval -- --all
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fuseDocuments, type FuseStats } from "../src/fuse.js";
import { normalizeLayout } from "../src/normalize.js";
import { ruleStrategy } from "../src/strategy.js";
import type { Question, SegmentationResult } from "../src/types.js";
import { scoreQuestions, type GoldDoc, type ScoreResult } from "./score.js";

const DOCS = [
  "23必刷题 1 直线运动",
  "23必刷题 2相互作用",
  "23必刷题 3 运动和力的关系",
  "23必刷题 4 曲线运动",
  "23必刷题 光学",
  "动量守恒定律23必刷题",
  "机械能23必刷题",
  "第二章相互作用-答案与解析",
];

function loadGold(): Map<string, GoldDoc> {
  const m = new Map<string, GoldDoc>();
  const dir = join("gold");
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<GoldDoc>;
      if (typeof j.docId === "string" && Array.isArray(j.questions)) m.set(j.docId, j as GoldDoc);
    } catch {
      /* 非金标 */
    }
  }
  return m;
}

function seg(doc: ReturnType<typeof normalizeLayout>): SegmentationResult {
  return ruleStrategy.segment(doc);
}

function statsOf(r: SegmentationResult): { q: number; groups: number; review: number } {
  const groups = new Set(r.questions.map((q) => `${q.chapter}|${q.sectionSeq}`)).size;
  return { q: r.questions.length, groups, review: r.questions.filter((q) => q.status === "needs_review").length };
}

function scoreOrNull(gold: GoldDoc | undefined, qs: Question[]): ScoreResult | null {
  return gold ? scoreQuestions(gold.docId, gold, qs) : null;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtScore(r: ScoreResult | null): string {
  if (!r) return "—";
  return `R${pct(r.recall)} / S${pct(r.strictTextMatch)} / O${pct(r.optionCompleteness)}`;
}

const gold = loadGold();
const rows: {
  doc: string;
  pages: number;
  mineru: { q: number; groups: number; review: number };
  oxr: { q: number; groups: number; review: number };
  fused: { q: number; groups: number; review: number };
  stats: FuseStats;
  sM: ScoreResult | null;
  sO: ScoreResult | null;
  sF: ScoreResult | null;
}[] = [];

mkdirSync(join("data", "fuse"), { recursive: true });
for (const doc of DOCS) {
  const mp = join("data", "out", doc, "layout.json");
  const op = join("data", "out", `${doc}-OXR`, "layout.json");
  if (!existsSync(mp) || !existsSync(op)) {
    console.log(`跳过 ${doc}：缺 MinerU 或 OXR layout`);
    continue;
  }
  const md = normalizeLayout(JSON.parse(readFileSync(mp, "utf8")), doc);
  const od = normalizeLayout(JSON.parse(readFileSync(op, "utf8")), `${doc}-OXR`);
  const rM = seg(md);
  const rO = seg(od);
  const fused = fuseDocuments(md, od);
  const rF = seg(fused.doc);
  const sM = scoreOrNull(gold.get(doc), rM.questions);
  const sO = scoreOrNull(gold.get(doc), rO.questions);
  const sF = scoreOrNull(gold.get(doc), rF.questions);
  rows.push({
    doc,
    pages: md.pages.length,
    mineru: statsOf(rM),
    oxr: statsOf(rO),
    fused: statsOf(rF),
    stats: fused.stats,
    sM,
    sO,
    sF,
  });
  writeFileSync(join("data", "fuse", `${doc}.questions.json`), JSON.stringify(rF.questions, null, 2));
  writeFileSync(
    join("data", "fuse", `${doc}.json`),
    JSON.stringify({ doc, stats: fused.stats, mineru: statsOf(rM), oxr: statsOf(rO), fused: statsOf(rF), scores: { mineru: sM, oxr: sO, fused: sF } }, null, 2),
  );
  console.log(
    `${doc}：MinerU ${statsOf(rM).q} / OXR ${statsOf(rO).q} / 融合 ${statsOf(rF).q} 题` +
      ` · 对齐 ${fused.stats.matched} 改文 ${fused.stats.textChanged} OXR-only ${fused.stats.oxrOnly} MinerU-only ${fused.stats.mineruOnly}` +
      (gold.has(doc) ? ` · 金标 M[${fmtScore(sM)}] O[${fmtScore(sO)}] F[${fmtScore(sF)}]` : ""),
  );
}

const lines = [
  "# 两源融合评估（MinerU 几何 + OXR 文本）",
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| 卷 | 页 | MinerU题 | OXR题 | 融合题 | 融合组 | 融合待复核 | 对齐 | 改文 | OXR-only | MinerU-only | MinerU金标 | OXR金标 | 融合金标 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.doc} | ${r.pages} | ${r.mineru.q} | ${r.oxr.q} | ${r.fused.q} | ${r.fused.groups} | ${r.fused.review} | ${r.stats.matched} | ${r.stats.textChanged} | ${r.stats.oxrOnly} | ${r.stats.mineruOnly} | ${r.stats.lowCoverage} | ${fmtScore(r.sM)} | ${fmtScore(r.sO)} | ${fmtScore(r.sF)} |`,
  ),
  "",
  "> R=recall / S=严格文本匹配 / O=选项完整；金标只覆盖部分文档（partial gold，precision 不计算）。",
  "> 融合 = MinerU 行几何 + OXR 文本（字符级对齐，不按换行点配对）；OXR 独有文字落独立块；",
  "> MinerU 有而 OXR 没收的行保留 MinerU 文本（mineruOnly）；低覆盖 = 已采用 OXR 文本但与 MinerU 原文相似度 <0.8 的块数。",
];
writeFileSync(join("data", "fuse", "report.md"), lines.join("\n"));
console.log(`\n报告：data/fuse/report.md`);
