// latex-display.test.ts —— 展示层 LaTeX→HTML 渲染的回归锁定。
// 用例文本全部取自真实样张的噪声公式。
// ⚠️ prettifyLatex 返回 **HTML 片段**（\frac 竖排分式 / \sqrt 带上划线根号需要二维结构），
// 所以期望值是 HTML —— 一维字符流表达不了原卷的数学排版。
import assert from "node:assert/strict";
import { test } from "node:test";
import { prettifyLatex, findCommandAmbiguities } from "../stages/latex-display.js";

/** 竖排分式的期望片段 */
const frac = (num: string, den: string) =>
  `<span class="frac"><span class="fn">${num}</span><span class="fd">${den}</span></span>`;
/** 带上划线根号的期望片段 */
const sqrt = (rad: string) => `<span class="sqrt">√<span class="rad">${rad}</span></span>`;

test("西塔：$\\theta \\left( \\theta < 9 0 ^ { \\circ } \\right)$ → θ(θ<90°)（< 须转义）", () => {
  assert.equal(
    prettifyLatex("$\\theta \\left( \\theta < 9 0 ^ { \\circ } \\right)$不变"),
    "θ(θ&lt;90°)不变",
  );
});

test("度数与数字空格噪声：A.$6 0 ^ { \\circ }$B.45°C.$3 7 ^ { \\circ }$ → A.60°…", () => {
  assert.equal(
    prettifyLatex("A.$6 0 ^ { \\circ }$B.45°C.$3 7 ^ { \\circ }$D.$3 0 ^ { \\circ }$"),
    "A.60°\u2003B.45°\u2003C.37°\u2003D.30°", // 选项标记分隔：≥2 个标记时补 EM SPACE
  );
});

test("字体包装与 \\: 间距：上标渲染为 <sup>", () => {
  assert.equal(
    prettifyLatex("$\\boldsymbol { 1 0 } \\ : \\mathrm { m } / \\mathrm { s } ^ { 2 }$"),
    "10m/s<sup>2</sup>",
  );
});

test("\\frac → 竖排分式（原卷是二维排版），Δ 保留", () => {
  assert.equal(prettifyLatex("$\\frac { m g } { 2 }$"), frac("mg", "2"));
  assert.equal(prettifyLatex("$\\frac { \\Delta F } { \\Delta L }$不变"), `${frac("ΔF", "ΔL")}不变`);
});

test("下标渲染为 <sub>：$B _ { 1 }$ → B<sub>1</sub>", () => {
  assert.equal(
    prettifyLatex("将 b 端从$B _ { 1 }$移到$B _ { 2 }$;绳子"),
    "将 b 端从B<sub>1</sub>移到B<sub>2</sub>;绳子",
  );
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
    `A.sinθ=${frac("kR", "mg")}\u2003B.sinθ=${frac("2kR", "mg")}`,
  );
});

test("无括号 \\frac12、嵌套 \\frac{\\sqrt{2}}{2}、\\overline", () => {
  assert.equal(prettifyLatex("$\\frac12$"), frac("1", "2"));
  assert.equal(prettifyLatex("$\\frac { \\sqrt { 2 } } { 2 }$"), frac(sqrt("2"), "2"));
  assert.equal(prettifyLatex("$\\overline { X }$"), "X");
});

// —— 以下用例来自 2026-10-08 全量渲染审计发现的真实缺陷（用户对比模式截图报出）——

test("上标 2 被 OCR 认成冒号 → 还原为 2（原卷第 4 页第 1 题 Fsin²θ 实证）", () => {
  assert.equal(
    prettifyLatex("A.$F \\mathrm { s i n } ^ { \\mathrm { : } } \\theta$B. Fsin θcos θ"),
    "A.Fsin<sup>2</sup>θ\u2003B. Fsin θcos θ", // 段外空格原样保留——原卷本身就有空格
  );
});

