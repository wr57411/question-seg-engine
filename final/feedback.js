// 类型权威检查器：`tsconfig.viewer.json`（checkJs:true + DOM lib）。本文件是 DOM 代码，
// **不要**加 `// @ts-check` —— 主 `tsconfig.json` 的 lib 没有 DOM，一旦本文件被 TS 测试 import
// 进主程序，`HTMLElement` / `document` 会被判成未知名字（DECISIONS §95）。
/**
 * final/feedback.js —— 成品页右下角的「反馈」窗口（自挂载 ES module，不动 final.js）。
 *
 * 场景（用户 2026-11-22 需求）：iPad 真机验收成品页，看到错处随手「截图 + 一句话」报上来；
 * 报障格式是「阶段 + 页码 + 现象」。写通道是 `scripts/view-server.ts` 的第三条写路径
 * （POST /api/feedback，守卫见 scripts/feedback-write-guards.ts），本文件只做展示与提交：
 * - 截图：粘贴（paste 事件）或文件选择，预览缩略图，可清除；>6MB 的整屏 Retina 截图
 *   经 canvas 重编码为 JPEG（≤2000px），保证不过服务端 8MB 解码上限；
 * - 评语必填（服务端同样校验，≤4000 字）；页码/题号可选，页码预填当前阅读页（`#page-now`）；
 * - doc 的取值跟 final.js 同口径但不碰它的状态：面板内手动选择（会话内最高）>
 *   卷切换按钮上的当前卷（`.fb-docs-label`，切卷不写 URL，它是唯一活信号）>
 *   URL `?doc=`（在清单里才认，与 final.js loadDocs 相同）> 清单第一卷；
 * - 「我的反馈」列表：GET /api/feedback?doc=…，每条可展开：全文 + 截图 + 补充，
 *   可追加补充（POST supplement）、可改评论（POST update，仅 open 态——服务端 409 拦截，
 *   UI 先对齐）；状态徽标 open=待处理 / working=处理中 / fixed=已修 / wontfix=不修；
 * - 失败一律面板内联红字说出原因（含 FEEDBACK_WRITE=0 的 403），不静默。
 *
 * 截图 URL：item.shot 是相对 `data/out/feedback/` 的路径（`shots/<id>.<ext>`）；
 * view-server 的静态白名单含 `/data/out` 前缀（view-server.ts 静态读段），故拼
 * `/data/out/feedback/<item.shot>`，已在验收时 curl 实测（见 tmp/feedback-frontend/report.md）。
 */
const API = "/api/feedback";
const SHOT_INLINE_MAX = 6 * 1024 * 1024; // 超过就重编码（服务端解码上限 8MB）
const SHRINK_MAX_SIDE = 2000; // 重编码的最长边（px）

/**
 * /api/docs 的一项只读 id/label（完整形状见 scripts/view-server.ts listDocs）。
 * @typedef {{ id: string, label: string }} DocLite
 * @typedef {"open"|"working"|"fixed"|"wontfix"} FeedbackStatus
 * @typedef {{ at?: string, text?: string }} Supplement
 * GET /api/feedback 的 item（服务端记录形状见 view-server.ts handleFeedbackWrite；
 * 只声明本文件读过的字段）。
 * @typedef {{ id: string, docId: string, page?: number | null, questionNumber?: string, comment?: string, shot?: string | null, supplements?: Supplement[], status?: FeedbackStatus, createdAt?: string, updatedAt?: string }} FeedbackItem
 */

/** @type {DocLite[] | null} 文档清单缓存（首次打开面板才拉，不给页面加载加请求） */
let docsCache = null;
/** 用户在反馈面板里手动选过的 doc（本会话最高优先） */
let docChoice = "";
/** @type {FeedbackItem[]} 最近一次列表数据（展开/收起用缓存重渲，不重复拉网络） */
let lastItems = [];
/** 当前展开的反馈 id（""=全收起） */
let expandedId = "";
/** @type {{ dataUrl: string, name: string } | null} 待提交截图 */
let shot = null;

/* ── 小工具 ── */

