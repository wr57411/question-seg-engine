// tests/judge-rulers.test.ts —— M4b 复合裁判口径纯函数（DECISIONS §112）。
// 证据：tmp/m4b/montage/*.png 逐条原卷裁图证实（qx A24/B34、wy A6+Ⅱ1/B20）。
// 红线：文本行 rec 字形错（汉字误读）仍判失败；族归一只覆盖实证标点族与罗马连字。
import test from "node:test";
import assert from "node:assert/strict";
import { isFormulaTextBase, isFormulaTextM4b, famNorm, isSubseq, confirmTextM4b } from "../scripts/judge-rulers.js";
import { isFormulaText } from "../scripts/audit-formula-ink.js";

test("isFormulaTextBase 与 audit-formula-ink 同口径（B-41 基线路由不动）", () => {
  for (const s of ["\\frac{1}{2}", "v_0", "x^2", "{a}", "H=3.2\\ m", "v$", "F2", "普通文本", "II"]) {
    assert.equal(isFormulaTextBase(s), isFormulaText(s), s);
  }
  assert.equal(isFormulaTextBase("H=3.2\\ m"), false); // 基线漏判：LaTeX 间距反斜杠
  assert.equal(isFormulaTextBase("v$"), false);
  assert.equal(isFormulaTextBase("F2"), false);
});

test("A1 任意反斜杠（LaTeX 间距 \\ ）路由公式：蒙太奇 qx-A00/wy-A00 证实公式排版", () => {
  for (const s of ["H=3.2\\ m", "h=2.45\\ m", "10\\ m/s", "10.0\\ m/s", "L=10\\ m", "20\\ m/s",
    "7.9\\ km/s<v<11.2\\ km/s", "v<7.9\\ km/s", "11.\\ 2\\ km/s<v<16.\\ 7\\ km/s"]) {
    assert.equal(isFormulaTextM4b(s), true, s);
  }
});

test("A2 含 $  delimiter 碎片路由公式：印刷为 v₀/x/m₂ 数学斜体", () => {
  for (const s of ["v$", "$x", "$1m₂2"]) assert.equal(isFormulaTextM4b(s), true, s);
});

test("A3 上下标/点标碎片形态路由公式：印刷为 F₂/v_A/ω/v₂/y₁/O₁ 等数学斜体或图内点标", () => {
  for (const s of ["F2", "vA", "Ad", "AQ", "0α", "v0", "4Q", "OC", "h1", "1ω", "FA", "U2", "v1", "y1", "IH", "O1", "ω2"]) {
    assert.equal(isFormulaTextM4b(s), true, s);
  }
});

test("A3 不误伤：罗马数字连字/单字符/长文本/纯数字串 不走公式路由", () => {
  for (const s of ["II", "IV", "XI", "A", "B", "7", "7777777777", "MN支撑", "下课练天星", "n-1", "T/7"]) {
    assert.equal(isFormulaTextM4b(s), false, s);
  }
});

test("famNorm 仅实证字形族：全半角括号/逗号/冒号、减号、中点、罗马Ⅱ连字；其余不动", () => {
  assert.equal(famNorm("（b)所示，则："), "(b)所示,则:");
  assert.equal(famNorm("m•s−1"), "m·s-1");
  assert.equal(famNorm("Ⅱ"), "II");
  assert.equal(famNorm("。、；x y"), "。、；xy"); // 句号/顿号/分号未实证 ⇒ 不归一；空白去除
  assert.equal(famNorm("μ相同"), "μ相同"); // 汉字/希腊字母不动
});

test("famNorm 角落括号「」归一（M7-C ④：原卷实证「鲁，rec 漏读括号 ⇒ 裁判伪失败）", () => {
  // 证据：data/out/教材基础练 磁场/pages/page-001.png p000_g28 窗（tmp/m7-table/shots/d14-p001-g28-orig.png）
  // 原卷印「2024年1月浙江卷「鲁」，V3 读到有「、笔记本 rec 漏读 ⇒ 不归一则 V3⊄rec 误判。
  assert.equal(famNorm("2024年1月浙江卷「鲁"), "2024年1月浙江卷鲁");
  assert.equal(confirmTextM4b("2024年1月浙江卷「鲁", "2024年1月浙江卷鲁"), true);
});

test("isSubseq 字符级保序子序列", () => {
  assert.equal(isSubseq("abc", "aXbYc"), true);
  assert.equal(isSubseq("abc", "acb"), false);
  assert.equal(isSubseq("", "x"), true);
});

test("confirmTextM4b：标点族变体确认（蒙太奇 B 组 55 条逐条证实）", () => {
  assert.equal(confirmTextM4b("动，速率将保持不变", "动,速率将保持不变"), true);
  assert.equal(confirmTextM4b("）", ")"), true);
  assert.equal(confirmTextM4b("（1）开普勒行星运动定律不仅适用于", "(1)开普勒行星运动定律不仅适用于"), true);
  assert.equal(confirmTextM4b("n-1", "n − 1"), true);
  assert.equal(confirmTextM4b("↑v/(m•s−1", "↑v/(m·s-1)"), true);
  assert.equal(confirmTextM4b("II", "Ⅱ"), true); // 罗马连字字形族（wy p008_g17 裁图证实）
  assert.equal(confirmTextM4b("，则", "0,则"), true); // rec 更完整：子序列方向容忍（裁图证实印刷含 0）
  assert.equal(confirmTextM4b("面向右滑动到图示位置（杆与地面夹角为）时", "面向右滑动到图示位置（杆与地面夹角为α)时，"), true);
});

test("confirmTextM4b：rec 汉字字形错仍判失败（真实失败不许抹掉）", () => {
  assert.equal(confirmTextM4b("下课练天星", "下课认听"), false);
  assert.equal(confirmTextM4b("合运动为物体的实际运动", "合运动为物体的实际运功"), false);
  assert.equal(confirmTextM4b("", "x"), false); // 空 V3 文本不确认
});