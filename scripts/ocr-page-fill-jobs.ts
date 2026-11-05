// scripts/ocr-page-fill-jobs.ts
/**
 * 整页补行 · **直连作业接口引擎**（B-28 批次 1 对照引擎；不进 `npm run check`、不接 daily）。
 *
 * 与 MCP 版（`scripts/ocr-page-fill.ts`）的差异只在「OCR 从哪来、文本怎么落位」，判据同阈值：
 * - MCP 版：整页图 → MCP 只回 markdown（无坐标）→ 解析块当锚点、片段按洞宽**摊字符**落位（位置是猜的）。
 * - 本文件：整页图 → PP-StructureV3 作业接口回**行级框**（rec_polys/rec_texts/rec_scores）→
 *   行框 `norm`(0..1) × stages 页宽高落回 pt 域（pdftoppm PNG 与 stages 页面同宽高比），
 *   与洞（stages pt 域）直接做几何匹配（L2 最严 AND，SPEC §4）：
 *   `重叠面积/洞面积 ≥ 0.6`（行框**盖住**洞）**且** 列一致（行与洞的 x0 同侧）**且** 行 ≥2 硬字符。
 *   ⚠️ 分母与 SPEC §4 的「/行框面积」**不同**（用户 2026-11-05 批准改洞面积）：实测（答案册 4 页 14 洞）
 *   V3 行框是**整行视觉行**、MinerU 洞是行内**未覆盖碎片**，行框比洞高 1.4–1.7 倍 ⇒
 *   「/行框面积」对真配对的上限只有 0.33–0.59，0.6 阈值字面跑出 0 候选；「/洞面积」下真配对 0.67–0.99。
 *   行按 y0 排序遍历、每行只归**重叠最大**的洞；一行多洞只取最大者、其余洞记 `lineMultiHole`
 *   冲突（不猜，方案 §11.2 教训）；一洞多行按 y 序拼进同一候选。
 *
 * 判据与 MCP 路径同阈值（A/B 可比）：text 非空 + `$` 成对 + ratio ∈ [0.45,1.9] + 洞期望字数 ≥1.6
 * + 裁图路径交叉核对；`rec_score` 只记录不过滤（检测不改写）。
 *
 * 批次 2（`--formula`，默认关）：公式碎片 V3 不放行级文本（进 `formula_res_list`）⇒ 公式洞行级无框可配
 * （实测 p150 三洞全空即此）。开启后对**无行命中**的洞用公式框（norm→pt）做同款几何匹配
 * （盖住洞 ≥0.6 + 列一致），候选 text=LaTeX **原样**（不清洗公式串），只两道门：
 * 匹配几何 + 洞大小（expected ≥1.6）；宽度比 / `$` 成对对 LaTeX 原串意义有限 ⇒ 只如实记录不拒。
 * 公式候选带 `kind:"formula"`、score 恒 null（作业解析层未取 formula score）；是否让 LaTeX 直进
 * OcrFillItem.text 是产品决策，未定 ⇒ 开关默认关。缓存 v2 同时存行与公式（v1 旧行缓存对
 * --formula 视为未命中，服务端按字节去重 ⇒ 重跑不重算不计费）。
 *
 * 用法：`node --import tsx scripts/ocr-page-fill-jobs.ts <docId> [--pages 74,91] [--force]`
 *   ⚠️ `--pages` 页号与产物 JSON 的 `page` 字段同口径（**0 基 p.index**；MCP 版 CLI 是 1 基，
 *   勿混 —— B-30 第一轮就是页序口径错位把整轮读数作废的）。
 * 产物：`data/out/<doc>/ocr-page-fill-jobs.json`（独立文件，**不覆盖** MCP 的 ocr-page-fill.json）。
 * 缓存：`data/out/<doc>/ocr-jobs-cache/pNN.png` + `pNN.json`（行级数组）；`--force` 绕过本地行缓存。
 *   PNG 只在缺失时渲染一次（不重渲染 ⇒ 字节稳定）；服务端按 (PNG 字节 + options) 去重，
 *   同字节重跑不重算不计费（`scripts/paddle-client.ts` 头注坑 2）。
 * 凭据：env `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`，或 `~/.workbuddy-ai/mcp.json`。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emWidthOf } from "../stages/font-metrics.js";
import { medianLineHeightPt } from "./ocr-lib.js";
import { overlapArea, parseDocParsingJsonl, runJob, type Box, type PaddleLine } from "./paddle-client.js";

/** 公式区域（`formula_res_list[]` 归一化形态，见 `PaddlePage.formulas`；解析层未取 formula score）。 */
type PaddleFormula = { latex: string; bbox: Box | null; norm: Box | null };

