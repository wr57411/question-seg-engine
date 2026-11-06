// audit-hole-geometry.test.ts —— 锁住「原卷墨迹是独立裁判」这条判据本身不是死门。
//
// 反向验证链（与 docs/evidence/2026-11-05-洞几何核查.md 的验收契约一一对应）：
//   ① 正确 bbox ⇒ inflation≈1、dx≈0；放大 1.8× ⇒ inflation≈1.8（判据会响）
//   ② 行框整体挪位 5pt ⇒ bestVerticalShift 必须报 +5；摆正 ⇒ 必须报 0
//   ③ 分类三态 FAKE/FRAGMENT/REAL 各有夹具，且 ±20% 阈值不翻转
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GrayImage } from "../scripts/export-stages.js";
import {
  THRESHOLDS,
  bestVerticalShift,
  bboxFit,
  classifyHole,
  holesOf,
  inkExtent,
  inkLineAround,
  type Box,
  type Thresholds,
} from "../scripts/audit-hole-geometry.js";

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

test("inkExtent：只认灰度低于阈值的像素，空白区域返回 null", () => {
  const img = makeImg([band]);
  const e = inkExtent(img, 200, 200, [0, 0, 200, 200]);
  assert.deepEqual(e.bbox, band);
  assert.equal(e.inkPx, 1000);
  assert.deepEqual(inkExtent(img, 200, 200, [130, 50, 190, 60]), { bbox: null, inkPx: 0 });
  // 阈值以下不算墨：把整张图填成 200（>160）应一个墨点都没有
  const light: GrayImage = { width: 200, height: 200, data: new Uint8Array(200 * 200).fill(200) };
  assert.equal(inkExtent(light, 200, 200, [0, 0, 200, 200]).inkPx, 0);
});

test("inkExtent：norm×页高 的浮点尾数不得凭空多算一行", () => {
  const img = makeImg([[20, 100, 120, 110]]); // 10 行墨带
  const e = inkExtent(img, 200, 200, [20, 100, 120, 109.00000000000001]);
  assert.equal(e.inkPx, 1000);
  assert.deepEqual(e.bbox, [20, 100, 120, 110]);
});

test("inkLineAround：从洞向上下扩到白缝，拿到完整单行且不跨相邻行", () => {
  const img = makeImg([[20, 100, 120, 110], [20, 119, 120, 129]]); // 两行相隔 9pt 白缝
  // 洞只覆盖第一行上半 5 行 ⇒ 必须扩到整行 100..110
  const a = inkLineAround(img, 200, 200, [20, 100, 120, 105]);
  assert.ok(a);
  assert.deepEqual(a.bbox, [20, 100, 120, 110]);
  assert.equal(a.inkPx, 1000);
  // 洞在第二行上 ⇒ 不能跨到第一行
  const b = inkLineAround(img, 200, 200, [20, 119, 120, 124]);
  assert.ok(b);
  assert.deepEqual(b.bbox, [20, 119, 120, 129]);
});

test("bboxFit：正确 bbox ⇒ inflation=1、dx=0（不报警）", () => {
  const img = makeImg([band]);
  const f = bboxFit(img, 200, 200, band);
  assert.ok(f);
  assert.equal(f.inflation, 1);
  assert.equal(f.dx, 0);
  assert.equal(f.dy, 0);
  assert.equal(f.inkW, 100);
});

test("bboxFit：bbox 放大 1.8× ⇒ inflation=1.8（判据会响）", () => {
  const img = makeImg([band]);
  // 中心对齐放大：[-20,50,160,60] 宽 180，中心仍是 70
  const f = bboxFit(img, 200, 200, [-20, 50, 160, 60]);
  assert.ok(f);
  assert.equal(f.inflation, 1.8);
  assert.equal(f.bboxW, 180);
  assert.equal(f.inkW, 100);
  assert.equal(f.dx, 0);
});

test("bboxFit：逐块 dx 会被 bbox 裁切压小 ⇒ 锁住「dx 不当判据」这条纪律", () => {
  const img = makeImg([band]);
  // 框右移 10pt：框内只剩 [30,120] 共 90pt 墨迹，中心差只有 5pt，不是 10pt
  const f = bboxFit(img, 200, 200, [30, 50, 130, 60]);
  assert.ok(f);
  assert.equal(f.dx, 5);
  assert.equal(f.inkW, 90);
  // 断言里明确写出：classifyHole 不含位移阈值，避免有人把这个钝信号重新加回判据
  assert.equal("displacementAlertPt" in THRESHOLDS, false);
});

