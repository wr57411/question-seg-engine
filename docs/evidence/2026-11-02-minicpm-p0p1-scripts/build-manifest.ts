// P0/P1 取样清单：用引擎的 normalizeLayout 还原页内行级块，
// 为每个候选生成裁图框（layout 坐标）和正确文本。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { normalizeLayout } from "../../../src/normalize.js";

type BBox = [number, number, number, number];
type Cand = {
  id: string;
  book: string;
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  imagePath: string;
  category: "text" | "formula" | "table";
  text: string;
  bbox: BBox;
  questionId?: string;
  blockIndex?: number;
  source: string;
};

const BOOKS = [
  "23必刷题 1 直线运动",
  "23必刷题 4 曲线运动",
  "物理_教材基础练 电路",
  "物理_教材基础练机械能守恒定律",
  "教材基础练 磁场",
];
const OUT = "tmp/minicpm-p0p1/manifest.json";

const caps = { line: 24, long: 8, formula: 10, table: 4 };

function imagePath(book: string, pageIndex: number): string {
  const dir = `data/out/${book}/pages`;
  for (const width of [2, 3]) {
    const p = `${dir}/page-${String(pageIndex + 1).padStart(width, "0")}.png`;
    if (existsSync(p)) return p;
  }
  return "";
}
function isImage(b: any): boolean { return b?.kind === "image"; }
function union(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function area(b: BBox): number { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
function overlap(a: BBox, b: BBox): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return w * h;
}
function intersectsImage(box: BBox, images: BBox[]): boolean {
  return images.some((im) => overlap(box, im) > area(box) * 0.15);
}
function hasFormula(t: string): boolean { return /\$[^$]+\$|\\frac|\\sqrt|\^|_\{/.test(t); }
function clean(t: string): string { return t.replace(/\s+/g, " ").trim(); }

const all: Cand[] = [];
const pageStats: any[] = [];

for (const book of BOOKS) {
  const qs = JSON.parse(readFileSync(`data/out/${book}/questions.json`, "utf8"));
  const layout = JSON.parse(readFileSync(`data/out/${book}/layout.json`, "utf8"));
  const doc = normalizeLayout(layout, book);
  const perBook = { line: 0, long: 0, formula: 0, table: 0 };

  // 页面级统计（给 P1 分层选页）
  for (const page of doc.pages) {
    const rawPage = layout.pdf_info?.[page.index];
    let formulaSpans = 0;
    for (const pb of rawPage?.para_blocks ?? []) {
      for (const line of pb.lines ?? []) {
        for (const span of line.spans ?? []) {
          const t = String(span.type ?? "");
          if ((t === "inline_equation" || t === "equation_inline") && String(span.content ?? "").trim()) formulaSpans++;
        }
      }
    }
    pageStats.push({
      book, pageIndex: page.index, width: page.width, height: page.height,
      textLines: page.blocks.filter((b: any) => b.kind === "text").length,
      tables: page.blocks.filter((b: any) => b.kind === "table").length,
      images: page.blocks.filter((b: any) => b.kind === "image").length,
      formulaSpans,
    });
  }

  for (const q of qs) {
    if (q.status !== "ok" || (q.confidence ?? 0) < 0.9) continue;
    const pageIndex = q.source?.pageIndex;
    const within = q.source?.blockIndexes ?? [];
    if (!Number.isInteger(pageIndex) || within.length === 0) continue;
    const page = doc.pages[pageIndex];
    if (!page) continue;
    const imgPath = imagePath(book, pageIndex);
    if (!imgPath) continue;
    const blocks = within.map((i: number) => page.blocks[i]).filter(Boolean);
    const images = page.blocks.filter(isImage).map((b: any) => b.bbox as BBox);
    const textBlocks = blocks.filter((b: any) => b.kind === "text" && clean(b.text).length >= 6);

    // 短行：每行一个候选
    for (let k = 0; k < textBlocks.length && perBook.line < caps.line; k++) {
      const b: any = textBlocks[k];
      const t = clean(b.text);
      if (t.length < 6 || t.length > 90) continue;
      if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) continue;
      const bbox = b.bbox as BBox;
      if (area(bbox) <= 0 || intersectsImage(bbox, images)) continue;
      all.push({
        id: `${book}:p${pageIndex}:l${k}:${q.id.split(":").pop()}`,
        book, pageIndex, pageWidth: page.width, pageHeight: page.height, imagePath: imgPath,
        category: "text", text: t, bbox, questionId: q.id, source: `line block ${within[k]}`,
      });
      perBook.line++;
    }

    // 长块：连续 3–6 个文本行拼成一段（长度 60–320）
    if (perBook.long < caps.long && textBlocks.length >= 3) {
      for (let start = 0; start < textBlocks.length && perBook.long < caps.long; start += 2) {
        for (let n = Math.min(6, textBlocks.length - start); n >= 3; n--) {
          const group = textBlocks.slice(start, start + n);
          const t = clean(group.map((b: any) => b.text).join("\n"));
          if (t.length < 60 || t.length > 320) continue;
          let box = group[0].bbox as BBox;
          for (const b of group.slice(1)) box = union(box, b.bbox as BBox);
          if (area(box) <= 0 || intersectsImage(box, images)) continue;
          all.push({
            id: `${book}:p${pageIndex}:long${start}_${n}`,
            book, pageIndex, pageWidth: page.width, pageHeight: page.height, imagePath: imgPath,
            category: "text", text: t, bbox: box, questionId: q.id, source: `lines ${n}`,
          });
          perBook.long++;
          break;
        }
      }
    }

    // 公式 span：取落在本题块范围内的 inline equation
    if (perBook.formula < caps.formula) {
      const qBoxes = blocks.map((b: any) => b.bbox as BBox);
      const rawPage = layout.pdf_info?.[pageIndex];
      for (const pb of rawPage?.para_blocks ?? []) {
        for (const line of pb.lines ?? []) {
          for (const span of line.spans ?? []) {
            const typ = String(span.type ?? "");
            if (typ !== "inline_equation" && typ !== "equation_inline") continue;
            const tex = String(span.content ?? "").trim();
            if (!tex || tex.length < 2) continue;
            const box = span.bbox as BBox;
            if (!Array.isArray(box) || box.length !== 4) continue;
            if (!qBoxes.some((qb) => overlap(box, qb) > area(box) * 0.5)) continue;
            if (area(box) <= 4) continue;
            all.push({
              id: `${book}:p${pageIndex}:f${perBook.formula}`,
              book, pageIndex, pageWidth: page.width, pageHeight: page.height, imagePath: imgPath,
              category: "formula", text: tex, bbox: box, questionId: q.id, source: "inline_equation span",
            });
            perBook.formula++;
            if (perBook.formula >= caps.formula) break;
          }
          if (perBook.formula >= caps.formula) break;
        }
        if (perBook.formula >= caps.formula) break;
      }
    }
  }

  // 表格：按页取，不去重；只取有 HTML 的
  for (const page of doc.pages) {
    if (perBook.table >= caps.table) break;
    const imgPath = imagePath(book, page.index);
    if (!imgPath) continue;
    for (const b of page.blocks as any[]) {
      if (perBook.table >= caps.table) break;
      if (b.kind !== "table" || !b.html) continue;
      all.push({
        id: `${book}:p${page.index}:t${perBook.table}`,
        book, pageIndex: page.index, pageWidth: page.width, pageHeight: page.height, imagePath: imgPath,
        category: "table", text: b.html, bbox: b.bbox, source: "table block",
      });
      perBook.table++;
    }
  }
  console.error(book, perBook);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), books: BOOKS, candidates: all, pageStats }, null, 2));
console.error("wrote", OUT, "candidates", all.length);
