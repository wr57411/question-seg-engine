// scripts/export-stages.ts
/**
 * 阶段样品展示快照导出（唯一允许 import 引擎 src/ 的展示层上游）。
 * 跑一遍真实管线（normalizeLayout → layoutPage → segmentFromLayout），
 * 把各阶段中间产物收进 data/out/<docId>/stages.json，
 * 供 stages/ 前端（不 import 引擎代码）做可视化展示。
 *
 * 运行：npm run stages:export [-- <docId> <layoutPath>]
 * 默认：docId = 23必刷题 2相互作用，layout = data/smoke/unpacked/layout.json
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { segmentFromLayout } from "../src/index.js";
import { normalizeLayout } from "../src/normalize.js";
import { detectColumnCenters, detectColumns, layoutPage } from "../src/layout.js";
import type { BBox, IndexedBlock, ParsedDocument, SegmentationResult } from "../src/types.js";

/** 阶段 1：MinerU 原始段级块（保留 MinerU 自身 type，只截断文本） */
export interface RawStageBlock {
  i: number;
  type: string;
  bbox: BBox;
  text: string;
}

/** 阶段 2/3：归一化后的行级块（引擎实际处理粒度） */
export interface StageBlock {
  i: number;
  kind: string;
  bbox: BBox;
  text: string;
  /** 图片块的裸文件名（拼 images/ 前缀由展示层负责） */
  img?: string;
}

export interface StageQuestion {
  id: string;
  number: string;
  section: string;
  type: string;
  blocks: number[];
  confidence: number;
  status: string;
  reasons: string[];
}

export interface StagePage {
  index: number;
  width: number;
  height: number;
  columns: number;
  centers: number[];
  raw: RawStageBlock[];
  blocks: StageBlock[];
  /** 阅读顺序的块 i 序列（数组下标即顺序号） */
  order: number[];
  questions: StageQuestion[];
}

export interface StageSnapshot {
  version: number;
  docId: string;
  generatedAt: string;
  stats: SegmentationResult["stats"];
  /** 答案区条目总数（0 表示本卷无答案区，展示层据此换文案） */
  answerEntriesTotal: number;
  /** 原卷逐页图数量（data/out/<docId>/pages/page-NN.png；0 = 未渲染，展示层降级为 PDF 内嵌） */
  originPages: number;
  pages: StagePage[];
  reviews: SegmentationResult["reviews"];
}

const RAW_TEXT_LIMIT = 80;
const BLOCK_TEXT_LIMIT = 120;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** layout.json 的 para_blocks → 阶段 1 段级块（type 原样保留，文本取 spans 拼接） */
export function extractRawBlocks(layoutRaw: unknown): RawStageBlock[][] {
  const root = (layoutRaw ?? {}) as Record<string, unknown>;
  const pages = Array.isArray(root.pdf_info) ? root.pdf_info : [];
  return pages.map((entry) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const paras = Array.isArray(rec.para_blocks) ? rec.para_blocks : [];
    return paras.map((pbRaw, i) => {
      const pb = (pbRaw ?? {}) as Record<string, unknown>;
      let text = "";
      const lines = Array.isArray(pb.lines) ? pb.lines : [];
      for (const lineRaw of lines) {
        const line = (lineRaw ?? {}) as Record<string, unknown>;
        const spans = Array.isArray(line.spans) ? line.spans : [];
        for (const spanRaw of spans) {
          const span = (spanRaw ?? {}) as Record<string, unknown>;
          text += String(span.content ?? "");
        }
      }
      const bbox = Array.isArray(pb.bbox) ? (pb.bbox as BBox) : ([0, 0, 0, 0] as BBox);
      return { i, type: String(pb.type ?? "text"), bbox, text: clip(text.trim(), RAW_TEXT_LIMIT) };
    });
  });
}

/**
 * 纯函数：引擎产物 → 展示快照。
 * rawPages 与 doc.pages 一一对应（extractRawBlocks 的输出）。
 *
 * 关键口径（两处）：
 * 1. segmentWithRules 会把 IndexedBlock.index 重写为跨页全局序号，
 *    Question.source.blockIndexes 存的是全局序号；此处按阅读顺序重建
 *    「全局序号 → 页内块序号」映射，展示层拿到的一律是页内序号。
 * 2. 题目可能跨页（起始页之后延续到下一页），故按「块的落页」分组：
 *    一道题在其块所在的每一页各出一条（blocks 为该页内的块序号），
 *    展示层在每页都能看到这道题的这一部分。
 */
