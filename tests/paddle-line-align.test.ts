// paddle-line-align.test.ts —— 锁住行对齐的两个真实修复（2026-11-03）。
// 背景：第一版用「严格单调游标 + 不剥标点」，实测只有 48.9% 能锚上；
// 修掉之后 86.3%（text 块 94.1%）。这两条退化回去会让小样数字立刻掉一半。
import assert from "node:assert/strict";
import { test } from "node:test";
import { alignBlock, matchChars } from "../scripts/paddle-line-align.js";

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
