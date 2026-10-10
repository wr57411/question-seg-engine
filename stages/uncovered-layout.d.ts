/**
 * uncovered-layout.d.ts —— 重建纸面上**所有标记**的落位算法类型声明（实现见同目录 .js）。
 * 两类标记：「解析遗漏」内容级标签、题号牌。共同红线：任何标记都不得盖住正文。
 * 供 TS 测试 import；红线：本目录不 import 引擎代码。
 */

/** 未覆盖区域的最小形状：仅需 bbox（PDF 点）。 */
export interface LayoutRegion {
  bbox: number[];
}

/** 解析块的最小形状：仅需 bbox（PDF 点）。 */
export interface LayoutBlock {
  bbox: number[];
}

/** 标签矩形（PDF 点）：[x0, y0, x1, y1]。 */
export type LabelRect = [number, number, number, number];

export const UNCOVERED_LABEL_GAP_PT: number;
export const UNCOVERED_LABEL_MIN_W_PX: number;
export const UNCOVERED_LABEL_H_PX: number;
export const UNCOVERED_LABEL_W_PX: number;

/** 标签矩形是否与任一解析块 bbox 相交。 */
export function labelOverlapsBlock(rect: number[], blocks: LayoutBlock[] | undefined): boolean;

/** 相邻（同列、垂直间隙 ≤ GAP）内容级区域并组，返回按 y 升序的组数组。 */
export function groupContentForLabels(regions: LayoutRegion[]): LayoutRegion[][];

/** 在锚区域周围挑首个不压正文且在页内的标签位；都不行返回 null。 */
export function pickLabelRect(
  bbox: number[],
  w: number,
  h: number,
  pageW: number,
  pageH: number,
  blocks: LayoutBlock[] | undefined,
): LabelRect | null;

/** 为内容级区域算出每组一个的可见标签落位；不遮正文、不越页，放不下则不产出。 */
export function contentLabelPlacements(
  regions: LayoutRegion[],
  blocks: LayoutBlock[] | undefined,
  pageW: number,
  pageH: number,
  canvasW: number,
): { rect: LabelRect; count: number }[];

export const CHIP_FONT_PX: number;
export const CHIP_PAD_PX: number;
export const CHIP_H_PX: number;

/** 题号牌落位：页边距优先，其次块上/下方；都不行返回 null。 */
export function pickChipRect(
  bbox: number[],
  w: number,
  h: number,
  pageW: number,
  pageH: number,
  blocks: LayoutBlock[] | undefined,
): LabelRect | null;

/** 为一组题算题号牌落位（先试 label，再试 compact，都不行则 null）。 */
export function chipPlacements(
  items: { bbox: number[] | null; label?: string; compact?: string }[],
  blocks: LayoutBlock[] | undefined,
  pageW: number,
  pageH: number,
  canvasW: number,
): ({ rect: LabelRect; label: string } | null)[];
