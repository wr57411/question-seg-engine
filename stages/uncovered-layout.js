/**
 * uncovered-layout.js —— 「解析遗漏」内容级标签的落位算法（纯函数，无 DOM）。
 *
 * 定位：stages.js 的对比/阶段视图要在重建纸面上给「未覆盖墨迹（内容级）」挂一个
 * 「解析遗漏」标签。但漏识别区域多是**一行文字高**（~10pt），而标签高 14px（对比模式
 * PANE_W=460 下折算 ~18pt）比它高 ⇒ 直接挂在区域左上角必然向下越出行、压到下一行正文。
 * 本模块把「挂哪儿才不遮正文」抽成纯函数，好让 tests/uncovered-layout.test.ts 把它钉死
 * （修复轮 1 发现 2：任何标记都不得盖住正文，是硬保证）。
 *
 * 红线：本目录不 import 引擎代码；本模块无任何依赖。
 */

/** 相邻内容级区域聚合成一个标签的垂直间隙上限（pt）。 */
export const UNCOVERED_LABEL_GAP_PT = 24;
/** 框宽不足以容纳标签时不挂可见标签（改用 title）。 */
export const UNCOVERED_LABEL_MIN_W_PX = 56;
/** 标签高（与 CSS .uncovered-tag 的 line-height 一致）。 */
export const UNCOVERED_LABEL_H_PX = 14;
/** 标签宽估（「解析遗漏」4 字 @10px + 内边距 + 余量）。 */
export const UNCOVERED_LABEL_W_PX = 60;

/** 标签矩形是否与任一解析块 bbox 相交（相交则不得挂可见标签 —— 不许遮正文）。 */
export function labelOverlapsBlock(rect, blocks) {
  for (const b of blocks ?? []) {
    const bb = b && b.bbox;
    if (!Array.isArray(bb)) continue;
    const [x0, y0, x1, y1] = bb;
    if (rect[0] < x1 && rect[2] > x0 && rect[1] < y1 && rect[3] > y0) return true;
  }
  return false;
}

/** 把相邻（同列、垂直间隙 ≤ GAP）的内容级区域并成标签组，避免「一区一标签」堆叠。
 *  regions 每项形如 { bbox: [x0,y0,x1,y1], ... }；返回按 y 升序排好的组数组。 */
export function groupContentForLabels(regions) {
  const n = regions.length;
  const parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = regions[i].bbox;
      const B = regions[j].bbox;
      const ox = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
      const narrow = Math.min(A[2] - A[0], B[2] - B[0]);
      const vy = Math.max(0, Math.max(A[1], B[1]) - Math.min(A[3], B[3]));
      if (narrow > 0 && ox >= 0.5 * narrow && vy <= UNCOVERED_LABEL_GAP_PT) union(i, j);
    }
  }
  const byRoot = new Map();
  regions.forEach((r, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(r);
  });
  return [...byRoot.values()].map((rs) => rs.sort((a, b) => a.bbox[1] - b.bbox[1]));
}

/**
 * 在锚区域周围挑一个**不压正文**的标签位：
 * 依次试 左上角 / 上方 / 下方 / 垂直居中 / 右上角 / 右-垂直居中，返回首个既在页内、
 * 又与任何解析块 bbox 都不相交的矩形；都不行返回 null（该组不挂可见标签，仅靠 title）。
 * 为什么不能只挂「区域左上角」：见文件头注释（标签比漏识别行高，左上角必然压下一行）。
 */
export function pickLabelRect(bbox, w, h, pageW, pageH, blocks) {
  const [ax, ay, ax1, ay1] = bbox;
  const bh = ay1 - ay;
  const cands = [
    [ax, ay], // 左上角
    [ax, ay - h - 1], // 上方
    [ax, ay + bh + 1], // 下方
    [ax, ay + (bh - h) / 2], // 垂直居中
    [ax1 - w, ay], // 右上角
    [ax1 - w, ay + (bh - h) / 2], // 右-垂直居中
  ];
  for (const [x, y] of cands) {
    const rect = [x, y, x + w, y + h];
    if (rect[0] < 0 || rect[1] < 0 || rect[2] > pageW || rect[3] > pageH) continue;
    if (!labelOverlapsBlock(rect, blocks)) return rect;
  }
  return null;
}

/**
 * 为内容级未覆盖区域算出「可见标签」的落位（每组一个）。
 * 返回 `[{ rect, count }]`：rect 为 PDF 点坐标的标签矩形，count 为该组区域数。
 * **保证**（硬不变量，见测试）：每个 rect 都与 blocks 中任何 bbox 不相交（不遮正文）且在页内；
 * 框宽放不下标签、或所有候选位都压正文的组**不产出**（改由 title 承载）。
 */
export function contentLabelPlacements(regions, blocks, pageW, pageH, canvasW) {
  const pxPerPt = canvasW / pageW;
  const w = UNCOVERED_LABEL_W_PX / pxPerPt;
  const h = UNCOVERED_LABEL_H_PX / pxPerPt;
  const out = [];
  for (const group of groupContentForLabels(regions)) {
    // 锚 = 组内**最宽**区域（不是最靠上——最靠上的常是细碎条，会因过窄误弃整组标签）
    const anchor = group.reduce((a, b) => (b.bbox[2] - b.bbox[0] > a.bbox[2] - a.bbox[0] ? b : a));
    const wPx = ((anchor.bbox[2] - anchor.bbox[0]) / pageW) * canvasW;
    if (wPx < UNCOVERED_LABEL_MIN_W_PX) continue; // 框宽放不下标签 → 不挂（title 已够）
    const rect = pickLabelRect(anchor.bbox, w, h, pageW, pageH, blocks);
    if (!rect) continue; // 候选位都会压正文 → 不挂（title 已够）
    out.push({ rect, count: group.length });
  }
  return out;
}
