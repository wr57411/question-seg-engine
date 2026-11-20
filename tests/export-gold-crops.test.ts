// export-gold-crops.test.ts —— 锁住「V3 框(pt) → 页图像素裁切矩形」的换算（含 ±2pt  padding 与边界钳制）。
// 裁图供独立 rec 重读，坐标必须与 audit-giant-crop 的 pdftoppm 裁切同口径（只是换 ffmpeg + 现成页图）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cropRect, resolvePageImage } from "../scripts/export-gold-crops.js";

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

// M4：OXR 快照页图命名不一（答案册 page-001.png 三位 / 曲线-OXR page-01.png 两位 / 万有引力-OXR page-1.png 无填充）。
// 解析器按候选序取第一个存在的文件；全缺 ⇒ null（调用方显式报错，不静默）。
test(" resolvePageImage prefers 3-digit, falls back to 2-digit then unpadded", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold-crops-"));
  try {
    assert.equal(resolvePageImage(dir, 0), null);
    writeFileSync(join(dir, "page-1.png"), "x");
    assert.equal(resolvePageImage(dir, 0), join(dir, "page-1.png"));
    writeFileSync(join(dir, "page-01.png"), "x");
    assert.equal(resolvePageImage(dir, 0), join(dir, "page-01.png"));
    writeFileSync(join(dir, "page-001.png"), "x");
    assert.equal(resolvePageImage(dir, 0), join(dir, "page-001.png"));
    // 页号换算：pno 是 0 基索引，页图是 1 基
    writeFileSync(join(dir, "page-12.png"), "x");
    assert.equal(resolvePageImage(dir, 11), join(dir, "page-12.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});