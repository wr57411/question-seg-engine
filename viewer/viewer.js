// @ts-check
// ============================================================
// viewer/viewer.js — 展示层逻辑（纯浏览器，无引擎 src/ import）
// 解耦红线：本文件不得 import ../src/ 任何内容。数据来源见 CONTRACT.md。
// ============================================================

import { resolveDoc, loadWithFallback } from "./doc-utils.js";

/**
 * 快照里一道题的**本文件视图**（字段口径见 `viewer/docs/CONTRACT.md`；这里只声明读过的）。
 * @typedef {Object} QOption
 * @property {string} key
 * @property {string} text
 *
 * @typedef {Object} Question
 * @property {string} id
 * @property {string} [number]
 * @property {string} [stem]
 * @property {string} [type]
 * @property {string} status
 * @property {string} [section]
 * @property {string} [answer]
 * @property {QOption[]} [options]
 * @property {Array<{ path: string }>} [images]
 * @property {number} [confidence]
 * @property {string} [review_note]
 * @property {string} [error]
 *
 * @typedef {Object} Band 教辅栏目板块条目（`DECISIONS §78`，`bands.json`）
 * @property {string | number} id
 * @property {string} title
 * @property {number} pageIndex
 * @property {number[]} [blockIndexes]
 * @property {string} [text]
 *
 * @typedef {{ renderMathInElement?: (el: Element, opts?: Record<string, unknown>) => void }} KatexWindow
 *   KaTeX auto-render 是 `<script>` 直接挂到 window 的第三方全局（无类型包），
 *   这里只声明本文件用到的那一个方法，不用 `any` 蒙过去。
 */

/** URL ?doc= 参数（含"缺失/非法回退默认"容错），由 doc-utils 解析 */
const DOC = resolveDoc(location.search);
// BASE 依赖实际生效 doc（回退后），故用函数延迟计算，并在 main() 中按 effectiveDoc 赋值
/** @param {string} doc */
const baseFor = (doc) => `../data/out/${encodeURIComponent(doc)}`;
let BASE = baseFor(DOC);

/** @type {{ answersVisible: boolean, filter: string, questions: Question[], bands: Band[], reviewMode: boolean }} */
const state = {
  answersVisible: false,
  filter: "all",
  questions: [],
  /** 教辅栏目板块条目（`bands.json`，可选增强：缺文件时为空数组，不影响主列表） */
  bands: [],
  reviewMode: false, // true 时显示质检队列视图（showReview），false 显示主列表（showOverview）
};

/**
 * 可选查询：拿不到就返回 null（调用方自己判空）。
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement | null}
 */
const $ = (sel, root = document) => /** @type {HTMLElement | null} */ (root.querySelector(sel));

/**
 * 必存在查询：页面缺这个元素就是**事故**，直接抛错并说清缺哪个
 * （旧写法在 null 上取属性同样抛 TypeError，只是信息不可读 —— 红线 G1「不静默失败」）。
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement}
 */
const need = (sel, root = document) => {
  const found = root.querySelector(sel);
  if (!found) throw new Error(`页面缺少元素：${sel}`);
  return /** @type {HTMLElement} */ (found); // 本文件的选择器全部指向 HTML 元素（id/class 选择）
};

/**
 * @param {string} id
 * @param {string} [cls]
 * @returns {string}
 */
