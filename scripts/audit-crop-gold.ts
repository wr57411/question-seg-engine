// scripts/audit-crop-gold.ts
/**
 * 巨带裁图回退坐标的**独立 rec 金标裁判**（只读测量，零 API，不进 check）。
 *
 * goal item 2 的 95% 正确率金标口径（task #14）：机器筛（单行高+框内有墨）只是保守下界，
 * 可能把「圈错行的框」也算对。真正的裁判是**另一台模型重读裁图**：把回退坐标框从原卷页图
 * 裁出来，用笔记本本地 PP-OCRv5_server_rec 重读（rec-batch-laptop.py），重读文本与 V3 行文本
 * `similarity ≥ 0.8`（复用 score.ts 全项目判据，B-35 不重写）⇒ 该框确实圈住这行字 ⇒ 坐标正确。
 *
 * 输入：data/out/<doc>/giant-crop.pNN.json 的 victims（id/text）+ rec 读数 [{id,recText}]。
 * 用法：npx tsx scripts/audit-crop-gold.ts --rec readings.json [--doc ..]
 * 产物：stdout 聚合 + data/out/<doc>/crop-gold.json。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { similarity } from "./score.js";

export interface GoldVictim { id: string; text: string }
export interface GoldReading { id: string; recText: string | null }
export interface GoldRow { id: string; text: string; recText: string; sim: number; correct: boolean }
export interface GoldResult {
  rows: GoldRow[];
  /** 有重读结果、参与判定的行数 */
  judged: number;
  correct: number;
  /** 有重读的行里坐标正确的比例（金标精度） */
  precision: number;
  /** 有重读的行 / 全部回退行（重读覆盖率） */
  coverage: number;
}

/** 纯函数：按 id 对齐回退行与重读，similarity≥threshold 判坐标正确。无重读的行不计入 precision 分母。 */
export function judgeCropGold(victims: GoldVictim[], readings: GoldReading[], threshold = 0.8): GoldResult {
  const recMap = new Map(readings.map((r) => [r.id, r.recText ?? ""]));
  const rows: GoldRow[] = [];
  for (const v of victims) {
    if (!recMap.has(v.id)) continue;
    const recText = recMap.get(v.id)!;
    const sim = similarity(recText, v.text);
    rows.push({ id: v.id, text: v.text, recText, sim: +sim.toFixed(4), correct: sim >= threshold });
  }
  const judged = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  return {
    rows,
    judged,
    correct,
    precision: judged ? correct / judged : 0,
    coverage: victims.length ? judged / victims.length : 0,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (k: string): string | null => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

function main(): void {
  const doc = arg("doc") ?? "答案册-合订本";
  const recPath = arg("rec");
  if (!recPath || !existsSync(recPath)) {
    console.error("用法: audit-crop-gold.ts --rec <readings.json> [--doc ..]（readings 来自笔记本 rec-batch-laptop.py）");
    process.exit(2);
  }
  const dir = join(process.cwd(), "data/out", doc);
  const readings = JSON.parse(readFileSync(recPath, "utf8")) as GoldReading[];
  const victims: GoldVictim[] = [];
  for (const f of readdirSync(dir).filter((f) => /^giant-crop\.p\d+\.json$/.test(f)).sort()) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { victims?: { id: string; text: string }[] };
    for (const v of j.victims ?? []) victims.push({ id: v.id, text: v.text });
  }
  const gold = judgeCropGold(victims, readings);

  // 与机器下界结合：全册正确率 = (基线配对 + 金标判对的回收行) / 总行数。
  // 仅当回收行重读覆盖率=100% 时这是精确值；否则是按已判样本精度的保守外推（标注）。
  const aggPath = join(dir, "giant-crop.aggregate.json");
  let combined: Record<string, unknown> | null = null;
  if (existsSync(aggPath)) {
    const agg = JSON.parse(readFileSync(aggPath, "utf8")) as { totalLines: number; baselinePaired: number; recovered: number; validLowerBound: number };
    const fullCoverage = gold.coverage >= 1;
    const goldCorrectRecovered = fullCoverage ? gold.correct : Math.round(agg.recovered * gold.precision);
    combined = {
      totalLines: agg.totalLines,
      baselinePaired: agg.baselinePaired,
      recovered: agg.recovered,
      machineValidLowerBound: agg.validLowerBound,
      goldJudged: gold.judged,
      goldCoverage: +(gold.coverage * 100).toFixed(1),
      goldPrecision: +(gold.precision * 100).toFixed(1),
      goldCorrectRecovered,
      goldCorrectnessRate: +(((agg.baselinePaired + goldCorrectRecovered) / agg.totalLines) * 100).toFixed(1),
      exact: fullCoverage,
      target95Met: (agg.baselinePaired + goldCorrectRecovered) / agg.totalLines >= 0.95,
    };
  }
  const out = { doc, recoveredVictims: victims.length, ...gold, rows: undefined, combined };
  writeFileSync(join(dir, "crop-gold.json"), JSON.stringify({ ...out, rows: gold.rows }, null, 1), "utf8");
  console.log(JSON.stringify(out, null, 1));
  if (combined) { console.log("=== COMBINED (机器下界 + rec 金标) ==="); console.log(JSON.stringify(combined, null, 1)); }
  console.log(`→ data/out/${doc}/crop-gold.json`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) main();