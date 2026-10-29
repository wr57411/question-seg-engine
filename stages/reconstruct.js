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
import { baseFontOfPage, clampByWidth, fontForBlock, isVerticalText } from "./font-metrics.js";
import { contentLabelPlacements } from "./uncovered-layout.js";
import { mergePlan } from "./block-dedup.js";
import { stackContents, tagStackPlacements } from "./tag-layout.js";
import { parseTableHtml } from "./table-html.js";

/** 阶段 1–5 的画布像素宽（与 CSS --canvas-w 一致，用于字号换算） */
export const CANVAS_W = 760;
/** 纸面外侧留给题号牌的留白宽度（号牌绝不压正文，见 renderPaper） */
export const GUTTER = 22;

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export const enc = encodeURIComponent;

/* ── 画布与块 ── */

export function paperCanvas(p) {
  const c = el("div", "canvas");
  c.style.aspectRatio = `${p.width} / ${p.height}`;
  return c;
}

export function posStyle(node, bbox, w, h) {
  const [x0, y0, x1, y1] = bbox;
  node.style.left = `${(x0 / w) * 100}%`;
  node.style.top = `${(y0 / h) * 100}%`;
  node.style.width = `${((x1 - x0) / w) * 100}%`;
  node.style.height = `${((y1 - y0) / h) * 100}%`;
  return node;
}

