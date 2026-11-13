// export-gold-crops.test.ts —— 锁住「V3 框(pt) → 页图像素裁切矩形」的换算（含 ±2pt  padding 与边界钳制）。
// 裁图供独立 rec 重读，坐标必须与 audit-giant-crop 的 pdftoppm 裁切同口径（只是换 ffmpeg + 现成页图）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { cropRect } from "../scripts/export-gold-crops.js";

test(" basic pt→px with scale=2 and ±2pt padding", () => {
  // v3=[10,20,110,30]pt, scale=2 ⇒ x0=(10-2)*2=16, x1=(110+2)*2=224, y0=(20-2)*2=36, y1=(30+2)*2=64
  const r = cropRect([10, 20, 110, 30], 2, 1000, 1467);
  assert.deepEqual(r, { x: 16, y: 36, w: 208, h: 28 });
});

test(" clamps to image bounds (box larger than page)", () => {
  const r = cropRect([-5, -5, 2000, 2000], 2, 1000, 1467);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.w, 999); // imgW-1
  assert.equal(r.h, 1466); // imgH-1
});

test(" fractional scale floors/ceils outward (never shrink the glyph box)", () => {
  // scale=1.805: x0=floor(8*1.805)=floor(14.44)=14, x1=ceil(112*1.805)=ceil(202.16)=203
  const r = cropRect([10, 20, 110, 30], 1.805, 1000, 1467);
  assert.equal(r.x, 14);
  assert.equal(r.w, 203 - 14);
});

test(" tiny box still yields w,h >= 1 (ffmpeg crop rejects 0)", () => {
  const r = cropRect([100, 100, 100.1, 100.1], 2, 1000, 1467);
  assert.ok(r.w >= 1);
  assert.ok(r.h >= 1);
});