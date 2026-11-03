// ink-lines.test.ts —— 锁住「洞内按墨迹投影切行」：3 条墨带 ⇒ 3 行；窄缝合并。
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitInkLines } from "../scripts/ink-lines.js";

function makeImg(w: number, h: number, bands: [number, number][]): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(w * h).fill(255);
  for (const [y0, y1] of bands)
    for (let y = y0; y <= y1; y++) for (let x = 10; x < w - 10; x++) data[y * w + x] = 0;
  return { width: w, height: h, data };
}

test("splitInkLines：三条墨带 ⇒ 三行，且行 y 范围对得上", () => {
  const img = makeImg(200, 200, [[20, 30], [50, 60], [80, 90]]);
  const lines = splitInkLines(img, 200, 200, [0, 0, 200, 200]);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.py0, 20);
  assert.equal(lines[0]!.py1, 30);
  assert.equal(lines[2]!.py0, 80);
});

test("splitInkLines：间距小于 minGapPx 的两条带会合并（治上下标/分式横线）", () => {
  const img = makeImg(200, 200, [[20, 30], [33, 40]]); // 中间只隔 2 行白
  const merged = splitInkLines(img, 200, 200, [0, 0, 200, 200]);
  assert.equal(merged.length, 1);
  const separated = splitInkLines(img, 200, 200, [0, 0, 200, 200], { threshold: 200, minInkPx: 1, minGapPx: 1 });
  assert.equal(separated.length, 2);
});

test("splitInkLines：空白区域切出 0 行（不产生幽灵行）", () => {
  const img = makeImg(200, 200, []);
  assert.equal(splitInkLines(img, 200, 200, [0, 0, 200, 200]).length, 0);
});