const MODEL = "PP-StructureV3" as const;
/** SPEC 参数面基线（盘点 §4.2 分档表）：补行只需文本；图表 HTML / 改写 / 公式编号都是噪声，显式关。 */
const JOB_OPTIONS = { useChartRecognition: false, prettifyMarkdown: false, showFormulaNumber: false };

const TARGET_PX_W = 1300; // 与 MCP 路径同口径（A/B 同输入对齐）
const MIN_DPI = 72;
const MAX_DPI = 200;
const PAD_X = 8; // 渲染/窗口外扩，与裁图路径同一套视觉口径
const PAD_Y = 3;
const RATIO_MIN = 0.45;
const RATIO_MAX = 1.9;
const MIN_EXPECT_CHARS = 1.6;
/** 行→洞：重叠面积/**洞**面积 下限（行框盖住洞的比例；阈值 0.6 同 SPEC，分母经实测修订见文件头）。 */
const LINE_HOLE_OVERLAP_MIN = 0.6;
/** 裁图↔整页交叉核对的一致度下限（同 `ocr-page-fill.ts`）。 */
const DICE_MIN = 0.34;

export interface OcrFillItem {
  bbox: Box;
  win: Box;
  text: string;
  raw: string;
  crop: string;
  ratio: number;
  accepted: boolean;
  source: "page";
  engine: "jobs";
  /** 匹配行的最小 rec_score；只记录不过滤。公式候选恒为 null（解析层未取 formula score）。 */
  score: number | null;
  /** 批次 2：公式候选标记（行级候选不设此字段）。 */
  kind?: "formula";
  reason?: string;
  /** lineMultiHole：该洞曾与别的洞争同一行、行归了重叠更大者（可核对记录，不猜）。 */
  conflict?: string;
}

/** 硬字符数 = 去掉空白与 LaTeX 记号 `$ \ { }` 后所剩（与 `ocr-page-fill.ts:hardNorm` 同口径）。 */
export function hardChars(s: string): number {
  return s.replace(/[\s$\\{}]/g, "").length;
}

/** 洞发现：与 MCP 路径同源（SPEC §4）—— uncovered content 且宽/高 ≥ 1.5。 */
export function holesOf(page: any): Box[] {
  return (page.uncovered ?? [])
    .filter((r: any) => {
      if (r.kind !== "content") return false;
      const w = r.bbox[2] - r.bbox[0];
      const h = r.bbox[3] - r.bbox[1];
      return h > 0 && w / h >= 1.5;
    })
    .map((r: any) => r.bbox as Box);
}

export interface MatchResult {
  /** 全部非空行按 y0 序（fullText 用）。 */
  orderedLines: PaddleLine[];
  /** 每个洞名下的行（遍历序即 y0 序 ⇒ 拼接顺序正确）。 */
  holeLines: PaddleLine[][];
  /** 每个洞的 lineMultiHole 冲突记录（行被重叠更大者取走时记在这里，不猜）。 */
  conflicts: (string | null)[];
}

/**
 * 行→洞匹配（L2 最严 AND）。行按 y0 排序遍历；重叠/**洞**面积 ≥ 0.6（行框盖住洞）且列一致且 ≥2 硬字符。
 * 「重叠最大」按**覆盖率**（重叠/该洞面积）排序——行归「它盖得最完整」的洞，与门控同一把尺。
 * 注：分母换成洞面积后，一行同时压中多个洞不再罕见（相邻两洞都被同一行盖满是正常现象），
 * lineMultiHole 冲突记录因此是**常态防线**而非纯防御 —— 只取覆盖率最大者，其余不猜。
 */
