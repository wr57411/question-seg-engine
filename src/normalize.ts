/**
 * normalize.ts —— MinerU content_list.json → 内部 ParsedDocument（正式件）
 *
 * 与上游的唯一耦合点：MinerU v4 返回 Zip 中的 *_content_list.json。
 * 结构参考官方文档：{ pdf_info: [{ page_idx, page_size, blocks }], images, formulas }。
 * 所有字段都做容错（缺省给安全默认值），字段名若有出入只改本文件。
 */
import type { BBox, BlockKind, PageInfo, ParsedBlock, ParsedDocument } from "./types.js";

/** 归一化入口：可直接传 fs.readFileSync 解析出的任意 JSON。
 * 兼容两种真实结构：
 * - 顶层数组 → v1 扁平块列表（实测 data/smoke/content_list.json，2026-08-18）；
 * - 顶层对象含 pdf_info → 旧版层级结构（官方旧文档，含 page_size/blocks）。 */
export function normalizeContentList(raw: unknown, docId: string): ParsedDocument {
  if (Array.isArray(raw)) return normalizeV1Flat(raw, docId);
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

/**
 * v1 扁平结构（2026-08-18 真实样张实测，见 docs/real-api-notes.md §4.1）：
 * 顶层数组 = 各页块平铺，每条 `{ type, text?, text_level?, bbox, page_idx }`，
 * 无 page_size / lines / font_size。按 page_idx 分组回页。
 *
 * 元素映射：
 * - text → 文本块（text 直接是元素级字段，非 lines/spans；firstLine 取首个 \n 段）
 * - image / chart → 图片块（路径字段是 `img_path`，非 `path`）
 * - equation → 公式块（LaTeX 在 `text`，以 $$...$$ 包裹，解包后存入 latex）
 * - header / footer / page_number / aside_text → 版面家具，丢弃：
 *   非试题内容，且会污染阅读顺序（aside_text 位于侧边，y 序会插入正文流中间）
 *   或干扰状态机（footer 文本可能误触答案区/选项判定）。
 * - 未知类型容错为文本块。
 */
function normalizeV1Flat(raw: unknown[], docId: string): ParsedDocument {
  const byPage = new Map<number, Record<string, unknown>[]>();
  for (const item of raw) {
    const rec = asRecord(item);
    const pageIdx = asInt(rec.page_idx) ?? 0;
    const list = byPage.get(pageIdx) ?? [];
    list.push(rec);
    byPage.set(pageIdx, list);
  }

  const pages: PageInfo[] = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, items]) => ({
      index: idx,
      // v1 无 page_size：置 0 走 layout 层默认页宽（真实 bbox 坐标系与
      // layout.json 的 page_size 比例不一致，见 docs/real-api-notes.md §5）
      width: 0,
      height: 0,
      blocks: items.flatMap((rec, i) => normalizeV1Element(rec, idx, i) ?? []),
    }));

  if (pages.length === 0) {
    pages.push({ index: 0, width: 0, height: 0, blocks: [] });
  }
  return { docId, pages };
}

function normalizeV1Element(
  rec: Record<string, unknown>,
  pageIdx: number,
  idx: number,
): ParsedBlock | null {
  const type = String(rec.type ?? "text");
  const bbox = toBBox(rec.bbox);

  switch (type) {
    case "image":
    case "chart": {
      return { kind: "image", bbox, path: String(rec.img_path ?? `image-p${pageIdx}-${idx}.png`) };
    }
    case "equation": {
      return { kind: "formula", bbox, latex: unwrapLatex(String(rec.text ?? "")) };
    }
    case "header":
    case "footer":
    case "page_number":
    case "aside_text": {
      return null;
    }
    default: {
      const text = typeof rec.text === "string" ? rec.text : "";
      const lines = text.split("\n").filter((s) => s.length > 0);
      return {
        kind: "text",
        bbox,
        text,
        firstLine: lines[0] ?? "",
        lineCount: Math.max(lines.length, 1),
        maxFontSize: 0, // v1 无字号信息；下游规则暂不使用该字段
      };
    }
  }
}

