/**
 * layout.ts —— 版面层（正式件）
 *
 * 只使用坐标与类别信息，不含任何题号/选项语义：
 * 1. 分栏检测：text 块左边缘 x0 的最大空隙 > 页宽 28% → 两栏；
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

/** 分栏检测：文本/表格/公式块 x0 的最大空隙是否构成栏间空白 */
export function detectColumns(entries: IndexedBlock[], pageWidth: number): number {
  const xs = entries
    .filter((e) => e.block.kind !== "image")
    .map((e) => e.block.bbox[0])
    .sort((a, b) => a - b);
  if (xs.length < 4) return 1;

  let maxGap = 0;
  let splitAfter = -1;
  for (let i = 1; i < xs.length; i++) {
    const gap = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
    if (gap > maxGap) {
      maxGap = gap;
      splitAfter = i - 1;
    }
  }
  // 栏间空隙必须足够大，且两侧块数量都不能太少（防单栏里个别孤立块误判）
  if (maxGap > pageWidth * 0.28 && splitAfter >= 1 && xs.length - splitAfter - 1 >= 2) {
    return 2;
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