export function matchLinesToHoles(lines: PaddleLine[], holes: Box[], pageW: number, pageH: number): MatchResult {
  const holeLines: PaddleLine[][] = holes.map(() => []);
  const conflicts: (string | null)[] = holes.map(() => null);
  const mid = pageW / 2;
  const orderedLines = lines
    .filter((l): l is PaddleLine & { norm: Box } => !!l.norm && !!l.text.trim())
    .sort((a, b) => a.norm[1] - b.norm[1]);
  for (const l of orderedLines) {
    if (hardChars(l.text) < 2) continue; // 单字行无法核对，不参与落位
    const lb: Box = [l.norm[0] * pageW, l.norm[1] * pageH, l.norm[2] * pageW, l.norm[3] * pageH];
    const la = Math.max(0, (lb[2] - lb[0]) * (lb[3] - lb[1]));
    if (!(la > 0)) continue;
    const cands: { i: number; cov: number }[] = [];
    holes.forEach((hb, i) => {
      if ((lb[0] < mid) !== (hb[0] < mid)) return; // 列一致：行与洞的 x0 同侧
      const ha = Math.max(0, (hb[2] - hb[0]) * (hb[3] - hb[1]));
      if (!(ha > 0)) return;
      const cov = overlapArea(lb, hb) / ha; // 行框盖住洞的比例（分母=洞面积，2026-11-05 实测修订）
      if (cov >= LINE_HOLE_OVERLAP_MIN) cands.push({ i, cov });
    });
    if (!cands.length) continue;
    cands.sort((a, b) => b.cov - a.cov);
    holeLines[cands[0]!.i]!.push(l);
    if (cands.length > 1) {
      const note =
        `lineMultiHole：行「${l.text.trim().slice(0, 18)}」同时压中 ${cands.length} 个洞，` +
        `归重叠最大者 #${cands[0]!.i}，其余 {${cands.slice(1).map((c) => c.i).join(",")}} 不猜`;
      for (const c of cands.slice(1)) conflicts[c.i] ??= note;
    }
  }
  return { orderedLines, holeLines, conflicts };
}

export interface Judgement {
  expected: number;
  ratio: number;
  balanced: boolean;
  agree: boolean;
  ok: boolean;
  reason?: string;
}

/**
 * 判据（与 MCP 路径同阈值，SPEC §4）：text 非空 + `$` 成对 + ratio∈[0.45,1.9]（洞宽/(em×字号)）
 * + 洞期望字数（洞宽/字号）≥1.6 + 裁图交叉核对（两独立路径明显矛盾 ⇒ 宁可不补）。
 */
export function judgeHole(holeW: number, fontPt: number, text: string, cropText: string): Judgement {
  const expected = fontPt > 0 ? holeW / fontPt : 0;
  const emW = emWidthOf(text);
  const ratio = emW > 0 && fontPt > 0 ? holeW / (emW * fontPt) : 0;
  const balanced = (text.match(/\$/g) ?? []).length % 2 === 0;
  const agree = !cropText || dice(cropText, text) >= DICE_MIN;
  const ok =
    text.length > 0 && expected >= MIN_EXPECT_CHARS && balanced && agree && ratio >= RATIO_MIN && ratio <= RATIO_MAX;
  const reason = ok
    ? undefined
    : !text
      ? "无行压中此洞"
      : expected < MIN_EXPECT_CHARS
        ? `洞太小（期望 ${expected.toFixed(1)} 字 < ${MIN_EXPECT_CHARS}）`
        : !balanced
          ? "公式被切断（$ 不成对）"
          : !agree
            ? `与裁图结果不一致（裁图=${JSON.stringify(cropText.slice(0, 20))}）`
            : `宽度比 ${ratio.toFixed(2)} 越界`;
  return { expected, ratio, balanced, agree, ok, reason };
}

export interface FormulaMatchResult {
  /** 每个洞名下的公式（遍历序即 y0 序 ⇒ 拼接顺序正确）。 */
  holeFormulas: { latex: string; box: Box }[][];
  /** 公式与多个洞争抢时的冲突记录（同 lineMultiHole 语义，不猜）。 */
  conflicts: (string | null)[];
}

/**
 * 公式框→洞匹配（批次 2，`--formula`）：与行匹配同款几何（**盖住洞** ≥0.6 + 列一致），
 * 但**无硬字符门槛**（LaTeX 记号会被 hardChars 剥没）、无 hardNorm 类清洗 —— LaTeX 原样保留。
 * 公式按 y0 排序遍历；一行多洞同款语义：只归覆盖率最大者，其余记冲突。
 */
