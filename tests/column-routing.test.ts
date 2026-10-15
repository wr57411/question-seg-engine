// tests/column-routing.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectColumnCenters, estimateGutter, layoutPage, restoreReadingOrder } from "../src/layout.js";
import type { IndexedBlock } from "../src/types.js";

function blocks(xs: number[]): IndexedBlock[] {
  return xs.map((x, i) => ({
    index: i,
    pageIndex: 0,
    block: {
      kind: "text",
      bbox: [x, 100 + i * 10, x + 30, 110 + i * 10],
      text: `b${i}`,
      firstLine: `b${i}`,
      lineCount: 1,
      maxFontSize: 0,
    },
  }));
}

test("detectColumnCenters：双栏两簇返回升序中心", () => {
  const left = Array.from({ length: 10 }, (_, i) => 40 + i * 2); // 40~58，中心≈49
  const right = Array.from({ length: 10 }, (_, i) => 300 + i * 2); // 300~318，中心≈309
  const centers = detectColumnCenters(blocks([...left, ...right]), 596);
  assert.equal(centers.length, 2);
  assert.ok(Math.abs(centers[0]! - 49) < 10);
  assert.ok(Math.abs(centers[1]! - 309) < 10);
});

test("restoreReadingOrder：栏界带行（x0 略小于中线 298）归最近簇中心（右栏）", () => {
  // 数据编排：左栏 b0..b5（y=100~150）；右栏 b6..b11（y=160~210）；
  // 栏界带行 b12..b14（y=220~240，x0=293/296/297 均 < mid=298，但距右簇中心 ~305 更近）
  const left = Array.from({ length: 6 }, (_, i) => 40 + i * 2);
  const right = Array.from({ length: 6 }, (_, i) => 300 + i * 2);
  const boundary = [293, 296, 297];
  const entries = blocks([...left, ...right, ...boundary]);
  const centers = detectColumnCenters(entries, 596);
  const ordered = restoreReadingOrder(entries, 2, 596, centers);
  const texts = ordered.map((e) => (e.block.kind === "text" || e.block.kind === "table" ? e.block.text : ""));

  // 核心验证 1：boundary 行必须位于所有左栏块之后（归右栏，不得被 mid=298 误路由到左栏）
  const leftTexts = new Set(["b0", "b1", "b2", "b3", "b4", "b5"]);
  const lastLeft = Math.max(...texts.map((t, i) => (leftTexts.has(t) ? i : -1)));
  for (const t of ["b12", "b13", "b14"]) {
    assert.ok(texts.indexOf(t) > lastLeft, `${t}（x0<mid=298，距右簇更近）应归右栏`);
  }
  // 核心验证 2：整体阅读顺序 = 左栏按 y 序在前，右栏（含 boundary 行）按 y 序在后
  assert.deepEqual(texts, [
    "b0", "b1", "b2", "b3", "b4", "b5",
    "b6", "b7", "b8", "b9", "b10", "b11", "b12", "b13", "b14",
  ]);
});

test("status quo：单栏/无簇时行为不变", () => {
  const xs = Array.from({ length: 20 }, (_, i) => 50 + i * 2);
  const ordered = layoutPage({ index: 0, width: 596, height: 800, blocks: blocks(xs).map((b) => b.block) });
  assert.equal(ordered.columns, 1);
  assert.equal(ordered.ordered.length, 20);
});
// ---------- 跨栏横幅（居中卷头/居中节标题）：2026-10-14 真实回归 ----------

/** 造一个带显式 bbox 的块 */
function box(x0: number, y: number, x1: number, text: string, i: number): IndexedBlock {
  return {
    index: i,
    pageIndex: 0,
    block: { kind: "text", bbox: [x0, y, x1, y + 10], text, firstLine: text, lineCount: 1, maxFontSize: 0 },
  };
}

/** 造一页「真实几何」的双栏内容：左栏 x0∈[60,76]/x1=295，右栏 x0∈[316,332]/x1=540。
 *  每栏 10 块 —— 分栏检测要求每簇 ≥5 块，块太少会退化成单栏（合成页面的坑）。 */
function twoColumnPage(): IndexedBlock[] {
  return [
    ...Array.from({ length: 10 }, (_, i) => box(60 + (i % 5) * 4, 120 + i * 12, 295, `L${i}`, i)),
    ...Array.from({ length: 10 }, (_, i) => box(316 + (i % 5) * 4, 120 + i * 12, 540, `R${i}`, 100 + i)),
  ];
}

test("跨栏横幅：居中节标题必须排在左栏之前（否则节上下文滞后一整栏）", () => {
  // 几何取自真实页（题册 p10）：居中标题 x=[214,405]，中心 309.5 落在栏间 [~295,~324]
  const entries = [...twoColumnPage(), box(214, 45, 405, "专题 连接体动态平衡问题", 200)];
  const centers = detectColumnCenters(entries, 596);
  assert.equal(centers.length, 2, "前提：这页必须被识别为双栏");
  const ordered = restoreReadingOrder(entries, 2, 596, centers);
  const texts = ordered.map((e) => (e.block.kind === "text" ? e.block.text : ""));

  assert.equal(texts[0], "专题 连接体动态平衡问题", "跨栏横幅必须最先被读到");
  assert.deepEqual(
    texts.slice(1),
    [...Array.from({ length: 10 }, (_, i) => `L${i}`), ...Array.from({ length: 10 }, (_, i) => `R${i}`)],
    "横幅之后的正文仍按「左栏整列 + 右栏整列」",
  );
});

