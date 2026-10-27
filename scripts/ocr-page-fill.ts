// scripts/ocr-page-fill.ts
/**
 * 整页 OCR 补全（显式步骤，**不进 `npm run check`**）。
 *
 * ## 为什么有这条路径（实测，见技能 `region-ocr-fill` §8）
 *
 * 区域裁图**丢了上下文** —— 而那行文字本来就缺失，裁图边界只能猜：
 * 猜窄了读到碎片、猜宽了吞进邻行碎片、连着插图裁会吐图片占位符、再小一点就**幻觉**。
 * 整页 OCR 没有这个问题：题干与选项天然连在一起，模型自己切分排序。
 * 实测（题册 p5）：150dpi 整页**一次读全** A/B/C/D 与两个分式，含引擎漏掉的整行。
 *
 * ## 与 `scripts/ocr-fill.ts`（区域裁图）的分工
 *
 * 两者产出**同一形状**的候选，靠 `source` 区分（`"page"` / `"crop"`）。
 * 合并规则（`scripts/export-stages.ts`）：**裁图已 accepted 的保留，整页只补裁图没补上的洞**。
 * 这不是偷懒，是必需的：整页 OCR 会把**折行的选项并成一行**（热狗题实测），
 * 而洞是按**视觉行**切开的 —— 按比例切分会把下一行的开头派给上一行。
 * 裁图来源的洞是按行裁的，位置天然对得上，所以优先信它。
 *
 * ## 算法：把「无位置信息的整页文本」映射回「有位置的洞」
 *
 * ① **用解析块当锚点**：块文本做硬归一化（去空白与 LaTeX 记号 `$ \ { }`）后，
 *    在整页文本里**前向**搜索，得到一条单调匹配链；链上未匹配的片段 = 「引擎没覆盖到的文本」。
 * ② 片段归属到「几何阅读顺序上紧随其前锚点」的那些洞。
 * ③ 片段按 **OCR 换行切段**；段与洞按**宽度**贪心配对；段内按洞宽比例**精确**分配字符数
 *    （floor + 余数给小数部分最大者 ⇒ 各洞字符数之和恰等于段长）。
 * ④ 判据：宽度比 ∈ [RATIO_MIN, RATIO_MAX]，且**洞的期望字符数 ≥ MIN_EXPECT_CHARS**。
 *    单字符候选无法核对（宽度比是相对量，对假字不敏感）⇒ 宁可不补。
 *
 * 用法：`node --import tsx scripts/ocr-page-fill.ts [docId] [--pages 1,5,14] [--force]`
 * 凭据：env `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`，或从 `~/.workbuddy-ai/mcp.json` 读。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emWidthOf } from "../stages/font-metrics.js";
import { cleanOcrLines, medianLineHeightPt, OcrMcp, readToken } from "./ocr-lib.js";

const DOC = process.argv[2] ?? "23必刷题 2相互作用";
const pagesArgIdx = process.argv.indexOf("--pages");
const PAGES: Set<number> | null =
  pagesArgIdx >= 0 ? new Set(process.argv[pagesArgIdx + 1]!.split(",").map((x) => Number(x.trim()))) : null;
const FORCE = process.argv.includes("--force");
/**
 * `--all-pages`：**即使该页没有「洞」也跑整页 OCR**，把 fullText 存下来。
 *
 * 为什么需要（2026-10-27 光学卷实测）：题号被上游漏识别时，那点墨迹往往被
 * `classifyUncovered` 判成**家具级**（面积 45–48px、落在内容矩形之外）⇒ 不进 holes
 * ⇒ 这一页永远不跑 OCR ⇒ 题号永远补不回来（8 页只切出 15 题）。
 * 但整页 OCR 的全文里明明读得到 `4.` `5.`。所以"要不要跑"不能只由 holes 决定。
 */
const ALL_PAGES = process.argv.includes("--all-pages");

const OUT_DIR = join("data", "out", DOC);
const PDF = join(OUT_DIR, "origin.pdf");
const PAGE_DIR = join(OUT_DIR, "ocr-page");
const PAGE_JSON = join(OUT_DIR, "ocr-page-fill.json");