test("上标撇号直出：$F _ { 1 } ^ { \\prime } > F _ { 1 }$", () => {
  assert.equal(
    prettifyLatex("$F _ { 1 } ^ { \\prime } > F _ { 1 }$"),
    "F<sub>1</sub><sup>′</sup>&gt;F<sub>1</sub>",
  );
});

test("命令表补全：\\varepsilon → ε、\\vdots → ⋮、\\colon → :", () => {
  assert.equal(prettifyLatex("$\\varepsilon$"), "ε");
  assert.equal(prettifyLatex("$\\Delta x \\vdots$"), "Δx⋮");
  assert.equal(prettifyLatex("$m _ { a } \\colon m _ { b }$"), "m<sub>a</sub>:m<sub>b</sub>");
});

test("裸公式块判据放宽：无 $ 的 F _ { 1 } = F _ { 2 } 也要渲染（阶段 1 源码残留修复）", () => {
  assert.equal(
    prettifyLatex("A.F _ { 1 } = F _ { 2 } = F _ { 3 }"),
    "A.F<sub>1</sub>=F<sub>2</sub>=F<sub>3</sub>",
  );
});

test("未知命令不裸奔：丢弃命令名但保留参数内容", () => {
  assert.equal(prettifyLatex("$\\foo { x } + y$"), "x+y");
});

test("非内容参数的命令连参数丢弃：\\color { red } x → x", () => {
  assert.equal(prettifyLatex("$\\color { red } x$"), "x");
});

test("选项粘连分隔：A.0.20B.0.30C.0.35D.0.45 → 补 EM SPACE（原卷为分列排版）", () => {
  assert.equal(
    prettifyLatex("A.0.20B.0.30C.0.35D.0.45"),
    "A.0.20\u2003B.0.30\u2003C.0.35\u2003D.0.45",
  );
  // 单个标记（正文引用）不动
  assert.equal(prettifyLatex("如图A.所示"), "如图A.所示");
});

test("LaTeX 不换行空格 ~ 还原为空格：10~kg → 10 kg", () => {
  assert.equal(prettifyLatex("$m _ { A } = 10 ~ \\mathrm { k g }$"), "m<sub>A</sub>=10 kg");
});

test("放宽判据不误伤中文普通文本", () => {
  assert.equal(prettifyLatex("两球对容器的压力大小"), "两球对容器的压力大小");
  assert.equal(prettifyLatex("如图甲所示，物块沿斜面下滑"), "如图甲所示，物块沿斜面下滑");
});

test("HTML 转义：字面 < > & 不会破坏结构", () => {
  assert.equal(prettifyLatex("若 a<b 且 c>d"), "若 a&lt;b 且 c&gt;d");
  assert.equal(prettifyLatex("$x < y$"), "x&lt;y");
});

// —— 命令切分歧义检测（提示级：机器无法从字面判断，只能报出来）——

test("歧义检测：\\top 会报出——整串是 ⊤，也可能是 \\to + \"p\"", () => {
  const hits = findCommandAmbiguities("$x \\top y$");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.command, "top");
  assert.equal(hits[0]!.alternative, 'to + "p"');
});

test("歧义检测：\\int 会报出（也可能是 \\in + \"t\"）", () => {
  const hits = findCommandAmbiguities("$\\int_0^1 f$");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.command, "int");
});

test("歧义检测：纯排版指令 \\left 豁免——不产生可见内容，切错也看不出", () => {
  assert.equal(findCommandAmbiguities("$R \\left( R \\right)$").length, 0);
});

test("歧义检测：普通命令与真实样张文本不误报", () => {
  assert.equal(findCommandAmbiguities("$\\theta + \\alpha = \\sin \\theta$").length, 0);
  assert.equal(
    findCommandAmbiguities("A.$\\sin \\ \\theta = { \\frac { k R } { m g } }$B.$\\cos \\theta$").length,
    0,
  );
});
