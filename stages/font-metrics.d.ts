/**
 * font-metrics.d.ts —— 重建纸面字号/全角宽度度量的类型声明（实现见同目录 font-metrics.js）。
 * 供 TS 测试与审计脚本 import；红线：本目录不 import 引擎代码。
 * 数值权威与被推翻的旧前提见 font-metrics.js 头注释。
 */

/** 字号推导只需要 bbox（pt 坐标）与可选的 kind/text。 */
export interface MetricBlock {
  kind?: string;
  text?: string;
  bbox: number[];
}

/** 行高 → 字号（画布 px）：`Math.max(4, hPx * 1.03)`（定案系数 c=1.03）。 */
export function fontFromLineHeight(hPx: number): number;

/** 页面基准字号（画布 px）：非公式文本块 bbox 高中位 → 换算过 fontFromLineHeight；无可用块返回 null。 */
export function baseFontOfPage(
  blocks: MetricBlock[] | undefined,
  pageWidth: number,
  canvasW: number,
): number | null;

/** 块的渲染字号：`hasMathSource` 命中（含 `\`/`$`/`_`/`^`）用 baseFont（null 时回退行高推算），
 *  否则按自身行高推算。竖排块（bboxH > 2×bboxW 且当量宽 ≥2）改取 bboxW 当行高。
 *  非公式文本块再过 `reconcileFont`：**全角字数 ≥ 6** 且宽高两路比值 > 1.3（bbox 被撑大）时退回 baseFont。
 *  若给了 `pageBlocks`，再过 `isCrampedLine`：框与同栏邻行挤在一起（间隙 ≤ 7pt）时退回 baseFont
 *  ——**仅在会缩小时生效**（Task 14 结构判据）。 */
export function fontForBlock(
  block: MetricBlock,
  pageWidth: number,
  canvasW: number,
  baseFont: number | null,
  pageBlocks?: MetricBlock[],
): number;

/** 两估计量交叉验证（Task 13）：全角字数 `fwCount < 6` 时**不比较**、直接返回 fontH（短块 fontW 噪声大）；
 *  否则 `max(fontH, fontW) / min(fontH, fontW) > 1.3` 时返回 baseFont（baseFont 为 null 时退回 fontH）。
 *  判据只此一处定义。 */
export function reconcileFont(
  fontH: number,
  fontW: number,
  baseFont: number | null,
  fwCount: number,
): number;

/** 全角/CJK 字数：码位 ≥ U+2E80 的字符计数（与 emWidthOf 的「全角/CJK」口径一致）。 */
export function fullWidthCount(text: string): number;

/** 竖排文本判定：bboxH > 2×bboxW（严格大于）且 emWidthOf(text) ≥ 2。 */
export function isVerticalText(bbox: number[], text: string): boolean;

/** 公式源码判定（C1 修复）：`/[\\$]|[_^]/` —— 反斜杠、美元符、下划线、脱字符任一即命中。 */
export function hasMathSource(text: string): boolean;

/** 二维排版构造判定（Task 14）：含 `\frac`/`\dfrac`/`\tfrac`/`\sqrt` 任一。
 *  只有这两类块继续豁免 `clampByWidth`（线性宽度模型对二维叠放/根号不成立）。 */
export function hasTwoDimensionalMath(text: string): boolean;

/** 块的渲染后纯文本（Task 14）：`stripTags(prettifyLatex(text))` —— 供 `clampByWidth` 度量宽度。 */
export function renderedTextOf(text: string): string;

/** 块 bbox 被撑大的**结构判据**（Task 14）：同页存在「同栏（横向重叠 ≥ 0.4×min 宽）、
 *  纵向挤在一起（垂直间隙 ≤ 7pt）」的另一文本块。命中 ⇒ 该块 bbox 高不可信。 */
export function isCrampedLine(
  block: MetricBlock,
  pageBlocks: MetricBlock[] | undefined,
): boolean;

/** 宽度安全上限（R3/R5）：`min(fontPx, bboxW_px / emWidthOf(renderedTextOf(text)))`。
 *  竖排块、**二维公式块**（`hasTwoDimensionalMath`，含 `\frac`/`\sqrt`）或无文本块原样返回 fontPx。
 *  Task 14：度量从「原始 LaTeX 源码」改为「渲染后纯文本」，豁免收窄到 `\frac`/`\sqrt`。 */
export function clampByWidth(
  fontPx: number,
  block: MetricBlock,
  pageWidth: number,
  canvasW: number,
): number;

/** 阶段 1 段级块字号（R1）：min(行高推算, bboxW_px/emWidthOf(text))，下限 8px，无上限；
 *  无文本（emWidthOf=0）时返回 8。 */
export function fontForRawBlock(
  block: MetricBlock,
  pageWidth: number,
  canvasW: number,
): number;

/** 全角当量宽度和：全角/CJK 1.0、ASCII 字母数字 0.5、空格 0.25、其余可见标点 0.3、\n\t 0。 */
export function emWidthOf(text: string): number;
