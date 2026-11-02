// 类型权威检查器：`tsconfig.viewer.json`（checkJs:true + DOM lib）。本文件是 DOM 代码，
// **不要**加 `// @ts-check` —— 主 `tsconfig.json` 的 lib 没有 DOM，一旦本文件被 TS 测试 import
// 进主程序，`HTMLElement` / `document` 会被判成未知名字（DECISIONS §95）。
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
import { CANVAS_W, el, enc, mergeContext, renderPaper } from "../stages/reconstruct.js";
import { entryCrop, entrySegments, fitEntryCrops } from "./entry-paper.js";
import { pickQuestionAt } from "./pick-hit.js";
import { prettifyLatex } from "../stages/latex-display.js";
import { tagSection } from "./tag-panel.js";
import { anchorOf, loadBindings, loadLibrary, reconcile, saveBindings, saveLibrary, tagIdsFor } from "./tag-store.js";
import {
  addCombo,
  addTeachItem,
  assignmentFor,
  badgeCounts,
  bindingFor,
  comboMatches,
  emptyTeachBindings,
  filterTeach,
  loadTeachBindings,
  loadTeachLibrary,
  loadTeachUsage,
  manageTeach,
  moveToFront,
  normalizeCombos,
  normalizeTeachBindings,
  normalizeTeachList,
  orderByRecent,
  renameCombo,
  replaceBinding,
  restoreCombo,
  retireCombo,
  sameAsPrevious,
  saveTeach,
  saveTeachBindings,
  splitRetired,
  toggleCategory,
  toggleTopic,
} from "./teach-store.js";

/**
 * ── 类型声明 ──
 *
 * 快照 typedef 为什么**在本地声明**（而不是 import `reconstruct.js` 的 `Page`/`Block`）：
 * `stages/reconstruct.d.ts` 是手写声明、**整体遮蔽实现**（债：`HANDOFF §6-29`），它的导出形状
 * 刻意宽松（`el`/`mergeContext`/`renderPaper` 回来的都是 `any`），跨文件也拿不到它的 typedef ——
 * 与 `final/entry-paper.js`（本地 `PageRef`/`SnapBlock`）、`final/tag-panel.js`（本地
 * `QuestionRef`/`PageRef`）同一口径：**只声明本文件读过的字段**，真实形状见
 * `scripts/export-stages.ts`（快照）与 `scripts/build-bank.ts:279`（bank 条目）。
 * 标签数据一律复用 `tag-store.js` 的导出 typedef（不另造一份，同 `tag-panel.js:30-38`）。
 *
 * @typedef {Object} SnapBlock 快照里的一个行级块（stages.json 的 pages[i].blocks[j]）
 * @property {number} i
 * @property {number[]} bbox
 * @property {string} [text]
 * @property {string} [kind]
 * @property {string} [img]
 * @property {string} [html]
 * @property {boolean} [ocr]
 *
 * @typedef {Object} SnapOcrItem 一条 OCR 候选补行（`text` 取必填，与 entry-paper.js:50 OcrItem 对齐）
 * @property {string} text
 * @property {number[]} [bbox]
 * @property {number[]} [win]
 * @property {boolean} [accepted]
 * @property {string} [source]
 * @property {string} [raw]
 * @property {string} [crop]
 * @property {number} [ratio]
 *
 * @typedef {Object} SnapQuestion 快照题目（真实形状：export-stages.ts StageQuestion）
 * @property {string} id
 * @property {string} number
 * @property {string} section
 * @property {string} type
 * @property {number[]} blocks
 * @property {boolean} [startsHere]
 * @property {number} confidence
 * @property {string} status
 *
 * @typedef {Object} SnapPage 快照一页（只列本文件读过的字段；`index` 见 export-stages.ts StagePage）
 * @property {number} index
 * @property {number} width
 * @property {number} height
 * @property {number} [columns]
 * @property {SnapBlock[]} blocks
 * @property {SnapQuestion[]} questions
 * @property {SnapOcrItem[]} [ocrFill]
 *
 * @typedef {Object} Snap 整册 stages.json 快照
 * @property {SnapPage[]} pages
 *
 * @typedef {{ key: string, text: string }} OptLine 选项行（questions.json / bank.json 都是这个形状）
 * @typedef {{ path: string, bbox?: number[] }} ImageRef 图片引用（裸文件名 + 原卷 bbox）
 *
 * @typedef {Object} BankQuestion questions.json 的一条（面板只读这几个字段）
 * @property {string} id
 * @property {string} [stem]
 * @property {OptLine[]} [options]
 * @property {ImageRef[]} [images]
 *
 * @typedef {Object} BankEntry bank.json 的一条配对条目（只读字段；真实形状 build-bank.ts Entry）
 * @property {string} quizId
 * @property {string} answerId
 * @property {string} answerKey
 * @property {string} stem
 * @property {string} answerText
 * @property {OptLine[]} [options]
 * @property {ImageRef[]} answerImages
 *
 * @typedef {{ byQuizId: Map<string, BankEntry>, byAnswerId: Map<string, BankEntry> }} Bank
 *
 * @typedef {{ level: string, short?: string, issues?: string[] }} HealthInfo meta.json 体检结论（本文件读的部分）
 * @typedef {{ questions?: number, pages?: number, ocrFilled?: number }} DocStats meta.json stats（只读这三个键）
 * @typedef {{ id: string, label: string, kind: string, examined: boolean, stats: DocStats | null, health: HealthInfo | null }} DocMeta /api/docs 的一项（形状见 scripts/view-server.ts listDocs）
 *
 * @typedef {import("./tag-store.js").Tag} Tag
 * @typedef {import("./tag-store.js").DocTags} DocTags
 * @typedef {{ version: number, tags: Tag[] }} Library
 * @typedef {{ library: Library, bindings: DocTags }} TagState
 *
 * 号牌点击回调与 `tagSection` 的 `QuestionRef`/`PageRef` 参数对得上即可（结构性兼容），
 * 这里本地声明的理由与 `tag-panel.js:33-34` 相同（reconstruct.d.ts 遮蔽债，跨不了文件）。
 * @typedef {{ id: string, number: string }} QuestionRef
 * @typedef {{ index: number, width: number, height: number }} PageRef
 *
 * @typedef {{ q: SnapQuestion, p: SnapPage }} SheetRef 当前面板打开的题/页
 * @typedef {{ doc: string, qid: string, pageIndex: number, prevBinding: import('./teach-store.js').TeachBinding | null, nextBinding: import('./teach-store.js').TeachBinding | null }} UndoRecord 一次可撤销动作
 * @typedef {{ sec: HTMLElement, head: HTMLElement, p: SnapPage, paper: { wrap: HTMLElement, canvas: HTMLElement } }} PageSlot 每页的四段（重绘单页、给号牌加选中态都要用）
 * @typedef {HTMLElement & { foreignBlocks: number, holes: number }} CropBox entryCrop 容器（契约见 entry-paper.js:326-327：容器上挂这两个计数）
 * @typedef {{ drop: Set<number>, keep: Map<number, { text: string }> }} MergeCtx mergeContext 返回（与 entry-paper.js:64 同形，另加 keep）
 * @typedef {{ kind?: string, blk?: SnapBlock, text?: string, last?: SnapBlock }} FlowItem 文本流的一条（text 段或块段）
 * @typedef {{ kind: "text", text: string, last: SnapBlock }} FlowPara groupParagraphs 的进行中段落
 * @typedef {{ kind: "question", pageIndex: number, q: SnapQuestion, snippet: string }} HitQuestion 题号候选行
 * @typedef {{ kind?: never, pageIndex: number, blockIndex: number, snippet: string }} HitBlock 正文命中行
 */

/**
 * 文档清单来自服务端 `/api/docs`（扫 `data/out/<docId>/` 里有快照的目录），
 * **不再硬编码** —— 硬编码的代价是「导入一份新卷要改前端代码」，那不叫每天能用。
 * 每项形如 `{ id, label, kind, examined, stats, health }`，`examined=false` 表示没跑过
 * `npm run daily` 的体检（此时如实显示「未体检」，不假装健康）。
 */
/** @type {DocMeta[]} */
let DOCS = [];
let DEFAULT_DOC = "";

/**
 * 页面骨架里的元素**恒存在**（final/index.html 随页面一起提交）。
 * ⚠️ 这里只做类型声明、**不加存在性检查**：真缺元素时维持原样 —— 在后续属性访问处抛
 * TypeError。换成 viewer.js 的 `need()`（查询时抛 Error）会**提前抛、换异常类型**，
 * 按红线「不得改变何时抛错」不采用，只做等价的返回类型收窄。
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** 跨所有卷的「某项被几题在用」：`{topics: {id: {live,stale}}, categories: {...}}` */
/** @typedef {{ topics: Record<string, { live: number, stale: number }>, categories: Record<string, { live: number, stale: number }> }} TeachUsage */

/**
 * 单一可变对象（纪律 7：整体声明一次，下游 never/隐式 any 自然消失，不靠逐点断言）。
 * @type {{
 *   doc: string,
 *   data: Snap | null,
 *   paneW: number,
 *   audit: boolean,
 *   ocrStyle: boolean,
 *   ocrFill: boolean,
 *   bank: Bank | null,
 *   snap: Snap | null,
 *   snaps: Map<string, Snap>,
 *   sheetToken: object | null,
 *   byId: Map<string, BankQuestion> | null,
 *   byIdError: string,
 *   tagsOn: boolean,
 *   tags: TagState | null,
 *   pages: PageSlot[],
 *   sheet: SheetRef | null,
 *   pickMode: boolean,
 *   picked: { q: SnapQuestion, p: SnapPage } | null,
 *   teach: (import('./teach-store.js').TeachLibrary & { bindings: import('./teach-store.js').TeachBindings, error: string }) | null,
 *   recent: { topics: string[], categories: string[] },
 *   creating: 'topics' | 'categories' | null,
 *   lastClassified: { doc: string, questionId: string, assignment: { topicIds: string[], categoryIds: string[] }, label: string } | null,
 *   undo: UndoRecord | null,
 *   manage: { renaming: string | null, usage: TeachUsage | null } | null,
 *   teachUsage: TeachUsage | null,
 *   search: { on: boolean, q: string }
 * }}
 */
const state = {
  doc: DEFAULT_DOC,
  data: null,
  paneW: CANVAS_W,
  audit: false,
  ocrStyle: false, // OCR 补入行的绿色候选样式：**默认关**（成品页要干净，需要核查时勾选）
  // OCR 补行（引擎漏识别、由 OCR 补出来的**候选行**）：默认**不画**（`DECISIONS §91`）。
  // 整页 OCR 来源没有位置信息，硬配回洞会错位（用户实测：表格单元格的文字被画到页眉）。
  ocrFill: false,
  bank: null,
  snap: null, // 当前文档的整册快照：面板按原卷坐标裁条目要用
  snaps: new Map(), // 另一册的快照缓存（按需拉，见 snapshotOf）
  sheetToken: null, // 连点两个号牌时判断哪次点击作数
  byId: null, // questions.json 索引（id → 完整题目：stem/options/images）；**快照 stages.json 没有这些字段**
  byIdError: "", // 读不到 questions.json 时面板要如实说，不能拿 undefined 冒充题干
  tagsOn: true, // ?tags=0 关掉标签层（版式不变门的对照态，与 ?audit/?ocr 同构）
  tags: null, // {library, bindings}：标签库 + 本题标签（独立文件，与快照解耦）
  pages: [], // 每页的 {sec, head, p, paper}，供打标后**只重绘那一页**（整册重绘在平板上会闪）
  sheet: null, // 当前面板打开的 {q, p}
  pickMode: false, // 挑题模式：点题目任意块选中；关掉即正常阅读
  picked: null, // 当前选中的 {q, p}
  teach: null, // {topics, categories, bindings, error}
  recent: { topics: [], categories: [] }, // 最近使用的专题/类别（本机 localStorage）
  creating: null, // 'topics' | 'categories' | null：托盘内联新建
  lastClassified: null, // 本会话最近一次已归类题 {doc, questionId, assignment, label}
  undo: null, // 最近一次可撤销动作 {doc, qid, pageIndex, prevBinding, nextBinding}
  manage: null, // 管理面板状态 {renaming: id|null, usage}；null=面板关着
  teachUsage: null, // 跨所有卷的「某个专题/类别被几题在用」，管理面板删除前要摆出来
  search: { on: false, q: "" }, // 托盘搜索：开着时组合条让位给搜索框，两行同步过滤
};

