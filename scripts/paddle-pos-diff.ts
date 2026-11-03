// scripts/paddle-pos-diff.ts
/**
 * 位置审计（**只报警**）：整页 OCR 摊字符猜出来的位置 vs PaddleOCR-VL 真实块位置。
 *
 * ## 为什么要量这个
 *
 * 现在整页 OCR 只回文本（MCP 通道丢坐标，见 `scripts/paddle-client.ts` 头注），于是
 * `scripts/ocr-page-fill.ts` 只能猜位置：① 按页宽中线判左右栏（`:300-310`）；
 * ② 按 y 聚成视觉行（`:289-331`）；③ 把一段文本**按洞的宽度等比例摊回字符**
 * （`:456-489`，floor + 最大余数）。第 ③ 步是纯启发式，脚本自己的注释也承认风险：
 * 「整页 OCR 会把折行的选项并成一行 ⇒ 按比例切分会把下一行的开头派给上一行」。
 *
 * 而 VL 整本作业是给块坐标的（实测 `parsing_res_list[].block_bbox / block_order`）。
 * 所以可以**反过来量**：这条候选文本，在 VL 眼里是不是真在这个位置？
 *
 * ## 度量口径（不改数据，只出差异清单）
 *
 * 对每条候选（`ocr-page-fill.json` 的 item，坐标在 `stages.json` 的像素域）：
 * 1. 归一化（÷ 该页 `width/height`）——VL 侧是 PDF 渲染尺度（实测 4186×5988），**不归一化不能比**；
 * 2. 在 VL 同页块里找**文本最像**的块（字符 4-gram Dice ≥ 阈值），记它的归一化框；
 * 3. 算 IoU、栏位是否一致（同用页宽中线，与现用判据同一口径）、纵向偏移 Δy。
 * ⇒ 文本匹配得上但 IoU≈0 = 「串位」证据；匹配不上 = 该页 VL 没给出可比块（不计为错）。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/paddle-pos-diff.ts                       # 所有有 ocr-page-fill.json 且 ≤40 页的册
 * npx tsx scripts/paddle-pos-diff.ts --doc "物理_教材基础练 电路" --force
 * npx tsx scripts/paddle-pos-diff.ts --report-only         # 只读已落盘 VL 结果
 * ```
 * 落盘：`data/out/<docId>/paddle-pos-diff.json` + 聚合报告 `docs/evidence/2026-11-03-paddle-pos-diff.md`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobTag, parseDocParsingJsonl, runJob, saveJobArtifacts, sha256File, verifyToken, type PaddlePage } from "./paddle-client.js";

const ROOT = join(import.meta.dirname, "..");
const OUT_ROOT = join(ROOT, "data", "out");
const REPORT = join(ROOT, "docs", "evidence", "2026-11-03-paddle-pos-diff.md");
/** Dice 相似度下限：低于此不认为「这块就是这条文本」，不计入串位。 */
const MATCH_MIN = 0.55;
const DICE_N = 4;
type Box = [number, number, number, number];

/* ── 纯函数（可单测） ──────────────────────────────────────────────────── */

/** 归一化：只留实义字符（去空白与 LaTeX 记号 `$ \\ { }`），与 `ocr-page-fill.ts:hardNorm` 同口径。 */
export function hardChars(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    if (ch === "$" || ch === "\\" || ch === "{" || ch === "}") continue;
    out.push(ch);
  }
  return out;
}

/** 字符 n-gram 集合。串短于 n 时退化为整串一个 gram（否则短文本永远 Dice=0）。 */
export function charNgrams(chars: string[], n = DICE_N): Set<string> {
  const g = new Set<string>();
  if (chars.length === 0) return g;
  if (chars.length <= n) {
    g.add(chars.join(""));
    return g;
  }
  for (let i = 0; i + n <= chars.length; i++) g.add(chars.slice(i, i + n).join(""));
  return g;
}

