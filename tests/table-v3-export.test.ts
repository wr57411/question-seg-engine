// tests/table-v3-export.test.ts
//
// S2 上游透传（spec §5.1）：export-stages 消费 table-v3.json / giant-crop.pNN.json，
// 只增快照新字段（tableClass/tableSource/crop/cropSize/coordSource），不改旧字段语义。
// 判据取最严 AND：
//   - 表格分类按 bbox IoU≥0.5 匹配 table 块；text 路由必须带 html（G3 完整性门，缺则不挂）；
//   - 巨带裁图行按 norm 框四边近等 + 文本归一化包含匹配——**段落块包含某行文本不挂**
//     （把整段换成单行裁图会丢其余行内容，红线）。
// 产物缺失/空 ⇒ 快照逐字节不变（默认关旗标纪律，与 B-39 同）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTableV3,
  attachGiantCropVictims,
  buildStageSnapshot,
  pngSizeFromHeader,
  type StageBlock,
  type StagePage,
  type TableV3Entry,
} from "../scripts/export-stages.js";
import type { ParsedDocument, SegmentationResult } from "../src/types.js";

/** 最小 PNG（只含签名 + IHDR）：放置器只需要原生宽高，不需要真像素 */
function fakePng(w: number, h: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function mkPage(blocks: StageBlock[]): StagePage {
  return {
    index: 76, width: 546, height: 815, columns: 2, centers: [136, 410],
    raw: [], discarded: [], blocks, order: blocks.map((b) => b.i),
    questions: [], uncovered: [], ocrFill: [], ocrFullText: "",
  };
}

test("pngSizeFromHeader：从 PNG IHDR 读原生宽高（大端）", () => {
  assert.deepEqual(pngSizeFromHeader(new Uint8Array(fakePng(894, 365))), [894, 365]);
  assert.deepEqual(pngSizeFromHeader(new Uint8Array(fakePng(54, 20))), [54, 20]);
  assert.throws(() => pngSizeFromHeader(new Uint8Array([0, 1, 2])), /PNG/);
});

/* ── table-v3.json 三分流透传 ── */

const TABLE_HTML = "<table><tr><td>甲</td><td>乙</td></tr></table>";
const tableBlock = (bbox: number[]): StageBlock => ({ i: 0, kind: "table", bbox: bbox as never, text: "甲\t乙", html: TABLE_HTML });

test("applyTableV3：text ⇒ html=V3 pred_html + tableSource=v3（走现状 tableNode）", () => {
  const pg = mkPage([tableBlock([10, 100, 300, 200])]);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [12, 102, 298, 198], class: "text", source: "v3", html: "<table><tr><td>V3甲</td><td>V3乙</td></tr></table>" }];
  const r = applyTableV3(pg, entries);
  assert.equal(r.attached, 1);
  const b = pg.blocks[0]!;
  assert.equal(b.tableClass, "text");
  assert.equal(b.tableSource, "v3");
  assert.ok(String(b.html).includes("V3甲"), "text 路由用 V3 结构化 HTML");
});

test("applyTableV3：image ⇒ 写 crop/cropSize，不写 V3 html（旧 html 数据保留不丢）", () => {
  const pg = mkPage([tableBlock([10, 100, 300, 200])]);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [12, 102, 298, 198], class: "image", source: "v3", crop: "table-crops/p077-t0.png", cropSize: [425, 578] }];
  assert.equal(applyTableV3(pg, entries).attached, 1);
  const b = pg.blocks[0]!;
  assert.equal(b.tableClass, "image");
  assert.equal(b.crop, "table-crops/p077-t0.png");
  assert.deepEqual(b.cropSize, [425, 578]);
  assert.equal(b.html, TABLE_HTML, "不写 V3 html；既有 html 保留（数据不丢，渲染分支优先 crop）");
});