/** 纸面宽度：像书一样尽量宽，但不超出视口（留出两侧留白与滚动条） */
function paperWidth() {  return Math.max(320, Math.min(CANVAS_W, window.innerWidth - 110));
}

/**
 * JSON 取数的边界。`Promise<any>` 沿用 `tag-store.js:65-67`（getJson）的既有先例：
 * 解析结果的形状在**各个消费处**用本地 typedef + `/** @type *\/` 断言钉住（见 loadDocs /
 * loadDoc / loadQuestions / loadBank / snapshotOf），不在这里伪造一个全局类型。
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 顶部提示条。⚠️ 一律走 DOM 构造、不用 innerHTML：`doc` 来自 URL 参数，
 *  拼进 HTML 等于把 `?doc=<img onerror=…>` 变成可执行内容（本地工具也是工具）。
 * @param {(string | [string, string])[]} parts 一段文本，或 `[标签名, 文本]` 二元组
 * @param {string} [kind] "err" 走错误态样式，其余（如 "warn"）为普通提示
 */
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

/** @param {string} doc */
async function loadTeach(doc) {
  state.teach = { topics: [], categories: [], combos: [], bindings: emptyTeachBindings(), error: "" };
  try {
    const [lib, bindings] = await Promise.all([loadTeachLibrary(), loadTeachBindings(doc)]);
    state.teach = { ...lib, bindings, error: "" };
  } catch (e) {
    state.teach = { topics: [], categories: [], combos: [], bindings: emptyTeachBindings(), error: String(e).slice(0, 80) };
    notice([`教学归类读取失败（${state.teach?.error ?? ""}）：托盘会空着，不影响阅读。`], "warn");
  }
}

async function loadTags() {
  const [library, bindings] = await Promise.all([loadLibrary(), loadBindings(state.doc)]);
  /** @type {Set<string>} */
  const present = new Set();
  // loadTags 只在 loadDoc 里 `state.data` 就位后被调用 ⇒ 边界收窄（cast 不产生任何运行时代码，
  // 真为 null 时依旧在 `.pages` 上抛 TypeError，抛点与原先一致）
  const data = /** @type {Snap} */ (state.data);
  for (const p of data.pages) for (const q of p.questions) present.add(q.id);
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

/**
 * @param {SnapQuestion} q
 * @returns {BankEntry | null}
 */
function bankEntryFor(q) {
  if (!state.bank) return null;
  return state.bank.byQuizId.get(q.id) ?? state.bank.byAnswerId.get(q.id) ?? null;
}

/** 渲染用的标签解析器，交给 renderPaper（纸面只读，数据在这里）
 * @param {SnapQuestion} q
 * @returns {Tag[] | null}
 */
function tagsForQuestion(q) {
  if (!state.tags) return null;
  const ids = new Set(tagIdsFor(state.tags.bindings, q.id));
  if (!ids.size) return null;
  // 顺序按标签库走：绑定里的 tagIds 是"打的先后"，显示要稳定不能随点击顺序跳
  return state.tags.library.tags.filter((t) => ids.has(t.id));
}

/** 只重绘受影响的这一页：标签层不改 innerW，页高不变，滚动位置不会跳
 * @param {number} pageIndex
 */
function repaintPage(pageIndex) {
  const slot = state.pages[pageIndex];
  if (!slot) return;
  const pr = paper(slot.p);
  slot.paper = pr;
  slot.sec.replaceChildren(slot.head, pr.wrap);
  if (state.picked?.p === slot.p) paintPickSelection(slot);
}

/**
 * **是否手机**（`DECISIONS §88`）：用「较短边 < 500」判，而不是宽度 ——
 * 手机横屏是 844×390（宽度够、但屏幕仍是手机）、平板最小 768×1024。
 * 只看宽度会把手机横屏误判成平板。
 *
 * 为什么按设备而不是横竖屏分：用户 2026-10-30 明确「手机横屏用原排版也别扭」。
 * 手机上纸面按原卷坐标等比缩放后正文只有 5-6px（375 宽）/ 12px（844 横屏但行宽过大），
 * 读起来都难受 ⇒ 手机一律走文本流；平板与桌面保留原版排版（那是这个项目的核心卖点）。
 */
function isPhoneViewport() {
  // 手动覆盖：`?flow=1` 强制文本流、`?flow=0` 强制纸面。
  // 不只是调试用 —— 平板用户可能想临时切到文本流读某个密页，反之亦然。
  const forced = new URLSearchParams(location.search).get("flow");
  if (forced === "1") return true;
  if (forced === "0") return false;
  return Math.min(window.innerWidth, window.innerHeight) < 500;
}

/**
 * **手机端文本流**（`DECISIONS §88`）：不跟原卷坐标，按阅读顺序流式排列。
 *
 * 为什么能这么做而不丢内容：`p.blocks` 在版面层已按阅读顺序排好（双栏也是「左栏读完再右栏」，
 * 与原卷阅读顺序一致），这里只是把「绝对定位的块」换成「流式块」，块集合完全相同。
 *
 * 三处必须与纸面渲染保持同源，否则会出现「手机能看到、平板看不到」的分叉：
 * 1. 同页块级重复的并集合并（`mergeContext`）—— 被合并掉的块不渲染，内容已在合并文本里；
 * 2. 公式渲染（`prettifyLatex`）—— 与纸面同一个函数，`\frac`/`\sqrt` 照样是二维排版；
 * 3. 表格（`blk.html` 原始网格）—— 直接沿用上游 HTML，不重新推断列宽（`§76` 的同一条原则）。
 */
/** 下一行明显是「新块开头」的形态：编号题、选项、栏目头、方框头 —— 都不许接上一行。 */
const FLOW_STARTS_NEW =
  /^(?:\d{1,3}\s|\d{1,3}[.．、)）]|第[一二三四五六七八九十百\d]{1,3}[讲章节]|[【〔]|教材|答案|变式|例题|解析|[A-D][.．、])/;

/** 上一行已经收句 —— 段落该断了。 */
const FLOW_ENDS = /[。！？：；!?:;…]$/;

/**
 * **行级块 → 段落**（`DECISIONS §88`）。
 *
 * 为什么必须有这一步：快照的 `pages[].blocks` 是**行级**的（`normalizeLayout` 每行一块），
 * 直接一段一行，行距 1.8em 读起来比纸面还松散 —— 实测第一版就是这样。
 *
 * 判据全部来自几何 + 标点，不猜内容：
 * 1. **同栏**：`x0` 差 ≤ 8（双栏页里左栏与右栏天然差半页宽，一步就分开了）；
 * 2. **同一行距带**：垂直间距 ≤ 1.6 × 行高（跨段空行、跨栏都超）；
 * 3. **上一行没收句**：末尾不是 `。！？：；`；
 * 4. **下一行不是新块开头**：编号/选项/栏目头/方框头（`FLOW_STARTS_NEW`）。
 *
 * 四条 AND。宁可不合并（读起来是短的独立行）也不能误合并 ——
 * 把标题和正文粘成一行，比多一个段落更难读。
 */
/**
 * @param {SnapBlock[]} blocks
 * @param {MergeCtx} ctx mergeContext 的返回（`reconstruct.d.ts` 债 ⇒ 这里是本地声明，字段见 reconstruct.js:304 的 JSDoc）
 * @returns {FlowItem[]}
 */
function groupParagraphs(blocks, ctx) {
  /** @type {FlowItem[]} */
  const out = [];
  /** @type {FlowPara | null} */
  let cur = null;
  for (const b of blocks) {
    if (ctx.drop.has(b.i)) continue;
    const merged = ctx.keep.get(b.i);
    const blk = merged ? { ...b, text: merged.text } : b;

    if (blk.kind !== "text") {
      // 图片**不**重置段落上下文：浮动图常插在两行正文之间（实测电路 p1 的 A/B 电极图
      // 压在 `…分别接 A、` 与 `B 金属板给…` 之间），重置会把一句话劈成两段。
      // 图后若真是新段落，下面的 x0/行距判据会自然断开。表格是块级独占，必须重置。
      if (blk.kind === "table") cur = null;
      out.push({ kind: blk.kind, blk });
      continue;
    }
    const t = (blk.text ?? "").trim();
    if (!t) continue;

    if (cur && cur.last && cur.last.bbox && blk.bbox && sameParagraph(cur.last, cur.text, blk, t)) {
      // 中英文/数字相邻时补一个空格，避免 `P062教材` 这种粘连
      const glue = /[A-Za-z0-9]$/.test(cur.text) && /^[A-Za-z0-9]/.test(t) ? " " : "";
      cur.text += glue + t;
      cur.last = blk;
      continue;
    }
    cur = { kind: "text", text: t, last: blk };
    out.push(cur);
  }
  return out;
}

/**
 * @param {SnapBlock} prevBlk
 * @param {string} prevText
 * @param {SnapBlock} blk
 * @param {string} text
 * @returns {boolean}
 */
function sameParagraph(prevBlk, prevText, blk, text) {
  // 60 而不是个位数：题号行顶格、正文首行缩进，实测同一段内 x0 差可达 45
  //（`1 [人教版必修三 P56 第 1 题情境变式]` x0=76 → `如图所示…` x0=121）。
  // 放这么宽仍安全：双栏页两栏的 x0 相差 >1000，居中标题与正文相差 >400。
  if (Math.abs(prevBlk.bbox[0] - blk.bbox[0]) > 60) return false;
  const h = prevBlk.bbox[3] - prevBlk.bbox[1];
  const gap = blk.bbox[1] - prevBlk.bbox[3];
  if (gap > Math.max(h * 1.6, 12)) return false;
  if (FLOW_ENDS.test(prevText)) return false;
  if (FLOW_STARTS_NEW.test(text)) return false;
  return true;
}

/**
 * @param {SnapPage} p
 * @returns {HTMLElement}
 */
function flowPaper(p) {
  const wrap = el("div", "flow-page");
  const ctx = mergeContext(p);
  for (const item of groupParagraphs(p.blocks, ctx)) {
    const blk = item.blk;
    if (item.kind === "text") {
      const para = el("p", "flow-p");
      // prettifyLatex 返回 HTML 片段（分式/根号/上下标），与纸面同一个渲染函数
      // （text 段由 groupParagraphs 构造时必带 text ⇒ 边界收窄，不产生运行时代码）
      para.innerHTML = prettifyLatex(/** @type {string} */ (item.text));
      wrap.append(para);
      continue;
    }

    // 非 text 段必带 blk（构造保证）；`blk &&` 只是把这份不变量讲给 tsc 听，永不改变走向
    if (blk && blk.kind === "image" && blk.img) {
      const img = el("img", "flow-img");
      img.src = `/data/out/${enc(state.doc)}/images/${enc(blk.img)}`;
      img.alt = "图片块";
      img.loading = "lazy";
      wrap.append(img);
      continue;
    }
    if (blk && blk.kind === "table" && blk.html) {
      // 上游 HTML 直接沿用（含 rowspan/colspan）；宽度交给 CSS，不重新推断列宽
      const box = el("div", "flow-table");
      box.innerHTML = blk.html;
      wrap.append(box);
    }
  }
  return wrap;
}

/**
 * @param {SnapPage} p
 * @returns {{ wrap: HTMLElement, canvas: HTMLElement }} 纸面与文本流**统一形状**：
 *          文本流没有独立 canvas 层，`canvas` 指回 `wrap`（否则单页重绘/点选命中在手机上会崩）。
 */
