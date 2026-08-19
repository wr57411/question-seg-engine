/**
 * layout.ts —— 版面层（正式件）
 *
 * 只使用坐标与类别信息，不含任何题号/选项语义：
 * 1. 分栏检测：text 块 x0 的桶直方图聚类（稠密桶聚簇 + 簇中心距 > 页宽×minGapRatio → 两栏）；
 * 2. 阅读顺序恢复：单栏按 y 排序；两栏按「左栏自上而下 + 右栏自上而下」。
 *
 * 已知简化（演进点）：复杂版式（三栏、栏内多层级、跨栏卷头居中等）
 * 需要按水平带（band）交替归并，后续扩展时替换 restoreReadingOrder 实现。
 */
import type { IndexedBlock, PageInfo, ParsedBlock } from "./types.js";

export interface LayoutInfo {
  columns: number;
  /** 恢复阅读顺序后的块序列（带原始序号） */
  ordered: IndexedBlock[];
}

/** 版面层编排：输入一页，输出阅读顺序 */
export function layoutPage(page: PageInfo): LayoutInfo {
  const width = page.width > 0 ? page.width : 1654;
  const entries: IndexedBlock[] = page.blocks.map((block, index) => ({
    index,
    pageIndex: page.index,
    block,
  }));
  const columns = detectColumns(entries, width);
  return { columns, ordered: restoreReadingOrder(entries, columns, width) };
}

export interface ColumnDetectorParams {
  /** 页宽等分桶数 */
  bucketCount: number;
  /** 有效簇的最小块数（绝对下限） */
  minClusterBlocks: number;
  /** 有效簇的最小块数占比（相对下限，乘以总块数后与绝对下限取 max） */
  minClusterRatio: number;
  /** 两栏判定：列中心最小间距（相对页宽） */
  minGapRatio: number;
}

export const DEFAULT_COLUMN_PARAMS: ColumnDetectorParams = {
  bucketCount: 24,
  minClusterBlocks: 5,
  minClusterRatio: 0.1,
  minGapRatio: 0.25,
};

/**
 * 分栏检测：x0 桶直方图聚类。
 * 机理（2026-08-19 真实数据校准）：双栏页左右各一簇（行级数据每簇 18~38 块），
 * 居中标题/边注 1~2 块横跨栏间隙会破坏「最大间隙」判定，但不会形成稠密桶——
 * 故用「稠密桶聚簇 + 簇中心距」替代单一间隙阈值。
 */
export function detectColumns(
  entries: IndexedBlock[],
  pageWidth: number,
  params: ColumnDetectorParams = DEFAULT_COLUMN_PARAMS,
): number {
  const xs = entries
    .filter((e) => e.block.kind !== "image")
    .map((e) => e.block.bbox[0]);
  if (xs.length < 4) return 1;

  const width = pageWidth > 0 ? pageWidth : 1654;
  const bucketWidth = width / params.bucketCount;
  const hist = new Array<number>(params.bucketCount).fill(0);
  for (const x of xs) {
    const idx = Math.min(params.bucketCount - 1, Math.floor(x / bucketWidth));
    hist[idx] = (hist[idx] ?? 0) + 1;
  }

  const minBlocks = Math.max(params.minClusterBlocks, Math.floor(xs.length * params.minClusterRatio));
  const clusters: { from: number; to: number; count: number }[] = [];
  let cur: { from: number; to: number; count: number } | null = null;
  for (let i = 0; i < params.bucketCount; i++) {
    const v = hist[i] ?? 0;
    if (v >= minBlocks) {
      if (!cur) cur = { from: i, to: i, count: v };
      else {
        cur.to = i;
        cur.count += v;
      }
    } else if (cur) {
      clusters.push(cur);
      cur = null;
    }
  }
  if (cur) clusters.push(cur);

  if (clusters.length >= 2) {
    const centers = clusters
      .map((c) => {
        const lo = c.from * bucketWidth;
        const hi = (c.to + 1) * bucketWidth;
        const inCluster = xs.filter((x) => x >= lo && x < hi);
        return inCluster.reduce((a, b) => a + b, 0) / Math.max(1, inCluster.length);
      })
      .sort((a, b) => a - b);
    if ((centers[1] ?? 0) - (centers[0] ?? 0) > width * params.minGapRatio) return 2;
  }
  return 1;
}

/** 恢复阅读顺序（简化版：两栏时左栏整列在前） */
export function restoreReadingOrder(
  entries: IndexedBlock[],
  columns: number,
  pageWidth: number,
): IndexedBlock[] {
  const byY = (a: IndexedBlock, b: IndexedBlock) => a.block.bbox[1] - b.block.bbox[1];
  if (columns <= 1) return [...entries].sort(byY);

  const mid = pageWidth / 2;
  const left = entries.filter((e) => e.block.bbox[0] < mid).sort(byY);
  const right = entries.filter((e) => e.block.bbox[0] >= mid).sort(byY);
  return [...left, ...right];
}

/** 供测试/调试：按阅读顺序展平多页 */
export function flattenPages(pages: PageInfo[]): { page: PageInfo; layout: LayoutInfo }[] {
  return pages.map((page) => ({ page, layout: layoutPage(page) }));
}