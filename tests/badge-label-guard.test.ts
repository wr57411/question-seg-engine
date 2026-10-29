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
import { matchFirstLine } from "../src/patterns.js";

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
