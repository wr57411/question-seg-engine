// 类型权威检查器：`tsconfig.viewer.json`（checkJs:true + DOM lib）。本文件是 DOM 代码，
// **不要**加 `// @ts-check` —— 主 `tsconfig.json` 的 lib 没有 DOM，一旦本文件被 TS 测试 import
// 进主程序，`HTMLElement` / `document` 会被判成未知名字（DECISIONS §95）。
/**
 * reconstruct.js —— 「按原坐标重建纸面」的共享渲染器（展示层；DOM 构造 + 纯函数消费）
 *
 * 谁在用：
 * - `stages/stages.js`：原料/阅读顺序/切题/质检/对比 各阶段的纸面；
 * - `final/`：**成品页**（用户 2026-10-14 要求「成品跟对比右侧那个一样」，为的是"用起来像原版书"）。
 *
 * ⚠️ **为什么必须抽成一个模块**：成品页与对比右侧是**同一件东西**（用户明确要求一致）。
 * 各写一遍必然漂移 —— 字号口径、留白宽度、号牌落位、审计标记……任一处改了另一处不会知道。
 * 这里只此一处实现，两个页面共用。
 *
 * 解耦红线：只消费快照 JSON + 同目录纯函数模块（latex-display / font-metrics /
 * uncovered-layout / block-dedup），**不 import 引擎 src/**。
 */
import { prettifyLatex } from "./latex-display.js";
import { baseFontOfPage, clampByWidth, emWidthOf, fontForBlock, hasTwoDimensionalMath, isVerticalText, renderedTextOf } from "./font-metrics.js";
import { contentLabelPlacements } from "./uncovered-layout.js";
import { mergePlan } from "./block-dedup.js";
import { stackContents, tagStackPlacements } from "./tag-layout.js";
import { parseTableHtml } from "./table-html.js";
import { isMisreadFigureText } from "./figure-misread.js";
import { findHorizontalChoiceRows } from "./choice-row.js";

/**
 * 本渲染器消费的快照形状（只声明**读过**的字段，不追求与引擎 schema 完全一致）：
 * - `Block` / `Uncovered` / `OcrItem` 来自 `stages.json` 的页内数据；
 * - `PageQuestion` 是页内 `questions[]`（`blocks` 是块下标，不是块对象）；
 * - `RenderOpts` 是 `renderPaper` 的选项。
 *
 * S2 放置新增字段（spec 2026-11-13 §5.1，**只增不改旧字段**；旧快照无这些字段 ⇒ 缺省走现状路径）：
 * - `tableClass`/`tableSource`：上游分类产物 table-v3.json（展示层只消费，不做识别）；
 * - `crop`/`cropSize`：相对 doc 目录的裁图子路径 + 原生像素 [w,h]（整表截图 / 巨带回退行 / M2 漏泄组）；
 * - `coordSource`：行级坐标来源（B-39 truncationCropFallback 旗标产出，export-stages 透传）；
 * - `leakCoveredBy`：M2 markdown 漏泄组尾块 ⇒ 由该 i 的首块并集裁图呈现（不重复画，原文进首块 title）。
 * @typedef {[number, number, number, number]} Rect
 * @typedef {{ i: number, kind?: string, bbox: number[], text?: string, html?: string, img?: string, dtype?: string, ocr?: boolean, correction?: boolean, tableClass?: "text" | "image" | "borderless", tableSource?: "v3" | "mineru", crop?: string, cropSize?: [number, number], coordSource?: "ink" | "crop", leakCoveredBy?: number }} Block
 * @typedef {{ bbox: number[], area: number, kind?: string }} Uncovered
 * @typedef {{ bbox: number[], win?: number[], text?: string, source?: string, accepted?: boolean, ratio?: number, crop?: string, raw?: string }} OcrItem
 * @typedef {{ id: string, number: string, blocks: number[], startsHere?: boolean }} PageQuestion
 * @typedef {{ width: number, height: number, blocks: Block[], questions: PageQuestion[], columns?: number, centers?: number[], discarded?: Block[], uncovered?: Uncovered[], ocrFill?: OcrItem[] }} Page
 * @typedef {{ text: string, short: string, name: string, color: string }} TagLike
 * @typedef {{ key: string, q: PageQuestion, tags: TagLike[], side: "left" | "right", topPx: number }} TagEntry
 * @typedef {{ doc?: string, paneW: number, diagnostics?: boolean, uncovered?: boolean, candidateStyle?: boolean, onChipClick?: ((q: PageQuestion, p: Page) => void) | null, resolveTags?: ((q: PageQuestion, p: Page) => TagLike[] | null) | null, ocrFill?: boolean, assignmentBadge?: ((q: PageQuestion, p: Page) => { topics: number, categories: number } | null) | null }} RenderOpts
 * @typedef {import("./table-html.js").ParsedTable} ParsedTable
 */

/** 阶段 1–5 的画布像素宽（与 CSS --canvas-w 一致，用于字号换算） */
export const CANVAS_W = 760;
/** 纸面外侧留给题号牌的留白宽度（号牌绝不压正文，见 renderPaper） */
export const GUTTER = 22;

/**
 * 实验编号（`实验10`）比纯数字宽，22px 留白放不下（2026-11-02 `B-20` 定案）。
 * 只对含实验编号的页面加宽，普通页几何仍是 22px（`tests/layout-invariant.test.ts` 锁死）。
 */
export const EXP_GUTTER = GUTTER + 14;

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export const enc = encodeURIComponent;

/* ── 画布与块 ── */

/**
 * @param {Pick<Page, "width" | "height">} p
 * @returns {HTMLDivElement}
 */
export function paperCanvas(p) {
  const c = /** @type {HTMLDivElement} */ (el("div", "canvas"));
  c.style.aspectRatio = `${p.width} / ${p.height}`;
  return c;
}

/**
 * @template {HTMLElement} T
 * @param {T} node
 * @param {number[]} bbox
 * @param {number} w
 * @param {number} h
 * @returns {T}
 */
export function posStyle(node, bbox, w, h) {
  const [x0, y0, x1, y1] = bbox;
  node.style.left = `${(x0 / w) * 100}%`;
  node.style.top = `${(y0 / h) * 100}%`;
  node.style.width = `${((x1 - x0) / w) * 100}%`;
  node.style.height = `${((y1 - y0) / h) * 100}%`;
  return node;
}

/**
 * **挂载后实测适配**（`DECISIONS §76`）：表格内容比框高就把字号往下收，直到装得下。
 *
 * 为什么不在建节点时算：`tableNode` 执行时节点还没进文档，`clientHeight` 是 0，
 * 量不到真实高度。而纯估算（字符数 / 渲染宽度）**永远偏保守** —— 实测把表格字号压到
 * 正文的 0.45 倍（原卷里表格字与正文接近同号），用户当场指出「这肯定不会有这么小的字」。
 * ⇒ 初始用页面正文字号，挂载后用真实布局收缩，取到「装得下的最大值」。
 *
 * 只缩不放：字号已经由 `fontForBlock` 按页面口径定过，放大就不再忠实。
 */
/**
 * @param {HTMLElement | null | undefined} root
 */
export function fitTables(root) {
  const nodes = root?.querySelectorAll ? root.querySelectorAll(".blk-table") : [];
  for (const rawNode of nodes) {
    const node = /** @type {HTMLElement} */ (rawNode);
    const table = /** @type {HTMLTableElement | null} */ (node.querySelector("table"));
    if (!table || typeof node.clientHeight !== "number" || node.clientHeight <= 0) continue;
    let fs = parseFloat(table.style.fontSize) || 12;
    let guard = 0;
    while (node.scrollHeight > node.clientHeight + 1 && fs > 6 && guard++ < 60) {
      fs = Math.max(6, fs - 0.25);
      table.style.fontSize = `${fs}px`;
    }
  }
}

