// normalize-eq.test.ts —— 等价性归一化判等（用户口径：空格/点号大小/全半角 = 语义等价，
// 不算错；2026-11-11 p016_h0 无谓升级事故的回归守卫）。
// 保守边界：不折叠大小写、不合并形近字（J/j、O/0 仍判不等价）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEq } from "../scripts/ocr-lib.js";

test("空格差判等（p016_h0 无谓升级事故回归）", () => {
  assert.equal(
    normalizeEq("5.C 必刷方法·正交分解法"),
    normalizeEq("5. C 必刷方法·正交分解法"),
  );
});

test("点号族判等：中圆点/句号/全角点互为等价", () => {
  assert.equal(normalizeEq("必刷方法·正交分解法"), normalizeEq("必刷方法.正交分解法"));
  assert.equal(normalizeEq("5．C 必刷方法"), normalizeEq("5.C 必刷方法"));
  assert.equal(normalizeEq("必刷方法。正交分解法"), normalizeEq("必刷方法.正交分解法"));
});

test("全半角判等：字母/数字/括号", () => {
  assert.equal(normalizeEq("（2）21Ｊ"), normalizeEq("(2)21J"));
  assert.equal(normalizeEq("１２３"), normalizeEq("123"));
});

test("保守边界：大小写与形近字不折叠", () => {
  assert.notEqual(normalizeEq("800 J"), normalizeEq("800 j"));
  assert.notEqual(normalizeEq("O"), normalizeEq("0"));
});

test("真实不同文本仍判不等价", () => {
  assert.notEqual(
    normalizeEq("1.AD 必刷模型·传送带模型"),
    normalizeEq("1.AD 必刷模型·图解法"),
  );
});