function paper(p) {
  if (isPhoneViewport()) {
    // 文本流（oxr 线的手机视图）只有一层 wrap，没有独立 canvas。
    // 调用方（repaintPage / paintPickSelection / 点选命中）统一按 `{wrap, canvas}` 取，
    // 所以这里把 canvas 指回 wrap —— 形状一致，行为在文本流下自然退化为「无高亮、无命中」。
    const wrap = flowPaper(p);
    return { wrap, canvas: wrap };
  }
  return renderPaper(p, {
    doc: state.doc,
    paneW: state.paneW,
    diagnostics: state.audit,
    candidateStyle: state.ocrStyle,
    ocrFill: state.ocrFill,
    onChipClick: (q, page) => {
      if (state.pickMode) pickQuestion(q, page);
      else void openSheet(q, page);
    },
    resolveTags: state.tagsOn ? tagsForQuestion : null,
    assignmentBadge: (/** @type {SnapQuestion} */ q) => {
      const a = assignmentFor(state.teach?.bindings ?? emptyTeachBindings(), q.id);
      return a.topicIds.length || a.categoryIds.length ? badgeCounts(a) : null;
    },
  });
}

/* ── 挑题模式（第一步：选中 + 高亮 + 托盘空壳；归类在下一步接入） ── */

const RECENT_KEY = "final:teach:recent";
function loadRecent() {
  try {
    const j = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}");
    state.recent = {
      topics: Array.isArray(j.topics) ? j.topics.filter((/** @type {unknown} */ x) => typeof x === "string") : [],
      categories: Array.isArray(j.categories) ? j.categories.filter((/** @type {unknown} */ x) => typeof x === "string") : [],
    };
  } catch {
    state.recent = { topics: [], categories: [] };
  }
}
/** @param {'topics'|'categories'} kind @param {string} id */
function bumpRecent(kind, id) {
  state.recent[kind] = moveToFront(state.recent[kind], id);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
  } catch {
    /* 存不了不影响本次归类 */
  }
}

function updatePickTray() {
  const title = $("pick-title");
  if (!title) return;
  renderPickRows();
  renderComboStrip();
  if (!state.picked) {
    title.textContent = state.pickMode ? "先点一道题" : "未选题";
    updateSameButton();
    closeComboPop();
    return;
  }
  const { q, p } = state.picked;
  title.textContent = `p${p.index + 1} · 第${q.number}题`;
  const full = state.byId?.get(q.id);
  title.title = String(full?.stem ?? "").split("\n")[0]?.trim().slice(0, 80) ?? "";
  updateSameButton();
}

function renderPickRows() {
  const rows = $("pick-rows");
  const hint = $("pick-hint");
  const topicBox = $("pick-topics");
  const categoryBox = $("pick-categories");
  const nomatch = $("pick-nomatch");
  if (!rows || !hint || !topicBox || !categoryBox) return;
  /** @param {'topics'|'categories'} kind @param {number} n @param {boolean} shown */
  const setCount = (kind, n, shown) => {
    const node = $(kind === "topics" ? "count-topics" : "count-categories");
    if (!node) return;
    node.hidden = !shown;
    node.textContent = String(n);
  };
  if (!state.picked) {
    rows.hidden = true;
    hint.hidden = true;
    hint.textContent = "";
    if (nomatch) nomatch.hidden = true;
    topicBox.replaceChildren();
    categoryBox.replaceChildren();
    setCount("topics", 0, false);
    setCount("categories", 0, false);
    return;
  }
  const a = assignmentFor(state.teach?.bindings ?? emptyTeachBindings(), state.picked.q.id);
  const rawTopics = state.teach?.topics ?? [];
  const rawCats = state.teach?.categories ?? [];
  const all = {
    topics: orderByRecent(splitRetired(rawTopics).active, state.recent.topics),
    categories: orderByRecent(splitRetired(rawCats).active, state.recent.categories),
  };
  const searching = state.search.on && !!state.search.q.trim();
  const view = searching
    ? filterTeach(state.search.q, all)
    : { topics: all.topics, categories: all.categories, total: all.topics.length + all.categories.length };
  setCount("topics", view.topics.length, searching);
  setCount("categories", view.categories.length, searching);
  const nothing = searching && view.total === 0;
  rows.hidden = nothing;
  if (nomatch) {
    nomatch.hidden = !nothing;
    if (nothing) {
      const q = state.search.q.trim();
      const text = $("pick-nomatch-text");
      const bt = $("nomatch-topics");
      const bc = $("nomatch-categories");
      if (text) text.textContent = `没有叫「${q}」的专题或类别`;
      if (bt) bt.textContent = `新建专题「${q}」`;
      if (bc) bc.textContent = `新建类别「${q}」`;
    }
  }

  /** @param {'topics'|'categories'} kind @param {{id:string,name:string}} item @param {boolean} on */
  const chip = (kind, item, on) => {
    const b = el("button", "pick-chip", item.name);
    b.type = "button";
    b.dataset.id = item.id;
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? `点一下移出：${item.name}` : `点一下放入：${item.name}`;
    b.addEventListener("click", () => togglePick(kind, item.id, item.name));
    return b;
  };
  topicBox.replaceChildren(...view.topics.map((t) => chip("topics", t, a.topicIds.includes(t.id))));
  categoryBox.replaceChildren(...view.categories.map((c) => chip("categories", c, a.categoryIds.includes(c.id))));
  if (!all.topics.length && !all.categories.length) {
    hint.hidden = false;
    hint.textContent = state.teach?.error
      ? `教学归类读取失败：${state.teach.error}`
      : rawTopics.length || rawCats.length
        ? "专题和类别都下架了（去「管理」里恢复，或点 ＋ 新建）"
        : "还没有专题/类别（点每行末尾的 ＋ 新建）";
  } else {
    hint.hidden = true;
    hint.textContent = "";
  }
}

/* ── 托盘搜索：一个框同时过滤两行；搜不到直接建 ── */

/** @param {boolean} on */
function setSearchOn(on) {
  state.search.on = on;
  const box = $("pick-search");
  const input = $("pick-search-q");
  const btn = $("pick-find");
  if (box) box.hidden = !on;
  btn?.setAttribute("aria-pressed", String(on));
  if (!on) {
    state.search.q = "";
    if (input) (/** @type {HTMLInputElement} */ (input)).value = "";
  }
  renderComboStrip();
  renderPickRows();
  if (on) input?.focus();
}

/** 搜不到 → 就地新建并打上，成功后自动收起搜索（新 chip 立刻看得见）。 */
/** @param {'topics'|'categories'} kind */
async function createFromSearch(kind) {
  const q = state.search.q.trim();
  if (!q) return;
  if (!state.picked) {
    flash("先点一道题");
    return;
  }
  const ok = await applyCreate(kind, q);
  if (ok) setSearchOn(false);
}

/** @param {'topics'|'categories'} kind @param {string} id @param {string} name */
function togglePick(kind, id, name) {
  if (!state.picked || !state.teach) {
    flash("先点一道题");
    return;
  }
  const { q, p } = state.picked;
  const before = state.teach?.bindings ?? emptyTeachBindings();
  const cur = assignmentFor(before, q.id);
  const on = kind === "topics" ? cur.topicIds.includes(id) : cur.categoryIds.includes(id);
  const anchor = anchorOf(q, p, p.blocks[q.blocks?.[0]]);
  const next = kind === "topics" ? toggleTopic(before, q.id, id, anchor) : toggleCategory(before, q.id, id, anchor);
  bumpRecent(kind, id);
  commitTeach(next, `${on ? "已移出" : "已放入"}：${name}`, before, { qid: q.id, pageIndex: p.index });
}

function clearTeachNotice() {
  const n = $("notice");
  if (!n || n.hidden) return;
  const t = n.textContent ?? "";
  if (t.includes("教学归类未能保存") || t.includes("教学归类保存异常") || t.includes("新建失败")) {
    n.hidden = true;
    n.replaceChildren();
  }
}

/** @param {import('./teach-store.js').TeachBinding | null} b */
const cloneBinding = (b) =>
  b
    ? {
        questionId: b.questionId,
        topicIds: [...b.topicIds],
        categoryIds: [...b.categoryIds],
        ...(b.anchor ? { anchor: { ...b.anchor } } : {}),
      }
    : null;

/** @param {{topicIds:string[],categoryIds:string[]}} a */
function assignmentLabel(a) {
  const names = [
    ...a.topicIds.map((id) => state.teach?.topics.find((t) => t.id === id)?.name ?? id),
    ...a.categoryIds.map((id) => state.teach?.categories.find((c) => c.id === id)?.name ?? id),
  ];
  return names.join(" · ");
}

function updateSameButton() {
  const btn = $("pick-same");
  if (!btn) return;
  const prev = state.lastClassified;
  const cur = state.picked;
  const can = !!(prev && cur && prev.doc === state.doc && prev.questionId !== cur.q.id);
  (/** @type {HTMLButtonElement} */ (btn)).disabled = !can;
  btn.title = can ? `复制「${prev.label}」到本题` : "先给另一道题归类后才能同上题";
}

/** @param {import('./teach-store.js').TeachCombo} combo */
function comboSummary(combo) {
  const t = combo.topicIds.map((id) => {
    const x = state.teach?.topics.find((v) => v.id === id);
    return x ? (x.retired ? `${x.name}（已下架）` : x.name) : "已删除专题";
  });
  const c = combo.categoryIds.map((id) => {
    const x = state.teach?.categories.find((v) => v.id === id);
    return x ? (x.retired ? `${x.name}（已下架）` : x.name) : "已删除类别";
  });
  return [...t, ...c].join(" · ");
}

function currentAssignment() {
  if (!state.picked) return { topicIds: [], categoryIds: [] };
  return assignmentFor(state.teach?.bindings ?? emptyTeachBindings(), state.picked.q.id);
}

function updateComboAdd() {
  const btn = $("combo-add");
  if (!btn) return;
  const a = currentAssignment();
  (/** @type {HTMLButtonElement} */ (btn)).disabled = !state.picked || (!a.topicIds.length && !a.categoryIds.length);
  (/** @type {HTMLButtonElement} */ (btn)).title = (/** @type {HTMLButtonElement} */ (btn)).disabled ? "先给当前题归类，再存为组合" : "把当前题存为组合";
}

function renderComboStrip() {
  const strip = $("combo-strip");
  if (!strip) return;
  updateComboAdd();
  if (!state.picked) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  // 搜索框和组合条共用同一格：开着搜索就让位给它（托盘不加行、不加高）
  strip.hidden = state.search.on === true;
  if (strip.hidden) {
    strip.replaceChildren();
    return;
  }
  const a = currentAssignment();
  const combos = splitRetired(state.teach?.combos ?? []).active;
  /** @type {HTMLElement[]} */
  const nodes = combos.map((combo) => {
    const b = el("button", "combo-chip" + (comboMatches(combo, a) ? " on" : ""));
    b.type = "button";
    b.dataset.id = combo.id;
    b.textContent = combo.name;
    b.title = `${combo.name}：${comboSummary(combo)}（长按拖动排序）`;
    b.addEventListener("click", () => {
      if (suppressComboClick) return;
      applyCombo(combo);
    });
    return b;
  });
  if (!nodes.length) nodes.push(el("span", "combo-empty-chip", "暂无组合"));
  strip.replaceChildren(...nodes);
}

function closeComboPop() {
  const pop = $("combo-pop");
  if (pop) pop.hidden = true;
  const hint = $("combo-hint");
  if (hint) hint.hidden = true;
  const input = $("combo-name");
  if (input) (/** @type {HTMLInputElement} */ (input)).value = "";
}

function openComboForm() {
  const a = currentAssignment();
  if (!state.picked || (!a.topicIds.length && !a.categoryIds.length)) {
    flash("先给当前题归类，再存组合");
    return;
  }
  const pop = $("combo-pop");
  const input = $("combo-name");
  const hint = $("combo-hint");
  if (!pop || !input) return;
  const t = $("toast");
  if (t) {
    t.hidden = true;
    t.classList.remove("on");
  }
  pop.hidden = false;
  if (hint) hint.hidden = true;
  (/** @type {HTMLInputElement} */ (input)).value = "";
  input.focus();
}

