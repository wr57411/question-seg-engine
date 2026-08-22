// ============================================================
// viewer/viewer.js — 展示层逻辑（纯浏览器，无引擎 src/ import）
// 解耦红线：本文件不得 import ../src/ 任何内容。数据来源见 CONTRACT.md。
// ============================================================

import { resolveDoc, loadWithFallback } from "./doc-utils.js";

/** URL ?doc= 参数（含"缺失/非法回退默认"容错），由 doc-utils 解析 */
const DOC = resolveDoc(location.search);
// BASE 依赖实际生效 doc（回退后），故用函数延迟计算，并在 main() 中按 effectiveDoc 赋值
const baseFor = (doc) => `../data/out/${encodeURIComponent(doc)}`;
let BASE = baseFor(DOC);

const state = { answersVisible: false, filter: "all", questions: [] };

const $ = (sel, root = document) => root.querySelector(sel);
const icon = (id, cls = "icon") =>
  `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* ---------------- 数据加载（doc 容错：失败时回退默认一次，并给出明确提示） ---------------- */
async function load() {
  return loadWithFallback(
    async (doc) => fetch(`../data/out/${encodeURIComponent(doc)}/questions.json`),
    DOC,
  );
}

/* ---------------- 契约适配 ---------------- */
// 图片路径：拼接 images/ 前缀
function imageSrc(q) {
  return (q.images || []).map((i) => `${BASE}/images/${encodeURIComponent(i.path)}`);
}

// 适配①：answer 形如 "B\n解析：由…" → 拆成 { value, solution? }
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
  const nav = $("#toc-nav");
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

function groupBySection(qs) {
  const m = new Map();
  for (const q of qs) {
    const key = q.section || "";
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(q);
  }
  return m;
}

/* ---------------- 渲染：卡片 ---------------- */
function renderCard(q, i) {
  const card = document.createElement("article");
  card.className = `card${q.status === "needs_review" ? " needs_review" : ""}`;
  card.id = anchorId(q);
  card.style.setProperty("--i", i);

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
      <span class="q-id">Q-${q.number || q.id}</span>
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
  const btn = $("[data-answer-toggle]", card);
  btn.addEventListener("click", () => {
    const shown = card.classList.toggle("show-answer");
    $("span", btn).textContent = shown ? "Hide Answer" : "Show Answer";
  });

  return card;
}

/* ---------------- 统计/筛选 ---------------- */
function updateStats() {
  const total = state.questions.length;
  const ok = state.questions.filter((q) => q.status === "ok").length;
  const review = total - ok;
  $("#stat-total").textContent = total;
  $("#stat-ok").textContent = ok;
  $("#stat-review").textContent = review;
}

function applyFilter() {
  const flow = $("#paper");
  const vis = state.questions.filter((q) => state.filter === "all" || q.type === state.filter);
  flow.querySelectorAll(".card").forEach((c) => c.remove());
  $("#placeholder").hidden = true;
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
  // 骨架屏保留至首屏渲染完成即可
  vis.forEach((q, i) => flow.appendChild(renderCard(q, i)));
  renderToc();
  // 重建卡片是全新的 DOM：按 state 统一回填答案可见性，并重新渲染 KaTeX 公式
  applyAnswerVisibility();
  renderMath();
}

/* ---------------- 答案可见性（全局 + 单题共用，保证 rebuild 后与 state 一致） ---------------- */
function applyAnswerVisibility() {
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("show-answer", state.answersVisible));
  const btn = $("#toggle-answers");
  $("span", btn).textContent = state.answersVisible ? "Hide All Answers" : "Toggle All Answers";
}

function setFilter(f) {
  state.filter = f;
  document.querySelectorAll(".filter").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.filter === f)
  );
  applyFilter();
}

/* ---------------- 全局答案开关 ---------------- */
function setAnswersVisible(v) {
  state.answersVisible = v;
  applyAnswerVisibility();
}

/* ---------------- KaTeX 渲染（离线降级原文） ---------------- */
function renderMath() {
  if (typeof window.renderMathInElement === "function") {
    try {
      window.renderMathInElement(document.body, {
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
  $("#mobile-menu").addEventListener("click", () => {
    const open = $("#toc").classList.toggle("open");
    document.body.classList.toggle("toc-open", open);
  });
}
function closeTocOnResize() {
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) {
      $("#toc").classList.remove("open");
      document.body.classList.remove("toc-open");
    }
  });
}

/* ---------------- 工具 ---------------- */
function anchorId(q) {
  return `q-${(q.id || q.number).replace(/[^\w\u4e00-\u9fa5:-]/g, "_")}`;
}
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
  $("#masthead-doc").textContent = DOC;
  $("#toc-doc").textContent = DOC;

  // 全局答案开关
  $("#toggle-answers").addEventListener("click", () => setAnswersVisible(!state.answersVisible));

  // 题型筛选
  $("#filters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (btn) setFilter(btn.dataset.filter);
  });

  initMobileToc();
  closeTocOnResize();

  try {
    const { questions, effectiveDoc } = await load();
    state.questions = questions;
    // 用实际生效 doc（可能已回退默认）驱动标题与图片路径 BASE，而非初始 DOC
    BASE = baseFor(effectiveDoc);
    $("#masthead-doc").textContent = effectiveDoc;
    $("#toc-doc").textContent = effectiveDoc;
  } catch (err) {
    $("#placeholder").hidden = true;
    const flow = $("#paper");
    const empty = document.createElement("div");
    empty.id = "empty";
    empty.className = "empty-state";
    empty.innerHTML = `<div class="stamp-circle">${icon("i-alert")}</div>
      <h2>数据加载失败</h2><p>${escapeHtml(err.message)}</p>`;
    flow.appendChild(empty);
    return;
  }

  updateStats();
  applyFilter();
  renderMath();
}

main();
