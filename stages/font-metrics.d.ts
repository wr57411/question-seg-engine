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
 *  否则按自身行高推算。竖排块（bboxH > 2×bboxW 且当量宽 ≥2）改取 bboxW 当行高。 */
export function fontForBlock(
  block: MetricBlock,
  pageWidth: number,
  canvasW: number,
  baseFont: number | null,
): number;

/** 竖排文本判定：bboxH > 2×bboxW（严格大于）且 emWidthOf(text) ≥ 2。 */
export function isVerticalText(bbox: number[], text: string): boolean;

/** 公式源码判定（C1 修复）：`/[\\$]|[_^]/` —— 反斜杠、美元符、下划线、脱字符任一即命中。 */
export function hasMathSource(text: string): boolean;

/** 宽度安全上限（R3/R5）：`min(fontPx, bboxW_px / emWidthOf(text))`。
 *  竖排块、**公式源码块**（hasMathSource 命中）或无文本块（emWidthOf=0）原样返回 fontPx。 */
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