/** 元素恒由本模块自己创建后 append，按下标取只为可读性；缺了就抛 TypeError（与 final.js $ 同口径）。
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {string} tag @param {string} [cls] @param {string} [text] @returns {HTMLElement} */
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 按钮：默认 type=button（防在表单里回车误提交），submit 按钮显式改回去。
 * @param {string} [cls] @param {string} [text] @returns {HTMLButtonElement}
 */
function btn(cls, text) {
  const b = document.createElement("button");
  if (cls) b.className = cls;
  if (text !== undefined) b.textContent = text;
  b.type = "button";
  return b;
}

/** @param {unknown} e @returns {string} 错误消息（去掉 Error: 前缀，截短） */
function msgOf(e) {
  return String(e).replace(/^Error:\s*/, "").slice(0, 160);
}

/** @param {string} [iso] @returns {string} 2026-11-22 */
function fmtDate(iso) {
  return String(iso ?? "").slice(0, 10);
}

/** @param {string} [iso] @returns {string} 11-22 14:30 */
function fmtTime(iso) {
  const s = String(iso ?? "");
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`.trim();
}

/** @param {string | undefined} [c] @returns {string} 折叠行的单行摘要 */
function summarize(c) {
  const one = String(c ?? "").replace(/\s+/g, " ").trim();
  return one.length > 26 ? `${one.slice(0, 26)}…` : one;
}

/** @param {File} f @returns {boolean} 服务端只收 png/jpeg */
function isImage(f) {
  return f.type === "image/png" || f.type === "image/jpeg";
}

/** item.shot（shots/<id>.<ext>）→ 可直接 <img> 的 URL（静态白名单含 /data/out，实测见报告）。
 * @param {string} rel
 * @returns {string}
 */
function shotUrl(rel) {
  return `/data/out/feedback/${rel}`;
}

/** JSON 取数（GET）。解析结果的形状在各个消费处断言钉住，不在这里伪造类型。
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** POST JSON。服务端错误一律 {ok:false,error}（含 403 FEEDBACK_WRITE=0），原样抛给调用方显示。
 * @param {string} url
 * @param {unknown} body
 * @returns {Promise<{ ok: boolean, id?: string }>}
 */
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) {
    throw new Error(j && j.error ? String(j.error) : `HTTP ${res.status}`);
  }
  return j;
}

/** @type {ReturnType<typeof setTimeout> | undefined} 定时器句柄（undefined 对 clearTimeout 是空句柄 no-op，同 final.js） */
let toastTimer = undefined;

/** 轻提示：复用页面已有的 #toast 元素（样式同源，不另造一个浮层）。
 * @param {string} text
 */
function flash(text) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("on");
    t.hidden = true;
  }, 2400);
}

/* ── doc 解析（与 final.js 同口径，不碰它的状态）── */

/**
 * @returns {string} 当前应归属的 docId；拿不到为 ""（提交前会被拦下并提示）。
 */
function currentDoc() {
  if (docChoice) return docChoice;
  const docs = docsCache ?? [];
  // 切卷不写 URL（final.js loadDoc 只改 state），卷按钮上的卷名是唯一活信号
  const live = document.querySelector("#doc-pick-label .fb-docs-label");
  const liveText = live && live.textContent ? live.textContent.trim() : "";
  if (liveText) {
    const hit = docs.find((d) => d.label === liveText || d.id === liveText);
    if (hit) return hit.id;
  }
  const asked = new URLSearchParams(location.search).get("doc") ?? "";
  if (asked && (!docs.length || docs.some((d) => d.id === asked))) return asked;
  return docs.length ? docs[0].id : "";
}

/** 拉文档清单（懒加载 + 缓存）。失败不缓存，下次打开再试。
 * @returns {Promise<DocLite[]>}
 */
async function ensureDocs() {
  if (docsCache) return docsCache;
  const j = await fetchJson("/api/docs");
  /** @type {DocLite[]} */
  const docs = Array.isArray(j.docs)
    ? j.docs.map((/** @type {any} */ d) => ({
        id: String(d && d.id ? d.id : ""),
        label: String(d && (d.label || d.id) ? d.label || d.id : ""),
      }))
    : [];
  docsCache = docs;
  return docs;
}

/* ── 截图：读入 / 压缩 / 预览 ── */

/**
 * 大图（iPad 整屏 Retina 截图可超 8MB 上限）经 canvas 重编码为 JPEG；
 * 小图原样透传（PNG 不失真，报障截图的字要看得清）。
 * @param {File} file
 * @returns {Promise<string>} dataURL
 */
function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!isImage(file)) {
      reject(new Error("截图只支持 PNG/JPEG"));
      return;
    }
    if (file.size > SHOT_INLINE_MAX) {
      shrinkImage(file).then(resolve, reject);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("截图读取失败"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      if (url) resolve(url);
      else reject(new Error("截图读取失败"));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * @param {File} file
 * @returns {Promise<string>} 重编码后的 JPEG dataURL（≤2000px、质量 0.85）
 */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("截图解码失败"));
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth || SHRINK_MAX_SIDE;
      const hh = img.naturalHeight || SHRINK_MAX_SIDE;
      const scale = Math.min(1, SHRINK_MAX_SIDE / Math.max(w, hh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(hh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("截图压缩失败（拿不到 2D 上下文）"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.src = url;
  });
}

/** @param {DataTransfer | null} dt @returns {File[]} 剪贴板里的图片（只认 png/jpeg） */
function imageFiles(dt) {
  if (!dt) return [];
  const out = [];
  for (const f of Array.from(dt.files)) {
    if (isImage(f)) out.push(f);
  }
  if (!out.length) {
    // files 空时再翻 items（部分安卓浏览器只给 items）
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (!item || item.kind !== "file") continue;
      const f = item.getAsFile();
      if (f && isImage(f)) out.push(f);
    }
  }
  return out;
}

/* ── UI（全部 DOM 构造，不用 innerHTML：doc/评语来自 URL 参数与服务端）── */

const fab = btn("fbk-fab", "反馈");
fab.id = "fbk-open";
fab.setAttribute("aria-controls", "fbk-panel");
fab.setAttribute("aria-expanded", "false");
fab.title = "报个错（截图 + 一句话）";

const panel = h("section", "fbk-panel");
panel.id = "fbk-panel";
panel.hidden = true;
panel.setAttribute("aria-label", "反馈");

const head = h("div", "fbk-head");
head.append(h("strong", "", "反馈"));
const headSub = h("span", "fbk-sub", "报障格式：阶段 + 页码 + 现象");
const closeBtn = btn("fbk-ghost", "收起");
head.append(headSub, closeBtn);

const bodyEl = h("div", "fbk-body");

const docSel = document.createElement("select");
docSel.id = "fbk-doc";
docSel.className = "fbk-doc";
docSel.setAttribute("aria-label", "所属卷");
const docLabel = document.createElement("label");
docLabel.textContent = "卷";
docLabel.htmlFor = "fbk-doc";
const rowDoc = h("div", "fbk-row");
rowDoc.append(docLabel, docSel);

const pageInput = document.createElement("input");
pageInput.id = "fbk-page";
pageInput.type = "number";
pageInput.min = "1";
pageInput.inputMode = "numeric";
pageInput.className = "fbk-page";
pageInput.placeholder = "页码";
const qnumInput = document.createElement("input");
qnumInput.id = "fbk-qnum";
qnumInput.type = "text";
qnumInput.maxLength = 40;
qnumInput.className = "fbk-qnum";
qnumInput.placeholder = "题号（可选）";
const rowLoc = h("div", "fbk-row");
{
  const pLabel = document.createElement("label");
  pLabel.textContent = "页";
  pLabel.htmlFor = "fbk-page";
  const qLabel = document.createElement("label");
  qLabel.textContent = "题";
  qLabel.htmlFor = "fbk-qnum";
  rowLoc.append(pLabel, pageInput, qLabel, qnumInput);
}

const zone = btn("fbk-zone", "选截图（或直接 ⌘V 粘贴）");
zone.id = "fbk-zone";
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "image/png,image/jpeg";
fileInput.hidden = true;

const preview = h("div", "fbk-preview");
preview.hidden = true;
const thumb = document.createElement("img");
thumb.className = "fbk-thumb";
thumb.alt = "截图预览";
const clearShotBtn = btn("fbk-ghost", "清除截图");
preview.append(thumb, clearShotBtn);

const commentArea = document.createElement("textarea");
commentArea.id = "fbk-comment";
commentArea.className = "fbk-comment";
commentArea.rows = 3;
commentArea.maxLength = 4000;
commentArea.placeholder = "现象描述（必填）——按「阶段 + 页码 + 现象」写，例：成品第 3 页第 5 题题号被吞";

const msg = h("span", "fbk-msg", "");
msg.id = "fbk-msg";
const sendBtn = btn("fbk-send", "提交反馈");
sendBtn.id = "fbk-send";
const actions = h("div", "fbk-actions");
actions.append(sendBtn, msg);

const countEl = h("span", "fbk-count", "");
const refreshBtn = btn("fbk-ghost", "刷新");
const listHead = h("div", "fbk-list-head");
listHead.append(h("strong", "", "我的反馈"), countEl, refreshBtn);

const listEl = h("div", "fbk-list");

bodyEl.append(rowDoc, rowLoc, zone, fileInput, preview, commentArea, actions, listHead, listEl);
panel.append(head, bodyEl);

/** @param {string} text @param {boolean} [isErr] */
function setMsg(text, isErr) {
  msg.textContent = text;
  msg.className = isErr ? "fbk-msg err" : "fbk-msg ok";
}

/** 页码预填当前阅读页（#page-now 文本是「12 / 30」）。用户已填就不动。
 * @returns {void}
 */
function prefillPage() {
  if (pageInput.value) return;
  const now = document.getElementById("page-now");
  const m = /^\s*(\d+)\s*\//.exec((now && now.textContent) || "");
  if (m && m[1]) pageInput.value = m[1];
}

/** 填卷下拉：清单空（/api/docs 读不到）时兜底塞 URL doc，保证至少能提交这一卷。 */
function fillDocSelect() {
  const docs = docsCache ?? [];
  docSel.replaceChildren();
  for (const d of docs) {
    const opt = document.createElement("option");
    opt.value = d.id;
    // label 多半已含 id（meta.label = "题册 · <id>"），别拼成两截重复的长串撑爆下拉
    opt.textContent = d.label ? (d.label.includes(d.id) ? d.label : `${d.label}（${d.id}）`) : d.id;
    docSel.append(opt);
  }
  if (!docs.length) {
    const asked = new URLSearchParams(location.search).get("doc") ?? "";
    if (asked) {
      const opt = document.createElement("option");
      opt.value = asked;
      opt.textContent = `${asked}（清单读不到）`;
      docSel.append(opt);
    }
  }
  const cur = currentDoc();
  if (cur) docSel.value = cur;
}

/* ── 我的反馈：列表 / 展开 / 补充 / 修改 ── */

const STATUS_LABEL = { open: "待处理", working: "处理中", fixed: "已修", wontfix: "不修" };

/** @param {FeedbackStatus} s @returns {HTMLElement} */
function badge(s) {
  return h("span", `fbk-badge fbk-st-${s}`, STATUS_LABEL[s] ?? s);
}

/** @param {FeedbackItem} it @returns {string} 折叠行右侧元信息（补充条数 / 截图） */
function rowMeta(it) {
  const n = (it.supplements ?? []).length;
  const parts = [];
  if (n) parts.push(`补充×${n}`);
  if (it.shot) parts.push("截图");
  return parts.join(" · ");
}

/** 拉列表（按当前 doc）。失败在列表区红字说明，不静默。 */
async function refreshList() {
  const doc = currentDoc();
  if (!doc) {
    lastItems = [];
    renderList(lastItems);
    return;
  }
  try {
    const j = /** @type {{ items?: FeedbackItem[] }} */ (
      await fetchJson(`${API}?doc=${encodeURIComponent(doc)}`)
    );
    lastItems = Array.isArray(j.items) ? j.items : [];
  } catch (e) {
    lastItems = [];
    countEl.textContent = "";
    listEl.replaceChildren(h("p", "fbk-err", `反馈列表读取失败：${msgOf(e)}`));
    return;
  }
  renderList(lastItems);
}

/** @param {FeedbackItem[]} items */
function renderList(items) {
  const sorted = items
    .slice()
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  listEl.replaceChildren();
  countEl.textContent = sorted.length ? `${sorted.length} 条` : "";
  if (!sorted.length) {
    listEl.append(h("p", "fbk-empty", "这一卷还没有反馈。有错就报，报了就会被看到。"));
    return;
  }
  for (const it of sorted) listEl.append(buildRow(it));
}

/**
 * 一条反馈：折叠行永远渲染；展开体（全文/截图/补充/表单）只在展开时建。
 * @param {FeedbackItem} it
 * @returns {HTMLElement}
 */
function buildRow(it) {
  const box = h("div", "fbk-item");
  const headBtn = btn("fbk-item-head", "");
  headBtn.setAttribute("aria-expanded", it.id === expandedId ? "true" : "false");
  headBtn.append(
    badge(it.status ?? "open"),
    h("span", "fbk-date", fmtDate(it.createdAt)),
    h("span", "fbk-sum", summarize(it.comment)),
    h("span", "fbk-meta", rowMeta(it)),
  );
  headBtn.addEventListener("click", () => {
    expandedId = expandedId === it.id ? "" : it.id;
    renderList(lastItems); // 展开/收起用缓存重渲，不重复拉网络
  });
  box.append(headBtn);
  if (it.id !== expandedId) return box;

  const itemBody = h("div", "fbk-item-body");
  const full = h("p", "fbk-full", String(it.comment ?? ""));
  itemBody.append(full);
  const loc = [
    it.page != null ? `第 ${it.page} 页` : "",
    it.questionNumber ? `题号 ${it.questionNumber}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (loc) itemBody.append(h("p", "fbk-loc", loc));
  if (it.shot) {
    const img = document.createElement("img");
    img.className = "fbk-shot";
    img.src = shotUrl(it.shot);
    img.alt = "反馈截图";
    img.loading = "lazy";
    itemBody.append(img);
  }
  for (const s of it.supplements ?? []) {
    const p = h("p", "fbk-sup", `${fmtTime(s.at)} 补充：${String(s.text ?? "")}`);
    itemBody.append(p);
  }

  // 行内错误行：提交失败的红字跟着这一条走（列表长时顶部消息会滚出视口）
  const rowErr = h("p", "fbk-err", "");
  rowErr.hidden = true;

  const supForm = h("form", "fbk-mini");
  const supInput = document.createElement("input");
  supInput.type = "text";
  supInput.maxLength = 4000;
  supInput.placeholder = "补充线索（可选，回车提交）";
  supInput.setAttribute("aria-label", "补充内容");
  const supBtn = btn("", "补充");
  supBtn.type = "submit";
  supForm.append(supInput, supBtn);
  supForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = supInput.value.trim();
    if (!text) return;
    supBtn.disabled = true;
    postJson(API, { action: "supplement", id: it.id, text })
      .then(() => {
        flash("已补充");
        return refreshList();
      })
      .catch((err) => {
        rowErr.textContent = msgOf(err);
        rowErr.hidden = false;
      })
      .finally(() => {
        supBtn.disabled = false;
      });
  });
  itemBody.append(supForm);

  // 修改评论：仅 open 态（服务端对 non-open 回 409「只能追加补充」，UI 先对齐口径）
  if ((it.status ?? "open") === "open") {
    const editForm = h("form", "fbk-mini");
    const editArea = document.createElement("textarea");
    editArea.rows = 2;
    editArea.maxLength = 4000;
    editArea.value = String(it.comment ?? "");
    editArea.setAttribute("aria-label", "修改评论");
    const editBtn = btn("", "保存修改");
    editBtn.type = "submit";
    editForm.append(editArea, editBtn);
    editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const comment = editArea.value.trim();
      if (!comment) return;
      editBtn.disabled = true;
      postJson(API, { action: "update", id: it.id, comment })
        .then(() => {
          flash("已修改");
          return refreshList();
        })
        .catch((err) => {
          rowErr.textContent = msgOf(err);
          rowErr.hidden = false;
        })
        .finally(() => {
          editBtn.disabled = false;
        });
    });
    itemBody.append(editForm);
  } else {
    itemBody.append(h("p", "fbk-hint", "该反馈已进入处理：不能改正文，可追加补充。"));
  }

  itemBody.append(rowErr);
  box.append(itemBody);
  return box;
}

