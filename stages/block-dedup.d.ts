/**
 * block-dedup.d.ts —— 同页块级重复去重的类型声明（实现见同目录 block-dedup.js）。
 * 供 TS 测试与审计脚本 import；红线：本目录不 import 引擎代码。
 * 判据与处置见 block-dedup.js 头注释。
 */

/** 判定所需的最小块形状。 */
export interface DedupBlock {
  i: number;
  kind?: string;
  text?: string;
  bbox: number[];
}

export const DUP_Y_OVERLAP_MIN: number;
export const DUP_MIN_COMMON: number;

/** 去 LaTeX 命令/`$`/`\`/`{}`/空白后的可见纯文本。 */
export function dedupPlainText(text: string): string;

/** 最长公共子串长度。 */
export function longestCommonSubstring(a: string, b: string): number;

/** 同页两块是否为「同一行被读成两块」的重复（判据只此一处定义）。 */
export function isCrossBlockDuplicate(a: DedupBlock, b: DedupBlock): boolean;

/** 本页应丢弃渲染的块 `i` 集合（保留文本更长者）。 */
export function droppedDuplicateIndices(blocks: DedupBlock[] | undefined): Set<number>;