/**
 * 整页送进去的**目标像素宽**。
 * 实测（题册 p5）：150dpi（1243px）表现很好；不盲目追高 ——
 * 像素预算超了服务端会内部降采样，而**降采样正是小字漏读的原因**。
 */
const TARGET_PX_W = 1300;
const MIN_DPI = 72;
const MAX_DPI = 200;

/** 渲染用外扩（pt）：给候选块一点边距，与裁图路径保持同一套视觉口径。 */
const PAD_X = 8;
const PAD_Y = 3;
const RATIO_MIN = 0.45;
const RATIO_MAX = 1.9;
/**
 * 洞的**期望字符数**下限（`洞宽 / 页字号`）。低于此值**不补**。
 * 单字符候选无法核对 ⇒ 宁可在界面上留一个可见的「解析遗漏」，也不收一个看起来合格的假字。
 * （插图子图标签 `A`/`B`/`C`/`D` 是 5–7pt，就落在这里。）
 */
const MIN_EXPECT_CHARS = 1.6;

type Box = [number, number, number, number];

interface OcrFillItem {
  bbox: Box;
  win: Box;
  text: string;
  raw: string;
  crop: string;
  ratio: number;
  accepted: boolean;
  source: "page";
  reason?: string;
}

/* ── 文本归一化 ─────────────────────────────────────────────────────── */

/**
 * 硬归一化：压成「只留实义字符」的序列，并记录每个字符在**原串**中的下标。
 *
 * 去掉：所有空白、`$`、`\`、`{`、`}` —— 这些是 LaTeX 记号，两侧写法常不一致
 * （`\frac { 5 } { 8 }` vs `\frac{5}{8}`）。保留 `map` 是为了能把
 * 「硬序列上的区间」还原成**原串切片**（输出仍带 LaTeX 原样，不丢公式）。
 */
function hardNorm(s: string): { chars: string[]; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) continue;
    if (ch === "$" || ch === "\\" || ch === "{" || ch === "}") continue;
    chars.push(ch);
    map.push(i);
  }
  return { chars, map };
}