/**
 * 表格节点：按块 bbox 落位，内部按上游 HTML 的行/列画真网格（`DECISIONS §76`）。
 *
 * 为什么用内联样式：`stages/` 与 `final/` 各有自己的 CSS，但**共用本渲染器**。
 * 把表格样式写成内联，能保证两处一定长得一样（红线「纸面重建只此一处实现」）。
 *
 * 解析不出行时返回 null ⇒ 调用方退回普通文本渲染（**不丢内容**）。
 */
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
export function tableColWidths(rows, cols) {
  if (!rows.length || cols <= 0) return [];
  const chars = new Array(cols).fill(1);
  for (const r of rows) {
    let c = 0;
    for (const cell of r.cells) {
      const per = Math.max(1, (cell.text || "").length) / cell.colspan;
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
 * 按「框宽/框高 + 单元格文字量 + 列宽比例」估算能装下的字号（`DECISIONS §76`）。
 *
 * 为什么需要：表格 bbox 是**原卷真实区域**，内容超出就会压到下面的正文
 * （2026-10-29 实测：表4 溢出 69px，直接叠在「教材素材变式…」上）。
 * 不能等渲染后量（`tableNode` 建节点时还没进文档，`clientHeight` 是 0），
 * 所以用字符数做确定性估算，从给定字号往下收敛到装得下为止。
 *
 * 口径：CJK 按 1em/字、行高 1.2、单元格上下 padding 各 1px。
 * 宁可估得保守（字号偏小）也不要溢出压字。
 */
export function fitTableFont(rows, widths, boxWpx, boxHpx, startSize) {
  if (!rows.length || !widths.length || boxWpx <= 0 || boxHpx <= 0) return startSize;
  const totalW = widths.reduce((a, b) => a + b, 0) || 1;
  for (let fs = startSize; fs > 6; fs -= 0.5) {
    let total = 0;
    for (const r of rows) {
      let rowLines = 1;
      let c = 0;
      for (const cell of r.cells) {
        let frac = 0;
        for (let k = 0; k < cell.colspan && c + k < widths.length; k++) frac += widths[c + k] / totalW;
        c += cell.colspan;
        const cellWpx = boxWpx * frac;
        const perLine = Math.max(1, Math.floor(cellWpx / fs));
        const lines = Math.max(1, Math.ceil((cell.text || "").length / perLine));
        if (lines > rowLines) rowLines = lines;
      }
      total += rowLines * fs * 1.2 + 2;
    }
    if (total <= boxHpx) return fs;
  }
  return 6;
}

export function tableNode(b, p, canvasW = CANVAS_W, baseFont = null) {
  const { rows, cols } = parseTableHtml(b.html);
  if (!rows.length) return null;
  const node = posStyle(el("div", "blk blk-table kind-table"), b.bbox, p.width, p.height);
  node.title = "上游表格（按 spans[].html 的 rowspan/colspan 还原网格）";
  const startSize = clampByWidth(fontForBlock(b, p.width, canvasW, baseFont, p.blocks), b, p.width, canvasW);
  const scale = canvasW / p.width;
  const boxWpx = (b.bbox[2] - b.bbox[0]) * scale;
  const boxHpx = (b.bbox[3] - b.bbox[1]) * scale;
  const widths = tableColWidths(rows, cols);
  const size = fitTableFont(rows, widths, boxWpx, boxHpx, startSize);
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
      const td = el("td");
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      td.style.cssText = "border:1px solid rgba(0,0,0,.35);padding:1px 3px;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere;";
      td.innerHTML = prettifyLatex(cell.text);
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
export function blockNode(b, p, canvasW = CANVAS_W, baseFont = null, mergeCtx = null, doc = "") {
  if (mergeCtx?.drop.has(b.i)) return null;
  const m = mergeCtx?.keep.get(b.i);
  const blk = m ? { ...b, text: m.text, bbox: m.bbox } : b;
  const node = posStyle(el("div", `blk blk-line kind-${blk.kind}`), blk.bbox, p.width, p.height);
  node.title = m ? `${blk.text} ｜（上游把本行读成两个重叠块，已合并）` : blk.text;
  if (blk.kind === "image" && blk.img) {
    const img = el("img");
    img.src = `/data/out/${enc(doc)}/images/${enc(blk.img)}`;
    img.alt = "图片块";
    node.append(img);
  } else {
    // prettifyLatex 返回 HTML 片段（\frac 竖排分式 / \sqrt 带上划线根号），必须 innerHTML
    const html = prettifyLatex(blk.text);
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
export function mergeContext(p) {
  return mergePlan(p.blocks);
}

/** 追加本页行级块节点（跳过被合并掉的块；返回与 p.blocks 对齐的节点数组，null = 未渲染）。
 *  `candidateStyle=false` ⇒ OCR 补入行**按普通正文样式**渲染（成品页的默认外观），
 *  但 title 仍写明来源（G1 的信息不丢，只是不抢视觉）。 */
export function appendBlockNodes(c, p, canvasW, baseFont, mergeCtx, doc = "", candidateStyle = true) {
  // ── 表格（DECISIONS §76）──
  // 表格块自带 bbox（就是表格整块框）。被这个框**完整覆盖**的其它行块，其文本已由网格呈现
  // ⇒ 不再重复画（否则网格上叠一层压平文字，正是用户看到的「几行乱字」）。
  // 判据是**几何包含**（确定性），不是"猜哪些块属于表格"。
  const tableBlocks = p.blocks.filter((b) => b.kind === "table" && b.html);
  const coveredByTable = new Set();
  for (const t of tableBlocks) {
    const [rx0, ry0, rx1, ry1] = t.bbox;
    for (const b of p.blocks) {
      if (b === t) continue;
      const [x0, y0, x1, y1] = b.bbox;
      if (x0 >= rx0 - 1 && y0 >= ry0 - 1 && x1 <= rx1 + 1 && y1 <= ry1 + 1) coveredByTable.add(b.i);
    }
  }
  const nodes = p.blocks.map((b) => {
    if (coveredByTable.has(b.i)) return null;
    if (b.kind === "table" && b.html) {
      const tn = tableNode(b, p, canvasW, baseFont);
      if (tn) return tn;
    }
    return blockNode(b, p, canvasW, baseFont, mergeCtx, doc);
  });
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
  for (const n of nodes) if (n) c.append(n);
  return nodes;
}

/* ── 三类「额外内容/标记」 ── */

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
  txt.textContent = it.text;
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
export function ocrRect(it) {
  return it.win ?? it.bbox;
}

/**
 * @param region 只画与该矩形相交的候选（面板裁一条题目时用）；null = 全画
 */
export function ocrFillInto(c, p, canvasW = CANVAS_W, candidateStyle = true, region = null) {
  const items = (p.ocrFill ?? []).filter((x) => x.accepted && (!region || rectHits(ocrRect(x), region)));
  if (!items.length) return;
  const baseFont = baseFontOfPage(p.blocks, p.width, canvasW);
  for (const it of items) c.append(ocrFillNode(it, p, canvasW, baseFont, candidateStyle));
}

/** 两个矩形是否相交（PDF 点 [x0,y0,x1,y1]）。 */
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
 * 由 `renderPaper({ diagnostics })` 控制，一键可开。
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
 * @param {any} p 整页快照
 * @returns {Array<{bbox:number[], area:number}>}
 */
export function unfilledContentHoles(p) {
  const all = p.uncovered ?? [];
  if (!all.length) return [];
  const filled = (p.ocrFill ?? []).filter((x) => x.accepted).map((x) => x.bbox);
  const isFilled = (r) => filled.some((f) => r[0] < f[2] && r[2] > f[0] && r[1] < f[3] && r[3] > f[1]);
  return all.filter((r) => r.kind !== "furniture" && !isFilled(r.bbox));
}

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
  const avoidForLabels = p.blocks.concat(
    (p.ocrFill ?? []).filter((x) => x.accepted).map((x) => ({ bbox: x.win ?? x.bbox })),
  );
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
export function renderDiscardedInto(c, p, canvasW = CANVAS_W) {
  const baseFont = baseFontOfPage(p.blocks, p.width, canvasW);
  // 邻块池含本页行级块与丢弃块：丢弃块之间也可能互相挤压（Task 14 结构判据）
  const pool = [...(p.blocks ?? []), ...(p.discarded ?? [])];
  for (const b of p.discarded ?? []) {
    const node = posStyle(el("div", "blk blk-discarded"), b.bbox, p.width, p.height);
    const shown = prettifyLatex(b.text);
    node.title = `[已被解析器丢弃·${DISCARDED_LABEL[b.dtype] ?? b.dtype}] ${b.text}`;
    if (shown) {
      const txt = el("span", "txt");
      txt.innerHTML = shown;
      // 宽度安全上限（R3/R5）：同 blockNode——丢弃块（页脚等）也会因 bboxH 过冲而压字
      txt.style.fontSize = `${clampByWidth(fontForBlock(b, p.width, canvasW, baseFont, pool), b, p.width, canvasW)}px`;
      node.append(txt);
      // 竖排块（R4）：同 blockNode——字号按 bboxW 定，方向也要竖排
      if (isVerticalText(b.bbox, b.text ?? "")) node.classList.add("blk-vertical");
    }
    node.append(el("span", "tag", `丢弃·${DISCARDED_LABEL[b.dtype] ?? b.dtype}`));
    c.append(node);
  }
}

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
 * @param opts.candidateStyle  是否给 OCR 补入内容加候选样式。**默认 true**
 *                             —— 红线 G1：候选不得与引擎原文混淆
 * @param opts.onChipClick     点题号牌的回调 `(question, page) => void`
 * @param opts.resolveTags     标签解析器 `(question, page) => [{short,name,color}] | null`。
 *                             **只读渲染**：留白里 12px 高的短码目标在触屏上点不准（会与相邻题的
 *                             列互相遮挡并误触），所以标签的增删一律走题号牌 → 面板，不在纸面上做。
 *                             落位与三级降级（full/count/chip）由 `tag-layout.js` 算，见该文件口径注释。
 */
export function renderPaper(p, opts = {}) {
  const {
    doc = "",
    paneW,
    diagnostics = false,
    candidateStyle = true,
    onChipClick = null,
    resolveTags = null,
  } = opts;

  // 题号牌挂在「题目所在那一栏」的外侧：
  // 双栏页里右栏的题若把号牌挂到左留白，看起来就像标在左栏内容上
  //（2026-10-12 用户当场指出「识别错了」——实测第 17 页第 3/4/5/6 题首块 x≈276 属右栏，号牌却全挂在左侧）。
  const firsts = p.questions.map((q) => q.blocks.map((i) => p.blocks[i]).find(Boolean) ?? null);
  const mid = p.width / 2;
  const isRightCol = (b) => (p.columns ?? 1) >= 2 && !!b && (b.bbox[0] + b.bbox[2]) / 2 >= mid;
  const needsRight = p.questions.some((q, k) => q.startsHere !== false && isRightCol(firsts[k]));

  // ⚠️ **留白（gutter）专供题号牌**（2026-10-12 用户当场指出）。
  // 原做法是「页内落位，放不下就不挂」—— 但答案册这种密页（86 块/双栏/小字）
  // 页边距根本放不下号牌，于是**整页几乎一个号牌都不显示**，用户看到的就是「题号没识别出来」。
  // 现在把内容区收窄、号牌挂在留白里 ⇒ 永远放得下，且**绝不压正文**。
  const innerW = Math.max(120, paneW - GUTTER - (needsRight ? GUTTER : 0));
  const c = paperCanvas(p);
  c.style.width = `${innerW}px`;
  if (diagnostics) renderDiscardedInto(c, p, innerW); // 对比栏宽口径：丢弃块也必须用 innerW（R2）
  const baseFont = baseFontOfPage(p.blocks, p.width, innerW);
  appendBlockNodes(c, p, innerW, baseFont, mergeContext(p), doc, candidateStyle); // 同页块级重复并集合并（Task 15）

  // ⚠️ 号牌**不能**挂在画布内部：`.canvas` 有 `overflow: hidden`（「画布边界裁切」的既定决策，不改），
  // 挂在画布外侧的号牌会被**裁掉**（DOM 里有、位置也对，就是看不见 —— 2026-10-12 实测踩到）。
  // ⇒ 套一层与画布等宽等高的定位容器，号牌挂在容器上。
  const wrap = el("div", "paper-wrap");
  wrap.style.position = "relative";
  wrap.style.marginLeft = `${GUTTER}px`;
  if (needsRight) wrap.style.marginRight = `${GUTTER}px`;
  wrap.append(c);

  // ── 标签层：先在 px 域算好落位，再挂号牌（chip 级降级要挂在号牌上）──────────
  // 画布高由 `aspect-ratio` 决定，等式与 CSS 同源：canvasH = innerW × p.height / p.width。
  const canvasH = (innerW * p.height) / p.width;
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
    const chip = el("span", "q-chip plain", q.number);
    // 号牌必须能追溯到题目 id：跳转/高亮/测试都靠它（`textContent` 只有题号，多节同号会认错）
    chip.dataset.qid = q.id;
    chip.title = `第${q.number}题${onChipClick ? (resolveTags ? "（点击看详情 / 增删标签）" : "（点击看详情）") : ""}`;
    // 按题目所在栏决定挂哪一侧：右栏题挂右留白，其余挂左留白
    if (isRightCol(f)) chip.style.left = "calc(100% + 4px)";
    else chip.style.right = "calc(100% + 4px)";
    chip.style.top = `${(f.bbox[1] / p.height) * 100}%`;
    // chip 级降级：留白里放不下独立短码列，但**标签必须在页面上留痕**（绝不静默，U6）
    const badge = badgeOf(q.id);
    if (badge) chip.append(el("span", "qtag-badge", String(badge)));
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

  ocrFillInto(c, p, innerW, candidateStyle); // 先画候选
  if (diagnostics) uncoveredInto(c, p, innerW); // 再画遗漏标记（盖得住候选，符合原顺序）
  // 注意：**不要再次 append(c)** —— c 已经在 wrap 里；重复 append 会把它移出容器，
  // 号牌就又回到被 `.canvas{overflow:hidden}` 裁掉的状态。
  return { wrap, canvas: c, innerW };
}