const icon = (id, cls = "icon") =>
  `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* ---------------- 数据加载（doc 容错：失败时回退默认一次，并给出明确提示） ---------------- */
/** @returns {Promise<{ questions: unknown, effectiveDoc: string }>} */
async function load() {
  const res = await loadWithFallback(
    async (doc) => fetch(`../data/out/${encodeURIComponent(doc)}/questions.json`),
    DOC,
  );
  // 栏目板块（`DECISIONS §78`）是**可选增强**：老产物没有 bands.json，
  // 缺文件/坏 JSON 都不该让题目列表打不开 ⇒ 静默降级为空数组。
  try {
    const r = await fetch(`../data/out/${encodeURIComponent(res.effectiveDoc)}/bands.json`);
    state.bands = r.ok ? await r.json() : [];
  } catch {
    state.bands = [];
  }
  return res;
}

/* ---------------- 契约适配 ---------------- */
// 图片路径：拼接 images/ 前缀
/** @param {Question} q @returns {string[]} */
function imageSrc(q) {
  return (q.images || []).map((i) => `${BASE}/images/${encodeURIComponent(i.path)}`);
}

// 适配①：answer 形如 "B\n解析：由…" → 拆成 { value, solution? }
/** @param {Question} q @returns {{ value: string, solution?: string }} */
function splitAnswer(q) {
  if (!q.answer) return { value: "—" };
  const idx = q.answer.indexOf("解析：");
  if (idx > 0) {
    return { value: q.answer.slice(0, idx).trim(), solution: q.answer.slice(idx).trim() };
  }
  return { value: q.answer };
}

/* ---------------- 渲染：目录栏 ---------------- */
function renderToc() {
  const nav = need("#toc-nav");
  nav.innerHTML = "";
  const sections = groupBySection(state.questions);
  for (const [name, qs] of sections) {
    const sec = document.createElement("div");
    sec.className = "toc-section";
    const title = document.createElement("div");
    title.className = "toc-section-title";
    title.textContent = name || "未分组";
    sec.appendChild(title);
    for (const q of qs) {
      if (state.filter !== "all" && q.type !== state.filter) continue;
      const a = document.createElement("a");
      a.className = "toc-item";
      a.href = `#${anchorId(q)}`;
      a.dataset.status = q.status;
      a.innerHTML =
        `<span class="num">${q.number || q.id}</span>` +
        `<span class="dot ${q.status === "needs_review" ? "alert" : "ok"}"></span>`;
      a.addEventListener("click", () => {
        document.querySelectorAll(".toc-item").forEach((n) => n.classList.remove("active"));
        a.classList.add("active");
        $(".main")?.classList.remove("toc-open");
        document.body.classList.remove("toc-open");
      });
      sec.appendChild(a);
    }
    nav.appendChild(sec);
  }
}

/**
 * @param {Question[]} qs
 * @returns {Map<string, Question[]>}
 */
function groupBySection(qs) {
  /** @type {Map<string, Question[]>} */
  const m = new Map();
  for (const q of qs) {
    const key = q.section || "";
    const bucket = m.get(key);
    if (bucket) bucket.push(q);
    else m.set(key, [q]);
  }
  return m;
}

/* ---------------- 渲染：卡片 ---------------- */
/** @param {Question} q @param {number} i @returns {HTMLElement} */
function renderCard(q, i) {
  const card = document.createElement("article");
  card.className = `card${q.status === "needs_review" ? " needs_review" : ""}`;
  card.id = anchorId(q);
  card.style.setProperty("--i", String(i));

  const opts = q.options || [];
  const isChoice = q.type === "choice" || opts.length >= 2;
  const typeLabel = isChoice ? "choice" : "subjective";

  // 选项：choice 用完整 A-D 列表；数据里主观题误带 options 时降级为横排 text 流
  let optionsHtml = "";
  if (isChoice && opts.length) {
    optionsHtml =
      `<ul class="options choices">` +
      opts
        .map(
          (o) =>
            `<li><span class="opt-key">${o.key}.</span><span class="opt-text">${escapeHtml(o.text)}</span></li>`
        )
        .join("") +
      `</ul>`;
  } else {
    optionsHtml =
      `<ul class="options linear">` +
      opts.map((o) => `<li>${escapeHtml(o.key)}. ${escapeHtml(o.text)}</li>`).join("") +
      `</ul>`;
  }

  const imgs = imageSrc(q);
  const figures = imgs.length
    ? `<div class="figures">${imgs.map((s) => `<img src="${s}" alt="" loading="lazy" />`).join("")}</div>`
    : "";

  const { value, solution } = splitAnswer(q);
  const missing = !q.answer;
  const solBlock = solution
    ? `<p class="stamp-solution">${escapeHtml(solution)}</p>`
    : "";

  const answerHtml = `
    <div class="answer">
      <div class="answer-stamp${missing ? " answer-missing" : ""}">
        <div class="stamp-title">${icon(missing ? "i-alert" : "i-check")} ${
          missing ? "暂无参考答案" : "Official Answer"
        }</div>
        <div class="stamp-value">${escapeHtml(value)}</div>
        ${solBlock}
      </div>
    </div>`;

  const blankCls = isChoice ? "choice" : "subjective";

  card.innerHTML = `
    <header class="card-head">
      <span class="q-id">${displayLabel(q)}</span>
      <span class="q-type">${typeLabel}</span>
      ${
        q.section
          ? `<span class="q-section">${escapeHtml(q.section)}</span>`
          : ""
      }
      ${
        q.status === "needs_review"
          ? `<span class="rev-tag">${icon("i-alert")} Review</span>`
          : ""
      }
      <span class="q-dot ${q.status === "needs_review" ? "alert" : "ok"}" ${
        q.status === "needs_review" ? 'title="Needs Review"' : ""
      }></span>
    </header>

    <p class="stem">${escapeHtml(q.stem)}</p>
    ${optionsHtml}
    ${figures}
    <button class="share-answer-btn" type="button" data-answer-toggle>
      ${icon("i-eye")} <span>Show Answer</span>
    </button>
    <div class="answer-write ${blankCls}"><span class="label">答题区</span></div>
    ${answerHtml}
  `;

  // 单题答案开关
  const btn = need("[data-answer-toggle]", card);
  btn.addEventListener("click", () => {
    const shown = card.classList.toggle("show-answer");
    need("span", btn).textContent = shown ? "Hide Answer" : "Show Answer";
  });

  return card;
}

