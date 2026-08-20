// tests/patterns-fraction.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchAnswerEntry, matchFirstLine, stripQuestionPrefix } from "../src/patterns.js";

test("0.x 小数行不再判为题号（幽灵题号守卫）", () => {
  for (const line of ["0.2,最大静摩擦力与滑动摩擦力大小相等", "0.8,不计滑轮与轻绳间的摩擦", "0.5,最大静摩擦力等于滑动摩擦力", "0.4kg的小球，劲度系数为"]) {
    assert.notEqual(matchFirstLine(line).kind, "question_no", `「${line}」不应是题号`);
    assert.equal(matchFirstLine(line).kind, "other");
  }
});

test("真题号形态不受影响", () => {
  assert.equal(matchFirstLine("1．设集合 A = {x}，则…").kind, "question_no");
  assert.equal(matchFirstLine("1. 设集合 A = {x}，则…").kind, "question_no");
  assert.equal(matchFirstLine("2.已知函数 f(x) = 2x - 4，则…").kind, "question_no");
  assert.equal(matchFirstLine("3) 求 a、b 的值").kind, "question_no");
  assert.equal(matchFirstLine("（2）求 f(x) 的最大值").kind, "question_no");
});

test("分支 1 加固：数字与半角点间空格容忍，但空格后接数字仍拒（0 . 2）", () => {
  assert.equal(matchFirstLine("1 . 设集合 A = {x}，则…").kind, "question_no", "「1 . 设」应恢复容忍");
  assert.equal(matchFirstLine("12 . 已知函数 f(x)，则…").kind, "question_no", "两位数 + 空格 + 半角点也应放行");
  assert.notEqual(matchFirstLine("0 . 2,最大静摩擦力与滑动摩擦力大小相等").kind, "question_no", "「0 . 2,」空格后仍接数字 → 仍应拒");
  assert.equal(matchFirstLine("0 . 2,最大静摩擦力与滑动摩擦力大小相等").kind, "other");
});

test("stripQuestionPrefix：小数行前缀保留进题干，真题号正常剥除", () => {
  // 守卫：0.x 行不作为题号剥离，前缀原样保留进题干（Task 2 手工实测的自动化契约）
  assert.equal(stripQuestionPrefix("0.5,最大静摩擦力等于滑动摩擦力，重力加速度"), "0.5,最大静摩擦力等于滑动摩擦力，重力加速度");
  assert.equal(stripQuestionPrefix("0.4kg的小球，劲度系数为"), "0.4kg的小球，劲度系数为");
  // 真题号两分支形态正常剥除（含数字与半角点间空格 → 与 ARABIC_QUESTION 判定层一致）
  assert.equal(stripQuestionPrefix("1．设集合 A = {x}"), "设集合 A = {x}");
  assert.equal(stripQuestionPrefix("2.已知函数 f(x) = 2x - 4"), "已知函数 f(x) = 2x - 4");
  assert.equal(stripQuestionPrefix("1 . 设集合 A = {x}"), "设集合 A = {x}", "「1 . 设」判定层可过，剥离层必须同步剥除");
  // 空格后接数字仍不剥（"0 . 2," 与 "0.2," 同属小数形态）
  assert.equal(stripQuestionPrefix("0 . 2,最大静摩擦力与滑动摩擦力大小相等"), "0 . 2,最大静摩擦力与滑动摩擦力大小相等");
});

test("matchAnswerEntry：答案条目「1．B」正常解析，0.x 行守卫生效", () => {
  assert.deepEqual(matchAnswerEntry("1．B"), { number: "1", text: "B" });
  assert.deepEqual(matchAnswerEntry("2. C"), { number: "2", text: "C" });
  assert.deepEqual(matchAnswerEntry("3) A、B"), { number: "3", text: "A、B" });
  assert.equal(matchAnswerEntry("0.5,不"), null, "0.x 行不应判为答案条目");
  assert.equal(matchAnswerEntry("0 . 5,不"), null, "「0 . 5」空格后仍接数字 → 仍应拒");
  assert.deepEqual(matchAnswerEntry("1 . B"), { number: "1", text: "B" }, "与判定层一致的「1 . B」应可解析");
});