/** 朴素子串搜索（页文本 ~5k 字符、锚点 ~50 个，够用）。 */
function findSub(hay: string[], needle: string[], from: number): number {
  const n = needle.length;
  const m = hay.length;
  if (n === 0 || n > m) return -1;
  outer: for (let i = Math.max(0, from); i + n <= m; i++) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

const snap = JSON.parse(readFileSync(join(OUT_DIR, "stages.json"), "utf8"));

/* ── 交叉核对素材：裁图路径（`ocr-fill.json`）对同一洞给过什么文本 ─────────────
 *
 * 两条路径是**独立**的（一条按行裁图、一条整页对齐），所以它们对同一个洞给出的文本
 * 若明显不一致，说明至少有一条错了 ⇒ **宁可不补**。
 *
 * 实测（答案文档 p15，用户当场指出）：裁图读到 `第4节`（比值 1.91，差 0.01 被拒），
 * 整页却给了 `分力,` —— 两个答案完全不同，而我当时只看了比值就收下了。
 */
function dice(a: string, b: string): number {
  const grams = (t: string) => {
    const g = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
const cropByBbox = new Map<string, string>();
{
  const f = join(OUT_DIR, "ocr-fill.json");
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { pages?: { items?: { bbox: number[]; text?: string }[] }[] };
      for (const pg of j.pages ?? []) {
        for (const it of pg.items ?? []) {
          if (it.text) cropByBbox.set(it.bbox.map((v) => Math.round(v)).join(","), it.text);
        }
      }
    } catch {
      /* 没有裁图结果就不做交叉核对 */
    }
  }
}
if (!existsSync(PDF)) {
  console.error(`缺少 ${PDF}（先 npm run stages:export）`);
  process.exit(2);
}
mkdirSync(PAGE_DIR, { recursive: true });

// 局部重跑（--pages）时**保留**未跑页的旧结果，避免合并阶段把其它页清空。
const prev: { page: number; fullText: string; items: OcrFillItem[] }[] = [];
if (PAGES && existsSync(PAGE_JSON)) {
  try {
    prev.push(...(JSON.parse(readFileSync(PAGE_JSON, "utf8")).pages ?? []));
  } catch {
    /* 旧文件坏了就重来 */
  }
}
const keep = prev.filter((x) => !PAGES?.has(x.page + 1));

const mcp = new OcrMcp(readToken());
await mcp.init();

const outPages: { page: number; fullText: string; items: OcrFillItem[] }[] = [...keep];
let totalHoles = 0;
let totalAccepted = 0;

for (const p of snap.pages) {
  const pno = p.index + 1;
  if (PAGES && !PAGES.has(pno)) continue;
  // 形状前置条件（与 export-stages.ts 同源）：洞必须是**横向文字行碎片**（宽/高 ≥ 1.5）。
  const holes = (p.uncovered ?? []).filter((r: any) => {
    if (r.kind !== "content") return false;
    const w = r.bbox[2] - r.bbox[0];
    const h = r.bbox[3] - r.bbox[1];
    return h > 0 && w / h >= 1.5;
  });
  if (!holes.length && !ALL_PAGES) continue;
  totalHoles += holes.length;

  /* ① 整页渲染 → OCR（带缓存；空结果换一档 DPI 重试，绕开服务端缓存） */
  const stem = `p${String(pno).padStart(2, "0")}`;
  const txtPath = join(PAGE_DIR, `${stem}.txt`);
  const pngPath = join(PAGE_DIR, `${stem}.png`);
  let raw = "";
  if (!FORCE && existsSync(txtPath)) {
    raw = readFileSync(txtPath, "utf8");
    console.log(`p${pno} 命中缓存（${raw.length} 字）`);
  } else {
    const baseDpi = Math.max(MIN_DPI, Math.min(MAX_DPI, Math.round((72 * TARGET_PX_W) / p.width)));
    for (let attempt = 1; attempt <= 2 && !raw.trim(); attempt++) {
      const dpi = attempt === 1 ? baseDpi : Math.min(MAX_DPI, baseDpi + 20);
      const prefix = join(PAGE_DIR, `${stem}-r${attempt}`);
      try {
        execFileSync(
          "pdftoppm",
          ["-r", String(dpi), "-f", String(pno), "-l", String(pno), "-png", PDF, prefix],
          { stdio: "ignore" },
        );
        // ⚠️ pdftoppm 会自动加 `-NN` 页码后缀，按实际产物改名
        const produced = readdirSync(PAGE_DIR)
          .filter((f) => f.startsWith(`${stem}-r${attempt}-`) && f.endsWith(".png"))
          .sort()
          .pop();
        if (!produced) throw new Error("no output");
        renameSync(join(PAGE_DIR, produced), pngPath);
      } catch {
        console.log(`p${pno} 整页渲染失败（第${attempt}轮）`);
        continue;
      }
      const t0 = Date.now();
      try {
        raw = await mcp.ocr(readFileSync(pngPath).toString("base64"));
      } catch (e) {
        console.log(`p${pno} 整页 OCR 异常（第${attempt}轮）: ${String(e).slice(0, 80)}`);
      }
      console.log(
        `p${pno} 整页 OCR ${((Date.now() - t0) / 1000).toFixed(1)}s ${dpi}dpi → ${raw.length} 字` +
          (raw.trim() ? "" : "（空，重试…）"),
      );
    }
    if (!raw.trim()) {
      console.log(`p${pno} 两轮均为空，本页无候选`);
      outPages.push({ page: p.index, fullText: "", items: [] });
      continue;
    }
    writeFileSync(txtPath, raw);
  }

  const fullText = cleanOcrLines(raw);
  const ocr = hardNorm(fullText);

  /* ② 锚点链：解析块文本在整页文本里前向搜索（单调，不回退） */
  const order: number[] = Array.isArray(p.order) && p.order.length ? p.order : p.blocks.map((_: any, i: number) => i);
  const matches: { bi: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (const bi of order) {
    const b = p.blocks[bi];
    if (!b || b.kind === "image") continue;
    const n = hardNorm(b.text ?? "");
    if (n.chars.length < 4) continue; // 太短不做锚点（防误匹配）
    const idx = findSub(ocr.chars, n.chars, cursor);
    if (idx >= 0) {
      matches.push({ bi, start: idx, end: idx + n.chars.length });
      cursor = idx + n.chars.length;
    }
  }

  /* ③ 未匹配片段（补集），按 **OCR 顺序**排列（不是按几何位置） */
  const matchEnd = new Map<number, number>();
  for (const m of matches) matchEnd.set(m.bi, m.end);
  const spans: { start: number; end: number; after: number | null; before: number | null }[] = [];
  {
    let pos = 0;
    let prevBi: number | null = null;
    for (const m of matches) {
      if (m.start > pos) spans.push({ start: pos, end: m.start, after: prevBi, before: m.bi });
      if (m.end > pos) pos = m.end;
      prevBi = m.bi;
    }
    if (pos < ocr.chars.length) spans.push({ start: pos, end: ocr.chars.length, after: prevBi, before: null });
  }

  /* ④ 洞的**几何阅读顺序**（只用来定「洞与洞之间的先后」） */
  //
  // ⚠️ 两条实测教训（都会让文本整体串位，且串位后宽度比仍「合格」——判据抓不住）：
  //  (a) **高块不参与排序**：高块（行高 > 1.6×字号）是**行内对象**（分式/根式），不是「一行」。
  //      热狗题实测：`5/8 G` 分式块高 23pt（字号 11pt），纵向跨两行文本；若按 y 中心排序，
  //      它会插在 A 选项第 1、2 行之间，把「A 的第 2 行」与「B 的第 1 行」拆开 → 文本串位。
  //      高块仍然**是文本匹配的锚点**（见 ②），只是不当「行」用。
  //  (b) **同一行内按 x 排**：洞的 y 中心有亚 pt 噪声（实测同行两洞 y=194.0 / 194.5），
  //      直接按 y 排会把右边的洞排到前面 → 整行文本左右颠倒。
  //      ⇒ 先按 y 排、顺次打「行号」（同列且 y 差 < 0.6×字号视为同行），再按 (列, 行号, x) 排。
  const fontPt = medianLineHeightPt(p.blocks);
  const mid = p.width / 2;
  type Ord = { kind: "block" | "hole"; idx: number; col: number; y: number; x: number };
  const ord: Ord[] = [];
  p.blocks.forEach((b: any, i: number) => {
    if (b.kind === "image") return;
    if (b.bbox[3] - b.bbox[1] > 1.6 * fontPt) return; // (a) 行内对象，不当「行」
    ord.push({ kind: "block", idx: i, col: b.bbox[0] < mid ? 0 : 1, y: (b.bbox[1] + b.bbox[3]) / 2, x: b.bbox[0] });
  });
  holes.forEach((h: any, i: number) => {
    const bb = h.bbox as Box;
    ord.push({ kind: "hole", idx: i, col: bb[0] < mid ? 0 : 1, y: (bb[1] + bb[3]) / 2, x: bb[0] });
  });
  ord.sort((a, b) => a.col - b.col || a.y - b.y || a.x - b.x);
  const tol = Math.max(2, fontPt * 0.6);
  const lineNo: number[] = [];
  {
    let line = 0;
    let lineY = ord.length ? ord[0]!.y : 0;
    let lineCol = ord.length ? ord[0]!.col : 0;
    ord.forEach((it, k) => {
      if (k > 0 && (it.col !== lineCol || Math.abs(it.y - lineY) > tol)) {
        line++;
        lineY = it.y;
        lineCol = it.col;
      }
      lineNo.push(line);
    });
  }
  const ordered = ord
    .map((it, k) => ({ it, line: lineNo[k]! }))
    .sort((a, b) => a.it.col - b.it.col || a.line - b.line || a.it.x - b.it.x)
    .map((z) => z.it);
  /** 每个洞的「前一个文本行块」—— 只用于下面那条几何守卫。 */
  const prevBlockOfHole = new Map<number, number>();
  {
    let last: number | null = null;
    for (const it of ordered) {
      if (it.kind === "block") last = it.idx;
      else if (last !== null) prevBlockOfHole.set(it.idx, last);
    }
  }
  const holeOrder = ordered.filter((z) => z.kind === "hole").map((z) => z.idx);

  /* ⑤ 按 **OCR 顺序**消费片段；片段内再按**段**消费「视觉行」 */
  //
  // ⚠️ 两条实测教训（都会让文本整体串位，而串位后宽度比仍「合格」——判据抓不住）：
  //
  // (a) **洞的选择必须在「段」这一层，不能先按整片段选洞。** 热狗题：片段有两段
  //     （`静止时，下列说法正确的是（）` / `A. 生“热狗”对单根金属圆柱的压力大小为`），
  //     按整片段选（est=398，阈值 1.2）会把 B 选项第 1 行也吞进来 → 整片串位。
  // (b) **消费单位是「视觉行」，不是「单个洞」。** p14 实测：OCR 把 D 选项读成两行
  //     （`D. 摩擦力大于手机所受的重力沿斜面向下的` / `分力`），视觉上也是两行
  //     （洞 226pt + 22pt）。若按单洞贪心（阈值 1.25），226+22=248 ≤ 250×1.25
  //     → 两行被并进同一个段 → D 只拿到 17 字、`分力` 拿到 `下的`。
  //     整行消费 + 「累计已达段宽 85% 就停」能正确切在两行之间。
  const holeLineKey = new Map<number, string>();
  ord.forEach((it, k) => {
    if (it.kind === "hole") holeLineKey.set(it.idx, `${it.col}:${lineNo[k]!}`);
  });
  const holeLines: number[][] = [];
  {
    let curKey: string | null = null;
    for (const k of holeOrder) {
      const key = holeLineKey.get(k)!;
      if (key !== curKey) {
        holeLines.push([]);
        curKey = key;
      }
      holeLines[holeLines.length - 1]!.push(k);
    }
  }
  const lineWidth = (line: number[]) => line.reduce((a, k) => a + (holes[k].bbox[2] - holes[k].bbox[0]), 0);

  const DBG = !!process.env.OCR_PAGE_DEBUG;
  const bbOf = (bi: number | null) => {
    if (bi === null) return "∅";
    const b = p.blocks[bi];
    return b ? `#${bi}[${b.bbox.map((v: number) => Math.round(v)).join(",")}]` : `#${bi}?`;
  };
  if (DBG) {
    console.log(`[dbg] 匹配锚点 ${matches.length} 个；片段 ${spans.length} 个；视觉行 ${holeLines.length} 个`);
    console.log(
      `[dbg] 行序：${holeLines.map((ln, k) => `${k}:${JSON.stringify(ln.map((i2) => Math.round((holes[i2].bbox[0] + holes[i2].bbox[2]) / 2)))}(${lineWidth(ln).toFixed(0)}pt)`).join(" ")}`,
    );
    spans.forEach((sp, k) => {
      const a = ocr.map[sp.start];
      const b = ocr.map[sp.end - 1];
      const t = a !== undefined && b !== undefined ? fullText.slice(a, b + 1) : "";
      console.log(`[dbg] span#${k} after=${bbOf(sp.after)} before=${bbOf(sp.before)} → ${JSON.stringify(t.slice(0, 56))}`);
    });
    console.log(
      `[dbg] 洞行→其「几何上后一块」：${holeLines.map((ln, k) => `${k}→${bbOf(prevBlockOfHole.get(ln[ln.length - 1]!) ?? null)}`).join(" ")}`,
    );
  }

  const texts: string[] = new Array(holes.length).fill("");
  const segs: string[] = new Array(holes.length).fill("");
  let li = 0; // 下一个未消费的「视觉行」
  for (const span of spans) {
    if (li >= holeLines.length) break;
    const a = ocr.map[span.start];
    const b = ocr.map[span.end - 1];
    if (a === undefined || b === undefined) continue;
    const segList = fullText
      .slice(a, b + 1)
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!segList.length) continue;
    const spanEst = segList.reduce((acc, sg) => acc + emWidthOf(sg) * fontPt, 0);
    if (spanEst <= 0) continue;
    const nextLine = holeLines[li]!;
    const firstHole = nextLine[0]!;
    const w0 = lineWidth(nextLine);
    // 几何守卫：下一个视觉行的「前一个文本行块」若出现在这个片段**之后**，
    // 说明这个片段比它还早（典型：左栏还剩片段，而下一个视觉行在右栏）⇒ 跳过这个片段。
    const anchor = prevBlockOfHole.get(firstHole);
    if (anchor !== undefined && (matchEnd.get(anchor) ?? -1) > span.end) continue;
    if (w0 > spanEst * 1.6) continue; // 片段明显比这一行宽 ⇒ 没有对应的洞
    // ── **`before` 守卫 + 列守卫**（2026-10-12 用户当场指出后补）────────────────
    //
    // 片段的文本**紧邻 `before` 块之前**，所以片段的位置在 `before` 块**上方**。
    // ⇒ 若 `before` 块在洞行之上，这个片段就不是这个洞的。
    //
    // 实测反例（答案文档 p15）：片段 #0 在**页眉区**（`before`=#75[29,39,78,49]，y≈44），
    // 却把右栏 y=433 的节标题行吞了 → 原卷 `第4节` 被写成 `分力,`（左栏解析正文里的词）。
    // 而宽度比 1.41 恰好落在合格区间 ⇒ **判据抓不住**。加这两条守卫后该片段被跳过。
    const beforeBi = span.before;
    const fb = beforeBi === null ? null : p.blocks[beforeBi];
    if (fb) {
      const fby = (fb.bbox[1] + fb.bbox[3]) / 2;
      const holeY = nextLine.reduce((a, k) => a + (holes[k].bbox[1] + holes[k].bbox[3]) / 2, 0) / nextLine.length;
      if (fby < holeY - fontPt) continue; // before 块在洞行之上 ⇒ 不是这个片段
      if ((fb.bbox[0] < mid) !== (holes[firstHole].bbox[0] < mid)) continue; // 不同列
    }
    for (const seg of segList) {
      if (li >= holeLines.length) break;
      const hn = hardNorm(seg);
      const L = hn.chars.length;
      if (!L) continue;
      const est = emWidthOf(seg) * fontPt;
      if (est <= 0) continue;
      const group: number[] = [];
      let acc = 0;
      while (li < holeLines.length) {
        const line = holeLines[li]!;
        const lw = lineWidth(line);
        if (group.length && acc + lw > est * 1.15) break;
        for (const k of line) group.push(k);
        acc += lw;
        li++;
        if (acc >= est * 0.85) break;
      }
      if (!group.length) continue;
      // 段内按洞宽比例**精确**分配字符数（floor + 余数给小数部分最大者 ⇒ 各洞之和恰等于段长）
      const totalW = group.reduce((s2, k) => s2 + (holes[k].bbox[2] - holes[k].bbox[0]), 0) || 1;
      const exact = group.map((k) => (L * (holes[k].bbox[2] - holes[k].bbox[0])) / totalW);
      const base = exact.map((v) => Math.floor(v));
      const rem = L - base.reduce((s2, v) => s2 + v, 0);
      const rank = exact.map((v, i2) => ({ i: i2, frac: v - Math.floor(v) })).sort((x, y) => y.frac - x.frac);
      for (let j = 0; j < rem && rank.length; j++) {
        const t = rank[j % rank.length]!;
        base[t.i] = (base[t.i] ?? 0) + 1;
      }
      let cur = 0;
      group.forEach((k, gi) => {
        const n = base[gi]!;
        if (n > 0) {
          const ca = hn.map[cur]!;
          const cb = hn.map[cur + n - 1]!;
          const piece = seg.slice(ca, cb + 1).trim();
          texts[k] = texts[k] ? `${texts[k]} ${piece}` : piece;
          segs[k] = seg;
        }
        cur += n;
      });
      if (DBG) {
        console.log(
          `[dbg] 段(est=${est.toFixed(0)}) → 洞 ${JSON.stringify(group)}: ` +
            group.map((k) => `#${k}=${JSON.stringify(texts[k])}`).join(" | "),
        );
      }
    }
  }

  /* ⑥ 判据 + 落条 */
  const items: OcrFillItem[] = [];
  let acc = 0;
  for (let i = 0; i < holes.length; i++) {
    const bb = holes[i].bbox as Box;
    const win: Box = [
      Math.max(0, bb[0] - PAD_X),
      Math.max(0, bb[1] - PAD_Y),
      Math.min(p.width, bb[2] + PAD_X),
      bb[3] + PAD_Y,
    ];
    const text = texts[i]!.trim();
    const holeW = bb[2] - bb[0];
    // ⚠️ 整页来源的宽度比按**洞自身**宽度算（文本应当填满这个洞），不是按窗口 —— 与裁图路径口径不同。
    const expected = fontPt > 0 ? holeW / fontPt : 0;
    const emW = emWidthOf(text);
    const ratio = emW > 0 && fontPt > 0 ? holeW / (emW * fontPt) : 0;
    // **文本必须自洽**：`$` 成对。切分按宽度比例切，可能落在公式中间
    //（实测答案文档 p13：`律有 $ T - \m` / `= ma $，根` —— 半个公式，渲染出来是噪声）。
    // 不成对 ⇒ 这不是一段可读文本 ⇒ 宁可不补。
    const balanced = ((text.match(/\$/g) ?? []).length % 2) === 0;
    // **交叉核对**：裁图路径对同一洞给过文本、且与整页结果明显不一致 ⇒ 两条独立路径矛盾 ⇒ 不补。
    const cropText = cropByBbox.get(bb.map((v) => Math.round(v)).join(",")) ?? "";
    const agree = !cropText || dice(cropText, text) >= 0.34;
    const ok =
      text.length > 0 && expected >= MIN_EXPECT_CHARS && balanced && agree && ratio >= RATIO_MIN && ratio <= RATIO_MAX;
    if (ok) acc++;
    const reason = ok
      ? undefined
      : !text
        ? "整页对齐未取到文本"
        : expected < MIN_EXPECT_CHARS
          ? `洞太小（期望 ${expected.toFixed(1)} 字 < ${MIN_EXPECT_CHARS}）`
          : !balanced
            ? "公式被切断（$ 不成对）"
            : !agree
              ? `与裁图结果不一致（裁图=${JSON.stringify(cropText.slice(0, 20))}）`
              : `宽度比 ${ratio.toFixed(2)} 越界`;
    items.push({
      bbox: bb,
      win,
      text,
      raw: segs[i]!,
      crop: pngPath,
      ratio: +ratio.toFixed(2),
      accepted: ok,
      source: "page",
      ...(reason ? { reason } : {}),
    });
    console.log(
      `  p${pno} 洞 ${JSON.stringify(bb.map((v) => Math.round(v)))} 期望${expected.toFixed(1)}字 比=${ratio.toFixed(2)} ${ok ? "✓" : "✗"} ${JSON.stringify(text.slice(0, 44))}${ok ? "" : ` ← ${reason}`}`,
    );
  }
  outPages.push({ page: p.index, fullText, items });
  totalAccepted += acc;
}
mcp.close();

outPages.sort((a, b) => a.page - b.page);
writeFileSync(
  PAGE_JSON,
  JSON.stringify(
    {
      docId: DOC,
      generatedAt: new Date().toISOString(),
      source: "paddleocr-vl-1.6",
      note: "整页 OCR 候选补全：仅供人工核对，不静默替换引擎文本（G1）。",
      total: totalHoles,
      accepted: totalAccepted,
      pages: outPages,
    },
    null,
    1,
  ),
);
console.log(`\n===== 整页补全：${totalAccepted}/${totalHoles} 条通过判据 =====`);
console.log(`落盘 ${PAGE_JSON}；整页图与识别原文在 ${PAGE_DIR}/`);

// 自动重导快照（同一 docId），让候选真正进入 stages.json。
const layoutPath = existsSync(join(OUT_DIR, "layout.json"))
  ? join(OUT_DIR, "layout.json")
  : join("data", "smoke", "unpacked", "layout.json");
console.log(`重导快照：export-stages.ts "${DOC}" "${layoutPath}"`);
execFileSync(process.execPath, ["--import", "tsx", "scripts/export-stages.ts", DOC, layoutPath], {
  stdio: "inherit",
});
