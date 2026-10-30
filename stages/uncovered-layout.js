// @ts-check
/**
 * uncovered-layout.js —— 重建纸面上**所有标记**的落位算法（纯函数，无 DOM）。
 *
 * 定位：stages.js 的对比/阶段视图要在重建纸面上挂两类标记 ——
 * ①「解析遗漏」标签（未覆盖墨迹，内容级）；②题号牌（题首，可点击看详情）。
 * 两者都是**浮在纸面上的标记**，共同的红线是：**任何标记都不得盖住正文**。
 * 本模块把「挂哪儿才不遮正文」抽成纯函数，好让 tests/uncovered-layout.test.ts 把它钉死。
 *
 * ⚠️ 2026-10-10 实测（DOM，15 页）：题号牌原先直接挂在**题首块左上角**，
 * 而块 bbox 紧贴墨迹（F1）→ 牌子必然压住题首前 1–3 个字（每处 400–750px²，
 * 全卷约 90 处，肉眼可见）。故题号牌也必须走落位算法（见 pickChipRect）。
 *
 * 红线：本目录不 import 引擎代码；本模块无任何依赖。
 */

/**
 * 本模块的几何输入输出（纯数字，不含 DOM）：
 * - `Rect` / `BBox`：`[x0, y0, x1, y1]`，单位随调用方（PDF 点或画布 px，本模块只做相对运算）
 * - `HasBBox`：解析块——只要求 `bbox` 存在且是数字数组（块的其他字段一律不读）
 * @typedef {[number, number, number, number]} Rect
 * @typedef {{ bbox?: number[] | null }} HasBBox
 * @typedef {{ bbox: number[] }} Region
 * @typedef {{ bbox?: number[] | null, label?: string, compact?: string }} ChipItem
 * @typedef {{ rect: Rect, label: string }} ChipPlacement
 * @typedef {{ rect: Rect, count: number }} LabelPlacement
 */

/** 相邻内容级区域聚合成一个标签的垂直间隙上限（pt）。 */
export const UNCOVERED_LABEL_GAP_PT = 24;
/** 框宽不足以容纳标签时不挂可见标签（改用 title）。 */
export const UNCOVERED_LABEL_MIN_W_PX = 56;
/** 标签高（与 CSS .uncovered-tag 的 line-height 一致）。 */
export const UNCOVERED_LABEL_H_PX = 14;
/** 标签宽估（「解析遗漏」4 字 @10px + 内边距 + 余量）。 */
export const UNCOVERED_LABEL_W_PX = 60;

/**
 * 标签矩形是否与任一解析块 bbox 相交（相交则不得挂可见标签 —— 不许遮正文）。
 * @param {Rect} rect
 * @param {HasBBox[] | null | undefined} blocks
 * @returns {boolean}
 */
export function labelOverlapsBlock(rect, blocks) {
  for (const b of blocks ?? []) {
    const bb = b && b.bbox;
    if (!Array.isArray(bb)) continue;
    const [x0, y0, x1, y1] = bb;
    if (rect[0] < x1 && rect[2] > x0 && rect[1] < y1 && rect[3] > y0) return true;
  }
  return false;
}

/**
 * 把相邻（同列、垂直间隙 ≤ GAP）的内容级区域并成标签组，避免「一区一标签」堆叠。
 * regions 每项形如 { bbox: [x0,y0,x1,y1], ... }；返回按 y 升序排好的组数组。
 * @param {Region[]} regions
 * @returns {Region[][]}
 */
export function groupContentForLabels(regions) {
  const n = regions.length;
  const parent = [...Array(n).keys()];
  /** @param {number} i @returns {number} */
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  /** @param {number} a @param {number} b */
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
  /** @type {Map<number, Region[]>} */
  const byRoot = new Map();
  regions.forEach((r, i) => {
    const root = find(i);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(r);
    else byRoot.set(root, [r]);
  });
  return [...byRoot.values()].map((rs) => rs.sort((a, b) => a.bbox[1] - b.bbox[1]));
}

/**
 * 在锚区域周围挑一个**不压正文**的标签位：
 * 依次试 左上角 / 上方 / 下方 / 垂直居中 / 右上角 / 右-垂直居中，返回首个既在页内、
 * 又与任何解析块 bbox 都不相交的矩形；都不行返回 null（该组不挂可见标签，仅靠 title）。
 * 为什么不能只挂「区域左上角」：见文件头注释（标签比漏识别行高，左上角必然压下一行）。
 * @param {number[]} bbox
 * @param {number} w
 * @param {number} h
 * @param {number} pageW
 * @param {number} pageH
 * @param {HasBBox[] | null | undefined} blocks
 * @returns {Rect | null}
 */
export function pickLabelRect(bbox, w, h, pageW, pageH, blocks) {
  const [ax, ay, ax1, ay1] = bbox;
  const bh = ay1 - ay;
  /** @type {[number, number][]} */
  const cands = [
    [ax, ay], // 左上角
    [ax, ay - h - 1], // 上方
    [ax, ay + bh + 1], // 下方
    [ax, ay + (bh - h) / 2], // 垂直居中
    [ax1 - w, ay], // 右上角
    [ax1 - w, ay + (bh - h) / 2], // 右-垂直居中
  ];
  for (const [x, y] of cands) {
    const rect = /** @type {Rect} */ ([x, y, x + w, y + h]);
    if (rect[0] < 0 || rect[1] < 0 || rect[2] > pageW || rect[3] > pageH) continue;
    if (!labelOverlapsBlock(rect, blocks)) return rect;
  }
  return null;
}