/* ---------------- 统计/筛选 ---------------- */
function updateStats() {
  const total = state.questions.length;
  const ok = state.questions.filter((q) => q.status === "ok").length;
  const review = total - ok;
  need("#stat-total").textContent = String(total);
  need("#stat-ok").textContent = String(ok);
  need("#stat-review").textContent = String(review);
  // Review 按钮计数同步（Review (N)，N = needs_review 数）
  const label = $("#review-btn-label");
  if (label) label.textContent = `Review (${review})`;
  const btn = need("#review-btn");
  if (btn) {
    btn.classList.toggle("is-empty", review === 0);
    btn.setAttribute("aria-pressed", String(state.reviewMode));
  }
}

/* ---------------- 渲染：栏目板块卡（DECISIONS §78） ---------------- */
/**
 * 板块条目不冒充题目：标题栏显示「板块」而不是题号，也不进 Total/ok/review 计数。
 * 目的只有一个 —— 让「教材实验 10 长度的测量」这类栏目里的内容在按题浏览时也能找到，
 * 而不是像以前那样要么被切成假题、要么彻底消失。
 */
/** @param {Band} b @returns {HTMLElement} */
function renderBandCard(b) {
  const card = document.createElement("article");
  card.className = "card band-card";
  card.id = `band-${String(b.id).replace(/[^\w:-]/g, "_")}`;
  const preview = (b.text || "").slice(0, 360);
  card.innerHTML = `
    <header class="card-head">
      <span class="q-id">板块</span>
      <span class="q-section">${escapeHtml(b.title)}</span>
      <span class="q-type">p${b.pageIndex + 1}</span>
    </header>
    <p class="band-note">本页栏目内容（${(b.blockIndexes || []).length} 块）不是独立题目，按栏目归属展示。</p>
    ${preview ? `<p class="stem band-text">${escapeHtml(preview)}${(b.text || "").length > preview.length ? "…" : ""}</p>` : ""}`;
  return card;
}

