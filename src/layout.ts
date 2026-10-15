/**
 * layout.ts —— 版面层（正式件）
 *
 * 只使用坐标与类别信息，不含任何题号/选项语义：
 * 1. 分栏检测：text 块 x0 的桶直方图聚类（稠密桶聚簇 + 簇中心距 > 页宽×minGapRatio → 两栏）；
 * 2. 阅读顺序恢复：单栏按 y 排序；两栏按「左栏自上而下 + 右栏自上而下」，
 *    但**跨栏横幅**（居中卷头/居中节标题）按水平带（band）插在它自己的 y 处 —— 见 estimateGutter。
 *
 * 已知简化（演进点）：三栏、栏内多层级仍按两栏处理，后续扩展时替换 restoreReadingOrder。
 */
import type { BBox, IndexedBlock, PageInfo, ParsedBlock } from "./types.js";

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
  const centers = detectColumnCenters(entries, width);
  const columns = detectColumns(entries, width);
  return { columns, ordered: restoreReadingOrder(entries, columns, width, centers) };
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

/**
 * x0 桶聚类有效簇中心（升序）。
 * 供分栏判定（detectColumns）与栏归属（restoreReadingOrder）复用，
 * 使栏界不再依赖固定中线 pageWidth/2，而是「每块归最近簇中心」。
 * 无有效簇（块数不足/簇密度不足）返回 []。
 */
export function detectColumnCenters(
  entries: IndexedBlock[],
  pageWidth: number,
  params: ColumnDetectorParams = DEFAULT_COLUMN_PARAMS,
): number[] {
  const xs = entries
    .filter((e) => e.block.kind !== "image")
    .map((e) => e.block.bbox[0]);
  if (xs.length < 4) return [];

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

  return clusters
    .map((c) => {
      const lo = c.from * bucketWidth;
      const hi = (c.to + 1) * bucketWidth;
      const inCluster = xs.filter((x) => x >= lo && x < hi);
      return inCluster.reduce((a, b) => a + b, 0) / Math.max(1, inCluster.length);
    })
    .sort((a, b) => a - b);
}

export function detectColumns(
  entries: IndexedBlock[],
  pageWidth: number,
  params: ColumnDetectorParams = DEFAULT_COLUMN_PARAMS,
): number {
  const centers = detectColumnCenters(entries, pageWidth, params);
  const width = pageWidth > 0 ? pageWidth : 1654;
  if (centers.length >= 2 && (centers[1] ?? 0) - (centers[0] ?? 0) > width * params.minGapRatio) return 2;
  return 1;
}

/**
 * 一个块归哪一栏。
 *
 * **判据 = 块的 x 区间与哪一侧栏的内容带重叠更多**（栏间按定义是无墨区，见 `estimateGutter`）。
 * 估不出栏间时退回旧口径「x0 距最近簇中心」。
 *
 * 为什么不能用 x0：`detectColumnCenters` 算出的簇中心是**栏的起始 x**（文字行贴栏左缘，
 * x0 正是栏的信号）。这对**顶到栏左缘的行**成立，对**窄块**不成立 —— 窄块的 x0 是
 * 「栏左缘 + 缩进」，会被推到栏间附近 ⇒ 判给隔壁栏。`detectColumnCenters` 与 `estimateGutter`
 * 早就把图排除在栏几何之外（图不是行首信号），唯独归栏这一步还在吃 x0，不一致就是错挂来源。
 *
 * 实测本卷两册，x0 口径判错的窄块共 **55 处**：图片 41 张（题册 27/124、答案册 14/78，
 * 方向全部一致：左栏图 → 右栏题），文本 8 处（题册 7 + 答案册 1，全是 6–46pt 宽的孤块：
 * `U`、`()`、`（)`、单个 `θ`、单个 `A`、半截分数）。逐张回原卷页图核对过。
 * 文本那 8 处的真实代价：题册 p2 的孤立 `U` 被挂进**右栏**第 11 题，
 * 于是成品数据里选项 B 中间凭空多出一个字母（2026-10-15 用户逐题看图发现）。
 *
 * 取重叠而非「中心 vs 栏间中线」：判据说的是「墨迹大部分落在哪一栏」；
 * 中心口径在栏间空隙本身偏一侧时会把压在空隙边上的块判错。
 */