/**
 * 组合清单的唯一写路径：新建/改名/删除/排序都走这里。
 * 串行发写请求（同一份 combos.json 不能两条并发写，后写的会盖掉前写的），
 * 失败回滚到本次改动前的清单并明说，不留「屏幕上有、文件里没有」的假成功。
 * @param {import('./teach-store.js').TeachCombo[]} next
 * @param {string} label 用于提示的主语，如「组合「曲线基础」」
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
let comboSaveChain = Promise.resolve();
/** @param {import('./teach-store.js').TeachCombo[]} next @param {string} label */
async function saveComboList(next, label) {
  if (!state.teach) return { ok: false, error: "教学清单没加载" };
  const prev = state.teach.combos ?? [];
  state.teach = { ...state.teach, combos: next };
  renderComboStrip();
  if (state.manage) renderManageList();
  const run = comboSaveChain.then(() =>
    saveTeach("combos", { version: 1, updatedAt: new Date().toISOString(), combos: next }),
  );
  comboSaveChain = run.then(
    () => undefined,
    () => undefined,
  );
  const r = await run;
  if (!r.ok) {
    state.teach = { ...state.teach, combos: prev };
    renderComboStrip();
    if (state.manage) renderManageList();
    notice([`${label}未能保存：${r.error ?? "未知错误"}（已回退）`], "err");
    return r;
  }
  return r;
}

/** @param {Event} e */
async function submitCombo(e) {
  e.preventDefault();
  if (!state.picked || !state.teach) return;
  const a = currentAssignment();
  const input = $("combo-name");
  const hint = $("combo-hint");
  const res = addCombo(state.teach.combos ?? [], (/** @type {HTMLInputElement} */ (input)).value, a.topicIds, a.categoryIds);
  if (!res.item) {
    hint.hidden = false;
    hint.textContent = res.error ?? "保存失败";
    input.focus();
    return;
  }
  const saved = await saveComboList(res.list, `组合「${res.item.name}」`);
  if (!saved.ok) {
    input.focus();
    return;
  }
  closeComboPop();
  flash(`组合「${res.item.name}」已保存`);
}

/** @param {import('./teach-store.js').TeachCombo} combo */
function applyCombo(combo) {
  if (!state.picked || !state.teach) return;
  const { q, p } = state.picked;
  /** @param {'topics'|'categories'} k @param {string} id */
  const live = (k, id) => state.teach?.[k].some((x) => x.id === id && !x.retired);
  const validTopics = combo.topicIds.filter((id) => live("topics", id));
  const validCategories = combo.categoryIds.filter((id) => live("categories", id));
  const missing = combo.topicIds.length + combo.categoryIds.length - validTopics.length - validCategories.length;
  if (!validTopics.length && !validCategories.length) {
    notice([`组合「${combo.name}」里的专题/类别都已下架或不存在，不能套用`], "err");
    return;
  }
  const cur = currentAssignment();
  if (comboMatches({ ...combo, topicIds: validTopics, categoryIds: validCategories }, cur)) {
    flash(`已经是「${combo.name}」`);
    return;
  }
  const before = state.teach?.bindings ?? emptyTeachBindings();
  const anchor = anchorOf(q, p, p.blocks[q.blocks?.[0]]);
  const next = sameAsPrevious(before, q.id, { topicIds: validTopics, categoryIds: validCategories }, anchor);
  commitTeach(next, `应用组合：${combo.name}`, before, { qid: q.id, pageIndex: p.index });
  if (missing) {
    notice([`组合「${combo.name}」有 ${missing} 项专题/类别已不存在，已跳过`], "warn");
  }
}

/* ── 管理面板：专题 / 类别 / 组合的改名、下架（软删除）与恢复 ── */

/** @param {string} text @param {'ok'|undefined} [kind] */
function showManageHint(text, kind) {
  const hint = $("manage-hint");
  if (!hint) return;
  hint.hidden = false;
  hint.textContent = text;
  hint.classList.toggle("ok", kind === "ok");
}

function clearManageHint() {
  const hint = $("manage-hint");
  if (!hint) return;
  hint.hidden = true;
  hint.textContent = "";
  hint.classList.remove("ok");
}

function openManage() {
  if (!state.teach) {
    flash("教学清单还没加载好");
    return;
  }
  const pop = $("manage-pop");
  if (!pop) return;
  closeComboPop();
  state.manage = { renaming: null, usage: state.teachUsage };
  clearManageHint();
  const t = $("toast");
  if (t) {
    t.hidden = true;
    t.classList.remove("on");
  }
  pop.hidden = false;
  $("pick-manage")?.setAttribute("aria-pressed", "true");
  renderManageList();
  refreshManageUsage();
}

function closeManage() {
  if (!state.manage) return;
  state.manage = null;
  const pop = $("manage-pop");
  if (pop) pop.hidden = true;
  $("pick-manage")?.setAttribute("aria-pressed", "false");
}

/** 「会影响几题」必须跨**所有卷**数，客户端只看得见当前卷 → 问服务端再补数字。 */
function refreshManageUsage() {
  void loadTeachUsage().then((usage) => {
    state.teachUsage = usage;
    if (!state.manage) return;
    state.manage.usage = usage;
    renderManageList();
  });
}

function renderManageList() {
  const box = $("manage-list");
  if (!box || !state.teach || !state.manage) return;
  /** @type {HTMLElement[]} */
  const nodes = [];
  /** @param {string} label @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string,retired?:true}[]} items @param {string} emptyText */
  const section = (label, kind, items, emptyText) => {
    const { active, retired } = splitRetired(items);
    nodes.push(el("p", "mg-label", `${label}（${active.length}）`));
    if (!active.length) nodes.push(el("p", "mg-empty", emptyText));
    for (const item of active) nodes.push(manageRow(kind, item, false));
    // 已下架单独一堆：清单里还在、题上的归类一个没动，所以随时能恢复
    if (retired.length) {
      nodes.push(el("p", "mg-label mg-sublabel", `已下架（${retired.length}）· 题上的归类都还在`));
      for (const item of retired) nodes.push(manageRow(kind, item, true));
    }
  };
  section("专题", "topics", state.teach.topics ?? [], "还没有专题。");
  section("类别", "categories", state.teach.categories ?? [], "还没有类别。");
  section(
    "常用组合",
    "combos",
    state.teach.combos ?? [],
    "还没有组合。先点一道题、选好专题/类别，再按托盘里的 ＋ 存成组合。",
  );
  box.replaceChildren(...nodes);
}

/** 这一项现在被多少题在用（跨卷；数字没回来前如实说"题数未知"）。 */
/** @param {'topics'|'categories'|'combos'} kind @param {string} id */
function usageLabel(kind, id) {
  if (!state.manage?.usage) return "题数未知";
  const bucket = kind === "combos" ? undefined : state.manage.usage[kind];
  const u = bucket?.[id];
  if (!u) return "还没用过";
  return `用在 ${u.live} 题上${u.stale ? `（另 ${u.stale} 题已漂移）` : ""}`;
}

/**
 * 一行：名字 + 说明（专题/类别显示在用题数，组合显示成员）+ 改名/下架。
 * 下架是软删除（用户 2026-10-30 拍板）：点一下就下架、随时可恢复，
 * 所以不再需要「两步确认 + 影响几题」那套防手滑设计。
 * @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item @param {boolean} retired
 */
function manageRow(kind, item, retired) {
  const key = `${kind}:${item.id}`;
  const renaming = !retired && state.manage?.renaming === key;
  const row = el("div", "mg-row" + (retired ? " mg-retired" : ""));
  row.dataset.kind = kind;
  row.dataset.id = item.id;
  const main = el("div", "mg-main");
  if (renaming) {
    const form = el("form", "mg-edit");
    const input = el("input", "mg-input");
    input.type = "text";
    input.maxLength = 60;
    input.value = item.name;
    input.setAttribute("aria-label", "新名字");
    const ok = el("button", "mg-btn primary", "保存");
    ok.type = "submit";
    form.append(input, ok);
    form.addEventListener("submit", /** @param {Event} e */ (e) => {
      e.preventDefault();
      void commitManageRename(kind, item, input.value);
    });
    main.append(form);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    main.append(el("span", "mg-name", item.name));
    main.append(el("span", "mg-sum", kind === "combos" ? comboSummary(/** @type {import('./teach-store.js').TeachCombo} */ (item)) : usageLabel(kind, item.id)));
  }
  row.append(main);
  /** @type {HTMLElement[]} */
  const acts = [];
  if (retired) {
    const back = el("button", "mg-btn primary", "恢复");
    back.type = "button";
    back.addEventListener("click", () => void commitManageRestore(kind, item));
    acts.push(back);
  } else if (!renaming) {
    const rn = el("button", "mg-btn", "改名");
    rn.type = "button";
    rn.addEventListener("click", () => {
      if (!state.manage) return;
      state.manage.renaming = key;
      clearManageHint();
      renderManageList();
    });
    const off = el("button", "mg-btn danger", "下架");
    off.type = "button";
    off.title = "下架后挑题时不再出现，题上已归的类保留，可随时恢复";
    off.addEventListener("click", () => void commitManageRetire(kind, item));
    acts.push(rn, off);
  }
  if (acts.length) {
    // ⚠️ el(tag, cls, text) 判的是 text !== undefined：传 null 会把文本设成 "null"
    const box = el("div", "mg-acts");
    box.append(...acts);
    row.append(box);
  }
  return row;
}

/** 管理成功后把服务端返回的新清单/新归属装回内存，并重画纸面角标。 */
/** @param {'topics'|'categories'|'combos'} kind @param {any} res */
function applyManageResult(kind, res) {
  if (!state.teach) return;
  if (Array.isArray(res.list)) {
    const listKind = /** @type {'topics'|'categories'} */ (kind);
    state.teach = { ...(state.teach ?? { topics: [], categories: [], combos: [], bindings: emptyTeachBindings(), error: "" }), [listKind]: normalizeTeachList({ [listKind]: res.list }, listKind) };
  }
  if (Array.isArray(res.combos)) {
    state.teach = { ...state.teach, combos: normalizeCombos({ combos: res.combos }) };
  }
  const docPayload = res.bindings ? res.bindings[state.doc] : undefined;
  if (docPayload) {
    state.teach = { ...state.teach, bindings: normalizeTeachBindings(docPayload) };
    for (let i = 0; i < state.pages.length; i++) repaintPage(i);
  }
  updatePickTray();
  if (!state.manage) return;
  state.manage.usage = null; // 数字随清单一起过期，重新问
  state.manage.renaming = null;
  renderManageList();
  refreshManageUsage();
}

/** @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item */
/** @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item @param {string} name */
async function commitManageRename(kind, item, name) {
  if (!state.teach) return;
  const clean = String(name ?? "").trim();
  if (kind === "combos") {
    const res = renameCombo(state.teach.combos ?? [], item.id, clean);
    if (!res.item) {
      showManageHint(res.error ?? "改名失败");
      return;
    }
    const saved = await saveComboList(res.list, `组合「${res.item.name}」`);
    if (!saved.ok || !state.manage) return;
    renderManageList();
    showManageHint(`已改名为「${res.item.name}」`, "ok");
    return;
  }
  if (!clean) {
    showManageHint("名字不能为空");
    return;
  }
  const dup = (state.teach[kind] ?? []).some((x) => x.id !== item.id && x.name.trim() === clean);
  if (dup) {
    showManageHint(`已有同名：${clean}`);
    return;
  }
  const res = await manageTeach("rename", kind, item.id, clean);
  if (!res.ok) {
    showManageHint(res.error ?? "改名失败");
    return;
  }
  applyManageResult(kind, res);
  showManageHint(`已改名为「${clean}」`, "ok");
}

