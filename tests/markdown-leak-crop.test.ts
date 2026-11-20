// tests/markdown-leak-crop.test.ts
//
// M2（no-MinerU 生产化）：markdown 图片漏泄行 → 原卷页图裁图。
// 病灶（M1 查明）：OXR 把 `![图描述](http…)` 当文字行漏出，同一漏泄常被拆成多个相邻 text 块
// （曲线运动 page index3 实测 i5/6/7 三块：开头 `![`、中间纯描述、结尾 `](http`）。
// 命题：
//   ① 漏泄行组识别：`![` 开头块沿 y 邻接+同栏吸收后续 text 块，直到含 `](http` 的收尾块；
//      找不到收尾块 ⇒ 只保留开头块自身（最严 AND，绝不吞正常正文行）；
//      孤立的 `](http` 块自成一组；kind≠text（table 等）不在本步处理（M3 范围）。
//   ② 组 bbox 并集外扩 2pt，ffmpeg -vf crop 从原卷页图裁（pt→px 按页图宽/页宽 pt 换算），
//      cropSize 从裁图 PNG IHDR 实测（L7：不信算出来的数字）。
//   ③ 挂接口径照 attachGiantCropVictims 的下游消费（coordSource=crop + crop + cropSize）：
//      组首块挂裁图，组内其余块标 leakCoveredBy=首块 i（展示层由首块并集裁图呈现，不叠影）；
//      原文一个字不动（text 保留，title 由展示层补全）。
//   ④ 无漏泄 ⇒ 逐字节不变；页图缺失/ffmpeg 失败 ⇒ skipped 计数可见、块不污染（G1 不静默）。
//   ⑤ main() 生产接线：页图在即生效（无布尔旗标，与 consumeGiantCropArtifacts 同风格）。
//   ⑥ 展示层（reconstruct.appendBlockNodes）：leakCoveredBy 尾块不重复画，原文进首块 title。
// 跑法：单元裁图测试用真 PNG（node:zlib 手工编码，零依赖）+ 真 ffmpeg；ffmpeg 不在场则跳过
//   裁图用例（与 pdftoppm 优雅降级同纪律），接线/判据/字节不变用例离线可跑。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  attachMarkdownLeakCrops,
  pngSizeFromHeader,
  type StageBlock,
  type StagePage,
} from "../scripts/export-stages.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/* ── 零依赖真 PNG 编码（签名+IHDR+IDAT+IEND，纯色图；ffmpeg 可裁、IHDR 可测） ── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 真 PNG（8bit 真彩纯色）：裁图测试需要 ffmpeg 真的能解码的页图，IHDR-only 假图不够。 */
function makePng(w: number, h: number, rgb: [number, number, number] = [255, 255, 255]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
const ffmpegSkip = HAS_FFMPEG ? false : "ffmpeg 不在场（裁图用例降级跳过；判据/字节不变用例仍跑）";

function mkPage(blocks: StageBlock[], index = 0): StagePage {
  return {
    index, width: 596, height: 852, columns: 1, centers: [298],
    raw: [], discarded: [], blocks, order: blocks.map((b) => b.i),
    questions: [], uncovered: [], ocrFill: [], ocrFullText: "",
  };
}
const txt = (i: number, bbox: [number, number, number, number], text: string): StageBlock =>
  ({ i, kind: "text", bbox, text });

/** 曲线运动 page index3 实测形态：`![` 开头 + 纯描述中间行 + `](http` 收尾，三块同栏 y 邻接。 */
function leakTrioPage(): StagePage {
  return mkPage([
    txt(0, [32, 60, 300, 74], "教材知识萃取 回归教材，萃精华"),
    txt(1, [40, 100, 500, 110], "![这幅图展示了一个抛物线运动的示意图。图中有一个坐标系，原点为O"),
    txt(2, [40, 116, 500, 126], "。物体在抛物线路径上经过点C，然后到达点P，速度分解为vₓ和vᵧ"),
    txt(3, [40, 132, 500, 142], "，表示vₓ与x轴的夹角。](https://cdn.example.com/imgs/fig-1.jpg)"),
    txt(4, [40, 160, 500, 174], "1. 关于平抛运动，下列说法正确的是"),
  ]);
}

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "qseg-leak-crop-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── ① 聚组 + 裁图 + 挂接（真 ffmpeg） ── */

test("M2：三块漏泄组 ⇒ 首块 coordSource=crop + 并集外扩2pt裁图（IHDR实测），尾块 leakCoveredBy，原文不动", { skip: ffmpegSkip }, () => {
  withTmp((dir) => {
    const pageImage = join(dir, "page-01.png");
    writeFileSync(pageImage, makePng(1000, 1428));
    const pg = leakTrioPage();
    const before = pg.blocks.map((b) => b.text);
    const r = attachMarkdownLeakCrops(pg, dir, pageImage);
    assert.deepEqual(r, { attached: 1, skipped: 0 }, "一个漏泄组挂成功");

    const [head, mid, tail] = [pg.blocks[1]!, pg.blocks[2]!, pg.blocks[3]!];
    assert.equal(head.coordSource, "crop");
    assert.equal(head.crop, join("leak-crops", "p001-g01.png"), "crop 落相对 outDir 子路径");
    assert.ok(existsSync(join(dir, head.crop!)), "裁图文件必须真的在盘上");
    // 尺寸自检：cropSize = 裁图 IHDR 实测（L7），且等于独立换算的期望像素
    // 并集 [40,100,500,142] +2pt → [38,98,502,144]；sx=1000/596, sy=1428/852
    const sx = 1000 / 596;
    const sy = 1428 / 852;
    const wantW = Math.ceil(502 * sx) - Math.floor(38 * sx);
    const wantH = Math.ceil(144 * sy) - Math.floor(98 * sy);
    assert.deepEqual(head.cropSize, [wantW, wantH], "pt→px 按页图宽/页宽pt换算（外扩2pt）");
    assert.deepEqual(
      pngSizeFromHeader(new Uint8Array(readFileSync(join(dir, head.crop!)))),
      head.cropSize,
      "cropSize 必须与裁图文件 IHDR 一致（实测，不信产物数字）",
    );
    // 尾块：不各挂一份裁图（同一并集图挂三块=叠影），标 leakCoveredBy 由首块呈现
    for (const b of [mid, tail]) {
      assert.equal(b.leakCoveredBy, head.i, "组内尾块标 leakCoveredBy=首块 i");
      assert.equal(b.coordSource, undefined);
      assert.equal(b.crop, undefined);
    }
    // 原文一个字不动；非漏泄行不挂任何新字段
    assert.deepEqual(pg.blocks.map((b) => b.text), before, "原文保留在块 text（不丢内容）");
    for (const b of [pg.blocks[0]!, pg.blocks[4]!]) {
      assert.equal(b.coordSource, undefined);
      assert.equal(b.crop, undefined);
      assert.equal(b.leakCoveredBy, undefined);
    }
  });
});

test("M2：单块完整漏泄（自带 ](http）⇒ 自成一组挂自身；孤立 ](http 尾块同样成组", { skip: ffmpegSkip }, () => {
  withTmp((dir) => {
    const pageImage = join(dir, "page-01.png");
    writeFileSync(pageImage, makePng(1000, 1428));
    const pg = mkPage([
      txt(0, [40, 100, 500, 112], "![插图](http://cdn.example.com/a.png)"),
      txt(1, [40, 300, 500, 312], "gs/image3-2-table-0.jpg) 续行尾巴 ](https://cdn.example.com/b.jpg"),
    ]);
    const r = attachMarkdownLeakCrops(pg, dir, pageImage);
    assert.equal(r.attached, 2, "两个互不邻接的漏泄各成一组");
    assert.equal(pg.blocks[0]!.coordSource, "crop");
    assert.equal(pg.blocks[0]!.leakCoveredBy, undefined);
    assert.equal(pg.blocks[1]!.coordSource, "crop");
    assert.equal(pg.blocks[1]!.crop, join("leak-crops", "p001-g02.png"));
  });
});

test("M2：开头块找不到 y 邻接收尾 ⇒ 只裁开头块自身，绝不吞中间正常正文（最严 AND）", { skip: ffmpegSkip }, () => {
  withTmp((dir) => {
    const pageImage = join(dir, "page-01.png");
    writeFileSync(pageImage, makePng(1000, 1428));
    const pg = mkPage([
      txt(0, [40, 100, 500, 110], "![描述开头，没有就近收尾"),
      txt(1, [40, 300, 500, 314], "1. 正常题干行（与开头块不相邻，不得被吞）"),
      txt(2, [40, 320, 500, 334], "远处的收尾 ](https://cdn.example.com/c.jpg"),
    ]);
    const r = attachMarkdownLeakCrops(pg, dir, pageImage);
    assert.equal(r.attached, 2, "开头块自成一组 + 远处收尾块自成一组");
    assert.equal(pg.blocks[0]!.coordSource, "crop");
    assert.equal(pg.blocks[1]!.coordSource, undefined, "正常正文行绝不挂裁图");
    assert.equal(pg.blocks[1]!.leakCoveredBy, undefined, "正常正文行绝不标 leakCoveredBy");
    assert.equal(pg.blocks[2]!.coordSource, "crop");
  });
});

test("M2：跨栏不聚组（x 重叠不足）⇒ 各挂各的，不吞邻栏行", { skip: ffmpegSkip }, () => {
  withTmp((dir) => {
    const pageImage = join(dir, "page-01.png");
    writeFileSync(pageImage, makePng(1000, 1428));
    const pg = mkPage([
      txt(0, [40, 100, 280, 110], "![左栏描述开头"),
      txt(1, [320, 106, 560, 116], "右栏收尾 ](https://cdn.example.com/d.jpg"),
    ]);
    const r = attachMarkdownLeakCrops(pg, dir, pageImage);
    assert.equal(r.attached, 2);
    assert.equal(pg.blocks[0]!.leakCoveredBy, undefined);
    assert.equal(pg.blocks[1]!.leakCoveredBy, undefined, "跨栏块不得被吸收进左栏组");
    assert.equal(pg.blocks[1]!.coordSource, "crop");
  });
});

test("M2：页边漏泄组 ⇒ 裁图夹到页界（不越界、w/h≥1）", { skip: ffmpegSkip }, () => {
  withTmp((dir) => {
    const pageImage = join(dir, "page-01.png");
    writeFileSync(pageImage, makePng(1000, 1428));
    const pg = mkPage([txt(0, [0, 0, 596, 20], "![贴边图](http://cdn.example.com/e.png)")]);
    const r = attachMarkdownLeakCrops(pg, dir, pageImage);
    assert.equal(r.attached, 1);
    const [w, h] = pg.blocks[0]!.cropSize!;
    assert.ok(w <= 1000 && h <= 1428 && w >= 1 && h >= 1, "裁图不得越出页图");
    assert.deepEqual(pngSizeFromHeader(new Uint8Array(readFileSync(join(dir, pg.blocks[0]!.crop!)))), [w, h]);
  });
});

/* ── ② 不静默 / 字节不变（离线可跑，不依赖 ffmpeg） ── */

test("M2：无漏泄行 ⇒ {0,0} 且页面对象逐字节不变（不产裁图目录）", () => {
  withTmp((dir) => {
    const pg = mkPage([
      txt(0, [40, 100, 500, 112], "1. 正常题干"),
      txt(1, [40, 130, 500, 142], "A. 正常选项"),
    ]);
    const before = JSON.stringify(pg);
    const r = attachMarkdownLeakCrops(pg, dir, join(dir, "page-01.png"));
    assert.deepEqual(r, { attached: 0, skipped: 0 });
    assert.equal(JSON.stringify(pg), before, "无漏泄 ⇒ 一个字节都不改");
    assert.equal(existsSync(join(dir, "leak-crops")), false, "无漏泄不产裁图目录");
  });
});

test("M2：页图缺失 ⇒ 漏泄组计 skipped、块不污染（不静默失败 G1）", () => {
  withTmp((dir) => {
    const pg = leakTrioPage();
    const before = JSON.stringify(pg.blocks);
    const r = attachMarkdownLeakCrops(pg, dir, join(dir, "不存在.png"));
    assert.equal(r.attached, 0);
    assert.equal(r.skipped, 1, "一个漏泄组因页图缺失被跳过，计数可见");
    assert.equal(JSON.stringify(pg.blocks), before);
  });
});

test("M2：kind=table 的 markdown 漏泄不在本步处理（M3 范围），text 判据不误伤图片块", () => {
  withTmp((dir) => {
    const pg = mkPage([
      { i: 0, kind: "table", bbox: [40, 100, 500, 300], text: "![表内图](http://cdn.example.com/t.jpg)", html: "<table></table>" },
      { i: 1, kind: "image", bbox: [40, 320, 200, 400], text: "![图片](http://cdn.example.com/i.jpg)", img: "x.png" },
    ]);
    const before = JSON.stringify(pg.blocks);
    const r = attachMarkdownLeakCrops(pg, dir, join(dir, "不存在.png"));
    assert.deepEqual(r, { attached: 0, skipped: 0 }, "非 text 块不是本步的漏泄行");
    assert.equal(JSON.stringify(pg.blocks), before);
  });
});

/* ── ③ main() 生产接线（真 spawn，页图在即生效，无布尔旗标） ── */

const DOC_ID = "bgx-markdown-leak-crop-test";
function para(type: string, bbox: [number, number, number, number], lines: string[]) {
  return {
    type,
    bbox,
    lines: lines.map((content, i) => ({
      bbox: [bbox[0], bbox[1] + i * 20, bbox[2], bbox[1] + i * 20 + 16] as [number, number, number, number],
      font_size: 10.5,
      spans: [{ content, font_size: 10.5 }],
    })),
  };
}
const LEAK_LAYOUT = {
  pdf_info: [
    {
      page_idx: 0, page_size: [596, 852],
      para_blocks: [
        para("text", [32, 60, 300, 76], ["第四章 曲线运动"]),
        para("text", [40, 100, 500, 116], ["![抛物线示意图，坐标系原点O，初速度v₀与x轴成α角"]),
        para("text", [40, 122, 500, 138], ["。物体经过C点到达P点，速度分解为vₓ和vᵧ"]),
        para("text", [40, 144, 500, 160], ["，θ为vₓ与x轴夹角。](https://cdn.example.com/imgs/fig-1.jpg)"]),
        para("text", [40, 200, 500, 216], ["1. 关于曲线运动，下列说法正确的是"]),
      ],
    },
    {
      page_idx: 1, page_size: [596, 852],
      para_blocks: [para("text", [32, 60, 500, 76], ["2. 无漏泄的正常页"])],
    },
  ],
};

test("M2 接线：export-stages 页图在即生效 ⇒ 漏泄组挂裁图、无漏泄页不产新字段", { skip: ffmpegSkip, timeout: 120_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "bgx-leak-crop-"));
  const layoutPath = join(base, "layout.json");
  writeFileSync(layoutPath, JSON.stringify(LEAK_LAYOUT));
  const outDir = join(ROOT, "data", "out", DOC_ID);
  try {
    // 预置页图（无 origin PDF ⇒ main 不渲染页图，预置件即「产物在即生效」的产物）
    mkdirSync(join(outDir, "pages"), { recursive: true });
    writeFileSync(join(outDir, "pages", "page-01.png"), makePng(1000, 1428));
    writeFileSync(join(outDir, "pages", "page-02.png"), makePng(1000, 1428));
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/export-stages.ts", DOC_ID, layoutPath],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
    );
    assert.equal(r.status, 0, `导出应成功退出 0；stderr=${r.stderr}`);
    const snap = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as {
      pages: { blocks: StageBlock[] }[];
    };
    const p0 = snap.pages[0]!;
    const heads = p0.blocks.filter((b) => b.coordSource === "crop");
    assert.equal(heads.length, 1, "三块漏泄组 ⇒ 恰一个首块挂裁图（不叠影）");
    const head = heads[0]!;
    assert.ok(head.text.startsWith("!["), "首块原文保留");
    assert.ok(head.crop && existsSync(join(outDir, head.crop)), "裁图文件在盘上");
    assert.deepEqual(
      pngSizeFromHeader(new Uint8Array(readFileSync(join(outDir, head.crop)))),
      head.cropSize,
      "cropSize=IHDR 实测",
    );
    const covered = p0.blocks.filter((b) => b.leakCoveredBy === head.i);
    assert.equal(covered.length, 2, "两个尾块标 leakCoveredBy");
    assert.ok(covered.some((b) => b.text.includes("](http")), "收尾块原文保留");
    assert.ok(p0.blocks.some((b) => b.text === "1. 关于曲线运动，下列说法正确的是" && !b.coordSource && b.leakCoveredBy === undefined), "正常题干行不受影响");
    // 无漏泄页：不产任何新字段（逐字节兼容纪律）
    const p1json = JSON.stringify(snap.pages[1]);
    for (const key of ["coordSource", "crop", "cropSize", "leakCoveredBy"]) {
      assert.ok(!p1json.includes(`"${key}"`), `无漏泄页不应含新字段 ${key}`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

/* ── ④ 展示层消费（reconstruct.appendBlockNodes）：尾块不重复画、原文进首块 title ── */

interface Stub {
  tagName: string;
  children: Stub[];
  parent: Stub | null;
  style: Record<string, string> & { cssText?: string };
  className: string;
  textContent: string;
  title: string;
  src?: string;
  alt?: string;
  dataset: Record<string, string>;
  classList: { add: (c: string) => void; contains: (c: string) => boolean };
  append: (...n: Stub[]) => void;
  remove: () => void;
  addEventListener: (t: string, fn: (e: unknown) => void) => void;
  querySelector: (sel: string) => Stub | null;
  querySelectorAll: (sel: string) => Stub[];
}
function makeNode(tagName: string): Stub {
  const n: Stub = {
    tagName, children: [], parent: null, style: {}, className: "", textContent: "", title: "",
    dataset: {},
    classList: {
      add: (c: string) => { if (!n.className.split(" ").includes(c)) n.className = `${n.className} ${c}`.trim(); },
      contains: (c: string) => n.className.split(" ").includes(c),
    },
    append: (...kids: Stub[]) => { for (const k of kids) { k.parent = n; n.children.push(k); } },
    remove: () => { if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n); n.parent = null; },
    addEventListener: () => {},
    querySelector: (sel: string) => n.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel: string) => {
      const out: Stub[] = [];
      const matches = (x: Stub) => sel.startsWith(".") ? x.classList.contains(sel.slice(1)) : x.tagName === sel;
      const walk = (x: Stub) => { for (const c of x.children) { if (matches(c)) out.push(c); walk(c); } };
      walk(n);
      return out;
    },
  };
  return n;
}
const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  createElement: (t: string) => makeNode(t),
  createTextNode: (t: string) => Object.assign(makeNode("#text"), { textContent: t }),
  body: makeNode("body"),
  addEventListener: () => {},
  removeEventListener: () => {},
};
g.requestAnimationFrame = (fn: () => void) => { fn(); return 0; };
const { appendBlockNodes } = await import("../stages/reconstruct.js");

