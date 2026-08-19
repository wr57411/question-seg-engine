// tests/detect-columns.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectColumns, DEFAULT_COLUMN_PARAMS } from "../src/layout.js";
import type { IndexedBlock } from "../src/types.js";

/** 构造 IndexedBlock[]：指定 x0 数组，其余字段占位 */
function blocks(xs: number[]): IndexedBlock[] {
  return xs.map((x, i) => ({
    index: i,
    pageIndex: 0,
    block: { kind: "text", bbox: [x, 10, x + 30, 20], text: `b${i}`, firstLine: `b${i}`, lineCount: 1, maxFontSize: 0 },
  }));
}

test("单栏：块集中在左侧一簇", () => {
  const xs = Array.from({ length: 30 }, (_, i) => 40 + i * 1.5); // 40~83
  assert.equal(detectColumns(blocks(xs), 596), 1);
});

test("双栏：左右两簇，簇距显著", () => {
  const left = Array.from({ length: 15 }, (_, i) => 40 + i * 2); // 40~68
  const right = Array.from({ length: 15 }, (_, i) => 300 + i * 2); // 300~328
  assert.equal(detectColumns(blocks([...left, ...right]), 596), 2);
});

test("带居中标题的双栏：标题块横跨栏间隙不破坏判定（真实数据机制）", () => {
  const left = Array.from({ length: 15 }, (_, i) => 40 + i * 2);
  const right = Array.from({ length: 15 }, (_, i) => 300 + i * 2);
  const titles = [221, 196]; // 居中标题/大题块，n=2 必须被过滤
  assert.equal(detectColumns(blocks([...left, ...titles, ...right]), 596), 2);
});

test("小数据双栏（math-two-column 形态）：左 10 块右 5 块仍判两栏", () => {
  const left = [60, 80, 80, 80, 80, 60, 80, 80, 80, 80];
  const right = [880, 880, 880, 880, 880];
  assert.equal(detectColumns(blocks([...left, ...right]), 1654), 2);
});

test("零散小簇不足阈值：单栏（边注 n=2 不构成第二栏）", () => {
  const main = Array.from({ length: 20 }, (_, i) => 50 + i * 1.5);
  const aside = [300, 305]; // 边注 2 块 < max(5, 10%×22=2.2)→5
  assert.equal(detectColumns(blocks([...main, ...aside]), 596), 1);
});

test("参数可注入：收紧 minClusterBlocks 后小簇可成第二栏簇", () => {
  const main = Array.from({ length: 12 }, (_, i) => 50 + i * 1.5);
  const aside = Array.from({ length: 6 }, (_, i) => 300 + i * 2);
  assert.equal(detectColumns(blocks([...main, ...aside]), 596, { ...DEFAULT_COLUMN_PARAMS, minClusterBlocks: 5 }), 2);
  assert.equal(detectColumns(blocks([...main, ...aside]), 596, { ...DEFAULT_COLUMN_PARAMS, minClusterBlocks: 8 }), 1);
});