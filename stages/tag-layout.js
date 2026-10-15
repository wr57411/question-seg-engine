// @ts-check —— 本文件纳入 tsc 检查（展示层是浏览器直接加载的 .js，没有构建步骤，
// 所以类型写在 JSDoc 里；见 DECISIONS.md §31）。
/**
 * tag-layout.js —— 标签短码列的落位（纯函数，无 DOM；展示层自有模块，不 import 引擎 src/）
 *
 * 为什么需要单独算：题号牌独占 22px 留白（`GUTTER`），标签竖排在号牌**下方**，
 * 而**密页里相邻题目起始位置挨得很近**（答案册 86 块/页），两列必然撞车。
 * 号牌当年的教训是「页内找空白、放不下就不挂」⇒ 密页几乎一个都不显示，用户看到的是
 * 「题号没识别出来」（reconstruct.js 留白注释区）。标签若照抄这个策略会重演同一起事故，
 * 所以这里定的是**三级降级、绝不静默**：
 *
 *   full  → 短码竖排（≤3 个）+ `+N` 折叠块
 *   count → 折成单个计数块（1 行）
 *   chip  → 不占独立行，改为在题号牌上挂 `n` 角标（号牌本身永远在）
 *
 * 三级的共同点：**打过标的题一定看得见标记**，只是详略不同；数据永远在面板里全量可见（U3/U6）。
 *
 * ⚠️ 口径：留白里的元素是 **CSS 像素**（号牌 14px、短码 12px），而题目起始位置是
 * **页高百分比**（`bbox[1] / p.height`）。两者混算必先换算 —— 本模块统一在 px 域工作，
 * 由调用方（renderPaper）传入 `canvasH = innerW × p.height / p.width`。
 */

/** 题号牌占位高（与 `.q-chip.plain` 的 line-height 一致） */
export const CHIP_H = 14;
/** 单个短码块占位高（与 `.qtag` 的 line-height 一致） */
export const TAG_LINE_H = 12;
/** 短码块之间的间距（与 `.qtag` 的 margin-bottom 一致）。
 *  ⚠️ 必须计入占位：2026-10-15 全页审板抓到答案册 1 处标签列互相重叠，
 *  根因就是模型按 12px/行算、CSS 实际每行 13px（12 + 1 间距），5 行差 4px 刚好撞上下一题。 */
export const TAG_LINE_GAP = 1;
/** 每行的实际占位（行高 + 间距） */
export const TAG_PITCH = TAG_LINE_H + TAG_LINE_GAP;
/** 常驻最多显示几个，超出折成 `+N`（需求 U3） */
export const MAX_VISIBLE = 3;

/** @typedef {"left" | "right"} TagSide */
/** @typedef {"full" | "count" | "chip"} StackLevel */
/**
 * @typedef {Object} TagStackItem
 * @property {string} key 稳定标识（用 q.id）
 * @property {TagSide} side
 * @property {number} topPx 该题首块在画布里的像素顶边
 * @property {number} tagCount
 */
/**
 * @typedef {Object} TagPlacement
 * @property {StackLevel} level
 * @property {TagSide} side
 * @property {number} topPx
 * @property {number} tagCount
 */

/** 一个题目需要占多少竖排高度（px） */
/**
 * @param {number} tagCount
 * @param {StackLevel} level
 * @returns {number}
 */
export function stackHeight(tagCount, level) {
  if (level === "chip") return 0;
  if (level === "count") return TAG_PITCH;
  const lines = Math.min(tagCount, MAX_VISIBLE) + (tagCount > MAX_VISIBLE ? 1 : 0);
  return lines * TAG_PITCH;
}

/**
 * 计算一页内所有**已打标**题目的标签列落位。
 *
 * @param items   [{ key, side:"left"|"right", topPx, tagCount }]
 *                `topPx` = 该题首块在画布里的像素顶边；`key` = 稳定标识（用 q.id）
 * @param canvasH 画布像素高（用于「不能越过页底」判定）
 * @returns Map<key, { level:"full"|"count"|"chip", topPx, side, tagCount }>
 */
/**
 * @param {TagStackItem[]} items
 * @param {number} canvasH
 * @returns {Map<string, TagPlacement>}
 */
export function tagStackPlacements(items, canvasH) {
  const out = new Map();
  for (const side of ["left", "right"]) {
    const list = items
      .filter((x) => x.side === side)
      .sort((a, b) => a.topPx - b.topPx);
    let occupiedBottom = -Infinity;
    for (const it of list) {
      const top = it.topPx + CHIP_H + 1; // 紧贴号牌下方
      // 撞不撞上一题的列，与"降到哪一级"无关：只跟这一列的**顶边**和已占用底边比
      const bumps = top < occupiedBottom;
      /** @param {StackLevel} lv */
      const fits = (lv) => top + stackHeight(it.tagCount, lv) <= canvasH;
      /** @type {StackLevel} */
      let level = "full";
      if (bumps || !fits(level)) level = "count";
      if (bumps || !fits(level)) level = "chip";
      occupiedBottom = level === "chip" ? Math.max(occupiedBottom, it.topPx + CHIP_H) : top + stackHeight(it.tagCount, level);
      out.set(it.key, { level, side, topPx: top, tagCount: it.tagCount });
    }
  }
  return out;
}

/** 短码列要显示的内容：full = 前 min(n,3) 个短码 + `+剩余`；count/chip = 只报总数 */
/**
 * @param {number} tagCount
 * @param {StackLevel} level
 * @returns {{ visible: number, more: number, countBadge: number }}
 */
export function stackContents(tagCount, level) {
  if (level === "full") {
    return { visible: Math.min(tagCount, MAX_VISIBLE), more: Math.max(0, tagCount - MAX_VISIBLE), countBadge: 0 };
  }
  return { visible: 0, more: 0, countBadge: tagCount };
}
