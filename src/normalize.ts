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
/**
 * 从表格块里取上游 HTML：网格在**嵌套** `blocks[].lines[].spans[].html`。
 * 取第一个含 `<table` 的串；没有就返回空串（调用方退回按 lines 展开）。
 */
function extractTableHtml(pb: Record<string, unknown>): string {
  for (const nestedRaw of asArray(pb.blocks as unknown)) {
    for (const lineRaw of asArray(asRecord(nestedRaw).lines as unknown)) {
      for (const spanRaw of asArray(asRecord(lineRaw).spans as unknown)) {
        const h = String(asRecord(spanRaw).html ?? "");
        if (h.includes("<table")) return h;
      }
    }
  }
  return "";
}

/**
 * 表格 HTML → 纯文本（**极简扁平化**，只给搜索/审计兜底，不承担结构还原）：
 * 单元格按行拼接、行间换行、`<eq>` 转 `$…$`、其余标签剥掉。
 * 结构还原由展示层的 `stages/table-html.js` 负责（那边要 rowspan/colspan）。
 */
function flattenTableText(html: string): string {
  const rows: string[] = [];
  for (const rm of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cm of (rm[1] ?? "").matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const t = String(cm[2] ?? "")
        .replace(/<eq>([\s\S]*?)<\/eq>/g, (_, m) => `$${String(m).trim()}$`)
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (t) cells.push(t);
    }
    if (cells.length) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

export function normalizeLayout(layoutRaw: unknown, docId: string): ParsedDocument {
  const root = asRecord(layoutRaw);
  const pages = asArray(root.pdf_info as unknown)
    .map((entry) => {
      const rec = asRecord(entry);
      const size = asArray(rec.page_size as unknown);
      const blocks: ParsedBlock[] = [];
      /** 跨页段泄漏行（见 dropCrossPageLeaks 的归类说明），按页收集后统一迁回 */
      const leaks: ParsedBlock[] = [];
      const pageWidth = asNumber(size?.[0]) ?? 1654;
      const pageHeight = asNumber(size?.[1]) ?? 2339;
      /**
       * **被 MinerU 误判为页眉的章标题，提升回正文**（2026-10-28 实测）：
       * `第四章 曲线运动` 印在页顶居中，MinerU 把它塞进 `discarded_blocks`（type=header）；
       * 而同一版式的 `第三章 运动和力的关系` 却是 `title`。丢掉的后果不是"少一行字"：
       * `chapter` 为空 ⇒ 题号组归到 `?` ⇒ **无法按章配对答案**（bank:all 整册跳过）。
       * 判据取最严：**只在 discarded 里、只认行首 `第N章`**，别的一律不动。
       */
      for (const dbRaw of asArray(rec.discarded_blocks as unknown)) {
        const db = asRecord(dbRaw);
        // **只认 header**：`aside_text` 是页边竖排的章号标记（题册 p1 右侧那列「第二章相互作用」），
        // 它位置在栏外，提升进正文会打乱分栏 ⇒ 图片归属掉 8 张、选项组掉 7 组
        // （2026-10-28 实测回归）。章标题只印在页顶。
        if (String(db.type ?? "") !== "header") continue;
        const raw = layoutBlockText(db);
        if (!CHAPTER_TITLE_LINE.test(raw)) continue;
        // 章标题常被拆成两行（实测 `第四章\n曲线运动`）——`matchFirstLine` 只看首行，
        // 不压平就会丢掉「曲线运动」这个标题，后面 9 道题的 chapterTitle 全空
        // （2026-10-28 曲线运动 p9 实测）。判据仍是行首 `第N章`，不放松。
        const text = raw.replace(/\s*\n\s*/g, " ").trim();
        blocks.push({
          kind: "text",
          bbox: toBBox(db.bbox),
          text,
          firstLine: text,
          lineCount: 1,
          maxFontSize: 0,
        });
      }

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

        /**
         * **表格块**（`DECISIONS §76`）：上游把表格作为独立块给出 —— `type:"table"`、
         * `lines` 为空、网格在**嵌套** `blocks[].lines[].spans[].html`（带 rowspan/colspan）。
         * 旧实现走到下面 `lines.length === 0 → continue` 就把它**整块丢了**
         * （实测 `电路-MinerU` 18 个表格、全项目 17 个，含 6 张实验数据表）。
         *
         * 这里产出一个 `kind:"table"` 块，`text` 只做**极简扁平化**（去标签、单元格换行拼接）
         * 供搜索/审计兜底；结构留在 `html` 里给展示层画网格。
         * ⚠️ 不复用 `stages/table-html.js`：解耦红线禁止 `src/` 依赖展示层。
         */
        if (pbType === "table") {
          const html = extractTableHtml(pb);
          if (html) {
            const text = flattenTableText(html);
            blocks.push({
              kind: "table",
              bbox: toBBox(pb.bbox),
              text,
              firstLine: text.split("\n")[0] ?? "",
              lineCount: Math.max(1, text.split("\n").length),
              maxFontSize: 0,
              html,
            });
            continue;
          }
          // 取不到 html ⇒ 退回旧行为（按 lines 展开），不新增块
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
          const block: ParsedBlock = {
            kind: "text",
            bbox: toBBox(line.bbox),
            text,
            firstLine: text,
            lineCount: 1,
            maxFontSize: 0,
          };
          // 跨页段泄漏行：MinerU 偶发把跨页段落的下一页行并进上一页段落
          // （行坐标是下一页页顶的，物理上压在上一页页眉标题上——2026-10-07 p0 q7 实证，
          // 行在第 2 页并无副本，直接丢弃会截断第 7 题题干）。此处仅收集，迁回见
          // dropCrossPageLeaks；与段落框相近的行是正常段内续行（段框偏紧），不在此列。
          const pbBBox = toBBox(pb.bbox);
          const lineBBox = toBBox(line.bbox);
          if (
            isCrossPageLeakShape(lineBBox, pbBBox, pageWidth, pageHeight)
          ) {
            leaks.push(block);
            continue;
          }
          blocks.push(block);
        }
      }
      // **跨行折断回接**（`DECISIONS §85`）：放在这里是因为 leak 行已被挑走
      // （`continue` 进 leaks、不进 blocks），此刻 blocks 里剩下的才是本页真正相邻的行。
      const joined = joinBrokenBracketLines(blocks, pageWidth, pageHeight);
      return {
        index: asInt(rec.page_idx) ?? 0,
        width: asNumber(size?.[0]) ?? 1654,
        height: pageHeight,
        blocks: joined,
        leaks,
      } satisfies PageInfo & { leaks: ParsedBlock[] };
    })
    .sort((a, b) => a.index - b.index);
  const withLeaks = pages as (PageInfo & { leaks: ParsedBlock[] })[];
  return { docId, pages: dropCrossPageLeaks(withLeaks) };
}

