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
  consumeGiantCropArtifacts,
  insertTableV3Regions,
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

/* ── 生产默认通电：main() 的 giant-crop 产物消费接线（consumeGiantCropArtifacts） ──
 * 上面 attachGiantCropVictims 测的是「单页匹配判据」；这里测的是 export-stages 真正
 * 从 outDir 读 giant-crop.pNN.json → 按页分发 → 挂 coordSource=crop 的**生产接线**。
 * 用户拍板 B-39 全量开进生产 = 产物在即生效（无布尔旗标），故此接线必须被测试锁死：
 *   ① 有 victims 产物 ⇒ 匹配行 coordSource=crop + crop + cropSize（默认通电）；
 *   ② 缺产物 ⇒ 快照逐字节不变（向后兼容，与默认关旗标同纪律）；
 *   ③ 产物损坏 ⇒ 错误可见不静默（G1），不污染快照。 */

test("consumeGiantCropArtifacts：outDir 有 giant-crop.pNN.json ⇒ 匹配行 coordSource=crop（生产默认通电）", () => {
  withCropDir((dir) => {
    const crops = join(dir, "giant-crop", "crops");
    mkdirSync(crops, { recursive: true });
    writeFileSync(join(crops, "p076_g0-077.png"), fakePng(290, 22));
    const line: StageBlock = { i: 0, kind: "text", bbox: [290.8, 130.7, 429.7, 141.4] as never, text: "1.A【解析】本题考查波的传播.根" };
    const pg = mkPage([line]);
    // crop=null ⇒ 走两产出方共同命名约定 {id}-{page+1:03d}.png（与真实 6616 条 victims 同形态）
    writeFileSync(join(dir, "giant-crop.p76.json"), JSON.stringify({
      victims: [{ id: "p076_g0", page: 76, text: line.text, v3box: line.bbox, fallbackBox: line.bbox, crop: null }],
    }));
    const r = consumeGiantCropArtifacts([pg], dir);
    assert.equal(r.files, 1);
    assert.equal(r.attached, 1);
    assert.equal(r.skipped, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(line.coordSource, "crop");
    assert.equal(line.crop, join("giant-crop", "crops", "p076_g0-077.png"));
    assert.deepEqual(line.cropSize, [290, 22]);
    assert.equal(line.text, "1.A【解析】本题考查波的传播.根", "引擎原文一个字不动（文本留快照/title）");
  });
});

test("consumeGiantCropArtifacts：缺 giant-crop 产物 ⇒ 快照逐字节不变（向后兼容）", () => {
  withCropDir((dir) => {
    const pg = mkPage([
      { i: 0, kind: "text", bbox: [290.8, 130.7, 429.7, 141.4] as never, text: "1.A【解析】本题考查波的传播.根" },
      { i: 1, kind: "table", bbox: [10, 100, 300, 200] as never, text: "甲\t乙", html: TABLE_HTML },
    ]);
    const pages = [pg];
    const before = JSON.stringify(pages);
    const r = consumeGiantCropArtifacts(pages, dir);
    assert.deepEqual(r, { attached: 0, skipped: 0, errors: [], files: 0 });
    assert.equal(JSON.stringify(pages), before, "无产物 ⇒ 一个字节都不改（默认关旗标纪律）");
  });
});

test("consumeGiantCropArtifacts：产物损坏 ⇒ 错误可见不静默（G1），快照不污染", () => {
  withCropDir((dir) => {
    const pg = mkPage([{ i: 0, kind: "text", bbox: [290.8, 130.7, 429.7, 141.4] as never, text: "1.A【解析】本题考查波的传播.根" }]);
    const before = JSON.stringify(pg.blocks);
    writeFileSync(join(dir, "giant-crop.p76.json"), "{ 这不是合法 JSON ");
    const r = consumeGiantCropArtifacts([pg], dir);
    assert.equal(r.files, 1);
    assert.equal(r.attached, 0);
    assert.equal(r.errors.length, 1, "损坏产物必须报错，不静默吞");
    assert.equal(JSON.stringify(pg.blocks), before);
  });
});

/* ── M3：insertTableV3Regions（OXR 骨架缺表块 ⇒ V3 表区域插入；有表块 ⇒ 覆盖走 applyTableV3） ──
 * 红线：无 V3 产物/空 entries ⇒ 页面对象逐字节不变；覆盖模式与 applyTableV3 单跑逐字节一致。
 * 插入块 order 槽按 y（中心 y 比较）；borderless 无匹配块 ⇒ 守卫跳过不插臆造格网。 */

test("insertTableV3Regions：OXR 骨架无 table 块 + image entry ⇒ 插入 kind=table 块带 crop/cropSize，order 槽按 y", () => {
  const pg = mkPage([
    { i: 0, kind: "text", bbox: [10, 50, 200, 62] as never, text: "表前正文" },
    { i: 1, kind: "text", bbox: [10, 400, 200, 412] as never, text: "表后正文" },
  ]);
  const entries: TableV3Entry[] = [{
    page: 76, bbox: [10, 200, 300, 300] as never, class: "image", source: "v3",
    crop: "table-crops/p077-t0.png", cropSize: [894, 365],
  }];
  const r = insertTableV3Regions(pg, entries);
  assert.equal(r.inserted, 1);
  assert.equal(r.unmatched, 0);
  assert.equal(pg.blocks.length, 3);
  const b = pg.blocks[2]!;
  assert.equal(b.kind, "table");
  assert.equal(b.i, 2, "新块 i 取现有最大 i+1，不与既有块冲突");
  assert.equal(b.tableClass, "image");
  assert.equal(b.tableSource, "v3");
  assert.equal(b.crop, "table-crops/p077-t0.png");
  assert.deepEqual(b.cropSize, [894, 365]);
  assert.deepEqual(b.bbox, [10, 200, 300, 300]);
  assert.deepEqual(pg.order, [0, 2, 1], "order 槽按 y：表中心 y=250 在两块之间 ⇒ 插中间");
});

test("insertTableV3Regions：text entry ⇒ 插入带 V3 html，text=压平全文（search/title 可核对）", () => {
  const pg = mkPage([{ i: 0, kind: "text", bbox: [10, 50, 200, 62] as never, text: "表前正文" }]);
  const html = "<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td><td>丁</td></tr></table>";
  const entries: TableV3Entry[] = [{ page: 76, bbox: [10, 200, 300, 300] as never, class: "text", html }];
  const r = insertTableV3Regions(pg, entries);
  assert.equal(r.inserted, 1);
  const b = pg.blocks[1]!;
  assert.equal(b.kind, "table");
  assert.equal(b.tableClass, "text");
  assert.equal(b.html, html, "text 路由 html=V3 pred_html 原样");
  assert.ok(b.text.includes("甲") && b.text.includes("丁"), "压平全文进 text（不丢内容）");
  assert.deepEqual(pg.order, [0, 1], "表在页尾 ⇒ order 追加末尾");
});

test("insertTableV3Regions：order 槽——表在所有块上方 ⇒ 插 order 首位", () => {
  const pg = mkPage([
    { i: 3, kind: "text", bbox: [10, 300, 200, 312] as never, text: "下块" },
    { i: 7, kind: "text", bbox: [10, 500, 200, 512] as never, text: "更下块" },
  ]);
  pg.order = [3, 7];
  const entries: TableV3Entry[] = [{ page: 76, bbox: [10, 40, 300, 100] as never, class: "image", crop: "table-crops/x.png", cropSize: [100, 60] }];
  assert.equal(insertTableV3Regions(pg, entries).inserted, 1);
  assert.deepEqual(pg.order, [8, 3, 7], "i=max+1=8；中心 y=70 最小 ⇒ order 首位");
});

test("insertTableV3Regions：既有 table 块 IoU 匹配 ⇒ 走 applyTableV3 覆盖，不插新块，与单跑逐字节一致", () => {
  const mk = () => mkPage([
    tableBlock([10, 100, 300, 200]),
    { i: 1, kind: "text", bbox: [10, 300, 200, 312] as never, text: "正文" },
  ]);
  const entries: TableV3Entry[] = [{
    page: 76, bbox: [12, 102, 298, 198] as never, class: "image", source: "v3",
    crop: "table-crops/p077-t0.png", cropSize: [425, 578],
  }];
  const pgA = mk();
  const pgB = mk();
  applyTableV3(pgA, entries);
  const r = insertTableV3Regions(pgB, entries);
  assert.equal(r.inserted, 0);
  assert.equal(r.attached, 1);
  assert.equal(JSON.stringify(pgB), JSON.stringify(pgA), "覆盖模式必须与 applyTableV3 单跑逐字节一致（红线）");
});

test("insertTableV3Regions：borderless 无匹配块 ⇒ 守卫跳过不插臆造格网，行块逐字节不变", () => {
  const pg = mkPage([{ i: 0, kind: "text", bbox: [10, 50, 200, 62] as never, text: "索引行照常渲染" }]);
  const before = JSON.stringify(pg);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [10, 40, 520, 780] as never, class: "borderless", guard: { hRunW: 0.04, vRunH: 0.14 } }];
  const r = insertTableV3Regions(pg, entries);
  assert.equal(r.inserted, 0);
  assert.equal(r.skipped, 1);
  assert.equal(JSON.stringify(pg), before, "无边框 ⇒ 不画臆造格网，行文本照常（不丢内容）");
});