test("applyTableV3：borderless ⇒ 只标 class（renderPaper 双保险跳过网格）", () => {
  const pg = mkPage([tableBlock([10, 40, 520, 780])]);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [12, 42, 518, 778], class: "borderless", source: "v3", guard: { hRunW: 0.04, vRunH: 0.14 } }];
  assert.equal(applyTableV3(pg, entries).attached, 1);
  assert.equal(pg.blocks[0]!.tableClass, "borderless");
});

test("applyTableV3：bbox 不匹配（IoU<0.5）⇒ 不挂、计数可见（不静默）", () => {
  const pg = mkPage([tableBlock([10, 100, 300, 200])]);
  const before = JSON.stringify(pg.blocks);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [400, 600, 500, 700], class: "text", html: TABLE_HTML }];
  const r = applyTableV3(pg, entries);
  assert.equal(r.attached, 0);
  assert.equal(r.unmatched, 1);
  assert.equal(JSON.stringify(pg.blocks), before);
});

test("applyTableV3：text 条目缺 html ⇒ 不进 text 路由（G3 门，降级不静默）", () => {
  const pg = mkPage([tableBlock([10, 100, 300, 200])]);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [12, 102, 298, 198], class: "text" }];
  const r = applyTableV3(pg, entries);
  assert.equal(r.attached, 0);
  assert.equal(r.unmatched, 1);
  assert.equal(pg.blocks[0]!.tableClass, undefined);
});

test("applyTableV3：空产物 ⇒ 快照块逐字节不变（默认关旗标）", () => {
  const pg = mkPage([tableBlock([10, 100, 300, 200]), { i: 1, kind: "text", bbox: [10, 300, 200, 312] as never, text: "正文" }]);
  const before = JSON.stringify(pg.blocks);
  assert.deepEqual(applyTableV3(pg, []), { attached: 0, unmatched: 0 });
  assert.equal(JSON.stringify(pg.blocks), before);
});

/* ── giant-crop victims 行级透传（coordSource=crop） ── */

function withCropDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "qseg-crop-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("attachGiantCropVictims：norm 框近等+文本匹配 ⇒ coordSource=crop + 相对 crop + 原生 cropSize", () => {
  withCropDir((dir) => {
    const crops = join(dir, "giant-crop", "crops");
    mkdirSync(crops, { recursive: true });
    writeFileSync(join(crops, "p076_g0-077.png"), fakePng(290, 22));
    const line: StageBlock = { i: 0, kind: "text", bbox: [290.8, 130.7, 429.7, 141.4] as never, text: "1.A【解析】本题考查波的传播.根" };
    const pg = mkPage([line]);
    const victims = [{ id: "p076_g0", page: 76, text: line.text, v3box: line.bbox, fallbackBox: line.bbox, crop: join(crops, "p076_g0-077.png") }];
    const r = attachGiantCropVictims(pg, victims, dir);
    assert.equal(r.attached, 1);
    assert.equal(line.coordSource, "crop");
    assert.equal(line.crop, join("giant-crop", "crops", "p076_g0-077.png"));
    assert.deepEqual(line.cropSize, [290, 22]);
    assert.equal(line.text, "1.A【解析】本题考查波的传播.根", "引擎原文一个字不动（文本留快照/title）");
  });
});

test("attachGiantCropVictims：段落块包含该行文本但框是整段 ⇒ 不挂（整段换单行裁图=丢其余行）", () => {
  withCropDir((dir) => {
    const crops = join(dir, "giant-crop", "crops");
    mkdirSync(crops, { recursive: true });
    writeFileSync(join(crops, "x.png"), fakePng(290, 22));
    const para: StageBlock = { i: 0, kind: "text", bbox: [290, 130, 430, 260] as never, text: "1.A【解析】本题考查波的传播.根\n据同侧法可知该时刻质点P向上" };
    const pg = mkPage([para]);
    const victims = [{ id: "p076_g0", page: 76, text: "1.A【解析】本题考查波的传播.根", v3box: [290.8, 130.7, 429.7, 141.4] as never, fallbackBox: [290.8, 130.7, 429.7, 141.4] as never, crop: join(crops, "x.png") }];
    const before = JSON.stringify(pg.blocks);
    const r = attachGiantCropVictims(pg, victims, dir);
    assert.equal(r.attached, 0);
    assert.equal(JSON.stringify(pg.blocks), before, "框不等 ⇒ 绝不把整段换成单行裁图");
  });
});

