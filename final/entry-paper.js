/**
 * entry-paper.js —— 把「一道题 / 一条答案」按**书上的位置**裁出来（展示层自有模块）
 *
 * 为什么要有它：用户 2026-10-15 明确要求「题目答案图片就应该按照书上的排版方式来排版，
 * 不是放在最后面」。之前面板把图片排在文本末尾，是因为只拿到引擎拼好的一维文本
 * （`stem` / `answerText`），里面没有图片的位置。
 * 而快照里**每个块都有 bbox 与类型**（文字块 / 图片块），位置信息一直都在 ——
 * 所以正确做法不是猜插图位置，而是**照坐标把这一条目从页上裁下来**。
 *
 * ⚠️ 关键口径：**逐块调用 `reconstruct.js` 的 `blockNode`，并传入整页**
 * （不是只传本条目的块）。字号模型要用「同页邻块池」判挤压（Task 14 结构判据），
 * 并集合并要用整页的 `mergeContext`（Task 15）。传子集会让同一条目在纸面里 13px、
 * 在面板里 14px —— 那就是"两处各写一遍碰巧长得像"，红线不允许。
 * 这里复用的正是纸面那一份块渲染，外面只多包一层裁剪。
 *
 * ⚠️ 第二条口径（2026-10-15 手机截图暴露）：**一条目不是一个矩形**。
 * 双栏页里答案常「左栏底部起 → 右栏顶部续」（实测 答案册 p3:q30：块 y 从 723..764 跳到 24..144）。
 * 取整体并集会把**整页**框进来 ⇒ 中间一大块不属于它的空白 + 最后一行被切。
 * 所以先按阅读顺序**切成若干同栏连续段**，一段一裁，自上而下叠放（这才是书上的读法）。
 */
import { el, blockNode, mergeContext, paperCanvas, ocrFillNode, ocrRect, posStyle, rectHits, unfilledContentHoles } from "../stages/reconstruct.js";
import { baseFontOfPage } from "../stages/font-metrics.js";

/** 块的 bbox 并集 `[x0,y0,x1,y1]`；空集合返回 null。 */
export function unionBbox(blocks) {
  if (!blocks.length) return null;
  return [
    Math.min(...blocks.map((b) => b.bbox[0])),
    Math.min(...blocks.map((b) => b.bbox[1])),
    Math.max(...blocks.map((b) => b.bbox[2])),
    Math.max(...blocks.map((b) => b.bbox[3])),
  ];
}

/**
 * @typedef {Object} SnapBlock 快照里的一个块（引擎或 OCR 补入）
 * @property {number} i
 * @property {number[]} bbox
 * @property {string} [text]
 * @property {string} [kind]
 * @property {string} [img]
 * @property {boolean} [ocr]
 *
 * @typedef {Object} OcrItem 一条 OCR 候选补入
 * @property {string} text
 * @property {number[]} [bbox]
 * @property {number[]} [win]
 * @property {boolean} [accepted]
 * @property {string} [source]
 * @property {string} [raw]
 * @property {string} [crop]
 * @property {number} [ratio]
 *
 * @typedef {Object} EntryItem 参与裁切排布的一个内容单元
 * @property {number[]} bbox
 * @property {SnapBlock} [blk]
 * @property {OcrItem} [ocr]
 *
 * @typedef {Object} MergeCtx
 * @property {Set<number>} drop
 */

/** 组内空洞阈值（pt）：行距约 16pt，超过 3.5 行的空白说明中间不属于本条目 */
const HOLE_PT = 60;

/**
 * 块属于哪一栏：**用页面中线**，与 `reconstruct.js` 判号牌挂哪一侧的 `isRightCol` 同一口径
 * （一个仓库里不要有两个"这是左栏还是右栏"的答案）。
 *
 * ⚠️ 不用 `page.centers`：实测答案册第 17 页的栏中心是 `[31, 286]`（页宽 595，
 * 真双栏应约 150/440）——那是聚类退化出来的值，拿它判栏会把同一栏的行交替判成两栏，
 * 一条答案被切成 7 段。
 *
 * @param {any} block
 * @param {any} page
 * @returns {number | null} 0 = 左半页，1 = 右半页；单栏页返回 null
 */
