/**
 * block-dedup.d.ts —— 同页块级重复的**并集合并**的类型声明（实现见同目录 block-dedup.js）。
 * 供 TS 测试与审计脚本 import；红线：本目录不 import 引擎代码。
 * 判据、合并算法与顺序见 block-dedup.js 头注释。
 */

/** 判定所需的最小块形状。 */
export interface DedupBlock {
  i: number;
  kind?: string;
  text?: string;
  bbox: number[];
}

/** 合并计划记录（`merged === null` 表示「命中但无法合并」→ 保留原样不处理）。 */
export interface MergeRecord {
  keepI: number;
  dropI: number;
  merged: { text: string; overlap: number; dir: "contains" | "ab" | "ba" } | null;
  text?: string;
  bbox?: number[];
  a: DedupBlock;
  b: DedupBlock;
}

export const DUP_Y_OVERLAP_MIN: number;
export const DUP_MIN_COMMON: number;
export const MERGE_MIN_OVERLAP: number;

/** 去 LaTeX 命令/`$`/`\`/`{}`/空白后的可见纯文本。 */
export function dedupPlainText(text: string): string;

/** 最长公共子串长度。 */
export function longestCommonSubstring(a: string, b: string): number;

/** 同页两块是否为「同一行被读成两块」的候选（判据只此一处定义）。 */
export function isCrossBlockDuplicate(a: DedupBlock, b: DedupBlock): boolean;

/** 两块文本的并集（重叠只保留一次）；无法合并返回 null。 */
export function mergeTexts(a: string, b: string): { text: string; overlap: number; dir: "contains" | "ab" | "ba" } | null;

/** 两块 bbox 的并集。 */
export function unionBbox(ba: number[], bb: number[]): number[];

/** 本页同页块级重复的合并计划（块内折叠先做、跨块合并后做）。 */
export function crossBlockMerges(blocks: DedupBlock[] | undefined): MergeRecord[];
