/**
 * audit-oxr-font.ts —— 字号保真度的**独立判据**（docs/oxr-evaluation.md §4.10 的收口）
 *
 * 为什么需要它：现有的 `audit:render` 字号判据算的是「渲染宽 / bbox 宽」，
 * 而 OXR 上游**没有** `font_size` —— 我们是从 bbox 反推出字号的
 * （`字号² = 块高×块宽/(1.45×em)`）。于是「用 bbox 推字号、再拿字号比 bbox」
 * 必然接近 1，是自我一致，不是与原卷一致（红线：判据分母必须来自被检验对象之外）。
 *
 * 本脚本把分母换成**原卷页图上的墨迹行高**：
 *   1. `pdftoppm -gray` 渲染原卷为灰度图（与墨迹覆盖率同一套机制）；
 *   2. 对每个文本块，按其 bbox 取图像区域，做**水平投影**找墨迹行；
 *   3. 行高（像素）→ pt → 反推字号（行高 / 1.45）；
 *   4. 与引擎算出的字号（`maxFontSize`）对比，出 ratio 分布。
 *
 * 判据意义：
 * - 对 **MinerU 卷**跑，ratio 应接近 1 —— 这一步是**判据自检**（分母独立且可信）；
 * - 对 **OXR 卷**跑，若 ratio 也接近 1，说明我们从 bbox 反推的字号**与原卷一致**，
 *   而不只是与 bbox 自洽。
 *
 * 用法：npx tsx scripts/audit-oxr-font.ts <docId>
 *       npx tsx scripts/audit-oxr-font.ts            # 两卷对比
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeLayout } from "../src/index.js";
import { renderGrayPages, type GrayImage } from "./export-stages.js";

const DPI = 150;
/** pt → px */
const PX_PER_PT = DPI / 72;
/** CJK 行高 / 字号（与 oxr-convert 的 LINE_HEIGHT_RATIO 同源） */
const LINE_HEIGHT_RATIO = 1.45;
/** 一个像素行里暗像素占比超过它就认为"这行有字"（避开纸张噪点） */
const INK_ROW_RATIO = 0.015;
/** 太短的文本块没有统计意义（单字符/标点），排除 */
const MIN_TEXT_LEN = 8;

interface Ratio {
  page: number;
  text: string;
  engineFont: number;
  measuredFont: number;
  ratio: number;
  /** 原卷该区域的墨迹垂直跨度（px） */
  spanPx: number;
  /** 该区域 bbox 高（px），用于判定是否单行块 */
  bboxHpx: number;
}

/**
 * 量区域的**墨迹垂直跨度**（第一暗行 → 最后暗行）。
 *
 * 为什么不用「连续暗行段」：第一版按连续段切行，而 CJK 字形在垂直方向中间常有空隙
 * （「二」的上下两横之间），一行会被切成多段 ⇒ 行高被系统性低估
 * （对照组 MinerU 卷 ratio p50 达 1.711，本该≈1，就是这个原因）。
 * 改用整块跨度后，字形内部空隙不影响结果。
 *
 * ⚠️ 另外第一版把跨度又除以了 LINE_HEIGHT_RATIO(1.45) —— 也是错的：
 * **墨迹跨度本身 ≈ 字号（1em）**，1.45 是「行距 / 字号」，只适用于把行距换算成字号。
 */
function measureInkSpan(
  img: GrayImage,
  bbox: number[],
): { spanPx: number; bboxHpx: number } | null {
  const x0 = Math.max(0, Math.round((bbox[0] ?? 0) * PX_PER_PT));
  const y0 = Math.max(0, Math.round((bbox[1] ?? 0) * PX_PER_PT));
  const x1 = Math.min(img.width, Math.round((bbox[2] ?? 0) * PX_PER_PT));
  const y1 = Math.min(img.height, Math.round((bbox[3] ?? 0) * PX_PER_PT));
  if (x1 - x0 < 8 || y1 - y0 < 4) return null;

  const w = x1 - x0;
  const thresh = Math.max(1, Math.floor(w * INK_ROW_RATIO));
  let first = -1;
  let last = -1;
  for (let y = y0; y < y1; y++) {
    let dark = 0;
    const row = y * img.width;
    for (let x = x0; x < x1; x++) {
      if ((img.data[row + x] ?? 255) < 128) dark++;
    }
    if (dark >= thresh) {
      if (first < 0) first = y;
      last = y;
    }
  }
  if (first < 0) return null;
  return { spanPx: last - first + 1, bboxHpx: y1 - y0 };
}