test("insertTableV3Regions：text 缺 html / image 缺裁图 ⇒ unmatched 计数可见，不插入（G3/缺件门）", () => {
  const pg = mkPage([{ i: 0, kind: "text", bbox: [10, 50, 200, 62] as never, text: "正文" }]);
  const before = JSON.stringify(pg);
  const entries: TableV3Entry[] = [
    { page: 76, bbox: [10, 200, 300, 300] as never, class: "text" },
    { page: 76, bbox: [10, 400, 300, 500] as never, class: "image" },
  ];
  const r = insertTableV3Regions(pg, entries);
  assert.equal(r.inserted, 0);
  assert.equal(r.unmatched, 2);
  assert.equal(JSON.stringify(pg), before);
});

test("insertTableV3Regions：§90 合成表（html 含 markdown 残字）被 image entry 覆盖 ⇒ bbox 校正为验证表框（漏泄行才能被抑）", () => {
  // 病灶实测（曲线运动 index3）：§90 合成框切掉表顶，漏泄行组在表内却在框外 ⇒ 不抑则双像。
  // 校正只认「html 含 markdown 图语法」的合成表；V3/MinerU 正常表框一个字节不动。
  const synth = { i: 0, kind: "table", bbox: [82, 178, 525, 331] as never, text: "速度关系", html: "<table><tr><td>](https://x/img.jpg)</td></tr></table>" };
  const pg = mkPage([synth]);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [82, 135, 525, 331] as never, class: "image", crop: "table-crops/p004-t0.png", cropSize: [750, 340] }];
  const r = insertTableV3Regions(pg, entries);
  assert.equal(r.attached, 1);
  assert.equal(r.inserted, 0);
  assert.deepEqual(pg.blocks[0]!.bbox, [82, 135, 525, 331], "合成框 bbox 校正为 entry 验证表框（并集）");
  assert.equal(pg.blocks[0]!.tableClass, "image");
});