/** 表格节点：按块 bbox 落位，内部按上游 HTML 的行/列画真网格（`DECISIONS §76`）。
 *
 * 为什么用内联样式：`stages/` 与 `final/` 各有自己的 CSS，但**共用本渲染器**。
 * 把表格样式写成内联，能保证两处一定长得一样（红线「纸面重建只此一处实现」）。
 *
 * 解析不出行时返回 null ⇒ 调用方退回普通文本渲染（**不丢内容**）。
 */
/**
 * 单元格文本的**渲染宽度估计**（单位 em，`DECISIONS §76`）。
 *
 * 为什么不能按字符数：`$P_{总}=EI=P_{出}+P_{内}$` 在源码里有 20 个字符，渲染出来只有
 * 约 2em 宽。按字符数会把行数严重高估 ⇒ 字号被压到 6–8px（2026-10-29 用户对照原书指出
 * 「这肯定不会有这么小的字」，实测确实只有原卷的 1/2 左右）。
 *
 * 口径：中文 1em、西文/数字 0.55em、其余标点 0.4em、行内公式整体约 2.2em。
 * 仍是估计，但误差方向从「系统性高估」变成「大致相当」。
 */
/**
 * @param {unknown} s
 * @returns {number}
 */
export function textWidthEm(s) {
  let em = 0;
  for (const part of String(s ?? "").split(/(\$[^$]*\$)/)) {
    if (!part) continue;
    if (part.startsWith("$") && part.endsWith("$") && part.length > 1) {
      em += 2.2;
      continue;
    }
    for (const ch of part) {
      if (/[\u4e00-\u9fa5]/.test(ch)) em += 1;
      else if (/[A-Za-z0-9]/.test(ch)) em += 0.55;
      else if (/\s/.test(ch)) em += 0.3;
      else em += 0.4;
    }
  }
  return em;
}

/**
 * 按内容给每列分配宽度比例（`DECISIONS §76`）。
 *
 * 为什么不用等宽：`table-layout:fixed` 默认等分，但教辅表格列宽差异极大
 * （「电源的总功率」很窄、公式列很宽）。等分会让宽列内容挤成很多行 ⇒ 纵向溢出
 * ⇒ 只能靠缩字号解决 ⇒ 字小到看不清。按内容长度分配后，同样高度能装下更大字号。
 *
 * 口径：每列取「该列所有单元格的字符数 / colspan」的最大值，再归一化成百分比。
 * 纯确定性（只看文字量），不猜语义。
 */
/**
 * @param {ParsedTable["rows"]} rows
 * @param {number} cols
 * @returns {number[]}
 */
export function tableColWidths(rows, cols) {
  if (!rows.length || cols <= 0) return [];
  const chars = new Array(cols).fill(1);
  for (const r of rows) {
    let c = 0;
    for (const cell of r.cells) {
      const per = Math.max(1, textWidthEm(cell.text)) / cell.colspan;
      for (let k = 0; k < cell.colspan && c + k < cols; k++) chars[c + k] = Math.max(chars[c + k], per);
      c += cell.colspan;
    }
  }
  const total = chars.reduce((a, b) => a + b, 0) || 1;
  // 下限 8%：太窄的列会把字挤成竖排，反而更高
  const raw = chars.map((n) => Math.max(8, (n / total) * 100));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((n) => (n / sum) * 100);
}

/**
 * @param {Block} b
 * @param {Page} p
 * @param {number} [canvasW]
 * @param {number | null} [baseFont]
 * @param {string} [doc]
 * @returns {HTMLElement | null}
 */
export function tableNode(b, p, canvasW = CANVAS_W, baseFont = null, doc = "") {
  if (!b.html) return null;
  const { rows, cols } = parseTableHtml(b.html);
  if (!rows.length) return null;
  const node = posStyle(el("div", "blk blk-table kind-table"), b.bbox, p.width, p.height);
  node.title = "上游表格（按 spans[].html 的 rowspan/colspan 还原网格）";
  // 初始用**页面正文字号**（表格字与原卷正文接近同号，2026-10-29 对照原卷实测）。
  // ⚠️ 不能用 `clampByWidth`：它是「一行文字宽度 vs 块宽」的夹子，而表格块的 `text` 是
  // **整表压平文本**（几十上百字），会被当成超长单行 ⇒ 字号被夹到 3–7px（实测表9 只剩 3.4px）。
  // 表格的宽度约束由 `tableColWidths` + 单元格换行负责，高度约束由 `fitTables` 实测负责。
  const size = baseFont || fontForBlock(b, p.width, canvasW, baseFont, p.blocks) || 12;
  const widths = tableColWidths(rows, cols);
  const table = el("table");
  // ⚠️ `white-space:normal` 是必须的：`.blk` 全局 `white-space:nowrap`（行级块按原坐标排一行），
  // 表格继承它就不换行 ⇒ 单元格内容溢出、被 `.canvas{overflow:hidden}` 裁掉右半边
  // （2026-10-29 首轮截图实测：第三列文字全部被切）。
  table.style.cssText = `width:100%;height:100%;border-collapse:collapse;table-layout:fixed;white-space:normal;font-size:${size}px;line-height:1.15;`;
  const colgroup = el("colgroup");
  for (const w of widths) {
    const col = el("col");
    col.style.width = `${w.toFixed(2)}%`;
    colgroup.append(col);
  }
  table.append(colgroup);
  for (const r of rows) {
    const tr = el("tr");
    for (const cell of r.cells) {
      const td = /** @type {HTMLTableCellElement} */ (el("td"));
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      td.style.cssText = "border:1px solid rgba(0,0,0,.35);padding:1px 3px;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere;";
      td.innerHTML = prettifyLatex(cell.text);
      // 单元格里的插图（上游 `<img src>`）：表格里的曲线图/示意图不能丢（对照原卷 2026-10-29）
      for (const name of cell.images ?? []) {
        const img = /** @type {HTMLImageElement} */ (el("img"));
        img.src = `/data/out/${enc(doc)}/images/${enc(name)}`;
        img.alt = "表格内插图";
        img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;display:block;margin:2px 0;";
        td.append(img);
      }
      tr.append(td);
    }
    table.append(tr);
  }
  node.append(table);
  return node;
}

/** 行级块节点（各阶段与对比/成品共用；canvasW 为画布像素宽，用于字号换算）
 *  mergeCtx：本页「同页块级重复」的**并集合并**上下文（block-dedup.js，判据只此一处定义）：
 *   - `drop`：被合并掉的块（其内容已进合并文本）→ 返回 null，调用方跳过（**不丢内容**）；
 *   - `keep`：承载块 → 用**合并文本**与两块 **bbox 并集**渲染（更接近原卷该行真实范围）。
 *  返回 null 表示该块不渲染。 */
/**
 * @param {Block} b
 * @param {Page} p
 * @param {number} [canvasW]
 * @param {number | null} [baseFont]
 * @param {{ drop: Set<number>, keep: Map<number, { text: string, bbox: number[] }> } | null} [mergeCtx]
 * @param {string} [doc]
 * @returns {HTMLElement | null}
 */
