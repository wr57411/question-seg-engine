/**
 * normalize.ts —— MinerU content_list.json → 内部 ParsedDocument（正式件）
 *
 * 与上游的唯一耦合点：MinerU v4 返回 Zip 中的 *_content_list.json。
 * 结构参考官方文档：{ pdf_info: [{ page_idx, page_size, blocks }], images, formulas }。
 * 所有字段都做容错（缺省给安全默认值），字段名若有出入只改本文件。
 */
import type { BBox, BlockKind, PageInfo, ParsedBlock, ParsedDocument } from "./types.js";

/** 归一化入口：可直接传 fs.readFileSync 解析出的任意 JSON */
export function normalizeContentList(raw: unknown, docId: string): ParsedDocument {
  const root = asRecord(raw);
  const pdfInfo = asArray(root.pdf_info as unknown);
  const pages: PageInfo[] = pdfInfo.map((entry, idx) => normalizePage(entry, idx));

  // MinerU 部分版本将图片/公式单独置于顶层 images/formulas 数组，
  // 此处按 bbox 就近重新挂回页面，保证版面层只面对「页面块序列」。
  attachTopLevelAssets(root, pages);

  if (pages.length === 0) {
    pages.push({ index: 0, width: 0, height: 0, blocks: [] });
  }
  return { docId, pages };
}

function attachTopLevelAssets(root: Record<string, unknown>, pages: PageInfo[]): void {
  for (const kind of ["images", "formulas"] as const) {
    for (const item of asArray(root[kind] as unknown)) {
      const rec = asRecord(item);
      const pageIndex = asInt(rec.page_idx) ?? 0;
      const page = pages[pageIndex];
      if (!page) continue; // 页码越界的孤立资源：跳过而非崩溃
      if (kind === "images") {
        page.blocks.push({
          kind: "image",
          bbox: toBBox(rec.bbox),
          path: String(rec.path ?? "unknown.png"),
        });
      } else {
        page.blocks.push({
          kind: "formula",
          bbox: toBBox(rec.bbox),
          latex: String(rec.latex ?? rec.content ?? rec.formula ?? ""),
        });
      }
    }
  }
}

function normalizePage(rawEntry: unknown, fallbackIdx: number): PageInfo {
  const rec = asRecord(rawEntry);
  const size = asArray(rec.page_size as unknown);
  return {
    index: asInt(rec.page_idx) ?? fallbackIdx,
    width: asNumber(size?.[0]) ?? 0,
    height: asNumber(size?.[1]) ?? 0,
    blocks: asArray(rec.blocks as unknown).flatMap((b) => normalizeBlock(b)),
  };
}

function normalizeBlock(rawBlock: unknown): ParsedBlock[] {
  const rec = asRecord(rawBlock);
  const kind = (rec.type as BlockKind) ?? "text";
  const bbox = toBBox(rec.bbox);

  if (kind === "image") {
    return [{ kind: "image", bbox, path: String(rec.path ?? "image.png") }];
  }
  if (kind === "formula") {
    return [{ kind: "formula", bbox, latex: String(rec.latex ?? rec.content ?? "") }];
  }

  // text / table：拼接 lines → spans，公式 span 内联为 $...$
  const lines = asArray(rec.lines as unknown);
  const parts: string[] = [];
  let maxFontSize = 0;
  let lineCount = 0;
  for (const lineRaw of lines) {
    const line = asRecord(lineRaw);
    if (typeof line.text === "string" && line.text.length > 0) {
      parts.push(line.text);
      lineCount += 1;
      maxFontSize = Math.max(maxFontSize, asNumber(line.font_size) ?? 0);
      continue;
    }
    // spans 形态（新版多以 spans 返回）
    const spans = asArray(line.spans as unknown);
    if (spans.length === 0) continue;
    const lineParts: string[] = [];
    for (const spanRaw of spans) {
      const span = asRecord(spanRaw);
      const content = String(span.content ?? span.text ?? "");
      if (!content) continue;
      const spanType = String(span.type ?? "text");
      if (spanType === "formula") {
        lineParts.push(`$${content.trim()}$`);
      } else {
        lineParts.push(content);
      }
      maxFontSize = Math.max(maxFontSize, asNumber(span.font_size) ?? 0);
    }
    if (lineParts.length > 0) {
      parts.push(lineParts.join(""));
      lineCount += 1;
    }
  }

  const text = parts.join("\n");
  return [
    {
      kind,
      bbox,
      text,
      firstLine: parts[0] ?? "",
      lineCount: Math.max(lineCount, 1),
      maxFontSize,
    },
  ];
}

function toBBox(v: unknown): BBox {
  const arr = asArray(v);
  if (arr.length < 4) return [0, 0, 0, 0];
  return [asNumber(arr[0]) ?? 0, asNumber(arr[1]) ?? 0, asNumber(arr[2]) ?? 0, asNumber(arr[3]) ?? 0];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  const n = asNumber(v);
  return n === undefined ? undefined : Math.trunc(n);
}