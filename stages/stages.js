// @ts-check
// stages/stages.js —— 阶段样品展示前端。
// 解耦红线：本文件不 import 引擎代码，只消费
//   /data/out/<docId>/stages.json（快照契约，见 scripts/export-stages.ts）
//   /data/out/<docId>/images/<裸文件名>、/data/out/<docId>/origin.pdf（原卷对照）
//   /viewer/（最终成品内嵌）。
// latex-display.js / font-metrics.js / uncovered-layout.js 为本目录纯函数模块（无引擎依赖），
// 分别负责公式展示美化、字号与全角宽度度量、解析遗漏标签落位（后两者的数学与证据见其头注释）。

import { prettifyLatex } from "./latex-display.js";
import { baseFontOfPage, fontForRawBlock } from "./font-metrics.js";
// 纸面重建的**唯一实现**在 ./reconstruct.js（成品页 final/ 与本页共用，避免两套实现漂移）
import {
  CANVAS_W,
  GUTTER,
  appendBlockNodes,
  el,
  enc,
  legend,
  mergeContext,
  ocrFillInto,
  paperCanvas,
  posStyle,
  renderDiscardedInto,
  renderPaper,
  uncoveredInto,
} from "./reconstruct.js";

/**
 * 本文件消费的快照形状（只声明**本文件读过**的字段；契约权威在
 * `scripts/export-stages.ts` 的 TS interface，这里按展示层最小口径重列）。
 *
 * 为什么不 `@typedef {import("./reconstruct.js").Block} Block` 复用：
 * `reconstruct.js` 被手写的 `reconstruct.d.ts` 遮蔽（债务登记 `HANDOFF §6-29`），
 * 类型 import 过去同样拿不到，故先在本文件自带最小 typedef
 * （同 `final/tag-panel.js` 的 G05 处理：在调用点显式收窄，不为过检查写 `any`）。
 * @typedef {{ i: number, type: string, bbox: number[], text: string }} RawBlock
 * @typedef {{ i: number, bbox: number[], text?: string }} Block
 * @typedef {{ id: string, number: string, section?: string, type: string, blocks: number[], confidence: number, status: string, reasons: string[] }} PageQuestion
 * @typedef {{ index: number, width: number, height: number, columns: number, centers: number[], raw: RawBlock[], blocks: Block[], order: number[], questions: PageQuestion[], ocrFullText?: string }} Page
 * @typedef {{ questionId: string, field: string, latex: string, kinds: string[] }} NoiseItem
 * @typedef {{ totalFormulas: number, noisyFormulas: number, questionsAffected: number, kindCounts?: Record<string, number>, items: NoiseItem[] }} FormulaNoise
 * @typedef {{ pages: Page[], originPages?: number, answerEntriesTotal?: number, stats: { answersMatched?: number }, formulaNoise?: FormulaNoise, reviews: unknown[] }} Snapshot
 * @typedef {PageQuestion & { page: number }} QAItem
 */

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

/** 阶段名 → 「这一步做什么 / 该看什么」文案表：按 key 索引，Record 让取用不必命中文面键。 */
/** @type {Record<string, { do: string, look: string }>} */
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
    do: "全部结构化之后，最终成品就是**按原坐标重建的纸面**——和下一步「对比」的右侧是同一件东西（同一段代码画的），用起来像翻原版书。左侧留白里的数字就是题号标注，点一下看该题的结构化详情。",
    look: "看：这一页读起来像不像原版书——字号、分栏、插图、公式是否各就各位；题号牌是否都在留白里、没压住正文。要查「哪里可能漏读了」，切到下一步「对比」（那里会画出解析遗漏框）。",
  },
  compare: {
    do: "左边是原卷，右边是用结构化数据按原始坐标重建的纸面——引擎读到什么就画什么，不借助原卷图像。排版保真度一目了然。",
    look: "看：两边是否逐块对得上——文字有没有少、图片在不在原位、题号顺序是否一致。右侧明显空掉/错位的地方，就是引擎的问题所在。**洋红标记框=「解析遗漏·内容级」**（原卷有墨迹、解析块没覆盖到，含上游漏识别的整行/整段）；**灰色细虚线=「解析遗漏·家具级」**（页眉装饰/栏间竖线/页边标等版式墨迹，非内容丢失，悬停看详情）。另外：上游偶发把**同一行**读成两个重叠的块，展示层会把它们**合并成一行**（悬停该行可见「已合并」说明），不丢内容、也不叠字。",
  },
};

