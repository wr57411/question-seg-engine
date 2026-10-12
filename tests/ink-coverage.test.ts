// ink-coverage.test.ts —— 墨迹覆盖率纯逻辑断言（合成数据，离线可跑，不需要 PDF/pdftoppm）。
// 覆盖：PGM(P5) 解析（含注释、maxval 后单空白）、二值化 + bbox 覆盖 + 未覆盖墨迹聚类、面积下限过滤。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePgm, findUncoveredInk, classifyUncovered, contentRectOf } from "../scripts/export-stages.js";
import type { BBox } from "../src/types.js";

const OPTS = { threshold: 160, expandPx: 0, dilatePx: 0, minAreaPx: 10 };

/** 造一张 P5 PGM：文本头 + 灰度字节 */
function makePgm(width: number, height: number, pixels: number[]): Uint8Array {
  const header = `P5\n${width} ${height}\n255\n`;
  const head = new Uint8Array([...header].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(pixels);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

test("parsePgm：解析 P5 文本头与灰度字节（含 # 注释）", () => {
  const buf = new Uint8Array([
    ..."P5\n# 注释行\n4 2\n255\n".split("").map((c) => c.charCodeAt(0)),
    0, 10, 20, 30, 40, 50, 60, 70,
  ]);
  const img = parsePgm(buf);
  assert.equal(img.width, 4);
  assert.equal(img.height, 2);
  assert.deepEqual([...img.data], [0, 10, 20, 30, 40, 50, 60, 70]);
});

test("parsePgm：非 P5 头抛错", () => {
  const buf = new Uint8Array([..."P6\n1 1\n255\n".split("").map((c) => c.charCodeAt(0)), 0, 0, 0]);
  assert.throws(() => parsePgm(buf), /P5/);
});

test("findUncoveredInk：只报「是墨迹且不在任何 bbox 内」的区域", () => {
  const W = 100;
  const H = 100;
  const px = new Array(W * H).fill(255);
  const setDark = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * W + x] = 0;
  };
  setDark(10, 10, 30, 30); // 被 bbox 覆盖
  setDark(60, 60, 80, 80); // 未覆盖（= 漏识别）
  const img = { width: W, height: H, data: new Uint8Array(px) };
  const boxes: BBox[] = [[5, 5, 35, 35]];
  const { regions, inkPx, uncoveredPx } = findUncoveredInk(
    img,
    { width: W, height: H, boxes },
    OPTS,
  );
  assert.equal(inkPx, 400 + 400, "两处墨迹共 800 像素");
  assert.equal(uncoveredPx, 400, "仅未覆盖的那处方块");
  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0]?.bbox, [60, 60, 80, 80]);
  assert.equal(regions[0]?.area, 400);
  assert.equal(regions[0]?.kind, "content", "未传 contentRect 时退化为整页 → 保守判内容级");
});

test("findUncoveredInk：极小区域被面积下限丢弃", () => {
  const W = 20;
  const H = 20;
  const px = new Array(W * H).fill(255);
  px[5 * W + 5] = 0; // 单个墨点
  const img = { width: W, height: H, data: new Uint8Array(px) };
  const { regions, uncoveredPx } = findUncoveredInk(img, { width: W, height: H, boxes: [] }, OPTS);
  assert.equal(uncoveredPx, 1);
  assert.equal(regions.length, 0, "1px 区域 < minAreaPx(10) 应被丢弃");
});

test("findUncoveredInk：bbox 外扩能吸收紧贴的墨迹（不误报）", () => {
  const W = 40;
  const H = 40;
  const px = new Array(W * H).fill(255);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) px[y * W + x] = 0;
  const img = { width: W, height: H, data: new Uint8Array(px) };
  // bbox 略小于墨迹（[9,9,19,19]），外扩 2px 后应完全覆盖 → 无未覆盖
  const { uncoveredPx } = findUncoveredInk(
    img,
    { width: W, height: H, boxes: [[9, 9, 19, 19]] },
    { ...OPTS, expandPx: 2 },
  );
  assert.equal(uncoveredPx, 0);
});

test("classifyUncovered：细长线判家具级，页边带判家具级，正文行判内容级", () => {
  const contentRect: BBox = [40, 130, 540, 780];
  const W = 596;
  const H = 824;
  // 栏间竖线：0.5pt 宽 × 400pt 高 → 家具级
  assert.equal(classifyUncovered([290, 255, 290.5, 655], contentRect, W, H), "furniture");
  // 页眉 logo（完全落在页眉带 y ≤ 15%H=123.6 内）→ 家具级
  assert.equal(classifyUncovered([61, 67, 111, 90], contentRect, W, H), "furniture");
  // 页边竖排章节标（完全落在右页边带 x ≥ 92%W=548.3 内）→ 家具级
  assert.equal(classifyUncovered([549, 173, 584, 221], contentRect, W, H), "furniture");
  // 正文行（宽 130pt × 高 11pt，落在内容矩形内）→ 内容级
  assert.equal(classifyUncovered([53.7, 204, 183.2, 215], contentRect, W, H), "content");
  // 可疑情形（短边 5pt 的横条，不够细；又不在页边带）→ 保守判内容级
  assert.equal(classifyUncovered([60, 200, 180, 205], contentRect, W, H), "content");
});

test("classifyUncovered：区域过半落在内容矩形外 → 家具级", () => {
  const contentRect: BBox = [40, 130, 540, 780];
  // 大部分在页眉带下方、内容矩形上方（y 124~129 不属于页眉带，但过半在内容矩形外）→ 家具级
  assert.equal(classifyUncovered([95, 110, 586, 128], contentRect, 596, 824), "furniture");
});

test("contentRectOf：取全部行级块的并集；无块时退化为整页", () => {
  const page = {
    index: 0,
    width: 596,
    height: 824,
    columns: 2,
    centers: [],
    raw: [],
    discarded: [],
    blocks: [
      { i: 0, kind: "text", bbox: [40, 72, 280, 90] as BBox, text: "a" },
      { i: 1, kind: "image", bbox: [300, 100, 540, 300] as BBox, text: "[图片]" },
    ],
    order: [0, 1],
    questions: [],
    uncovered: [],
    ocrFill: [],
    ocrFullText: "",
  };
  assert.deepEqual(contentRectOf(page), [40, 72, 540, 300]);
  assert.deepEqual(contentRectOf({ ...page, blocks: [] }), [0, 0, 596, 824]);
});