export function columnOf(block, page) {
  if (!page || (page.columns ?? 1) < 2) return null;
  const cx = (block.bbox[0] + block.bbox[2]) / 2;
  return cx >= page.width / 2 ? 1 : 0;
}

/**
 * 把条目的块切成若干段：**先按栏分组（左组→右组），组内再按"空洞"断开**。
 *
 * 为什么两级：
 *  · 只按栏分组不够 —— 实测 答案册 p3:q30 的左栏组里，一张图在 y24..144、正文在 y723..764，
 *    并集会把整栏 700pt 都框进来（中间全是别人的内容），裁出来 495×1522 一大条空白；
 *  · 只按阅读顺序里的"顶边回跳"切也不够 —— 一张高图与文字并排时会被误判成换栏
 *    （实测 p16:q123 切成 7 段、p3:q34 切成 4 段）。
 *  所以：组内按 y 顶边排序后，**只有当前块顶边与已覆盖底边的空洞 > HOLE_PT 才断段**；
 *  并排的高图产生的是负空洞（下一块顶边还在图的上方区间内），不会被误切。
 *
 * 段内**留白是事实**（那部分墨迹不属于本条目），纸面那份同样有这块白 —— 不该由裁切来掩盖。
 *
 * @param {Array<{bbox:number[]}>} blocks 已按阅读顺序排列
 * @param {any} page 所在页（要 columns 与 width）
 * @returns {Array<Array<{bbox:number[]}>>}
 */