function applyFilter() {
  const flow = need("#paper");
  const vis = state.questions.filter((q) => state.filter === "all" || q.type === state.filter);
  flow.querySelectorAll(".card").forEach((c) => c.remove());
  need("#placeholder").hidden = true;
  if (!vis.length) {
    flow.querySelector("#empty")?.remove();
    const empty = document.createElement("div");
    empty.id = "empty";
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="stamp-circle">${icon("i-check")}</div>
      <h2>没有符合条件的题目</h2>
      <p>当前筛选下没有题目，请切换题型筛选。</p>
      <button class="btn btn-ghost" type="button" data-reset>返回全部</button>`;
    $("[data-reset]", empty)?.addEventListener("click", () => setFilter("all"));
    flow.appendChild(empty);
    return;
  }
  // 板块卡按页插在题目流里。同页的板块**排在该页题目之后**：
  // questions.json 里没有「题目在本页的块位置」，硬把板块放在页首会把它前面的题推到后面
  // （实测 p1 三张板块卡把第 1 题挤到了第三张卡下面）。宁可顺序粗一点，也不能打乱题目顺序。
  const bands = [...(state.bands || [])].sort((a, b) => a.pageIndex - b.pageIndex);
  /** @type {Set<string | number>} */
  const placed = new Set();
  /** @param {number} page */
  const placeBandsBefore = (page) => {
    for (const b of bands) {
      if (!placed.has(b.id) && b.pageIndex < page) {
        flow.appendChild(renderBandCard(b));
        placed.add(b.id);
      }
    }
  };
  vis.forEach((q, i) => {
    const pm = /:p(\d+):/.exec(q.id || "");
    placeBandsBefore(pm ? Number(pm[1]) : -1);
    flow.appendChild(renderCard(q, i));
  });
  for (const b of bands) {
    if (!placed.has(b.id)) {
      flow.appendChild(renderBandCard(b));
      placed.add(b.id);
    }
  }
  renderToc();
  // 重建卡片是全新的 DOM：按 state 统一回填答案可见性，并重新渲染 KaTeX 公式
  applyAnswerVisibility();
  renderMath();
}

/* ---------------- 答案可见性（全局 + 单题共用，保证 rebuild 后与 state 一致） ---------------- */
function applyAnswerVisibility() {
  document.querySelectorAll(".card").forEach((c) => /** @type {HTMLElement} */ (c).classList.toggle("show-answer", state.answersVisible));
  const btn = need("#toggle-answers");
  need("span", btn).textContent = state.answersVisible ? "Hide All Answers" : "Toggle All Answers";
}

/** @param {string} f */
function setFilter(f) {
  state.filter = f;
  document.querySelectorAll(".filter").forEach((b) => {
    const el = /** @type {HTMLElement} */ (b);
    el.classList.toggle("is-active", el.dataset.filter === f);
  });
  applyFilter();
}

/* ---------------- 质检队列视图（Review 入口 / P3） ---------------- */
// 切换质检队列视图：显示 id="review" 容器并渲染队列；隐藏主列表；body 加 .review-mode
function showReview() {
  state.reviewMode = true;
  renderReviewQueue();
  need("#paper").hidden = true;
  const rb = need("#review");
  rb.hidden = false;
  document.body.classList.add("review-mode");
  const btn = need("#review-btn");
  btn.classList.add("is-active");
  btn.setAttribute("aria-pressed", "true");
}

// 返回总览视图（恢复卡片流 + 筛选 + 目录）
function showOverview() {
  state.reviewMode = false;
  const rb = need("#review");
  rb.hidden = true;
  need("#paper").hidden = false;
  document.body.classList.remove("review-mode");
  const btn = need("#review-btn");
  btn.classList.remove("is-active");
  btn.setAttribute("aria-pressed", "false");
}

// 渲染质检队列：列出所有 needs_review 题，每项可点击进入单题
function renderReviewQueue() {
  const rb = need("#review");
  rb.innerHTML = "";
  /** @type {Question[]} */
  const reviewQs = state.questions.filter((q) => q.status === "needs_review");

  const head = document.createElement("div");
  head.className = "review-head";
  head.innerHTML =
    `<h2 class="review-title">${icon("i-alert")} 质检队列</h2>` +
    `<span class="review-count">${reviewQs.length} Pending Review</span>`;
  rb.appendChild(head);

  const desc = document.createElement("p");
  desc.className = "review-desc";
  desc.textContent = "以下题目因置信度偏低或结构异常，需人工编辑复核。";
  rb.appendChild(desc);

  if (!reviewQs.length) {
    const empty = document.createElement("div");
    empty.className = "review-empty";
    empty.innerHTML =
      `<div class="stamp-circle">${icon("i-check")}</div>` +
      `<h3>All questions reviewed.</h3>` +
      `<p>暂无待审题目。</p>`;
    const back = document.createElement("button");
    back.className = "btn btn-ink w-full";
    back.type = "button";
    back.textContent = "返回总览";
    back.addEventListener("click", showOverview);
    empty.appendChild(back);
    rb.appendChild(empty);
    return;
  }

  for (const q of reviewQs) {
    const item = document.createElement("article");
    item.className = "review-item";
    item.dataset.target = anchorId(q);
    const qid = displayLabel(q);
    const conf = Math.round((q.confidence ?? 0) * 100);
    const err = reviewError(q);
    item.innerHTML = `
      <div class="review-item-head">
        <span class="review-id">${icon("i-alert")} ${escapeHtml(qid)}</span>
        <span class="review-conf">Conf ${conf}%</span>
        <span class="review-err">${escapeHtml(err)}</span>
        <button class="btn btn-ghost review-go" type="button" data-go>进入单题</button>
      </div>
      <p class="review-stem">${escapeHtml(q.stem)}</p>`;
    // 进入单题：滚动到对应题卡并回到总览（高亮目标卡）
    need("[data-go]", item).addEventListener("click", (e) => {
      e.stopPropagation();
      goToQuestion(q);
    });
    item.addEventListener("click", () => goToQuestion(q));
    rb.appendChild(item);
  }
}

// 质检队列项 → 回到总览并滚动到目标题卡（含单题高亮）
/** @param {Question} q */
function goToQuestion(q) {
  showOverview();
  const target = document.getElementById(anchorId(q));
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("review-highlight");
    setTimeout(() => target.classList.remove("review-highlight"), 2600);
  }
}

// 根据数据泛化错误摘要（用于质检队列的红色错误标签）
/** @param {Question} q @returns {string} */
function reviewError(q) {
  const msg = q.review_note || q.error || "";
  if (msg) return String(msg);
  if (q.type === "subjective") return "SUBJECTIVE FLAG";
  if ((q.confidence ?? 1) < 0.7) return "LOW CONFIDENCE";
  return "ANOMALY DETECTED";
}

/* ---------------- 全局答案开关 ---------------- */
/** @param {boolean} v */
function setAnswersVisible(v) {
  state.answersVisible = v;
  applyAnswerVisibility();
}

/* ---------------- KaTeX 渲染（离线降级原文） ---------------- */
function renderMath() {
  const katex = /** @type {KatexWindow} */ (window);
  if (typeof katex.renderMathInElement === "function") {
    try {
      katex.renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    } catch (e) {
      /* 离线/降级：保留 $..$ 原文 */
    }
  }
}

/* ---------------- 移动端目录 ---------------- */
function initMobileToc() {
  need("#mobile-menu").addEventListener("click", () => {
    const open = need("#toc").classList.toggle("open");
    document.body.classList.toggle("toc-open", open);
  });
}
function closeTocOnResize() {
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) {
      need("#toc").classList.remove("open");
      document.body.classList.remove("toc-open");
    }
  });
}

/* ---------------- 工具 ---------------- */
/** @param {Question} q @returns {string} */
function anchorId(q) {
  // id 必有（契约）；万一缺失也只退化成 `q-`，不再抛 TypeError
  return `q-${(q.id || q.number || "").replace(/[^\w\u4e00-\u9fa5:-]/g, "_")}`;
}

// 展示标签：避免"题号重复"歧义（真实数据多卷题目 number 都为 6）。
// 若 number 在全量题目里唯一 → 用 "Q-6"；重复 → 用 id 里的页码段（如 p7:q43 → "p7-6"）
// 或直接回退 id，确保每张卡/队列项展示可区分。
/** @param {Question} q @returns {string} */
function displayLabel(q) {
  const n = q.number;
  const label = `Q-${n || q.id}`;
  if (!n) return `Q-${q.id}`;
  const sameNum = state.questions.filter((x) => x.number === n).length;
  if (sameNum <= 1) return label;
  // number 重复：附加 id 中的页码段（更好读），id 形如 "<卷>:p7:q43"
  const m = String(q.id).match(/:p(\d+):q(\d+)$/);
  if (m) return `Q-${n} (p${m[1]})`;
  return `Q-${q.id}`;
}
/** @param {unknown} s @returns {string} */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- 启动 ---------------- */
async function main() {
  // 标题先用初始 DOC 占位；成功加载后再用实际生效 doc（可能回退默认）覆盖
  need("#masthead-doc").textContent = DOC;
  need("#toc-doc").textContent = DOC;

  // 全局答案开关
  need("#toggle-answers").addEventListener("click", () => setAnswersVisible(!state.answersVisible));

  // 质检队列 Review 入口（P3）：点击切换 质检队列视图 <-> 总览
  need("#review-btn").addEventListener("click", () => {
    if (state.reviewMode) showOverview();
    else showReview();
  });

  // 题型筛选
  need("#filters").addEventListener("click", (e) => {
    const target = /** @type {Element | null} */ (e.target);
    const btn = /** @type {HTMLElement | null} */ (target?.closest("[data-filter]"));
    if (btn?.dataset.filter) setFilter(btn.dataset.filter);
  });

  initMobileToc();
  closeTocOnResize();

  try {
    const { questions, effectiveDoc } = await load();
    state.questions = /** @type {Question[]} */ (questions);
    // 用实际生效 doc（可能已回退默认）驱动标题与图片路径 BASE，而非初始 DOC
    BASE = baseFor(effectiveDoc);
    need("#masthead-doc").textContent = effectiveDoc;
    need("#toc-doc").textContent = effectiveDoc;
  } catch (err) {
    need("#placeholder").hidden = true;
    const flow = need("#paper");
    const empty = document.createElement("div");
    empty.id = "empty";
    empty.className = "empty-state";
    empty.innerHTML = `<div class="stamp-circle">${icon("i-alert")}</div>
      <h2>数据加载失败</h2><p>${escapeHtml(/** @type {Error} */ (err).message)}</p>`;
    flow.appendChild(empty);
    return;
  }

  updateStats();
  applyFilter();
  renderMath();
}

main();
