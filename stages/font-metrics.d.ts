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

/** 块的渲染字号：含 \frac/\sqrt/_/^ 用 baseFont（null 时回退行高推算），否则按自身行高推算。 */
export function fontForBlock(
  block: MetricBlock,
  pageWidth: number,
  canvasW: number,
  baseFont: number | null,
): number;

/** 全角当量宽度和：全角/CJK 1.0、ASCII 字母数字 0.5、空格 0.25、其余可见标点 0.3、\n\t 0。 */
export function emWidthOf(text: string): number;
