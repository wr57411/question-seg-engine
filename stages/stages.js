// stages/stages.js —— 阶段样品展示前端。
// 解耦红线：本文件不 import 引擎代码，只消费
//   /data/out/<docId>/stages.json（快照契约，见 scripts/export-stages.ts）
//   /data/out/<docId>/images/<裸文件名>、/data/out/<docId>/origin.pdf（原卷对照）
//   /viewer/（最终成品内嵌）。
// latex-display.js / font-metrics.js / uncovered-layout.js 为本目录纯函数模块（无引擎依赖），
// 分别负责公式展示美化、字号与全角宽度度量、解析遗漏标签落位（后两者的数学与证据见其头注释）。

import { prettifyLatex } from "./latex-display.js";
import { baseFontOfPage, clampByWidth, fontForBlock, fontForRawBlock, isVerticalText } from "./font-metrics.js";
import { chipPlacements, contentLabelPlacements } from "./uncovered-layout.js";
import { mergePlan } from "./block-dedup.js";

const DEFAULT_DOC = "23必刷题 2相互作用";

const STAGES = [
  { key: "origin", t: "原卷", q: "原文长什么样？" },
  { key: "raw", t: "原料", q: "机器读到了什么？" },
  { key: "order", t: "阅读顺序", q: "电脑按什么顺序读？" },
  { key: "seg", t: "切题", q: "题目切对了吗？" },
  { key: "qa", t: "质检", q: "电脑哪里没把握？" },
  { key: "final", t: "成品", q: "最终长什么样？" },
  { key: "compare", t: "对比", q: "跟原卷像不像？" },
];

const EXPLAIN = {
  origin: {
    do: "这是给电脑吃的原始试卷（PDF 原文，双栏排版）。后面每个阶段都是对这份原文的逐步理解，随时回到这一步对照。",
    look: "看：先记住某页的样子——比如第 1 页的双栏、插图位置、「第二章 相互作用」的居中大标题——再去后面的阶段比对有没有走样。",
  },
  raw: {
    do: "PDF 先由解析程序（MinerU）转成「带坐标的文字块」。它只知道页面上哪里有什么，还不知道哪些是题目。",
    look: "看：有没有整段文字没被框住（漏识别）？图片框的位置对不对？标题有没有被认成正文？",
  },
  order: {
    do: "引擎把大块拆成一行一行的小块，自动判断这页是单栏还是双栏，再按人眼的阅读习惯给每行编号。",
    look: "看：红色编号 1→2→3… 是否顺着走（双栏页应先读完整左栏再读右栏）？虚线分栏位置对不对？",
  },
  seg: {
    do: "引擎按「题号 / 选项 / 答案区」的文字特征，把行块归组成一道道题。蓝框=选择题，灰框=主观题，红框=电脑自己没把握的题。跨栏、跨页的题会在每一部分都挂牌子。",
    look: "看：每个框是否完整套住一道题（题干+选项+图）？有没有把两题并成一题、或一题切两半？灰掉的行块是页眉页脚等不属于任何题的部分，属正常。",
  },
  qa: {
    do: "引擎给自己打分：规则匹配越完整，可信度越高。低于阈值（75%）的题被标记「需人工校对」；另有逐条诊断记录，是规则引擎发现的所有疑点（含已自行兜底的）。",
    look: "看：被标红的题是不是真有问题？没被标红的题里，能不能肉眼发现电脑没察觉的错误？页面底部的「公式噪声」扫描量化了上游 LaTeX 的可读性问题——它的计数应随算法迭代下降。",
  },
  final: {
    do: "全部结构化之后，最终成品是一份可阅读、可开关答案的试卷页（与「最终成品 viewer」同一份数据）。这是**阅读版**——为答题/检索重新排版；与原卷的排版保真度请切到下一步「对比」检查。",
    look: "看：阅读版整体是否可用——题目排版、答案开关、公式与图片是否正常。",
  },
  compare: {
    do: "左边是原卷，右边是用结构化数据按原始坐标重建的纸面——引擎读到什么就画什么，不借助原卷图像。排版保真度一目了然。",
    look: "看：两边是否逐块对得上——文字有没有少、图片在不在原位、题号顺序是否一致。右侧明显空掉/错位的地方，就是引擎的问题所在。**洋红标记框=「解析遗漏·内容级」**（原卷有墨迹、解析块没覆盖到，含上游漏识别的整行/整段）；**灰色细虚线=「解析遗漏·家具级」**（页眉装饰/栏间竖线/页边标等版式墨迹，非内容丢失，悬停看详情）。另外：上游偶发把**同一行**读成两个重叠的块，展示层会把它们**合并成一行**（悬停该行可见「已合并」说明），不丢内容、也不叠字。",
  },
};