test("insertTableV3Regions：正常表（html 无 markdown 残字）被 image entry 覆盖 ⇒ bbox 逐字节不动（覆盖模式行为锁）", () => {
  const pg = mkPage([tableBlock([10, 100, 300, 200])]);
  const entries: TableV3Entry[] = [{ page: 76, bbox: [8, 95, 305, 205] as never, class: "image", crop: "table-crops/x.png", cropSize: [300, 110] }];
  assert.equal(insertTableV3Regions(pg, entries).attached, 1);
  assert.deepEqual(pg.blocks[0]!.bbox, [10, 100, 300, 200], "正常表框不校正（MinerU/旧样本行为不变）");
});

test("insertTableV3Regions：空 entries / 它页 entries ⇒ 页面逐字节不变（无 V3 产物行为不变红线）", () => {
  const pg = mkPage([
    tableBlock([10, 100, 300, 200]),
    { i: 1, kind: "text", bbox: [10, 300, 200, 312] as never, text: "正文" },
  ]);
  const before = JSON.stringify(pg);
  assert.deepEqual(insertTableV3Regions(pg, []), { inserted: 0, unmatched: 0, attached: 0, skipped: 0 });
  assert.deepEqual(insertTableV3Regions(pg, [{ page: 99, bbox: [10, 200, 300, 300] as never, class: "image", crop: "x.png", cropSize: [1, 1] }]), { inserted: 0, unmatched: 0, attached: 0, skipped: 0 });
  assert.equal(JSON.stringify(pg), before);
});

/* ── M3 双像抑制（展示层 coveredByTable，B-42 最严 AND）：插入表内的 markdown 漏泄裁图行
 * 必须被抑制（整表截图已含其内容），被抑行原文留快照 text + 覆盖表 title（不丢内容）。
 * 假 DOM 与 crop-placement.test.ts 同法（零依赖，check 任何机器可跑）。 ── */

interface DomStub {
  tagName: string;
  children: DomStub[];
  parent: DomStub | null;
  style: Record<string, string> & { cssText?: string };
  className: string;
  textContent: string;
  innerHTML: string;
  title: string;
  src?: string;
  alt?: string;
  dataset: Record<string, string>;
  listeners: Record<string, ((e: unknown) => void)[]>;
  classList: { add: (c: string) => void; contains: (c: string) => boolean };
  append: (...n: DomStub[]) => void;
  remove: () => void;
  addEventListener: (t: string, fn: (e: unknown) => void) => void;
  querySelector: (sel: string) => DomStub | null;
  querySelectorAll: (sel: string) => DomStub[];
}