export function matchFormulasToHoles(
  formulas: PaddleFormula[],
  holes: Box[],
  pageW: number,
  pageH: number,
): FormulaMatchResult {
  const holeFormulas: { latex: string; box: Box }[][] = holes.map(() => []);
  const conflicts: (string | null)[] = holes.map(() => null);
  const mid = pageW / 2;
  const rows = formulas
    .filter((f): f is PaddleFormula & { norm: Box } => !!f.norm && !!f.latex.trim())
    .map((f) => ({ latex: f.latex.trim(), box: [f.norm[0] * pageW, f.norm[1] * pageH, f.norm[2] * pageW, f.norm[3] * pageH] as Box }))
    .sort((a, b) => a.box[1] - b.box[1]);
  for (const f of rows) {
    const cands: { i: number; cov: number }[] = [];
    holes.forEach((hb, i) => {
      if ((f.box[0] < mid) !== (hb[0] < mid)) return; // 列一致
      const ha = Math.max(0, (hb[2] - hb[0]) * (hb[3] - hb[1]));
      if (!(ha > 0)) return;
      const cov = overlapArea(f.box, hb) / ha;
      if (cov >= LINE_HOLE_OVERLAP_MIN) cands.push({ i, cov });
    });
    if (!cands.length) continue;
    cands.sort((a, b) => b.cov - a.cov);
    holeFormulas[cands[0]!.i]!.push(f);
    if (cands.length > 1) {
      const note =
        `lineMultiHole：公式「${f.latex.slice(0, 18)}」同时压中 ${cands.length} 个洞，` +
        `归覆盖率最大者 #${cands[0]!.i}，其余 {${cands.slice(1).map((c) => c.i).join(",")}} 不猜`;
      for (const c of cands.slice(1)) conflicts[c.i] ??= note;
    }
  }
  return { holeFormulas, conflicts };
}

export interface FormulaJudgement {
  expected: number;
  ok: boolean;
  reason?: string;
}

/**
 * 公式候选判据（批次 2）：**只两道门** —— 匹配几何（matchFormulasToHoles 已过）+ 洞大小。
 * 宽度比 / `$` 成对对 LaTeX 原串意义有限（rec_formula 是完整公式、emWidthOf 对二维排版不成立）
 * ⇒ 不据此拒，只在候选的 ratio/文本里如实记录（检测不改写）。
 */
export function judgeFormulaHole(holeW: number, fontPt: number): FormulaJudgement {
  const expected = fontPt > 0 ? holeW / fontPt : 0;
  const ok = expected >= MIN_EXPECT_CHARS;
  return { expected, ok, reason: ok ? undefined : `洞太小（期望 ${expected.toFixed(1)} 字 < ${MIN_EXPECT_CHARS}）` };
}

/** 字符 bigram Dice 一致度（与 `ocr-page-fill.ts` 同式）。 */
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

