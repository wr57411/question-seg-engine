// latex-display.test.ts —— 展示层 LaTeX→Unicode 美化的回归锁定。
// 用例文本全部取自真实样张的噪声公式。
import assert from "node:assert/strict";
import { test } from "node:test";
import { prettifyLatex } from "../stages/latex-display.js";

test("西塔：$\\theta \\left( \\theta < 9 0 ^ { \\circ } \\right)$ → θ(θ<90°)", () => {
  assert.equal(
    prettifyLatex("$\\theta \\left( \\theta < 9 0 ^ { \\circ } \\right)$不变"),
    "θ(θ<90°)不变",
  );
});

test("度数与数字空格噪声：A.$6 0 ^ { \\circ }$B.45°C.$3 7 ^ { \\circ }$ → A.60°…", () => {
  assert.equal(
    prettifyLatex("A.$6 0 ^ { \\circ }$B.45°C.$3 7 ^ { \\circ }$D.$3 0 ^ { \\circ }$"),
    "A.60°B.45°C.37°D.30°",
  );
});

test("字体包装与 \\: 间距：\\boldsymbol { 1 0 } \\ : \\mathrm { m } / \\mathrm { s } ^ { 2 } → 10m/s²", () => {
  assert.equal(
    prettifyLatex("$\\boldsymbol { 1 0 } \\ : \\mathrm { m } / \\mathrm { s } ^ { 2 }$"),
    "10m/s²",
  );
});

test("\\frac → (A/B)，Δ 保留", () => {
  assert.equal(prettifyLatex("$\\frac { m g } { 2 }$"), "(mg/2)");
  assert.equal(
    prettifyLatex("$\\frac { \\Delta F } { \\Delta L }$不变"),
    "(ΔF/ΔL)不变",
  );
});

test("下标：$B _ { 1 }$ → B₁", () => {
  assert.equal(prettifyLatex("将 b 端从$B _ { 1 }$移到$B _ { 2 }$;绳子"), "将 b 端从B₁移到B₂;绳子");
});

test("段外文本原样、不成对 $ 不动", () => {
  assert.equal(prettifyLatex("没有公式的普通文本"), "没有公式的普通文本");
  assert.equal(prettifyLatex("奇数个 $ 定界符保持原样"), "奇数个 $ 定界符保持原样");
  assert.equal(prettifyLatex("杆OA竖直"), "杆OA竖直");
});
