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
    "A.60° B.45° C.37° D.30°", // 选项标记分隔：≥2 个标记时补空格
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

test("段外文本原样、不成对 $ 视为噪声去掉", () => {
  assert.equal(prettifyLatex("没有公式的普通文本"), "没有公式的普通文本");
  assert.equal(prettifyLatex("奇数个 $ 定界符视为噪声去掉"), "奇数个 定界符视为噪声去掉");
  assert.equal(prettifyLatex("杆OA竖直"), "杆OA竖直");
});

test("真实样张第 5 题选项行（\\ 空格命令 + 分组花括号 + 嵌套 \\frac）", () => {
  assert.equal(
    prettifyLatex(
      "A.$\\sin \\ \\theta = { \\frac { k R } { m g } }$B.$\\sin \\ \\theta = \\frac { 2 k R } { m g }$",
    ),
    "A.sinθ=(kR/mg) B.sinθ=(2kR/mg)",
  );
});

test("无括号 \\frac12、嵌套 \\frac{\\sqrt{2}}{2}、\\overline", () => {
  assert.equal(prettifyLatex("$\\frac12$"), "(1/2)");
  assert.equal(prettifyLatex("$\\frac { \\sqrt { 2 } } { 2 }$"), "(√(2)/2)");
  assert.equal(prettifyLatex("$\\overline { X }$"), "X");
});

// —— 以下用例来自 2026-10-08 全量渲染审计发现的真实缺陷（用户对比模式截图报出）——

test("上标 OCR 噪声丢弃：$F \\mathrm{s i n} ^ { \\mathrm{:} } \\theta$ → Fsinθ（原卷无上标）", () => {
  assert.equal(
    prettifyLatex("A.$F \\mathrm { s i n } ^ { \\mathrm { : } } \\theta$B. Fsin θcos θ"),
    "A.Fsinθ B. Fsin θcos θ",
  );
});

test("上标撇号直出：$F _ { 1 } ^ { \\prime } > F _ { 1 }$ → F₁′>F₁", () => {
  assert.equal(prettifyLatex("$F _ { 1 } ^ { \\prime } > F _ { 1 }$"), "F₁′>F₁");
});

test("命令表补全：\\varepsilon → ε、\\vdots → ⋮、\\colon → :", () => {
  assert.equal(prettifyLatex("$\\varepsilon$"), "ε");
  assert.equal(prettifyLatex("$\\Delta x \\vdots$"), "Δx⋮");
  // SUB 表只有部分字母有 Unicode 下标字形（ₐ/ₑ/ₒ/ₓ），b 等没有 → 退回 _b
  assert.equal(prettifyLatex("$m _ { a } \\colon m _ { b }$"), "mₐ:m_b");
});

test("裸公式块判据放宽：无 $ 的 F _ { 1 } = F _ { 2 } 也要渲染（阶段 1 源码残留修复）", () => {
  assert.equal(prettifyLatex("A.F _ { 1 } = F _ { 2 } = F _ { 3 }"), "A.F₁=F₂=F₃");
});

test("未知命令不裸奔：丢弃命令名但保留参数内容", () => {
  assert.equal(prettifyLatex("$\\foo { x } + y$"), "x+y");
});

test("非内容参数的命令连参数丢弃：\\color { red } x → x", () => {
  assert.equal(prettifyLatex("$\\color { red } x$"), "x");
});

test("选项粘连分隔：A.0.20B.0.30C.0.35D.0.45 → 补空格", () => {
  assert.equal(
    prettifyLatex("A.0.20B.0.30C.0.35D.0.45"),
    "A.0.20 B.0.30 C.0.35 D.0.45",
  );
  // 单个标记（正文引用）不动
  assert.equal(prettifyLatex("如图A.所示"), "如图A.所示");
});

test("LaTeX 不换行空格 ~ 还原为空格：10~kg → 10 kg", () => {
  assert.equal(prettifyLatex("$m _ { A } = 10 ~ \\mathrm { k g }$"), "m_A=10 kg");
});

test("放宽判据不误伤中文普通文本", () => {
  assert.equal(prettifyLatex("两球对容器的压力大小"), "两球对容器的压力大小");
  assert.equal(prettifyLatex("如图甲所示，物块沿斜面下滑"), "如图甲所示，物块沿斜面下滑");
});
