/**
 * final/final.js —— **成品页**（整册浏览）
 *
 * 用户 2026-10-14 定的调子：「成品要跟『对比』生成的那个一样，这样我使用时更接近使用原版书」。
 * 所以这一页**不做重排**：每一页都交给 `../stages/reconstruct.js` 的 `renderPaper` 按原坐标重建
 * —— 与「对比」右侧**同一段代码**，不是"长得像"而是结构保证的一致。
 *
 * 与阅读版（`/viewer/`）的分工：
 * - 成品页 = 像原版书（逐页、按坐标、可整册滚动翻）→ 日常阅读用；
 * - 阅读版 = 检索/答题用（目录、答案开关、筛选、质检队列）。
 *
 * 两个开关（用户选择：审计标记默认关、OCR 候选样式默认开）：
 * - **审计标记**：解析遗漏（洋红框）+ 丢弃块（灰虚线）。原版书上没有这些标记，默认不画；
 * - **OCR 候选样式**：上游整行漏读、由 OCR 补回的内容。默认加青绿候选样式（红线 G1：
 *   候选不得与引擎原文混淆）；关掉则按普通正文显示 —— **文本始终在**，只是不再抢眼。
 *
 * 解耦红线：只消费快照 JSON + 同目录纯函数模块，**不 import 引擎 src/**。
 *
 * 题目标签（2026-10-15 新增，需求规格 docs/specs/2026-10-15-paper-question-tags.md）：
 * 纸面上只**显示**（号牌下方的短码列，由 renderPaper 画），**增删一律点题号牌 → 面板**——
 * 留白 22px 里 12px 高的目标在触屏上点不准。数据独立落在 `data/out/tags/`，
 * 不碰快照（快照每次导出都会被冲掉）。
 */
import { CANVAS_W, el, enc, renderPaper } from "../stages/reconstruct.js";
import { entryCrop, entrySegments, fitEntryCrops } from "./entry-paper.js";
import { prettifyLatex } from "../stages/latex-display.js";
import { tagSection } from "./tag-panel.js";
import { anchorOf, loadBindings, loadLibrary, reconcile, saveBindings, saveLibrary, tagIdsFor } from "./tag-store.js";

const DOCS = [
  { id: "23必刷题 2相互作用", label: "题册 · 2 相互作用", kind: "quiz" },
  { id: "第二章相互作用-答案与解析", label: "答案册 · 第二章", kind: "answer" },
];
const DEFAULT_DOC = DOCS[0].id;

const $ = (id) => document.getElementById(id);

const state = {
  doc: DEFAULT_DOC,
  data: null,
  paneW: CANVAS_W,
  audit: false,
  ocrStyle: true,
  bank: null,
  snap: null, // 当前文档的整册快照：面板按原卷坐标裁条目要用
  snaps: new Map(), // 另一册的快照缓存（按需拉，见 snapshotOf）
  sheetToken: null, // 连点两个号牌时判断哪次点击作数
  byId: null, // questions.json 索引（id → 完整题目：stem/options/images）；**快照 stages.json 没有这些字段**
  byIdError: "", // 读不到 questions.json 时面板要如实说，不能拿 undefined 冒充题干
  tagsOn: true, // ?tags=0 关掉标签层（版式不变门的对照态，与 ?audit/?ocr 同构）
  tags: null, // {library, bindings}：标签库 + 本题标签（独立文件，与快照解耦）
  pages: [], // 每页的 {sec, head, p}，供打标后**只重绘那一页**（整册重绘在平板上会闪）
  sheet: null, // 当前面板打开的 {q, p}
};

