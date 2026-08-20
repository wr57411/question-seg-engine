// tests/patterns-fraction.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";

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