export function blockNode(b, p, canvasW = CANVAS_W, baseFont = null, mergeCtx = null, doc = "") {
  if (mergeCtx?.drop.has(b.i)) return null;
  const m = mergeCtx?.keep.get(b.i);
  const blk = m ? { ...b, text: m.text, bbox: m.bbox } : b;
  const node = posStyle(el("div", `blk blk-line kind-${blk.kind}`), blk.bbox, p.width, p.height);
  node.title = m ? `${blk.text} ｜（上游把本行读成两个重叠块，已合并）` : (blk.text ?? "");
  if (blk.kind === "image" && blk.img) {
    const img = /** @type {HTMLImageElement} */ (el("img"));
    img.src = `/data/out/${enc(doc)}/images/${enc(blk.img)}`;
    img.alt = "图片块";
    node.append(img);
  } else if (
    blk.kind === "text" &&
    isMisreadFigureText(blk.text ?? "", (blk.bbox[3] ?? 0) - (blk.bbox[1] ?? 0))
  ) {
    // **图形误读压制**（B-64）：OXR 把数轴等简单图形读成 LaTeX array（A&&B&&C&&D 源码直出），
    // 渲染成乱码行。压制=不渲染文本，保留虚线占位 + title 提示（stages 审计可见，不静默——
    // 数据不删，红线「检测不改写」；原卷对照可见真图）。判据见 src/patterns.ts isMisreadFigureText。
    node.classList.add("blk-misread-figure");
    node.title = `（图形被上游误读为公式已压制：${(blk.text ?? "").slice(0, 40)}）`;
    return node;
  } else {
    // prettifyLatex 返回 HTML 片段（\frac 竖排分式 / \sqrt 带上划线根号），必须 innerHTML
    const html = prettifyLatex(blk.text ?? "");
    const txt = el("span", "txt");
    txt.innerHTML = html;
    // 宽度安全上限（R3/R5）：行高模型对个别行（页眉页脚/计划用时/短标签）会过冲，
    // 夹到 bbox 宽以免压到相邻块；纯 CJK 未溢出的块不受影响（见 font-metrics.js clampByWidth）。
    // Task 14：传入同页块池，供「同栏挤压」结构判据（框被撑大的碎尾退回基准字号）。
    txt.style.fontSize = `${clampByWidth(fontForBlock(blk, p.width, canvasW, baseFont, p.blocks), blk, p.width, canvasW)}px`;
    node.append(txt);
    // 竖排块（R4）：字号已按 bboxW 定，排布方向也要竖排，否则文字仍横向越出窄框
    if (isVerticalText(blk.bbox, blk.text ?? "")) node.classList.add("blk-vertical");
  }
  return node;
}

/** 本页并集合并上下文：{ drop:Set<i>, keep:Map<i, {text,bbox}> }（block-dedup.js）。
 *  派生逻辑（含「不可合并则不丢弃」不变式）在 `mergePlan` 内，只此一处实现、有测试锁定。 */
/**
 * @param {Page} p
 * @returns {{ drop: Set<number>, keep: Map<number, { text: string, bbox: number[] }> }}
 */
export function mergeContext(p) {
  return mergePlan(p.blocks);
}

/* ── S2 裁图放置器（spec 2026-11-13 §2/§5.2；内部函数，不 export ⇒ reconstruct.d.ts 不动） ── */

/**
 * 裁图例外放置（整表截图 / 巨带截断回退行共用同一放置器，A 内联）：
 * - posStyle 原位（bbox 左上角），宽 = min(nativeW, 栏宽)，height:auto，**只缩不放**
 *   （放大=海报化，entry-paper.js maxFontPx 教训）；无 cropSize 时退回 bbox 框内 contain。
 * - 文本不丢：原文本 + 放置说明 + 证据路径全留 title（search/面板可核对）；
 *   回退行是**引擎原文+回退坐标**，不是 OCR 候选 ⇒ 不套青绿候选框，以 data-coord-source 供审计区分。
 * - 宽裁图可读性补丁（§2.3）：nativeW > innerW/0.7 ⇒ 缩放后正文 <10px，内联只是缩略图
 *   ⇒ 挂 data-zoom，renderPaper 挂载后统一接「点按看原生尺寸」浮层。
 * @param {Block} b
 * @param {Page} p
 * @param {number} canvasW
 * @param {string} doc
 * @param {boolean} [diagnostics]
 * @returns {HTMLElement}
 */
function cropFigureNode(b, p, canvasW, doc, diagnostics = false) {
  const node = posStyle(el("div", `blk blk-crop kind-${b.kind ?? "text"}`), b.bbox, p.width, p.height);
  const cropPath = String(b.crop ?? "");
  const src = `/data/out/${enc(doc)}/${cropPath.split("/").map(enc).join("/")}`;
  const nw = b.cropSize?.[0] ?? 0;
  const nh = b.cropSize?.[1] ?? 0;
  const img = /** @type {HTMLImageElement} */ (el("img"));
  img.src = src;
  img.alt = b.tableClass === "image" ? "插图表整表截图（无损侧）" : "巨带裁图回退行（coordSource=crop）";
  if (nw > 0) {
    // 只缩不放 + 坐标保真：可用宽 = min(栏宽, bbox 框宽的画布像素)。
    // 裁图原生像素处在**页图域**（如 1000px 宽渲染），比坐标纸面画布密度大；
    // 若按 min(nativeW, 整栏宽) 放置会越出原 bbox ⇒ 压住邻块标题、右缘被 canvas
    // overflow:hidden 裁掉（2026-11-19 成品页实测事故）。故「可用栏宽」取该块框宽。
    // 原生宽小于框宽时仍按原生入页（不放大=海报化教训）；阅读原生尺寸走 data-zoom 浮层。
    const bboxW = ((b.bbox[2] - b.bbox[0]) / p.width) * canvasW;
    const availW = Math.min(canvasW, bboxW);
    node.style.width = `${Math.min(nw, availW)}px`;
    node.style.height = "auto";
    img.style.cssText = "display:block;width:100%;height:auto;";
  } else {
    img.style.cssText = "display:block;max-width:100%;max-height:100%;object-fit:contain;";
  }
  node.append(img);
  const why = b.tableClass === "image" ? "插图表整表截图" : "coordSource=crop 巨带裁图回退";
  node.title = `${b.text ?? ""} ｜ 裁图例外放置（${why}）｜ 证据：/data/out/${doc}/${cropPath}`;
  if (b.coordSource) node.dataset.coordSource = b.coordSource;
  if (b.tableClass) node.dataset.tableClass = b.tableClass;
  if (nw > 0 && nh > 0) {
    node.dataset.nativeW = String(nw);
    node.dataset.nativeH = String(nh);
    // 保守判据（§2.3）：实际缩放比 <0.7 时正文高 <10px ⇒ 必须提供原生尺寸阅读路径。
    // 实际渲染宽 = min(nw, 框宽, 栏宽) ⇒ 阈值用同一可用宽口径。
    const availW = Math.min(canvasW, ((b.bbox[2] - b.bbox[0]) / p.width) * canvasW);
    if (nw > availW / 0.7) node.dataset.zoom = "1";
  }
  if (diagnostics) {
    // bbox 审计框：裁图含 ±3px 外扩、高按同比例 ⇒ 与原框略有出入，审计时把原框画出来供核对
    const box = el("div", "crop-audit-box");
    const bw = ((b.bbox[2] - b.bbox[0]) / p.width) * canvasW;
    const bh = ((b.bbox[3] - b.bbox[1]) / p.height) * ((canvasW * p.height) / p.width);
    box.style.cssText = `position:absolute;left:0;top:0;width:${bw}px;height:${bh}px;border:1px dashed rgba(200,0,120,.6);pointer-events:none;`;
    box.append(el("span", "tag", "裁图例外"));
    node.append(box);
  }
  return node;
}

/**
 * 「点按看原生尺寸」浮层（§2.3 / R8）。**只此一处实现**：renderPaper 挂载后 rAF 统一接线，
 * final/ 与 stages/ 零改动自动获得（纸面重建只此一处红线）。
 * ⚠️ 浮层必须挂 **document.body**（canvas 外）：`.canvas{overflow:hidden}` 会把挂里面的浮层裁掉
 * （号牌事故同型，R8）。fixed 定位、可滚动、点背景/Esc 关。
 * @param {HTMLElement} node 带 data-zoom 的裁图节点
 */
function openCropZoom(node) {
  const img0 = /** @type {HTMLImageElement | null} */ (node.querySelector("img"));
  if (!img0 || typeof document === "undefined" || !document.body) return;
  const ov = el("div", "crop-zoom-overlay");
  ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);overflow:auto;padding:16px;";
  ov.title = "原生尺寸阅读（点背景或 Esc 关闭）";
  const img = /** @type {HTMLImageElement} */ (el("img"));
  img.src = img0.src;
  img.alt = "原生尺寸裁图";
  const nw = Number(node.dataset.nativeW) || 0;
  img.style.cssText = `display:block;background:#fff;max-width:none;height:auto;${nw > 0 ? `width:${nw}px;` : ""}`;
  ov.append(img);
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    ov.remove();
    document.removeEventListener("keydown", onKey);
  };
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close(); // 点背景关；点图本身不关（可滚动看全图）
  });
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
}

