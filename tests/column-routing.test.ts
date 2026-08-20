// tests/column-routing.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectColumnCenters, layoutPage, restoreReadingOrder } from "../src/layout.js";
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