export function buildStageSnapshot(
  doc: ParsedDocument,
  result: SegmentationResult,
  rawPages: RawStageBlock[][],
): StageSnapshot {
  const sortedPages = [...doc.pages].sort((a, b) => a.index - b.index);
  const pageLayouts = sortedPages.map((page) => ({ page, layout: layoutPage(page) }));
  let globalIndex = 0;
  const globalToPage = new Map<number, { page: number; block: number }>();
  for (const { page, layout } of pageLayouts) {
    for (const entry of layout.ordered) {
      globalToPage.set(globalIndex++, { page: page.index, block: entry.index });
    }
  }

  const questionsByPage = new Map<number, StageQuestion[]>();
  for (const q of result.questions) {
    const perPageBlocks = new Map<number, number[]>();
    for (const gi of q.source.blockIndexes) {
      const m = globalToPage.get(gi);
      if (!m) continue;
      const arr = perPageBlocks.get(m.page) ?? [];
      arr.push(m.block);
      perPageBlocks.set(m.page, arr);
    }
    const reasons = result.reviews.filter((r) => r.questionId === q.id).map((r) => r.reason);
    for (const [pageIndex, blocks] of perPageBlocks) {
      const arr = questionsByPage.get(pageIndex) ?? [];
      arr.push({
        id: q.id,
        number: q.number,
        section: q.section,
        type: q.type,
        blocks,
        confidence: q.confidence,
        status: q.status,
        reasons,
      });
      questionsByPage.set(pageIndex, arr);
    }
  }

  const pages: StagePage[] = pageLayouts.map(({ page, layout }, p) => {
    const entries: IndexedBlock[] = page.blocks.map((block, index) => ({
      index,
      pageIndex: page.index,
      block,
    }));
    return {
      index: page.index,
      width: page.width,
      height: page.height,
      columns: detectColumns(entries, page.width),
      centers: detectColumnCenters(entries, page.width).map((c) => Math.round(c)),
      raw: rawPages[p] ?? [],
      blocks: page.blocks.map((b, i) => ({
        i,
        kind: b.kind,
        bbox: b.bbox,
        text: clip(b.kind === "image" ? "[图片]" : b.kind === "formula" ? b.latex : b.text, BLOCK_TEXT_LIMIT),
        ...(b.kind === "image" ? { img: b.path } : {}),
      })),
      order: layout.ordered.map((e) => e.index),
      questions: questionsByPage.get(page.index) ?? [],
    };
  });
  return {
    version: 1,
    docId: result.docId,
    generatedAt: new Date().toISOString(),
    stats: result.stats,
    answerEntriesTotal: result.answerEntries.length,
    originPages: 0,
    pages,
    reviews: result.reviews,
  };
}

function main(): void {
  const docId = process.argv[2] ?? "23必刷题 2相互作用";
  const layoutPath = process.argv[3] ?? join("data", "smoke", "unpacked", "layout.json");
  const raw = JSON.parse(readFileSync(layoutPath, "utf8"));

  const doc = normalizeLayout(raw, docId);
  const result = segmentFromLayout(raw, docId);
  const snapshot = buildStageSnapshot(doc, result, extractRawBlocks(raw));

  const outDir = join("data", "out", docId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "stages.json"), JSON.stringify(snapshot, null, 1));

  // 原卷 PDF 一并复制到 data/out/<docId>/，供展示层「原卷对照」内嵌浏览；
  // 本机有 pdftoppm（poppler）时再渲染逐页 PNG（任何浏览器可靠显示，缺工具则跳过降级 PDF）。
  const unpackedDir = join(layoutPath, "..");
  const originPdf = readdirSync(unpackedDir).find((f) => f.endsWith("_origin.pdf"));
  let originPages = 0;
  if (originPdf) {
    const pdfPath = join(outDir, "origin.pdf");
    copyFileSync(join(unpackedDir, originPdf), pdfPath);
    try {
      const pagesDir = join(outDir, "pages");
      mkdirSync(pagesDir, { recursive: true });
      execFileSync("pdftoppm", ["-png", "-r", "120", pdfPath, join(pagesDir, "page")], {
        timeout: 120_000,
      });
      originPages = readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length;
    } catch {
      console.log("  pdftoppm 不可用或渲染失败，原卷对照降级为 PDF 内嵌");
    }
  }

  const totalBlocks = snapshot.pages.reduce((a, p) => a + p.blocks.length, 0);
  const flagged = result.questions.filter((q) => q.status === "needs_review").length;
  snapshot.originPages = originPages;
  writeFileSync(join(outDir, "stages.json"), JSON.stringify(snapshot, null, 1));
  console.log(`阶段快照已写入 ${join(outDir, "stages.json")}`);
  if (originPdf) console.log(`原卷 PDF 已复制 ${join(outDir, "origin.pdf")}`);
  if (originPages > 0) console.log(`原卷页图 ${originPages} 张 → ${join(outDir, "pages")}`);
  console.log(
    `  ${snapshot.pages.length} 页 · ${totalBlocks} 行级块 · ${result.questions.length} 题 · ` +
      `质检诊断 ${result.reviews.length} 条（需人工校对 ${flagged} 题）`,
  );
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
