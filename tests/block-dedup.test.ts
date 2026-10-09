// block-dedup.test.ts —— 同页块级重复去重的回归锁定（Task 15）。
//
// 为什么需要它：这是「丢弃渲染」类变换（lessons.md L2：判据必须最严），判据一旦被放宽
// （去掉「同一行」或去掉「公共子串」），会误丢正文且无人察觉。用例锚定：
//   ① 第 9 页第 8 题 D 的**真实 bbox/文本**（目标案例，必须命中，且丢弃较短块 blocks[25]）；
//   ② 反例：同一行但文本无关 / 不同行 / 图片块 / 公共子串过短 —— 都**不得**命中。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUP_MIN_COMMON,
  DUP_Y_OVERLAP_MIN,
  dedupPlainText,
  droppedDuplicateIndices,
  isCrossBlockDuplicate,
  longestCommonSubstring,
} from "../stages/block-dedup.js";

// ── 真实案例（data/out/23必刷题 2相互作用/stages.json · pages[8]）────────────────
/** p8 blocks[23]：选项段里被读成 D 行的那块（含上游即时重复前缀，Task 12 已折叠）。 */
const BLK23 = {
  i: 23,
  kind: "text",
  bbox: [49, 448, 204, 462],
  text: "D. 绳a的拉力D. 绳a的拉力$F _ { a }$增大.杆的压",
};
/** p8 blocks[25]：同一物理行的**独立 raw 块**（D 行尾部），bbox 与 blk23 在 y 方向重叠。 */
const BLK25 = {
  i: 25,
  kind: "text",
  bbox: [136, 449, 272, 462],
  text: "增大，杆的压力F大小不变",
};

test("目标案例：p8 第8题 D 的两块判为同页重复", () => {
  assert.equal(isCrossBlockDuplicate(BLK23, BLK25), true);
});

test("目标案例：丢弃较短块（保留文本更长者 blk23）", () => {
  const drop = droppedDuplicateIndices([BLK23, BLK25]);
  assert.deepEqual([...drop], [25]);
  // 与传入顺序无关
  assert.deepEqual([...droppedDuplicateIndices([BLK25, BLK23])], [25]);
});

test("同页守卫：只比较传入数组内部（单块 → 空集）", () => {
  assert.equal(droppedDuplicateIndices([BLK23]).size, 0);
  assert.equal(droppedDuplicateIndices([BLK25]).size, 0);
  assert.equal(droppedDuplicateIndices(undefined).size, 0);
});

test("反例：A 选项的两行（bbox 不相交，非同一行）不得命中", () => {
  // p8 blocks[17]/blocks[18]：A 选项第一行与续行，y 区间 [334,349] / [352,367] 不相交
  const a1 = { i: 17, kind: "text", bbox: [49, 334, 203, 349], text: "A. 绳 a的拉力$F _ { a }$减小，杆的压" };
  const a2 = { i: 18, kind: "text", bbox: [61, 352, 135, 367], text: "力F大小不变" };
  assert.equal(isCrossBlockDuplicate(a1, a2), false);
  assert.equal(droppedDuplicateIndices([a1, a2]).size, 0);
});

test("反例：同一行、bbox 重叠但文本无公共内容 → 不命中", () => {
  const a = { i: 1, kind: "text", bbox: [10, 100, 90, 114], text: "完全无关的第一段文字" };
  const b = { i: 2, kind: "text", bbox: [40, 100, 120, 114], text: "另外一句毫无重叠的话" };
  assert.equal(isCrossBlockDuplicate(a, b), false);
});

test("反例：图片块不参与", () => {
  const img = { i: 24, kind: "image", bbox: [212, 334, 278, 420], text: "[图片]" };
  const txt = { i: 25, kind: "text", bbox: [136, 449, 272, 462], text: "增大，杆的压力F大小不变" };
  assert.equal(isCrossBlockDuplicate(img, txt), false);
  assert.equal(isCrossBlockDuplicate(txt, img), false);
});

test("反例：公共子串不足 DUP_MIN_COMMON → 不命中", () => {
  const a = { i: 1, kind: "text", bbox: [10, 100, 90, 114], text: "甲乙丙丁戊己庚辛" };
  const b = { i: 2, kind: "text", bbox: [40, 100, 120, 114], text: "庚辛子丑寅卯辰巳" };
  // 公共子串「庚辛」= 2 < 3
  assert.equal(longestCommonSubstring("甲乙丙丁戊己庚辛", "庚辛子丑寅卯辰巳"), 2);
  assert.ok(DUP_MIN_COMMON === 3);
  assert.equal(isCrossBlockDuplicate(a, b), false);
});

test("边界：y 重叠比 = DUP_Y_OVERLAP_MIN 命中；略小则不命中", () => {
  const mk = (i: number, y0: number) => ({ i, kind: "text", bbox: [10, y0, 90, y0 + 10], text: "测试文本内容" });
  // A: y[0,10]；B: y[4,14] → 重叠 6/10 = 0.6（= 阈值）→ 命中
  assert.equal(DUP_Y_OVERLAP_MIN, 0.6);
  assert.equal(isCrossBlockDuplicate(mk(1, 0), mk(2, 4)), true);
  // B: y[5,15] → 重叠 5/10 = 0.5 < 0.6 → 不命中
  assert.equal(isCrossBlockDuplicate(mk(1, 0), mk(2, 5)), false);
});

test("反例：同一行但 x 不相交 → 不命中（双栏/并排元素）", () => {
  const a = { i: 1, kind: "text", bbox: [10, 100, 90, 114], text: "相同的文本内容" };
  const b = { i: 2, kind: "text", bbox: [100, 100, 180, 114], text: "相同的文本内容" };
  assert.equal(isCrossBlockDuplicate(a, b), false);
});

test("等长文本：保留 bbox 更靠左上者（确定性）", () => {
  const a = { i: 7, kind: "text", bbox: [50, 200, 150, 214], text: "一模一样的文字" };
  const b = { i: 9, kind: "text", bbox: [80, 200, 180, 214], text: "一模一样的文字" };
  assert.deepEqual([...droppedDuplicateIndices([a, b])], [9]);
  assert.deepEqual([...droppedDuplicateIndices([b, a])], [9]);
});

test("dedupPlainText：去 LaTeX 命令/定界符/空白（`_`/`^` 保留）", () => {
  assert.equal(dedupPlainText("D. 绳a的拉力$F _ { a }$增大"), "D.绳a的拉力F_a增大");
  assert.equal(dedupPlainText("$\\frac { \\Delta F } { \\Delta L }$"), "FL");
});

test("longestCommonSubstring：基本用例", () => {
  assert.equal(longestCommonSubstring("abcde", "cdefg"), 3);
  assert.equal(longestCommonSubstring("", "abc"), 0);
  assert.equal(longestCommonSubstring("增大", "增大"), 2);
});
