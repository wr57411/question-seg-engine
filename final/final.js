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
import { prettifyLatex } from "../stages/latex-display.js";
import { tagSection } from "./tag-panel.js";
import { anchorOf, loadBindings, loadLibrary, reconcile, saveBindings, saveLibrary, tagIdsFor } from "./tag-store.js";

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
 * @typedef {{ sec: HTMLElement, head: HTMLElement, p: SnapPage }} PageSlot 每页的三段（重绘单页要用）
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
 *   sheet: SheetRef | null
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
  pages: [], // 每页的 {sec, head, p}，供打标后**只重绘那一页**（整册重绘在平板上会闪）
  sheet: null, // 当前面板打开的 {q, p}
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
  slot.sec.replaceChildren(slot.head, paper(slot.p));
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
 * @returns {HTMLElement} `renderPaper(...).wrap` —— d.ts 把它写成 any（遮蔽债，HANDOFF §6-29），
 *          实现侧 reconstruct.js:625 声明的是 HTMLElement，这里按实现收窄。
 */
function paper(p) {
  if (isPhoneViewport()) return flowPaper(p);
  return renderPaper(p, {
    doc: state.doc,
    paneW: state.paneW,
    diagnostics: state.audit,
    candidateStyle: state.ocrStyle,
    ocrFill: state.ocrFill,
    onChipClick: openSheet,
    resolveTags: state.tagsOn ? tagsForQuestion : null,
  }).wrap;
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

/** 当前卷是题册还是答案册（措辞与"哪一面是自己"都靠它）
 * @param {string} doc
 * @returns {string} "quiz" | "answer"（取自 meta.json，类型只按字符串对待）
 */
function docKind(doc) {
  return DOCS.find((x) => x.id === doc)?.kind ?? "quiz";
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
    await loadQuestions(doc);
    state.snap = state.data;
    await loadTags();
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
