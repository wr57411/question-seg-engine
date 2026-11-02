// tests/badge-label-guard.test.ts —— 徽标题号「紧跟字 = 题」守卫（2026-10-29 电路/磁场实测）
//
// 实测缺陷：出处标注在 OXR 折行处被切成两块，
//   `3[鲁科版必修三 P115 第` + `5 题设问变式] 如图是…`
// 第二块行首是「5 + 空格 + 题」，命中 `BARE_BADGE_QUESTION` 的第二分支
// ⇒ 被当成题号 5 开了一道新题：上一题题干只剩 `[鲁科版必修三 P115 第`（14 字），
//   正文被搬到那道假题里，且与后面真正的第 5 题**同号重号**。
// 全 15 册扫描：该形态共 3 处（电路 p2 ×1、磁场 p2/p6 ×2），全部是出处标注折行残片。
//
// 修法与 `§77` 的 `GLUED_NOT_QUESTION_CHARS` 对齐：`题` 是标签字
// （`第5题` 的「题」），数字后接它必然不是题号开头。
import assert from "node:assert/strict";
import { test } from "node:test";
import { bandOrdinal, matchFirstLine } from "../src/patterns.js";

const cases: [string, string][] = [
  ["5 题设问变式] 如图是", "电路 p2：`第5题设问变式` 的折行残片"],
  ["2 题设问变式] 如图所", "磁场 p2：同上"],
  ["3 题拓展变式] 如图所", "磁场 p6：同上"],
];

for (const [line, why] of cases) {
  test(`徽标题号守卫：「${line}」不是题号（${why}）`, () => {
    const m = matchFirstLine(line);
    assert.notEqual(m.ok && m.kind, "question_no", `「${line}」被误判成题号，会切断上一题题干`);
  });
}

test("徽标题号既有行为不变：数字 + 空格 + 「一」仍按题号处理（本次不扩大收严范围）", () => {
  const m = matchFirstLine("1 一个简易风速测量仪");
  // 这条锁定既有行为：`一` 不在排除名单里。本次只加「题」，不动其它字。
  assert.equal(m.ok && m.kind, "question_no");
  assert.equal(m.ok && m.captured, "1");
});

test("徽标题号回归：数字 + 空格 + 年份仍是题号", () => {
  const m = matchFirstLine("3 2024 广西卷 [人教版必修三 P71 图 11.4-9 拓展变式]");
  assert.equal(m.ok && m.kind, "question_no");
  assert.equal(m.ok && m.captured, "3");
});

test("徽标题号回归：数字紧跟方括号仍是题号", () => {
  const m = matchFirstLine("2[鲁科版必修三 P146 科学书屋拓展变式]中国宋代");
  assert.equal(m.ok && m.kind, "question_no");
  assert.equal(m.ok && m.captured, "2");
});

// 折行残片（`DECISIONS §78`）：`1)条刻线的总长度相等。…` 是原文 `(n-1)条刻线…` 被折断的尾巴。
// 判据：分隔符后紧跟量词/标签字（与 §77 的 GLUED_NOT_QUESTION_CHARS 同一份语义）。
test("折行残片：「1)条刻线的总长度相等」不是题号", () => {
  const m = matchFirstLine("1)条刻线的总长度相等。常见的几种卡尺分类");
  assert.notEqual(m.ok && m.kind, "question_no");
});

test("折行残片守卫不漏真题：「1）下列说法正确的是」仍是题号", () => {
  const m = matchFirstLine("1）下列说法正确的是");
  assert.equal(m.ok && m.kind, "question_no");
  assert.equal(m.ok && m.captured, "1");
});

// ---- 序号佐证守卫（`DECISIONS §97`，2026-10-31 磁场 p3/p4 原卷页图确证）----
//
// 缺陷：`BARE_BADGE_QUESTION` 第二分支「数字 + 空格 + 汉字」没有序号约束，
// 于是把**正文里的数字**当成题号开了新题：
//   p3 原卷 `2024 年 10 月 5 日晚,我国多地出现绝美极光…` → 折行后行首 `10 月 5 日晚…`
//      ⇒ 被判成题号 10（真相是第 3 题）；
//   p4 原卷 `…人教版选修二 P16 第3题设问变式]Oxy坐标平面内…` → 折行后行首 `16 第3题设问变式]…`
//      ⇒ 被判成题号 16（真相是变式 2 的第 3 题）。
// 两处都切出「题号错 + 题干从中间起 + 与真题重复」的假题。
//
// 守卫：弱信号分支必须有**序号佐证** —— 等于上一题 + 1，或是本组第一题（`1`）。
test("序号守卫：`10 月 5 日晚…` 上一题是 3 ⇒ 不是题号（10 ≠ 4）", () => {
  const m = matchFirstLine("10 月 5 日晚,我国多地出现绝美极光,实际上", 4);
  assert.notEqual(m.ok && m.kind, "question_no");
});

test("序号守卫：`16 第3题设问变式]Oxy坐标平面内` 上一题是 3 ⇒ 不是题号（16 ≠ 4）", () => {
  const m = matchFirstLine("16 第3题设问变式]Oxy坐标平面内一有界匀强磁场区", 4);
  assert.notEqual(m.ok && m.kind, "question_no");
});

test("序号守卫：序号连续时仍认（数字 + 空格 + 汉字）", () => {
  const m = matchFirstLine("2 一个简易风速测量仪", 2);
  assert.equal(m.ok && m.kind, "question_no");
  assert.equal(m.ok && m.captured, "2");
});

test("序号守卫：题号归 1（组内重启）时仍认，即使上一题不是 0", () => {
  const m = matchFirstLine("1 一个简易风速测量仪", 7);
  assert.equal(m.ok && m.kind, "question_no");
  assert.equal(m.ok && m.captured, "1");
});

test("序号守卫：无上下文（null）时不拦，保持既有行为", () => {
  const m = matchFirstLine("10 月 5 日晚,我国多地出现绝美极光", null);
  // 无上一题可参照 ⇒ 不施加守卫（与加守卫前一致）；真实调用中只有在首题/节首才出现
  assert.equal(m.ok && m.kind, "question_no");
});

test("序号守卫：强信号分支不受影响（数字 + 方括号/年份有出处佐证）", () => {
  const a = matchFirstLine("3 2024 广西卷 [人教版必修三 P71 图 11.4-9 拓展变式]", 7);
  assert.equal(a.ok && a.kind, "question_no");
  const b = matchFirstLine("2[鲁科版必修三 P146 科学书屋拓展变式]中国宋代", 7);
  assert.equal(b.ok && b.kind, "question_no");
});

// 板块序号（`DECISIONS §79`）：只有 `教材实验 N` 有序号 —— 它决定「整块无题号时按栏目序号开题」。
// 其它板块（教材素材变式/教材知识萃取/素养演练）没有序号，必须返回 null，否则会凭空开题。
test("bandOrdinal：只认教材实验 N", () => {
  assert.equal(bandOrdinal("教材实验 10 长度的测量及其测量工具的选取"), "10");
  assert.equal(bandOrdinal("教材实验12练习使用多用电表"), "12");
  assert.equal(bandOrdinal("教材实验4探究加速度与力、质量的关系"), "4");
});

test("bandOrdinal：其它板块不开题", () => {
  assert.equal(bandOrdinal("教材素材变式 多维变式，夯基础"), null);
  assert.equal(bandOrdinal("教材知识萃取 回归教材，萃精华"), null);
  assert.equal(bandOrdinal("素养演练 跟踪拓展，培素养素养1 物理观念"), null);
});