/* ── 提交 / 截图事件 ── */

function clearShot() {
  shot = null;
  thumb.removeAttribute("src");
  preview.hidden = true;
}

/**
 * @param {File[]} files 只取第一张（服务端一条反馈只存一张截图，多余忽略不假装收下）
 */
async function takeFiles(files) {
  const file = files[0];
  if (!file) return;
  setMsg("截图处理中…", false);
  try {
    const dataUrl = await readImageDataUrl(file);
    shot = { dataUrl, name: file.name || "截图" };
    thumb.src = dataUrl;
    preview.hidden = false;
    setMsg("截图已就绪", false);
  } catch (e) {
    setMsg(msgOf(e), true);
  }
}

async function submitCreate() {
  const doc = currentDoc();
  if (!doc) {
    setMsg("拿不到当前卷：先在上方选一卷，或在网址后加 ?doc=<docId>", true);
    return;
  }
  const comment = commentArea.value.trim();
  if (!comment) {
    setMsg("评语不能为空（按「阶段 + 页码 + 现象」写）", true);
    return;
  }
  /** @type {{ docId: string, comment: string, page?: number, questionNumber?: string, shotDataUrl?: string }} */
  const item = { docId: doc, comment };
  const pageStr = pageInput.value.trim();
  if (pageStr) {
    const n = Number(pageStr);
    if (!Number.isFinite(n) || n < 1) {
      setMsg("页码要填正整数（或留空）", true);
      return;
    }
    item.page = n;
  }
  const qnum = qnumInput.value.trim();
  if (qnum) item.questionNumber = qnum;
  if (shot) item.shotDataUrl = shot.dataUrl;

  sendBtn.disabled = true;
  setMsg("提交中…", false);
  try {
    const j = await postJson(API, { action: "create", item });
    setMsg(`已提交（${String(j.id ?? "")}）`, false);
    flash("反馈已提交，谢谢");
    commentArea.value = "";
    qnumInput.value = "";
    pageInput.value = "";
    clearShot();
    prefillPage(); // 还停在同一页，顺手把页码补回去
    await refreshList();
  } catch (e) {
    setMsg(msgOf(e), true); // 含 403 FEEDBACK_WRITE=0：红字说出原因，不静默
  } finally {
    sendBtn.disabled = false;
  }
}

