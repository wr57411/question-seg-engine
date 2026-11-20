// tests/band-mask.test.ts —— M4b 页缘装饰竖条遮罩转生产（最严 AND 判据：整高+窄+x 在页缘）
// 判据常量 import 自实现（同源）；合成页 1px=1pt。
// 红线锁：alignLinesToBands 默认（旗标关）在竖条页行为逐字节不变；无竖条页遮罩零副本零行为差。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maskFrameBars,
  detectEdgeFrameBars,
  EDGE_FRAME_PT,
  MASK_BAR_WIDTH_PT,
  MASK_BAR_SPAN_RATIO,
} from "../scripts/band-mask.js";
import { alignLinesToBands } from "../scripts/ink-band-align.js";
import type { GrayImage } from "../scripts/export-stages.js";

type Box = [number, number, number, number];
const W = 200, H = 200;

/** 空白页 + 指定墨矩形（gray=0） */
function page(rects: [number, number, number, number][]): GrayImage {
  const data = new Uint8Array(W * H).fill(255);
  for (const [x0, y0, x1, y1] of rects)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * W + x] = 0;
  return { width: W, height: H, data };
}

/** 左缘整高窄竖条（x2-8，宽 6pt=6px≥bandsForColumn minInkPx=6 ⇒ 无遮罩时连墨成巨带）
 *  + 左栏 5 条间隔 10pt 的墨行（y20-30…100-110） */
function barPage(): GrayImage {
  return page([[2, 0, 8, H], [20, 20, 90, 30], [20, 40, 90, 50], [20, 60, 90, 70], [20, 80, 90, 90], [20, 100, 90, 110]]);
}

const fiveLines = (): { text: string; score: number | null; bbox: null; norm: Box }[] =>
  [20, 40, 60, 80, 100].map((y, i) => ({
    text: `行${i}`, score: 0.9, bbox: null, norm: [20 / W, y / H, 90 / W, (y + 10) / H],
  }));

test("detectEdgeFrameBars：页缘整高窄竖条命中，记录 pt 域 x/跨度/墨比（可核对记录）", () => {
  const runs = detectEdgeFrameBars(barPage(), W);
  assert.equal(runs.length, 1);
  const r = runs[0]!;
  assert.equal(r.x0, 2);
  assert.equal(r.x1, 8);
  assert.equal(r.spanRatio, 1);
  assert.equal(r.inkRatio, 1);
  assert.ok(r.x1 <= EDGE_FRAME_PT, "竖条整体落在页缘zone内");
  assert.ok(r.x1 - r.x0 <= MASK_BAR_WIDTH_PT, "窄条守卫");
});

test("maskFrameBars：竖条列置白、不改入参 img（检测不改写原图）", () => {
  const img = barPage();
  const before = Uint8Array.from(img.data);
  const out = maskFrameBars(img, W);
  assert.notEqual(out, img, "有竖条 ⇒ 遮蔽副本");
  assert.deepEqual(img.data, before, "入参逐字节不变");
  for (let y = 0; y < H; y++) for (let x = 2; x < 8; x++) assert.equal(out.data[y * W + x], 255);
  assert.equal(out.data[25 * W + 30], 0, "正文墨不动");
});

test("maskFrameBars：无竖条 ⇒ 原样返回入参（零副本，无竖条页逐字节不变）", () => {
  const img = page([[20, 20, 90, 30]]);
  assert.equal(maskFrameBars(img, W), img);
  assert.deepEqual(detectEdgeFrameBars(img, W), []);
});

test("最严 AND·页缘：页中部整高窄列（表格竖线形态）不遮罩", () => {
  const img = page([[95, 0, 100, H], [20, 20, 90, 30]]);
  assert.deepEqual(detectEdgeFrameBars(img, W), []);
  assert.equal(maskFrameBars(img, W), img);
});

test("最严 AND·窄：页缘整高宽色块（>MASK_BAR_WIDTH_PT）不遮罩（宁可漏遮不误遮）", () => {
  const img = page([[0, 0, MASK_BAR_WIDTH_PT + 10, H]]);
  assert.deepEqual(detectEdgeFrameBars(img, W), []);
  assert.equal(maskFrameBars(img, W), img);
});

