// latex-display.test.ts —— 展示层 LaTeX→HTML 渲染的回归锁定。
// 用例文本全部取自真实样张的噪声公式。
// ⚠️ prettifyLatex 返回 **HTML 片段**（\frac 竖排分式 / \sqrt 带上划线根号需要二维结构），
// 所以期望值是 HTML —— 一维字符流表达不了原卷的数学排版。
import assert from "node:assert/strict";
import { test } from "node:test";
import { prettifyLatex, findCommandAmbiguities, collapseImmediateRepeat, spaceEmptyParens } from "../stages/latex-display.js";

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

// —— 即时精确重复前缀折叠（Task 12；改写类变换，判据最保守 + 每处回原卷核对）——
// 文本全部取自 stages.json 的真实命中块；每处已从 origin.pdf 裁局部核对「原卷只有一份」。

test("真实实例：p8 第 8 题 D 选项前缀重复两遍 → 折叠（原卷仅一份，已核对）", () => {
  assert.equal(
    collapseImmediateRepeat("D. 绳a的拉力D. 绳a的拉力$F _ { a }$增大.杆的压"),
    "D. 绳a的拉力$F _ { a }$增大.杆的压",
  );
});

test("真实实例：p8「静止，则在此过程中」重复 → 折叠（原卷仅一份，已核对）", () => {
  assert.equal(
    collapseImmediateRepeat("静止，则在此过程中静止，则在此过程中()"),
    "静止，则在此过程中()",
  );
});

test("真实实例：p14 第 C 选项「C.M所受斜面的摩擦力大」重复 → 折叠（原卷仅一份，已核对）", () => {
  assert.equal(
    collapseImmediateRepeat("C.M所受斜面的摩擦力大C.M所受斜面的摩擦力大小一定一直增加"),
    "C.M所受斜面的摩擦力大小一定一直增加",
  );
});

test("接入渲染管线：折叠后再渲染 LaTeX，选项分隔不受影响", () => {
  assert.equal(
    prettifyLatex("D. 绳a的拉力D. 绳a的拉力$F _ { a }$增大.杆的压"),
    "D. 绳a的拉力F<sub>a</sub>增大.杆的压",
  );
});

test("反例：正常中文叠词（<6 字符重复）不得折叠", () => {
  assert.equal(collapseImmediateRepeat("讨论讨论"), "讨论讨论");
  assert.equal(collapseImmediateRepeat("研究研究"), "研究研究");
  assert.equal(collapseImmediateRepeat("收拾收拾"), "收拾收拾");
  // 「增加增加」是 2 字重复，与「讨论讨论」同形——按最保守判据（单元 <6）不折叠。
  // （全卷中它是独立的跨块伪影，跨块匹配明确不做。）
  assert.equal(collapseImmediateRepeat("增加增加"), "增加增加");
});

test("反例：非即时重复（X…Y…X）不得折叠", () => {
  assert.equal(
    collapseImmediateRepeat("静止，则在此过程中物体运动，静止，则在此过程中"),
    "静止，则在此过程中物体运动，静止，则在此过程中",
  );
  assert.equal(collapseImmediateRepeat("ABCABCXYZABC"), "ABCABCXYZABC");
});

test("边界：重复单元正好 5 字符不折叠、正好 6 字符折叠", () => {
  assert.equal(collapseImmediateRepeat("一二三四五一二三四五"), "一二三四五一二三四五"); // 5 → 不动
  assert.equal(collapseImmediateRepeat("一二三四五六一二三四五六"), "一二三四五六"); // 6 → 折叠
});

test("不递归折叠：折叠一次即返回，结果不再折", () => {
  // 4 份单元 → 只折掉 1 份得到 3 份；若递归会继续折到 1 份。
  assert.equal(collapseImmediateRepeat("一二三四五六一二三四五六一二三四五六一二三四五六"), "一二三四五六一二三四五六一二三四五六");
});

// —— 空括号补间距（Task 13；改写类变换，判据最保守 + G4 回原卷量间隙）——
// 原卷实测（600dpi 裁 origin.pdf，墨迹口径）：两括号墨迹间隙 27.0–27.2pt；
// 同页正文 CJK 字距 11.52pt ⇒ 27.0 / 11.52 ≈ 2.34em ⇒ 补 2 个 EM SPACE（原卷 `（　　）`）。

test("spaceEmptyParens：半角空括号补 2 个 EM SPACE（原卷间隙实测 ≈27pt ≈2.34em）", () => {
  assert.equal(spaceEmptyParens("下列说法中正确的是()"), "下列说法中正确的是(\u2003\u2003)");
  assert.equal(spaceEmptyParens("弹力的是()"), "弹力的是(\u2003\u2003)");
  assert.equal(spaceEmptyParens("()"), "(\u2003\u2003)");
});

test("spaceEmptyParens：全角 / 混合空括号同样补间距", () => {
  assert.equal(spaceEmptyParens("正确的是（）"), "正确的是（\u2003\u2003）");
  assert.equal(spaceEmptyParens("正确的是（)"), "正确的是（\u2003\u2003)");
  assert.equal(spaceEmptyParens("正确的是(）"), "正确的是(\u2003\u2003）");
});

test("spaceEmptyParens：内部已有空白（半角/全角空格/制表）→ 归一到 2 个 EM SPACE", () => {
  assert.equal(spaceEmptyParens("正确的是( )"), "正确的是(\u2003\u2003)");
  assert.equal(spaceEmptyParens("正确的是（　）"), "正确的是（\u2003\u2003）");
  assert.equal(spaceEmptyParens("正确的是(\t)"), "正确的是(\u2003\u2003)");
});

test("spaceEmptyParens：内部有内容的括号不动（(多选) 等，判据保守）", () => {
  assert.equal(spaceEmptyParens("(多选)现代的"), "(多选)现代的");
  assert.equal(spaceEmptyParens("7.「黑龙江佳木斯一中2022月考](多选)现代"), "7.「黑龙江佳木斯一中2022月考](多选)现代");
  assert.equal(spaceEmptyParens("如图(R)所示"), "如图(R)所示");
  assert.equal(spaceEmptyParens("A.(甲)B.(乙)"), "A.(甲)B.(乙)");
});

test("spaceEmptyParens：幂等 —— 已补过的括号不会越补越宽", () => {
  const once = spaceEmptyParens("下列说法中正确的是()");
  assert.equal(spaceEmptyParens(once), once);
  assert.equal(spaceEmptyParens("正确的是(\u2003\u2003)"), "正确的是(\u2003\u2003)");
});

test("接入渲染管线：prettifyLatex 对空括号补间距、(多选) 不被动", () => {
  assert.equal(prettifyLatex("下列说法中正确的是()"), "下列说法中正确的是(\u2003\u2003)");
  assert.equal(prettifyLatex("7.「黑龙江」(多选)现代的"), "7.「黑龙江」(多选)现代的");
  // 空括号与选项分隔互不干扰（选项分隔照旧在 A./B. 前补 EM SPACE）
  assert.equal(prettifyLatex("正确的是()A.甲B.乙"), "正确的是(\u2003\u2003)\u2003A.甲\u2003B.乙");
});