/** 题号牌字号（px，与 CSS `.q-chip.plain` 的 font-size 一致）。 */
export const CHIP_FONT_PX = 10;
/** 题号牌左右内边距合计（px，= CSS `.q-chip` 的 padding 1px 7px × 2 + 边框）。 */
export const CHIP_PAD_PX = 16;
/** 题号牌高（px，= CSS `.q-chip.plain` 的 font-size × line-height 1.3 + 上下 padding 2px）。 */
export const CHIP_H_PX = 15;

/**
 * 题号牌落位：优先**页边距**（左侧 → 右侧），其次块上方 / 下方；
 * 返回首个既在页内、又不与任何解析块 bbox 相交的矩形；都不行返回 null（该题不挂牌）。
 *
 * 为什么不能挂首块左上角：见文件头 2026-10-10 实测（牌子高 15px、宽 ≥19px，
 * 而块 bbox 紧贴墨迹 → 必压正文）。为什么优先页边距：实测题目首块**上方空隙中位仅 8pt**
 * （牌子高 15px ≈ 19pt 放不下），而**左边距中位 59pt / 最小 36pt**（够放紧凑牌）。
 * @param {number[]} bbox
 * @param {number} w
 * @param {number} h
 * @param {number} pageW
 * @param {number} pageH
 * @param {HasBBox[] | null | undefined} blocks
 * @returns {Rect | null}
 */
export function pickChipRect(bbox, w, h, pageW, pageH, blocks) {
  const [x0, y0, x1, y1] = bbox;
  /** @type {[number, number][]} */
  const cands = [
    [x0 - w - 1, y0], // 左侧页边距
    [x1 + 1, y0], // 右侧页边距
    [x0 - w - 1, y0 - h - 1], // 左上（外扩到边距）
    [x0, y0 - h - 1], // 上方
    [x0, y1 + 1], // 下方
  ];
  for (const [x, y] of cands) {
    const rect = /** @type {Rect} */ ([x, y, x + w, y + h]);
    if (rect[0] < 0 || rect[1] < 0 || rect[2] > pageW || rect[3] > pageH) continue;
    if (!labelOverlapsBlock(rect, blocks)) return rect;
  }
  return null;
}

/**
 * 标签像素宽（含内边距）：全角/CJK 按 1 字宽、ASCII 按半宽估。
 * @param {string} label
 * @returns {number}
 */
function chipTextWidthPx(label) {
  let em = 0;
  for (const ch of label) em += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.5;
  return em * CHIP_FONT_PX + CHIP_PAD_PX;
}

/**
 * 为一批题（每项 `{ bbox, label, compact }`）算出**不压正文**的题号牌落位。
 * 每题先试完整标签（`第N题`），放不下再试紧凑标签（`N`），都不行返回 null（不挂牌）。
 * 返回与入参等长的数组，元素为 `{ rect, label }` 或 null。
 * **硬不变量**（见测试）：非 null 的 rect 与 blocks 中任何 bbox 都不相交且在页内。
 * @param {ChipItem[]} items
 * @param {HasBBox[] | null | undefined} blocks
 * @param {number} pageW
 * @param {number} pageH
 * @param {number} canvasW
 * @returns {(ChipPlacement | null)[]}
 */
export function chipPlacements(items, blocks, pageW, pageH, canvasW) {
  const pxPerPt = canvasW / pageW;
  const h = CHIP_H_PX / pxPerPt;
  return items.map((it) => {
    if (!it.bbox) return null;
    for (const label of [it.label, it.compact]) {
      if (!label) continue;
      const w = chipTextWidthPx(label) / pxPerPt;
      const rect = pickChipRect(it.bbox, w, h, pageW, pageH, blocks);
      if (rect) return { rect, label };
    }
    return null;
  });
}
/**
 * 为内容级未覆盖区域算出「可见标签」的落位（每组一个）。
 * 返回 `[{ rect, count }]`：rect 为 PDF 点坐标的标签矩形，count 为该组区域数。
 * **保证**（硬不变量，见测试）：每个 rect 都与 blocks 中任何 bbox 不相交（不遮正文）且在页内；
 * 框宽放不下标签、或所有候选位都压正文的组**不产出**（改由 title 承载）。
 * @param {Region[]} regions
 * @param {HasBBox[] | null | undefined} blocks
 * @param {number} pageW
 * @param {number} pageH
 * @param {number} canvasW
 * @returns {LabelPlacement[]}
 */
export function contentLabelPlacements(regions, blocks, pageW, pageH, canvasW) {
  const pxPerPt = canvasW / pageW;
  const w = UNCOVERED_LABEL_W_PX / pxPerPt;
  const h = UNCOVERED_LABEL_H_PX / pxPerPt;
  /** @type {LabelPlacement[]} */
  const out = [];
  /** 区域宽（pt）。bbox 少于 4 个元素时按 0 宽 ⇒ 该组不挂标签，绝不 NaN。 */
  /** @param {number[]} bb @returns {number} */
  const widthOf = (bb) => (bb[2] ?? 0) - (bb[0] ?? 0);
  for (const group of groupContentForLabels(regions)) {
    // 锚 = 组内**最宽**区域（不是最靠上——最靠上的常是细碎条，会因过窄误弃整组标签）
    const anchor = group.reduce((a, b) => (widthOf(b.bbox) > widthOf(a.bbox) ? b : a));
    const wPx = (widthOf(anchor.bbox) / pageW) * canvasW;
    if (wPx < UNCOVERED_LABEL_MIN_W_PX) continue; // 框宽放不下标签 → 不挂（title 已够）
    const rect = pickLabelRect(anchor.bbox, w, h, pageW, pageH, blocks);
    if (!rect) continue; // 候选位都会压正文 → 不挂（title 已够）
    out.push({ rect, count: group.length });
  }
  return out;
}