test("跨栏横幅不误伤栏内标题：栏内节标题留在左栏内部（答案册实测形态）", () => {
  // 栏内标题：x0=68、x1=208（中心 138，落在左栏内），y 在左栏中部
  const entries = [...twoColumnPage(), box(68, 165, 208, "第1节 重力 弹力 摩擦力", 200)];
  const centers = detectColumnCenters(entries, 596);
  const ordered = restoreReadingOrder(entries, 2, 596, centers);
  const texts = ordered.map((e) => (e.block.kind === "text" ? e.block.text : ""));
  const at = (t: string) => texts.indexOf(t);

  assert.ok(at("第1节 重力 弹力 摩擦力") > at("L0"), "栏内标题不得被提到左栏之前");
  assert.ok(at("第1节 重力 弹力 摩擦力") < at("R0"), "栏内标题仍应排在右栏之前");
  // 且必须保持「栏内按 y 排序」：y=165 落在 L3(156) 与 L4(168) 之间
  assert.ok(at("L3") < at("第1节 重力 弹力 摩擦力") && at("第1节 重力 弹力 摩擦力") < at("L4"), "栏内标题按 y 落位");
});

test("栏间估计的失效保护：栏间过宽（退化版面）时放弃估计、退化为原行为", () => {
  // 左栏很窄（x1≈88）+ 右栏 x0≈300~316 ⇒ 假栏间宽 ≈220 > 0.5×260 ⇒ 必须放弃估计
  const entries = [
    ...Array.from({ length: 10 }, (_, i) => box(40 + (i % 5) * 4, 120 + i * 12, 88, `L${i}`, i)),
    ...Array.from({ length: 10 }, (_, i) => box(300 + (i % 5) * 4, 120 + i * 12, 540, `R${i}`, 100 + i)),
    box(200, 50, 400, "居中横幅", 200),
  ];
  const centers = detectColumnCenters(entries, 596);
  assert.equal(estimateGutter(entries, centers), null, "退化版面必须放弃栏间估计");
});

// ---------- 图片块的栏归属与流位置：2026-10-15 真实回归（热狗题的图不见了） ----------

/** 阅读顺序里一个块的标签：图片用 `IMG<页内序号>`，文字用它的文本。 */
function flowLabel(e: IndexedBlock): string {
  const b = e.block;
  if (b.kind === "image") return `IMG${e.index}`;
  return b.kind === "text" || b.kind === "table" ? b.text : "";
}

/** 造一个图片块。bbox 全部取**真实页**上的数字。 */
function img(x0: number, y0: number, x1: number, y1: number, i: number): IndexedBlock {
  return { index: i, pageIndex: 0, block: { kind: "image", bbox: [x0, y0, x1, y1], path: `img-${i}.jpg` } };
}

/**
 * 复刻题册 p5（页宽 596）左栏第 1/2 题与右栏第 4 题的几何。
 * 三张图全在**左栏**：热狗图 [194,201,282,283]、钢丝木条图 [187,377,282,425]，
 * 右栏那张滑轮图 [447,256,539,335] 是唯一的对照（它本来就该归右栏）。
 */
function hotdogPage(): IndexedBlock[] {
  return [
    ...[74, 93, 111, 129, 149, 167].map((y, i) => box(52, y, 280, `L${i}`, i)), // 题1 正文
    box(146, 222, 165, "LA", 6), // 选项 A 的分数
    box(146, 273, 165, "LB", 7), // 选项 B 的分数
    box(40, 379, 176, "Q2", 13), // 题2 首行（带题号「2.」）
    ...[72, 90, 109, 128, 149, 167, 186, 204, 222, 239].map((y, i) => box(310, y, 538, `R${i}`, 40 + i)),
    img(194, 201, 282, 283, 8), // 热狗受力图 —— 属于题1
    img(187, 377, 282, 425, 16), // 钢丝木条图 —— 属于题2
    img(447, 256, 539, 335, 51), // 滑轮图 —— 属于题4（右栏）
  ];
}

test("图片归栏：左栏居中的图不得因 x0 偏右被判去右栏", () => {
  const entries = hotdogPage();
  const centers = detectColumnCenters(entries, 596);
  const gutter = estimateGutter(entries, centers);
  assert.ok(gutter, "前提：这页要估得出栏间");
  // 前提：x0 口径确实会把这张图判给右栏（簇中心是「栏起始 x」，图的 x0 被缩进推到栏间附近）
  assert.ok(Math.abs(centers[1]! - 194) < Math.abs(centers[0]! - 194), "前提：按 x0 判，热狗图更靠近右栏");

  const texts = restoreReadingOrder(entries, 2, 596, centers).map(flowLabel);
  const at = (t: string) => texts.indexOf(t);

  assert.ok(at("IMG8") < at("R0"), "热狗图必须留在左栏整列里，不能插进右栏");
  assert.ok(at("IMG16") < at("R0"), "钢丝木条图同上");
  assert.ok(at("R9") < at("IMG51"), "右栏的滑轮图仍归右栏（对照组：它排在右栏正文之后）");
});

test("图片流位置：图排在它所说明的那几行**之间**，不抢在它们之前", () => {
  // 钢丝木条图 y=[377,425]，题2 首行 y=379 —— 图顶边比它说明的那行高 2pt。
  // 按顶边排 ⇒ 图排在题2 之前 ⇒ `attachImage` 把它挂给**上一题**（实测挂给题1）。
  const entries = hotdogPage();
  const centers = detectColumnCenters(entries, 596);
  const texts = restoreReadingOrder(entries, 2, 596, centers).map(flowLabel);
  const at = (t: string) => texts.indexOf(t);

  assert.ok(at("Q2") < at("IMG16"), "图必须排在它所属题号行之后");
  assert.ok(at("L5") < at("IMG8") && at("IMG8") < at("LB"), "热狗图落在它的两个选项分数之间（与纸面一致）");
});