test("M2 展示层：leakCoveredBy 尾块不画（首块并集裁图呈现），三块原文都留 title", () => {
  const head = {
    i: 0, kind: "text", bbox: [40, 100, 500, 110], text: "![描述开头",
    coordSource: "crop", crop: "leak-crops/p001-g01.png", cropSize: [780, 78],
  };
  const mid = { i: 1, kind: "text", bbox: [40, 116, 500, 126], text: "中间描述行", leakCoveredBy: 0 };
  const tail = { i: 2, kind: "text", bbox: [40, 132, 500, 142], text: "收尾 ](https://cdn.example.com/f.jpg)", leakCoveredBy: 0 };
  const p = { index: 0, width: 596, height: 852, columns: 1, questions: [], blocks: [head, mid, tail] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p as never, 350, 12, null, "doc", true) as (Stub | null)[];
  assert.ok(nodes[0], "首块裁图必须画出来");
  assert.equal(nodes[1], null, "尾块不重复画（同一并集图再画=叠影）");
  assert.equal(nodes[2], null, "尾块不重复画");
  const imgs = nodes[0]!.querySelectorAll("img");
  assert.equal(imgs.length, 1, "一组恰一张图（单印）");
  assert.equal(imgs[0]!.src, "/data/out/doc/leak-crops/p001-g01.png");
  for (const t of ["![描述开头", "中间描述行", "收尾 ](https://cdn.example.com/f.jpg)"]) {
    assert.ok(nodes[0]!.title.includes(t), `原文必须留 title（不丢内容）：${t}`);
  }
});

test("M2 展示层：无 leakCoveredBy 的旧快照路径不变（巨带回退行照常各画各的）", () => {
  const a = { i: 0, kind: "text", bbox: [40, 100, 500, 112], text: "巨带回退行甲", coordSource: "crop", crop: "giant-crop/crops/a.png", cropSize: [290, 22] };
  const b = { i: 1, kind: "text", bbox: [40, 130, 500, 142], text: "巨带回退行乙", coordSource: "crop", crop: "giant-crop/crops/b.png", cropSize: [290, 22] };
  const p = { index: 0, width: 596, height: 852, columns: 1, questions: [], blocks: [a, b] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p as never, 350, 12, null, "doc", true) as (Stub | null)[];
  assert.ok(nodes[0] && nodes[1], "无 leakCoveredBy ⇒ 每块各画各的裁图（现状路径）");
  assert.ok(!nodes[0]!.title.includes("中间描述行"));
});