// scripts/audit-formula-ink.ts
/**
 * 回退行坐标的**原卷墨迹独立裁判**（只读审计；不接 check、不覆盖现有产物）。
 *
 * 为什么存在：rec 文字金标（Dice≥0.8）对公式-heavy 物理答案册无效——V3 把公式存成
 * LaTeX 源码、还把行内公式从行文本里抠掉，重读裁图比文字会把大量**正确坐标**误判成错
 * （全册 naive 91.3%，复合区间 89.6–96.8%）。用户拍板：公式行坐标改用墨迹几何裁判。
 *
 * 唯一独立来源：origin.pdf 灰度像素（复用 audit-hole-geometry 的 inkExtent/inkLineAround/
 * bboxFit 与 THRESHOLDS，**不新造阈值**）。bbox 只作为被检验对象，不读 OCR 文本。
 *
 * 每框判定（judgeInkBox）：
 *   FAKE     框内几乎无墨（inkPx < minHoleInkPx）⇒ 框落在空白处
 *   BLOAT    inflation > inflationAlert ⇒ 框膨胀或横向挪位（框内墨宽 < 框宽）
 *   FRAGMENT 框宽/行墨宽 < fragmentRatio 或 框内墨/行墨 < fragmentRatio ⇒ 纵向挪位/残片
 *   REAL     其余 ⇒ 框与原卷墨迹吻合，坐标正确
 * 与 classifyHole 的差异：此处无「同栏块」上下文，故残片单独即判失败（不要求 badBlock）。
 *
 * 用法：npx tsx scripts/audit-formula-ink.ts [--doc <id>] [--pages 76,127] [--out <json>]
 * 产物：data/out/<doc>/formula-ink.json（不含时间戳 ⇒ 同输入逐字节可复现）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  THRESHOLDS,
  bboxFit,
  inkExtent,
  inkLineAround,
  renderGrayPage,
  type Box,
  type Thresholds,
} from "./audit-hole-geometry.js";
import type { GrayImage } from "./export-stages.js";

const ROOT = join(import.meta.dirname, "..");
const round = (n: number): number => Math.round(n * 1000) / 1000;

export type InkVerdict = "REAL" | "FAKE" | "FRAGMENT" | "BLOAT";

export interface InkBoxResult {
  verdict: InkVerdict;
  inkPx: number;
  inflation: number | null;
  holeToBandWidth: number | null;
  inkShare: number | null;
  reasons: string[];
}

/** 单框墨迹吻合判定。纯函数，合成图可反向验证（见 tests/audit-formula-ink.test.ts）。 */
export function judgeInkBox(
  img: GrayImage,
  pageW: number,
  pageH: number,
  box: Box,
  t: Thresholds = THRESHOLDS,
): InkBoxResult {
  const hole = inkExtent(img, pageW, pageH, box);
  const base = { inkPx: hole.inkPx, inflation: null as number | null, holeToBandWidth: null as number | null, inkShare: null as number | null };
  if (hole.inkPx < t.minHoleInkPx) {
    return { ...base, verdict: "FAKE", reasons: [`框内墨迹 ${hole.inkPx}px < ${t.minHoleInkPx}px`] };
  }
  const fit = bboxFit(img, pageW, pageH, box);
  const inflation = fit ? fit.inflation : null;
  if (inflation !== null && inflation > t.inflationAlert) {
    return { ...base, inflation, verdict: "BLOAT", reasons: [`inflation ${inflation} > ${t.inflationAlert}（膨胀或横向挪位）`] };
  }
  const band = inkLineAround(img, pageW, pageH, box);
  const bandW = band ? band.bbox[2] - band.bbox[0] : 0;
  const boxW = box[2] - box[0];
  const holeToBandWidth = bandW > 0 ? round(boxW / bandW) : null;
  const inkShare = band && band.inkPx > 0 ? round(hole.inkPx / band.inkPx) : null;
  const narrow = holeToBandWidth !== null && holeToBandWidth < t.fragmentRatio;
  const lowShare = inkShare !== null && inkShare < t.fragmentRatio;
  if (narrow || lowShare) {
    return {
      ...base, inflation, holeToBandWidth, inkShare, verdict: "FRAGMENT",
      reasons: [narrow ? `框宽/行墨宽 ${holeToBandWidth} < ${t.fragmentRatio}` : `框内墨占该行 ${inkShare} < ${t.fragmentRatio}`],
    };
  }
  return { ...base, inflation, holeToBandWidth, inkShare, verdict: "REAL", reasons: [] };
}

