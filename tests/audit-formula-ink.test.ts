// audit-formula-ink.test.ts —— 锁住「公式行坐标用原卷墨迹独立裁判」这条判据不是死门。
//
// 反向验证链（与 audit-hole-geometry 同口径，复用其 THRESHOLDS，不新造阈值）：
//   ① 正确框紧贴墨带 ⇒ REAL
//   ② 空框（无墨）⇒ FAKE
//   ③ 横向右移半框 ⇒ BLOAT（框内墨宽 < 框宽 ⇒ inflation>1.4）
//   ④ 纵向下移 ⇒ FRAGMENT（框内墨占真实行墨 < 0.5）
//   ⑤ 膨胀框（远宽于墨）⇒ BLOAT
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GrayImage } from "../scripts/export-stages.js";
import { judgeInkBox } from "../scripts/audit-formula-ink.js";
import type { Box } from "../scripts/audit-hole-geometry.js";

/** 200×200 合成灰度图，页面也设 200×200 ⇒ 1pt = 1px，便于精确断言。 */
function makeImg(rects: Box[]): GrayImage {
  const w = 200;
  const h = 200;
  const data = new Uint8Array(w * h).fill(255);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) data[y * w + x] = 0;
    }
  }
  return { width: w, height: h, data };
}

const band: Box = [20, 50, 120, 60]; // 100×10pt 的一条墨带
const img = makeImg([band]);
const W = 200;
const H = 200;

test("正确框紧贴墨带 ⇒ REAL", () => {
  const r = judgeInkBox(img, W, H, [20, 50, 120, 60]);
  assert.equal(r.verdict, "REAL");
  assert.ok(r.inkPx >= 20);
});

test("空框（无墨）⇒ FAKE", () => {
  const r = judgeInkBox(img, W, H, [20, 100, 120, 110]);
  assert.equal(r.verdict, "FAKE");
});

test("横向右移半框 ⇒ BLOAT（inflation>1.4）", () => {
  const r = judgeInkBox(img, W, H, [70, 50, 170, 60]);
  assert.equal(r.verdict, "BLOAT");
  assert.ok((r.inflation ?? 0) > 1.4);
});

test("纵向下移 ⇒ FRAGMENT（inkShare<0.5）", () => {
  const r = judgeInkBox(img, W, H, [20, 57, 120, 67]);
  assert.equal(r.verdict, "FRAGMENT");
  assert.ok((r.inkShare ?? 1) < 0.5);
});

test("膨胀框（远宽于墨）⇒ BLOAT", () => {
  const r = judgeInkBox(img, W, H, [0, 50, 200, 60]);
  assert.equal(r.verdict, "BLOAT");
});