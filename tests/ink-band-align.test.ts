// tests/ink-band-align.test.ts —— V3 行框→墨迹带配对（几何换源，2026-11-07 用户目标）
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairLineToBand, alignLinesToBands, type InkBand } from "../scripts/ink-band-align.js";
import type { GrayImage } from "../scripts/export-stages.js";

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

// ── B-39 巨带裁图坐标补充（truncationCropFallback 旗标）──────────────────────
// 合成巨带页：200×200pt（1px=1pt），左栏一条 100pt 高实心墨迹巨带（x20-90, y20-120，无内部白缝），
// 5 条紧单行 V3 框全落在带内 ⇒ 一条带认领 5 行 > MAX_BAND_LINES=3 ⇒ 截断 2 行。
type LineIn = { text: string; score: number | null; bbox: null; norm: Box };
function giantBandPage(): { img: GrayImage; lines: LineIn[] } {
  const W = 200, H = 200;
  const data = new Uint8Array(W * H).fill(255);
  for (let y = 20; y < 120; y++) for (let x = 20; x < 90; x++) data[y * W + x] = 0;
  const img: GrayImage = { width: W, height: H, data };
  const ys: [number, number][] = [[25, 35], [40, 50], [55, 65], [70, 80], [85, 95]];
  const lines: LineIn[] = ys.map(([y0, y1], i) => ({
    text: `行${i}`, score: 0.9, bbox: null, norm: [20 / W, y0 / H, 90 / W, y1 / H],
  }));
  return { img, lines };
}

test("truncationCropFallback 默认关：巨带截断行 norm=null、无 coordSource、无 cropFallback 统计（逐字节不变）", () => {
  const { img, lines } = giantBandPage();
  const r = alignLinesToBands(lines, img, 200, 200);
  assert.equal(r.stats.total, 5);
  assert.equal(r.stats.paired, 3, "top-3 配对");
  assert.equal(r.stats.noBand, 2, "截断 2 行降级 noBand");
  assert.equal(r.stats.cropFallback, undefined, "默认不产出 cropFallback 字段");
  assert.equal(r.lines.filter((l) => l.norm === null).length, 2);
  assert.ok(r.lines.every((l) => l.coordSource === undefined), "默认路径无 coordSource 字段");
});

test("truncationCropFallback 开：截断行保留 V3 紧框 + coordSource=crop，计入 cropFallback 不算 noBand", () => {
  const { img, lines } = giantBandPage();
  const r = alignLinesToBands(lines, img, 200, 200, { truncationCropFallback: true });
  assert.equal(r.stats.total, 5);
  assert.equal(r.stats.paired, 3);
  assert.equal(r.stats.noBand, 0, "回退行有坐标，不算 noBand");
  assert.equal(r.stats.cropFallback, 2);
  const crop = r.lines.filter((l) => l.coordSource === "crop");
  assert.equal(crop.length, 2);
  for (const c of crop) {
    assert.ok(c.norm, "回退行保留坐标");
    const orig = lines.find((l) => l.text === c.text)!;
    assert.deepEqual(c.norm, orig.norm, "回退坐标=V3 原紧框，不重新切带");
  }
  const paired = r.lines.filter((l) => l.coordSource !== "crop");
  assert.equal(paired.length, 3);
  assert.ok(paired.every((l) => l.norm && l.coordSource === undefined), "配对行仍换墨迹带几何，无 crop 标记");
});
