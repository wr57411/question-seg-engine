// 逻辑块裁图器：按 questions.json 的 source.blockIndexes 合并同题块。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { normalizeLayout } from "../../../src/normalize.js";

type BBox = [number, number, number, number];
const OUT = "tmp/minicpm-round3/logical-blocks.json";
const books = readdirSync("corrections").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const all: any[] = [];

function imagePath(book: string, pageIndex: number): string {
  for (const w of [2, 3]) {
    const p = `data/out/${book}/pages/page-${String(pageIndex + 1).padStart(w, "0")}.png`;
    if (existsSync(p)) return p;
  }
  return "";
}
function union(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function area(b: BBox): number { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }

for (const book of books) {
  const qPath = `data/out/${book}/questions.json`;
  const lPath = `data/out/${book}/layout.json`;
  if (!existsSync(qPath) || !existsSync(lPath)) { console.error("skip", book); continue; }
  const qs = JSON.parse(readFileSync(qPath, "utf8"));
  const layout = JSON.parse(readFileSync(lPath, "utf8"));
  const doc = normalizeLayout(layout, book);
  // blockIndexes 是全书全局序号：按页序拍平
  const global: { block: any; pageIndex: number }[] = [];
  for (const p of doc.pages) for (const b of p.blocks) global.push({ block: b, pageIndex: p.index });
  for (const q of qs) {
    const pageIndex = q.source?.pageIndex;
    const within = q.source?.blockIndexes ?? [];
    if (!Number.isInteger(pageIndex) || within.length === 0) continue;
    const page = doc.pages[pageIndex];
    if (!page) continue;
    const mapped = within.map((i: number) => global[i]).filter(Boolean) as { block: any; pageIndex: number }[];
    // 裁图只用本题起始页的块；跨页续块只进文本，不进裁图
    const blocks = mapped.filter((x) => x.pageIndex === pageIndex).map((x) => x.block);
    if (!blocks.length) continue;
    let box: BBox | null = null;
    let textBox: BBox | null = null;
    const textParts: string[] = [];
    let images = 0, tables = 0;
    for (const x of mapped) {
      const b = x.block;
      if (x.pageIndex === pageIndex) {
        if (!box) box = b.bbox; else box = union(box, b.bbox);
        if (b.kind === "text") {
          if (!textBox) textBox = b.bbox; else textBox = union(textBox, b.bbox);
        }
      }
      if (b.kind === "text") textParts.push(b.text);
      if (b.kind === "image") images++;
      if (b.kind === "table") tables++;
    }
    if (!box) continue;
    const img = imagePath(book, pageIndex);
    if (!img) continue;
    const qaText = [q.stem ?? "", ...(q.options ?? []).map((o: any) => `${o.key}. ${o.text}`)].join("\n");
    all.push({
      id: q.id, book, pageIndex, number: q.number, type: q.type, status: q.status, confidence: q.confidence,
      pageWidth: page.width, pageHeight: page.height, imagePath: img,
      bbox: box, textBbox: textBox, blockText: textParts.join("\n"), qaText,
      blockCount: mapped.length, pageBlockCount: blocks.length, images, tables,
      blockItems: mapped.map((x) => ({ text: x.block.text ?? "", bbox: x.block.bbox, kind: x.block.kind, pageIndex: x.pageIndex })),
      blocks: within,
    });
  }
  console.error(book, "questions", qs.length);
}
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), books, blocks: all }, null, 2));
console.error("wrote", OUT, "blocks", all.length);
