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
 * 文档清单来自服务端 `/api/docs`（扫 `data/out/<docId>/` 里有快照的目录），
 * **不再硬编码** —— 硬编码的代价是「导入一份新卷要改前端代码」，那不叫每天能用。
 * 每项形如 `{ id, label, kind, examined, stats, health }`，`examined=false` 表示没跑过
 * `npm run daily` 的体检（此时如实显示「未体检」，不假装健康）。
 */
let DOCS = [];
let DEFAULT_DOC = "";

const $ = (id) => document.getElementById(id);

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
function groupParagraphs(blocks, ctx) {
  const out = [];
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

function flowPaper(p) {
  const wrap = el("div", "flow-page");
  const ctx = mergeContext(p);
  for (const item of groupParagraphs(p.blocks, ctx)) {
    const blk = item.blk;
    if (item.kind === "text") {
      const para = el("p", "flow-p");
      // prettifyLatex 返回 HTML 片段（分式/根号/上下标），与纸面同一个渲染函数
      para.innerHTML = prettifyLatex(item.text);
      wrap.append(para);
      continue;
    }

    if (blk.kind === "image" && blk.img) {
      const img = el("img", "flow-img");
      img.src = `/data/out/${enc(state.doc)}/images/${enc(blk.img)}`;
      img.alt = "图片块";
      img.loading = "lazy";
      wrap.append(img);
      continue;
    }
    if (blk.kind === "table" && blk.html) {
      // 上游 HTML 直接沿用（含 rowspan/colspan）；宽度交给 CSS，不重新推断列宽
      const box = el("div", "flow-table");
      box.innerHTML = blk.html;
      wrap.append(box);
    }
  }
  return wrap;
}

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

/**
 * 顶部体检摘要：把 `meta.json` 的结论翻译成一句人话。
 * - `examined=false` ⇒ 说「未体检」而不是「通过」（没测过 ≠ 没问题）；
 * - 有 issues ⇒ 显示第一条，悬停/点击看全部。
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
    box.title = d.health.issues.join("\n");
    box.append(el("span", "more", "详情"));
    box.onclick = () =>
      notice([["div", "本册体检："], ...d.health.issues.map((x) => ["div", `· ${x}`])], "warn");
    box.style.cursor = "pointer";
  } else {
    box.title = "体检通过：题号连续、无未解释的抑制";
    box.onclick = null;
    box.style.cursor = "";
  }
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
  savePosition(cur);
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

/**
 * 拉文档清单。失败时**不空着**：有 `?doc=` 就按它直接开（至少能读这一卷），
 * 没有就给出「先导入」的可操作提示。静默失败在这里等于「页面白屏且不说为什么」。
 */
async function loadDocs() {
  const asked = new URLSearchParams(location.search).get("doc");
  try {
    const j = await fetchJson("/api/docs");
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
let toastTimer = null;
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

/** 跳转后必须看得见"跳到了哪"：短暂高亮 2s */
function markHit(node) {
  if (!node) return;
  node.classList.add("hit");
  setTimeout(() => node.classList.remove("hit"), 2000);
}

function pageEl(index) {
  return document.getElementById(`pg-${index + 1}`);
}

function jumpToPage(index) {
  const sec = pageEl(index);
  if (!sec) return false;
  sec.scrollIntoView({ block: "start", behavior: "smooth" });
  // 跳转即视为"读到这里"，并锁住途中上报的中间页（见 posLockUntil 的说明）
  posLockUntil = Date.now() + 1500;
  savePosition(index + 1, true);
  return true;
}

/** 本册所有该题号的题（不同节会重号 ⇒ 天然是列表） */
function questionsByNumber(n) {
  const out = [];
  state.data.pages.forEach((p, i) => {
    for (const q of p.questions ?? []) if (String(q.number) === String(n)) out.push({ pageIndex: i, q });
  });
  return out;
}

function jumpToQuestion(hit) {
  jumpToPage(hit.pageIndex);
  const chip = document.querySelector(`.q-chip[data-qid="${CSS.escape(hit.q.id)}"]`);
  markHit(chip);
  return Boolean(chip);
}

/** 搜正文：返回 { pageIndex, blockIndex, snippet }，最多 60 条（再多也没人翻） */
function searchBlocks(text) {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (let i = 0; i < state.data.pages.length; i++) {
    const blocks = state.data.pages[i].blocks ?? [];
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

/** 结果面板（题号候选与正文命中共用；点一行就跳过去） */
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

/** 输入框的唯一入口：页码 → 题号 → 搜索 */
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

const posKey = (doc) => `final:pos:${doc}`;
let posTimer = null;
/**
 * 跳转后的短暂锁：平滑滚动途中 `updatePageIndicator` 会一路报**中间页**
 * （实测跳 p7 被记成 p5）。锁住这段时间，只认"跳到的目标页"；锁一过，
 * 用户自己滚到哪就记哪。
 */
let posLockUntil = 0;

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
  if (!p || p < 1 || p > state.data.pages.length) return;
  const sec = pageEl(p - 1);
  if (!sec) return;
  sec.scrollIntoView({ block: "start" });
  posLockUntil = Date.now() + 1500;
  savePosition(p, true);
  flash(`已回到上次位置：第 ${p} 页`);
}

/* ── 交互 ── */

function initBar() {
  const pick = $("doc-pick");
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

  const jump = $("jump");
  jump.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    runJump(jump.value);
  });
  // 输入框失焦时收起结果面板（点面板里的行之前会先失焦 ⇒ 延迟收，否则点不中）
  jump.addEventListener("blur", () => setTimeout(() => ($("hits").hidden = true), 180));

  $("t-audit").addEventListener("change", (e) => {
    state.audit = e.target.checked;
    renderBook();
  });
  $("t-fill").checked = state.ocrFill;
  $("t-fill").addEventListener("change", (e) => {
    state.ocrFill = e.target.checked;
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
  // 默认**关**（2026-10-30 用户：成品页里成片的绿字没法看）。要看哪些行是 OCR 补的，
  // 勾工具栏「OCR 候选样式」或加 `?ocr=1` —— 能力保留，只是不再默认糊在脸上。
  state.ocrFill = qs.get("fill") === "1";
  state.ocrStyle = qs.get("ocr") === "1";
  state.tagsOn = qs.get("tags") !== "0";
  await loadDocs();
  initBar();
  $("t-audit").checked = state.audit;
  $("t-ocr").checked = state.ocrStyle;
  $("t-fill").checked = state.ocrFill;
  const asked = qs.get("doc") || DEFAULT_DOC;
  await loadBank();
  await loadDoc(asked);
  const hash = /^#pg-(\d+)$/.exec(location.hash);
  if (hash) document.getElementById(`pg-${hash[1]}`)?.scrollIntoView();
  // ?q= 打开即执行一次跳转/搜索（方便收藏"某个搜索"，也让交互可被自动化核对）
  const q = qs.get("q");
  if (q) {
    $("jump").value = q;
    runJump(q);
  }
}

main();