/**
 * **跨行折断回接**（`DECISIONS §85`）：把「上一行没收括号、下一行以 `数字)` 开头」的两行接回去。
 *
 * 现象（2026-10-30 实测，电路册 p6）：
 * ```
 * 行A: 是游标尺上的n条刻线的总长度与主尺上(n-      ← 行尾 `(n-`
 * 行B: 1)条刻线的总长度相等。常见的几种卡尺分类     ← 行首 `1)`
 * ```
 * 原文是 `(n-1)条刻线`，被版面折开。切题层看到行 B 的 `1)` 就当题号 ——
 * `§78` 用「量词黑名单」挡住了它，但那是**猜**：一旦正文改成 `1)滑块…` 就会漏。
 * 真正的证据是结构性的：**行 A 的 `(` 没闭合，它一定在下面闭合**。
 *
 * 判据（三条 AND，缺一不可）：
 * 1. 上一块最后一行**左括号多于右括号**（`(`/`（` > `)`/`）`）；
 * 2. 本块首行以 `数字)` / `数字）` 开头；
 * 3. **几何守卫**：本块在上一块正下方、行距很小、水平区间有重叠（同栏紧邻）。
 *
 * 为什么必须三条：只有 ① 时全项目命中 168 处，其中绝大多数是括号内正文的正常折行
 * （`(不计空气阻` + `力,g取10…`）—— 那些合并会把整页段落结构并掉，是实打实的回归。
 * ①+② 只剩 **2 处**，且都是真折断（电路 p6、答案册 p155 的 `(3+` + `57)K`）。
 *
 * 合并后文本**不加换行**（原文是同一句被折断，不是两段），`lineCount` 随之取 1，
 * 保证 `lineCount` 与 `text.split("\n").length` 始终一致。
 */
function joinBrokenBracketLines(
  blocks: ParsedBlock[],
  pageWidth: number,
  pageHeight: number,
): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "text" &&
      b.kind === "text" &&
      isBrokenTail(prev) &&
      startsWithNumberClose(b) &&
      isAdjacentBelow(prev, b, pageWidth, pageHeight)
    ) {
      out[out.length - 1] = {
        ...prev,
        bbox: [
          Math.min(prev.bbox[0], b.bbox[0]),
          prev.bbox[1],
          Math.max(prev.bbox[2], b.bbox[2]),
          b.bbox[3],
        ] as BBox,
        text: prev.text + b.text,
        firstLine: prev.firstLine,
        lineCount: 1,
      };
      continue;
    }
    out.push(b);
  }
  return out;
}