const TYPE_LABEL = {
  title: "标题", text: "正文", image: "图片", table: "表格", chart: "图表",
  equation: "公式", interline_equation: "公式", abandon: "弃用",
};
const TYPE_LABEL_CN = (t) => TYPE_LABEL[t] ?? t;

const NOISE_KIND_LABEL = {
  "spaced-digits": "数字间空格",
  wrapper: "字体包装命令",
  "left-right": "\\left/\\right 定界",
  "degree-spelled": "度符号拼写",
  unbalanced: "花括号失衡",
  long: "超长公式",
};

const state = { doc: null, effectiveDoc: null, data: null, stage: 0, page: 0, highlight: null };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const enc = encodeURIComponent;

/* ── 数据加载（与 viewer 相同的宽容策略：doc 参数非法时回退默认卷一次） ── */
async function fetchSnapshot(doc) {
  const res = await fetch(`/data/out/${enc(doc)}/stages.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function load() {
  const params = new URLSearchParams(location.search);
  const asked = params.get("doc") || DEFAULT_DOC;
  state.doc = asked;
  try {
    state.data = await fetchSnapshot(asked);
    state.effectiveDoc = asked;
  } catch {
    if (asked !== DEFAULT_DOC) {
      try {
        state.data = await fetchSnapshot(DEFAULT_DOC);
        state.effectiveDoc = DEFAULT_DOC;
        notice(`参数里的「${asked}」没有快照，已回退默认卷「${DEFAULT_DOC}」。`, false);
      } catch {
        missingSnapshot(asked);
        return;
      }
    } else {
      missingSnapshot(asked);
      return;
    }
  }
  if (state.effectiveDoc !== state.doc) {
    const url = new URL(location);
    url.searchParams.set("doc", state.effectiveDoc);
    history.replaceState(null, "", url);
  }
  $("doc-name").textContent = state.effectiveDoc;
  // 直达阶段/页码：?stage=6&page=1（便于分享链接，也供截图审计免交互取图）
  const wantStage = Number(params.get("stage"));
  const wantPage = Number(params.get("page"));
  if (Number.isInteger(wantStage) && wantStage >= 0 && wantStage < STAGES.length) state.stage = wantStage;
  if (Number.isInteger(wantPage) && wantPage >= 0 && wantPage < state.data.pages.length) state.page = wantPage;
  $("link-viewer").href = `/viewer/?doc=${enc(state.effectiveDoc)}`;
  buildStepper();
  buildPager();
  render();
}

function missingSnapshot(name) {
  state.effectiveDoc = null;
  notice(
    `没有找到「${name}」的展示快照。先运行 <code>npm run stages</code> 生成快照（并启动服务），再刷新本页。`,
    true,
  );
  $("doc-name").textContent = name;
}

function notice(html, isError) {
  const n = $("notice");
  n.innerHTML = html; // 内容为本页面自身生成的提示，不含用户数据文本
  n.classList.toggle("error", !!isError);
  n.hidden = false;
}

/* ── 步进条 / 工具条 ── */
function buildStepper() {
  const nav = $("stepper");
  nav.replaceChildren();
  STAGES.forEach((s, i) => {
    const b = el("button", "step-btn");
    b.append(
      el("span", "no", i === 0 ? "原" : String(i)),
      el("span", "t", s.t),
      el("span", "q", s.q),
    );
    b.addEventListener("click", () => {
      state.stage = i;
      state.highlight = null;
      render();
    });
    nav.append(b);
  });
}

function buildPager() {
  const sel = $("page-jump");
  sel.replaceChildren();
  state.data.pages.forEach((p) => {
    const o = el("option", "", `第 ${p.index + 1} 页`);
    o.value = String(p.index);
    sel.append(o);
  });
  sel.addEventListener("change", () => {
    state.page = Number(sel.value);
    render();
  });
  $("page-prev").addEventListener("click", () => {
    if (state.page > 0) { state.page--; render(); }
  });
  $("page-next").addEventListener("click", () => {
    if (state.page < state.data.pages.length - 1) { state.page++; render(); }
  });
}

function syncToolbar(p) {
  const last = state.data.pages.length - 1;
  $("page-label").textContent = `第 ${p.index + 1} / ${state.data.pages.length} 页`;
  $("page-prev").disabled = p.index === 0;
  $("page-next").disabled = p.index === last;
  $("page-jump").value = String(p.index);
  const origin = $("origin-link");
  origin.href = `/data/out/${enc(state.effectiveDoc)}/origin.pdf#page=${p.index + 1}`;
  origin.hidden = false;
  $("page-meta").textContent =
    `判定 ${p.columns} 栏 · ${p.blocks.length} 行块 · ${p.questions.length} 题` +
    (p.questions.some((q) => q.status === "needs_review") ? " · 含待复核题" : "");
}

/* ── 画布与阶段渲染 ── */
function paperCanvas(p) {
  const c = el("div", "canvas");
  c.style.aspectRatio = `${p.width} / ${p.height}`;
  return c;
}

function posStyle(node, bbox, w, h) {
  const [x0, y0, x1, y1] = bbox;
  node.style.left = `${(x0 / w) * 100}%`;
  node.style.top = `${(y0 / h) * 100}%`;
  node.style.width = `${((x1 - x0) / w) * 100}%`;
  node.style.height = `${((y1 - y0) / h) * 100}%`;
  return node;
}

const CANVAS_W = 760; // 与 CSS --canvas-w 一致，用于字号换算
// 字号与全角宽度度量见 ./font-metrics.js（纯函数模块，有测试锁定；证据见其头注释）。

/** 行级块节点（阶段 2/3 与对比模式共用；canvasW 为画布像素宽，用于字号换算）
 *  mergeCtx：本页「同页块级重复」的**并集合并**上下文（block-dedup.js，判据只此一处定义）：
 *   - `drop`：被合并掉的块（其内容已进合并文本）→ 返回 null，调用方跳过（**不丢内容**）；
 *   - `keep`：承载块 → 用**合并文本**与两块 **bbox 并集**渲染（更接近原卷该行真实范围）。
 *  返回 null 表示该块不渲染。 */
function blockNode(b, p, canvasW = CANVAS_W, baseFont = null, mergeCtx = null) {
  if (mergeCtx?.drop.has(b.i)) return null;
  const m = mergeCtx?.keep.get(b.i);
  const blk = m ? { ...b, text: m.text, bbox: m.bbox } : b;
  const node = posStyle(el("div", `blk blk-line kind-${blk.kind}`), blk.bbox, p.width, p.height);
  node.title = m ? `${blk.text} ｜（上游把本行读成两个重叠块，已合并）` : blk.text;
  if (blk.kind === "image" && blk.img) {
    const img = el("img");
    img.src = `/data/out/${enc(state.effectiveDoc)}/images/${enc(blk.img)}`;
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
function mergeContext(p) {
  return mergePlan(p.blocks);
}

/** 追加本页行级块节点（跳过被合并掉的块；返回与 p.blocks 对齐的节点数组，null = 未渲染）。 */
function appendBlockNodes(c, p, canvasW, baseFont, mergeCtx) {
  const nodes = p.blocks.map((b) => blockNode(b, p, canvasW, baseFont, mergeCtx));
  for (const n of nodes) if (n) c.append(n);
  return nodes;
}

function renderOrigin(p) {
  $("canvas-wrap").replaceChildren();
  const total = state.data.pages.length;
  if ((state.data.originPages ?? 0) >= total && total > 0) {
    // 逐页 PNG（pdftoppm 渲染）：任何浏览器可靠显示
    const pad = String(total).length;
    const img = el("img", "origin-img");
    img.src = `/data/out/${enc(state.effectiveDoc)}/pages/page-${String(p.index + 1).padStart(pad, "0")}.png`;
    img.alt = `原卷第 ${p.index + 1} 页`;
    $("canvas-wrap").append(img);
  } else {
    // 降级：PDF 内嵌（依赖浏览器 PDF 查看器）
    const f = el("iframe", "origin-frame");
    f.src = `/data/out/${enc(state.effectiveDoc)}/origin.pdf#page=${p.index + 1}`;
    f.title = `原卷第 ${p.index + 1} 页`;
    $("canvas-wrap").append(f);
  }
}

function renderRaw(p) {
  const c = paperCanvas(p);
  // 阶段 1 是**段级块**（整段多行）：行高模型不成立，改用「按框宽适配」（R1，见 font-metrics.js）
  renderDiscardedInto(c, p, CANVAS_W);
  for (const b of p.raw) {
    const node = posStyle(el("div", `blk blk-raw type-${b.type}`), b.bbox, p.width, p.height);
    const shown = prettifyLatex(b.text);
    node.title = `[${TYPE_LABEL_CN(b.type)}] ${b.text}`;
    const txt = el("span", "txt");
    if (shown) txt.innerHTML = shown;
    else txt.textContent = `(${TYPE_LABEL_CN(b.type)})`;
    txt.style.fontSize = `${fontForRawBlock(b, p.width, CANVAS_W)}px`;
    node.append(txt, el("span", "tag", TYPE_LABEL_CN(b.type)));
    c.append(node);
  }
  ocrFillInto(c, p, CANVAS_W); // 阶段 1 也呈现 OCR 候选补全（先画，标记后画才盖得住）
  uncoveredInto(c, p, CANVAS_W); // 阶段 1 也标出解析遗漏（Task 16）
  return c;
}

const DISCARDED_LABEL = {
  header: "页眉", footer: "页脚", page_number: "页码", aside_text: "侧栏",
};

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
 * 所以引擎文本一个字都不动，候选只以**青绿虚线框**呈现（角标默认隐藏、悬停才出，
 * 避免「标记盖住正文」），悬停可见来源、宽度比、证据路径与 OCR 原始输出（可核对）。
 */
function ocrFillInto(c, p, canvasW = CANVAS_W) {
  const items = (p.ocrFill ?? []).filter((x) => x.accepted);
  if (!items.length) return;
  const baseFont = baseFontOfPage(p.blocks, p.width, canvasW);
  for (const it of items) {
    const isPage = it.source === "page";
    const node = posStyle(el("div", "blk blk-ocr"), it.win ?? it.bbox, p.width, p.height);
    node.title =
      `OCR 候选补全（非引擎文本，请核对）\n来源：${isPage ? "整页 OCR" : "区域裁图"}\n` +
      `宽度比 ${it.ratio}（≈1 为合理；${isPage ? "整页来源按**洞自身**宽度算" : "裁图来源按窗口宽算"}）\n` +
      `证据：${it.crop}\nOCR 原始输出：${it.raw}`;
    const txt = el("span", "txt");
    txt.textContent = it.text;
    txt.style.fontSize = `${baseFont}px`;
    node.append(txt, el("span", "tag", isPage ? "OCR·整页" : "OCR·裁图"));
    c.append(node);
  }
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
 */
function uncoveredInto(c, p, canvasW = CANVAS_W) {
  const all = p.uncovered ?? [];
  if (!all.length) return;
  // 已被 OCR 候选补全覆盖的区域：不再画洋红框（否则会盖住候选文本），
  // 改由 ocrFillInto 的青绿候选块表达「这里原本缺、现已补上候选」。
  const filled = (p.ocrFill ?? []).filter((x) => x.accepted).map((x) => x.bbox);
  const isFilled = (r) =>
    filled.some((f) => r[0] < f[2] && r[2] > f[0] && r[1] < f[3] && r[3] > f[1]);
  const content = all.filter((r) => r.kind !== "furniture" && !isFilled(r.bbox));
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
 * canvasW 为**该视图**的画布像素宽：阶段 1–5 传 CANVAS_W(760)、对比模式传 PANE_W(460)；
 * 曾硬编码 CANVAS_W → 对比栏内丢弃块字号偏大 760/460 = 1.65×（R2）。 */
function renderDiscardedInto(c, p, canvasW = CANVAS_W) {
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

function renderOrder(p) {
  const c = paperCanvas(p);
  if (p.centers.length >= 2) {
    const mid = ((p.centers[0] + p.centers[1]) / 2 / p.width) * 100;
    const left = el("div", "col-tint");
    left.style.left = "0%";
    left.style.width = `${mid}%`;
    const right = el("div", "col-tint");
    right.style.left = `${mid}%`;
    right.style.width = `${100 - mid}%`;
    const divider = el("div", "col-divider");
    divider.style.left = `${mid}%`;
    c.append(left, right, divider);
  }
  const baseFont = baseFontOfPage(p.blocks, p.width, CANVAS_W);
  appendBlockNodes(c, p, CANVAS_W, baseFont, mergeContext(p)); // 同页块级重复并集合并（Task 15）
  p.order.forEach((blockIdx, seq) => {
    const b = p.blocks[blockIdx];
    if (!b) return;
    const badge = el("span", "order-badge", String(seq + 1));
    badge.style.left = `${(b.bbox[0] / p.width) * 100}%`;
    badge.style.top = `${(b.bbox[1] / p.height) * 100}%`;
    badge.style.transform = "translate(-9px, -9px)";
    c.append(badge);
  });
  return c;
}

function renderSeg(p) {
  const c = paperCanvas(p);
  const baseFont = baseFontOfPage(p.blocks, p.width, CANVAS_W);
  // 同页块级重复并集合并（Task 15）：被合并掉的块不渲染 → 节点数组与 p.blocks 按位对齐（null = 未渲染）
  const blockNodes = appendBlockNodes(c, p, CANVAS_W, baseFont, mergeContext(p));

  const covered = new Set();
  for (const q of p.questions) for (const i of q.blocks) covered.add(i);
  blockNodes.forEach((n, i) => {
    if (n && !covered.has(p.blocks[i].i)) n.classList.add("orphan");
  });

  // 逐块描边（跨栏/跨页题的并集矩形会罩住整页，改按块着色）+ 首块挂牌
  for (const q of p.questions) {
    const colorCls = q.status === "needs_review" ? "needs_review" : q.type;
    for (const bi of q.blocks) {
      const b = p.blocks[bi];
      if (!b) continue;
      const o = posStyle(el("div", `q-block-outline ${colorCls}`), b.bbox, p.width, p.height);
      if (state.highlight && q.id === state.highlight) o.classList.add("highlight");
      c.append(o);
    }
    const first = q.blocks.map((i) => p.blocks[i]).find(Boolean);
    if (first) {
      const chip = el(
        "span",
        `q-chip ${colorCls}`,
        `第${q.number}题 · ${q.type === "choice" ? "选择" : "主观"} · ${Math.round(q.confidence * 100)}%`,
      );
      // 牌子内嵌在题目首块左上角：只标注真正的题目，绝不飘到页眉等非题目区
      chip.style.left = `${(first.bbox[0] / p.width) * 100}%`;
      chip.style.top = `${(first.bbox[1] / p.height) * 100}%`;
      chip.style.transform = "translate(0, -1px)";
      chip.addEventListener("click", () => showDetail(q, p));
      c.append(chip);
    }
  }
  ocrFillInto(c, p, CANVAS_W); // 阶段 3 也呈现 OCR 候选补全
  uncoveredInto(c, p, CANVAS_W); // 阶段 3 也标出解析遗漏（Task 16）
  return c;
}

function showDetail(q, p) {
  const d = $("detail");
  d.hidden = false;
  d.replaceChildren();
  const close = el("button", "close", "关闭 ×");
  close.addEventListener("click", () => { d.hidden = true; });
  d.append(close, el("h3", "", `第 ${q.number} 题（${q.section || "未识别大题"}）`));
  d.append(el("p", "kv", `页码：第 ${p.index + 1} 页 · 题型：${q.type === "choice" ? "选择题" : "主观题"} · 状态：${q.status === "needs_review" ? "需人工校对" : "正常"}`));
  d.append(el("p", "kv", `可信度：${Math.round(q.confidence * 100)}%（低于 75% 自动标记）`));
  if (q.reasons.length) {
    d.append(el("p", "reason", `电脑给出的原因：${q.reasons.join("；")}`));
  }
  const texts = q.blocks.map((i) => p.blocks[i]?.text).filter(Boolean);
  const preview = el("p", "kv");
  preview.innerHTML = `本页内容预览：${prettifyLatex(texts.join(" / ").slice(0, 200)) || "（无文本）"}`;
  d.append(preview);
  d.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderQA() {
  const qs = [];
  // 同一道题可能跨页出现在多页，质检清单按（题号 id）去重
  const seen = new Set();
  state.data.pages.forEach((p) =>
    p.questions.forEach((q) => {
      if (!seen.has(q.id)) {
        seen.add(q.id);
        qs.push({ ...q, page: p.index });
      }
    }),
  );
  qs.sort((a, b) => a.confidence - b.confidence);
  const flagged = qs.filter((q) => q.status === "needs_review");
  const avg = qs.length ? qs.reduce((a, q) => a + q.confidence, 0) / qs.length : 0;
  const diagTotal = state.data.reviews.length;

  const extra = $("stage-extra");
  extra.replaceChildren();
  const sum = el("div", "qa-summary");
  const chip = (n, l, warn) => {
    const c = el("div", `qa-chip${warn ? " warn" : ""}`);
    c.append(el("span", "n", String(n)), el("span", "l", l));
    return c;
  };
  const ansTotal = state.data.answerEntriesTotal ?? 0;
  sum.append(
    chip(qs.length, "共切出题目"),
    chip(flagged.length, "需人工校对", flagged.length > 0),
    chip(`${Math.round(avg * 100)}%`, "平均可信度"),
    chip(diagTotal, "诊断记录（含已兜底）"),
    ansTotal === 0
      ? chip("—", "本卷无答案区")
      : chip(`${state.data.stats.answersMatched ?? "—"}/${ansTotal}`, "答案已对号"),
  );
  extra.append(sum);
  extra.append(el("p", "qa-note", `说明：诊断记录是规则引擎发现的所有疑点；只有可信度低于 75% 的题才会被标记「需人工校对」。诊断多而待复核少是正常现象（多数疑点已被规则自行兜底）。`));

  // 公式噪声检测区（检测不改写）：量化上游 LaTeX 可读性问题，计数随清洗规则迭代下降
  const noise = state.data.formulaNoise;
  if (noise && noise.totalFormulas > 0) {
    const nsum = el("div", "qa-summary");
    nsum.append(
      chip(noise.totalFormulas, "公式总数"),
      chip(noise.noisyFormulas, "含噪声公式", noise.noisyFormulas > 0),
      chip(noise.questionsAffected, "受影响题目"),
    );
    extra.append(nsum);
    const kinds = Object.entries(noise.kindCounts ?? {}).filter(([, n]) => n > 0);
    if (kinds.length) {
      extra.append(
        el("p", "qa-note", `噪声类型：${kinds.map(([k, n]) => `${NOISE_KIND_LABEL[k] ?? k} ${n} 处`).join("；")}。检测不改写数据——展示层另有美化器让它可读；清洗规则每上线一轮，这里的计数就应下降一轮。`),
      );
    }
    const nlist = el("div", "qa-list");
    const pageOf = new Map();
    state.data.pages.forEach((p) => p.questions.forEach((q) => {
      if (!pageOf.has(q.id)) pageOf.set(q.id, p.index);
    }));
    for (const it of noise.items.slice(0, 8)) {
      const row = el("div", "qa-row noise");
      const tail = it.questionId.split(":").slice(-2).join(" ");
      row.append(
        el("span", "num", "公式噪声"),
        el("span", "meta", `${it.field === "stem" ? "题干" : "选项"} · ${tail}`),
        el("span", "why", `${it.kinds.map((k) => NOISE_KIND_LABEL[k] ?? k).join("、")}`),
      );
      const code = el("span", "noise-latex", it.latex.slice(0, 40));
      code.title = it.latex;
      row.append(code);
      row.addEventListener("click", () => {
        const pg = pageOf.get(it.questionId);
        if (pg === undefined) return;
        state.stage = 3;
        state.page = pg;
        state.highlight = it.questionId;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      nlist.append(row);
    }
    if (noise.items.length > 8) {
      nlist.append(el("p", "kv", `（仅列前 8 条，共 ${noise.items.length} 条）`));
    }
    extra.append(nlist);
  }

  const list = el("div", "qa-list");
  const why = (q) => (q.reasons.length ? q.reasons.join("；") : "规则匹配完整");
  for (const q of qs.slice(0, 60)) {
    const row = el("div", `qa-row${q.status === "needs_review" ? " flag" : ""}`);
    row.append(
      el("span", "num", `第${q.number}题`),
      el("span", "meta", `第 ${q.page + 1} 页 · ${q.type === "choice" ? "选择题" : "主观题"}`),
      el("span", "why", why(q)),
      el("span", "conf", `${Math.round(q.confidence * 100)}%`),
      el("span", "go", "看它在切题页的样子 →"),
    );
    row.addEventListener("click", () => {
      state.stage = 3;
      state.page = q.page;
      state.highlight = q.id;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    list.append(row);
  }
  if (qs.length > 60) {
    list.append(el("p", "kv", `（仅列出可信度最低的 60 题，其余 ${qs.length - 60} 题可信度更高）`));
  }
  extra.append(list);
}

function renderFinal() {
  $("canvas-wrap").replaceChildren();
  const extra = $("stage-extra");
  extra.replaceChildren();
  const f = el("iframe", "viewer-frame");
  f.src = `/viewer/?doc=${enc(state.effectiveDoc)}`;
  f.title = "最终成品 viewer";
  extra.append(f);
}

/** 对比模式：左 = 原卷页图，右 = 结构化数据按原坐标重建的纸面 */
function renderCompare(p) {
  const row = el("div", "compare-wrap");

  // 栏宽按**可用宽度**算，不写死 460：写死 + flex-wrap 会在窄窗口折行堆叠，
  // 表现为「并排没了」。paneW 同时是字号换算口径（F10/R2：对比栏必须是真实栏宽）。
  const GAP = 14;
  const avail = ($("canvas-wrap").clientWidth || 940) - 2;
  const paneW = Math.max(180, Math.min(560, Math.floor((avail - GAP) / 2)));

  const left = el("div", "compare-pane");
  left.style.width = `${paneW}px`;
  left.append(el("p", "pane-title", "原卷"));
  if ((state.data.originPages ?? 0) >= state.data.pages.length && state.data.pages.length > 0) {
    const pad = String(state.data.pages.length).length;
    const img = el("img", "origin-page-img");
    img.src = `/data/out/${enc(state.effectiveDoc)}/pages/page-${String(p.index + 1).padStart(pad, "0")}.png`;
    img.alt = `原卷第 ${p.index + 1} 页`;
    left.append(img);
  } else {
    const f = el("iframe", "origin-frame");
    f.src = `/data/out/${enc(state.effectiveDoc)}/origin.pdf#page=${p.index + 1}`;
    f.title = `原卷第 ${p.index + 1} 页`;
    left.append(f);
  }

  const right = el("div", "compare-pane");
  right.style.width = `${paneW}px`;
  right.append(el("p", "pane-title", "成品（结构化数据按原坐标重建，非原图）"));
  const c = paperCanvas(p);
  c.style.width = "100%";
  renderDiscardedInto(c, p, paneW); // 对比栏宽口径：丢弃块也必须用 paneW（R2）
  const baseFont = baseFontOfPage(p.blocks, p.width, paneW);
  appendBlockNodes(c, p, paneW, baseFont, mergeContext(p)); // 同页块级重复并集合并（Task 15）
  // 题号牌：**必须走不压正文的落位**。原先挂在题首块左上角，而块 bbox 紧贴墨迹（F1）
  // → 牌子必然盖住题首 1–3 个字（2026-10-10 DOM 实测 15 页约 90 处、每处 400–750px²，
  // 肉眼可见）。落位由 uncovered-layout.js 的 chipPlacements 算好（页边距优先，放不下则不挂）。
  const firsts = p.questions.map((q) => q.blocks.map((i) => p.blocks[i]).find(Boolean) ?? null);
  // 避让集合要含**全部会被渲染的块**（行级块 + 丢弃块），否则牌子会压到页眉/页脚的家具块上。
  const avoid = p.blocks
    .concat(p.discarded ?? [])
    .concat((p.ocrFill ?? []).filter((x) => x.accepted).map((x) => ({ bbox: x.win ?? x.bbox })));
  const chips = chipPlacements(
    firsts.map((f, k) => ({ bbox: f ? f.bbox : null, label: `第${p.questions[k].number}题`, compact: p.questions[k].number })),
    avoid,
    p.width,
    p.height,
    paneW,
  );
  p.questions.forEach((q, k) => {
    const hit = chips[k];
    if (!hit) return; // 页边距放不下 → 不挂牌（压正文比不挂牌更糟）
    const chip = el("span", "q-chip plain", hit.label);
    chip.title = `第${q.number}题（点击看详情）`;
    chip.style.left = `${(hit.rect[0] / p.width) * 100}%`;
    chip.style.top = `${(hit.rect[1] / p.height) * 100}%`;
    chip.addEventListener("click", () => showDetail(q, p));
    c.append(chip);
  });
  ocrFillInto(c, p, paneW); // 对比模式：先画 OCR 候选补全
  uncoveredInto(c, p, paneW); // 对比模式必做：把解析遗漏标在右侧重建上（Task 16）
  right.append(c);

  row.append(left, right);
  $("canvas-wrap").append(row);
  $("canvas-wrap").append(
    legend([
      ["rgba(216,27,96,.85)", "解析遗漏·内容级：原卷有墨迹、解析块未覆盖（疑似漏识别正文）"],
      ["transparent", "解析遗漏·家具级：页眉装饰/栏间竖线/页边标等版式墨迹（灰细虚线，悬停看详情）"],
    ]),
  );

  // 整页 OCR 全文（`scripts/ocr-page-fill.ts` 的产物）：**没有 bbox**，所以不能画在纸面上定位；
  // 但它有整页的**完整上下文** —— 单给一份「可通读」的对照文本，用户核对时能一眼看到
  // 被引擎漏掉的内容确实读出来了（这是整页路径最大的价值，也是裁图路径给不了的）。
  if (p.ocrFullText) {
    const d = el("details", "ocr-full");
    d.open = true;
    d.append(el("summary", "", "OCR 整页识别全文（PaddleOCR · 无位置信息 · 供逐行对照）"));
    const pre = el("pre", "ocr-full-text");
    pre.textContent = p.ocrFullText;
    d.append(pre);
    $("canvas-wrap").append(d);
  }
}

function render() {
  const p = state.data.pages[state.page];
  [...$("stepper").children].forEach((b, i) => b.classList.toggle("active", i === state.stage));
  const ex = EXPLAIN[STAGES[state.stage].key];
  const explain = $("explain");
  explain.replaceChildren();
  const doLine = el("div", "do");
  doLine.append(el("b", "", "这一步："), document.createTextNode(ex.do));
  const lookLine = el("div", "look");
  lookLine.append(el("b", "", "你该看："), document.createTextNode(ex.look));
  explain.append(doLine, lookLine);

  $("detail").hidden = true;
  const noToolbar = state.stage === 4 || state.stage === 5;
  $("toolbar").hidden = noToolbar;
  $("origin-link").hidden = noToolbar;

  const wrap = $("canvas-wrap");
  const extra = $("stage-extra");
  if (!noToolbar) extra.replaceChildren();
  wrap.replaceChildren();

  if (state.stage === 0) {
    renderOrigin(p);
    syncToolbar(p);
  } else if (state.stage === 1) {
    wrap.append(renderRaw(p));
    wrap.append(legend([
      ["rgba(179,67,43,.14)", "标题"], ["#fff", "正文"],
      ["rgba(58,107,138,.10)", "图片/表格"], ["rgba(77,124,95,.14)", "公式"],
    ]));
    syncToolbar(p);
    $("page-meta").textContent = `${p.raw.length} 个原始块`;
  } else if (state.stage === 2) {
    wrap.append(renderOrder(p));
    wrap.append(legend([
      ["rgba(179,67,43,.9)", "阅读顺序编号"], ["rgba(58,107,138,.05)", "栏区着色"], ["rgba(179,67,43,.55)", "分栏界线"],
    ]));
    syncToolbar(p);
  } else if (state.stage === 3) {
    wrap.append(renderSeg(p));
    wrap.append(legend([
      ["#3a6b8a", "选择题"], ["#8a7f66", "主观题"], ["#b3432b", "需人工校对"], ["rgba(43,42,38,.3)", "未归题块"],
    ]));
    syncToolbar(p);
  } else if (state.stage === 4) {
    renderQA();
  } else if (state.stage === 5) {
    renderFinal();
  } else {
    renderCompare(p);
    syncToolbar(p);
  }
}

function legend(items) {
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

/* 对比模式的栏宽随窗口变化 → 防抖重渲染，保证「永远并排」且字号换算口径与真实栏宽同步。 */
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (state.stage !== 6 || !state.data) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

load();