export function splitSegments(blocks, page) {
  const groups = new Map();
  for (const b of blocks) {
    const c = columnOf(b, page) ?? 0;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(b);
  }
  const out = [];
  for (const [, arr] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    let cur = [];
    let bottom = -Infinity;
    for (const b of arr.slice().sort((x, y) => x.bbox[1] - y.bbox[1])) {
      if (cur.length && b.bbox[1] - bottom > HOLE_PT) {
        out.push(cur);
        cur = [];
        bottom = -Infinity;
      }
      cur.push(b);
      bottom = Math.max(bottom, b.bbox[3]);
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

/**
 * 一条目的**可渲染内容集合**（纯函数，无 DOM ⇒ 可单测）。
 *
 * 为什么不能只画 `question.blocks`：纸面画的是「整页所有块 + 所有 OCR 候选行」，
 * 而条目只认领其中一部分块。上游漏识别的行只存在于 `page.ocrFill`，不属于任何题目 ⇒
 * 只按块列表裁就会丢它们（实测 题册 p5 第1题：A/B 选项正文各缺一半，2026-10-15 用户截图报出）。
 * 所以：**落在本条目区域内的候选行一并纳入**；区域内**属于别题**的块不抢，但要计数，
 * 让面板能说清"这里为什么空"。
 *
 * @param {any} page 整页快照
 * @param {SnapBlock[]} own 本条目的块（已剔除被并集合并掉的）
 * @param {MergeCtx | null} [mergeCtx] 整页并集合并上下文（跳过被合并掉的游离块）
 * @returns {{items: EntryItem[], foreignBlocks: number, boxes: number[][], holes: Array<{bbox:number[],area:number}>}}
 *          `boxes` = 本条目的**区域矩形集合**（按栏分段，见下）；`holes` = 归属本题但没读出来的洞。
 */
export function collectEntryItems(page, own, mergeCtx = null) {
  const mine = new Set(own.map((b) => b.i));
  const assigned = new Set();
  const claimedElsewhere = new Set();
  for (const other of page.questions ?? []) {
    for (const i of other.blocks) assigned.add(i);
    if (other.blocks.some((i) => mine.has(i))) continue; // 本条目自己的题，不算"别题"
    for (const i of other.blocks) claimedElsewhere.add(i);
  }
  const dropped = mergeCtx?.drop ?? new Set();

  /**
   * ⚠️ 区域是**按栏分开的矩形集合**，不是 own 的外接单矩形。
   *
   * 为什么：一条目常常跨栏续排（实测 题册 p5 第3题：题干在左栏底 y594..777，
   * 四个选项在右栏顶 y72..142 —— 书上就这么排的）。取外接单矩形就得同时盖住这两块 ⇒
   * 撑成 `x[40,443] × y[72,777]`，**约等于整页**。于是隔壁题的 OCR 候选行全被吸进来：
   * 点开第3题，面板第一段整段是第1题热狗题的 A/B 选项，还排在最前面；
   * 第1题的引擎块因"别题不抢"只计数不画 ⇒ 中间一片空洞（并报"另有 57 个块归给了别的题"）。
   * 全卷 26 处"一块 OCR 墨迹被两题同时认领"里 25 处都是这个巨型矩形造成的
   * （清单：`npm run audit:attribution`）。
   *
   * ⚠️ 只按**栏**分，不按 `splitSegments` 的"空洞"再切一刀 —— 试过，会把内容踢出去：
   * 候选行补的**就是**题干里那个洞（上游整行漏识别才会留洞），按空洞切区域 ⇒
   * 补洞的行反过来变成"无主"，实测 3 条（题册 p14 的 C/D 选项行）。
   * 判"在不在本条目内"要的是**栏**这个粒度；裁成几段才是空洞的事，两者不必同一个口径。
   */
  const colBoxesOf = (blocks) => {
    const m = new Map();
    for (const b of blocks) {
      const c = columnOf(b, page) ?? 0;
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(b);
    }
    return [...m.entries()].map(([c, bs]) => ({ c, box: unionBbox(bs) })).filter((x) => !!x.box);
  };
  const myBoxes = colBoxesOf(own);
  const boxes = myBoxes.map((x) => x.box);

  /**
   * 一块内容归谁：**全局唯一胜出**，不是"谁包含它就算谁的"。
   *
   * 为什么不能判包含：同一栏里两个条目的矩形会上下重叠（答案册实测 9 处 ——
   * 「5. C 必刷方法·正交分解法」同时落在 #4 与 #5 的栏矩形里），判包含就两主，
   * 同一行字在两道题的面板里各画一遍。
   * 胜出规则（与调用方是谁无关，所以各条目算出的答案一致）：
   *   ① 同栏内**垂直重叠最多**者胜；
   *   ② 都不重叠时，退到「整块在它上方、且空洞 ≤ HOLE_PT 的最近一个」——
   *      候选行补的常常正是题干**末尾**被上游整行漏掉的几行，那些行天然超出本题块范围
   *      （实测 题册 p14 第5题：右栏自己的块到 y216，C/D 选项行在 y226/245/264）；
   *   ③ 洞比 HOLE_PT 还大就不猜（宁可留"无主"可见，红线 G1）；
   *   ④ 平手按条目在页上的序号，保证确定性。
   */
  const otherBoxes = [];
  for (const other of page.questions ?? []) {
    if (other.blocks.some((i) => mine.has(i))) continue; // 本条目自己的题（跨页段的另一条）不算别人
    for (const cb of colBoxesOf(other.blocks.map((i) => page.blocks[i]).filter(Boolean))) otherBoxes.push(cb);
  }
  const allBoxes = [
    ...myBoxes.map((x) => ({ ...x, mine: true })),
    ...otherBoxes.map((x) => ({ ...x, mine: false })),
  ].map((x, ord) => ({ ...x, ord }));
  const overlapY = (a, b) => Math.max(0, Math.min(a[3] ?? 0, b[3] ?? 0) - Math.max(a[1] ?? 0, b[1] ?? 0));
  const claimable = (bbox) => {
    const c = columnOf({ bbox }, page) ?? 0;
    let best = null;
    let bestScore = -Infinity;
    for (const cb of allBoxes) {
      if (cb.c !== c) continue;
      const ov = overlapY(cb.box, bbox);
      // 不相交时只有「整块在上方」才参与"最近上方"的兜底；在下方的一律不参与
      // （否则 `bbox[1] - box[3]` 是负数、取负变正，会把下面的条目算成最高分 —— 实测抢走
      //  第4题的选项行「动时，A 的轴所受压力变大」，因为第5题在它下面）
      const above = (cb.box[3] ?? 0) <= (bbox[1] ?? 0);
      const score = ov > 0 ? ov : above ? -((bbox[1] ?? 0) - (cb.box[3] ?? 0)) - 1 : -Infinity;
      if (score > bestScore || (score === bestScore && best !== null && cb.ord < best.ord)) {
        bestScore = score;
        best = cb;
      }
    }
    if (!best) return false;
    if (bestScore <= 0 && bbox[1] - (best.box[3] ?? 0) > HOLE_PT) return false;
    return best.mine;
  };

  /** 区域内（含正下方补洞）、不属于任何题目的引擎块：纸面画得出来，裁切也不能丢 */
  const strays = page.blocks.filter(
    (b) => !assigned.has(b.i) && !dropped.has(b.i) && claimable(b.bbox),
  );
  const cands = (page.ocrFill ?? [])
    .filter((x) => x.accepted && claimable(ocrRect(x)))
    .map((it) => ({ bbox: ocrRect(it), ocr: it }));

  /** 别题的块压在我的区域里 ⇒ 只计数不画（留白必须说清原因）。按块号去重。 */
  const foreign = new Set();
  for (const b of page.blocks) {
    if (!mine.has(b.i) && claimedElsewhere.has(b.i) && boxes.some((r) => rectHits(b.bbox, r))) foreign.add(b.i);
  }

  /**
   * 原卷有墨迹、两套 OCR 都没读出来的洞。⚠️ **必须走 `claimable` 同一个判据**：
   * 洞常常就在本题那张图的**下方**（图注就是这种位置），比本题块的底边还低几 pt，
   * 用"与区域矩形相交"判会把它挡掉（实测 答案册 p4 甲/乙/丙 三个洞距图底边 2pt ⇒ 一个都不显示）。
   * 一个页面里"属不属于本题"只能有一个答案，否则又回到两处各写一遍。
   */
  const holes = unfilledContentHoles(page).filter((r) => claimable(r.bbox));

  return {
    items: [...own.map((b) => ({ bbox: b.bbox, blk: b })), ...strays.map((b) => ({ bbox: b.bbox, blk: b })), ...cands],
    foreignBlocks: foreign.size,
    boxes,
    holes,
  };
}

/**
 * 一个条目 id 在快照里的**全部页段**（按页序）。
 *
 * 为什么必须找齐：跨页条目（答案从一栏底续到下一页）在快照里是**同一个 id 在它涉及的
 * 每一页各出一条**，每条的 `blocks` 只含该页那一段（见 export-stages 的 perPageBlocks）。
 * 只取第一条就把续段整段丢掉 —— 实测热狗题的答案裁出 3 行、书上有 14 行（2026-10-15 用户报出）。
 *
 * @param {Array<{questions: Array<{id: string, blocks: number[]}>}>} pages
 * @param qid
 * @returns {Array<{page: any, blocks: number[]}>}
 */
export function entrySegments(pages, qid) {
  const out = [];
  for (const p of pages ?? []) for (const q of p.questions) if (q.id === qid) out.push({ page: p, blocks: q.blocks });
  return out;
}

/**
 * 裁出一条目（题目 / 答案）的纸面样子：一段一裁，按阅读顺序叠放。
 *
 * ⚠️ 内容集合见 `collectEntryItems`（必须与纸面同区域所见一致，含 OCR 候选行）。
 * 候选行沿用纸面的候选样式（青绿虚线 + 角标 + title 证据，红线 G1：候选不得与引擎原文混淆）。
 *
 * ⚠️ 入参是**段列表**而不是单页：一条目可能跨页，见 `entrySegments`。
 *
 * @param {Array<{page: any, blocks: number[]}>} segments 该条目的各页段（须按页序）
 * @param doc       卷 id（图片由 `blockNode` 拼 `/data/out/<doc>/images/...`）
 * @param widthPx   单段裁出来可占的显示宽度上限（面板可用宽）
 * @param opts      `{ candidateStyle, maxFontPx }`
 *                  `maxFontPx`（默认 19）是**字号上限**：条目往往只占原书一栏（约 240pt），
 *                  直接铺满面板宽会放大到 3× 以上，一行只剩 20 个字，读起来像海报。
 * @returns {HTMLElement | null} 容器（内含若干 `.entry-crop`）；无可渲染块时 null。
 *          容器上带 `foreignBlocks`：区域内属于**别题**的块数（供面板如实标注留白原因）；
 *          带 `holes`：区域内**原卷有墨迹但没读出来**的处数（供面板明说内容缺失）。
 */
export function entryCrop(segments, doc, widthPx, opts = {}) {
  const box = el("div", "entry-figs");
  box.foreignBlocks = 0;
  box.holes = 0;
  for (const seg of segments ?? []) {
    if (!seg?.page) continue;
    const n = cropPageInto(box, seg.page, seg.blocks, doc, widthPx, opts);
    box.foreignBlocks += n.foreign;
    box.holes += n.holes;
  }
  return box.children.length ? box : null;
}

/** 把一页上的条目段裁进共享容器，返回该页的「别题块数」与「未读出的洞数」。 */
function cropPageInto(box, page, blockIdxs, doc, widthPx, opts) {
  const { candidateStyle = true, maxFontPx = 19 } = opts;
  const blocks = (blockIdxs ?? []).map((i) => page.blocks[i]).filter(Boolean);
  if (!blocks.length) return { foreign: 0, holes: 0 };

  const mergeCtx = mergeContext(page); // 整页合并上下文 = 与纸面同一份判定
  const own = blocks.filter((b) => !mergeCtx.drop.has(b.i)); // 被并集合并掉的块纸面也不画
  if (!own.length) return { foreign: 0, holes: 0 };
  const { items, foreignBlocks, holes } = collectEntryItems(page, own, mergeCtx);
  const segs = splitSegments(items, page);

  /**
   * 洞该画在哪一段：**同栏里底边离它最近的那一段**。
   * ⚠️ 不能用"与段矩形相交"判 —— 图注天然印在图的**下方**，比本题块的底边还低几 pt
   * （实测 答案册 p4 甲/乙/丙 三个洞距图底边 2pt ⇒ 相交判据一个都收不到，标记全丢）。
   */
  const hostOf = holes.map((h) => {
    const col = columnOf({ bbox: h.bbox }, page) ?? 0;
    let best = -1;
    let bestD = Infinity;
    segs.forEach((st, i) => {
      const bb = unionBbox(st);
      if (!bb || (columnOf({ bbox: bb }, page) ?? 0) !== col) return;
      const d = Math.abs(bb[3] - h.bbox[1]);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  });
  const holesIn = (i) => holes.filter((_, hi) => hostOf[hi] === i);

  const fontAt1x = baseFontOfPage(page.blocks, page.width, page.width); // 1 pt/px 时的基准字号
  const kFont = fontAt1x > 0 ? maxFontPx / fontAt1x : Infinity;
  const baseFontCache = new Map();

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const mine = holesIn(si);
    // 段矩形必须把归属它的洞**框进来**，否则洞画在裁切框外面照样看不见
    const bbox = unionBbox([...seg, ...mine.map((h) => ({ bbox: h.bbox }))]);
    const entryW = bbox[2] - bbox[0];
    const k = Math.min(widthPx / entryW, kFont); // 铺满面板宽 与 字号封顶，取小的
    const fullW = page.width * k; // 整页按同一比例放大，块坐标换算才与纸面一致

    const canvas = paperCanvas(page);
    canvas.style.width = `${fullW}px`;
    let baseFont = baseFontCache.get(fullW);
    if (baseFont === undefined) {
      baseFont = baseFontOfPage(page.blocks, page.width, fullW);
      baseFontCache.set(fullW, baseFont);
    }
    // 先引擎块、后候选块：与 renderPaper 的绘制顺序一致（候选压在正文之上才看得见角标）
    for (const x of seg) {
      if (!x.blk) continue;
      const node = blockNode(x.blk, page, fullW, baseFont, mergeCtx, doc);
      if (!node) continue;
      if (x.blk.ocr && candidateStyle) node.classList.add("blk-ocr"); // 与 appendBlockNodes 同口径
      canvas.append(node);
    }
    for (const x of seg) {
      if (x.ocr) canvas.append(ocrFillNode(x.ocr, page, fullW, baseFont, candidateStyle));
    }
    for (const h of mine) {
      const mark = posStyle(el("div", "uncovered-mark hole"), h.bbox, page.width, page.height);
      mark.title = `原卷此处有墨迹（${h.area}px），MinerU 与 OCR 都没读出来 —— 内容缺失，不是排版留白`;
      canvas.append(mark);
    }
    const crop = el("div", "entry-crop");
    // ceil + 2：`.entry-crop` 是 border-box 且带 1px 边框，框高里含上下共 2px 边框，
    // 留给内容的实际比 style 值少 2px ⇒ 不补就会把洞标记（只有 8–12px 高）的底边吃掉
    // （实测最大溢出 1.44px，答案册 44 个标记 9 个越界）。
    crop.style.width = `${Math.ceil(entryW * k) + 2}px`;
    crop.style.height = `${Math.ceil((bbox[3] - bbox[1]) * k) + 2}px`;
    canvas.style.transform = `translate(${Math.round(-bbox[0] * k)}px, ${Math.round(-bbox[1] * k)}px)`;
    crop.append(canvas);
    box.append(crop);
  }
  return { foreign: foreignBlocks, holes: holes.length };
}

/**
 * 挂载后按**实测外框**补尺寸。必须在元素已经进文档之后调用（要量真实布局）。
 *
 * ⚠️ 量的是**墨迹**（Range），不是元素盒。块是 `white-space:nowrap` 排的：
 * 字号模型按 bbox 宽定字号，但排版出来的字可以比 bbox 宽（实测 题册 p2 第11题
 * C/D 两行渲染宽 / bbox 宽 = 1.06），多出来的字**冲出 `.txt` 的元素盒**却不撑大它。
 * 所以拿 `getBoundingClientRect()` 量永远量不到越界 —— 上一版就是这么报了"0 处裁切"，
 * 实际两册 44 道题的**行尾最后一个字**被 `overflow:hidden` 整字切掉（2026-10-15 逐字实测）。
 *
 * @param {HTMLElement | null} root entryCrop 返回的容器
 */
export function fitEntryCrops(root) {
  if (!root || !root.isConnected) return;
  for (const crop of root.querySelectorAll(".entry-crop")) {
    const cRect = crop.getBoundingClientRect();
    const canvas = crop.querySelector(".canvas");
    // 上限 = 画布还剩多少可看（裁切框再宽也只是空白，不该把页面外头圈进来）
    const maxRight = canvas ? canvas.getBoundingClientRect().right - cRect.left : Infinity;
    const maxBottom = canvas ? canvas.getBoundingClientRect().bottom - cRect.top : Infinity;
    let bottom = 0;
    let right = 0;
    for (const n of crop.querySelectorAll(".blk, .blk .txt, .blk img")) {
      const img = n.tagName === "IMG" ? n : n.querySelector(":scope > img");
      // 图片是替换元素，盒子=墨迹；文字必须走 Range
      const r = img ? img.getBoundingClientRect() : inkRect(n);
      bottom = Math.max(bottom, Math.min(r.bottom - cRect.top, maxBottom));
      right = Math.max(right, Math.min(r.right - cRect.left, maxRight));
    }
    if (bottom > cRect.height) crop.style.height = `${Math.ceil(bottom)}px`;
    if (right > cRect.width) crop.style.width = `${Math.ceil(right)}px`;
  }
}

/**
 * 一个节点里**全部文字**的墨迹外接矩形（含冲出元素盒的部分）。
 * 用 Range 而不是 `getBoundingClientRect()`：后者只给元素盒，`nowrap` 溢出时它不长大。
 * 空文本节点（纯容器 div）退化为元素盒。
 * @param {Element} n
 * @returns {{bottom:number, right:number}}
 */
function inkRect(n) {
  const rg = document.createRange();
  rg.selectNodeContents(n);
  const r = rg.getBoundingClientRect();
  const box = n.getBoundingClientRect();
  // Range 在无内容时返回零矩形 —— 这时用元素盒兜底（图片块、空占位）
  return { bottom: Math.max(r.bottom, box.bottom), right: Math.max(r.right, box.right) };
}