function columnOfBlock(
  block: ParsedBlock,
  assignByX0: (x: number) => number,
  gutter: { lo: number; hi: number } | null,
): number {
  if (!gutter) return assignByX0(block.bbox[0]);
  const [x0, , x1] = block.bbox;
  const leftOver = Math.max(0, Math.min(x1, gutter.lo) - x0);
  const rightOver = Math.max(0, x1 - Math.max(x0, gutter.hi));
  if (leftOver !== rightOver) return leftOver > rightOver ? 0 : 1;
  // 两侧都不重叠 = 整块落在栏间空隙内（本卷没有这种块）⇒ 退回中心口径
  return (x0 + x1) / 2 < (gutter.lo + gutter.hi) / 2 ? 0 : 1;
}

/**
 * 一个块在栏内的**流位置**。
 *
 * 文字块 = 顶边（行的自然起点）。**图片块 = 垂直中心**：图是**印在它所要说明的那几行旁边**的，
 * 顶边不是它"开始"的位置 —— MinerU 给的图 bbox 顶边普遍比它旁边那行文字高几个 pt
 * （实测题册 p5 钢丝图 y377 vs 题2 首行 y379），按顶边排就会让图**抢在它所属的那题之前**，
 * 于是被 `attachImage` 挂给上一题。
 * 独立真值取「图压着的那几行属于哪一题」（同栏 y 区间相交）：
 * 顶边口径 139/161 张挂对，中心口径 **161/161**。
 */
function flowY(block: ParsedBlock): number {
  return block.kind === "image" ? (block.bbox[1] + block.bbox[3]) / 2 : block.bbox[1];
}

/** 恢复阅读顺序：单栏/无簇中心按全页 y 排序；两栏时文字块按「x0 距最近簇中心」归栏、
 * 块一律按「与栏内容带的重叠」归栏（见 columnOfBlock），
 * 左栏整列在前（栏内按 flowY 排序）；**跨栏横幅**按水平带插在它自己的 y 处（见 estimateGutter）。 */
export function restoreReadingOrder(
  entries: IndexedBlock[],
  columns: number,
  pageWidth: number,
  centers: number[] = [],
): IndexedBlock[] {
  const byY = (a: IndexedBlock, b: IndexedBlock) => flowY(a.block) - flowY(b.block);
  if (columns <= 1 || centers.length < 2) return [...entries].sort(byY);

  // 簇中心升序，第 0 个即最左簇；归属 = 距哪个簇中心最近（不再依赖固定中线 pageWidth/2）
  const assign = (x: number) => {
    let best = 0;
    let bestDist = Infinity;
    centers.forEach((c, i) => {
      const d = Math.abs(c - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  const gutter = estimateGutter(entries, centers);
  const banners = entries.filter((e) => isSpanningBlock(e.block.bbox, gutter)).sort(byY);
  const left: IndexedBlock[] = [];
  const right: IndexedBlock[] = [];
  for (const e of entries) {
    if (isSpanningBlock(e.block.bbox, gutter)) continue;
    (columnOfBlock(e.block, assign, gutter) === 0 ? left : right).push(e);
  }
  left.sort(byY);
  right.sort(byY);

  // 水平带归并：每遇到一个跨栏横幅，先把「它上方」的左栏块、右栏块吐出，再吐横幅本身。
  // 为什么必须这样：跨栏横幅（居中卷头/居中节标题）的 x0 落在栏间，
  // 用「x0 距最近簇中心」归栏会把它判给右栏 ⇒ 排到左栏之后 ⇒ **节上下文滞后一整栏**
  // （2026-10-14 实测：题册 p10 的「专题 连接体动态平衡问题」被排到第 35/76 位，
  //  导致该节 10 道题全部标成上一节的「第5节」）。
  const out: IndexedBlock[] = [];
  let li = 0;
  let ri = 0;
  for (const b of banners) {
    const y = flowY(b.block); // 与 byY 同一口径，否则「排在横幅上方」的判据和排序自相矛盾
    while (li < left.length && flowY(left[li]!.block) < y) out.push(left[li++]!);
    while (ri < right.length && flowY(right[ri]!.block) < y) out.push(right[ri++]!);
    out.push(b);
  }
  while (li < left.length) out.push(left[li++]!);
  while (ri < right.length) out.push(right[ri++]!);
  return out;
}

export interface GutterParams {
  /** 「明确属于某栏」的判定：x0 距该栏簇中心不超过两栏中心距的该比例 */
  clearRatio: number;
  /** 左栏右边界取「明确左栏块」x1 的该分位 */
  leftQuantile: number;
  /** 右栏左边界取「明确右栏块」x0 的该分位 */
  rightQuantile: number;
  /** 每侧至少多少个「明确块」才敢估栏间（否则返回 null，退化为原行为） */
  minClearBlocks: number;
  /**
   * 栏间宽度的**上限**（相对两栏中心距）。超过即判「这不是干净的栏间」并放弃估计。
   * 为什么要有这道闸：栏间估计偏大时，落在「假栏间」里的正常正文会被误判成跨栏横幅。
   * 实测两栏真实页的栏间宽 ≈ 26~28pt、栏中心距 ≈ 260pt（比值 ≈ 0.10），故 0.5 有 5 倍余量，
   * 同时能挡住「两栏挨得很近 / 单栏被误判成双栏」这类退化版面。
   */
  maxGutterRatio: number;
}

export const DEFAULT_GUTTER_PARAMS: GutterParams = {
  clearRatio: 0.25,
  leftQuantile: 0.75,
  rightQuantile: 0.25,
  minClearBlocks: 4,
  maxGutterRatio: 0.5,
};

const quantile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))] ?? 0;
};