/** 裁图路径（`ocr-fill.json`）对同洞给过的文本；没有这份产物就返回空表 ⇒ 交叉核对自动放行。 */
function loadCropTexts(outDir: string): Map<string, string> {
  const m = new Map<string, string>();
  const f = join(outDir, "ocr-fill.json");
  if (!existsSync(f)) return m;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { pages?: { items?: { bbox: number[]; text?: string }[] }[] };
    for (const pg of j.pages ?? []) {
      for (const it of pg.items ?? []) {
        if (it.text) m.set(it.bbox.map((v) => Math.round(v)).join(","), it.text);
      }
    }
  } catch {
    /* 读不动就不做交叉核对 */
  }
  return m;
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const DOC = process.argv[2] ?? "答案册-合订本";
  const pagesArgIdx = process.argv.indexOf("--pages");
  const PAGES: Set<number> | null =
    pagesArgIdx >= 0 ? new Set(process.argv[pagesArgIdx + 1]!.split(",").map((x) => Number(x.trim()))) : null;
  const FORCE = process.argv.includes("--force");
  const FORMULA = process.argv.includes("--formula"); // 批次 2：公式洞补全（默认关，产品决策未定）
  const OUT_DIR = join("data", "out", DOC);
  const PDF = join(OUT_DIR, "origin.pdf");
  const CACHE_DIR = join(OUT_DIR, "ocr-jobs-cache");
  const OUT_JSON = join(OUT_DIR, "ocr-page-fill-jobs.json");
  if (!existsSync(PDF)) {
    console.error(`缺少 ${PDF}（先 npm run stages:export）`);
    process.exit(2);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`页号口径：--pages 与产物 page 字段一致（0 基 p.index）；模型 ${MODEL} options=${JSON.stringify(JOB_OPTIONS)}`);
  const snap = JSON.parse(readFileSync(join(OUT_DIR, "stages.json"), "utf8"));
  const cropByBbox = loadCropTexts(OUT_DIR);

  // 局部重跑（--pages）时保留未跑页的旧结果（与 MCP 路径同行为）。
  const prev: { page: number; fullText: string; items: OcrFillItem[] }[] = [];
  if (PAGES && existsSync(OUT_JSON)) {
    try {
      prev.push(...(JSON.parse(readFileSync(OUT_JSON, "utf8")).pages ?? []));
    } catch {
      /* 旧文件坏了就重来 */
    }
  }
  const keep = prev.filter((x) => !PAGES?.has(x.page));
  const outPages: { page: number; fullText: string; items: OcrFillItem[] }[] = [...keep];
  let totalHoles = 0;
  let totalAccepted = 0;

  for (const p of snap.pages) {
    const pno: number = p.index;
    if (PAGES && !PAGES.has(pno)) continue;
    const holes = holesOf(p);
    if (!holes.length) continue;
    totalHoles += holes.length;

    /* ① 整页渲染（与 MCP 路径同口径：目标宽 1300px，DPI 夹 [72,200]；只在缺图时渲染一次） */
    const stem = `p${String(pno).padStart(2, "0")}`;
    const pngPath = join(CACHE_DIR, `${stem}.png`);
    if (!existsSync(pngPath)) {
      const dpi = Math.max(MIN_DPI, Math.min(MAX_DPI, Math.round((72 * TARGET_PX_W) / p.width)));
      const prefix = join(CACHE_DIR, `${stem}-r1`);
      execFileSync(
        "pdftoppm",
        ["-r", String(dpi), "-f", String(pno + 1), "-l", String(pno + 1), "-png", PDF, prefix],
        { stdio: "ignore" },
      );
      // ⚠️ pdftoppm 会自动加页码后缀，按实际产物改名
      const produced = readdirSync(CACHE_DIR)
        .filter((f) => f.startsWith(`${stem}-r1-`) && f.endsWith(".png"))
        .sort()
        .pop();
      if (!produced) {
        console.log(`p${pno} 整页渲染失败，跳过`);
        continue;
      }
      renameSync(join(CACHE_DIR, produced), pngPath);
    }

    /* ② 行级 OCR：本地缓存 v2 = {v:2, lines, formulas}（--force 绕过）；
       服务端按 (PNG 字节+options) 去重 ⇒ 同字节重跑不重算不计费（v1 旧行缓存对 --formula 视为未命中） */
    let lines: PaddleLine[] = [];
    let formulas: PaddleFormula[] = [];
    const cachePath = join(CACHE_DIR, `${stem}.json`);
    let cacheHit = false;
    if (!FORCE && existsSync(cachePath)) {
      try {
        const raw = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
        const isV2 = !Array.isArray(raw) && (raw as { v?: unknown })?.v === 2;
        if (!FORMULA || isV2) {
          lines = (Array.isArray(raw) ? raw : (raw as { lines: PaddleLine[] }).lines) as PaddleLine[];
          formulas = (!Array.isArray(raw) && Array.isArray((raw as { formulas?: PaddleFormula[] }).formulas)
            ? (raw as { formulas: PaddleFormula[] }).formulas
            : []) as PaddleFormula[];
          cacheHit = true;
          console.log(`p${pno} 命中缓存（${lines.length} 行${FORMULA ? ` / ${formulas.length} 公式` : ""}）`);
        }
      } catch {
        /* 坏缓存当没有 */
      }
    }
    if (!cacheHit) {
      const t0 = Date.now();
      const outcome = await runJob({
        model: MODEL,
        filePath: pngPath,
        options: JOB_OPTIONS,
        onProgress: (m) => console.log(`p${pno} ${m}`),
      });
      const page0 = parseDocParsingJsonl(outcome.jsonl)[0];
      lines = page0?.lines ?? [];
      formulas = page0?.formulas ?? [];
      writeFileSync(cachePath, JSON.stringify({ v: 2, lines, formulas }), "utf8");
      console.log(
        `p${pno} ${MODEL} ${(outcome.wallMs / 1000).toFixed(1)}s jobId=${outcome.jobId} sha=${outcome.inputSha256.slice(0, 12)} → ${lines.length} 行 / ${formulas.length} 公式`,
      );
      if (!lines.length && !formulas.length) console.log(`p${pno} ⚠️ 行级与公式结果均为空`);
    }

    /* ③ 行框/公式框 → pt 域 → 洞匹配（L2 最严 AND）；公式只在 --formula 且无行命中时补位 */
    const fontPt = medianLineHeightPt(p.blocks);
    const { orderedLines, holeLines, conflicts } = matchLinesToHoles(lines, holes, p.width, p.height);
    const fm = FORMULA ? matchFormulasToHoles(formulas, holes, p.width, p.height) : null;
    const fullText = orderedLines.map((l) => l.text).join("\n"); // fullText 只记行文，公式不混入

    /* ④ 判据 + 落条（OcrFillItem 同构 + engine/score/kind） */
    const items: OcrFillItem[] = [];
    let acc = 0;
    holes.forEach((bb, i) => {
      const win: Box = [
        Math.max(0, bb[0] - PAD_X),
        Math.max(0, bb[1] - PAD_Y),
        Math.min(p.width, bb[2] + PAD_X),
        bb[3] + PAD_Y,
      ];
      const ls = holeLines[i]!;
      const fms = fm?.holeFormulas[i] ?? [];
      const conflict = conflicts[i] ?? fm?.conflicts[i] ?? null;
      const item: OcrFillItem = {
        bbox: bb, win, text: "", raw: "", crop: pngPath, ratio: 0, accepted: false,
        source: "page", engine: "jobs", score: null,
      };
      let reason: string | undefined;
      let label = "";
      if (ls.length) {
        const text = ls.map((l) => l.text.trim()).filter(Boolean).join(" ");
        const j = judgeHole(bb[2] - bb[0], fontPt, text, cropByBbox.get(bb.map((v) => Math.round(v)).join(",")) ?? "");
        const scores = ls.map((l) => l.score).filter((s): s is number => typeof s === "number");
        item.text = text;
        item.raw = ls.map((l) => l.text).join("\n");
        item.ratio = +j.ratio.toFixed(2);
        item.accepted = j.ok;
        item.score = scores.length ? Math.min(...scores) : null;
        reason = j.ok ? undefined : !text && conflicts[i] ? conflicts[i]! : j.reason;
        if (j.ok) acc++;
        label = `期望${j.expected.toFixed(1)}字 比=${j.ratio.toFixed(2)} score=${item.score === null ? "-" : item.score.toFixed(2)} `;
        console.log(
          `  p${pno} 洞 ${JSON.stringify(bb.map((v) => Math.round(v)))} ${label}${j.ok ? "✓" : "✗"} ${JSON.stringify(text.slice(0, 44))}${j.ok ? "" : ` ← ${reason}`}`,
        );
      } else if (fms.length) {
        // 公式候选（批次 2）：text=LaTeX 原样**不清洗**；只两道门（匹配几何已过 + 洞大小），ratio 只记录不拒
        const text = fms.map((f) => f.latex).join(" ");
        const jf = judgeFormulaHole(bb[2] - bb[0], fontPt);
        const denom = emWidthOf(text) * fontPt; // LaTeX 原串的 em 度量只作记录（对二维排版不成立），不据判
        item.text = text;
        item.raw = fms.map((f) => f.latex).join("\n");
        item.kind = "formula";
        item.ratio = +(denom > 0 ? (bb[2] - bb[0]) / denom : 0).toFixed(2);
        item.accepted = jf.ok;
        reason = jf.reason;
        if (jf.ok) acc++;
        console.log(
          `  p${pno} 洞 ${JSON.stringify(bb.map((v) => Math.round(v)))} 期望${jf.expected.toFixed(1)}字 公式 ${jf.ok ? "✓" : "✗"} ${JSON.stringify(text.slice(0, 44))}${jf.ok ? "" : ` ← ${reason}`}`,
        );
      } else {
        const j = judgeHole(bb[2] - bb[0], fontPt, "", "");
        reason = conflicts[i] ?? j.reason;
        console.log(
          `  p${pno} 洞 ${JSON.stringify(bb.map((v) => Math.round(v)))} 期望${j.expected.toFixed(1)}字 比=0.00 score=- ✗ "" ← ${reason}`,
        );
      }
      if (reason) item.reason = reason;
      if (conflict) item.conflict = conflict;
      items.push(item);
    });
    outPages.push({ page: pno, fullText, items });
    totalAccepted += acc;
  }

  outPages.sort((a, b) => a.page - b.page);
  writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        docId: DOC,
        generatedAt: new Date().toISOString(),
        source: "pp-structurev3-jobs",
        formula: FORMULA, // 批次 2 公式候选开关状态（产物溯源）
        note: "整页 OCR 候选补全（直连作业接口，行框落位）：仅供人工核对，不静默替换引擎文本（G1）。",
        total: totalHoles,
        accepted: totalAccepted,
        pages: outPages,
      },
      null,
      1,
    ),
    "utf8",
  );
  console.log(`\n===== 整页补全（jobs 引擎）：${totalAccepted}/${totalHoles} 条通过判据 =====`);
  console.log(`落盘 ${OUT_JSON}；整页图与行级缓存在 ${CACHE_DIR}/`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