/* ── 面板开合与挂载 ── */

async function openPanel() {
  panel.hidden = false;
  fab.setAttribute("aria-expanded", "true");
  prefillPage();
  if (!docsCache) {
    try {
      await ensureDocs();
    } catch (e) {
      // 清单读不到：下拉里兜底塞 URL doc（fillDocSelect），并把原因说出来
      setMsg(`文档清单读取失败（${msgOf(e)}）：只能按网址 doc 参数提交`, true);
    }
  }
  fillDocSelect();
  await refreshList();
}

function closePanel() {
  panel.hidden = true;
  fab.setAttribute("aria-expanded", "false");
}

fab.addEventListener("click", () => {
  if (panel.hidden) void openPanel();
  else closePanel();
});
closeBtn.addEventListener("click", closePanel);
refreshBtn.addEventListener("click", () => void refreshList());
docSel.addEventListener("change", () => {
  docChoice = docSel.value;
  void refreshList();
});
zone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  void takeFiles(Array.from(fileInput.files ?? []));
  fileInput.value = ""; // 允许重复选同一张
});
clearShotBtn.addEventListener("click", clearShot);
sendBtn.addEventListener("click", () => void submitCreate());

// 粘贴：面板开着时，往面板任何地方（含评语框）贴图都收；纯文本粘贴不拦
panel.addEventListener("paste", (e) => {
  const files = imageFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  void takeFiles(files);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !panel.hidden) closePanel();
});

document.body.append(fab, panel);