/**
 * 估计**栏间空隙**（gutter）：两栏排版里栏间是无墨区，所以「明确属于左栏的块」的右边界
 * 与「明确属于右栏的块」的左边界之间就是栏间。
 *
 * 关键设计（2026-10-14）：
 * - **用分位数而不是 max/min**：跨栏横幅自己的 x0/x1 会伸进栏间，用极值会被它污染。
 * - **「明确属于某栏」用 x0 距簇中心的相对距离**（clearRatio），把跨栏块排除在统计外。
 * - 估计不出（块太少 / 栏间不成立）就返回 null ⇒ 阅读顺序**退化为原行为**，不引入新风险。
 *
 * 实测（题册 15 页 + 答案册 23 页，共 1916 块）：判为跨栏的只有 10 块 ——
 * 题册 7 块（1 个章标题 + 6 个居中节标题）、答案册 3 块（3 个章标题），**零误判**；
 * 答案册的 15 个节标题全部是栏内标题（中心落在 138~156 或 399~415），**完全不受影响**。
 */
export function estimateGutter(
  entries: IndexedBlock[],
  centers: number[],
  params: GutterParams = DEFAULT_GUTTER_PARAMS,
): { lo: number; hi: number } | null {
  if (centers.length < 2) return null;
  const l = centers[0]!;
  const r = centers[centers.length - 1]!;
  const span = r - l;
  if (!(span > 0)) return null;

  const leftEdges: number[] = [];
  const rightEdges: number[] = [];
  for (const e of entries) {
    if (e.block.kind === "image") continue; // 与 detectColumnCenters 口径一致：图不参与栏几何
    const x0 = e.block.bbox[0];
    if (x0 < l + span * params.clearRatio) leftEdges.push(e.block.bbox[2]);
    else if (x0 > l + span * (1 - params.clearRatio)) rightEdges.push(x0);
  }
  if (leftEdges.length < params.minClearBlocks || rightEdges.length < params.minClearBlocks) return null;

  const lo = quantile(leftEdges, params.leftQuantile);
  const hi = quantile(rightEdges, params.rightQuantile);
  if (!(lo < hi)) return null;
  if (hi - lo > span * params.maxGutterRatio) return null; // 太宽 ⇒ 不是干净的栏间，放弃估计
  return { lo, hi };
}

/**
 * 是否**跨栏横幅**：块的 x 区间**盖住整条栏间空隙**（左边界在栏间左侧、右边界在栏间右侧）。
 * 判据自洽 —— 栏间按定义是无墨区，一个块的墨迹同时出现在栏间两侧，只可能是它横跨了栏间。
 *
 * ⚠️ **不能用「块的中心落在栏间内」**（2026-10-14 实测踩过）：栏间附近会有**窄块**，
 * 其中心恰好落在栏间里 —— 答案册 p10 的孤立题号块 `10.`（x=[291,300]，宽仅 9pt）
 * 就被这样误判成横幅，被提到水平带的位置输出，导致该页阅读顺序错乱
 * （组 2|9 的题号序列变成 `1,2,3,4,5,9,10,7,8`，被题号审计的 N7 判据抓出回退）。
 */
export function isSpanningBlock(bbox: BBox, gutter: { lo: number; hi: number } | null): boolean {
  if (!gutter) return false;
  return bbox[0] <= gutter.lo && bbox[2] >= gutter.hi;
}

/** 供测试/调试：按阅读顺序展平多页 */
export function flattenPages(pages: PageInfo[]): { page: PageInfo; layout: LayoutInfo }[] {
  return pages.map((page) => ({ page, layout: layoutPage(page) }));
}