/** 下架（软删除）：题上的归属一个都不动。 @param {'topics'|'categories'|'combos'} kind */
/** @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item */
async function commitManageRetire(kind, item) {
  if (!state.teach) return;
  clearManageHint();
  if (kind === "combos") {
    const res = retireCombo(state.teach.combos ?? [], item.id);
    if (!res.item) {
      showManageHint(res.error ?? "下架失败");
      return;
    }
    const saved = await saveComboList(res.list, `组合「${item.name}」`);
    if (!saved.ok || !state.manage) return;
    renderManageList();
    showManageHint(`已下架「${item.name}」，在「已下架」里可以恢复`, "ok");
    return;
  }
  const res = await manageTeach("retire", kind, item.id);
  if (!res.ok) {
    showManageHint(res.error ?? "下架失败");
    renderManageList();
    return;
  }
  applyManageResult(kind, res);
  showManageHint(
    `已下架「${res.item ?? item.name}」（${res.stillAssigned ?? 0} 题上的归类保留，随时可恢复）`,
    "ok",
  );
}

/** 恢复已下架项。 @param {'topics'|'categories'|'combos'} kind */
/** @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item */
async function commitManageRestore(kind, item) {
  if (!state.teach) return;
  clearManageHint();
  if (kind === "combos") {
    const res = restoreCombo(state.teach.combos ?? [], item.id);
    if (!res.item) {
      showManageHint(res.error ?? "恢复失败");
      return;
    }
    const saved = await saveComboList(res.list, `组合「${item.name}」`);
    if (!saved.ok || !state.manage) return;
    renderManageList();
    showManageHint(`已恢复「${item.name}」`, "ok");
    return;
  }
  const res = await manageTeach("restore", kind, item.id);
  if (!res.ok) {
    showManageHint(res.error ?? "恢复失败");
    renderManageList();
    return;
  }
  applyManageResult(kind, res);
  showManageHint(`已恢复「${res.item ?? item.name}」，挑题时又能选了`, "ok");
}

/* ── 组合条拖动排序：长按 380ms 进入拖动，松手写回 combos.json ── */
let suppressComboClick = false;
/** @type {any} */
let comboPress = null;
/** @type {any} */
let comboTimer = null;
/** @type {any} */
let comboDrag = null;

function comboOrder() {
  const strip = $("combo-strip");
  if (!strip) return [];
  return [...strip.querySelectorAll(".combo-chip")].map((b) => /** @type {HTMLElement} */ (b).dataset.id ?? "");
}

function bindComboDrag() {
  const strip = $("combo-strip");
  if (!strip) return;
  const finish = () => {
    clearTimeout(comboTimer);
    comboTimer = null;
    if (!comboDrag) {
      comboPress = null;
      return;
    }
    const drag = comboDrag;
    comboDrag = null;
    drag.chip.classList.remove("dragging");
    strip.classList.remove("dragging");
    try {
      strip.releasePointerCapture(drag.pointerId);
    } catch {
      /* ignore */
    }
    const ids = comboOrder();
    setTimeout(() => (suppressComboClick = false), 350);
    if (JSON.stringify(ids) === JSON.stringify(drag.before)) return;
    const prev = state.teach?.combos ?? [];
    const byId = new Map(prev.map((c) => [c.id, c]));
    const next = /** @type {import('./teach-store.js').TeachCombo[]} */ (ids.map((id) => byId.get(id)).filter((c) => !!c));
    if (next.length !== prev.length) return;
    if (JSON.stringify(next.map((c) => c.id)) === JSON.stringify(prev.map((c) => c.id))) return;
    void saveComboList(next, "组合顺序").then((r) => {
      if (r.ok) flash("组合顺序已保存");
    });
  };

  strip.addEventListener("pointerdown", (e) => {
    if (!state.picked) return;
    const chip = /** @type {HTMLElement} */ (e.target).closest?.(".combo-chip");
    if (!chip) return;
    clearTimeout(comboTimer);
    comboPress = { chip, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    comboTimer = setTimeout(() => {
      if (!comboPress) return;
      comboDrag = { ...comboPress, before: comboOrder() };
      comboPress = null;
      comboDrag.chip.classList.add("dragging");
      strip.classList.add("dragging");
      suppressComboClick = true;
      try {
        strip.setPointerCapture(comboDrag.pointerId);
      } catch {
        /* ignore */
      }
    }, 380);
  });

  strip.addEventListener("pointermove", (e) => {
    if (comboDrag) {
      e.preventDefault();
      const chip = comboDrag.chip;
      const chips = [...strip.querySelectorAll(".combo-chip")];
      let before = null;
      for (const c of chips) {
        if (c === chip) continue;
        const r = c.getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          before = c;
          break;
        }
      }
      if (before) {
        if (chip.nextElementSibling !== before) strip.insertBefore(chip, before);
      } else if (strip.lastElementChild !== chip) {
        strip.appendChild(chip);
      }
      return;
    }
    if (!comboPress) return;
    if (Math.abs(e.clientX - comboPress.x) > 8 || Math.abs(e.clientY - comboPress.y) > 8) {
      clearTimeout(comboTimer);
      comboTimer = null;
      comboPress = null;
      suppressComboClick = true;
      setTimeout(() => (suppressComboClick = false), 350);
    }
  });

  strip.addEventListener("pointerup", finish);
  strip.addEventListener("pointercancel", () => {
    clearTimeout(comboTimer);
    comboTimer = null;
    comboPress = null;
    if (comboDrag) {
      comboDrag.chip.classList.remove("dragging");
      strip.classList.remove("dragging");
      comboDrag = null;
    }
  });
}

/** @param {string} qid @param {{topicIds:string[],categoryIds:string[]}} assignment */
function rememberClassified(qid, assignment) {
  if (assignment.topicIds.length || assignment.categoryIds.length) {
    state.lastClassified = {
      doc: state.doc,
      questionId: qid,
      assignment: { topicIds: [...assignment.topicIds], categoryIds: [...assignment.categoryIds] },
      label: assignmentLabel(assignment),
    };
  } else if (state.lastClassified?.questionId === qid) {
    state.lastClassified = null;
  }
  updateSameButton();
}

/** @type {any} */
let undoTimer = null;
/** @param {string} label @param {UndoRecord} action */
function showUndo(label, action) {
  state.undo = action;
  $("pick-undo-text").textContent = label;
  $("pick-undo").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => hideUndo(), 5000);
  const t = $("toast");
  if (t) {
    t.hidden = true;
    t.classList.remove("on");
  }
}

function hideUndo() {
  clearTimeout(undoTimer);
  state.undo = null;
  const box = $("pick-undo");
  if (box) box.hidden = true;
}

function undoLast() {
  const a = state.undo;
  if (!a) return;
  hideUndo();
  if (state.doc !== a.doc) {
    flash("换卷后不能撤销");
    return;
  }
  if (state.lastClassified?.questionId === a.qid) state.lastClassified = null;
  const before = state.teach?.bindings ?? emptyTeachBindings();
  const next = replaceBinding(before, a.qid, a.prevBinding);
  commitTeach(next, "已撤销", before, { qid: a.qid, pageIndex: a.pageIndex }, { undoable: false, remember: false });
  flash("已撤销");
  updateSameButton();
}

function applySameAsPrevious() {
  if (!state.picked || !state.lastClassified) return;
  const { q, p } = state.picked;
  const prev = state.lastClassified;
  if (prev.doc !== state.doc || prev.questionId === q.id) return;
  const before = state.teach?.bindings ?? emptyTeachBindings();
  const anchor = anchorOf(q, p, p.blocks[q.blocks?.[0]]);
  const next = sameAsPrevious(before, q.id, prev.assignment, anchor);
  commitTeach(next, `同上题：${prev.label}`, before, { qid: q.id, pageIndex: p.index });
}

let teachSaveChain = Promise.resolve();
/** @param {import('./teach-store.js').TeachBindings} next @param {string} label @param {import('./teach-store.js').TeachBindings} prev @param {{qid:string,pageIndex:number}} ctx @param {{undoable?:boolean,remember?:boolean}} [opts] */
function commitTeach(next, label, prev, ctx, opts = {}) {
  const { qid, pageIndex } = ctx;
  state.teach = { ...(state.teach ?? { topics: [], categories: [], combos: [], bindings: emptyTeachBindings(), error: "" }), bindings: next };
  updatePickTray();
  repaintPage(pageIndex);
  if (opts.undoable === false) flash(label);

  const doc = state.doc;
  const prevBinding = cloneBinding(bindingFor(prev, qid));
  const nextBinding = cloneBinding(bindingFor(next, qid));
  const payload = JSON.parse(JSON.stringify(next));
  const nextRef = next;
  teachSaveChain = teachSaveChain
    .then(async () => {
      const r = await saveTeachBindings(doc, payload);
      if (r.ok) {
        clearTeachNotice();
        if (opts.remember !== false) rememberClassified(qid, assignmentFor(next, qid));
        if (opts.undoable !== false && JSON.stringify(prevBinding) !== JSON.stringify(nextBinding)) {
          showUndo(label, { doc, qid, pageIndex, prevBinding, nextBinding });
        }
        return;
      }
      hideUndo();
      const rolledBack = state.doc === doc && state.teach?.bindings === nextRef;
      if (rolledBack) {
        state.teach = { ...(state.teach ?? { topics: [], categories: [], combos: [], bindings: emptyTeachBindings(), error: "" }), bindings: prev };
        updatePickTray();
        repaintPage(pageIndex);
      }
      notice(
        [`教学归类未能保存：${r.error ?? "未知错误"}${rolledBack ? "（本次改动已回退）" : "（后续改动仍在，未回退）"}`],
        "err",
      );
    })
    .catch((e) => {
      hideUndo();
      notice([`教学归类保存异常：${String(e).slice(0, 100)}`], "err");
    });
}

/** @param {'topics'|'categories'} kind */
function openCreate(kind) {
  if (!state.picked) {
    flash("先点一道题");
    return;
  }
  state.creating = kind;
  const form = $("pick-create");
  const input = $("pick-create-name");
  form.hidden = false;
  document.querySelector(".pick-tray")?.classList.add("creating");
  (/** @type {HTMLInputElement} */ (input)).value = "";
  (/** @type {HTMLInputElement} */ (input)).placeholder = kind === "topics" ? "新专题名" : "新类别名";
  input.focus();
}

function closeCreate() {
  state.creating = null;
  const form = $("pick-create");
  if (form) form.hidden = true;
  document.querySelector(".pick-tray")?.classList.remove("creating");
  const input = $("pick-create-name");
  if (input) (/** @type {HTMLInputElement} */ (input)).value = "";
}

/** @param {'topics'|'categories'} kind @param {string} id */
function revealChip(kind, id) {
  const box = $(kind === "topics" ? "pick-topics" : "pick-categories");
  const chip = [...box.querySelectorAll(".pick-chip")].find((b) => /** @type {HTMLElement} */ (b).dataset.id === id);
  chip?.scrollIntoView?.({ inline: "center", block: "nearest" });
}

/**
 * 新建专题/类别并立刻打给当前题（内联表单与「搜不到就新建」共用一条路径）。
 * 名字已存在时复用既有条目，不重复写清单。
 * @param {'topics'|'categories'} kind @param {string} name
 */
