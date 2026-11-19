// tests/table-guard.test.ts
//
// G1 无边框守卫（spec §4.1）：判据全部来自**原卷灰度墨迹**，独立于 V3 输出。
// 口径：表区域内最长水平连续墨迹 run / 区域宽（hRunW，浅灰表格线阈 <240）。
// 实测分离：8 张真表 hRunW ∈ [0.62,1.00]；da-p186 无边框索引 = 0.04 ⇒ 阈值 0.3。
// 合成灰度门：有横线 ⇒ 不判 borderless；无横线（只有文字墨点）⇒ 判 borderless。
// 误杀方向安全：真表被误判 borderless 只失格网视觉、行文本照常（不丢内容）。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  G1_BORDERLESS_HRUN_MAX,
  G1_LINE_THRESHOLD,
  isBorderlessByInk,
  longestHRunRatio,
  longestVRunRatio,
} from "../scripts/table-guard.js";

/** 合成灰度图：白纸 255，指定像素写灰值 */
function gray(w: number, h: number, paint: (x: number, y: number) => number = () => 255) {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = paint(x, y);
  return { width: w, height: h, data };
}

test("G1：贯穿横线（浅灰 200）⇒ hRunW≈1，不判 borderless", () => {
  const img = gray(100, 50, (_x, y) => (y === 25 ? 200 : 255));
  const r = longestHRunRatio(img, [0, 0, 100, 50]);
  assert.ok(r >= 0.99, `贯穿横线 hRunW 应≈1（实测 ${r}）`);
  assert.equal(isBorderlessByInk(r), false);
});

test("G1：只有文字墨点（无横线）⇒ hRunW 远小于 0.3，判 borderless", () => {
  // 每 10px 一个 2px 宽墨点（模拟文字笔画），最长水平 run=2
  const img = gray(100, 50, (x, y) => (y >= 20 && y <= 30 && x % 10 < 2 ? 40 : 255));
  const r = longestHRunRatio(img, [0, 0, 100, 50]);
  assert.ok(r < 0.1, `文字墨点最长 run 应很短（实测 ${r}）`);
  assert.equal(isBorderlessByInk(r), true);
});

test("G1：阈值口径——浅灰线 230 算墨（<240），纸色 250 不算", () => {
  assert.equal(G1_LINE_THRESHOLD, 240);
  const line230 = gray(100, 20, (_x, y) => (y === 10 ? 230 : 255));
  assert.ok(longestHRunRatio(line230, [0, 0, 100, 20]) >= 0.99, "浅灰表格线（160–240）必须算墨");
  const paper250 = gray(100, 20, (_x, y) => (y === 10 ? 250 : 255));
  assert.equal(longestHRunRatio(paper250, [0, 0, 100, 20]), 0, "纸色/噪点 250 不算墨");
});

test("G1：阈值 0.3 钉死（分离裕度 0.04 vs 0.62，>15×）；最弱真表 0.62 不被误杀", () => {
  assert.equal(G1_BORDERLESS_HRUN_MAX, 0.3);
  assert.equal(isBorderlessByInk(0.04), true, "da-p186 实测 0.04 ⇒ borderless");
  assert.equal(isBorderlessByInk(0.62), false, "qx-p10 最弱真表 0.62 ⇒ 仍是有框表");
  assert.equal(isBorderlessByInk(0.3), false, "边界取 <0.3（等于不判）");
});

test("G1：区域裁剪——只量表 bbox 内的墨迹，区域外横线不干扰", () => {
  const img = gray(100, 60, (_x, y) => (y === 5 ? 30 : 255)); // 横线在区域外（y=5）
  const r = longestHRunRatio(img, [10, 20, 90, 50]);
  assert.equal(r, 0, "区域外墨迹不得计入");
});

test("G1：竖 run 口径（vRunH，佐证信号）——单竖分隔线 / 区域高", () => {
  const img = gray(50, 100, (x, _y) => (x === 25 ? 200 : 255));
  const v = longestVRunRatio(img, [0, 0, 50, 100]);
  assert.ok(v >= 0.99, "贯穿竖线 vRunH≈1");
  const none = gray(50, 100);
  assert.equal(longestVRunRatio(none, [0, 0, 50, 100]), 0);
});