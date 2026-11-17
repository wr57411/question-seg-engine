// 类型权威检查器：`tsconfig.viewer.json`（checkJs:true + DOM lib）。本文件是 DOM 代码，
// **不要**加 `// @ts-check` —— 主 `tsconfig.json` 的 lib 没有 DOM（同 reconstruct.js 的处理）。
/**
 * render-faithful.js —— **1:1 复刻内核**（与 `reconstruct.js` 的 `renderPaper` **并列**）
 *
 * ⚠️ 这是**并列新增**的内核，**不改** `renderPaper` 的任何行为，也不替换它：
 * - `stages/` 各阶段与 `final/` 的既有数据（`stages.json`，带引擎 bbox）继续走 `renderPaper`；
 * - 本内核只消费 `faithful.json`（DOCX 原卷行级坐标，见 `data/out-doc/<doc>/faithful.json`），
 *   由 `final/final.js` 的加载分支按页的 `mode` 自动选择。两条路互不依赖。
 *
 * 与 `renderPaper` 的**本质差异**（也是必须新开一个内核的原因）：
 * 1. **公式直通**：`faithful.json` 的文本块带完整 `html`（MathML 原样）。本内核用
 *    `innerHTML` 原样写入，**绝不过 `prettifyLatex`** —— 后者会 `escapeHtml`，
 *    把 `<math>` 变成页面上可见的字面标签（G2-5）。
 * 2. **字号来自 `fontPt`**：`renderPaper` 用 bbox 高度反推字号；原卷的 bbox 高是**行距**
 *    （43.75pt），直接当字号盒会得到 2.3 倍字（G2-7）。这里字号只认块上的 `fontPt`（原卷 19pt），
 *    行盒高度另由 `linePt` 给定，两者不混用。
 * 3. **两种模式**：`mode:'abs'` 按 (H,V) 百分比绝对定位（pt/页宽，与 `renderPaper` 同口径，
 *    无 px↔pt 转换层）；`mode:'flow'` 无坐标页走固定行高双栏流式。
 *
 * DOM 契约与 `renderPaper` 保持一致：`.blk[data-bi]`、`.q-chip[data-qid]`，
 * 因此 `final/` 的挑题/标签/跳转不需要任何改动。
 */

import { el, enc, fitTables } from "./reconstruct.js";
import { stackContents, tagStackPlacements } from "./tag-layout.js";

/** 纸面外侧留给题号牌的留白（px，与 renderPaper 的 GUTTER 同口径） */
export const FAITHFUL_GUTTER = 22;
/** 实验编号（`实验10`）更宽，留白加宽（与 renderPaper 的 EXP_GUTTER 同规则） */
export const FAITHFUL_EXP_GUTTER = FAITHFUL_GUTTER + 14;

/**
 * @typedef {{ i?: number, kind?: string, bbox?: number[], html?: string, img?: string,
 *   fontPt?: number, linePt?: number, formula?: boolean }} FaithfulBlock
 * @typedef {{ id: string, number: string, section?: string, type?: string, blocks: number[],
 *   startsHere?: boolean, col?: number }} FaithfulQuestion
 * @typedef {{ index: number, pageNo?: number, width: number, height: number, columns?: number,
 *   mode?: "abs" | "flow", wrap?: boolean, originWidth?: number, originHeight?: number,
 *   blocks: FaithfulBlock[], questions: FaithfulQuestion[],
 *   flow?: { left: number, right: number, width: number, linePt: number },
 *   imgDims?: Record<string, number[]> }} FaithfulPage
 * @typedef {{ text?: string, short?: string, name?: string, color?: string }} TagLike
 * @typedef {{ doc?: string, paneW?: number,
 *   onChipClick?: ((q: any, p: any) => void) | null,
 *   resolveTags?: ((q: any, p: any) => TagLike[] | null) | null,
 *   assignmentBadge?: ((q: any, p: any) => { topics: number, categories: number } | null) | null }} FaithfulOpts
 */

