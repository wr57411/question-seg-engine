// scripts/score.ts —— 金标准评分器：把「系统切题结果」与「独立人工标签」逐题对照。
//
// 为什么先做它：当前只有 needs_review 这个「引擎自己觉得可疑」的代理指标，
// 没有相对原卷的召回/精确/选项/答案指标；没有它，任何「99%」都无法验收。
//
// 设计约束（spec 2026-10-28-batch-book-ingestion-spec.md）：
// - 金标准标签**独立于系统产物**（人工从原卷页图转写），分母只来自标签；
// - 部分金标准（complete:false）只算 recall，不算 precision（避免用系统自己的题数当分母）；
// - 页号用 0-based（与 questions.json 的 source.pageIndex 一致）；
// - 输出 JSON + Markdown；`--all` 扫 `gold/*.json`；`--gate` 才按阈值退出码判红。
//
// 用法：
//   npm run score -- --all
//   npm run score -- --all --gate
//   npm run check:accuracy
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Question } from "../src/types.js";

export interface GoldOption {
  key: string;
  text: string;
}

export interface GoldQuestion {
  /** 0-based 页号（与 source.pageIndex 一致） */
  page: number;
  number: string;
  stem: string;
  options?: GoldOption[];
  answer?: string;
  /** 该题应有的图片数；缺省 = 不评图片召回 */
  imageCount?: number;
}

export interface GoldDoc {
  docId: string;
  /** true = 整本标注（可算 precision）；false = 试点/部分标注（只算 recall） */
  complete: boolean;
  source?: string;
  notes?: string;
  questions: GoldQuestion[];
}

export interface ScoreResult {
  docId: string;
  goldComplete: boolean;
  goldQuestions: number;
  systemQuestions: number;
  matched: number;
  recall: number;
  /** 仅 complete=true 时计算；partial 为 null */
  precision: number | null;
  /** 匹配题中，题干+选项归一化重合 ≥95% 的比例 */
  strictTextMatch: number | null;
  /** 严格文本未达标的匹配题（page 0-based / number / 相似度），用于定位差异 */
  strictTextMismatches: { page: number; number: string; similarity: number }[];
  optionCompleteness: number | null;
  optionCer: number | null;
  answerPairing: number | null;
  imageRecall: number | null;
  needsReviewRate: number;
  autoPass: boolean;
  unmatchedGold: { page: number; number: string }[];
  falsePositives: number | null;
  notes: string[];
}

const REVIEW_THRESHOLD = 0.01;