async function applyCreate(kind, name) {
  if (!state.picked || !state.teach) return false;
  const prefix = kind === "topics" ? "tp" : "ct";
  const list = kind === "topics" ? state.teach.topics : state.teach.categories;
  const res = addTeachItem(list, name, prefix);
  if (!res.item) {
    flash(res.error ?? "新建失败");
    return false;
  }
  // created = 真新建；revived = 同名的那一项原本已下架，这次要**落盘**摘掉下架标记，
  // 否则只改内存、刷新又变回下架态（2026-10-30 交接 2 第 2 条）
  if (res.created || res.revived) {
    const payload =
      kind === "topics"
        ? { version: 1, updatedAt: new Date().toISOString(), topics: res.list }
        : { version: 1, updatedAt: new Date().toISOString(), categories: res.list };
    const saved = await saveTeach(kind, payload);
    if (!saved.ok) {
      notice([`${res.revived ? "恢复" : "新建"}失败：${saved.error ?? "未知错误"}`], "err");
      return false;
    }
    state.teach = { ...state.teach, [kind]: res.list };
    clearTeachNotice();
  }
  const { q, p } = state.picked;
  const before = state.teach?.bindings ?? emptyTeachBindings();
  const cur = assignmentFor(before, q.id);
  const already = kind === "topics" ? cur.topicIds.includes(res.item.id) : cur.categoryIds.includes(res.item.id);
  closeCreate();
  bumpRecent(kind, res.item.id);
  if (already) {
    renderPickRows();
    revealChip(kind, res.item.id);
    flash(`已经在「${res.item.name}」里`);
    return true;
  }
  const anchor = anchorOf(q, p, p.blocks[q.blocks?.[0]]);
  const next =
    kind === "topics" ? toggleTopic(before, q.id, res.item.id, anchor) : toggleCategory(before, q.id, res.item.id, anchor);
  commitTeach(next, `已放入：${res.item.name}`, before, { qid: q.id, pageIndex: p.index });
  revealChip(kind, res.item.id);
  return true;
}

/** @param {Event} e */
async function submitCreate(e) {
  e.preventDefault();
  const kind = state.creating;
  if (!kind || !state.picked || !state.teach) return;
  const input = $("pick-create-name");
  const ok = await applyCreate(kind, (/** @type {HTMLInputElement} */ (input)).value);
  if (!ok) input.focus();
}


function bindKeyboardLift() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--pick-kb", `${Math.round(kb)}px`);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

function clearPickSelection() {
  state.picked = null;
  for (const node of document.querySelectorAll(".blk.pick-selected, .q-chip.pick-selected")) {
    node.classList.remove("pick-selected");
  }
  updatePickTray();
}

/** 给选中题的所有块与号牌加高亮；只加 class/outline，不改任何几何。
 * @param {PageSlot | undefined} slot */
function paintPickSelection(slot) {
  const q = state.picked?.q;
  if (!q || !slot?.paper) return;
  const blocks = new Set((q.blocks ?? []).map(String));
  for (const node of slot.paper.canvas.querySelectorAll(".blk")) {
    const bi = /** @type {HTMLElement} */ (node).dataset?.bi;
    if (bi !== undefined && blocks.has(bi)) node.classList.add("pick-selected");
  }
  for (const chip of slot.paper.wrap.querySelectorAll(".q-chip")) {
    if (/** @type {HTMLElement} */ (chip).dataset?.qid === q.id) chip.classList.add("pick-selected");
  }
}

/** @param {SnapQuestion} q @param {SnapPage} p */
function pickQuestion(q, p) {
  if (!state.pickMode) return;
  closeCreate();
  clearPickSelection();
  state.picked = { q, p };
  const slot = state.pages[p.index];
  paintPickSelection(slot);
  const chip = slot?.paper?.wrap.querySelector(".q-chip.pick-selected");
  chip?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  updatePickTray();
}

/** @param {boolean} on */
function setPickMode(on) {
  if (on && isPhoneViewport()) {
    // 挑题依赖「号牌 + 块坐标」，文本流两者都没有 ⇒ 明确拒绝并给出出路，不做静默失效
    flash("文本流视图不支持挑题：加 ?flow=0 切回纸面再挑");
    return;
  }
  state.pickMode = on;
  document.body.classList.toggle("pick-mode", on);
  const btn = $("t-pick");
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "退出挑题" : "挑题";
  $("pick-tray").hidden = !on;
  if (on) {
    $("detail").hidden = true;
    state.sheet = null;
    updatePickTray();
  } else {
    closeCreate();
    closeComboPop();
    closeManage();
    if (state.search.on) setSearchOn(false);
    hideUndo();
    clearPickSelection();
  }
}

/** 点整道题：按下到抬起移动 >10px 视为滚动，不选。 */
/** @type {{ x: number, y: number } | null} */
let pickDown = null;
function bindPickPointer() {
  const book = $("book");
  book.addEventListener("pointerdown", (e) => {
    if (!state.pickMode) return;
    pickDown = { x: e.clientX, y: e.clientY };
  });
  book.addEventListener("pointerup", (e) => {
    if (!state.pickMode || !pickDown) return;
    const down = pickDown;
    pickDown = null;
    if (Math.abs(e.clientX - down.x) > 10 || Math.abs(e.clientY - down.y) > 10) return;
    const target = /** @type {HTMLElement | null} */ (e.target);
    if (!target) return;
    const sec = target.closest?.(".bk-page");
    if (!sec) return;
    const idx = Number(sec.id.replace("pg-", "")) - 1;
    const slot = state.pages[idx];
    if (!slot?.paper) return;
    const chip = /** @type {HTMLElement | null} */ (target.closest?.(".q-chip"));
    if (chip?.dataset?.qid) {
      const q = slot.p.questions.find((x) => x.id === chip.dataset.qid);
      if (q) pickQuestion(/** @type {SnapQuestion} */ (q), slot.p);
      return;
    }
    const rect = slot.paper.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const xPt = ((e.clientX - rect.left) * slot.p.width) / rect.width;
    const yPt = ((e.clientY - rect.top) * slot.p.height) / rect.height;
    const q = pickQuestionAt(slot.p, xPt, yPt, 6);
    if (q) pickQuestion(/** @type {SnapQuestion} */ (q), slot.p);
  });
  book.addEventListener("pointercancel", () => {
    pickDown = null;
  });
}

