// paddle-line-align.test.ts —— 锁住行对齐的两个真实修复（2026-11-03）。
// 背景：第一版用「严格单调游标 + 不剥标点」，实测只有 48.9% 能锚上；
// 修掉之后 86.3%（text 块 94.1%）。这两条退化回去会让小样数字立刻掉一半。
import assert from "node:assert/strict";
import { test } from "node:test";
import { alignBlock, matchChars, stripMarkup } from "../scripts/paddle-line-align.js";

test("matchChars：剥标点后，全角逗号与半角逗号不再造成 MISS", () => {
  assert.deepEqual(matchChars("如图所示，电源"), matchChars("如图所示,电源"));
  assert.ok(matchChars("A.只有正离子").length > 0);
});

test("alignBlock：逐行锚点（顺序一致时全中）", () => {
  const { result } = alignBlock("第一行文字第二行文字第三行文字", [
    { text: "第一行文字" },
    { text: "第二行文字" },
    { text: "第三行文字" },
  ]);
  assert.equal(result.lines, 3);
  assert.equal(result.anchor, 3);
  assert.equal(result.needsHuman, 0);
});

test("alignBlock：行序与文本序不一致时仍能锚上（乱序兜底）", () => {
  // 实测场景：V3 的第 1 行在文本里出现在第 2 行之后（跨栏/跨页续段）
  const { result } = alignBlock("甲段文字乙段文字丙段文字", [
    { text: "乙段文字" },
    { text: "甲段文字" },
    { text: "丙段文字" },
  ]);
  assert.equal(result.anchor, 3);
  assert.equal(result.outOfOrder, 1);
});

test("alignBlock：区间里两行都没锚上 ⇒ 交人工，不硬凑", () => {
  const { result } = alignBlock("开头文字这是完全对不上的两行公式内容结尾文字", [
    { text: "开头文字" },
    { text: "P_出=I²R" },
    { text: "R_总=R_1+R_2" },
    { text: "结尾文字" },
  ]);
  assert.equal(result.needsHuman, 1);
  assert.equal(result.eliminated, 0);
});

test("alignBlock：V3 漏行 ⇒ 剩字报警（不把邻行文字塞进去）", () => {
  const { result } = alignBlock("第一行文字第二行文字第三行文字", [
    { text: "第一行文字" },
    // 第二行 V3 漏了
    { text: "第三行文字" },
  ]);
  assert.equal(result.anchor, 2);
  assert.ok(result.chars > result.consumed, "必须留下未消费的字");
});

test("stripMarkup：表格块的 HTML 标签不算「要消费的字」", () => {
  const html = '<table><tr><td rowspan="2">欧姆定律</td><td>1/R</td></tr></table>';
  assert.equal(stripMarkup(html).replace(/\s+/g, ""), "欧姆定律1/R");
  assert.ok(matchChars(html).join("").includes("欧姆定律"));
  assert.ok(!matchChars(html).join("").includes("table"), "标签名不得进入匹配字符");
  assert.ok(!matchChars(html).join("").includes("rowspan"), "属性名不得进入匹配字符");
});

test("stripMarkup：HTML 标签与图片占位符不进分母（表格块的真实教训）", () => {
  assert.deepEqual(matchChars('<table><tr><td rowspan="2">甲</td></tr></table>'), matchChars("甲"));
  assert.deepEqual(matchChars("![](images/x.jpg) 乙"), matchChars("乙"));
});

test("容量守卫：缺口字数超过邻行平均 1.5× ⇒ 不填（标待核）", () => {
  // 两条锚定行各 8 字（均 8），中间一行对不上、且缺口有 16 字 ⇒ 16 > 8×1.5
  const hay = "甲".repeat(8) + "程".repeat(16) + "乙".repeat(8);
  const { result } = alignBlock(hay, [
    { text: "甲".repeat(8) },
    { text: "对不上的公式行" },
    { text: "乙".repeat(8) },
  ]);
  assert.equal(result.anchor, 2);
  assert.equal(result.eliminated, 0);
  assert.equal(result.guardBlocked, 1);
});

test("容量守卫：缺口字数在邻行 1.5× 以内 ⇒ 照常排除法定行", () => {
  const hay = "甲".repeat(8) + "程".repeat(8) + "乙".repeat(8);
  const { result } = alignBlock(hay, [
    { text: "甲".repeat(8) },
    { text: "对不上" },
    { text: "乙".repeat(8) },
  ]);
  assert.equal(result.anchor, 2);
  assert.equal(result.eliminated, 1);
  assert.equal(result.guardBlocked, 0);
});

test("容量守卫：一块里一个锚都没有 ⇒ 无从校准，不填", () => {
  const { result } = alignBlock("完全对不上的整段文字内容甲", [{ text: "另一段完全不同的字" }]);
  assert.equal(result.eliminated, 0);
  assert.equal(result.guardBlocked, 1);
});