/** 纸面宽度：像书一样尽量宽，但不超出视口（留出两侧留白与滚动条） */
function paperWidth() {
  return Math.max(320, Math.min(CANVAS_W, window.innerWidth - 110));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 顶部提示条。⚠️ 一律走 DOM 构造、不用 innerHTML：`doc` 来自 URL 参数，
 *  拼进 HTML 等于把 `?doc=<img onerror=…>` 变成可执行内容（本地工具也是工具）。 */
function notice(parts, kind) {
  const n = $("notice");
  n.hidden = false;
  // 类名跟 CSS 对齐（`.notice.error`）——原来写的是 `err`，错误态样式一直没生效过
  n.className = kind === "err" ? "notice error" : "notice";
  n.replaceChildren();
  for (const part of parts) {
    if (Array.isArray(part)) n.append(el(part[0], "", part[1]));
    else n.append(document.createTextNode(String(part)));
  }
}

/* ── 标签：加载与漂移核对 ── */

async function loadTags() {
  const [library, bindings] = await Promise.all([loadLibrary(), loadBindings(state.doc)]);
  const present = new Set();
  for (const p of state.data.pages) for (const q of p.questions) present.add(q.id);
  const r = reconcile(bindings, present);
  state.tags = { library, bindings: r.state };
  // 对不上的绑定不删、不藏：先把状态如实写回文件，再在页面上说清楚（U21）
  if (r.changed) await saveBindings(state.doc, r.state);
  const stale = r.state.stale ?? [];
  if (stale.length) {
    notice(
      [`${stale.length} 条标签在当前快照里对不上题目（切分重新导出后位置型 ID 会变），数据已原样保留。`,
        ...stale.slice(0, 8).flatMap((s) => [`\n第 ${s.anchor?.page ?? "?"} 页 第 ${s.anchor?.number ?? "?"} 题：${(s.tagIds ?? []).join(", ")}`])],
      "warn",
    );
  }
}

/* ── 题号牌点开：标签区置顶 + 详情在下（同一个浮层，不做两个并存面板） ── */

function bankEntryFor(q) {
  if (!state.bank) return null;
  return state.bank.byQuizId.get(q.id) ?? state.bank.byAnswerId.get(q.id) ?? null;
}

/** 渲染用的标签解析器，交给 renderPaper（纸面只读，数据在这里） */
function tagsForQuestion(q) {
  if (!state.tags) return null;
  const ids = new Set(tagIdsFor(state.tags.bindings, q.id));
  if (!ids.size) return null;
  // 顺序按标签库走：绑定里的 tagIds 是"打的先后"，显示要稳定不能随点击顺序跳
  return state.tags.library.tags.filter((t) => ids.has(t.id));
}

/** 只重绘受影响的这一页：标签层不改 innerW，页高不变，滚动位置不会跳 */
function repaintPage(pageIndex) {
  const slot = state.pages[pageIndex];
  if (!slot) return;
  slot.sec.replaceChildren(slot.head, paper(slot.p));
}

function paper(p) {
  return renderPaper(p, {
    doc: state.doc,
    paneW: state.paneW,
    diagnostics: state.audit,
    candidateStyle: state.ocrStyle,
    onChipClick: openSheet,
    resolveTags: state.tagsOn ? tagsForQuestion : null,
  }).wrap;
}

/** 标签面板拿的「应用」句柄：写路径只有 commitBindings / commitLibrary 两条 */
const tagApp = {
  get tags() {
    return state.tags;
  },
  set tags(v) {
    state.tags = v;
  },
  commitBindings: (next) => saveBindings(state.doc, next),
  commitLibrary: (next) => saveLibrary(next),
  onRepaint: (q, p) => repaintPage(p.index),
};

/**
 * 面板：标签区置顶 → 题面与答案**按原卷坐标裁出来**（图在文字旁边，不在文末）。
 *
 * 用户 2026-10-15 的口径：「题目答案图片就应该按照书上的排版方式来排版，不是放在最后面」。
 * 之前把图甩到文末，是因为只用了引擎的一维文本（stem / answerText）—— 那里面没有图片位置。
 * 现在改用快照的块坐标（entryCrop），图文相对位置与纸面同源。
 * 跨页条目**逐页续裁**：同一个 id 在快照里按页各有一段，段段都裁、按页序叠放。
 */
async function openSheet(q, p) {
  const d = $("detail");
  const token = (state.sheetToken = {}); // 连点两个号牌时，后点开的才算数
  d.replaceChildren();
  const close = el("button", "close", "关闭 ×");
  close.addEventListener("click", () => {
    d.hidden = true;
    state.sheet = null;
  });
  d.append(close);

  if (state.tags) d.append(tagSection(tagApp, q, p, anchorOf(q, p, p.blocks[q.blocks?.[0]])));
  state.sheet = { q, p };

  d.append(el("h3", "", `第 ${q.number} 题（${q.section || "未识别大题"}）`));
  d.append(
    el(
      "p",
      "kv",
      `第 ${p.index + 1} 页 · ${q.type === "choice" ? "选择题" : "主观题"} · ` +
        `可信度 ${Math.round(q.confidence * 100)}%${q.status === "needs_review" ? " · 需人工校对" : ""}`,
    ),
  );

  const entry = bankEntryFor(q);
  // 「自己这一面」永远显示（未配对也显示），「另一面」只有配上对才有
  const kind = docKind(state.doc); // 当前卷是题册还是答案册 ⇒ 决定标题措辞
  const ownLabel = kind === "answer" ? "本条答案" : "题面";
  const otherLabel = kind === "answer" ? "它对应的题（题册）" : "对应答案（来自答案册）";
  const full = state.byId?.get(q.id) ?? null; // 兜底文本源（裁切不可用时）
  if (entry?.answerKey) d.append(el("p", "kv", `答案字母：${entry.answerKey}`));
  if (!entry) {
    d.append(el("p", "kv", "（题库里没有这条的配对答案：题册片段只覆盖第二章，或该题未配对。下面只显示它自己。）"));
  }
  d.hidden = false;
  const w = Math.max(260, d.clientWidth - 34); // 面板可用宽：hidden 时 clientWidth=0，故先显示再量

  const own = await sideSection(token, d, ownLabel, { id: q.id, doc: state.doc }, w, () =>
    textFallback(full?.stem ?? "", full?.options ?? null, full?.images ?? null, state.doc),
  );
  if (own) {
    d.append(own);
    fitEntryCrops(own); // 进文档后才能量真实行盒：按 bbox 裁会把最后一行切一半
  }
  if (token !== state.sheetToken || !entry) return;

  // 另一册按需拉取快照并缓存（题册 0.4 MB / 答案册 0.9 MB）
  const otherDoc = kind === "answer" ? entry.quizId : entry.answerId;
  const other = await sideSection(
    token,
    d,
    otherLabel,
    { id: otherDoc, doc: docOf(otherDoc) },
    w,
    () =>
      kind === "answer"
        ? textFallback(entry.stem, entry.options, null, docOf(entry.quizId))
        : textFallback(entry.answerText, null, entry.answerImages, docOf(entry.answerId)),
  );
  if (other) {
    d.append(other);
    fitEntryCrops(other);
  }
}

/** 当前卷是题册还是答案册（措辞与"哪一面是自己"都靠它） */
function docKind(doc) {
  return DOCS.find((x) => x.id === doc)?.kind ?? "quiz";
}

/** 一面：先试纸面裁切；拿不到快照或块才退回文本 + 图片条，并明说是降级（不静默换排法）。
 *  返回 null = 这次点击已作废（调用方不许再往面板里塞东西）。 */
async function sideSection(token, d, label, side, w, fallback) {
  const box = el("div", "sec");
  box.append(el("div", "lbl", label));
  let snap = side.doc === state.doc ? state.snap : null;
  if (!snap) {
    const tip = el("p", "hint", "正在取原卷排版…");
    box.append(tip);
    d.append(box); // 先挂上占位：跨册要拉 0.4–0.9 MB 快照，不能让面板看起来卡死
    try {
      snap = await snapshotOf(side.doc);
    } catch (e) {
      if (token !== state.sheetToken) return null;
      tip.className = "warn";
      tip.textContent = `取不到「${side.doc}」的原卷排版（${String(e).slice(0, 50)}）——下面按文本显示，图片排在文末。`;
      for (const n of fallback()) box.append(n);
      return box;
    }
    if (token !== state.sheetToken) {
      box.remove();
      return null;
    }
    tip.remove();
  }
  const crop = cropOf(snap, side.id, side.doc, w);
  if (crop) {
    if (crop.holes) {
      // 洞必须说出来而不是只画框：几十像素的虚线框在裁切图里会被读成"排版留白"。
      // ⚠️ 必须挂在裁切图**上方**：面板是定高滚动容器，裁切图动辄 1300px，
      // 说明写在图下方 = 打开面板时它在折叠线以下，等于没说（2026-10-15 用户「我并没有看到」）。
      box.append(
        el(
          "p",
          "lost",
          `原卷上这里有 ${crop.holes} 处墨迹，MinerU 和 OCR 都没读出来 —— 是内容缺失，不是留白。位置见下方裁切图里的洋红斜纹框。`,
        ),
      );
    }
    box.append(crop);
    if (crop.foreignBlocks) {
      // 留白必须说清原因：不说就会被读成"内容丢了"（实测热狗题的图被挂给了下一题）
      box.append(
        el("p", "hint", `本区域内另有 ${crop.foreignBlocks} 个块被切题时归给了别的题，所以这里有空白（见 HANDOFF §6-12）。`),
      );
    }
  } else {
    box.append(el("p", "warn", "这一条在原卷上没有可渲染的块（纸面那份仍是全的）——按文本显示："));
    for (const n of fallback()) box.append(n);
  }
  return box;
}

/** 降级出口：文本 + 按阅读顺序的图片条（位置不如纸面准，但图不丢） */
function textFallback(stem, options, images, doc) {
  const out = [];
  const stemBox = el("div", "stem");
  stemBox.innerHTML = prettifyLatex(stem ?? "");
  out.push(stemBox);
  for (const o of options ?? []) {
    const line = el("div", "opt");
    line.innerHTML = `<b>${o.key}．</b>${prettifyLatex(o.text)}`;
    out.push(line);
  }
  const strip = figStrip(images, doc, "图片");
  if (strip.children.length) out.push(strip);
  return out;
}

/** 一条目可能跨页：段列表由 `entrySegments` 从整册快照里按 id 找齐。 */
function cropOf(snap, qid, doc, w) {
  const segs = snap ? entrySegments(snap.pages, qid) : [];
  if (!segs.length) return null;
  try {
    return entryCrop(segs, doc, w, { candidateStyle: state.ocrStyle });
  } catch (e) {
    console.warn("按原卷裁切失败，退回文本：", String(e).slice(0, 80));
    return null;
  }
}

/** 另一册的快照按需拉取并缓存（题册 0.4 MB / 答案册 0.9 MB） */
async function snapshotOf(doc) {
  if (state.snaps.has(doc)) return state.snaps.get(doc);
  const snap = await fetchJson(`/data/out/${enc(doc)}/stages.json`);
  state.snaps.set(doc, snap);
  return snap;
}

/** `docId:p2:q23` → `docId`（图片要拼 `/data/out/<docId>/images/`） */
function docOf(id) {
  const i = String(id ?? "").lastIndexOf(":p");
  return i > 0 ? id.slice(0, i) : state.doc;
}

/**
 * 图片条：**只在降级路径里出现**（正常路径是 entryCrop，图按原卷位置排）。
 * 按原卷阅读顺序（bbox 先 y 后 x）排；此时手里只有一维文本，没有可回填的位置标记。
 */
function figStrip(images, doc, label) {
  const box = el("div", "figs");
  const list = (images ?? [])
    .slice()
    .sort((a, b) => (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0) || (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0));
  if (!list.length) return box;
  box.append(el("div", "lbl", `${label} ${list.length} 张（按原卷阅读顺序）`));
  for (const im of list) {
    const img = el("img", "fig");
    img.src = `/data/out/${enc(doc)}/images/${enc(im.path)}`;
    img.alt = label;
    img.loading = "lazy";
    img.title = `${im.path} 原卷 bbox ${JSON.stringify(im.bbox ?? [])}`;
    box.append(img);
  }
  return box;
}

/* ── 渲染 ── */

function renderBook() {
  const book = $("book");
  book.replaceChildren();
  state.pages = [];
  const data = state.data;
  data.pages.forEach((p, i) => {
    const sec = el("section", "bk-page");
    sec.id = `pg-${i + 1}`;
    const head = el("p", "bk-head", `第 ${i + 1} / ${data.pages.length} 页`);
    sec.append(head, paper(p));
    book.append(sec);
    state.pages[i] = { sec, head, p };
  });
  updatePageIndicator();
}

/** 顶部页码指示：取「视口中心落在哪一页」 */
function updatePageIndicator() {
  const secs = [...document.querySelectorAll(".bk-page")];
  if (!secs.length) return;
  const mid = window.innerHeight / 2;
  let cur = 1;
  for (const s of secs) {
    const r = s.getBoundingClientRect();
    if (r.top <= mid) cur = Number(s.id.replace("pg-", ""));
  }
  $("page-now").textContent = `第 ${cur} / ${secs.length} 页`;
}

/**
 * 题干/选项/图片的权威来源。⚠️ **不能用 stages.json 的题目对象**：
 * 那里只有 id/number/section/type/blocks/startsHere/confidence/status/reasons，
 * 没有 stem/options/images —— 曾经面板因此把题干渲染成字面量 `undefined`、选项恒 0、图片全丢。
 * 阅读版（viewer/）一直读的就是这份（viewer.js:28）。
 */
async function loadQuestions(doc) {
  state.byId = null;
  state.byIdError = "";
  try {
    const list = await fetchJson(`/data/out/${enc(doc)}/questions.json`);
    const m = new Map();
    for (const q of list.questions ?? list) m.set(q.id, q);
    state.byId = m;
  } catch (e) {
    state.byIdError = String(e).slice(0, 60);
  }
}

async function loadBank() {
  try {
    const list = await fetchJson("/data/out/bank/bank.json");
    const byQuizId = new Map();
    const byAnswerId = new Map();
    for (const e of list) {
      if (e.quizId) byQuizId.set(e.quizId, e);
      if (e.answerId) byAnswerId.set(e.answerId, e);
    }
    state.bank = { byQuizId, byAnswerId };
  } catch {
    state.bank = null; // 题库不存在也不影响成品页（只少一层「对应答案」）
  }
}

async function loadDoc(doc) {
  try {
    state.data = await fetchJson(`/data/out/${enc(doc)}/stages.json`);
    state.doc = doc;
    $("doc-pick").value = doc;
    $("lnk-stages").href = `/stages/?doc=${enc(doc)}&stage=6&page=1`;
    $("lnk-viewer").href = `/viewer/?doc=${enc(doc)}`;
    $("notice").hidden = true;
    $("detail").hidden = true; // 换卷时关掉面板，避免标签区指着上一卷的题目
    state.sheet = null;
    await loadQuestions(doc);
    state.snap = state.data;
    await loadTags();
    renderBook();
  } catch (e) {
    notice(
      ["读取不到「", doc, "」的快照（", String(e).slice(0, 60), "）。先跑 ", ["code", "npm run stages:export"], " 生成。"],
      "err",
    );
  }
}

/* ── 交互 ── */

function initBar() {
  const pick = $("doc-pick");
  for (const d of DOCS) {
    const o = el("option", "", d.label);
    o.value = d.id;
    pick.append(o);
  }
  pick.value = state.doc;
  pick.addEventListener("change", () => loadDoc(pick.value));

  $("t-audit").addEventListener("change", (e) => {
    state.audit = e.target.checked;
    renderBook();
  });
  $("t-ocr").addEventListener("change", (e) => {
    state.ocrStyle = e.target.checked;
    renderBook();
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = paperWidth();
    if (w === state.paneW) return;
    state.paneW = w;
    if (state.data) renderBook();
  }, 160);
});
window.addEventListener("scroll", updatePageIndicator, { passive: true });

async function main() {
  state.paneW = paperWidth();
  // 开关支持 URL 参数（可分享/收藏某个视图）：?audit=1 开审计标记、?ocr=0 关候选样式
  const qs = new URLSearchParams(location.search);
  state.audit = qs.get("audit") === "1";
  state.ocrStyle = qs.get("ocr") !== "0";
  state.tagsOn = qs.get("tags") !== "0";
  initBar();
  $("t-audit").checked = state.audit;
  $("t-ocr").checked = state.ocrStyle;
  const asked = qs.get("doc") || DEFAULT_DOC;
  await loadBank();
  await loadDoc(asked);
  const hash = /^#pg-(\d+)$/.exec(location.hash);
  if (hash) document.getElementById(`pg-${hash[1]}`)?.scrollIntoView();
}

main();