/**
 * 给 [data-zoom] 裁图节点接点按浮层（与 fitTables 同模式：挂载后 rAF 调用）。
 * @param {HTMLElement | null | undefined} root
 */
function wireCropZoom(root) {
  const nodes = root?.querySelectorAll ? root.querySelectorAll("[data-zoom]") : [];
  for (const rawNode of nodes) {
    const node = /** @type {HTMLElement} */ (rawNode);
    if (node.dataset.zoomWired) continue;
    node.dataset.zoomWired = "1";
    node.style.cursor = "zoom-in";
    node.title = `${node.title} ｜ 点按看原生尺寸`;
    node.addEventListener("click", () => openCropZoom(node));
  }
}

/** 追加本页行级块节点（跳过被合并掉的块；返回与 p.blocks 对齐的节点数组，null = 未渲染）。
 *  `candidateStyle=false` ⇒ OCR 补入行**按普通正文样式**渲染（成品页的默认外观），
 *  但 title 仍写明来源（G1 的信息不丢，只是不抢视觉）。
 *  S2 三分流（spec §3/§5.2）：image 表整表截图内联 / text 表走 tableNode / borderless 双保险跳过；
 *  行级 coordSource=crop 走裁图例外放置。**无新字段的旧快照逐字节走现状路径**。 */
/**
 * @param {HTMLElement} c
 * @param {Page} p
 * @param {number} canvasW
 * @param {number | null} baseFont
 * @param {{ drop: Set<number>, keep: Map<number, { text: string, bbox: number[] }> } | null} mergeCtx
 * @param {string} [doc]
 * @param {boolean} [candidateStyle]
 * @param {boolean} [diagnostics]
 * @returns {(HTMLElement | null)[]}
 */