/** @type {Record<string, string>} */
const TYPE_LABEL = {
  title: "标题", text: "正文", image: "图片", table: "表格", chart: "图表",
  equation: "公式", interline_equation: "公式", abandon: "弃用",
};
/** @param {string} t @returns {string} */
const TYPE_LABEL_CN = (t) => TYPE_LABEL[t] ?? t;

/** @type {Record<string, string>} */
const NOISE_KIND_LABEL = {
  "spaced-digits": "数字间空格",
  wrapper: "字体包装命令",
  "left-right": "\\left/\\right 定界",
  "degree-spelled": "度符号拼写",
  unbalanced: "花括号失衡",
  long: "超长公式",
};

/**
 * **OCR 候选样式是否开启**（`DECISIONS §89`）：默认**关**。
 *
 * 原来默认打开，成品页/对比页整页文字被染成绿色 + 绿虚线框（`.blk-ocr`），
 * 用户看到的第一反应是「这页面是坏的」。绿色本意是「这一行是 OCR 补的、不是引擎原文」
 * （G1 可追溯），但这个信息不该糊在默认视图上 —— 需要核查时加 `?ocr=1` 或勾 final 页的开关。
 */
const CANDIDATE_STYLE = new URLSearchParams(location.search).get("ocr") === "1";

/**
 * **是否把 OCR 补行画到纸面上**（`DECISIONS §91`）：默认 **false**。
 * 整页 OCR 来源没有位置信息，硬配回洞会错位（电路 p1 把表格单元格的文字画到页眉）。
 * `?fill=1` 打开（与 final 页的「显示 OCR 补行」同口径）。
 */
const SHOW_OCR_FILL = new URLSearchParams(location.search).get("fill") === "1";

/** @type {{ doc: string | null, effectiveDoc: string | null, data: Snapshot | null, stage: number, page: number, highlight: string | null }} */
const state = { doc: null, effectiveDoc: null, data: null, stage: 0, page: 0, highlight: null };

/**
 * 取页面骨架（index.html）里的固定节点。这些 id 全部写死在骨架里、本文件的每次调用都命中，
 * ⇒ 按 `final/tag-panel.js` 的惯例在取用处显式收窄为 HTMLElement（而不是抛错改变行为）。
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/* ── 数据加载（与 viewer 相同的宽容策略：doc 参数非法时回退默认卷一次） ── */
/**
 * @param {string} doc
 * @returns {Promise<Snapshot>}
 */
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
    // location.href 与 new URL(location) 的隐式 ToString 同一个串（Location.toString() 即 href）⇒ 严格等价
    const url = new URL(location.href);
    url.searchParams.set("doc", /** @type {string} */ (state.effectiveDoc));
    history.replaceState(null, "", url);
  }
  $("doc-name").textContent = state.effectiveDoc;
  // 直达阶段/页码：?stage=6&page=1（便于分享链接，也供截图审计免交互取图）
  const wantStage = Number(params.get("stage"));
  const wantPage = Number(params.get("page"));
  if (Number.isInteger(wantStage) && wantStage >= 0 && wantStage < STAGES.length) state.stage = wantStage;
  if (Number.isInteger(wantPage) && wantPage >= 0 && wantPage < state.data.pages.length) state.page = wantPage;
  // `<a id="link-viewer">` 写死在 index.html ⇒ 收窄到 anchor 只是告诉类型系统 DOM 事实（同上 G05 口径）
  const viewerLink = /** @type {HTMLAnchorElement} */ ($("link-viewer"));
  viewerLink.href = `/viewer/?doc=${enc(/** @type {string} */ (state.effectiveDoc))}`;
  buildStepper();
  buildPager();
  render();
}

/** @param {string} name */
function missingSnapshot(name) {
  state.effectiveDoc = null;
  notice(
    `没有找到「${name}」的展示快照。先运行 <code>npm run stages</code> 生成快照（并启动服务），再刷新本页。`,
    true,
  );
  $("doc-name").textContent = name;
}