/** 标签面板拿的「应用」句柄：写路径只有 commitBindings / commitLibrary 两条 */
const tagApp = {
  /** @returns {TagState} openSheet 只在 `if (state.tags)` 之后才把本句柄交给 tagSection ⇒
   *  「tags 为 null」在句柄使用期内不可达，这里按该不变量收窄（tag-panel.js:38 的 TagApp 要求非空） */
  get tags() {
    return /** @type {TagState} */ (state.tags);
  },
  /** @param {TagState} v */
  set tags(v) {
    state.tags = v;
  },
  /** @param {DocTags} next */
  commitBindings: (next) => saveBindings(state.doc, next),
  /** @param {Library} next */
  commitLibrary: (next) => saveLibrary(next),
  /** @param {QuestionRef} q @param {PageRef} p */
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
/**
 * @param {SnapQuestion} q
 * @param {SnapPage} p
 */
async function openSheet(q, p) {
  if (state.pickMode) {
    pickQuestion(q, p);
    return;
  }
  const d = $("detail");
  const token = (state.sheetToken = {}); // 连点两个号牌时，后点开的才算数
  d.replaceChildren();
  const close = el("button", "close", "关闭 ×");
  close.addEventListener("click", () => {
    d.hidden = true;
    state.sheet = null;
  });
  d.append(close);
  state.sheet = { q, p };

  // 顺序即优先级：先「这是哪道题」，再「归了什么类」，然后才是业务标签与题面/答案。
  // 教学归类提到标签区之前，是因为标签区有 7 行 × 44px，放它后面等于要滚一屏才看得见（U09）。
  d.append(el("h3", "", `第 ${q.number} 题（${q.section || "未识别大题"}）`));
  d.append(
    el(
      "p",
      "kv",
      `第 ${p.index + 1} 页 · ${q.type === "choice" ? "选择题" : "主观题"} · ` +
        `可信度 ${Math.round(q.confidence * 100)}%${q.status === "needs_review" ? " · 需人工校对" : ""}`,
    ),
  );
  d.append(teachReadonlySection(q, p));
  if (state.tags) d.append(tagSection(tagApp, q, p, anchorOf(q, p, p.blocks[q.blocks?.[0]])));

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

/** 当前卷是题册还是答案册（措辞与"哪一面是自己"都靠它）
 * @param {string} doc
 * @returns {string} "quiz" | "answer"（取自 meta.json，类型只按字符串对待）
 */
function docKind(doc) {
  return DOCS.find((x) => x.id === doc)?.kind ?? "quiz";
}

/**
 * 阅读模式里的**只读**「教学归类」区（U09）。
 *
 * 为什么要有：挑题归类是在成品页底部托盘里完成的，离开挑题模式后**看不见归了什么** ——
 * 只靠号牌上的 `N·M` 角标，既不知道是哪几个专题，也没法核对。这里把归属原样列出来，
 * 并给一个「去挑题修改」直接跳过去（进挑题模式 + 选中该题），不用自己再找一遍。
 *
 * 只读 = 不在这里增删（增删只走托盘，避免两套写入口）。**下架项照样显示**并标注「已下架」：
 * 题上的归属确实还在（软删除语义），藏起来会让人以为归类丢了。
 */
/** @param {SnapQuestion} q @param {SnapPage} p */
function teachReadonlySection(q, p) {
  const box = el("section", "teach-read");
  box.append(el("h4", "", "教学归类"));
  const teach = state.teach;
  if (!teach) {
    box.append(el("p", "kv", "归类清单还没加载好：刷新一次再试。"));
    return box;
  }
  if (teach.error) {
    box.append(el("p", "kv", `归类清单读取失败：${teach.error}（角标与这里都会显示为空，不代表没归类）`));
  }
  const a = assignmentFor(teach.bindings ?? emptyTeachBindings(), q.id);
  /** @param {'topics'|'categories'} kind */
  /** @param {string} label @param {'topics'|'categories'} kind @param {string[]} ids */
  const row = (label, kind, ids) => {
    const line = el("div", "teach-read-row");
    line.append(el("span", "teach-read-label", label));
    const chips = el("div", "teach-read-chips");
    if (!ids.length) chips.append(el("span", "teach-read-none", "未归类"));
    for (const id of ids) {
      const item = (teach[kind] ?? []).find((x) => x.id === id) ?? null;
      const cls = "teach-read-chip" + (item?.retired ? " retired" : "");
      // 清单里找不到 = 断链（被彻底删过），如实说，不编名字
      chips.append(el("span", cls, item ? `${item.name}${item.retired ? "（已下架）" : ""}` : `${id}（清单里找不到）`));
    }
    line.append(chips);
    return line;
  };
  box.append(row("专题", "topics", a.topicIds));
  box.append(row("类别", "categories", a.categoryIds));
  const go = el("button", "teach-read-go", "去挑题修改");
  go.type = "button";
  go.addEventListener("click", () => {
    setPickMode(true); // 会顺手把详情面板关掉
    pickQuestion(q, p);
    const chip = state.pages[p.index]?.paper?.wrap.querySelector(".q-chip.pick-selected");
    chip?.scrollIntoView?.({ block: "center" });
  });
  box.append(go);
  return box;
}

/**
 * 顶部体检摘要：把 `meta.json` 的结论翻译成一句人话。
 * - `examined=false` ⇒ 说「未体检」而不是「通过」（没测过 ≠ 没问题）；
 * - 有 issues ⇒ 显示第一条，悬停/点击看全部。
 * @param {string} doc
 */
function renderHealth(doc) {
  const box = $("doc-health");
  const d = DOCS.find((x) => x.id === doc);
  box.hidden = false;
  box.className = "fb-health";
  box.replaceChildren();
  if (!d) {
    box.hidden = true;
    return;
  }
  /** @type {DocStats} */
  const s = d.stats ?? {};
  const bits = [];
  if (s.questions !== undefined) bits.push(`${s.questions} 题`);
  if (s.pages !== undefined) bits.push(`${s.pages} 页`);
  if (s.ocrFilled) bits.push(`补回 ${s.ocrFilled} 处`);

  let tail = "未体检";
  if (d.examined && d.health) {
    if (d.health.level === "fail") {
      tail = d.health.short ?? "体检失败";
      box.classList.add("bad");
    } else if (d.health.level === "warn") {
      // 只写条数：完整原因在悬停/点击里（顶部一行放不下"3 题标记为需人工校对"这种长句，
      // 放不下就会把页码挤走 —— 2026-10-27 截图实测）
      tail = d.health.short ?? `${d.health.issues?.length ?? 0} 处提示`;
      box.classList.add("warn");
    } else {
      tail = "体检通过";
    }
  }
  box.append(el("span", "", [...bits, tail].join(" · ")));
  if (d.health?.issues?.length) {
    // 同一引用先取局部：闭包里 `d.health.issues` 会丢收窄（health 可变属性），取局部不改变任何读取时机
    const issues = d.health.issues;
    box.title = issues.join("\n");
    box.append(el("span", "more", "详情"));
    box.onclick = () =>
      notice([["div", "本册体检："], ...issues.map((x) => /** @type {[string, string]} */ (["div", `· ${x}`]))], "warn");
    box.style.cursor = "pointer";
  } else {
    box.title = "体检通过：题号连续、无未解释的抑制";
    box.onclick = null;
    box.style.cursor = "";
  }
}

/** 一面：先试纸面裁切；拿不到快照或块才退回文本 + 图片条，并明说是降级（不静默换排法）。
 *  返回 null = 这次点击已作废（调用方不许再往面板里塞东西）。
 * @param {object} token 本次点击的令牌（state.sheetToken）
 * @param {HTMLElement} d 面板容器
 * @param {string} label
 * @param {{ id: string, doc: string }} side 要裁的条目：id + 所属卷
 * @param {number} w 面板可用宽
 * @param {() => HTMLElement[]} fallback 降级出口（textFallback）
 * @returns {Promise<HTMLElement | null>}
 */
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

/** 降级出口：文本 + 按阅读顺序的图片条（位置不如纸面准，但图不丢）
 * @param {string} stem
 * @param {OptLine[] | null | undefined} options
 * @param {ImageRef[] | null | undefined} images
 * @param {string} doc
 * @returns {HTMLElement[]}
 */
function textFallback(stem, options, images, doc) {
  /** @type {HTMLElement[]} */
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

/** 一条目可能跨页：段列表由 `entrySegments` 从整册快照里按 id 找齐。
 * @param {Snap | null} snap
 * @param {string} qid
 * @param {string} doc
 * @param {number} w
 * @returns {CropBox | null}
 */
function cropOf(snap, qid, doc, w) {
  const segs = snap ? entrySegments(snap.pages, qid) : [];
  if (!segs.length) return null;
  try {
    // `holes`/`foreignBlocks` 是 entryCrop 的**声明契约**（entry-paper.js:326-327），
    // 但其导出签名只到 `HTMLElement | null` ⇒ 调用点按契约收窄（d.ts 遮蔽债 HANDOFF §6-29 同源问题）
    return /** @type {CropBox} */ (entryCrop(segs, doc, w, { candidateStyle: state.ocrStyle }));
  } catch (e) {
    console.warn("按原卷裁切失败，退回文本：", String(e).slice(0, 80));
    return null;
  }
}

/** 另一册的快照按需拉取并缓存（题册 0.4 MB / 答案册 0.9 MB）
 * @param {string} doc
 * @returns {Promise<Snap>}
 */
async function snapshotOf(doc) {
  // `has` 已判过存在 ⇒ `get` 的 `| undefined` 只是 lib 签名，cast 不产生运行时代码
  if (state.snaps.has(doc)) return /** @type {Snap} */ (state.snaps.get(doc));
  const snap = /** @type {Snap} */ (await fetchJson(`/data/out/${enc(doc)}/stages.json`));
  state.snaps.set(doc, snap);
  return snap;
}

/** `docId:p2:q23` → `docId`（图片要拼 `/data/out/<docId>/images/`）
 * @param {string} id
 * @returns {string}
 */
function docOf(id) {
  const i = String(id ?? "").lastIndexOf(":p");
  return i > 0 ? id.slice(0, i) : state.doc;
}

/**
 * 图片条：**只在降级路径里出现**（正常路径是 entryCrop，图按原卷位置排）。
 * 按原卷阅读顺序（bbox 先 y 后 x）排；此时手里只有一维文本，没有可回填的位置标记。
 * @param {ImageRef[] | null | undefined} images
 * @param {string} doc
 * @param {string} label
 * @returns {HTMLElement}
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
  // renderBook 只在快照就位后被调用（loadDoc 尾部 / 三个开关 / resize 的 `if (state.data)`）
  // ⇒ 边界收窄：cast 不产生运行时代码，真为 null 时依旧在 `.pages` 上抛 TypeError
  const data = /** @type {Snap} */ (state.data);
  data.pages.forEach((p, i) => {
    const sec = el("section", "bk-page");
    sec.id = `pg-${i + 1}`;
    const head = el("p", "bk-head", `第 ${i + 1} / ${data.pages.length} 页`);
    const pr = paper(p);
    sec.append(head, pr.wrap);
    book.append(sec);
    state.pages[i] = { sec, head, p, paper: pr };
  });
  if (state.picked) paintPickSelection(state.pages[state.picked.p.index]);
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
  $("page-now").textContent = `${cur} / ${secs.length}`;
  $("page-now").title = `第 ${cur} / ${secs.length} 页`;
  savePosition(cur);
}

/**
 * 题干/选项/图片的权威来源。⚠️ **不能用 stages.json 的题目对象**：
 * 那里只有 id/number/section/type/blocks/startsHere/confidence/status/reasons，
 * 没有 stem/options/images —— 曾经面板因此把题干渲染成字面量 `undefined`、选项恒 0、图片全丢。
 * 阅读版（viewer/）一直读的就是这份（viewer.js:28）。
 * @param {string} doc
 */
async function loadQuestions(doc) {
  state.byId = null;
  state.byIdError = "";
  try {
    // 产物实际是裸数组；`list.questions ?? list` 兼容带壳返回 ⇒ 用交叉类型声明，
    // 数组上读不到 `questions`（undefined）走 ?? 兜底，运行路径与原先逐字相同
    const list = /** @type {BankQuestion[] & { questions?: BankQuestion[] }} */ (
      await fetchJson(`/data/out/${enc(doc)}/questions.json`)
    );
    /** @type {Map<string, BankQuestion>} */
    const m = new Map();
    for (const q of list.questions ?? list) m.set(q.id, q);
    state.byId = m;
  } catch (e) {
    state.byIdError = String(e).slice(0, 60);
  }
}

async function loadBank() {
  try {
    const list = /** @type {BankEntry[]} */ (await fetchJson("/data/out/bank/bank.json"));
    /** @type {Map<string, BankEntry>} */
    const byQuizId = new Map();
    /** @type {Map<string, BankEntry>} */
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

/**
 * 拉文档清单。失败时**不空着**：有 `?doc=` 就按它直接开（至少能读这一卷），
 * 没有就给出「先导入」的可操作提示。静默失败在这里等于「页面白屏且不说为什么」。
 */
async function loadDocs() {
  const asked = new URLSearchParams(location.search).get("doc");
  try {
    const j = /** @type {{ docs?: DocMeta[] }} */ (await fetchJson("/api/docs"));
    DOCS = (j.docs ?? []).map((d) => ({ ...d, label: d.label || d.id }));
    if (!DOCS.length) throw new Error("服务端没发现任何文档");
  } catch (e) {
    DOCS = [];
    if (asked) {
      DOCS = [
        {
          id: asked,
          label: asked,
          kind: /答案|解析/.test(asked) ? "answer" : "quiz",
          examined: false,
          stats: null,
          health: null,
        },
      ];
      notice([`读不到文档清单（${String(e).slice(0, 50)}），已按网址里的 doc 参数直接打开这一卷。`], "warn");
    } else {
      notice(
        [
          `读不到文档清单（${String(e).slice(0, 50)}）。先跑 `,
          ["code", "npm run daily -- <pdf>"],
          " 导入一份试卷；或在网址后加 ?doc=<docId> 指定。",
        ],
        "err",
      );
    }
  }
  DEFAULT_DOC = DOCS[0]?.id ?? "";
  state.doc = asked && DOCS.some((d) => d.id === asked) ? asked : DEFAULT_DOC;
}

/**
 * @param {string} doc
 */
async function loadDoc(doc) {
  try {
    state.data = /** @type {Snap} */ (await fetchJson(`/data/out/${enc(doc)}/stages.json`));
    state.doc = doc;
    /** @type {HTMLSelectElement} */ ($("doc-pick")).value = doc;
    /** @type {HTMLAnchorElement} */ ($("lnk-stages")).href = `/stages/?doc=${enc(doc)}&stage=6&page=1`;
    /** @type {HTMLAnchorElement} */ ($("lnk-viewer")).href = `/viewer/?doc=${enc(doc)}`;
    $("notice").hidden = true;
    $("detail").hidden = true; // 换卷时关掉面板，避免标签区指着上一卷的题目
    state.sheet = null;
    state.picked = null;
    state.lastClassified = null;
    hideUndo();
    closeCreate();
    closeComboPop();
    updatePickTray();
    await loadQuestions(doc);
    state.snap = state.data;
    await loadTags();
    await loadTeach(doc);
    renderBook();
    renderHealth(doc);
    if (!/^#pg-\d+$/.test(location.hash)) restorePosition();
  } catch (e) {
    notice(
      [
        "读取不到「",
        doc,
        "」的快照（",
        String(e).slice(0, 60),
        "）。先跑 ",
        ["code", `npm run daily -- <pdf> --id "${doc}"`],
        " 或 ",
        ["code", "npm run stages:export"],
        " 生成。",
      ],
      "err",
    );
  }
}

/* ── 跳转 / 搜索 / 阅读进度 ──
 *
 * 三件事共用**一个输入框**（用户原话："尽量不让我手动参与"，那就别让他先选模式再输入）：
 *   12       → 第 12 题（多节同号时列出来让他点）
 *   p7       → 第 7 页
 *   摩擦力    → 搜正文，列出命中片段
 * 判断顺序固定：页码 → 纯数字题号 → 其余当搜索。**认不出的输入必须说话**（flash 提示），
 * 静默不动会让人以为坏了。
 */

/** 底部轻提示（2.4s 自动消失） */
/** @type {ReturnType<typeof setTimeout> | undefined} 定时器句柄；初值 null→undefined：两者都是 clearTimeout 的空句柄 no-op，行为不变（同 stages.js:716 的处理） */
let toastTimer = undefined;
/** @param {string} text */
function flash(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("on");
    t.hidden = true;
  }, 2400);
}

/** 跳转后必须看得见"跳到了哪"：短暂高亮 2s
 * @param {Element | null} node
 */
function markHit(node) {
  if (!node) return;
  node.classList.add("hit");
  setTimeout(() => node.classList.remove("hit"), 2000);
}

/** @param {number} index @returns {HTMLElement | null} */
function pageEl(index) {
  return document.getElementById(`pg-${index + 1}`);
}

/** @param {number} index @returns {boolean} */
function jumpToPage(index) {
  const sec = pageEl(index);
  if (!sec) return false;
  sec.scrollIntoView({ block: "start", behavior: "smooth" });
  // 跳转即视为"读到这里"，并锁住途中上报的中间页（见 posLockUntil 的说明）
  posLockUntil = Date.now() + 1500;
  savePosition(index + 1, true);
  return true;
}

/** 本册所有该题号的题（不同节会重号 ⇒ 天然是列表）
 * @param {string} n
 * @returns {Array<{ pageIndex: number, q: SnapQuestion }>}
 */
function questionsByNumber(n) {
  /** @type {Array<{ pageIndex: number, q: SnapQuestion }>} */
  const out = [];
  // 只在 runJump 判过 `!state.data` 之后被调用 ⇒ 边界收窄（cast 不产生运行时代码）
  const data = /** @type {Snap} */ (state.data);
  data.pages.forEach((p, i) => {
    for (const q of p.questions ?? []) if (String(q.number) === String(n)) out.push({ pageIndex: i, q });
  });
  return out;
}

/** 只需要 {pageIndex, q} 两点：HitQuestion 与 questionsByNumber 的裸命中都结构兼容
 * @param {{ pageIndex: number, q: SnapQuestion }} hit @returns {boolean}
 */
function jumpToQuestion(hit) {
  jumpToPage(hit.pageIndex);
  const chip = document.querySelector(`.q-chip[data-qid="${CSS.escape(hit.q.id)}"]`);
  markHit(chip);
  return Boolean(chip);
}

/** 搜正文：返回 { pageIndex, blockIndex, snippet }，最多 60 条（再多也没人翻）
 * @param {string} text
 * @returns {HitBlock[]}
 */
function searchBlocks(text) {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  /** @type {HitBlock[]} */
  const out = [];
  // 只在 runJump 判过 `!state.data` 之后被调用 ⇒ 边界收窄（cast 不产生运行时代码）
  const data = /** @type {Snap} */ (state.data);
  for (let i = 0; i < data.pages.length; i++) {
    const blocks = data.pages[i].blocks ?? [];
    for (let k = 0; k < blocks.length; k++) {
      const t = blocks[k].text ?? "";
      const at = t.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const from = Math.max(0, at - 16);
      const snippet =
        (from > 0 ? "…" : "") +
        t
          .slice(from, at + needle.length + 24)
          .replace(/\s+/g, " ")
          .trim() +
        (at + needle.length + 24 < t.length ? "…" : "");
      out.push({ pageIndex: i, blockIndex: k, snippet });
      if (out.length >= 60) return out;
    }
  }
  return out;
}

/** 结果面板（题号候选与正文命中共用；点一行就跳过去）
 * @param {(HitQuestion | HitBlock)[]} hits
 * @param {string} title
 */
function showHits(hits, title) {
  const box = $("hits");
  box.replaceChildren();
  box.hidden = false;
  if (!hits.length) {
    box.append(el("div", "hit-empty", `没有找到「${title}」`));
    return;
  }
  box.append(el("div", "hit-head", `${hits.length} 处「${title}」—— 点一条跳过去`));
  for (const h of hits) {
    const row = el("button", "hit-row");
    row.append(el("span", "hit-pg", `p${h.pageIndex + 1}`));
    row.append(el("span", "hit-txt", h.snippet));
    row.addEventListener("click", () => {
      if (h.kind === "question") jumpToQuestion(h);
      else {
        jumpToPage(h.pageIndex);
        markHit(document.querySelector(`#pg-${h.pageIndex + 1} [data-bi="${h.blockIndex}"]`));
      }
      box.hidden = true;
    });
    box.append(row);
  }
}

/** 输入框的唯一入口：页码 → 题号 → 搜索
 * @param {string | null | undefined} raw
 */
function runJump(raw) {
  const q = String(raw ?? "").trim();
  if (!q || !state.data) return;
  const box = $("hits");

  const pageM = /^p\s*(\d{1,3})$/i.exec(q);
  if (pageM) {
    const n = Number(pageM[1]);
    const total = state.data.pages.length;
    if (n < 1 || n > total) {
      flash(`本册共 ${total} 页，没有第 ${n} 页`);
      return;
    }
    box.hidden = true;
    jumpToPage(n - 1);
    flash(`已到第 ${n} 页`);
    return;
  }

  if (/^\d{1,3}$/.test(q)) {
    const hits = questionsByNumber(q);
    if (!hits.length) {
      flash(`本册没有第 ${q} 题（要搜正文请直接输入文字）`);
      return;
    }
    if (hits.length === 1) {
      box.hidden = true;
      jumpToQuestion(hits[0]);
      flash(`已到第 ${q} 题（第 ${hits[0].pageIndex + 1} 页）`);
      return;
    }
    showHits(
      hits.map((h) => ({
        kind: "question",
        pageIndex: h.pageIndex,
        q: h.q,
        snippet: `第 ${q} 题${h.q.section ? ` · ${h.q.section}` : ""}`,
      })),
      `第 ${q} 题`,
    );
    return;
  }

  showHits(searchBlocks(q), q);
}

/* ── 阅读进度（每册独立）──
 * 每天用的人不会每天从第 1 页翻起。位置存 localStorage：
 * 隐私模式/禁用存储时**写不进去也不影响阅读**（try/catch 兜住，不弹错）。 */

/** @param {string} doc */
const posKey = (doc) => `final:pos:${doc}`;
/** @type {ReturnType<typeof setTimeout> | undefined} 同 toastTimer：null→undefined 对 clearTimeout 都是空句柄 no-op，行为不变 */
let posTimer = undefined;
/**
 * 跳转后的短暂锁：平滑滚动途中 `updatePageIndicator` 会一路报**中间页**
 * （实测跳 p7 被记成 p5）。锁住这段时间，只认"跳到的目标页"；锁一过，
 * 用户自己滚到哪就记哪。
 */
let posLockUntil = 0;

/**
 * @param {number} page
 * @param {boolean} [force]
 */
function savePosition(page, force = false) {
  if (!force && Date.now() < posLockUntil) return;
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    try {
      localStorage.setItem(posKey(state.doc), String(page));
    } catch {
      /* 存不了就算了，下次从第 1 页开始，不影响读 */
    }
  }, 400);
}

function restorePosition() {
  let p = 0;
  try {
    p = Number(localStorage.getItem(posKey(state.doc)) || 0);
  } catch {
    return;
  }
  // restorePosition 只在 loadDoc 的 renderBook 之后被调用 ⇒ 边界收窄（cast 不产生运行时代码）
  if (!p || p < 1 || p > /** @type {Snap} */ (state.data).pages.length) return;
  const sec = pageEl(p - 1);
  if (!sec) return;
  sec.scrollIntoView({ block: "start" });
  posLockUntil = Date.now() + 1500;
  savePosition(p, true);
  flash(`已回到上次位置：第 ${p} 页`);
}

/* ── 交互 ── */

function initBar() {
  // index.html 里 doc-pick 是 `<select>`、jump 是 `<input>`、t-* 是 `checkbox`：
  // `$` 只收窄到 HTMLElement（见上方注释），这里按元素实际标签再收一层（tag-panel.js:51 同法）
  const pick = /** @type {HTMLSelectElement} */ ($("doc-pick"));
  pick.replaceChildren();
  for (const d of DOCS) {
    const o = el("option", "", d.label);
    o.value = d.id;
    pick.append(o);
  }
  if (!DOCS.length) {
    const o = el("option", "", "（没有可用文档）");
    o.value = "";
    pick.append(o);
    pick.disabled = true;
  }
  pick.value = state.doc;
  pick.addEventListener("change", () => loadDoc(pick.value));

  const jump = /** @type {HTMLInputElement} */ ($("jump"));
  jump.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    runJump(jump.value);
  });
  // 输入框失焦时收起结果面板（点面板里的行之前会先失焦 ⇒ 延迟收，否则点不中）
  jump.addEventListener("blur", () => setTimeout(() => ($("hits").hidden = true), 180));

  const tAudit = /** @type {HTMLInputElement} */ ($("t-audit"));
  tAudit.addEventListener("change", (e) => {
    // change 的 e.target 即 checkbox 本体；为 null 时原先在 `.checked` 上抛 TypeError，cast 不改这点
    state.audit = /** @type {HTMLInputElement} */ (e.target).checked;
    renderBook();
  });
  const tFill = /** @type {HTMLInputElement} */ ($("t-fill"));
  tFill.checked = state.ocrFill;
  tFill.addEventListener("change", (e) => {
    state.ocrFill = /** @type {HTMLInputElement} */ (e.target).checked;
    renderBook();
  });
  const tOcr = /** @type {HTMLInputElement} */ ($("t-ocr"));
  tOcr.addEventListener("change", (e) => {
    state.ocrStyle = /** @type {HTMLInputElement} */ (e.target).checked;
    renderBook();
  });
  const more = $("t-more");
  const menu = $("more-menu");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    more.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (/** @type {HTMLElement | null} */ (e.target)?.closest?.(".fb-right")) return;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
  });
  for (const a of menu.querySelectorAll("a")) {
    a.addEventListener("click", () => {
      menu.hidden = true;
      more.setAttribute("aria-expanded", "false");
    });
  }

  $("t-pick").addEventListener("click", () => setPickMode(!state.pickMode));
  $("pick-close").addEventListener("click", () => setPickMode(false));
  $("pick-same").addEventListener("click", applySameAsPrevious);
  $("pick-undo-btn").addEventListener("click", undoLast);
  $("combo-close").addEventListener("click", closeComboPop);
  $("combo-add").addEventListener("click", openComboForm);
  $("combo-form").addEventListener("submit", (e) => void submitCombo(e));
  $("combo-cancel").addEventListener("click", closeComboPop);
  $("pick-manage").addEventListener("click", () => (state.manage ? closeManage() : openManage()));
  $("manage-close").addEventListener("click", closeManage);
  $("pick-find").addEventListener("click", () => setSearchOn(!state.search.on));
  $("pick-search-q").addEventListener("input", (e) => {
    state.search.q = /** @type {HTMLInputElement} */ (e.target).value;
    renderPickRows();
  });
  $("pick-search-clear").addEventListener("click", () => {
    const input = /** @type {HTMLInputElement | null} */ ($("pick-search-q"));
    state.search.q = "";
    if (input) (/** @type {HTMLInputElement} */ (input)).value = "";
    renderPickRows();
    input?.focus();
  });
  $("nomatch-topics").addEventListener("click", () => void createFromSearch("topics"));
  $("nomatch-categories").addEventListener("click", () => void createFromSearch("categories"));
  document.addEventListener("click", (e) => {
    // 用 composedPath 而不是 closest()：面板里的按钮点下去会同步重绘，
    // 那时 e.target 已经从 DOM 上摘下来了，closest 找不到祖先 → 会把刚打开的面板又关掉。
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    /** @param {string} id */
    const has = (id) => path.some((n) => /** @type {{ id?: string }} */ (n)?.id === id) || !!/** @type {HTMLElement} */ (e.target)?.closest?.(`#${id}`);
    if (!has("manage-pop") && !has("pick-manage")) closeManage();
    const pop = $("combo-pop");
    if (!pop || pop.hidden) return;
    if (has("combo-pop") || has("combo-add")) return;
    closeComboPop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeManage();
    closeComboPop();
    if (state.search.on) setSearchOn(false);
  });
  $("pick-add-topics").addEventListener("click", () => openCreate("topics"));
  $("pick-add-categories").addEventListener("click", () => openCreate("categories"));
  $("pick-create").addEventListener("submit", (e) => void submitCreate(e));
  $("pick-create-cancel").addEventListener("click", closeCreate);
  bindPickPointer();
  bindComboDrag();
  bindKeyboardLift();
}

