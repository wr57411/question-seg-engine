// tests/figure-misread.test.ts —— B-64 图形误读判据（数轴读成 LaTeX array）
import assert from "node:assert/strict";
import { test } from "node:test";
import { isMisreadFigureText } from "../stages/figure-misread.js";

test("数轴误读形态（q298 实测）压制", () => {
  assert.equal(isMisreadFigureText("\\begin{array}{ccccc}A&&B&&C&D\\\\\\hline\\end{array", 5), true);
});

test("真数学 array 不压制", () => {
  assert.equal(isMisreadFigureText("\\begin{array}{cc}\\frac{s}{2v}&x\\end{array}", 6), false);
  assert.equal(isMisreadFigureText("\\begin{array}{cc}\\sqrt{2}&\\sqrt{3}\\end{array}", 6), false);
});

test("高行框/非 array/无字母列不压制（宁漏不误）", () => {
  assert.equal(isMisreadFigureText("\\begin{array}{cc}A&B\\end{array}", 40), false);
  assert.equal(isMisreadFigureText("普通文本", 5), false);
  assert.equal(isMisreadFigureText("\\begin{array}{cc}&B\\end{array}", 5), false);
});
