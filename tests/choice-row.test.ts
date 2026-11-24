// choice-row.js 判据测试（B-73/vk62：一行多选项被上游竖切）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHorizontalChoiceRow, findHorizontalChoiceRows } from "../stages/choice-row.js";

/** 造一个文本块 */
const b = (i: number, x0: number, y0: number, x1: number, y1: number, text: string) => ({
  i,
  kind: "text",
  bbox: [x0, y0, x1, y1] as number[],
  text,
});

test("真横排误切（书A p8 vk62 实证形态）：四选项宽而矮、紧排", () => {
  const g = [
    b(8, 49.7, 202.3, 268.6, 207.7, "A. $\\frac{s}{2v}$"),
    b(9, 49.7, 210.1, 268.6, 215.5, "B. $\\frac{s}{3v}$"),
    b(10, 49.7, 218.0, 268.6, 223.4, "C. $\\frac{s}{4v}$"),
    b(11, 49.7, 225.8, 268.6, 231.2, "D. $\\frac{s}{5v}$"),
  ];
  assert.equal(isHorizontalChoiceRow(g, 596), true);
});

test("正常竖排选项（高 ≥10pt、间距大）不判横排——宁漏不误", () => {
  const g = [
    b(9, 46, 242, 285, 253, "A. 汽车制动时的加速度大小为 $2.5\\,m/s^{2}$"),
    b(10, 46, 261, 285, 271, "B. 制动后, 4 s 内汽车的位移大小为 $22.5\\,m$"),
    b(11, 46, 280, 285, 290, "C. 汽车制动 2 s 时的速度大小为 $10\\,m/s$"),
    b(12, 46, 299, 285, 309, "D. 制动后, 3 s 内汽车的平均速度大小为 $5\\,m/s$"),
  ];
  assert.equal(isHorizontalChoiceRow(g, 596), false);
});

test("只有 2 个选项不成组", () => {
  const g = [b(0, 10, 10, 200, 15, "A. x"), b(1, 10, 20, 200, 25, "B. y")];
  assert.equal(isHorizontalChoiceRow(g, 596), false);
});

test("同栏约束：左缘差超过页宽 5% 不判", () => {
  const g = [
    b(0, 49, 202, 268, 207, "A. a"),
    b(1, 200, 210, 419, 215, "B. b"),
    b(2, 49, 218, 268, 223, "C. c"),
  ];
  assert.equal(isHorizontalChoiceRow(g, 596), false);
});

test("非 A./B./C./D. 开头的连续短行不判", () => {
  const g = [
    b(0, 49, 202, 268, 207, "甲 xxx"),
    b(1, 49, 210, 268, 215, "乙 yyy"),
    b(2, 49, 218, 268, 223, "丙 zzz"),
  ];
  assert.equal(isHorizontalChoiceRow(g, 596), false);
});

test("findHorizontalChoiceRows：只捞真横排，跳过正常竖排", () => {
  const blocks = [
    b(8, 49.7, 202.3, 268.6, 207.7, "A. $\\frac{s}{2v}$"),
    b(9, 49.7, 210.1, 268.6, 215.5, "B. $\\frac{s}{3v}$"),
    b(10, 49.7, 218.0, 268.6, 223.4, "C. $\\frac{s}{4v}$"),
    b(11, 49.7, 225.8, 268.6, 231.2, "D. $\\frac{s}{5v}$"),
    b(12, 42.0, 237.0, 293.2, 250.0, "8. [安徽五校 2025 联考] 如图是某"),
    b(20, 46, 242, 285, 253, "A. 汽车制动时的加速度大小为 $2.5\\,m/s^{2}$"),
    b(21, 46, 261, 285, 271, "B. 制动后, 4 s 内汽车的位移大小为 $22.5\\,m$"),
    b(22, 46, 280, 285, 290, "C. 汽车制动 2 s 时的速度大小为 $10\\,m/s$"),
  ];
  const rows = findHorizontalChoiceRows(blocks, 596);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    (rows[0] ?? []).map((x) => x.i),
    [8, 9, 10, 11],
  );
});