function stubMatches(n: DomStub, sel: string): boolean {
  if (sel.startsWith(".")) return n.classList.contains(sel.slice(1));
  const m = /^\[data-([a-z-]+)\]$/.exec(sel);
  if (m) {
    const key = m[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return n.dataset[key] !== undefined;
  }
  return n.tagName === sel;
}

function makeStub(tagName: string): DomStub {
  const n: DomStub = {
    tagName,
    children: [],
    parent: null,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    dataset: {},
    listeners: {},
    classList: {
      add: (c: string) => {
        if (!n.className.split(" ").includes(c)) n.className = `${n.className} ${c}`.trim();
      },
      contains: (c: string) => n.className.split(" ").includes(c),
    },
    append: (...kids: DomStub[]) => {
      for (const k of kids) {
        k.parent = n;
        n.children.push(k);
      }
    },
    remove: () => {
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = null;
    },
    addEventListener: (t, fn) => {
      (n.listeners[t] ??= []).push(fn);
    },
    querySelector: (sel: string) => n.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel: string) => {
      const out: DomStub[] = [];
      const walk = (x: DomStub) => {
        for (const c of x.children) {
          if (stubMatches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(n);
      return out;
    },
  };
  return n;
}

const stubBody = makeStub("body");
const stubDocListeners: Record<string, ((e: unknown) => void)[]> = {};
const gg = globalThis as unknown as Record<string, unknown>;
gg.document = {
  createElement: (t: string) => makeStub(t),
  createTextNode: (t: string) => Object.assign(makeStub("#text"), { textContent: t }),
  body: stubBody,
  addEventListener: (t: string, fn: (e: unknown) => void) => {
    (stubDocListeners[t] ??= []).push(fn);
  },
  removeEventListener: (t: string, fn: (e: unknown) => void) => {
    stubDocListeners[t] = (stubDocListeners[t] ?? []).filter((f) => f !== fn);
  },
};
gg.requestAnimationFrame = (fn: () => void) => {
  fn();
  return 0;
};

const { appendBlockNodes } = await import("../stages/reconstruct.js");

const domPage = {
  index: 3,
  width: 1000,
  height: 1431,
  columns: 1,
  questions: [] as { id: string; number: string; blocks: number[] }[],
  blocks: [] as Record<string, unknown>[],
};

test("M3 双像抑制：插入 image 表内的 markdown 漏泄裁图行（首块+尾块）⇒ 抑制，原文进覆盖表 title", () => {
  const table = {
    i: 0, kind: "table", bbox: [40, 160, 930, 530], text: "",
    tableClass: "image", tableSource: "v3",
    crop: "table-crops/p004-t0.png", cropSize: [896, 376],
  };
  const head = {
    i: 1, kind: "text", bbox: [60, 200, 900, 220], text: "![曲线运动图示",
    coordSource: "crop", crop: "leak-crops/p004-g01.png", cropSize: [840, 60],
  };
  const tail = {
    i: 2, kind: "text", bbox: [60, 225, 900, 245], text: "](http://cdn.example.com/a.png)",
    leakCoveredBy: 1,
  };
  const p = { ...domPage, blocks: [table, head, tail] };
  const c = makeStub("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "doc", true) as (DomStub | null)[];
  assert.ok(nodes[0], "整表截图必须渲染");
  assert.equal(nodes[1], null, "表内漏泄首块（coordSource=crop）必须被 coveredByTable 抑制（防双像）");
  assert.equal(nodes[2], null, "表内漏泄尾块同样不画");
  assert.ok(nodes[0]!.title.includes("![曲线运动图示"), "被抑首块原文必须进覆盖表 title（不丢内容）");
  assert.ok(nodes[0]!.title.includes("](http://cdn.example.com/a.png)"), "被抑尾块原文必须进覆盖表 title（不丢内容）");
});

test("M3 双像抑制守卫：表外 markdown 漏泄裁图行 ⇒ 绝不抑（中心在表外，照常贴原卷裁图）", () => {
  const table = {
    i: 0, kind: "table", bbox: [40, 160, 930, 530], text: "",
    tableClass: "image", tableSource: "v3",
    crop: "table-crops/p004-t0.png", cropSize: [896, 376],
  };
  const outside = {
    i: 1, kind: "text", bbox: [60, 700, 900, 720], text: "![另一张图](http://cdn.example.com/b.png)",
    coordSource: "crop", crop: "leak-crops/p004-g02.png", cropSize: [840, 30],
  };
  const p = { ...domPage, blocks: [table, outside] };
  const c = makeStub("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "doc", true) as (DomStub | null)[];
  assert.ok(nodes[1], "表外漏泄行必须照常渲染裁图（不丢内容红线）");
  assert.equal(nodes[1]!.dataset.coordSource, "crop");
  assert.ok(!nodes[0]!.title.includes("另一张图"), "表外行原文不进表 title");
});