/**
 * @param {string} html
 * @param {boolean} [isError]
 */
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
  // buildPager/render*/syncToolbar 只在 load() 成功之后被调用 ⇒ state.data 此时必为快照；
  // 别名 data 只做类型收窄（同一次调用里 state.data 不会再被改写），不改任何行为。
  const data = /** @type {Snapshot} */ (state.data);
  const sel = /** @type {HTMLSelectElement} */ ($("page-jump")); // index.html 里是 <select>
  sel.replaceChildren();
  data.pages.forEach((p) => {
    const o = el("option", "", `第 ${p.index + 1} 页`);
    o.value = String(p.index);
    sel.append(o);
  });
  sel.addEventListener("change", () => {
    state.page = Number(sel.value);
    render();
  });
  const prev = /** @type {HTMLButtonElement} */ ($("page-prev"));
  const next = /** @type {HTMLButtonElement} */ ($("page-next"));
  prev.addEventListener("click", () => {
    if (state.page > 0) { state.page--; render(); }
  });
  next.addEventListener("click", () => {
    if (state.page < data.pages.length - 1) { state.page++; render(); }
  });
}

/** @param {Page} p */
function syncToolbar(p) {
  const data = /** @type {Snapshot} */ (state.data); // 同上：仅收窄，不改行为
  const doc = /** @type {string} */ (state.effectiveDoc); // 同上：load() 成功后必为字符串
  const last = data.pages.length - 1;
  $("page-label").textContent = `第 ${p.index + 1} / ${data.pages.length} 页`;
  const prev = /** @type {HTMLButtonElement} */ ($("page-prev")); // index.html 里是 <button>
  const nextBtn = /** @type {HTMLButtonElement} */ ($("page-next"));
  prev.disabled = p.index === 0;
  nextBtn.disabled = p.index === last;
  /** @type {HTMLSelectElement} */ ($("page-jump")).value = String(p.index);
  const origin = /** @type {HTMLAnchorElement} */ ($("origin-link"));
  origin.href = `/data/out/${enc(doc)}/origin.pdf#page=${p.index + 1}`;
  origin.hidden = false;
  $("page-meta").textContent =
    `判定 ${p.columns} 栏 · ${p.blocks.length} 行块 · ${p.questions.length} 题` +
    (p.questions.some((q) => q.status === "needs_review") ? " · 含待复核题" : "");
}

/* ── 各阶段渲染（纸面重建的基元在 ./reconstruct.js） ── */

/**
 * @param {Page} p
 */
function renderOrigin(p) {
  const data = /** @type {Snapshot} */ (state.data); // 同上：仅收窄，不改行为
  const doc = /** @type {string} */ (state.effectiveDoc); // 同上
  $("canvas-wrap").replaceChildren();
  const total = data.pages.length;
  if ((data.originPages ?? 0) >= total && total > 0) {
    // 逐页 PNG（pdftoppm 渲染）：任何浏览器可靠显示
    const pad = String(total).length;
    const img = el("img", "origin-img");
    img.src = `/data/out/${enc(doc)}/pages/page-${String(p.index + 1).padStart(pad, "0")}.png`;
    img.alt = `原卷第 ${p.index + 1} 页`;
    $("canvas-wrap").append(img);
  } else {
    // 降级：PDF 内嵌（依赖浏览器 PDF 查看器）
    const f = el("iframe", "origin-frame");
    f.src = `/data/out/${enc(doc)}/origin.pdf#page=${p.index + 1}`;
    f.title = `原卷第 ${p.index + 1} 页`;
    $("canvas-wrap").append(f);
  }
}

/**
 * @param {Page} p
 * @returns {HTMLElement}
 */
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
  if (SHOW_OCR_FILL) ocrFillInto(c, p, CANVAS_W, CANDIDATE_STYLE); // 阶段 1 也呈现 OCR 候选补全（先画，标记后画才盖得住）
  uncoveredInto(c, p, CANVAS_W); // 阶段 1 也标出解析遗漏（Task 16）
  return c;
}

/**
 * @param {Page} p
 * @returns {HTMLElement}
 */
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
  // `el`/`appendBlockNodes` 等的返回类型仍被 `reconstruct.d.ts` 写成 any（§6-29 债）⇒ 这里只收窄 doc 实参
  appendBlockNodes(c, p, CANVAS_W, baseFont, mergeContext(p), /** @type {string} */ (state.effectiveDoc)); // 同页块级重复并集合并（Task 15）
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