test("bestVerticalShift：行框整体挪位 5pt ⇒ 报 +5；摆正 ⇒ 报 0", () => {
  const img = makeImg([[20, 100, 120, 110]]); // 墨带 y=100..109，共 10 行
  // 行框也精确取 10 行（y0..y0+9）：用 105/200 会因浮点 ceil 多出一行，制造假平台。
  const shifted = [{ norm: [0.1, 95 / 200, 0.6, 104 / 200] as Box, text: "一行" }];
  const a = bestVerticalShift(img, 200, 200, shifted, 20);
  assert.equal(a.bestDy, 5);
  assert.equal(a.bestInkPx, 1000);
  assert.equal(a.baselineInkPx, 500);
  assert.equal(a.gainPct, 100);

  const aligned = [{ norm: [0.1, 100 / 200, 0.6, 109 / 200] as Box, text: "一行" }];
  const b = bestVerticalShift(img, 200, 200, aligned, 20);
  assert.equal(b.bestDy, 0);
  assert.equal(b.gainPct, 0);
});

test("bestVerticalShift：搜索范围超出半行距会把「错一行」当成对齐（锁住默认 ±8pt）", () => {
  // 两条相隔 19pt 的相同墨带 = 相邻两行；行框本应对齐第一条。
  const img = makeImg([[20, 100, 120, 110], [20, 119, 120, 129]]);
  const line = [{ norm: [0.1, 100 / 200, 0.6, 109 / 200] as Box, text: "一行" }];
  assert.equal(bestVerticalShift(img, 200, 200, line, 8).bestDy, 0);
  // 放宽到 ±20 后，dy=+19（整行错位）与 dy=0 并列最优 ⇒ 平台中心变成 10，估计被污染
  assert.notEqual(bestVerticalShift(img, 200, 200, line, 20).bestDy, 0);
  assert.equal(bestVerticalShift(img, 200, 200, line, 8).range, 8);
});

test("bestVerticalShift：空行列表不产生幽灵峰值", () => {
  const img = makeImg([]);
  const a = bestVerticalShift(img, 200, 200, [], 5);
  assert.equal(a.bestDy, 0); // 全 0 ⇒ 平台是整条曲线，中心 0；显式锁住别让调用方误读成「检测到偏移」
  assert.equal(a.bestInkPx, 0);
  assert.equal(a.lineCount, 0);
});

const base = {
  holeW: 20,
  holeInkPx: 300,
  bandInk: [20, 50, 120, 60] as Box,
  holeToBandWidth: 0.2,
  inkShare: 0.2,
  worst: {
    src: "blocks" as const,
    type: "title",
    bbox: [0, 50, 200, 60] as Box,
    bboxW: 200,
    inkW: 100,
    inflation: 2,
    dx: 0,
    dy: 0,
    inkPx: 1000,
    text: "标题",
  },
};

test("classifyHole：洞内无墨 ⇒ FAKE", () => {
  const r = classifyHole({ ...base, holeInkPx: 0 });
  assert.equal(r.verdict, "FAKE");
  assert.match(r.reasons.join(" "), /洞内墨迹/);
});

test("classifyHole：残片 + 膨胀块 ⇒ FRAGMENT（反向验证：放大框必须响）", () => {
  const r = classifyHole(base);
  assert.equal(r.verdict, "FRAGMENT");
  assert.match(r.reasons.join(" "), /inflation=2/);
  // 拿掉膨胀块，同一份残片数据必须回到 REAL ⇒ 判据不是恒红的死门
  assert.equal(classifyHole({ ...base, worst: { ...base.worst, inflation: 1 } }).verdict, "REAL");
});

test("classifyHole：整行真洞 + 正常块 ⇒ REAL", () => {
  const r = classifyHole({ ...base, holeW: 100, holeToBandWidth: 1, inkShare: 1, worst: { ...base.worst, inflation: 1 } });
  assert.equal(r.verdict, "REAL");
});

test("classifyHole：阈值 ±20% 不改变三态判定（结论不靠调参）", () => {
  for (const k of [0.8, 1, 1.2]) {
    const t: Thresholds = {
      minHoleInkPx: Math.round(THRESHOLDS.minHoleInkPx * k),
      fragmentRatio: Math.round(THRESHOLDS.fragmentRatio * k * 100) / 100,
      inflationAlert: Math.round(THRESHOLDS.inflationAlert * k * 100) / 100,
    };
    assert.equal(classifyHole({ ...base, holeInkPx: 0 }, t).verdict, "FAKE");
    assert.equal(classifyHole(base, t).verdict, "FRAGMENT");
    assert.equal(classifyHole({ ...base, holeW: 100, holeToBandWidth: 1, inkShare: 1, worst: { ...base.worst, inflation: 1 } }, t).verdict, "REAL");
  }
});

test("holesOf：只收 content 且宽高比 ≥1.5 的洞（与 ocr-page-fill-jobs 同源）", () => {
  const boxes = holesOf({
    uncovered: [
      { kind: "content", bbox: [0, 0, 30, 10] },
      { kind: "content", bbox: [0, 0, 10, 10] }, // 宽高比 1 ⇒ 排除
      { kind: "furniture", bbox: [0, 0, 30, 10] }, // 非 content ⇒ 排除
    ],
  });
  assert.deepEqual(boxes, [[0, 0, 30, 10]]);
});