function audit(docId: string): Ratio[] {
  const outDir = join("data", "out", docId);
  // layout 可能落在产物目录（daily 路径）或 data/oxr（adapter 手工路径）
  const layoutPath = [join(outDir, "layout.json"), `data/oxr/${docId}-as-layout.json`].find(existsSync);
  // 原卷 PDF 两种命名都可能：daily 的 `<docId>_origin.pdf`、stages:export 的 `origin.pdf`
  const pdfPath = [join(outDir, `${docId}_origin.pdf`), join(outDir, "origin.pdf")].find(existsSync);
  if (!layoutPath) throw new Error(`找不到 layout.json（out 目录与 data/oxr 都没有）`);
  if (!pdfPath) throw new Error(`找不到原卷 PDF（${docId}_origin.pdf / origin.pdf 都没有）`);

  const doc = normalizeLayout(JSON.parse(readFileSync(layoutPath, "utf8")), docId);
  const images = renderGrayPages(pdfPath, DPI);
  const rows: Ratio[] = [];

  doc.pages.forEach((page, pi) => {
    const img = images[pi];
    if (!img) return;
    for (const b of page.blocks) {
      if (b.kind !== "text") continue;
      if (b.text.length < MIN_TEXT_LEN) continue;
      // 含 LaTeX 源码的行 bbox 会被二维结构撑高，不是纯行高样本（与 baseFontOfPage 同口径）
      if (/[\\$]|[_^]/.test(b.text)) continue;
      const m = measureInkSpan(img, b.bbox);
      if (!m || m.spanPx <= 0) continue;
      // **只取单行块**：墨迹跨度 ≈ 字号只对单行成立；多行块的跨度是多行总高，
      // 拿它当字号会严重高估。判据：跨度接近 bbox 高（块内没有整行空白）。
      if (m.spanPx / m.bboxHpx < 0.85) continue;
      const measuredFont = m.spanPx / PX_PER_PT; // 墨迹跨度(px) → pt，本身即字号量级
      if (measuredFont <= 0) continue;
      // 引擎侧字号：展示层模型就是 `fontFromLineHeight(bboxH) = bboxH × 1.03`（HANDOFF 记载）。
      // ⚠️ 不能用 `maxFontSize` —— 实测**两卷它全是 0**：MinerU 的 layout.json 同样没有
      // `font_size`，它的字号也是从 bbox 推的。所以「谁是上游实测值」这个前提本身不成立，
      // 独立分母只能来自**原卷像素**（本函数就是干这个的）。
      const bboxH = (b.bbox[3] - b.bbox[1]) * 1.03;
      if (bboxH <= 0) continue;
      const engineFont = bboxH;
      rows.push({
        page: pi + 1,
        text: b.text.slice(0, 24),
        engineFont: Number(engineFont.toFixed(2)),
        measuredFont: Number(measuredFont.toFixed(2)),
        ratio: Number((engineFont / measuredFont).toFixed(3)),
        spanPx: m.spanPx,
        bboxHpx: m.bboxHpx,
      });
    }
  });
  return rows;
}

const pct = (arr: number[], p: number): number =>
  arr.length === 0 ? NaN : (arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? NaN);

const targets = process.argv[2]
  ? [process.argv[2]]
  : ["23必刷题 2相互作用", "23必刷题 2相互作用-OXR"];

for (const docId of targets) {
  try {
    const rows = audit(docId);
    if (rows.length === 0) {
      console.log(`${docId}: 无可判样本`);
      continue;
    }
    const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
    const p10 = pct(ratios, 0.1);
    const p50 = pct(ratios, 0.5);
    const p90 = pct(ratios, 0.9);
    const inRange = ratios.filter((r) => r >= 0.8 && r <= 1.25).length;
    console.log(`\n=== ${docId} ===`);
    console.log(
      `  可判块 ${rows.length} · ratio p10/p50/p90 = ${p10.toFixed(3)} / ${p50.toFixed(3)} / ${p90.toFixed(3)}`,
    );
    console.log(
      `  ∈[0.80,1.25] 占比 ${((inRange / rows.length) * 100).toFixed(1)}% · 判定 ${Math.abs(p50 - 1) <= 0.15 ? "✅ 中位在 ±15% 内" : "❌ 中位偏差超 15%"}`,
    );
    console.log("  样本（前 5）：");
    for (const r of rows.slice(0, 5)) {
      console.log(
        `    p${r.page} 引擎 ${r.engineFont}pt / 实测 ${r.measuredFont}pt = ${r.ratio} 「${r.text}」`,
      );
    }
  } catch (e) {
    console.log(`${docId}: 跳过（${e instanceof Error ? e.message : e}）`);
  }
}
