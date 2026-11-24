// figure-overlap.js 判据测试（rdwi/8f0e：文字框右缘过冲到图上）
import { test } from "node:test";
import assert from "node:assert/strict";
import { figureEdgeClamps, columnIndexOf } from "../stages/figure-overlap.js";

const b = (i: number, kind: string, x0: number, y0: number, x1: number, y1: number, text = "") => ({
  i,
  kind,
  bbox: [x0, y0, x1, y1] as number[],
  text,
});

test("书A p6 实证：左文右图，文字框越过图左缘 ⇒ 收缘到图左缘", () => {
  const blocks = [
    b(45, "text", 310, 235, 557, 246, "A. 图中三种方案汽车运动的位移相同"),
    b(46, "text", 310, 259, 557, 271, "B. 方案二中要行驶“10千米”用时约“20分钟”,则全程的平均速率约为30 km/h"),
    b(52, "image", 458, 237, 553, 355),
  ];
  const m = figureEdgeClamps(blocks, 596, [42, 308]);
  assert.equal(m.get(45), 458);
  assert.equal(m.get(46), 458);
});

test("文字完全在图左侧、不越界 ⇒ 不动", () => {
  const blocks = [
    b(1, "text", 310, 235, 450, 246, "A. xxx"),
    b(2, "image", 458, 237, 553, 355),
  ];
  assert.equal(figureEdgeClamps(blocks, 596, [42, 308]).size, 0);
});

test("图内标注（文字中心在图内）⇒ 不动——甲/乙/图3 等本来就该印在图上", () => {
  const blocks = [
    b(1, "text", 513, 489, 549, 497, "加速电场"),
    b(2, "image", 311, 429, 553, 504),
  ];
  assert.equal(figureEdgeClamps(blocks, 596, [42, 308]).size, 0);
});

test("异栏不处理（左栏文字 × 右栏图）", () => {
  const blocks = [
    b(1, "text", 51, 235, 295, 246, "左栏正文"),
    b(2, "image", 458, 237, 553, 355),
  ];
  assert.equal(figureEdgeClamps(blocks, 596, [42, 308]).size, 0);
});

test("小图（细线/图标）不处理", () => {
  const blocks = [
    b(1, "text", 310, 235, 557, 246, "正文"),
    b(2, "image", 458, 240, 480, 250),
  ];
  assert.equal(figureEdgeClamps(blocks, 596, [42, 308]).size, 0);
});

test("纵向无交集不处理", () => {
  const blocks = [
    b(1, "text", 310, 100, 557, 110, "上方文字"),
    b(2, "image", 458, 237, 553, 355),
  ];
  assert.equal(figureEdgeClamps(blocks, 596, [42, 308]).size, 0);
});

test("columnIndexOf：取最近簇心（与引擎 assign 一致）；缺 centers 时按页宽对半", () => {
  // 书A p6 的 centers=[42,308]：x=100 离 42 更近 ⇒ 左栏 0；x=400 离 308 更近 ⇒ 右栏 1
  assert.equal(columnIndexOf(100, 596, [42, 308]), 0);
  assert.equal(columnIndexOf(400, 596, [42, 308]), 1);
  assert.equal(columnIndexOf(100, 600), 0);
  assert.equal(columnIndexOf(400, 600), 1);
});
