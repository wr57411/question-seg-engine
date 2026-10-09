// block-dedup.test.ts —— 同页块级重复「并集合并」的回归锁定（Task 15 + 修复轮 1）。
//
// 为什么需要它：这是「改写渲染文本」类变换（lessons.md L2：判据必须最严），判据一旦被放宽
// （去掉「同一行」或去掉「公共子串」），会误并正文且无人察觉；而合并算法若把重叠部分重复
// 计入或丢掉真实尾部，会**静默改坏内容**。用例锚定：
//   ① 第 9 页第 8 题 D 的**真实 bbox/文本**（目标案例）：命中 → 并集文本 = 完整一行、bbox = 并集；
//   ② 反例：不同行 / 文本无关 / 图片块 / 公共子串过短 / x 不相交 —— 都**不得**命中；
//   ③ 合并守卫：互含取长者、1 字符重叠不算、并集须严格长于任一单块（否则保留原样不处理）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUP_MIN_COMMON,
  DUP_Y_OVERLAP_MIN,
  MERGE_MIN_OVERLAP,
  crossBlockMerges,
  dedupPlainText,
  isCrossBlockDuplicate,
  longestCommonSubstring,
  mergeTexts,
  unionBbox,
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
/** 目标并集文本（块内折叠先做 → 在「增大」处拼接、重叠 2 字符只出现一次）。 */
const TARGET_MERGED = "D. 绳a的拉力$F _ { a }$增大，杆的压力F大小不变";

test("目标案例：p8 第8题 D 的两块判为同页重复", () => {
  assert.equal(isCrossBlockDuplicate(BLK23, BLK25), true);
});

test("目标案例：合并为完整一行、渲染位置取两块 bbox 并集", () => {
  const ms = crossBlockMerges([BLK23, BLK25]);
  assert.equal(ms.length, 1);
  const m = ms[0];
  assert.ok(m); // 收窄类型（node:assert 的 asserts 签名）
  assert.equal(m.keepI, 23); // 承载块 = 文本更长者（信息更全）
  assert.equal(m.dropI, 25);
  assert.equal(m.merged?.text, TARGET_MERGED);
  assert.equal(m.merged?.overlap, 2); // 重叠「增大」只出现一次
  assert.deepEqual(m.bbox, [49, 448, 272, 462]); // 两块 bbox 并集
});

test("目标案例：与传入顺序无关（keepI/dropI/并集文本一致）", () => {
  const [m] = crossBlockMerges([BLK25, BLK23]);
  assert.ok(m);
  assert.equal(m.keepI, 23);
  assert.equal(m.dropI, 25);
  assert.equal(m.text, TARGET_MERGED);
  assert.deepEqual(m.bbox, [49, 448, 272, 462]);
});

test("同页守卫：只比较传入数组内部（单块 → 无命中）", () => {
  assert.equal(crossBlockMerges([BLK23]).length, 0);
  assert.equal(crossBlockMerges([BLK25]).length, 0);
  assert.equal(crossBlockMerges(undefined).length, 0);
});

test("反例：A 选项的两行（bbox 不相交，非同一行）不得命中", () => {
  // p8 blocks[17]/blocks[18]：A 选项第一行与续行，y 区间 [334,349] / [352,367] 不相交
  const a1 = { i: 17, kind: "text", bbox: [49, 334, 203, 349], text: "A. 绳 a的拉力$F _ { a }$减小，杆的压" };
  const a2 = { i: 18, kind: "text", bbox: [61, 352, 135, 367], text: "力F大小不变" };
  assert.equal(isCrossBlockDuplicate(a1, a2), false);
  assert.equal(crossBlockMerges([a1, a2]).length, 0);
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

// ── 合并算法 mergeTexts ─────────────────────────────────────────────────────
test("mergeTexts：目标案例 → A 头 + B 尾，重叠只出现一次（dir=ab）", () => {
  const r = mergeTexts("D. 绳a的拉力$F _ { a }$增大.杆的压", "增大，杆的压力F大小不变");
  assert.equal(r?.text, TARGET_MERGED);
  assert.equal(r?.overlap, 2);
  assert.equal(r?.dir, "ab");
});

test("mergeTexts：互含 → 取长者（dir=contains）", () => {
  assert.deepEqual(mergeTexts("abcdef", "bcd"), { text: "abcdef", overlap: 3, dir: "contains" });
  assert.deepEqual(mergeTexts("bcd", "abcdef"), { text: "abcdef", overlap: 3, dir: "contains" });
});

test("mergeTexts：无重叠 / 1 字符重叠 → null（保留原样不处理）", () => {
  assert.equal(mergeTexts("abc", "xyz"), null);
  assert.equal(MERGE_MIN_OVERLAP, 2);
  // 仅 1 字符重叠（「X」）低于 MERGE_MIN_OVERLAP → 不合并
  assert.equal(mergeTexts("aX", "Xb"), null);
});

test("mergeTexts 守卫：并集必须严格长于任一单块（匹配落在中部 → null）", () => {
  // a 比 b 长，且重叠点太靠前 → 拼接结果「前言甲乙丙戊」不比 a「前言甲乙丙丁」长 → 不合并
  assert.equal(mergeTexts("前言甲乙丙丁", "甲乙丙戊"), null);
});

test("unionBbox：两块 bbox 的并集", () => {
  assert.deepEqual(unionBbox([49, 448, 204, 462], [136, 449, 272, 462]), [49, 448, 272, 462]);
  assert.deepEqual(unionBbox([10, 20, 30, 40], [5, 25, 25, 35]), [5, 20, 30, 40]);
});

test("crossBlockMerges：命中但无法合并 → merged=null（保留原样不处理）", () => {
  // 同一行、横向相交、公共子串「甲乙丙」=3（命中判据），但拼接不严格更长 → 无法合并
  const a = { i: 1, kind: "text", bbox: [10, 100, 90, 114], text: "前言甲乙丙丁" };
  const b = { i: 2, kind: "text", bbox: [40, 100, 120, 114], text: "甲乙丙戊" };
  assert.equal(isCrossBlockDuplicate(a, b), true);
  const ms = crossBlockMerges([a, b]);
  assert.equal(ms.length, 1);
  assert.ok(ms[0]);
  assert.equal(ms[0].merged, null);
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