test("最严 AND·窄：答案册 p185/186 形态 8pt 厚边条不遮罩（基线逐字节守卫）", () => {
  const img = page([[3, 0, 11, H]]); // 宽 8pt > MASK_BAR_WIDTH_PT
  assert.deepEqual(detectEdgeFrameBars(img, W), []);
  assert.equal(maskFrameBars(img, W), img);
});

test("最严 AND·整高：页缘窄条跨度不足（spanRatio<阈值）不遮罩", () => {
  const short = page([[2, 50, 7, 150]]); // span 0.5
  assert.deepEqual(detectEdgeFrameBars(short, W), []);
  const broken = page([[2, 0, 7, 170]]); // span 0.85 ≥ 阈值（装饰条允许设计断口）
  const runs = detectEdgeFrameBars(broken, W);
  assert.equal(runs.length, 1);
  assert.ok(runs[0]!.spanRatio >= MASK_BAR_SPAN_RATIO);
  const tooShort = page([[2, 0, 7, 150]]); // span 0.75 < 阈值
  assert.deepEqual(detectEdgeFrameBars(tooShort, W), []);
});

test("最严 AND·墨比：页缘整高稀疏列（墨比≤0.5，文字列形态）不遮罩", () => {
  const data = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y += 2) for (let x = 2; x < 7; x++) data[y * W + x] = 0; // inkRatio 0.5
  const img: GrayImage = { width: W, height: H, data };
  assert.deepEqual(detectEdgeFrameBars(img, W), []);
});

test("右页缘整高窄竖条同样命中（对称页缘zone）", () => {
  const img = page([[W - 6, 0, W - 1, H]]);
  const runs = detectEdgeFrameBars(img, W);
  assert.equal(runs.length, 1);
  assert.ok(runs[0]!.x0 >= W - EDGE_FRAME_PT);
  const out = maskFrameBars(img, W);
  assert.equal(out.data[100 * W + (W - 3)], 255);
});

test("maskFrameBars 预计算 runs 参数与自动检测同结果（审计侧记录复用不重判）", () => {
  const img = barPage();
  const runs = detectEdgeFrameBars(img, W);
  const a = maskFrameBars(img, W, runs);
  const b = maskFrameBars(img, W);
  assert.deepEqual(a.data, b.data);
});

// ── 配对回收 + 默认关逐字节锁 ────────────────────────────────────────────────
test("竖条页默认（旗标关）：整页单巨带 ⇒ top-3 截断，noBand/coordSource 形态逐字节不变", () => {
  const r = alignLinesToBands(fiveLines(), barPage(), W, H);
  assert.equal(r.stats.total, 5);
  assert.equal(r.stats.paired, 3, "竖条连墨 ⇒ 单巨带认领 5 行 ⇒ 截断 2");
  assert.equal(r.stats.noBand, 2);
  assert.equal(r.stats.cropFallback, undefined);
  assert.ok(r.lines.every((l) => l.coordSource === undefined));
  assert.equal(r.lines.filter((l) => l.norm === null).length, 2);
});

test("竖条页 bandMaskFrameBars 开：巨带被拆回 5 条行带 ⇒ 5/5 配对回收", () => {
  const r = alignLinesToBands(fiveLines(), barPage(), W, H, { bandMaskFrameBars: true });
  assert.equal(r.stats.paired, 5, "遮罩后左栏投影恢复白缝 ⇒ 逐行配带");
  assert.equal(r.stats.noBand, 0);
  for (const [i, l] of r.lines.entries()) {
    assert.ok(l.norm);
    assert.equal(l.norm![1], [20, 40, 60, 80, 100][i]! / H, "y=墨迹行带真值");
  }
});

test("无竖条页 bandMaskFrameBars 开与关逐字节同结果（遮罩零副作用）", () => {
  const img = page([[20, 20, 90, 30], [20, 40, 90, 50], [20, 60, 90, 70], [20, 80, 90, 90], [20, 100, 90, 110]]);
  const a = alignLinesToBands(fiveLines(), img, W, H);
  const b = alignLinesToBands(fiveLines(), img, W, H, { bandMaskFrameBars: true });
  assert.deepEqual(b, a);
});