/** @type {ReturnType<typeof setTimeout> | undefined} 同上：空句柄对 clearTimeout 等价（stages.js:716） */
let resizeTimer = undefined;
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
  loadRecent();
  // 开关支持 URL 参数（可分享/收藏某个视图）：?audit=1 开审计标记、?ocr=0 关候选样式
  const qs = new URLSearchParams(location.search);
  state.audit = qs.get("audit") === "1";
  // 默认**关**（2026-10-30 用户：成品页里成片的绿字没法看）。要看哪些行是 OCR 补的，
  // 勾工具栏「OCR 候选样式」或加 `?ocr=1` —— 能力保留，只是不再默认糊在脸上。
  state.ocrFill = qs.get("fill") === "1";
  state.ocrStyle = qs.get("ocr") === "1";
  state.tagsOn = qs.get("tags") !== "0";
  await loadDocs();
  initBar();
  /** @type {HTMLInputElement} */ ($("t-audit")).checked = state.audit;
  /** @type {HTMLInputElement} */ ($("t-ocr")).checked = state.ocrStyle;
  /** @type {HTMLInputElement} */ ($("t-fill")).checked = state.ocrFill;
  const asked = qs.get("doc") || DEFAULT_DOC;
  await loadBank();
  await loadDoc(asked);
  if (qs.get("pick") === "1") setPickMode(true);
  const hash = /^#pg-(\d+)$/.exec(location.hash);
  if (hash) document.getElementById(`pg-${hash[1]}`)?.scrollIntoView();
  // ?q= 打开即执行一次跳转/搜索（方便收藏"某个搜索"，也让交互可被自动化核对）
  const q = qs.get("q");
  if (q) {
    /** @type {HTMLInputElement} */ ($("jump")).value = q;
    runJump(q);
  }
}

main();