/** equation 块的 text 形如 "$$\n{ \frac { 5 } { 8 } } G\n$$"，解包为裸 LaTeX */
function unwrapLatex(s: string): string {
  return s.replace(/^\$\$\s*/, "").replace(/\s*\$\$$/, "").trim();
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

/**
 * 行级布局解析：以 MinerU result.zip 中的 layout.json 为主内容源。
 * para_blocks 每块按 lines[] 展开为行级块（每行一个 ParsedBlock），
 * 行内公式 span 内联为 $...$；page_size 取真实值。
 * 解决 v1/v2 content_list 块粒度太粗（选项被合并进单块）的问题。
 *
 * 注意：真实 layout.json（2026-08-18 实测）行内公式 span 的 type 为
 * `inline_equation`（brief 初稿写作 equation_inline），此处同时识别两种，
 * 保证夹具（page 1 block 4/7 含 inline_equation）的 `$..$` 内联被验证。
 */
export function normalizeLayout(layoutRaw: unknown, docId: string): ParsedDocument {
  const root = asRecord(layoutRaw);
  const pages = asArray(root.pdf_info as unknown)
    .map((entry) => {
      const rec = asRecord(entry);
      const size = asArray(rec.page_size as unknown);
      const blocks: ParsedBlock[] = [];
      for (const pbRaw of asArray(rec.para_blocks as unknown)) {
        const pb = asRecord(pbRaw);
        const pbType = String(pb.type ?? "text");

        // 图片/图表块：真实 layout.json（2026-08-18 实测 95/95）没有块级 lines，
        // 图片路径在嵌套 blocks[].lines[].spans[].image_path（span bbox 与块 bbox 一致）。
        // 旧实现 `if (lines.length === 0) continue` 会把 image 块整块跳过 → layout 路径
        // imagesAttached=0（v1 基线 97/97），图片归属静默回退且无测试拦截。
        // 此处把 image_path 挂回为 image ParsedBlock；bbox 取 span/块 bbox，参与版面层阅读顺序。
        if (pbType === "image" || pbType === "chart") {
          const img = extractLayoutImage(pb);
          if (img) blocks.push(img);
          continue;
        }

        const lines = asArray(pb.lines as unknown);
        if (lines.length === 0) continue;
        for (const lineRaw of lines) {
          const line = asRecord(lineRaw);
          const spans = asArray(line.spans as unknown);
          const parts: string[] = [];
          for (const spanRaw of spans) {
            const span = asRecord(spanRaw);
            const content = String(span.content ?? span.text ?? "");
            if (!content) continue;
            const spanType = String(span.type ?? "text");
            const isInlineEquation =
              spanType === "equation_inline" || spanType === "inline_equation";
            parts.push(isInlineEquation ? `$${content.trim()}$` : content);
          }
          if (parts.length === 0) continue;
          const text = parts.join("");
          blocks.push({
            kind: "text",
            bbox: toBBox(line.bbox),
            text,
            firstLine: text,
            lineCount: 1,
            maxFontSize: 0,
          });
        }
      }
      return {
        index: asInt(rec.page_idx) ?? 0,
        width: asNumber(size?.[0]) ?? 1654,
        height: asNumber(size?.[1]) ?? 2339,
        blocks,
      } satisfies PageInfo;
    })
    .sort((a, b) => a.index - b.index);
  return { docId, pages };
}

/**
 * 从 layout.json 的 image/chart para_block 提取 image ParsedBlock。
 *
 * 真实形态（2026-08-18 实测 95/95 图片块一致）：块级无 lines，图片路径在
 * `blocks[].lines[].spans[].image_path`（span bbox 与块 bbox 相同）。
 * 兜底：块级 `path` 字段（旧版结构）。
 * 找不到任何图片路径返回 null（不产出悬空块）。
 */
function extractLayoutImage(
  pb: Record<string, unknown>,
): Extract<ParsedBlock, { kind: "image" }> | null {
  const blockBBox = toBBox(pb.bbox);
  // ① 嵌套子块 lines[].spans[].image_path（真实主形态）
  for (const subRaw of asArray(pb.blocks as unknown)) {
    const sub = asRecord(subRaw);
    for (const lineRaw of asArray(sub.lines as unknown)) {
      for (const spanRaw of asArray(asRecord(lineRaw).spans as unknown)) {
        const span = asRecord(spanRaw);
        const path = String(span.image_path ?? span.path ?? "");
        if (path) {
          const spanBBox = toBBox(span.bbox);
          return {
            kind: "image",
            bbox: isZeroBox(spanBBox) ? blockBBox : spanBBox,
            path,
          };
        }
      }
    }
  }
  // ② 块级 path 兜底（旧版结构）
  const path = String(pb.path ?? "");
  if (path) return { kind: "image", bbox: blockBBox, path };
  return null;
}

function isZeroBox(b: BBox): boolean {
  return b.every((n) => n === 0);
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