/**
 * @param {Page} p
 * @returns {HTMLElement}
 */
function renderSeg(p) {
  const c = paperCanvas(p);
  const baseFont = baseFontOfPage(p.blocks, p.width, CANVAS_W);
  // 同页块级重复并集合并（Task 15）：被合并掉的块不渲染 → 节点数组与 p.blocks 按位对齐（null = 未渲染）
  const blockNodes = appendBlockNodes(c, p, CANVAS_W, baseFont, mergeContext(p), /** @type {string} */ (state.effectiveDoc));

  /** @type {Set<number>} 被题目圈走的块下标 */
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
  if (SHOW_OCR_FILL) ocrFillInto(c, p, CANVAS_W, CANDIDATE_STYLE); // 阶段 3 也呈现 OCR 候选补全
  uncoveredInto(c, p, CANVAS_W); // 阶段 3 也标出解析遗漏（Task 16）
  return c;
}

/**
 * @param {PageQuestion} q
 * @param {Page} p
 */
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
  const data = /** @type {Snapshot} */ (state.data); // 只在 load() 成功后被调用 ⇒ 仅收窄，不改行为
  /** @type {QAItem[]} */
  const qs = [];
  // 同一道题可能跨页出现在多页，质检清单按（题号 id）去重
  /** @type {Set<string>} */
  const seen = new Set();
  data.pages.forEach((p) =>
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
  const diagTotal = data.reviews.length;

  const extra = $("stage-extra");
  extra.replaceChildren();
  const sum = el("div", "qa-summary");
  /**
   * @param {string | number} n
   * @param {string} l
   * @param {boolean} [warn]
   * @returns {HTMLElement}
   */
  const chip = (n, l, warn) => {
    const c = el("div", `qa-chip${warn ? " warn" : ""}`);
    c.append(el("span", "n", String(n)), el("span", "l", l));
    return c;
  };
  const ansTotal = data.answerEntriesTotal ?? 0;
  sum.append(
    chip(qs.length, "共切出题目"),
    chip(flagged.length, "需人工校对", flagged.length > 0),
    chip(`${Math.round(avg * 100)}%`, "平均可信度"),
    chip(diagTotal, "诊断记录（含已兜底）"),
    ansTotal === 0
      ? chip("—", "本卷无答案区")
      : chip(`${data.stats.answersMatched ?? "—"}/${ansTotal}`, "答案已对号"),
  );
  extra.append(sum);
  extra.append(el("p", "qa-note", `说明：诊断记录是规则引擎发现的所有疑点；只有可信度低于 75% 的题才会被标记「需人工校对」。诊断多而待复核少是正常现象（多数疑点已被规则自行兜底）。`));

  // 公式噪声检测区（检测不改写）：量化上游 LaTeX 可读性问题，计数随清洗规则迭代下降
  const noise = data.formulaNoise;
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
    /** @type {Map<string, number>} 题号 id → 首次出现的页下标 */
    const pageOf = new Map();
    data.pages.forEach((p) => p.questions.forEach((q) => {
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
  /** @param {QAItem} q @returns {string} */
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

/**
 * 阶段 5「成品」= **按原坐标重建的纸面**（与「对比」右侧同一实现，见 ./reconstruct.js）。
 *
 * 2026-10-14 用户定的调子：「成品跟这个对比生成的那个是一样的，这样我使用时可以更接近使用原版书」。
 * 所以这里不再是「卡片式阅读版」（那个仍在 `/viewer/`，供检索/答案开关/质检用）。
 *
 * `diagnostics: false` —— 成品是给人读的，洋红「解析遗漏」框/灰虚线丢弃块**原版书上没有**，
 * 默认画就不像原版书了；要查漏识别请切到「对比」（那里全开）。
 * 题号牌保留：它就是用户要的题号标注，且挂在留白里、不压正文。
 */
/** @param {Page} p */
function renderFinal(p) {
  const doc = /** @type {string} */ (state.effectiveDoc); // 只在 load() 成功后被调用 ⇒ 仅收窄，不改行为
  $("canvas-wrap").replaceChildren();
  const extra = $("stage-extra");
  extra.replaceChildren();
  const holder = el("div", "final-wrap");
  holder.append(
    renderPaper(p, {
      doc,
      paneW: CANVAS_W,
      diagnostics: false,
      candidateStyle: CANDIDATE_STYLE,
      ocrFill: SHOW_OCR_FILL,
      onChipClick: showDetail,
    }).wrap,
  );
  $("canvas-wrap").append(holder);

  const note = el("p", "final-note");
  note.innerHTML =
    "成品 = 结构化数据按原坐标重建的纸面（与原卷逐块对位，非原图）。" +
    `完整成品页（整册浏览 · 可切审计标记）：<a href="/final/?doc=${enc(doc)}" target="_blank" rel="noopener">打开成品页 ↗</a>` +
    ` · 要检索/答案开关：<a href="/viewer/?doc=${enc(doc)}" target="_blank" rel="noopener">阅读版 ↗</a>` +
    " · 要查漏识别：上一步「对比」。";
  extra.append(note);
}

/** 对比模式：左 = 原卷页图，右 = 结构化数据按原坐标重建的纸面 */
/** @param {Page} p */
function renderCompare(p) {
  const data = /** @type {Snapshot} */ (state.data); // 只在 load() 成功后被调用 ⇒ 仅收窄，不改行为
  const doc = /** @type {string} */ (state.effectiveDoc); // 同上
  const row = el("div", "compare-wrap");

  // 栏宽按**可用宽度**算，不写死 460：写死 + flex-wrap 会在窄窗口折行堆叠，
  // 表现为「并排没了」。paneW 同时是字号换算口径（F10/R2：对比栏必须是真实栏宽）。
  const GAP = 14;
  const avail = ($("canvas-wrap").clientWidth || 940) - 2;
  const paneW = Math.max(180, Math.min(560, Math.floor((avail - GAP) / 2)));

  const left = el("div", "compare-pane");
  left.style.width = `${paneW}px`;
  left.append(el("p", "pane-title", "原卷"));
  if ((data.originPages ?? 0) >= data.pages.length && data.pages.length > 0) {
    const pad = String(data.pages.length).length;
    const img = el("img", "origin-page-img");
    img.src = `/data/out/${enc(doc)}/pages/page-${String(p.index + 1).padStart(pad, "0")}.png`;
    img.alt = `原卷第 ${p.index + 1} 页`;
    left.append(img);
  } else {
    const f = el("iframe", "origin-frame");
    f.src = `/data/out/${enc(doc)}/origin.pdf#page=${p.index + 1}`;
    f.title = `原卷第 ${p.index + 1} 页`;
    left.append(f);
  }

  const right = el("div", "compare-pane");
  right.style.width = `${paneW}px`;
  right.append(el("p", "pane-title", "成品（结构化数据按原坐标重建，非原图）"));
  // 纸面重建的**唯一实现**在 ./reconstruct.js —— 成品页（final/）用的是同一个函数，
  // 所以「成品 = 对比右侧」是结构保证的，不是两处各写一遍碰巧长得像。
  // 对比模式是**审计视图** ⇒ diagnostics 全开（解析遗漏框 + 丢弃块）。
  const paper = renderPaper(p, {
    doc,
    paneW,
    diagnostics: true,
    candidateStyle: CANDIDATE_STYLE,
    ocrFill: SHOW_OCR_FILL,
    onChipClick: showDetail,
  });
  right.append(paper.wrap);

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
  const data = /** @type {Snapshot} */ (state.data); // 只在 load() 成功后被调用 ⇒ 仅收窄，不改行为
  const p = data.pages[state.page];
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
  const noToolbar = state.stage === 4; // 质检是列表视图、无页码；成品是逐页重建 ⇒ 要翻页栏
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
    renderFinal(p);
    syncToolbar(p);
  } else {
    renderCompare(p);
    syncToolbar(p);
  }
}

/* 对比模式的栏宽随窗口变化 → 防抖重渲染，保证「永远并排」且字号换算口径与真实栏宽同步。 */
/** @type {ReturnType<typeof setTimeout> | undefined} 定时器句柄；初值由 null 改为 undefined（两者都被 clearTimeout 当空句柄 no-op，行为不变），以便类型收窄不靠断言 */
let resizeTimer = undefined;
window.addEventListener("resize", () => {
  if (state.stage !== 6 || !state.data) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

load();
