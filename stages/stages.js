// stages/stages.js —— 阶段样品展示前端。
// 解耦红线：本文件不 import 引擎代码，只消费
//   /data/out/<docId>/stages.json（快照契约，见 scripts/export-stages.ts）
//   /data/out/<docId>/images/<裸文件名>、/data/out/<docId>/origin.pdf（原卷对照）
//   /viewer/（最终成品内嵌）。
// latex-display.js 为本目录纯函数模块（无引擎依赖），负责公式展示美化。

import { prettifyLatex } from "./latex-display.js";

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
    look: "看：两边是否逐块对得上——文字有没有少、图片在不在原位、题号顺序是否一致。右侧明显空掉/错位的地方，就是引擎的问题所在。",
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
function lineFont(hPx) {
  return Math.max(8, Math.min(20, Math.round(hPx * 0.72)));
}

/* 字号同时适配框宽与框高：CJK 记 1em、其他记 0.55em 估宽，
 * 超宽则缩字号——「出现的东西大小要匹配」，避免文字溢出边框的别扭感 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFFFD\u3000-\u303F\uFF00-\uFFEF]/;
/** 剥掉 HTML 标签：prettifyLatex 返回 HTML 片段（分式/根号需要二维结构），
 * 按纯文本估算字号时不能把标签字符算进宽度。 */
const stripTags = (html) => html.replace(/<[^>]*>/g, "");
function fitFontSize(text, boxWpx, boxHpx) {
  const hFit = lineFont(boxHpx);
  let ems = 0;
  for (const ch of text) ems += CJK_RE.test(ch) ? 1 : 0.55;
  if (ems <= 0) return hFit;
  return Math.max(7, Math.min(hFit, (boxWpx / ems) * 0.98));
}

/** 行级块节点（阶段 2/3 与对比模式共用；canvasW 为画布像素宽，用于字号换算） */
function blockNode(b, p, canvasW = CANVAS_W) {
  const node = posStyle(el("div", `blk blk-line kind-${b.kind}`), b.bbox, p.width, p.height);
  node.title = b.text;
  if (b.kind === "image" && b.img) {
    const img = el("img");
    img.src = `/data/out/${enc(state.effectiveDoc)}/images/${enc(b.img)}`;
    img.alt = "图片块";
    node.append(img);
  } else {
    // prettifyLatex 返回 HTML 片段（\frac 竖排分式 / \sqrt 带上划线根号），必须 innerHTML
    const html = prettifyLatex(b.text);
    const txt = el("span", "txt");
    txt.innerHTML = html;
    const boxW = ((b.bbox[2] - b.bbox[0]) / p.width) * canvasW;
    const boxH = ((b.bbox[3] - b.bbox[1]) / p.width) * canvasW;
    txt.style.fontSize = `${fitFontSize(stripTags(html), boxW, boxH)}px`;
    node.append(txt);
  }
  return node;
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
  renderDiscardedInto(c, p);
  for (const b of p.raw) {
    const node = posStyle(el("div", `blk blk-raw type-${b.type}`), b.bbox, p.width, p.height);
    const shown = prettifyLatex(b.text);
    node.title = `[${TYPE_LABEL_CN(b.type)}] ${b.text}`;
    const txt = el("span", "txt");
    if (shown) txt.innerHTML = shown;
    else txt.textContent = `(${TYPE_LABEL_CN(b.type)})`;
    const boxW = ((b.bbox[2] - b.bbox[0]) / p.width) * CANVAS_W;
    const boxH = ((b.bbox[3] - b.bbox[1]) / p.width) * CANVAS_W;
    txt.style.fontSize = `${fitFontSize(stripTags(shown) || `(${TYPE_LABEL_CN(b.type)})`, boxW, boxH * 0.9)}px`;
    node.append(txt, el("span", "tag", TYPE_LABEL_CN(b.type)));
    c.append(node);
  }
  return c;
}

const DISCARDED_LABEL = {
  header: "页眉", footer: "页脚", page_number: "页码", aside_text: "侧栏",
};

/** 丢弃块（页眉/页脚/页码/侧栏）：虚线灰块呈现——原卷上有、解析器判为家具的内容 */
function renderDiscardedInto(c, p) {
  for (const b of p.discarded ?? []) {
    const node = posStyle(el("div", "blk blk-discarded"), b.bbox, p.width, p.height);
    const shown = prettifyLatex(b.text);
    node.title = `[已被解析器丢弃·${DISCARDED_LABEL[b.dtype] ?? b.dtype}] ${b.text}`;
    if (shown) {
      const txt = el("span", "txt");
      txt.innerHTML = shown;
      const boxW = ((b.bbox[2] - b.bbox[0]) / p.width) * CANVAS_W;
      const boxH = ((b.bbox[3] - b.bbox[1]) / p.width) * CANVAS_W;
      txt.style.fontSize = `${fitFontSize(stripTags(shown), boxW, boxH)}px`;
      node.append(txt);
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
  for (const b of p.blocks) c.append(blockNode(b, p));
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
  for (const b of p.blocks) c.append(blockNode(b, p));

  const covered = new Set();
  for (const q of p.questions) for (const i of q.blocks) covered.add(i);
  const blockNodes = [...c.children].slice(0, p.blocks.length);
  blockNodes.forEach((n, i) => {
    if (!covered.has(p.blocks[i].i)) n.classList.add("orphan");
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

  const left = el("div", "compare-pane");
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
  right.append(el("p", "pane-title", "成品（结构化数据按原坐标重建，非原图）"));
  const c = paperCanvas(p);
  c.style.width = "100%";
  const PANE_W = 460; // 与 CSS .compare-pane 一致，用于字号换算
  renderDiscardedInto(c, p);
  for (const b of p.blocks) c.append(blockNode(b, p, PANE_W));
  for (const q of p.questions) {
    const first = q.blocks.map((i) => p.blocks[i]).find(Boolean);
    if (!first) continue;
    const chip = el("span", "q-chip plain", `第${q.number}题`);
    // 内嵌首块左上角（同切题页）：牌子只出现在题目自身位置
    chip.style.left = `${(first.bbox[0] / p.width) * 100}%`;
    chip.style.top = `${(first.bbox[1] / p.height) * 100}%`;
    chip.style.transform = "translate(0, -1px)";
    chip.addEventListener("click", () => showDetail(q, p));
    c.append(chip);
  }
  right.append(c);

  row.append(left, right);
  $("canvas-wrap").append(row);
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

load();