/** 归一化：去 LaTeX 命令/定界符/空白/标点，只留字面（用于重合与 CER）。 */
export function normForScore(s: string): string {
  return s
    .replace(/\\[A-Za-z]+/g, "")
    .replace(/[\s${}\\]/g, "")
    .replace(/[，。；：、,.;:!?（）()【】《》“”"'']/g, "")
    .toLowerCase();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice 系数（0..1）；空串规则：都空=1，一空=0。 */
export function similarity(a: string, b: string): number {
  const A = normForScore(a);
  const B = normForScore(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;
  const ga = bigrams(A);
  const gb = bigrams(B);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (A.length - 1 + (B.length - 1));
}

function levenshtein(a: string, b: string): number {
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? 0;
}

function qText(q: { stem: string; options?: { key: string; text: string }[] }): string {
  return `${q.stem}\n${(q.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`;
}

function byPageNumber(system: Question[]): Map<string, Question[]> {
  const m = new Map<string, Question[]>();
  for (const q of system) {
    const k = `${q.source.pageIndex}|${q.number}`;
    const arr = m.get(k) ?? [];
    arr.push(q);
    m.set(k, arr);
  }
  return m;
}

/**
 * 纯函数：金标准 vs 系统题。page+number 是题的身份；文本重合单独作为 strictTextMatch。
 * 这样「题存在但内容略偏」和「题根本没切出来」能分开看。
 */
export function scoreQuestions(docId: string, gold: GoldDoc, system: Question[]): ScoreResult {
  const byKey = byPageNumber(system);
  const used = new Set<Question>();
  const matchedPairs: { g: GoldQuestion; s: Question; sim: number }[] = [];
  const unmatchedGold: { page: number; number: string }[] = [];

  for (const g of gold.questions) {
    const cands = (byKey.get(`${g.page}|${g.number}`) ?? []).filter((q) => !used.has(q));
    if (cands.length === 0) {
      unmatchedGold.push({ page: g.page, number: g.number });
      continue;
    }
    cands.sort((a, b) => similarity(qText(g), qText(b)) - similarity(qText(g), qText(a)));
    const s = cands[0]!;
    used.add(s);
    matchedPairs.push({ g, s, sim: similarity(qText(g), qText(s)) });
  }

  const matched = matchedPairs.length;
  const recall = gold.questions.length ? matched / gold.questions.length : 0;
  const precision = gold.complete ? (system.length ? matched / system.length : 0) : null;
  const strictTextMatch = matched
    ? matchedPairs.filter((p) => p.sim >= 0.95).length / matched
    : null;
  const strictTextMismatches = matchedPairs
    .filter((p) => p.sim < 0.95)
    .map((p) => ({ page: p.g.page, number: p.g.number, similarity: Number(p.sim.toFixed(4)) }));

  let goldOpts = 0;
  let hitOpts = 0;
  let cerSum = 0;
  let cerN = 0;
  let goldAnswers = 0;
  let hitAnswers = 0;
  let goldImages = 0;
  let hitImages = 0;

  for (const { g, s } of matchedPairs) {
    for (const go of g.options ?? []) {
      goldOpts++;
      const so = (s.options ?? []).find((o) => o.key === go.key);
      if (!so) continue;
      if (similarity(go.text, so.text) >= 0.8) hitOpts++;
      const a = normForScore(go.text);
      const b = normForScore(so.text);
      cerSum += levenshtein(a, b) / Math.max(1, a.length);
      cerN++;
    }
    if (g.answer) {
      goldAnswers++;
      if (s.answer && similarity(g.answer, s.answer) >= 0.8) hitAnswers++;
    }
    if (g.imageCount !== undefined) {
      goldImages += g.imageCount;
      hitImages += Math.min(g.imageCount, s.images.length);
    }
  }

  const needsReviewRate = system.length
    ? system.filter((q) => q.status === "needs_review").length / system.length
    : 0;
  // 部分金标准不能判「自动通过」：没有 precision/误切分母，只有完整金标准才有资格。
  const autoPass =
    gold.complete && needsReviewRate <= REVIEW_THRESHOLD && recall >= 0.99 && (precision ?? 0) >= 0.99;

  const notes: string[] = [];
  if (!gold.complete) notes.push("partial gold：只算 recall 与匹配题上的选项/答案指标，precision 不计算");
  notes.push("边界准确率未测：金标准暂未标注起始/结束块");
  notes.push("静默失败由 audit-numbering/ReviewNote 门判定，不在本脚本内");

  return {
    docId,
    goldComplete: gold.complete,
    goldQuestions: gold.questions.length,
    systemQuestions: system.length,
    matched,
    recall,
    precision,
    strictTextMatch,
    strictTextMismatches,
    optionCompleteness: goldOpts ? hitOpts / goldOpts : null,
    optionCer: cerN ? cerSum / cerN : null,
    answerPairing: goldAnswers ? hitAnswers / goldAnswers : null,
    imageRecall: goldImages ? hitImages / goldImages : null,
    needsReviewRate,
    autoPass,
    unmatchedGold,
    falsePositives: gold.complete ? system.length - matched : null,
    notes,
  };
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function loadGold(path: string): GoldDoc {
  return JSON.parse(readFileSync(path, "utf8")) as GoldDoc;
}

function loadSystem(docId: string): Question[] {
  const p = join("data", "out", docId, "questions.json");
  return JSON.parse(readFileSync(p, "utf8")) as Question[];
}

const PHASE1 = {
  recall: 0.99,
  precision: 0.99,
  strictTextMatch: 0.95,
  optionCompleteness: 0.99,
  optionCer: 0.005,
  answerPairing: 0.99,
  imageRecall: 0.99,
  needsReviewRate: 0.05,
};

function gateFailures(r: ScoreResult): string[] {
  const f: string[] = [];
  if (!r.goldComplete) return f;
  if (r.recall < PHASE1.recall) f.push(`recall ${pct(r.recall)} < ${pct(PHASE1.recall)}`);
  if (r.precision !== null && r.precision < PHASE1.precision)
    f.push(`precision ${pct(r.precision)} < ${pct(PHASE1.precision)}`);
  if (r.strictTextMatch !== null && r.strictTextMatch < PHASE1.strictTextMatch)
    f.push(`strictTextMatch ${pct(r.strictTextMatch)} < ${pct(PHASE1.strictTextMatch)}`);
  if (r.optionCompleteness !== null && r.optionCompleteness < PHASE1.optionCompleteness)
    f.push(`optionCompleteness ${pct(r.optionCompleteness)} < ${pct(PHASE1.optionCompleteness)}`);
  if (r.optionCer !== null && r.optionCer > PHASE1.optionCer)
    f.push(`optionCer ${pct(r.optionCer)} > ${pct(PHASE1.optionCer)}`);
  if (r.answerPairing !== null && r.answerPairing < PHASE1.answerPairing)
    f.push(`answerPairing ${pct(r.answerPairing)} < ${pct(PHASE1.answerPairing)}`);
  if (r.imageRecall !== null && r.imageRecall < PHASE1.imageRecall)
    f.push(`imageRecall ${pct(r.imageRecall)} < ${pct(PHASE1.imageRecall)}`);
  if (r.needsReviewRate > PHASE1.needsReviewRate)
    f.push(`needsReviewRate ${pct(r.needsReviewRate)} > ${pct(PHASE1.needsReviewRate)}`);
  return f;
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const gate = args.includes("--gate");
  const docArg = args.find((a) => !a.startsWith("--"));

  const goldDir = join("gold");
  if (!existsSync(goldDir)) {
    console.error("没有 gold/ 目录：先按 gold/README.md 标注金标准");
    process.exit(2);
  }
  const files = readdirSync(goldDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(goldDir, f))
    .filter((f) => {
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as { docId?: unknown; questions?: unknown };
        return typeof j.docId === "string" && Array.isArray(j.questions);
      } catch {
        return false;
      }
    });
  const selected = all
    ? files
    : docArg
      ? files.filter((f) => f.includes(docArg))
      : [];
  if (selected.length === 0) {
    console.error("没有可评分的金标准文件（--all 或给 docId）");
    process.exit(2);
  }

  const results: ScoreResult[] = [];
  for (const file of selected) {
    const gold = loadGold(file);
    let system: Question[];
    try {
      system = loadSystem(gold.docId);
    } catch {
      console.log(`跳过 ${gold.docId}：data/out/${gold.docId}/questions.json 不存在`);
      continue;
    }
    const r = scoreQuestions(gold.docId, gold, system);
    results.push(r);
  }
  if (results.length === 0) {
    console.error("金标准对应的系统产物都不存在");
    process.exit(2);
  }

  mkdirSync(join("data", "score"), { recursive: true });
  for (const r of results) {
    writeFileSync(join("data", "score", `${r.docId}.json`), JSON.stringify(r, null, 2));
  }
  const lines = [
    "# 准确率评分报告",
    "",
    "| 卷 | 金标 | 系统 | 匹配 | recall | precision | 严格文本 | 选项完整 | 选项CER | 答案配对 | 图片召回 | 待复核 | 自动通过 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...results.map(
      (r) =>
        `| ${r.docId}${r.goldComplete ? "" : "（部分）"} | ${r.goldQuestions} | ${r.systemQuestions} | ${r.matched} | ${pct(r.recall)} | ${pct(r.precision)} | ${pct(r.strictTextMatch)} | ${pct(r.optionCompleteness)} | ${pct(r.optionCer)} | ${pct(r.answerPairing)} | ${pct(r.imageRecall)} | ${pct(r.needsReviewRate)} | ${r.autoPass ? "是" : "否"} |`,
    ),
    "",
    ...results.flatMap((r) => [
      `## ${r.docId}`,
      ...r.notes.map((n) => `- ${n}`),
      r.unmatchedGold.length
        ? `- 未匹配金标题：${r.unmatchedGold.map((x) => `p${x.page + 1}#${x.number}`).join("、")}`
        : "- 未匹配金标题：0",
      "",
    ]),
  ];
  writeFileSync(join("data", "score", "report.md"), lines.join("\n"));
  console.log(lines.slice(0, 5).join("\n"));
  for (const r of results) {
    console.log(
      `\n${r.docId}${r.goldComplete ? "" : "（部分）"}：匹配 ${r.matched}/${r.goldQuestions} · recall ${pct(r.recall)}` +
        ` · 严格文本 ${pct(r.strictTextMatch)} · 选项完整 ${pct(r.optionCompleteness)} · 选项CER ${pct(r.optionCer)}` +
        ` · 答案配对 ${pct(r.answerPairing)} · 图片召回 ${pct(r.imageRecall)} · 待复核 ${pct(r.needsReviewRate)}` +
        ` · 自动通过 ${r.autoPass ? "是" : "否"}`,
    );
    if (!r.goldComplete) console.log("  注：部分金标准，precision/误切不计算；完整金标准后才能算。");
    if (r.unmatchedGold.length) console.log(`  未匹配：${r.unmatchedGold.map((x) => `p${x.page + 1}#${x.number}`).join("、")}`);
    if (r.strictTextMismatches.length)
      console.log(
        `  严格文本未达标：${r.strictTextMismatches.map((x) => `p${x.page + 1}#${x.number}（sim ${x.similarity}）`).join("、")}`,
      );
  }
  console.log(`\n报告：data/score/report.md`);

  if (gate) {
    if (results.every((r) => !r.goldComplete)) {
      console.error("check:accuracy：没有完整金标准，无法判定（partial 试点不算）");
      process.exit(2);
    }
    const failures = results
      .filter((r) => r.goldComplete)
      .flatMap((r) => gateFailures(r).map((f) => `${r.docId}: ${f}`));
    if (failures.length) {
      console.error(`\n准确率门未过（Phase 1 阈值）：\n- ${failures.join("\n- ")}`);
      process.exit(1);
    }
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