/** 上一块最后一行有未闭合左括号 ⇒ 它的闭合一定在下面。 */
function isBrokenTail(b: ParsedBlock): boolean {
  if (b.kind !== "text") return false;
  const lastLine = b.text.split("\n").pop() ?? "";
  const open = (lastLine.match(/[（(]/g) ?? []).length;
  const close = (lastLine.match(/[）)]/g) ?? []).length;
  return open > close;
}

/** 本块首行以 `数字)` / `数字）` 开头（折断后掉下来的闭合段）。 */
function startsWithNumberClose(b: ParsedBlock): boolean {
  if (b.kind !== "text") return false;
  return /^\d{1,3}\s*[)）]/.test(b.firstLine.trim());
}

/**
 * 几何守卫：本块紧贴上一块下方、同栏。
 *
 * - bbox 约定 `[x0, y0, x1, y1]`，**y 向下增长**（与 `isCrossPageLeakShape` 一致）；
 * - 行距上限取页高 3%：实测折断处行距 38 / 页高 2994 ≈ 1.3%，留余量但不跨段；
 * - 水平区间必须有重叠：双栏版面里左栏末行与右栏首行垂直相近，靠这一条挡掉。
 */
function isAdjacentBelow(
  prev: ParsedBlock,
  next: ParsedBlock,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const gap = next.bbox[1] - prev.bbox[3];
  if (gap < -2 || gap > Math.max(pageHeight * 0.03, 8)) return false;
  const overlap = Math.min(prev.bbox[2], next.bbox[2]) - Math.max(prev.bbox[0], next.bbox[0]);
  return overlap > Math.min(pageWidth * 0.1, 40);
}

/**
 * 行在页顶带且所属段在页底带、二者框完全不相交 → 跨页段泄漏的形状特征。
 *
 * 双栏版面下「左栏底部的段 + 右栏顶部的行」天然 x 不相交，会被 noOverlap 的 OR 命中；
 * 但二者同属本页、行只是段在右栏的续行（阅读顺序上**晚于**段），不是跨页泄漏。
 * 因此仅凭 noOverlap 不足以定案，必须叠加**阅读顺序守卫**：泄漏行的真实位置在所属段的
 * 相邻页上——主形态（段在页底、行在页顶）中行属下一页页顶，在本页阅读顺序里**早于**段；
 * 对称形态（段在页顶、行在页底）中行属上一页页底，在本页阅读顺序里**晚于**段。
 * 2 栏以「列桶 + y」作阅读键（x < 页宽/2 为桶 0，否则桶 1），逐项比较 (桶, y0)。
 */
function isCrossPageLeakShape(
  lineBBox: BBox,
  paraBBox: BBox,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const noOverlap =
    lineBBox[2] <= paraBBox[0] ||
    lineBBox[0] >= paraBBox[2] ||
    lineBBox[3] <= paraBBox[1] ||
    lineBBox[1] >= paraBBox[3];
  const lineTop = lineBBox[3] <= pageHeight * 0.35;
  const paraBottom = paraBBox[1] >= pageHeight * 0.6;
  const paraTop = paraBBox[3] <= pageHeight * 0.35;
  const lineBottom = lineBBox[1] >= pageHeight * 0.6;
  // 段在页底 + 行在页顶（下一页页顶内容并入本页末段，主形态），
  // 或段在页顶 + 行在页底（对称形态）。紧贴段框下方的续行不满足「完全不相交」之外
  // 还需跨带，故不会误伤 p6/p8/p9 那类正常段内续行。
  const mainForm = lineTop && paraBottom;
  const symmetricForm = lineBottom && paraTop;
  if (!noOverlap || (!mainForm && !symmetricForm)) return false;

  const lineKey = readingOrderKey(lineBBox, pageWidth);
  const paraKey = readingOrderKey(paraBBox, pageWidth);
  const lineBeforePara = compareReadingOrder(lineKey, paraKey) < 0;
  // 主形态要求行早于段（行属下一页页顶）；对称形态相反（行属上一页页底）。
  return mainForm ? lineBeforePara : !lineBeforePara;
}

/** 双栏阅读键：(列桶, y0)；列桶 = x0 < 页宽/2 ? 0 : 1 */
function readingOrderKey(b: BBox, pageWidth: number): [number, number] {
  return [b[0] < pageWidth / 2 ? 0 : 1, b[1]];
}