test("attachGiantCropVictims：文本不匹配 ⇒ 不挂（AND 最严）；crop=null ⇒ 跳过计数", () => {
  withCropDir((dir) => {
    const line: StageBlock = { i: 0, kind: "text", bbox: [290.8, 130.7, 429.7, 141.4] as never, text: "完全不同的另一行文字" };
    const pg = mkPage([line]);
    const victims = [
      { id: "a", page: 76, text: "1.A【解析】本题考查波的传播.根", v3box: line.bbox, fallbackBox: line.bbox, crop: join(dir, "nope.png") },
      { id: "b", page: 76, text: line.text, v3box: line.bbox, fallbackBox: line.bbox, crop: null },
    ];
    const r = attachGiantCropVictims(pg, victims, dir);
    assert.equal(r.attached, 0);
    assert.equal(r.skipped, 2);
    assert.equal(line.coordSource, undefined);
  });
});

test("attachGiantCropVictims：crop=null 但约定命名裁图在盘上 ⇒ 按约定解析（存在性+IHDR 自检）", () => {
  withCropDir((dir) => {
    const crops = join(dir, "giant-crop", "crops");
    mkdirSync(crops, { recursive: true });
    // export-gold-crops / audit-giant-crop 的命名约定：{id}-{page+1:03d}.png
    writeFileSync(join(crops, "p076_g0-077.png"), fakePng(290, 22));
    const line: StageBlock = { i: 0, kind: "text", bbox: [290.8, 130.7, 429.7, 141.4] as never, text: "1.A【解析】本题考查波的传播.根" };
    const pg = mkPage([line]);
    const victims = [{ id: "p076_g0", page: 76, text: line.text, v3box: line.bbox, fallbackBox: line.bbox, crop: null }];
    const r = attachGiantCropVictims(pg, victims, dir);
    assert.equal(r.attached, 1);
    assert.equal(line.coordSource, "crop");
    assert.equal(line.crop, join("giant-crop", "crops", "p076_g0-077.png"));
    assert.deepEqual(line.cropSize, [290, 22]);
  });
});

test("attachGiantCropVictims：空 victims ⇒ 逐字节不变", () => {
  const pg = mkPage([{ i: 0, kind: "text", bbox: [10, 10, 100, 22] as never, text: "正文" }]);
  const before = JSON.stringify(pg.blocks);
  assert.deepEqual(attachGiantCropVictims(pg, [], "/nonexistent"), { attached: 0, skipped: 0 });
  assert.equal(JSON.stringify(pg.blocks), before);
});

/* ── buildStageSnapshot 本体不产新字段（新字段只由 main() 的产物消费步骤写入） ── */

test("buildStageSnapshot：无产物消费时快照不含任何 S2 新字段（旧快照逐字节兼容）", () => {
  const doc: ParsedDocument = {
    docId: "t", pages: [{ index: 0, width: 596, height: 821, blocks: [{ kind: "text", bbox: [10, 10, 100, 20], text: "1. 甲", firstLine: "1. 甲", lineCount: 1, maxFontSize: 0 }] }],
  };
  const result: SegmentationResult = {
    docId: "t", questions: [], answerEntries: [], bands: [], reviews: [],
    stats: { totalBlocks: 1, questions: 0, reviewCount: 0, optionGroups: 0, imagesAttached: 0, answersMatched: 0, formulaBlocks: 0, inlineFormulas: 0, columnsPerPage: [1] },
  };
  const snap = buildStageSnapshot(doc, result, [[]], [[]]);
  const json = JSON.stringify(snap);
  for (const key of ["tableClass", "tableSource", "cropSize", "coordSource"]) {
    assert.ok(!json.includes(`"${key}"`), `快照不应含新字段 ${key}（产物缺失=默认关）`);
  }
});