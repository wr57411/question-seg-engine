/**
 * block-dedup.js —— 同页「同一行被上游读成两个 bbox 重叠的块」的展示层去重（纯函数，无 DOM）。
 *
 * ── 背景（Task 15）────────────────────────────────────────────────────────────
 * Task 12 折叠了「**块内**」的即时重复前缀，但第 9 页第 8 题 D 仍有叠字。根因是**跨块**：
 * 上游把**同一物理行**读成了两个 bbox 在 y 方向重叠的块 ——
 *   blk23 = `"D. 绳a的拉力D. 绳a的拉力$F _ { a }$增大.杆的压"` bbox=[49,448,204,462]
 *   blk25 = `"增大，杆的压力F大小不变"`                        bbox=[136,449,272,462]
 * 两块 y 区间几乎完全重合（同一行），x 区间相交 68pt ⇒ 渲染后文字互相压叠（叠字）。
 *
 * ── 判据（**只此一处定义**）──────────────────────────────────────────────────
 * 计划 Ruling 的字面判据是「一块的文本是另一块的**子串**或**前缀**」。**实测该判据对目标
 * 案例不成立**（`"增大，杆的压力F大小不变"` 既非 `blk23` 的子串也非其前缀；反之亦然），
 * 照字面实现全卷命中 **0 处**、修不了目标缺陷。故改用下列**结构 + 文本**判据，并**保持最严**
 * （lessons.md L2：搬迁/丢弃类规则的判据宁可漏判不可误判）：
 *   ① 同页（调用方保证：只在本页 `blocks` 内两两比较——**同页守卫**）；
 *   ② 两块都非图片块、文本非空；
 *   ③ **同一行**：y 方向重叠 / 较小块高 ≥ `DUP_Y_OVERLAP_MIN`（0.6）；
 *   ④ **横向相交**：x 区间重叠 > 0；
 *   ⑤ **文本有实质公共内容**：去 LaTeX 与空白后的纯文本，最长公共子串 ≥ `DUP_MIN_COMMON`（3）。
 *
 * 保守性实测（全卷 15 页 / 1061 行级块）：同页非图片块对中 bbox 相交的**只有 4 对**，
 * 其中 y 重叠比 ≥ 0.6（即同一行）的**只有 1 对**（p8[23,25]，即目标）。判据几乎无过拟合空间。
 *
 * ── 处置 ────────────────────────────────────────────────────────────────────
 * 保留**信息更全的那块（文本更长者）**，另一块**不渲染**；调用方（stages.js）必须给被丢弃的块
 * 画一个**极淡的虚线框 + title**（G1：保留可见优于静默删除）。本模块只回答「丢弃哪一块」，
 * 不做任何 DOM 操作、不改写任何文本。
 *
 * ⚠️ 已知代价（如实登记，见 Task 15 报告「遗留疑虑」）：目标案例里两块是**同一行的两段读数**，
 * `blk23`（较长）缺尾 `"力F大小不变"`、`blk25`（较短）缺头 `"D. 绳a的拉力$F_{a}$"` ——
 * 「保留较长者」保住了选项标记 D 与行首，代价是渲染行少了 `blk25` 独有的尾部；
 * 该尾部文字仍在被丢弃块的可见标记的 `title` 里（非静默）。
 *
 * 供 stages.js 使用；tests/block-dedup.test.ts 回归锁定。
 */

/** y 方向重叠 / 较小块高 的下限（同一行判定；实测目标 = 1.000，次高对 = 0.385）。 */
export const DUP_Y_OVERLAP_MIN = 0.6;
/** 纯文本最长公共子串长度下限（实质公共内容判定）。 */
export const DUP_MIN_COMMON = 3;

const isImage = (b) => b?.kind === "image";
const textOf = (b) => (typeof b?.text === "string" ? b.text : "");

/**
 * 去 LaTeX 命令名、`$`/`\`/`{}` 与全部空白后的可见纯文本（仅用于公共子串比较）。
 * `_`/`^`（上下标标记）保留 —— 比较用，不追求与渲染文本逐字一致。
 * 例：`"D. 绳a的拉力$F _ { a }$增大"` → `"D.绳a的拉力F_a增大"`。
 */
export function dedupPlainText(text) {
  return String(text).replace(/\\[A-Za-z]+/g, "").replace(/[$\\{}]/g, "").replace(/\s+/g, "");
}

/** 两个字符串的最长公共子串长度（朴素 DP，O(m·n)；输入是单块短文本，规模可忽略）。 */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 判据（只此一处定义）：同页两块是否为「同一行被读成两块」的重复。
 * 仅比较形状与文本，不含任何页/栏上下文 —— 同页守卫由调用方（只在本页 blocks 内两两比较）保证。
 * @param {{kind?:string,text?:string,bbox:number[]}} a
 * @param {{kind?:string,text?:string,bbox:number[]}} b
 * @returns {boolean}
 */
export function isCrossBlockDuplicate(a, b) {
  if (isImage(a) || isImage(b)) return false;
  const ta = textOf(a);
  const tb = textOf(b);
  if (!ta || !tb) return false;
  // ③ 同一行：y 方向显著重叠
  const y0 = Math.max(a.bbox[1], b.bbox[1]);
  const y1 = Math.min(a.bbox[3], b.bbox[3]);
  const hMin = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
  if (hMin <= 0 || (y1 - y0) / hMin < DUP_Y_OVERLAP_MIN) return false;
  // ④ 横向相交
  if (Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]) <= 0) return false;
  // ⑤ 文本有实质公共内容
  return longestCommonSubstring(dedupPlainText(ta), dedupPlainText(tb)) >= DUP_MIN_COMMON;
}

/**
 * 返回本页**应丢弃渲染**的块 `i` 集合（同页守卫：只在本页 `blocks` 内两两比较）。
 * 处置：保留文本更长者；文本等长时保留 bbox 更靠左上者（保证确定性、可重复）。
 * @param {{i:number,kind?:string,text?:string,bbox:number[]}[]} blocks
 * @returns {Set<number>}
 */
export function droppedDuplicateIndices(blocks) {
  const list = blocks ?? [];
  const drop = new Set();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!isCrossBlockDuplicate(a, b)) continue;
      const la = textOf(a).length;
      const lb = textOf(b).length;
      if (la !== lb) drop.add(la > lb ? b.i : a.i);
      else {
        // 等长：保留 bbox 更靠左上者（先比 y0，再比 x0）
        const aFirst = a.bbox[1] < b.bbox[1] || (a.bbox[1] === b.bbox[1] && a.bbox[0] <= b.bbox[0]);
        drop.add(aFirst ? b.i : a.i);
      }
    }
  }
  return drop;
}
