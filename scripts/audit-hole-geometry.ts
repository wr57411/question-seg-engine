// scripts/audit-hole-geometry.ts
/**
 * B-28 批次 3 · 洞几何核查（**只读审计**；不接 `check`、不接 daily、不覆盖任何现有产物）。
 *
 * 为什么存在：批次 1/2 的接线条件卡在「jobs 候选数 2 < MCP 7」，但 MCP 那 7 条里
 * ≥2 条是「按宽摊字符」串位（`54af46b`）——基准本身掺错；批次 2 又发现 p150 三洞疑似
 * MinerU 标题块 bbox 膨胀（230pt vs 墨迹 ~130pt）+ 位移造出的假洞/半真洞。在谈换引擎前，
 * 必须先用**独立于解析结果**的来源回答：这些洞在原卷上是不是一条真实、完整、未被覆盖的墨迹行？
 *
 * 唯一独立来源：`data/out/<doc>/origin.pdf` 经 `pdftoppm -gray` 渲染的灰度像素，
 * 复用 `parsePgm` / `INK_THRESHOLD`（与 Task 16 墨迹口径同源）。判「哪里是墨迹」
 * **不读** MinerU 的 bbox / content_list / OCR 文本；bbox 只作为**被检验对象**参与比较。
 *
 * 每个 content 洞量四组数：
 *   bandInk = 洞所在行带（同栏、洞高×1.5）内的真实墨迹包围盒（pt）+ 像素数
 *   holeInk = 洞 bbox 内的真实墨迹像素数
 *   blocks  = 与该行带 y 重叠、x 同栏的 stage 块（**blocks∪raw∪discarded**，与 uncovered
 *             同源——只量 raw 会漏掉 230pt 级膨胀块，首版就因此把结论做反了），逐块量 bboxFit
 *   fit.inflation = bbox 宽 / 块内真实墨迹宽（>1 即膨胀）；dx/dy = bbox 中心 − 墨迹中心
 *
 * 判定（L2 最严 AND，阈值集中在 THRESHOLDS，可做 ±20% 敏感性对照）：
 *   FAKE     洞内几乎无墨（holeInk < minHoleInkPx）
 *   FRAGMENT 洞只占该真实行一小段（洞宽/行宽 < fragmentRatio **或** 洞内墨迹/行墨迹 < fragmentRatio）
 *            **且**同源框集里存在 inflation ≥ inflationAlert 的块
 *            ⇒ bbox 吃掉了同行其余墨迹，洞是被切剩的残片
 *            （逐块 dx 只如实记录、不当判据：见 THRESHOLDS 下方注记）
 *   REAL     其余（洞与行墨迹吻合、附近块无明显膨胀/位移）
 * 只报警，不做任何搬迁/丢弃；每条结论带可核对数字。
 *
 * 用法：npx tsx scripts/audit-hole-geometry.ts [--doc <id>] [--pages 74,91,150,159]
 *       [--out <json>] [--threshold 160] [--sensitivity]
 * 页号口径：与 `stages.json` 的 `pages[].index` 一致（**0 基**），渲染时 +1 转 pdftoppm 页号。
 * 产物：`data/out/<doc>/hole-geometry.json`（新增文件；不含时间戳 ⇒ 同输入逐字节可复现）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INK_THRESHOLD, parsePgm, type GrayImage } from "./export-stages.js";

export type Box = [number, number, number, number];

const ROOT = join(import.meta.dirname, "..");
const round = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** 只渲染需要的单页（187 页全渲既慢又没必要）。复用生产脚本的 PGM 解析。 */
export function renderGrayPage(pdfPath: string, pageNo1Based: number, dpi = 150): GrayImage {
  const dir = mkdtempSync(join(tmpdir(), "hole-geom-"));
  try {
    const prefix = join(dir, "p");
    execFileSync(
      "pdftoppm",
      ["-gray", "-r", String(dpi), "-f", String(pageNo1Based), "-l", String(pageNo1Based), "-singlefile", pdfPath, prefix],
      { timeout: 120_000 },
    );
    const pgm = `${prefix}.pgm`;
    if (!existsSync(pgm)) throw new Error(`pdftoppm 未产出 PGM：${pgm}`);
    return parsePgm(new Uint8Array(readFileSync(pgm)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Extent {
  /** 区域内墨迹包围盒（pt）；null = 该区域无墨 */
  bbox: Box | null;
  inkPx: number;
}

/** 区域内真实墨迹包围盒 + 像素数。**唯一读图像的地方**，纯函数、可合成图单测。 */
export function inkExtent(
  img: GrayImage,
  pageW: number,
  pageH: number,
  region: Box,
  threshold = INK_THRESHOLD,
): Extent {
  if (!(pageW > 0 && pageH > 0)) return { bbox: null, inkPx: 0 };
  const sx = img.width / pageW;
  const sy = img.height / pageH;
  // norm(0..1)×页高 常产生 109.00000000000001 这类浮点尾数，直接 ceil 会凭空多算一行
  // （合成图单测抓到过：10 行墨带被算成 11 行框 ⇒ 互相关出现假平台）。
  const EPS = 1e-9;
  const x0 = clamp(Math.floor(region[0] * sx + EPS), 0, img.width - 1);
  const x1 = clamp(Math.ceil(region[2] * sx - EPS), 0, img.width - 1);
  const y0 = clamp(Math.floor(region[1] * sy + EPS), 0, img.height - 1);
  const y1 = clamp(Math.ceil(region[3] * sy - EPS), 0, img.height - 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let inkPx = 0;
  for (let y = y0; y <= y1; y++) {
    const base = y * img.width;
    for (let x = x0; x <= x1; x++) {
      if (img.data[base + x]! >= threshold) continue;
      inkPx++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!inkPx) return { bbox: null, inkPx: 0 };
  return { bbox: [minX / sx, minY / sy, (maxX + 1) / sx, (maxY + 1) / sy], inkPx };
}

/**
 * 以洞为锚点、在**洞的 x 范围**内向上/下扩展到白缝，得到「洞所在的真实墨迹行」。
 * 为什么不用 `splitInkLines`：全局切行在窄 x 范围/上下标处会多切少切，实测 p150 h0
 * 算出「洞宽是行宽 1.99 倍」的自相矛盾值。以洞为锚点扩展没有这个问题。
 * 纯函数，合成图可单测。
 */
export function inkLineAround(
  img: GrayImage,
  pageW: number,
  pageH: number,
  hole: Box,
  threshold = INK_THRESHOLD,
  gapPt = 3,
  maxExpandPt = 30,
): { bbox: Box; inkPx: number } | null {
  const sx = img.width / pageW;
  const sy = img.height / pageH;
  const EPS = 1e-9;
  const x0 = clamp(Math.floor(hole[0] * sx + EPS), 0, img.width - 1);
  const x1 = clamp(Math.ceil(hole[2] * sx - EPS), 0, img.width - 1);
  const rowInk = (y: number): number => {
    let c = 0;
    const base = y * img.width;
    for (let x = x0; x <= x1; x++) if (img.data[base + x]! < threshold) c++;
    return c;
  };
  const y0 = clamp(Math.floor(hole[1] * sy + EPS), 0, img.height - 1);
  const y1 = clamp(Math.ceil(hole[3] * sy - EPS), 0, img.height - 1);
  const gapPx = Math.max(1, Math.round(gapPt * sy));
  const maxPx = Math.max(1, Math.round(maxExpandPt * sy));
  let top = y0;
  let blank = 0;
  for (let y = y0 - 1; y >= 0 && y0 - y <= maxPx; y--) {
    if (rowInk(y) > 0) {
      top = y;
      blank = 0;
    } else if (++blank >= gapPx) break;
  }
  let bot = y1;
  let blank2 = 0;
  for (let y = y1 + 1; y < img.height && y - y1 <= maxPx; y++) {
    if (rowInk(y) > 0) {
      bot = y;
      blank2 = 0;
    } else if (++blank2 >= gapPx) break;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let inkPx = 0;
  for (let y = top; y <= bot; y++) {
    const base = y * img.width;
    for (let x = x0; x <= x1; x++) {
      if (img.data[base + x]! >= threshold) continue;
      inkPx++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (!inkPx) return null;
  return { bbox: [minX / sx, top / sy, (maxX + 1) / sx, (bot + 1) / sy], inkPx };
}

export interface Fit {
  bboxW: number;
  inkW: number;
  /** bbox 宽 / 块内真实墨迹宽；>1 即膨胀 */
  inflation: number;
  /** bbox 中心 − 墨迹中心（pt） */
  dx: number;
  dy: number;
  inkPx: number;
}

/** 被检验对象（MinerU 块 bbox）与块内真实墨迹的吻合度。纯函数。 */
export function bboxFit(
  img: GrayImage,
  pageW: number,
  pageH: number,
  bbox: Box,
  threshold = INK_THRESHOLD,
): Fit | null {
  const e = inkExtent(img, pageW, pageH, bbox, threshold);
  if (!e.bbox) return null;
  const bw = bbox[2] - bbox[0];
  const iw = e.bbox[2] - e.bbox[0];
  if (!(bw > 0 && iw > 0)) return null;
  return {
    bboxW: round(bw),
    inkW: round(iw),
    inflation: round(bw / iw),
    dx: round((bbox[0] + bbox[2] - e.bbox[0] - e.bbox[2]) / 2),
    dy: round((bbox[1] + bbox[3] - e.bbox[1] - e.bbox[3]) / 2),
    inkPx: e.inkPx,
  };
}

export const THRESHOLDS = {
  /** 洞内墨迹像素下限：低于它视为「洞里其实没字」 */
  minHoleInkPx: 20,
  /** 洞宽 / 同栏同行墨迹宽 低于它视为残片 */
  fragmentRatio: 0.5,
  /** bbox 膨胀报警线 */
  inflationAlert: 1.4,
} as const;
// ⚠️ 故意**不**把逐块 dx 当判据：`bboxFit` 的 dx 是相对「框内墨迹」算的，
// bbox 一平移就把一半墨迹裁到框外 ⇒ dx 系统性偏小（实测 10pt 平移只报 5pt）。
// 位移改由 `bestVerticalShift` 在**整页坐标系**层面量，口径独立且可反向验证。

export type Thresholds = { -readonly [K in keyof typeof THRESHOLDS]: number };
export type Verdict = "FAKE" | "FRAGMENT" | "REAL";

export interface BlockFit extends Fit {
  /** 来源层：`uncovered` 用 blocks∪raw∪discarded 定义，判膨胀必须同源，否则会漏块 */
  src: "blocks" | "raw" | "discarded";
  type: string;
  bbox: Box;
  text: string;
}

export interface MeasuredHole {
  page: number;
  hole: number;
  bbox: Box;
  holeW: number;
  holeInkPx: number;
  band: Box;
  bandInk: Box | null;
  bandInkPx: number;
  /** 洞宽 / 行墨迹宽；null = 行内无墨，无法比 */
  holeToBandWidth: number | null;
  /** 洞内墨迹 / 该真实行墨迹；越小说明该行大部分已被别的 bbox 覆盖 */
  inkShare: number | null;
  /** 同栏、与行带 y 重叠的全部 raw 块及其吻合度（可核对记录，不只留最差一个） */
  blocks: BlockFit[];
  worst: BlockFit | null;
  verdict: Verdict;
  reasons: string[];
}

/** 判定与测量分离：纯数据进、纯判定出 ⇒ 可用夹具反向验证判据不是死门。 */
export function classifyHole(
  m: Pick<MeasuredHole, "holeW" | "holeInkPx" | "bandInk" | "holeToBandWidth" | "inkShare" | "worst">,
  t: Thresholds = THRESHOLDS,
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  if (m.holeInkPx < t.minHoleInkPx) {
    reasons.push(`洞内墨迹 ${m.holeInkPx}px < ${t.minHoleInkPx}px`);
    return { verdict: "FAKE", reasons };
  }
  const narrow = m.holeToBandWidth !== null && m.holeToBandWidth < t.fragmentRatio;
  const lowShare = m.inkShare !== null && m.inkShare < t.fragmentRatio;
  const small = narrow || lowShare;
  const badBlock = m.worst !== null && m.worst.inflation >= t.inflationAlert;
  if (small && badBlock && m.worst) {
    reasons.push(
      narrow ? `洞宽/行墨迹宽 ${m.holeToBandWidth} < ${t.fragmentRatio}` : `洞内墨迹仅占该行 ${m.inkShare}`,
      `同源最差块 src=${m.worst.src} type=${m.worst.type} inflation=${m.worst.inflation} bbox=${JSON.stringify(m.worst.bbox)}`,
    );
    return { verdict: "FRAGMENT", reasons };
  }
  if (small) reasons.push(`洞只占该行一部分（宽比 ${m.holeToBandWidth} / 墨迹占比 ${m.inkShare}），但同栏无膨胀块`);
  if (!m.bandInk) reasons.push("行带内无墨迹（bandInk=null），只按洞内墨迹判 REAL");
  return { verdict: "REAL", reasons };
}

/** 洞发现：与 `ocr-page-fill-jobs.ts` 的 holesOf 同源（uncovered content + 宽高比 ≥1.5）。 */
export function holesOf(page: { uncovered?: { kind: string; bbox: Box }[] }): Box[] {
  return (page.uncovered ?? [])
    .filter((r) => {
      if (r.kind !== "content") return false;
      const w = r.bbox[2] - r.bbox[0];
      const h = r.bbox[3] - r.bbox[1];
      return h > 0 && w / h >= 1.5;
    })
    .map((r) => r.bbox);
}

export interface AlignResult {
  /** 搜索半宽（pt）；限制在半行距内，避免「错一行」伪对齐 */
  range: number;
  /** 使 V3 行框内墨迹像素最多的纵向平移（pt） */
  bestDy: number;
  baselineInkPx: number;
  bestInkPx: number;
  /** 相对 dy=0 的增益（%） */
  gainPct: number;
  lineCount: number;
  curve: { dy: number; inkPx: number }[];
}

/**
 * V3 行框（norm 0..1）与**原卷墨迹**的最佳纵向平移。纯函数，合成图可反向验证。
 * 若 bestDy 显著 ≠0，说明 `norm × pageH` 这一落位口径本身带系统偏移，
 * 几何匹配的「行框盖住洞 ≥0.6」自然达不到——而不是洞是假的。
 */
export function bestVerticalShift(
  img: GrayImage,
  pageW: number,
  pageH: number,
  normLines: { norm: Box; text?: string }[],
  range = 8,
  threshold = INK_THRESHOLD,
): AlignResult {
  // ⚠️ 为什么默认 ±8pt：本卷行距 ~19pt、行高 ~11pt。若搜索范围放宽到一个行距，
  // 「行框整组挪到相邻行」也会让框内墨迹变多 ⇒ 出现 −18pt 之类的假峰（p74 实测
  // 全范围最佳 −18，但 ±8 内最佳 −1、增益仅 0.04%）。半行距内才是真正的对齐修正。
  const rows = normLines.filter((l) => Array.isArray(l.norm) && String(l.text ?? "").trim());
  const curve: { dy: number; inkPx: number }[] = [];
  for (let dy = -range; dy <= range; dy++) {
    let inkPx = 0;
    for (const l of rows) {
      const b: Box = [
        l.norm[0] * pageW,
        l.norm[1] * pageH + dy,
        l.norm[2] * pageW,
        l.norm[3] * pageH + dy,
      ];
      inkPx += inkExtent(img, pageW, pageH, b, threshold).inkPx;
    }
    curve.push({ dy, inkPx });
  }
  const baselineInkPx = curve[range]?.inkPx ?? 0;
  const maxInkPx = Math.max(...curve.map((c) => c.inkPx));
  const plateau = curve.filter((c) => c.inkPx === maxInkPx).map((c) => c.dy);
  // 行框常比墨带高 1px ⇒ 最优平移会出现 1–2pt 并列平台。取平台中心而不是
  // 「谁先出现谁赢」，否则估计会系统性偏小 1pt（单测 bestVerticalShift 抓到过）。
  const bestDy = plateau.length
    ? Math.round(plateau.reduce((a, b) => a + b, 0) / plateau.length) || 0 // || 0 把 -0 归一，避免 JSON/Object.is 语义坑
    : 0;
  return {
    range,
    bestDy,
    baselineInkPx,
    bestInkPx: maxInkPx,
    gainPct: baselineInkPx > 0 ? round(((maxInkPx - baselineInkPx) / baselineInkPx) * 100) : 0,
    lineCount: rows.length,
    curve,
  };
}

export interface PageResult {
  page: number;
  pageW: number;
  pageH: number;
  imageW: number;
  imageH: number;
  holes: MeasuredHole[];
  /** 仅当该页存在 `ocr-jobs-cache/pNN.json` 时有值 */
  align?: AlignResult;
}

/** 单页测量。图像来自原卷，块来自 stages（被检验对象），两者不互相当裁判。 */
export function measurePage(
  img: GrayImage,
  page: {
    index: number;
    width: number;
    height: number;
    /** 三源并集才是 `uncovered` 的框集（见 export-stages.ts 的 computeInkCoverage） */
    blocks?: { type?: string; bbox: Box; text?: string }[];
    raw?: { type?: string; bbox: Box; text?: string }[];
    discarded?: { type?: string; bbox: Box; text?: string }[];
    uncovered?: { kind: string; bbox: Box }[];
  },
  threshold = INK_THRESHOLD,
  t: Thresholds = THRESHOLDS,
): PageResult {
  const pageW = page.width;
  const pageH = page.height;
  const mid = pageW / 2;
  const holes = holesOf(page);
  const measured: MeasuredHole[] = holes.map((bbox, hi) => {
    const w = bbox[2] - bbox[0];
    const h = bbox[3] - bbox[1];
    const left = (bbox[0] + bbox[2]) / 2 < mid;
    // 用「墨迹投影切行」定位洞所在的**真实单行**（复用 ink-lines.ts）。
    // 旧口径「洞高×1.5 窗口内的全部墨迹」会跨行，把相邻行算进来 ⇒ 洞/行宽、墨迹占比全虚高
    // （2026-11-05 首版踩过，见报告 §5/§6）。
    const bandE = inkLineAround(img, pageW, pageH, bbox, threshold) ?? { bbox: null as Box | null, inkPx: 0 };
    /** 行 bbox；找不到墨迹行时退回洞自身（后续按洞筛块） */
    const band: Box = bandE.bbox ?? bbox;
    const holeE = inkExtent(img, pageW, pageH, bbox, threshold);
    const bandW = bandE.bbox ? bandE.bbox[2] - bandE.bbox[0] : 0;
    const holeToBandWidth = bandW > 0 ? round(w / bandW) : null;
    /** 洞内墨迹占「该真实行」墨迹的比例；越小说明该行越大部分已被别的 bbox 覆盖 */
    const inkShare = bandE.inkPx > 0 ? round(holeE.inkPx / bandE.inkPx) : null;

    const candidates: BlockFit[] = [];
    // ⚠️ 必须用 uncovered 的同源框集（blocks ∪ raw ∪ discarded）。只量 raw 会漏掉
    // 230pt 级的膨胀块（2026-11-05 首版就踩了这个坑，把结论做反了——见报告 §5）。
    for (const [src, arr] of [
      ["blocks", page.blocks],
      ["raw", page.raw],
      ["discarded", page.discarded],
    ] as const) {
      for (const b of arr ?? []) {
        if (!Array.isArray(b.bbox)) continue;
        const bb = b.bbox;
        if (bb[3] < band[1] || bb[1] > band[3]) continue; // y 不与行带重叠
        if (((bb[0] + bb[2]) / 2 < mid) !== left) continue; // 不同栏（显式括号，别让优先级读错）
        const f = bboxFit(img, pageW, pageH, bb, threshold);
        if (f) candidates.push({ ...f, src, type: b.type ?? "?", bbox: bb, text: String(b.text ?? "").slice(0, 24) });
      }
    }
    // 「最差」= 膨胀最大；同膨胀取 |dx| 最大。只记录、不过滤。
    candidates.sort((a, z) => z.inflation - a.inflation || Math.abs(z.dx) - Math.abs(a.dx));
    const worst = candidates[0] ?? null;
    const base = {
      page: page.index,
      hole: hi,
      bbox,
      holeW: round(w),
      holeInkPx: holeE.inkPx,
      band,
      bandInk: bandE.bbox,
      bandInkPx: bandE.inkPx,
      holeToBandWidth,
      inkShare,
      blocks: candidates,
      worst,
    };
    const { verdict, reasons } = classifyHole(base, t);
    return { ...base, verdict, reasons };
  });
  return {
    page: page.index,
    pageW,
    pageH,
    imageW: img.width,
    imageH: img.height,
    holes: measured,
  };
}

function parseArgs(argv: string[]): { doc: string; pages: number[] | "all"; out: string; threshold: number; sensitivity: boolean; alignRange: number } {
  const get = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
  };
  const doc = get("--doc", "答案册-合订本");
  const raw = get("--pages", "74,91,150,159");
  const pages: number[] | "all" = raw === "all" ? "all" : raw.split(",").map(Number).filter(Number.isFinite);
  return {
    doc,
    pages,
    out: get("--out", join(ROOT, "data/out", doc, "hole-geometry.json")),
    threshold: Number(get("--threshold", String(INK_THRESHOLD))),
    sensitivity: argv.includes("--sensitivity"),
    alignRange: Number(get("--align-range", "8")),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const docDir = join(ROOT, "data/out", args.doc);
  const stagesPath = join(docDir, "stages.json");
  const pdfPath = join(docDir, "origin.pdf");
  if (!existsSync(stagesPath) || !existsSync(pdfPath)) {
    throw new Error(`缺输入：${stagesPath} 或 ${pdfPath}（本脚本只读，不生成产物）`);
  }
  const stages = JSON.parse(readFileSync(stagesPath, "utf8")) as {
    pages: { index: number; width: number; height: number; raw?: { type?: string; bbox: Box; text?: string }[]; uncovered?: { kind: string; bbox: Box }[] }[];
  };

  const pageNos = args.pages === "all"
    ? stages.pages.filter((p) => holesOf(p).length > 0).map((p) => p.index)
    : args.pages;
  const results: PageResult[] = [];
  for (const n of pageNos) {
    const p = stages.pages[n];
    if (!p) throw new Error(`页 ${n} 不在 stages.json（共 ${stages.pages.length} 页）`);
    const img = renderGrayPage(pdfPath, n + 1);
    const r = measurePage(img, p, args.threshold);
    const cachePath = join(docDir, "ocr-jobs-cache", `p${n}.json`);
    if (existsSync(cachePath)) {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as { lines?: { norm: Box; text?: string }[] };
      if (c.lines?.length) r.align = bestVerticalShift(img, p.width, p.height, c.lines, args.alignRange, args.threshold);
    }
    results.push(r);
  }

  const counts = { FAKE: 0, FRAGMENT: 0, REAL: 0 };
  for (const r of results) for (const h of r.holes) counts[h.verdict]++;
  const payload = {
    doc: args.doc,
    threshold: args.threshold,
    thresholds: THRESHOLDS,
    alignRange: args.alignRange,
    pages: pageNos,
    pageCount: pageNos.length,
    holeCount: counts.FAKE + counts.FRAGMENT + counts.REAL,
    counts,
    alignment: results.filter((r) => r.align).map((r) => ({
      page: r.page,
      bestDy: r.align!.bestDy,
      gainPct: r.align!.gainPct,
      baselineInkPx: r.align!.baselineInkPx,
      bestInkPx: r.align!.bestInkPx,
      lineCount: r.align!.lineCount,
    })),
    results,
  };
  writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`\n=== 洞几何核查 · ${args.doc} · ${pageNos.length} 页 / ${payload.holeCount} 洞 ===`);
  console.log(`独立来源：origin.pdf 灰度像素（threshold=${args.threshold}）；bbox 仅为被检验对象`);
  if (pageNos.length <= 8) {
    console.log(`页  洞  holeW  洞墨px  行墨宽  洞/行   最差块(膨胀/dx/type)      判定`);
    for (const r of results) {
      for (const h of r.holes) {
        const bw = h.bandInk ? round(h.bandInk[2] - h.bandInk[0]) : 0;
        const worst = h.worst ? `${h.worst.inflation}/${h.worst.src}/${h.worst.type}` : "—";
        console.log(
          `${String(r.page).padStart(3)} ${String(h.hole).padStart(2)} ${String(h.holeW).padStart(7)} ` +
          `${String(h.holeInkPx).padStart(7)} ${String(bw).padStart(7)} ${String(h.holeToBandWidth ?? "—").padStart(6)}  ` +
          `${worst.padEnd(24)} ${h.verdict}`,
        );
      }
    }
  }
  console.log(`合计：FAKE ${counts.FAKE} / FRAGMENT ${counts.FRAGMENT} / REAL ${counts.REAL}`);
  const inflations = results.flatMap((r) => r.holes.flatMap((h) => h.blocks.map((b) => b.inflation)));
  if (inflations.length) {
    console.log(
      `同栏块 inflation：min ${Math.min(...inflations)} / max ${Math.max(...inflations)} / ` +
      `≥${THRESHOLDS.inflationAlert} 的 ${inflations.filter((v) => v >= THRESHOLDS.inflationAlert).length} 块（共 ${inflations.length} 块）`,
    );
  }
  if (payload.alignment.length) {
    console.log(`V3 行框 ↔ 原卷墨迹 对齐互相关（搜索 ±${args.alignRange}pt；bestDy≠0 ⇒ 落位口径带系统偏移）：`);
    for (const a of payload.alignment) {
      console.log(
        `  p${a.page}: bestDy ${a.bestDy >= 0 ? "+" : ""}${a.bestDy}pt  ` +
        `墨迹 ${a.baselineInkPx}→${a.bestInkPx}px (+${a.gainPct}%)  ${a.lineCount} 行`,
      );
    }
  }
  console.log(`明细 → ${args.out}`);

  if (args.sensitivity) {
    console.log("\n=== 阈值敏感性（±20%，看判定是否翻转）===");
    for (const k of [0.8, 1, 1.2]) {
      const t: Thresholds = {
        minHoleInkPx: Math.round(THRESHOLDS.minHoleInkPx * k),
        fragmentRatio: round(THRESHOLDS.fragmentRatio * k),
        inflationAlert: round(THRESHOLDS.inflationAlert * k),
      };
      const c = { FAKE: 0, FRAGMENT: 0, REAL: 0 };
      for (const r of results) for (const h of r.holes) c[classifyHole(h, t).verdict]++;
      console.log(`  ×${k}: FAKE ${c.FAKE} / FRAGMENT ${c.FRAGMENT} / REAL ${c.REAL}  ${JSON.stringify(t)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  try {
    main();
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