/** 阅读键字典序比较：(桶, y0) 逐项比较，返回 -1/0/1 */
function compareReadingOrder(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/**
 * 跨页段泄漏行迁回：泄漏行的坐标即它真实所属页的页顶位置，默认迁回下一页
 * （段在页底形态）；若下一页已有近似重复文本（页眉注释类，两页各有副本）则丢弃，
 * 避免重复。对称形态迁回上一页。迁移后由版面层阅读顺序自然归位。
 *
 * 无相邻页可迁时（末页「段在页底 + 行在页顶」/ 首页「段在页顶 + 行在页底」对称形态）
 * **保留在本页**而非丢弃——G1「不静默丢内容」：保留可见（可能压页眉/页脚）优于无声丢弃。
 */
function dropCrossPageLeaks(pages: (PageInfo & { leaks: ParsedBlock[] })[]): PageInfo[] {
  const norm = (t: string) => t.replace(/[\s\\${}]+/g, "");
  const fuzzyDup = (text: string, blocks: ParsedBlock[]): boolean => {
    const n = norm(text);
    if (n.length < 6) return false;
    return blocks.some((b) => {
      const nb = norm(b.kind === "text" ? b.text : "");
      return nb.length >= 6 && (nb.includes(n) || n.includes(nb));
    });
  };
  for (let i = 0; i < pages.length; i++) {
    const leaks = (pages[i] as PageInfo & { leaks: ParsedBlock[] }).leaks;
    if (!leaks || leaks.length === 0) continue;
    for (const block of leaks) {
      const leakedFromBottom = block.bbox[3] <= (pages[i]?.height ?? 0) * 0.35;
      const target = leakedFromBottom ? pages[i + 1] : pages[i - 1];
      if (!target) {
        // 末页「段在页底 + 行在页顶」/ 首页「段在页顶 + 行在页底」对称形态：无下一页/上一页可迁。
        // 旧实现直接丢弃且**无任何记录** = 静默丢内容（违反 G1）。修法取「保留可见优于丢弃」：
        // 留在本页（其坐标在页顶/页底，可能压住页眉/页脚，但内容可见、可回溯），而非丢弃。
        // 另一选项「丢弃 + 产出 ReviewNote」需把 note 从 normalize 层穿透到 SegmentationResult
        // （当前无此通道，ReviewNote 由 rule-engine 层产出），改动面大，故不取。
        pages[i]!.blocks.push(block);
      } else if (!fuzzyDup(block.kind === "text" ? block.text : "", target.blocks)) {
        target.blocks.push(block);
      }
      // 有目标页且已有副本：丢弃（副本存在时不损失数据）
    }
  }
  return pages.map(({ leaks: _leaks, ...page }) => page);
}

/**
 * 从 layout.json 的 image/chart para_block 提取 image ParsedBlock。
 *
 * 真实形态（2026-08-18 实测 95/95 图片块一致）：块级无 lines，图片路径在
 * `blocks[].lines[].spans[].image_path`（span bbox 与块 bbox 相同）。
 * 兜底：块级 `path` 字段（旧版结构）。
 * 找不到任何图片路径返回 null（不产出悬空块）。
 */
/**
 * 从 layout 的块结构里取纯文本（`lines[].spans[].content`）。
 * 用于 `discarded_blocks` —— 那里同样只有行/span 结构，没有现成的 text 字段。
 */
function layoutBlockText(pb: Record<string, unknown>): string {
  const out: string[] = [];
  for (const lineRaw of asArray(pb.lines as unknown)) {
    const line = asRecord(lineRaw);
    const parts: string[] = [];
    for (const spanRaw of asArray(line.spans as unknown)) {
      const span = asRecord(spanRaw);
      const c = String(span.content ?? span.text ?? "");
      if (c) parts.push(c);
    }
    if (parts.length) out.push(parts.join(""));
  }
  return out.join("\n").trim();
}

/**
 * 章标题形态：`第四章 曲线运动` / `第 4 章 …`。
 * **章号后面必须还有标题文本** —— 只有 `第六章` 三个字的那种是**页眉上的章号**，
 * 不是章标题；把它当章标题提升，反而会把 `chapterTitle` 清空
 * （2026-10-28 机械能 p7/p9 实测：p8–p11 共 15 题标题变空）。
 */
const CHAPTER_TITLE_LINE = /^第\s*[一二三四五六七八九十0-9]{1,3}\s*章\s*\S/;

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