/** V3 行文本是否为公式（LaTeX 命令或上下标/花括号）。与 crop-gold 分析同口径。 */
export const isFormulaText = (s: string): boolean => /\\[a-zA-Z]+|[_^{}]/.test(s);

interface Victim { id: string; text: string; v3box: Box }

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: string): string => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
  const doc = arg("doc", "答案册-合订本");
  const dir = join(ROOT, "data/out", doc);
  const pagesFilter = argv.includes("--pages") ? arg("pages", "").split(",").map(Number).filter(Number.isFinite) : null;
  const out = arg("out", join(dir, "formula-ink.json"));

  const stages = JSON.parse(readFileSync(join(dir, "stages.json"), "utf8")) as { pages: { width: number; height: number }[] };
  const agg = JSON.parse(readFileSync(join(dir, "giant-crop.aggregate.json"), "utf8")) as { totalLines: number; baselinePaired: number };
  const files = readdirSync(dir).filter((f) => /^giant-crop\.p\d+\.json$/.test(f)).sort();

  const rows: { id: string; page: number; formula: boolean; verdict: InkVerdict; inflation: number | null; inkShare: number | null }[] = [];
  for (const f of files) {
    const pno = Number(f.match(/^giant-crop\.p(\d+)\.json$/)![1]);
    if (pagesFilter && !pagesFilter.includes(pno)) continue;
    const victims = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { victims?: Victim[] }).victims ?? [];
    if (!victims.length) continue;
    const pageW = stages.pages[pno]!.width;
    const pageH = stages.pages[pno]!.height;
    const img = renderGrayPage(join(dir, "origin.pdf"), pno + 1);
    for (const v of victims) {
      const r = judgeInkBox(img, pageW, pageH, v.v3box);
      rows.push({ id: v.id, page: pno, formula: isFormulaText(v.text), verdict: r.verdict, inflation: r.inflation, inkShare: r.inkShare });
    }
    console.log(`p${pno}: ${victims.length} victims judged`);
  }

  const count = (pred: (r: typeof rows[number]) => boolean) => rows.filter(pred).length;
  const real = count((r) => r.verdict === "REAL");
  const formulaRows = rows.filter((r) => r.formula);
  const textRows = rows.filter((r) => !r.formula);
  const formulaReal = formulaRows.filter((r) => r.verdict === "REAL").length;
  const textReal = textRows.filter((r) => r.verdict === "REAL").length;
  const correctness = (agg.baselinePaired + real) / agg.totalLines;
  const payload = {
    doc,
    thresholds: THRESHOLDS,
    totalLines: agg.totalLines,
    baselinePaired: agg.baselinePaired,
    recoveredJudged: rows.length,
    inkReal: real,
    byVerdict: { REAL: real, FAKE: count((r) => r.verdict === "FAKE"), FRAGMENT: count((r) => r.verdict === "FRAGMENT"), BLOAT: count((r) => r.verdict === "BLOAT") },
    formula: { total: formulaRows.length, real: formulaReal, rate: formulaRows.length ? round(formulaReal / formulaRows.length) : 0 },
    text: { total: textRows.length, real: textReal, rate: textRows.length ? round(textReal / textRows.length) : 0 },
    goldCorrectnessRate: round(correctness * 100),
    target95Met: correctness >= 0.95,
    rows,
  };
  writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`\n=== 回退行墨迹几何裁判 · ${doc} ===`);
  console.log(`回退判定 ${rows.length}：REAL ${real} / FAKE ${payload.byVerdict.FAKE} / FRAGMENT ${payload.byVerdict.FRAGMENT} / BLOAT ${payload.byVerdict.BLOAT}`);
  console.log(`公式行 ${formulaRows.length}：REAL ${formulaReal}（${(payload.formula.rate * 100).toFixed(1)}%）`);
  console.log(`文本行 ${textRows.length}：REAL ${textReal}（${(payload.text.rate * 100).toFixed(1)}%）`);
  console.log(`全册正确率 =（墨迹配对 ${agg.baselinePaired} + 墨迹确认回退 ${real}）/ ${agg.totalLines} = ${payload.goldCorrectnessRate}%  target95Met=${payload.target95Met}`);
  console.log(`明细 → ${out}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) main();