/**
 * 行内图片占位（`@@IMG:rId123@@`）→ 真实 `<img>`。尺寸取页面 `imgDims`（原卷 pt）。
 * 只在 html 里出现（abs 页的图由 `copyImages` 单独成块）。
 * ★ 尺寸必须走 `toPx`（与文字同一 pt→px 映射）。不能写 CSS `pt`：CSS 的 1pt=1.333px
 *   是绝对单位，不随画布缩放走，实测图被放大 1.59 倍溢出栏外压住邻栏文字（108/109 页）。
 * `maxWPx`（可选）：栏宽上限，超宽时等比缩到栏内（不裁切、不失真）。
 * @param {string} html
 * @param {FaithfulPage} p
 * @param {string} doc
 * @param {(pt: number) => number} toPx 原卷 pt → 画布 px
 * @param {number} [maxWPx] 图片宽度上限（px，通常为本栏宽）
 * @returns {string}
 */
function injectImages(html, p, doc, toPx, maxWPx) {
  if (!html || html.indexOf("@@IMG:") < 0) return html;
  return html.replace(/@@IMG:(\w+)@@/g, (_m, /** @type {string} */ rid) => {
    const d = p.imgDims?.[rid];
    let w = toPx(d ? d[0] : 60);
    let h = toPx(d ? d[1] : 45);
    if (maxWPx && w > maxWPx && w > 0) {
      h = (h * maxWPx) / w;
      w = maxWPx;
    }
    const src = `/data/out/${enc(doc)}/images/${enc(rid)}.jpeg`;
    return (
      `<img class="faithful-img" src="${src}" alt="原卷插图" ` +
      `style="width:${w.toFixed(2)}px;height:${h.toFixed(2)}px;object-fit:contain;vertical-align:middle">`
    );
  });
}

/**
 * 百分比落位（与 `reconstruct.js:88-94` 的 posStyle 同一口径：页面 pt 直接除以页宽高）。
 * @param {HTMLElement} node
 * @param {number[]} bbox
 * @param {number} w
 * @param {number} h
 * @returns {HTMLElement}
 */
function posStyle(node, bbox, w, h) {
  const [x0, y0, x1, y1] = bbox;
  node.style.left = `${(x0 / w) * 100}%`;
  node.style.top = `${(y0 / h) * 100}%`;
  node.style.width = `${((x1 - x0) / w) * 100}%`;
  node.style.height = `${((y1 - y0) / h) * 100}%`;
  return node;
}

/**
 * 表格节点：沿用上游 HTML 的行/列（faithful 的 flow 页带 `<table>`）。
 * 样式写成行内，保证与 1:1 复刻页同观感（与 renderPaper 的 tableNode 同思路）。
 * @param {FaithfulBlock} b
 * @param {number} fontPx
 * @returns {HTMLElement}
 */
function tableNode(b, fontPx) {
  const box = el("div", "blk-table faithful-table-box");
  box.innerHTML = b.html ?? "";
  const table = /** @type {HTMLTableElement | null} */ (box.querySelector("table"));
  if (table) {
    table.style.borderCollapse = "collapse";
    table.style.width = "100%";
    table.style.tableLayout = "fixed";
    table.style.fontSize = `${fontPx}px`;
    for (const cell of table.querySelectorAll("td,th")) {
      const c = /** @type {HTMLElement} */ (cell);
      c.style.border = "0.5px solid #999";
      c.style.padding = "0.4px 2px";
      c.style.textAlign = "center";
      c.style.fontSize = `${fontPx}px`;
    }
  }
  return box;
}

/**
 * 1:1 复刻内核。签名与返回形状对齐 `renderPaper(p, opts)`：`{wrap, canvas, innerW}`。
 * @param {FaithfulPage} p
 * @param {FaithfulOpts} [opts]
 * @returns {{ wrap: HTMLElement, canvas: HTMLElement, innerW: number }}
 */