export function dice(a: string, b: string): number {
  const A = charNgrams(hardChars(a));
  const B = charNgrams(hardChars(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function iou(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const u = areaA + areaB - inter;
  return u > 0 ? inter / u : 0;
}

/** 洞被匹配块覆盖的比例：`交集面积 / 洞面积`。 */
export function coverage(hole: Box, block: Box): number {
  const w = Math.min(hole[2], block[2]) - Math.max(hole[0], block[0]);
  const h = Math.min(hole[3], block[3]) - Math.max(hole[1], block[1]);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const areaHole = Math.max(0, hole[2] - hole[0]) * Math.max(0, hole[3] - hole[1]);
  return areaHole > 0 ? inter / areaHole : 0;
}

/** 栏判定：与现用判据同一口径 —— 中心点在页宽中线左侧 = 左栏。 */
export function colOf(b: Box): number {
  return (b[0] + b[2]) / 2 < 0.5 ? 0 : 1;
}

/**
 * 文本匹配：**包含关系**，不是 n-gram Dice（2026-11-03 第二轮定；第一轮用 Dice 是错的）。
 *
 * 为什么不能用相似度：洞里的文本是**一段文字被摊出来的碎片**（实测 2603 条候选里
 * 2586 条硬字符数 < 8），拿碎片去和整段算 4-gram Dice，实测 99.6% 判成"不可匹配"，
 * 剩下匹配上的全是 `图1`/`甲`/`乙` 这类**跨处重复的短标签**随机配对 ⇒ 结论作废。
 * 正确的问法是：**这段碎片落在哪个块的文字里？**
 * - 恰好 1 个块包含 ⇒ 可核对（`unique`）
 * - ≥2 个块包含 ⇒ 无法唯一定位（`ambiguous`，不计为错）
 * - 0 个包含 ⇒ VL 没读出这段（`absent`，不计为错）
 * - 碎片太短（< `MIN_FRAG` 个硬字符）⇒ 本来就不该指望定位（`too_short`）
 */
export const MIN_FRAG = 6;
export type MatchState = "unique" | "ambiguous" | "absent" | "too_short" | "no_blocks";

/** 只按「是否被包含」定位（两侧都过 `hardChars`，与 `ocr-page-fill.ts:hardNorm` 同口径）。 */
export function containMatches(fragment: string, blocks: { content: string; norm: Box | null; label: string }[]): number[] {
  const t = hardChars(fragment).join("");
  const hits: number[] = [];
  blocks.forEach((b, i) => {
    if (!b.norm || !b.content) return;
    if (hardChars(b.content).join("").includes(t)) hits.push(i);
  });
  return hits;
}

export function matchState(fragment: string, blocks: { content: string; norm: Box | null; label: string }[], hits: number[]): MatchState {
  if (blocks.length === 0) return "no_blocks";
  if (hardChars(fragment).length < MIN_FRAG) return "too_short";
  if (hits.length === 0) return "absent";
  if (hits.length > 1) return "ambiguous";
  return "unique";
}

/**
 * 页序基：`0` = `ocr-page-fill.json` 的 `page` 从 0 开始（实测电路 13 页 ⇒ 0..12），
 * `1` = 从 1 开始，`mixed` = 这一册的页字段**判不出基**（洞只在部分页出现，
 * 值全落在 1..pageCount−1）。判基规则见 `detectPageBasis`——用值集合，不用 min/max。
 */
export type PageBasis = "0" | "1" | "mixed";

/**
 * 页序基判定用**值集合**而不是 min/max（2026-11-03 第二轮修正）：
 * - 集合里有 `pageCount` ⇒ 只可能是 1 基（0 基最大到 pageCount−1）
 * - 集合里有 `0` ⇒ 只可能是 0 基（1 基不会从 0 开始）
 * - 都没有（只有部分页有洞，值全落在 1..pageCount−1）⇒ **真判不出来**，记 `mixed`
 *   并按 0 基走：宁可标"这一册的结论不可信"，也不假装知道。
 *   只看 min 会误判：稀疏页的 0 基册（洞从第 4 页开始）会被错标成 mixed。
 */
export function detectPageBasis(raws: number[], pageCount: number): PageBasis {
  if (raws.length === 0 || pageCount <= 0) return "0";
  const set = new Set(raws);
  if (set.has(pageCount)) return "1";
  if (set.has(0)) return "0";
  return "mixed";
}

/** 按整本判定出的基把页字段换算成 0 基数组下标。 */
export function pageIndex(raw: number, basis: PageBasis): number {
  return basis === "1" ? raw - 1 : raw;
}

/**
 * **串位判据用「覆盖率」不用 IoU**（2026-11-03 定）：VL 的一块 = 一整段，
 * 而洞是按**视觉行**切的，一行对一段的 IoU 天然低 ⇒ 用 IoU 会"狼来了"。
 * 覆盖率问的是更准的事：**VL 说这段话所在的位置，包不包含这个洞？**
 * `cover < COVER_MIN` ⇒ 文本对得上、位置却说在别处 = 串位证据。
 */
export const COVER_MIN = 0.5;

/**
 * **块边界容差**（归一化页高单位，2026-11-03 第二轮加）：VL 的块框来自版面检测，
 * 比 MinerU 的视觉行框粗糙且常内缩；**洞与块边线相接**那一类会被判成 `cover=0`，
 * 属于工具伪影，先把块框四周外扩这个量再算覆盖。
 *
 * ⚠️ 但它**消不掉**"洞与块隔了一行以上"的情况：实测样本洞 y 0.339–0.346、块 y 0.355–0.411，
 * 间隔 0.009 ≈ 1.3 倍行高，外扩 0.01 后 cover 也只有 0.143。这种到底是"摊字符摊错了行"
 * 还是"VL 块框本身不含这一行"，**指标分不开，只能回原卷页图逐条看**（`BACKLOG B-30`）。
 */
export const COVER_MARGIN = 0.01;

export function dilate(b: Box, m: number): Box {
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
}

export interface ItemVerdict {
  page: number;
  hole: Box;
  text: string;
  accepted: boolean;
  status: MatchState;
  bestDice: number;
  bestIou: number;
  /** 洞被 VL 匹配块覆盖的比例 */
  cover: number;
  colSame: boolean | null;
  dy: number | null;
  vlLabel: string | null;
  /** 匹配到的 VL 块归一化框（报告要能指着页图核对） */
  vlBox: Box | null;
}

/** 一条候选 ⇒ 对 VL 块做文本定位 + 位置核对（纯函数）。 */
export function judgeItem(pageIdx0: number, holeNorm: Box, text: string, accepted: boolean, blocks: { content: string; norm: Box | null; label: string }[]): ItemVerdict {
  const v: ItemVerdict = {
    page: pageIdx0 + 1,
    hole: holeNorm,
    text,
    accepted,
    status: "no_blocks",
    bestDice: 0,
    bestIou: 0,
    cover: 0,
    colSame: null,
    dy: null,
    vlLabel: null,
    vlBox: null,
  };
  const hits = containMatches(text, blocks);
  v.status = matchState(text, blocks, hits);
  // Dice 只留作参考列（说明"像不像"，不参与判定）
  let bestScore = 0;
  for (const b of blocks) if (b.norm && b.content) bestScore = Math.max(bestScore, dice(text, b.content));
  v.bestDice = +bestScore.toFixed(3);
  if (v.status !== "unique") return v;
  const b = blocks[hits[0]!];
  if (b?.norm) {
    v.bestIou = +iou(holeNorm, b.norm).toFixed(3);
    v.cover = +coverage(holeNorm, dilate(b.norm, COVER_MARGIN)).toFixed(3);
    v.colSame = colOf(holeNorm) === colOf(b.norm);
    v.dy = +((b.norm[1] + b.norm[3]) / 2 - (holeNorm[1] + holeNorm[3]) / 2).toFixed(4);
    v.vlBox = b.norm;
    v.vlLabel = b.label;
  }
  return v;
}

/* ── 取数 ──────────────────────────────────────────────────────────────── */

interface OcrItem {
  bbox: number[];
  text?: string;
  accepted?: boolean;
  reason?: string;
  source?: string;
}
interface FillPage {
  page: number;
  items?: OcrItem[];
}

function loadFill(docDir: string): FillPage[] | null {
  const p = join(docDir, "ocr-page-fill.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { pages?: FillPage[] };
    return Array.isArray(j.pages) ? j.pages : null;
  } catch {
    return null; // 存在但读不动 = 异常，由调用方如实登记（与 tests/ocr-input-error.test.ts 同一口径）
  }
}

function stagePageDims(docDir: string): Map<number, { w: number; h: number }> {
  const m = new Map<number, { w: number; h: number }>();
  try {
    const j = JSON.parse(readFileSync(join(docDir, "stages.json"), "utf8")) as {
      pages: { index?: number; width?: number; height?: number }[];
    };
    for (const p of j.pages ?? []) {
      if (typeof p.index === "number" && p.width && p.height) m.set(p.index, { w: p.width, h: p.height });
    }
  } catch {
    /* 没有快照就什么都不映射，该册会被跳过 */
  }
  return m;
}

function cachedVl(docDir: string, sha: string): PaddlePage[] | null {
  const dir = join(docDir, "ocr-jobs");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n === `${jobTag("PaddleOCR-VL-1.6", sha)}.pages.json`);
  if (!f) return null;
  try {
    const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    return Array.isArray(p) ? (p as PaddlePage[]) : null;
  } catch {
    return null;
  }
}

export interface DocOutcome {
  docId: string;
  ran: "cached" | "job" | "skipped";
  skipReason?: string;
  wallMs?: number;
  pageBasis: PageBasis;
  items: number;
  accepted: number;
  /** 碎片被**唯一一个** VL 块包含 ⇒ 位置可核对 */
  unique: number;
  /** 唯一包含 + 碎片够长，但那个块没盖住洞 ⇒ 串位证据 */
  misplaced: number;
  ambiguous: number;
  absent: number;
  tooShort: number;
  noBlocks: number;
  /** 文本落在左栏、洞在右栏（或反之）的条数 */
  colDiff: number;
  meanCoverUnique: number;
  worst: ItemVerdict[];
}

async function auditDoc(docId: string, maxPages: number, reportOnly: boolean, force: boolean): Promise<DocOutcome> {
  const docDir = join(OUT_ROOT, docId);
  const fill = loadFill(docDir);
  if (!fill) return skip(docId, "没有可读的 ocr-page-fill.json（本审计需要有整页摊字符的候选）");
  const pdf = join(docDir, "origin.pdf");
  if (!existsSync(pdf) || statSync(pdf).size === 0) return skip(docId, "没有 origin.pdf（VL 整本作业要按页取 PDF）");
  const dims = stagePageDims(docDir);
  if (dims.size === 0) return skip(docId, "stages.json 里没有页宽高，无法归一化坐标");

  const sha = sha256File(pdf);
  let vl = force ? null : cachedVl(docDir, sha);
  let ran: DocOutcome["ran"] = "cached";
  let wallMs = 0;
  const pageCount = Math.max(...[...dims.keys()]) + 1;
  if (!vl) {
    if (reportOnly) return skip(docId, `只有 --report-only，VL 结果未落盘（sha ${sha.slice(0, 12)}）`);
    if (pageCount > maxPages) return skip(docId, `本审计限 ${maxPages} 页/本（这本 ${pageCount} 页）——加大 --max-pages 再跑`);
    const cred = await verifyToken();
    if (!cred.ok) return skip(docId, `凭据不可用 [${cred.state}] ${cred.detail}`);
    const t0 = Date.now();
    console.log(`  ▶ ${docId}：VL 整本作业（${pageCount} 页 / ${(statSync(pdf).size / 1024 / 1024).toFixed(1)} MB）…`);
    const outcome = await runJob({
      model: "PaddleOCR-VL-1.6",
      filePath: pdf,
      options: { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: true, useSealRecognition: false },
      onProgress: (m) => console.log(`    ${docId}${m}`),
    });
    wallMs = Date.now() - t0;
    saveJobArtifacts(docDir, outcome, { model: "PaddleOCR-VL-1.6" });
    vl = parseDocParsingJsonl(outcome.jsonl);
    ran = "job";
  }
  const pages = vl as PaddlePage[];
  const raws = fill.map((p) => (typeof p.page === "number" ? p.page : 0));
  const basis = detectPageBasis(raws, pages.length);
  const verdicts: ItemVerdict[] = [];
  for (const pg of fill) {
    const raw = typeof pg.page === "number" ? pg.page : 0;
    // 页序基按整本判定（第一轮写死 1 基 ⇒ 拿第 N 页的洞比第 N−1 页的块，结论作废）
    const index = pageIndex(raw, basis);
    const dim = dims.get(index);
    const page = pages[index];
    if (!dim || !dim.w || !dim.h) continue;
    const blocks = (page?.blocks ?? []).map((b) => ({ content: b.content, norm: b.norm, label: b.label }));
    for (const it of pg.items ?? []) {
      if (!it.text || !Array.isArray(it.bbox) || it.bbox.length < 4) continue;
      const hole: Box = [it.bbox[0]! / dim.w, it.bbox[1]! / dim.h, it.bbox[2]! / dim.w, it.bbox[3]! / dim.h];
      verdicts.push(judgeItem(index, hole, it.text, it.accepted === true, blocks));
    }
  }
  const uniq = verdicts.filter((v) => v.status === "unique");
  const misplaced = uniq.filter((v) => v.cover < COVER_MIN);
  const colDiff = uniq.filter((v) => v.colSame === false);
  const out: DocOutcome = {
    docId,
    ran,
    wallMs,
    pageBasis: basis,
    items: verdicts.length,
    accepted: verdicts.filter((v) => v.accepted).length,
    unique: uniq.length,
    misplaced: misplaced.length,
    ambiguous: verdicts.filter((v) => v.status === "ambiguous").length,
    absent: verdicts.filter((v) => v.status === "absent").length,
    tooShort: verdicts.filter((v) => v.status === "too_short").length,
    noBlocks: verdicts.filter((v) => v.status === "no_blocks").length,
    colDiff: colDiff.length,
    meanCoverUnique: +(uniq.reduce((a, v) => a + v.cover, 0) / Math.max(1, uniq.length)).toFixed(3),
    // 最硬的样本 = 碎片越长、被唯一包含却没盖住洞（短碎片本来就不该指望定位）
    worst: [...misplaced].sort((a, b) => hardChars(b.text).length - hardChars(a.text).length).slice(0, 8),
  };
  writeFileSync(
    join(docDir, "paddle-pos-diff.json"),
    JSON.stringify(
      {
        docId,
        model: "PaddleOCR-VL-1.6",
        vlInputSha256: sha,
        generatedAt: new Date().toISOString(),
        matchMinDice: MATCH_MIN,
        minFragChars: MIN_FRAG,
        coverMin: COVER_MIN,
        pageBasis: basis,
        note: "只报警：串位 = 碎片被唯一一个 VL 块的文字包含、但该块没盖住这个洞（cover<0.5）；ambiguous/absent/too_short/no_blocks 都不计为错。判定仍回原卷页图。",
        summary: out,
        verdicts,
      },
      null,
      2,
    ),
    "utf8",
  );
  return out;
}

function skip(docId: string, reason: string): DocOutcome {
  return {
    docId,
    ran: "skipped",
    skipReason: reason,
    pageBasis: "0",
    items: 0,
    accepted: 0,
    unique: 0,
    misplaced: 0,
    ambiguous: 0,
    absent: 0,
    tooShort: 0,
    noBlocks: 0,
    colDiff: 0,
    meanCoverUnique: 0,
    worst: [],
  };
}

export function candidateDocsWithFill(): string[] {
  if (!existsSync(OUT_ROOT)) return [];
  return readdirSync(OUT_ROOT)
    .filter((d) => !d.startsWith("_") && d !== "bank" && d !== "archive")
    .filter((d) => existsSync(join(OUT_ROOT, d, "ocr-page-fill.json")))
    .sort();
}

function renderReport(rows: DocOutcome[]): string {
  const done = rows.filter((r) => r.ran !== "skipped");
  const sum = (k: keyof DocOutcome) => done.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const lines: string[] = [
    "# 整页 OCR 摊字符位置 vs PaddleOCR-VL 真实块位置（只报警）",
    "",
    `> 生成：${new Date().toISOString().slice(0, 16)} ｜ 脚本：\`scripts/paddle-pos-diff.ts\` ｜ 明细：各册 \`data/out/<docId>/paddle-pos-diff.json\``,
    ">",
    "> **判据（第二轮）**：把洞里的文本碎片归一化后，看它被**哪几个** VL 块的文字包含 ——",
    "> 恰好 1 个 ⇒ `唯一落位`（可核对）；≥2 个 ⇒ `歧义`；0 个 ⇒ `VL 没读出`；碎片硬字符 < ",
    `> ${MIN_FRAG} ⇒ \`太短无法定位\`。四态里**只有「唯一落位」参与判定**，其余一律不计为错。`,
    `> **串位** = 唯一落位、但那个块没盖住洞（覆盖率 < ${COVER_MIN}，块框先四周外扩 ${COVER_MARGIN} 页高再算）。`,
    "> 容差只消得掉「洞与块边线相接」那类伪影；**隔一行以上的差距分不开「摊字符摊错了行」与「VL 块框本身内缩」**",
    "> ⇒ 串位样本必须逐条回原卷页图看，本页比率**不能当结论**（`BACKLOG B-30`）。",
    ">",
    "> **为什么不用 IoU**：VL 一块 = 一整段，洞按视觉行切，一行对一段 IoU 天然低 ⇒ 会「狼来了」。",
    "> **为什么第一轮作废**：当时用 4-gram Dice 比「碎片段 vs 整段」（实测 2603 条里 2586 条 <8 字符），",
    "> 结果 99.6% 判成不可匹配、剩下 16 条全是 `图1`/`甲`/`乙` 这种重复短标签乱配对；",
    "> 且页序写死 1 基而 `ocr-page-fill.json` 的 `page` 实测是 **0 基** ⇒ 拿第 N 页的洞比了第 N−1 页的块。",
    "> **两处都是这个审计工具自己的错，不是产线的问题**；v1 的「串位 100%」不成立，本节数字是 v2 重算。",
    "",
    "| 册 | 页序基 | 来源 | 候选 | 已采纳 | 唯一落位 | **串位** | 歧义 | VL 没读出 | 太短 | 无可比块 | 栏位不一致 | 唯一落位平均覆盖 |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of done) {
    lines.push(
      `| ${r.docId} | ${r.pageBasis} | ${r.ran === "job" ? `新作业 ${((r.wallMs ?? 0) / 1000).toFixed(1)}s` : "缓存"} | ${r.items} | ${r.accepted} | ${r.unique} | ` +
        `**${r.misplaced}** | ${r.ambiguous} | ${r.absent} | ${r.tooShort} | ${r.noBlocks} | ${r.colDiff} | ${r.meanCoverUnique} |`,
    );
  }
  const u = Math.max(1, sum("unique"));
  lines.push(
    "",
    "## 合计（v2 判据）",
    "",
    `- 候选 **${sum("items")}** 条 ⇒ 唯一落位 **${sum("unique")}** 条（${((sum("unique") / Math.max(1, sum("items"))) * 100).toFixed(1)}% 的候选有能力核对位置）`,
    `- **串位（唯一落位但没盖住洞）：${sum("misplaced")} 条 = 唯一落位的 ${((sum("misplaced") / u) * 100).toFixed(1)}%**`,
    `- 栏位判读不一致：${sum("colDiff")} 条（唯一落位的 ${((sum("colDiff") / u) * 100).toFixed(1)}%）`,
    `- 唯一落位子集平均覆盖：${(done.reduce((a, r) => a + r.meanCoverUnique * r.unique, 0) / u).toFixed(3)}`,
    `- 不可判定的去向：歧义 ${sum("ambiguous")}、VL 没读出 ${sum("absent")}、太短 ${sum("tooShort")}、无可比块 ${sum("noBlocks")}`,
    "",
    "## 最硬的串位样本（每册最多 8 条，按碎片长度从长到短）",
    "",
    "| 册 | 页 | 碎片字数 | 覆盖 | IoU | 栏 | VL 标签 | 候选文本 | 洞(归一化) | VL 块(归一化) |",
    "|---|---:|---:|---:|---:|---|---|---|---|---|",
  );
  for (const r of done) {
    for (const w of r.worst) {
      const f = (b: Box | null) => (b ? `${b[0].toFixed(3)},${b[1].toFixed(3)},${b[2].toFixed(3)},${b[3].toFixed(3)}` : "—");
      lines.push(
        `| ${r.docId} | ${w.page} | ${hardChars(w.text).length} | ${w.cover} | ${w.bestIou} | ${w.colSame === null ? "—" : w.colSame ? "同" : "**异**"} | ${w.vlLabel ?? "—"} | ` +
          `${w.text.slice(0, 28).replace(/\|/g, "\\|")} | ${f(w.hole)} | ${f(w.vlBox)} |`,
      );
    }
  }
  const sk = rows.filter((r) => r.ran === "skipped");
  if (sk.length) {
    lines.push("", "## 本轮跳过（如实登记）", "", "| 册 | 原因 |", "|---|---|");
    for (const r of sk) lines.push(`| ${r.docId} | ${r.skipReason} |`);
  }
  lines.push(
    "",
    "## 这批数字说明什么 / 不能说明什么",
    "",
    `**能定的只有一条**：候选里有 **${sum("tooShort")} 条（${((sum("tooShort") / Math.max(1, sum("items"))) * 100).toFixed(1)}%）碎片 <${MIN_FRAG} 个硬字符**`,
    "⇒ 摊字符产出的**绝大多数碎片无法用文本独立核验位置**（这才是「位置证据缺失」的直接证据），",
    "与 B-27（文本域跨源比对）的设计有关：比对粒度得落到**行/段**，不能落在这种碎片上。",
    "",
    "**不能定的**：串位率本身。三个理由：",
    `1. 可判定样本只 ${sum("unique")} 条（候选的 ${((sum("unique") / Math.max(1, sum("items"))) * 100).toFixed(1)}%），代表性不足；`,
    `2. 有 ${rows.filter((r) => r.ran !== "skipped" && r.pageBasis === "mixed").length} 本连**页序基都判不出**（洞只出现在部分页，值域同时兼容 0/1 基），这几本的读数不可信；`,
    "3. 指标分不清「摊错了行」与「VL 块框内缩」（见上文容差说明），逐条仍要回原卷页图。",
    "",
    "- `VL 没读出` 与 `歧义` 不计为错：VL 自己也会漏读、把折行选项并成一行（`ocr-page-fill.ts` 头部注释实测过），",
    "  同一碎片被多个块包含时本来就不该指望定位。",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const maxPages = Number(flag("max-pages") ?? 40);
  const reportOnly = argv.includes("--report-only");
  const force = argv.includes("--force");
  const only = flag("doc");
  const docs = only ? [only] : candidateDocsWithFill();
  console.log(`位置审计 ${docs.length} 本（≤${maxPages} 页/本${reportOnly ? "，仅读缓存" : ""}${force ? "，--force 重跑作业" : ""}）…`);
  const rows: DocOutcome[] = [];
  for (const d of docs) {
    try {
      rows.push(await auditDoc(d, maxPages, reportOnly, force));
    } catch (e) {
      rows.push(skip(d, `异常：${(e as Error)?.message ?? e}`.slice(0, 180)));
      console.log(`  ⚠️ ${d}：${(e as Error)?.message ?? e}`);
    }
  }
  mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
  writeFileSync(REPORT, renderReport(rows), "utf8");
  const done = rows.filter((r) => r.ran !== "skipped");
  const unique = done.reduce((a, r) => a + r.unique, 0);
  const mis = done.reduce((a, r) => a + r.misplaced, 0);
  console.log(
    `\n完成 ${done.length} 本 / 跳过 ${rows.length - done.length} 本；报告 → ${REPORT}\n` +
      `   唯一落位 ${unique} 条，其中串位（VL 块没盖住洞）${mis} 条 = ${((mis / Math.max(1, unique)) * 100).toFixed(1)}%`,
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