export function appendBlockNodes(c, p, canvasW, baseFont, mergeCtx, doc = "", candidateStyle = true, diagnostics = false) {
  // ── 表格（DECISIONS §76）──
  // 表格块自带 bbox（就是表格整块框）。被这个框**呈现**的其它行块，其文本已由网格/截图呈现
  // ⇒ 不再重复画（否则网格/截图上叠一层压平文字，正是用户看到的「几行乱字」/双像）。
  // 判据是**确定性几何**（中心在表内 + 实质重叠 + 过冲有界，见下），不是"猜哪些块属于表格"。
  // S2：抑制只对「**实际会渲染的表**」成立——text 表（html 网格）与 image 表（整表截图）都抑制；
  // borderless 双保险跳过 tableNode 且**不进 coveredByTable**（行文本照常渲染，不丢内容）。
  /** @param {Block} b @returns {boolean} */
  const rendersTable = (b) =>
    b.kind === "table" && b.tableClass !== "borderless" && (!!b.html || (b.tableClass === "image" && !!b.crop));
  const tableBlocks = p.blocks.filter(rendersTable);
  /** @type {Set<number>} */
  const coveredByTable = new Set();
  /** M3：被抑块 i → 覆盖它的表块（供漏泄残字原文回填表 title，不丢内容） @type {Map<number, Block>} */
  const coveredByMap = new Map();
  for (const t of tableBlocks) {
    const [rx0, ry0, rx1, ry1] = t.bbox;
    const tw = rx1 - rx0;
    const th = ry1 - ry0;
    for (const b of p.blocks) {
      if (b === t) continue;
      const [x0, y0, x1, y1] = b.bbox;
      // N12 回归（曲线运动 p10 第4列）：OCR 行框过冲表框 19.2pt，旧**严格包含**判据漏抑
      // ⇒ 整表截图上叠 DOM 文本成双像。改最严 AND 三件（page-10 实测几何校准）：
      // ① 行中心落在表框内——中心在表外 = genuinely 表外行，绝不抑（不丢内容红线）；
      // ② 实质重叠：两轴重叠 ≥ 行宽/行高的 70%（实测 84.3%/100%，留裕度）；
      // ③ 单边过冲 ≤ 表对应边长的 10%（实测过冲=表宽 3.8%；table-render 反例锁的
      //    过冲=表宽 25% 正文行不得误抑）。包含关系是三件的特例，旧行为被超集覆盖。
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const ow = Math.min(x1, rx1) - Math.max(x0, rx0);
      const oh = Math.min(y1, ry1) - Math.max(y0, ry0);
      const overBounded =
        Math.max(rx0 - x0, x1 - rx1, 0) <= 0.1 * tw && Math.max(ry0 - y0, y1 - ry1, 0) <= 0.1 * th;
      if (
        cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1 &&
        ow >= 0.7 * (x1 - x0) && oh >= 0.7 * (y1 - y0) && overBounded
      ) {
        coveredByTable.add(b.i);
        coveredByMap.set(b.i, t);
      }
    }
  }
  // M2 漏泄组：首块 i → 尾块原文列表（尾块不画，原文补进首块裁图 title，不丢内容）
  /** @type {Map<number, string[]>} */
  const leakTails = new Map();
  for (const b of p.blocks) {
    if (b.leakCoveredBy === undefined) continue;
    const list = leakTails.get(b.leakCoveredBy) ?? [];
    list.push(b.text ?? "");
    leakTails.set(b.leakCoveredBy, list);
  }
  const nodes = p.blocks.map((b) => {
    if (coveredByTable.has(b.i)) return null;
    // M2 markdown 漏泄组尾块：由首块的并集裁图呈现（同一张图再画一遍=叠影）；
    // 原文不丢——快照 text 原样保留，下面补进首块 title（search/面板可核对）。
    if (b.leakCoveredBy !== undefined) return null;
    // 插图表：整表截图内联（无损侧，优先于 html 分支——V3 对插图表会丢图/丢文，§1）
    if (b.kind === "table" && b.tableClass === "image" && b.crop) {
      return cropFigureNode(b, p, canvasW, doc, diagnostics);
    }
    if (b.kind === "table" && b.html && b.tableClass !== "borderless") {
      const tn = tableNode(b, p, canvasW, baseFont, doc);
      if (tn) return tn;
    }
    // borderless 双保险：即使误入快照也跳过网格，退回文本渲染；全文留 title（不丢内容），
    // 诊断模式挂灰虚线注记（R4：误杀方向安全但必须可见）。
    if (b.kind === "table" && b.tableClass === "borderless") {
      const n = blockNode(b, p, canvasW, baseFont, mergeCtx, doc);
      if (n && b.html) {
        const { rows } = parseTableHtml(b.html);
        const flat = rows.map((r) => r.cells.map((cell) => cell.text).join("\t")).join("\n");
        n.title = `${flat}\n（无边框索引页，守卫跳过表格渲染；全文保留于此）`;
        // 快照 text 被上游 240 字夹过（整页索引实测只看见开头）⇒ 可见文本改用 html 全文
        // 扁平化：高度自适应 + 预换行 + 正文字号，成品页看得见全文才算不丢内容。
        const txt = /** @type {HTMLElement | null} */ (n.querySelector(".txt"));
        if (txt) {
          txt.textContent = flat;
          txt.style.whiteSpace = "pre-wrap";
          txt.style.fontSize = `${(canvasW / p.width) * 10.5}px`;
        }
        n.style.height = "auto";
        if (diagnostics) {
          n.style.outline = "1px dashed rgba(0,0,0,.3)";
          n.append(el("span", "tag", "无边框索引·守卫跳过"));
        }
      }
      return n;
    }
    // 巨带截断回退行（B-39）/ M2 markdown 漏泄组首块：坐标回退/漏泄行用截图代替文字放置
    // （用户许可的截图例外）；文本仍留 title 与快照，纸面呈现为裁图 ⇒ 不再出现 noBand 丢行/网址上页。
    if (b.coordSource === "crop" && b.crop) {
      const n = cropFigureNode(b, p, canvasW, doc, diagnostics);
      const tails = leakTails.get(b.i);
      if (tails) n.title = `${n.title} ｜ markdown 漏泄组并集裁图（同组原文）：${tails.join(" ")}`;
      return n;
    }
    return blockNode(b, p, canvasW, baseFont, mergeCtx, doc);
  });
  // M3 防双像：表内被抑的 markdown 漏泄行（M2 裁图首块 / leakCoveredBy 尾块）原文回填覆盖表 title——
  // 整表截图/网格已含其内容，残字不再重复画；原文留快照 text + 此处 title（不丢内容）。
  // 只认漏泄行（coordSource=crop 且含 markdown 图语法 / 漏泄尾块），普通表内行与巨带回退行不动。
  for (const b of p.blocks) {
    let t = coveredByMap.get(b.i);
    if (!t && b.leakCoveredBy !== undefined) {
      // 尾块自身可能在表框外，但首块被表抑 ⇒ 首块节点已不存在，原文同样进表 title
      const head = p.blocks.find((x) => x.i === b.leakCoveredBy);
      if (head) t = coveredByMap.get(head.i);
    }
    if (!t) continue;
    const txt = b.text ?? "";
    const isLeak =
      (b.coordSource === "crop" && (/!\[/.test(txt) || txt.includes("](http"))) ||
      b.leakCoveredBy !== undefined;
    if (!isLeak) continue;
    const n = nodes[p.blocks.indexOf(t)];
    if (n) n.title = `${n.title} ｜ 表内 markdown 残字（抑制防双像，原文留证）：${txt}`;
  }
  // `ocr: true` 的块是**从 OCR 候选补进来的题号行**（上游整行漏识别，见 export-stages 的
  // injectOcrQuestionLines）⇒ 默认用青绿候选样式渲染，绝不与引擎原文混淆（G1）。
  nodes.forEach((n, i) => {
    if (n && p.blocks[i] && p.blocks[i].ocr) {
      if (candidateStyle) n.classList.add("blk-ocr");
      n.title = `OCR 补入行（非引擎原文，请核对）：${n.title}`;
    }
  });
  // `correction: true` 的块经过**人工已核对的上游错误修正**（`corrections/<docId>.json`）：
  // 可能是「替换」（字母 O 被读成 0）或「补入」（漏读的图注）。用**琥珀虚线框**与
  // OCR 候选的青绿框区分开 —— 审阅时必须一眼看出哪块不是上游原文（见 DECISIONS §47）。
  nodes.forEach((n, i) => {
    if (n && p.blocks[i] && p.blocks[i].correction) {
      if (candidateStyle) n.classList.add("blk-corrected");
      n.title = `人工已核对修正（上游错读/漏读，依据 corrections/）：${n.title}`;
    }
  });
  nodes.forEach((n, i) => {
    if (n) n.dataset.bi = String(i); // 块索引 = p.blocks 下标（stages.json 的 i）
  });
  /** 「一行多选项被上游竖切」还原（fb-20261122T143209-vk62）：判据见 choice-row.js。
   *  命中的组按**同一行横排**摆放——不删块、不改数据，只把四个块摆回一行（检测不改写）。
   *  位置算法：以组内首块左缘为起点，按各块**墨迹宽**（bboxW）顺序拼接，行高取组内最大块高。 */
  applyChoiceRows(nodes, p);
  for (const n of nodes) if (n) c.append(n);
  return nodes;
}

/**
 * 把「横排误切」的选项组摆回一行（纯显示层；数据不动）。
 * @param {(HTMLElement | null)[]} nodes 与 p.blocks 同下标的节点数组
 * @param {Page} p
 */
function applyChoiceRows(nodes, p) {
  const rows = findHorizontalChoiceRows(p.blocks ?? [], p.width);
  const baseFont = baseFontOfPage(p.blocks ?? [], p.width, CANVAS_W);
  // 栏界：优先用快照 centers（左缘、栏心），否则按页宽对半分
  const centers = Array.isArray(p.centers) && p.centers.length >= 2 ? p.centers : [p.width / 2];
  /** 该 pt 坐标落在哪个栏（返回栏的左右界，用于把横排组限制在栏内）
   * @param {number} xPt */
  const columnOf = (xPt) => {
    const bounds = [];
    let left = 0;
    for (const c of centers) { bounds.push([left, c * 2 - left]); left = c * 2 - left; }
    bounds.push([left, p.width]);
    for (const [l, r] of bounds) if (xPt >= l && xPt < r) return [l, r];
    return [0, p.width];
  };
  for (const row of rows) {
    const idxs = row.map((b) => p.blocks.indexOf(b));
    if (!nodes[idxs[0]]) continue;
    const topPt = Math.min(...row.map((b) => b.bbox[1]));
    const x0 = Math.min(...row.map((b) => b.bbox[0]));
    const [colL, colR] = columnOf(x0);

    // 行高：按「装得下内容」取——分式 ~2.2×字号，普通 1.4×（字号为页面基准，pt 口径）
    const sizePt = (((baseFont ?? 12) * CANVAS_W) / p.width) || 10;
    const maxH = Math.max(
      ...row.map((b) =>
        hasTwoDimensionalMath(b.text ?? "") ? sizePt * 2.2 : sizePt * 1.4,
      ),
    );

    // 每项宽度按**内容墨迹宽**估（em×字号），而不是被撑满的 bbox 宽——否则四项之和远超栏宽
    const widths = row.map((b) => Math.max(emWidthOf(renderedTextOf(b.text ?? "")), 0.5) * sizePt);
    const totalW = widths.reduce((a, w) => a + w, 0);
    // 栏内可用宽（留 2% 边距）；若拼不下则等比收缩到栏宽
    const avail = (colR - colL) * 0.98;
    const scale = totalW > avail ? avail / totalW : 1;

    let acc = 0;
    row.forEach((b, k) => {
      const n = nodes[idxs[k]];
      if (!n) return;
      const w = widths[k] * scale;
      const xStart = colL + acc;
      acc += w;
      n.style.left = `${(xStart / p.width) * 100}%`;
      n.style.top = `${(topPt / p.height) * 100}%`;
      n.style.width = `${(w / p.width) * 100}%`;
      n.style.height = `${(maxH / p.height) * 100}%`;
      n.classList.add("blk-choice-row");
      n.title = `${n.title} ｜（上游把一行横排选项切成竖排，已还原为一行）`;
    });
  }
}

/* ── 三类「额外内容/标记」 ── */

/** @type {Record<string, string>} */
const DISCARDED_LABEL = { header: "页眉", footer: "页脚", page_number: "页码", aside_text: "侧栏" };

/**
 * OCR 候选补全（`scripts/ocr-fill.ts` / `scripts/ocr-page-fill.ts` 的产物，
 * **显式步骤**，不进 `npm run check`）：对「引擎为空」的解析遗漏区域，
 * 用 PaddleOCR-VL 读到的**候选**文本，**原位**渲染。
 *
 * 两条来源（`it.source`，角标会写明）：
 * - `"crop"`：**区域裁图** —— 窗口按行裁，位置天然对得上；
 * - `"page"`：**整页 OCR** —— 上下文完整、文本更干净（实测一次读全被漏掉的整行），
 *   但 OCR 会把折行的选项并成一行 ⇒ 合并时只用来**补裁图没补上的洞**。
 *
 * 为什么必须原位渲染：不渲染的话右侧重建就永远缺这一行 —— 那正是「对比之后的明显问题」。
 * 为什么不静默替换引擎文本：**OCR 会错字**（实测 `D 当口将` ← 原卷 `D. 当只将`），
 * 所以引擎文本一个字都不动，候选默认以**青绿虚线框**呈现（角标默认隐藏、悬停才出，
 * 避免「标记盖住正文」），悬停可见来源、宽度比、证据路径与 OCR 原始输出（可核对）。
 */
/**
 * 单条 OCR 候选 → 节点。**纸面与面板裁切共用这一个实现**（否则两处样式/口径会漂）。
 * 候选一律用青绿虚线 + 角标呈现，绝不与引擎原文混淆（红线 G1）。
 */
/**
 * @param {OcrItem} it
 * @param {Page} p
 * @param {number} canvasW
 * @param {number} baseFont
 * @param {boolean} [candidateStyle]
 * @returns {HTMLElement}
 */
export function ocrFillNode(it, p, canvasW, baseFont, candidateStyle = true) {
  const isPage = it.source === "page";
  const box = it.win ?? it.bbox;
  const node = posStyle(
    el("div", candidateStyle ? "blk blk-ocr blk-ocr-window" : "blk blk-line"),
    box,
    p.width,
    p.height,
  );
  node.title =
    `OCR 候选补全（非引擎文本，请核对）\n来源：${isPage ? "整页 OCR" : "区域裁图"}\n` +
    `宽度比 ${it.ratio}（≈1 为合理；${isPage ? "整页来源按**洞自身**宽度算" : "裁图来源按窗口宽算"}）\n` +
    `证据：${it.crop}\nOCR 原始输出：${it.raw}`;
  /**
   * 2026-10-28：绿框画在候选**证据 bbox** 上，不再画在 `win` 上。
   *
   * `win` 是为了把整行 OCR 文本排进去而扩出来的窗口，常与相邻公式块有几 pt 重叠
   * （答案册 p13 实测：`二 定律有1` 的 win x24.6–74.7 vs 公式 x69–179，重叠 5.7pt；
   * `a，根据运动学规律有` 重叠 5.2pt）。绿框画在 win 上 ⇒ 边框压到公式。
   * 证据 bbox 是「原卷上真正缺墨的洞」，与原生块天然不相交；文字仍按 win 排版，
   * 证据框只负责标记。宁可框比文字小，也不让标记压正文（G1/G9）。
   */
  if (candidateStyle) {
    const ev = el("div", "ocr-evidence");
    const [x0, y0, x1, y1] = it.bbox;
    const [wx0, wy0, wx1, wy1] = box;
    const w = wx1 - wx0;
    const h = wy1 - wy0;
    ev.style.left = `${((x0 - wx0) / w) * 100}%`;
    ev.style.top = `${((y0 - wy0) / h) * 100}%`;
    ev.style.width = `${((x1 - x0) / w) * 100}%`;
    ev.style.height = `${((y1 - y0) / h) * 100}%`;
    ev.append(el("span", "tag", isPage ? "OCR·整页" : "OCR·裁图"));
    node.append(ev);
  }
  const txt = el("span", "txt");
  txt.textContent = it.text ?? "";
  /**
   * 字号必须**按候选自身框宽夹紧**（与 `blockNode` 同源，`clampByWidth`）。
   * 定死 baseFont 会让长候选横向溢出，而 `posStyle` 连**高度**也定死了 ⇒
   * 溢出的字直接压到下一行正文上（2026-10-28 实测：答案册 p13 的
   * 「【解析】设 A、B…」一行宽 246pt，13.6px 时需 ~408px，横向溢出后压住公式行）。
   * 候选是「行」级证据，一行必须落在一行的高度里 —— 宁可字略小，也不能压正文。
   */
  txt.style.fontSize = `${clampByWidth(baseFont, { bbox: box, text: it.text ?? "" }, p.width, canvasW)}px`;
  node.append(txt);
  return node;
}

/** 候选行的落点矩形（窗口优先，整页来源没有窗口时用块框）。 */
/**
 * @param {OcrItem} it
 * @returns {number[]}
 */
export function ocrRect(it) {
  return it.win ?? it.bbox;
}

/**
 * @param region 只画与该矩形相交的候选（面板裁一条题目时用）；null = 全画
 */
/**
 * @param {HTMLElement} c
 * @param {Page} p
 * @param {number} [canvasW]
 * @param {boolean} [candidateStyle]
 * @param {number[] | null} [region] 只画与该矩形相交的候选（面板裁一条题目时用）；null = 全画
 */
export function ocrFillInto(c, p, canvasW = CANVAS_W, candidateStyle = true, region = null) {
  const items = (p.ocrFill ?? []).filter((x) => x.accepted && (!region || rectHits(ocrRect(x), region)));
  if (!items.length) return;
  // 12px 是本渲染器的兜底字号（与 tableNode 一致）；baseFontOfPage 全页无文本块时才为 null
  const baseFont = baseFontOfPage(p.blocks, p.width, canvasW) ?? 12;
  for (const it of items) c.append(ocrFillNode(it, p, canvasW, baseFont, candidateStyle));
}

/** 两个矩形是否相交（PDF 点 [x0,y0,x1,y1]）。 */
/**
 * @param {number[] | null | undefined} a
 * @param {number[] | null | undefined} b
 * @returns {boolean}
 */
export function rectHits(a, b) {
  return !!a && !!b && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/**
 * 未覆盖墨迹（Task 16；修复轮 1 分级 + 聚合 + 不遮正文）：
 * 解析漏掉的墨迹区域 —— 这是「不静默失败」红线的**地面真值呈现**（G1：丢失必须可见）。
 * - **内容级**：洋红标记框 + 「解析遗漏」标签（醒目）；
 * - **家具级**（页眉装饰/栏间竖线/页边标）：灰色细虚线框 + title 提示（仍可见，不抢眼，
 *   避免「洋红墙」）；
 * - **标签聚合**：相邻内容级区域合并为一个标签（避免热狗区那种标签堆叠）；
 * - **不遮正文**：标签矩形从候选位里取首个不与任何解析块 bbox 相交者；若框宽不足、或所有
 *   候选位都压正文，则不挂可见标签（改 title）—— 这是硬保证（验收：任何标记都不得盖住正文）。
 *
 * ⚠️ 成品页默认**不画**这些标记（它们不是原版书上的东西，默认画就不像原版书了）——
 * 由 `renderPaper({ diagnostics })` 控制；对比视图再叠一层 `uncovered` 开关（默认关）。
 */
/**
 * **没被补上的**内容级未覆盖洞（纯函数，无 DOM ⇒ 纸面与面板共用一份判据）。
 *
 * 判据：`p.uncovered` 里 `kind !== "furniture"` 且**不被任何 accepted 候选覆盖**的区域。
 * 已被候选盖住的那部分不再算洞 —— 它已经以青绿候选块的形式可见了（否则会重复标记）。
 *
 * 为什么单列出来：红线 G1 说「丢失必须可见」，而这些洞此前只在**纸面 + 审计标记开着**时才画，
 * 面板（点开题号牌的详情）根本不画 ⇒ 一处内容读不出来，用户在面板里完全看不出来。
 * 实测两册 45 个洞（42 个 <200px），几乎全是图注那一类小孤立标记
 * （例 答案册 p4 甲/乙/丙 三个图注位各一个洞）。
 *
 * @param {Page} p 整页快照
 * @returns {Uncovered[]}
 */
export function unfilledContentHoles(p) {
  const all = p.uncovered ?? [];
  if (!all.length) return [];
  const filled = (p.ocrFill ?? []).filter((x) => x.accepted).map((x) => x.bbox);
  /** @param {number[]} r @returns {boolean} */
  const isFilled = (r) => filled.some((f) => r[0] < f[2] && r[2] > f[0] && r[1] < f[3] && r[3] > f[1]);
  return all.filter((r) => r.kind !== "furniture" && !isFilled(r.bbox));
}

/**
 * @param {HTMLElement} c
 * @param {Page} p
 * @param {number} [canvasW]
 */
export function uncoveredInto(c, p, canvasW = CANVAS_W) {
  const all = p.uncovered ?? [];
  if (!all.length) return;
  // 已被 OCR 候选补全覆盖的区域：不再画洋红框（否则会盖住候选文本），
  // 改由 ocrFillInto 的青绿候选块表达「这里原本缺、现已补上候选」。
  const content = unfilledContentHoles(p);
  const furniture = all.filter((r) => r.kind === "furniture");

  // 家具级：灰色细虚线框 + title（不挂可见标签）
  for (const r of furniture) {
    const node = posStyle(el("div", "uncovered-mark furniture"), r.bbox, p.width, p.height);
    node.title = `版式家具级未覆盖：原卷页图上是墨迹（页眉装饰/栏间竖线/页边标等），不在任何解析块内（${r.area}px）`;
    c.append(node);
  }

  // 内容级：洋红标记框
  for (const r of content) {
    const node = posStyle(el("div", "uncovered-mark content"), r.bbox, p.width, p.height);
    node.title = `解析遗漏（内容级）：原卷页图上是墨迹，却不在本页任何解析块内（${r.area}px）`;
    c.append(node);
  }

  // 内容级标签：按组挂一个，落位由 uncovered-layout.js 的 contentLabelPlacements 算好
  // （它保证每个标签都不与任何解析块 bbox 相交、且在页内；放不下/必压正文的组不产出）。
  // ⚠️ 避让集合必须**含 OCR 候选块** —— 候选不在 p.blocks 里，不带上它标签就会压住刚补出来的候选文本
  //（2026-10-10 用户当场指出：「标记盖住正文」的规矩对候选同样成立）。
  /** @type {{ bbox: number[] }[]} */
  const avoidForLabels = [
    ...p.blocks,
    ...(p.ocrFill ?? []).filter((x) => x.accepted).map((x) => ({ bbox: x.win ?? x.bbox })),
  ];
  for (const { rect, count } of contentLabelPlacements(content, avoidForLabels, p.width, p.height, canvasW)) {
    const tag = el("span", "uncovered-tag", count > 1 ? `解析遗漏 ×${count}` : "解析遗漏");
    tag.style.left = `${(rect[0] / p.width) * 100}%`;
    tag.style.top = `${(rect[1] / p.height) * 100}%`;
    c.append(tag);
  }
}

/** 丢弃块（页眉/页脚/页码/侧栏）：虚线灰块呈现——原卷上有、解析器判为家具的内容。
 * canvasW 为**该视图**的画布像素宽：阶段 1–5 传 CANVAS_W(760)、对比/成品传真实栏宽；
 * 曾硬编码 CANVAS_W → 对比栏内丢弃块字号偏大 760/460 = 1.65×（R2）。 */
/**
 * @param {HTMLElement} c
 * @param {Page} p
 * @param {number} [canvasW]
 */
export function renderDiscardedInto(c, p, canvasW = CANVAS_W) {
  const baseFont = baseFontOfPage(p.blocks, p.width, canvasW);
  // 邻块池含本页行级块与丢弃块：丢弃块之间也可能互相挤压（Task 14 结构判据）
  const pool = [...(p.blocks ?? []), ...(p.discarded ?? [])];
  for (const b of p.discarded ?? []) {
    const node = posStyle(el("div", "blk blk-discarded"), b.bbox, p.width, p.height);
    const shown = prettifyLatex(b.text ?? "");
    const dtype = b.dtype ?? "";
    node.title = `[已被解析器丢弃·${DISCARDED_LABEL[dtype] ?? b.dtype}] ${b.text}`;
    if (shown) {
      const txt = el("span", "txt");
      txt.innerHTML = shown;
      // 宽度安全上限（R3/R5）：同 blockNode——丢弃块（页脚等）也会因 bboxH 过冲而压字
      txt.style.fontSize = `${clampByWidth(fontForBlock(b, p.width, canvasW, baseFont, pool), b, p.width, canvasW)}px`;
      node.append(txt);
      // 竖排块（R4）：同 blockNode——字号按 bboxW 定，方向也要竖排
      if (isVerticalText(b.bbox, b.text ?? "")) node.classList.add("blk-vertical");
    }
    node.append(el("span", "tag", `丢弃·${DISCARDED_LABEL[dtype] ?? b.dtype}`));
    c.append(node);
  }
}

/**
 * @param {[string, string][]} items
 * @returns {HTMLElement}
 */
export function legend(items) {
  const l = el("div", "legend");
  for (const [color, label] of items) {
    const s = el("span");
    const sw = el("span", "sw");
    sw.style.background = color;
    s.append(sw, document.createTextNode(label));
    l.append(s);
  }
  return l;
}

/* ── 整页重建（成品页与对比右侧的唯一入口） ── */

/**
 * 重建一整页纸面：内容画布 + 外侧留白里的题号牌（+ 可选审计标记）。
 * 返回 `{ wrap, canvas, innerW }`；`wrap` 是要挂进容器的元素。
 *
 * @param p        快照里的一页（`stages.json` 的 `pages[i]`）
 * @param {object} opts
 * @param opts.doc             卷 id（图片块要拼 `/data/out/<doc>/images/...`）
 * @param opts.paneW           该栏可用宽度（px）；字号换算与留白都按它算
 * @param opts.diagnostics     是否画审计标记（解析遗漏 + 丢弃块）。**默认 false**
 *                             —— 这些标记原版书上没有，默认画就不像原版书了
 * @param opts.uncovered       是否画「解析遗漏」标记（内容级洋红框 / 家具级灰虚线）。
 *                             **默认 true**（仅当 `diagnostics` 为真时才有意义）——
 *                             既有调用方（成品页/对比页）不传即维持原行为；对比视图用它做
 *                             用户开关（默认关，页面更干净），见 `stages.js` 的 `state.uncovered`。
 * @param opts.candidateStyle  是否给 OCR 补入内容加候选样式。**默认 true**
 *                             —— 红线 G1：候选不得与引擎原文混淆
 * @param opts.onChipClick     点题号牌的回调 `(question, page) => void`
 * @param opts.assignmentBadge 教学归类角标 `(question, page) => {topics,categories} | null`；
 *                             只挂在号牌内（`N·M`），不改变纸面几何。阅读/挑题模式用 CSS 调透明度。
 * @param opts.resolveTags     标签解析器 `(question, page) => [{short,name,color}] | null`。
 *                             **只读渲染**：留白里 12px 高的短码目标在触屏上点不准（会与相邻题的
 *                             列互相遮挡并误触），所以标签的增删一律走题号牌 → 面板，不在纸面上做。
 *                             落位与三级降级（full/count/chip）由 `tag-layout.js` 算，见该文件口径注释。
 */
/**
 * @param {Page} p
 * @param {Partial<RenderOpts>} [opts]
 * @returns {{ wrap: HTMLElement, canvas: HTMLDivElement, innerW: number }}
 */
export function renderPaper(p, opts = {}) {
  const {
    doc = "",
    paneW = 0,
    diagnostics = false,
    uncovered = true,
    candidateStyle = true,
    onChipClick = null,
    resolveTags = null,
    assignmentBadge = null,
    /**
     * **是否把 OCR 补行画到纸面上**（`DECISIONS §91`）：默认 **false**。
     *
     * 补行是「引擎没识别到、由 OCR 补出来的候选行」。它有两种来源：
     * - `crop`：按行裁图，位置天然对得上；
     * - `page`：**整页 OCR，没有位置信息** —— 算法要靠「锚点 + 宽度比例」把文本硬配回洞，
     *   实测会错配（电路 p1 把表格单元格的文字配到页眉的洞上 ⇒ 页面上出现
     *   `欧姆定律（纯电阻电路` / `dot` / `_2+` 一堆错位碎字，2026-10-30 用户截图）。
     *
     * 补行是**核查**用的证据（"这里原来漏了什么"），不是阅读内容。默认不画：
     * 需要时 `?fill=1` 或工具栏开关，`OCR 整页识别全文` 折叠区也一直可看。
     * 数据一个字没删（G1），只是不再默认糊在页面上。
     */
    ocrFill = false,
  } = opts;

  // 题号牌挂在「题目所在那一栏」的外侧：
  // 双栏页里右栏的题若把号牌挂到左留白，看起来就像标在左栏内容上
  //（2026-10-12 用户当场指出「识别错了」——实测第 17 页第 3/4/5/6 题首块 x≈276 属右栏，号牌却全挂在左侧）。
  const firsts = p.questions.map((q) => q.blocks.map((i) => p.blocks[i]).find(Boolean) ?? null);
  const mid = p.width / 2;
  /** @param {Block | null} b @returns {boolean} */
  const isRightCol = (b) => (p.columns ?? 1) >= 2 && !!b && (b.bbox[0] + b.bbox[2]) / 2 >= mid;
  const needsRight = p.questions.some((q, k) => q.startsHere !== false && isRightCol(firsts[k]));

  // ⚠️ **留白（gutter）专供题号牌**（2026-10-12 用户当场指出）。
  // 原做法是「页内落位，放不下就不挂」—— 但答案册这种密页（86 块/双栏/小字）
  // 页边距根本放不下号牌，于是**整页几乎一个号牌都不显示**，用户看到的就是「题号没识别出来」。
  // 现在把内容区收窄、号牌挂在留白里 ⇒ 永远放得下，且**绝不压正文**。
  // 实验编号（`实验10`）更宽：只对该页加宽留白，普通页保持 22px（B-20）
  const gutter = p.questions.some((q) => /^实验\d+/.test(q.number)) ? EXP_GUTTER : GUTTER;
  const innerW = Math.max(120, paneW - gutter - (needsRight ? gutter : 0));
  const c = paperCanvas(p);
  c.style.width = `${innerW}px`;
  if (diagnostics) renderDiscardedInto(c, p, innerW); // 对比栏宽口径：丢弃块也必须用 innerW（R2）
  const baseFont = baseFontOfPage(p.blocks, p.width, innerW);
  appendBlockNodes(c, p, innerW, baseFont, mergeContext(p), doc, candidateStyle, diagnostics); // 同页块级重复并集合并（Task 15）

  // ⚠️ 号牌**不能**挂在画布内部：`.canvas` 有 `overflow: hidden`（「画布边界裁切」的既定决策，不改），
  // 挂在画布外侧的号牌会被**裁掉**（DOM 里有、位置也对，就是看不见 —— 2026-10-12 实测踩到）。
  // ⇒ 套一层与画布等宽等高的定位容器，号牌挂在容器上。
  const wrap = el("div", "paper-wrap");
  wrap.style.position = "relative";
  wrap.style.marginLeft = `${gutter}px`;
  if (needsRight) wrap.style.marginRight = `${gutter}px`;
  wrap.append(c);

  // ── 标签层：先在 px 域算好落位，再挂号牌（chip 级降级要挂在号牌上）──────────
  // 画布高由 `aspect-ratio` 决定，等式与 CSS 同源：canvasH = innerW × p.height / p.width。
  const canvasH = (innerW * p.height) / p.width;
  /** @type {TagEntry[]} */
  const tagEntries = [];
  if (resolveTags) {
    p.questions.forEach((q, k) => {
      const f = firsts[k];
      if (!f || q.startsHere === false) return;
      const tags = resolveTags(q, p) ?? [];
      if (!tags.length) return;
      tagEntries.push({
        key: q.id,
        q,
        tags,
        side: isRightCol(f) ? "right" : "left",
        topPx: (f.bbox[1] / p.height) * canvasH,
      });
    });
  }
  const tagPlaced = tagStackPlacements(
    tagEntries.map((e) => ({ key: e.key, side: e.side, topPx: e.topPx, tagCount: e.tags.length })),
    canvasH,
  );
  /** @param {string} id @returns {number} */
  const badgeOf = (id) => {
    const pl = tagPlaced.get(id);
    return pl && pl.level === "chip" ? pl.tagCount : 0;
  };

  p.questions.forEach((q, k) => {
    const f = firsts[k];
    if (!f) return;
    // 跨页题的**续段**不挂号牌：那一页的原卷上本来就没有题号，
    // 挂了会让用户看到「不属于这页的题号」（实测第 17 页顶部挂 `第8题`，而该页题号是 9/2/3/4/5/6）。
    if (q.startsHere === false) return;
    // **只写数字**（用户要求：写「第N题」太占版面，把页面挤小了）——完整信息放 title。
    // 实验编号（`实验10`）是完整标签，不再加「第…题」前缀（B-20）。
    const isExperiment = /^实验\d+/.test(q.number);
    const chip = el("span", `q-chip plain${isExperiment ? " exp" : ""}`, q.number);
    // 号牌必须能追溯到题目 id：跳转/高亮/测试都靠它（`textContent` 只有题号，多节同号会认错）
    chip.dataset.qid = q.id;
    chip.title = `${isExperiment ? q.number : `第${q.number}题`}${onChipClick ? (resolveTags ? "（点击看详情 / 增删标签）" : "（点击看详情）") : ""}`;
    // 按题目所在栏决定挂哪一侧：右栏题挂右留白，其余挂左留白
    if (isRightCol(f)) chip.style.left = "calc(100% + 4px)";
    else chip.style.right = "calc(100% + 4px)";
    chip.style.top = `${(f.bbox[1] / p.height) * 100}%`;
    // chip 级降级：留白里放不下独立短码列，但**标签必须在页面上留痕**（绝不静默，U6）
    const badge = badgeOf(q.id);
    if (badge) chip.append(el("span", "qtag-badge", String(badge)));
    const asg = assignmentBadge ? assignmentBadge(q, p) : null;
    if (asg && (asg.topics || asg.categories)) {
      const tb = el("span", "teach-badge", `${asg.topics}·${asg.categories}`);
      tb.title = `${asg.topics} 个专题 · ${asg.categories} 个类别`;
      chip.append(tb);
    }
    if (onChipClick) chip.addEventListener("click", () => onChipClick(q, p));
    wrap.append(chip);
  });

  for (const e of tagEntries) {
    const pl = tagPlaced.get(e.key);
    if (!pl || pl.level === "chip") continue;
    const { visible, more, countBadge } = stackContents(e.tags.length, pl.level);
    const stack = el("div", `qtag-stack qtag-${pl.level}`);
    if (pl.side === "right") stack.style.left = "calc(100% + 4px)";
    else stack.style.right = "calc(100% + 4px)";
    stack.style.top = `${pl.topPx}px`;
    const names = e.tags.map((t) => t.name).join("、");
    stack.title = `标签：${names}（点题号可增删）`;
    for (const t of e.tags.slice(0, visible)) {
      const code = el("span", "qtag", t.short);
      code.style.background = t.color;
      code.title = t.name;
      stack.append(code);
    }
    if (more) stack.append(el("span", "qtag qtag-more", `+${more}`));
    if (countBadge) stack.append(el("span", "qtag qtag-count", String(countBadge)));
    wrap.append(stack);
  }

  if (ocrFill) ocrFillInto(c, p, innerW, candidateStyle); // 候选补行：默认不画（见 opts.ocrFill）
  if (diagnostics && uncovered) uncoveredInto(c, p, innerW); // 再画遗漏标记（盖得住候选，符合原顺序）；开关见 opts.uncovered
  // 注意：**不要再次 append(c)** —— c 已经在 wrap 里；重复 append 会把它移出容器，
  // 号牌就又回到被 `.canvas{overflow:hidden}` 裁掉的状态。
  // 表格字号适配必须在**挂载后**做：节点进文档才有 clientHeight。
  // 用 rAF 排到下一帧，两个调用方（final / stages）都不用改一行（纸面重建只此一处）。
  // S2：宽裁图的「点按看原生尺寸」浮层同模式接线（浮层挂 body，canvas 外，R8）。
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => {
    fitTables(wrap);
    wireCropZoom(wrap);
  });

  return { wrap, canvas: c, innerW };
}