export function renderFaithful(p, opts = {}) {
  const {
    doc = "",
    paneW = 0,
    onChipClick = null,
    resolveTags = null,
    assignmentBadge = null,
  } = opts;
  const mode = p.mode === "flow" ? "flow" : "abs";
  const mid = p.width / 2;
  /** 题目所在栏（abs 看首块中点；flow 看数据里的 col） */
  /** @param {FaithfulQuestion} q @returns {boolean} */
  const isRight = (q) => {
    if (mode === "flow") return q.col === 1;
    const b = p.blocks[q.blocks[0]];
    return (p.columns ?? 1) >= 2 && !!b?.bbox && (b.bbox[0] + b.bbox[2]) / 2 >= mid;
  };
  const gutter = p.questions.some((q) => /^实验\d+/.test(q.number))
    ? FAITHFUL_EXP_GUTTER
    : FAITHFUL_GUTTER;
  const needsRight = p.questions.some((q) => q.startsHere !== false && isRight(q));
  const innerW = Math.max(120, paneW - gutter - (needsRight ? gutter : 0));
  /** 原卷 pt → 画布 px（页宽映射；原卷 1107pt → 588.44pt → innerW px） */
  const px = (/** @type {number} */ pt) => (pt * innerW) / (p.originWidth || p.width);

  const c = el("div", "canvas");
  c.style.aspectRatio = `${p.width} / ${p.height}`;
  c.style.width = `${innerW}px`;
  /** flow 页：题 wrapper（挂载后量它的 top 来放号牌） */
  /** @type {Map<string, HTMLElement>} */
  const qWrapById = new Map();

  if (mode === "abs") {
    p.blocks.forEach((b, i) => {
      if (!b.bbox) return;
      const node = posStyle(
        el("div", `blk blk-line blk-faithful kind-${b.kind ?? "text"}`),
        b.bbox,
        p.width,
        p.height,
      );
      if (b.kind === "image" && b.img) {
        const img = /** @type {HTMLImageElement} */ (el("img", ""));
        img.src = `/data/out/${enc(doc)}/images/${enc(b.img)}`;
        img.alt = "原卷插图";
        img.loading = "lazy";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "contain";
        node.append(img);
      } else if (b.kind === "gap") {
        node.className = "blk blk-gap";
        node.innerHTML = b.html ?? "";
        node.style.fontSize = `${px(b.fontPt ?? 15)}px`;
        node.style.lineHeight = "1.5";
        node.style.textAlign = "center";
        node.style.border = "0.6pt dashed #c9c2b2";
        node.style.color = "#a89f8c";
        node.style.background = "#fcfbf7";
        node.style.whiteSpace = "normal";
        node.style.display = "flex";
        node.style.alignItems = "center";
        node.style.justifyContent = "center";
      } else {
        const txt = el("span", "txt");
        // ★ 公式直通：html（MathML）原样写入，绝不过 prettifyLatex（G2-5）
        txt.innerHTML = injectImages(b.html ?? "", p, doc, px);
        // ★ 字号只认 fontPt（原卷 19pt），行盒高另用 linePt（G2-7）
        txt.style.fontSize = `${px(b.fontPt ?? 19)}px`;
        txt.style.lineHeight = `${px(b.linePt ?? 16.4)}px`;
        // 行内公式框在 DOCX 里常比公式本身窄（bbox 29pt 却要放 60pt 的 5×10^18）。
        // 严格按 bbox 限宽会让文字溢出到邻栏/纸张外（截图验收 A5 实测 4 处）。
        // 做法：让块宽按内容自适应，但上限锁在**本栏右缘**，既不裁字，也不越栏。
        // left/top 不变 ⇒ 1:1 纵向位置保留。
        const x0pt = b.bbox?.[0] ?? 0;
        const rightEdge = () => {
          // 右栏块从右半页开始，右缘用页宽；左栏块到栏分界
          return x0pt > (p.originWidth ?? p.width) / 2
            ? (p.originWidth ?? p.width) - 8
            : (p.originWidth ?? p.width) / 2 - 8;
        };
        if (p.wrap) {
          // LO 坐标页：块定位于首片段，宽度已由 posStyle 按 bbox 百分比给足，
          // 块内按栏宽换行（字号/行距=DOC 实测值 ⇒ 拆行位置与 DOC 渲染一致）。
          // 注意：不能用 px(bbox宽) 覆盖宽度——px 是原卷 pt 换算，bbox 是 sheet pt，
          // 会把宽度砍半（实测 120/226）。
          // 宽度交由 posStyle 按 bbox 百分比设置，这里不覆盖、不清空。
          txt.style.whiteSpace = "normal";
        } else {
          node.style.width = "auto";
          node.style.maxWidth = `${px(Math.max(20, rightEdge() - x0pt))}px`;
          txt.style.whiteSpace = "nowrap";
        }
        node.append(txt);
      }
      node.dataset.bi = String(i);
      c.append(node);
    });
  } else {
    const flow = p.flow ?? { left: 0, right: p.width / 2, width: p.width / 2 - 10, linePt: 23.3 };
    const cols = [0, 1].map((k) => {
      const col = el("div", "faithful-col");
      col.style.position = "absolute";
      col.style.top = "0";
      col.style.left = `${((k === 0 ? flow.left : flow.right) / p.width) * 100}%`;
      col.style.width = `${(flow.width / p.width) * 100}%`;
      col.style.lineHeight = `${px(flow.linePt)}px`;
      c.append(col);
      return col;
    });
    const byIndex = new Map(p.blocks.map((b, i) => [i, b]));
    p.questions.forEach((q) => {
      const col = cols[q.col === 1 ? 1 : 0];
      const qWrap = el("div", "faithful-q");
      qWrapById.set(q.id, qWrap);
      (q.blocks ?? []).forEach((bi) => {
        const b = byIndex.get(bi);
        if (!b) return;
        const node = el("div", `blk blk-flow blk-faithful kind-${b.kind ?? "text"}`);
        node.style.position = "relative";
        node.style.whiteSpace = "normal";
        node.style.margin = "0";
        if (b.kind === "table" && b.html) {
          node.append(tableNode(b, px(b.fontPt ?? 19)));
        } else {
          const txt = el("span", "txt");
          // 图片宽度钳到本栏宽内（rId444 缩放后 234pt ≥ 栏宽 232pt，不钳会溢出到邻栏）
          const colWPx = (flow.width / p.width) * innerW;
          txt.innerHTML = injectImages(b.html ?? "", p, doc, px, colWPx);
          txt.style.fontSize = `${px(b.fontPt ?? 19)}px`;
          txt.style.lineHeight = `${px(flow.linePt)}px`;
          node.append(txt);
        }
        node.dataset.bi = String(bi);
        qWrap.append(node);
      });
      col.append(qWrap);
    });
  }

  // ── 号牌 / 标签层：与 renderPaper 一样挂在画布外侧的 wrap 上（.canvas 会裁切） ──
  const wrap = el("div", "paper-wrap");
  wrap.style.position = "relative";
  wrap.style.marginLeft = `${gutter}px`;
  if (needsRight) wrap.style.marginRight = `${gutter}px`;
  wrap.append(c);

  const canvasH = (innerW * p.height) / p.width;
  /** @type {{ key: string, q: FaithfulQuestion, tags: TagLike[], side: "left" | "right", topPx: number }[]} */
  const tagEntries = [];
  /** @type {{ chip: HTMLElement, qWrap: HTMLElement }[]} */
  const flowChips = [];

  for (const q of p.questions) {
    if (q.startsHere === false) continue;
    const right = isRight(q);
    const isExperiment = /^实验\d+/.test(q.number);
    const chip = el("span", `q-chip plain${isExperiment ? " exp" : ""}`, q.number);
    chip.dataset.qid = q.id;
    chip.title = `${isExperiment ? q.number : `第${q.number}题`}${
      onChipClick ? (resolveTags ? "（点击看详情 / 增删标签）" : "（点击看详情）") : ""
    }`;
    const asg = assignmentBadge ? assignmentBadge(q, p) : null;
    if (asg && (asg.topics || asg.categories)) {
      const tb = el("span", "teach-badge", `${asg.topics}·${asg.categories}`);
      tb.title = `${asg.topics} 个专题 · ${asg.categories} 个类别`;
      chip.append(tb);
    }
    if (onChipClick) chip.addEventListener("click", () => onChipClick(q, p));
    const tags = resolveTags ? resolveTags(q, p) ?? [] : [];
    if (mode === "abs") {
      const first = p.blocks[q.blocks[0]];
      chip.style.top = `${((first?.bbox?.[1] ?? 0) / p.height) * 100}%`;
      if (right) chip.style.left = "calc(100% + 4px)";
      else chip.style.right = "calc(100% + 4px)";
      if (tags.length && first?.bbox) {
        tagEntries.push({
          key: q.id,
          q,
          tags,
          side: right ? "right" : "left",
          topPx: (first.bbox[1] / p.height) * canvasH,
        });
      }
    } else {
      // flow：位置要等挂载后量（行高由浏览器排出来），先挂在 wrap 上，rAF 里补 top
      if (right) chip.style.left = "calc(100% + 4px)";
      else chip.style.right = "calc(100% + 4px)";
      const qWrap = qWrapById.get(q.id);
      if (qWrap) flowChips.push({ chip, qWrap });
      if (tags.length) tagEntries.push({ key: q.id, q, tags, side: right ? "right" : "left", topPx: 0 });
    }
    wrap.append(chip);
  }

  /**
   * 标签短码列（full / count 两级）：与 renderPaper 的落位规则一致，只在本内核里补挂。
   * chip 级降级时把角标挂回该题号牌（标签必须在页面上留痕，绝不静默）。
   */
  const placeStacks = () => {
    const placed = tagStackPlacements(
      tagEntries.map((e) => ({ key: e.key, side: e.side, topPx: e.topPx, tagCount: e.tags.length })),
      canvasH,
    );
    for (const e of tagEntries) {
      const pl = placed.get(e.key);
      if (!pl) continue;
      if (pl.level === "chip") {
        const chip = /** @type {HTMLElement | null} */ (
          wrap.querySelector(`.q-chip[data-qid="${CSS.escape(e.key)}"]`)
        );
        if (chip && !chip.querySelector(".qtag-badge")) {
          chip.append(el("span", "qtag-badge", String(pl.tagCount)));
        }
        continue;
      }
      const { visible, more, countBadge } = stackContents(e.tags.length, pl.level);
      const stack = el("div", `qtag-stack qtag-${pl.level}`);
      if (pl.side === "right") stack.style.left = "calc(100% + 4px)";
      else stack.style.right = "calc(100% + 4px)";
      stack.style.top = `${pl.topPx}px`;
      stack.title = `标签：${e.tags.map((t) => t.name).join("、")}（点题号可增删）`;
      for (const t of e.tags.slice(0, visible)) {
        const code = el("span", "qtag", t.short);
        code.style.background = t.color ?? "";
        code.title = t.name ?? "";
        stack.append(code);
      }
      if (more) stack.append(el("span", "qtag qtag-more", `+${more}`));
      if (countBadge) stack.append(el("span", "qtag qtag-count", String(countBadge)));
      wrap.append(stack);
    }
  };
  if (mode === "abs") placeStacks();

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (mode === "flow") {
        // 挂载后量真实几何：号牌落位 + 把流式块的实际 bbox 写回页对象（挑题命中要用）
        const cr = c.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        if (cr.width > 0) {
          const sx = p.width / cr.width;
          const sy = p.height / cr.height;
          p.blocks.forEach((b, i) => {
            const node = /** @type {HTMLElement | null} */ (c.querySelector(`[data-bi="${i}"]`));
            if (!node) return;
            const r = node.getBoundingClientRect();
            b.bbox = [
              (r.left - cr.left) * sx,
              (r.top - cr.top) * sy,
              (r.right - cr.left) * sx,
              (r.bottom - cr.top) * sy,
            ];
          });
          for (const it of flowChips) {
            const r = it.qWrap.getBoundingClientRect();
            it.chip.style.top = `${r.top - wr.top}px`;
          }
        }
        placeStacks();
      }
      fitTables(wrap);
    });
  }

  return { wrap, canvas: c, innerW };
}
