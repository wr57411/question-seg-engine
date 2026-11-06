// tests/ink-band-align.test.ts —— V3 行框→墨迹带配对（几何换源，2026-11-07 用户目标）
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairLineToBand, type InkBand } from "../scripts/ink-band-align.js";

type Box = [number, number, number, number];

const band = (y0: number, y1: number, x0: number, x1: number, inkPx = 100): InkBand => ({ y0, y1, x0, x1, inkPx });

test("pairLineToBand：半行距偏移的框配到 y 重叠最大的正确带", () => {
  // 两带 y 100-110 / 120-130（行距 19pt 形态）；框 y 118-128 与带 2 重叠 10/10
  const bands = [band(100, 110, 20, 100), band(120, 130, 20, 100)];
  const r = pairLineToBand([20, 118, 100, 128], bands);
  assert.ok(r);
  assert.equal(r.band.y0, 120, "配到下方那条带");
});

test("pairLineToBand：行内大空隙碎片带合并 —— x 取同视觉行碎片并集，y 保持主带（真值）", () => {
  // 一行被行内空隙切成两条碎片带（同 y、x 相邻不重叠）⇒ x 合并覆盖整行，y 不动
  const bands = [band(100, 110, 20, 60), band(100, 110, 80, 160)];
  const r = pairLineToBand([20, 100, 160, 110], bands);
  assert.ok(r);
  assert.equal(r.band.x0, 20, "合并带 x 起点=第一条碎片");
  assert.equal(r.band.x1, 160, "合并带 x 终点=第二条碎片");
  assert.equal(r.band.y0, 100, "y 保持主带（不跨行）");
  assert.equal(r.band.inkPx, 200, "合并带墨量=两条碎片之和");
});

test("pairLineToBand：无带可配（零重叠）返回 null（不猜）", () => {
  const bands = [band(100, 110, 20, 100)];
  const r = pairLineToBand([20, 300, 100, 310], bands);
  assert.equal(r, null);
});

test("pairLineToBand：框跨两带各半（正中）时仍返回其一（歧义不硬猜方向，ties>1 记录）", () => {
  const bands = [band(100, 110, 20, 100), band(120, 130, 20, 100)];
  const r = pairLineToBand([20, 108, 100, 122], bands); // 与两带各重叠 2/14
  assert.ok(r);
  assert.ok([100, 120].includes(r.band.y0), "返回两条带之一");
});

test("pairLineToBand：不同 y 重叠时取重叠最大者（中心距只是 tie-break）", () => {
  const bands = [band(100, 110, 20, 100), band(120, 130, 20, 100)];
  // 框 y 104-124：与带 1 重叠 6、带 2 重叠 4 ⇒ 主分 0.6 vs 0.4 ⇒ 带即使中心更远也赢
  const r = pairLineToBand([20, 104, 100, 124], bands);
  assert.ok(r);
  assert.equal(r.band.y0, 100, "y 重叠主分优先于中心距");
});

test("pairLineToBand：LaTeX 行正常配对（无宽度守卫）", () => {
  const bands = [band(100, 110, 20, 100)];
  const r = pairLineToBand([20, 100, 100, 110], bands);
  assert.ok(r, "配对只看几何，不看文本内容");
});
