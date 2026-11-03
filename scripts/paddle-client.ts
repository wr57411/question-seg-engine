/**
 * paddle-client.ts —— PaddleOCR AI Studio **异步作业接口**客户端（替代 MCP 通道拿结构）
 *
 * ## 为什么要有这个文件（2026-11-03 实测，证据 `docs/evidence/2026-11-03-paddle-two-routes-probe.md`）
 *
 * 现有的 OCR 校验线走 `paddleocr_mcp`（`scripts/ocr-lib.ts`）。那个封装把结果收敛成
 * 三个字段（markdown / pages / images_mapping），**`prunedResult` 整层被扔掉**，
 * 连 `output_mode:"detailed"` 也只多返回一行 `Pages: N`（已实测：响应里没有任何 bbox）。
 * 而模型本身是给的：
 * - `PaddleOCR-VL-1.6` ⇒ `parsing_res_list[]`（块文字 + `block_bbox` + `block_order`）
 *   与 `layout_det_res.boxes[]`（版面框 + `score` 置信）。
 * - `PP-StructureV3` ⇒ 上面两套之外，还有 `overall_ocr_res`（**行级框 + 逐行置信**）、
 *   `table_res_list`（**单元格框** + `pred_html`）、`formula_res_list`（LaTeX + 区域框）。
 * ⇒ 想要坐标只能直连作业接口，这就是本文件。
 *
 * ## 实测吞吐（同一本《电路》13 页，2026-11-03）
 *
 * | 通道 | 整本一次作业 | 单页（新字节） |
 * |---|---|---|
 * | MCP + VL（现状） | 逐页 42–90s ⇒ ≈ 19 分钟 | 45.8s |
 * | 本文件 + VL | 218.7s ⇒ 16.8s/页 | 20.5s |
 * | 本文件 + V3 | **71s ⇒ 5.5s/页** | 31.7s |
 *
 * ## 三条必须记住的坑（都踩过或实测过）
 *
 * 1. **坐标空间不统一**：图片输入按图片像素，PDF 输入按渲染尺度（实测 4186×5988）。
 *    ⇒ 一切对外用的框都要按 `prunedResult.width/height` **归一化**（本文件已做，`norm` 字段）。
 * 2. **服务端疑似按「文件字节 + optionalPayload」去重**：同一 PNG 第二次 1.7s 返回、
 *    响应逐字节相同；换了 payload 就重新计时 ⇒ **任何时延基准必须换新字节**
 *    （这也解释了 `scripts/ocr-fill.ts:158-160`「重试要换不同字节」那条老坑）。
 * 3. **凭据有效性 ≠ 存在性**：`GET {JOB_URL}/1` 是零成本握手 —— 401/403 ⇒ token 不行；
 *    404 + `code 11001「jobId 不存在」` ⇒ token 能用。已实测三种返回。
 *
 * 不引入任何新依赖（Node 内置 fetch / FormData / Blob），与 `scripts/oxr-client.ts` 同一写法。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readToken } from "./ocr-lib.js";

export const JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";

/** 作业接口支持的模型（取自 `paddleocr` SDK `Model` 枚举，3.7.0 实测）。 */
export const PADDLE_MODELS = [
  "PP-OCRv5",
  "PP-OCRv5-latin",
  "PP-OCRv6",
  "PP-StructureV3",
  "PaddleOCR-VL",
  "PaddleOCR-VL-1.5",
  "PaddleOCR-VL-1.6",
] as const;
export type PaddleModel = (typeof PADDLE_MODELS)[number];

/** 文档解析产线（只有这三条 VL + V3 返回 `layoutParsingResults`）。 */
export const DOC_PARSING_MODELS: readonly PaddleModel[] = [
  "PP-StructureV3",
  "PaddleOCR-VL",
  "PaddleOCR-VL-1.5",
  "PaddleOCR-VL-1.6",
];

/** 提交后等服务端跑完的上限：实测整本 PDF 71–219s，答案册 187 页要留足。 */
const POLL_TIMEOUT_MS = Number(process.env.PADDLE_JOB_TIMEOUT_MS ?? 1_800_000);
const POLL_INTERVAL_MS = Number(process.env.PADDLE_JOB_POLL_MS ?? 4_000);
const REQ_TIMEOUT_MS = Number(process.env.PADDLE_REQ_TIMEOUT_MS ?? 300_000);

/* ── 类型（只声明本项目要读的字段；服务端多给的字段原样留在 `raw`） ─────────── */

export type Box = [number, number, number, number];

export interface PaddleBlock {
  label: string;
  content: string;
  /** 原始终坐标（像素 / PDF 渲染尺度都可能是），**不可跨来源直接比**。 */
  bbox: Box | null;
  /** 按 `width/height` 归一化到 0..1；无 bbox 时为 null。 */
  norm: Box | null;
  order: number | null;
}

export interface PaddleDetBox {
  label: string;
  score: number | null;
  bbox: Box | null;
  norm: Box | null;
}

export interface PaddleLine {
  text: string;
  score: number | null;
  bbox: Box | null;
  norm: Box | null;
}

export interface PaddlePage {
  /** 0-based，与作业接口返回的页序一致（整本 PDF 一行一页）。 */
  page: number;
  width: number;
  height: number;
  markdown: string;
  blocks: PaddleBlock[];
  det: PaddleDetBox[];
  /** StructureV3 才有；VL 该数组为空（实测 `overall_ocr_res` 不存在）。 */
  lines: PaddleLine[];
  tables: { cells: number; html: string; htmlLen: number }[];
  formulas: { latex: string; bbox: Box | null; norm: Box | null }[];
  counters: PageCounters;
}

export interface PageCounters {
  blocks: number;
  lines: number;
  detBoxes: number;
  tables: number;
  cells: number;
  formulas: number;
  /** 版面标签 ⇒ 计数，用于与 MinerU 逐类对表。 */
  byLabel: Record<string, number>;
  markdownChars: number;
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const isObj = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function asBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  const [x0, y0, x1, y1] = v as number[];
  if (![x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [x0 as number, y0 as number, x1 as number, y1 as number];
}

/** 四点多边形 ⇒ 外接矩形（`rec_polys` 给的是四个角点）。 */
function boxOfPoly(poly: unknown): Box | null {
  if (!Array.isArray(poly) || poly.length === 0) return null;
  if (typeof poly[0] === "number") return asBox(poly);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pt of poly as unknown[]) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [x, y] = pt as number[];
    if (typeof x !== "number" || typeof y !== "number") continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

function normBox(b: Box | null, w: number, h: number): Box | null {
  if (!b || !(w > 0) || !(h > 0)) return null;
  return [b[0] / w, b[1] / h, b[2] / w, b[3] / h];
}

/** 面积并集用于判重叠；这里只做交集判定，不做几何运算（审计脚本自己决定怎么用）。 */
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/* ── JSONL 解析（纯函数，可单测） ────────────────────────────────────────── */

/**
 * 解析作业接口 `resultUrl.jsonUrl` 的 JSONL 文本 ⇒ 每页一个 `PaddlePage`。
 *
 * 结构（实测）：每行 `{errorCode, errorMsg, logId, result}`，
 * `result.layoutParsingResults[]` 里每项含 `{markdown:{text,images}, prunedResult, outputImages, inputImage}`。
 * VL 的整本返回是「一行 4 页」的批次（实测 13 页 ⇒ 4 行），StructureV3 是「一行 1 页」⇒
 * 这里**按展平后的顺序统一编号**，两种形状都能吃。
 */
export function parseDocParsingJsonl(text: string): PaddlePage[] {
  const pages: PaddlePage[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // 允许尾部空行/进度行；真解析不出来由 counters=0 暴露
    }
    const result = isObj(obj) && isObj(obj.result) ? obj.result : null;
    if (!result) continue;
    const items = Array.isArray(result.layoutParsingResults) ? result.layoutParsingResults : [];
    for (const it of items) pages.push(normalizePageItem(it, pages.length));
  }
  return pages;
}

/** 单页 ⇒ 归一化结构。`page` 只作编号用，不参与几何。 */
export function normalizePageItem(item: unknown, page: number): PaddlePage {
  const empty: PaddlePage = {
    page,
    width: 0,
    height: 0,
    markdown: "",
    blocks: [],
    det: [],
    lines: [],
    tables: [],
    formulas: [],
    counters: { blocks: 0, lines: 0, detBoxes: 0, tables: 0, cells: 0, formulas: 0, byLabel: {}, markdownChars: 0 },
  };
  if (!isObj(item)) return empty;

  const md = isObj(item.markdown) && typeof item.markdown.text === "string" ? item.markdown.text : "";
  const pr = isObj(item.prunedResult) ? item.prunedResult : null;
  if (!pr) return { ...empty, markdown: md, counters: { ...empty.counters, markdownChars: md.length } };

  const width = typeof pr.width === "number" ? pr.width : 0;
  const height = typeof pr.height === "number" ? pr.height : 0;

  const blocks: PaddleBlock[] = (Array.isArray(pr.parsing_res_list) ? pr.parsing_res_list : []).map((b) => {
    const bbox = asBox(b?.block_bbox);
    return {
      label: String(b?.block_label ?? ""),
      content: String(b?.block_content ?? ""),
      bbox,
      norm: normBox(bbox, width, height),
      order: typeof b?.block_order === "number" ? b.block_order : null,
    };
  });

  const detSrc = isObj(pr.layout_det_res) && Array.isArray(pr.layout_det_res.boxes) ? pr.layout_det_res.boxes : [];
  const det: PaddleDetBox[] = detSrc.map((d) => {
    const bbox = asBox(d?.coordinate);
    return {
      label: String(d?.label ?? ""),
      score: typeof d?.score === "number" ? d.score : null,
      bbox,
      norm: normBox(bbox, width, height),
    };
  });

  // StructureV3 独有的行级 OCR；VL 没有 ⇒ 空数组（实测）
  const ocr = isObj(pr.overall_ocr_res) ? pr.overall_ocr_res : null;
  const texts: unknown[] = ocr && Array.isArray(ocr.rec_texts) ? ocr.rec_texts : [];
  const polys: unknown[] = ocr && Array.isArray(ocr.rec_polys) ? ocr.rec_polys : [];
  const scores: unknown[] = ocr && Array.isArray(ocr.rec_scores) ? ocr.rec_scores : [];
  const lines: PaddleLine[] = texts.map((t, i) => {
    const bbox = boxOfPoly(polys[i]);
    return {
      text: String(t ?? ""),
      score: typeof scores[i] === "number" ? (scores[i] as number) : null,
      bbox,
      norm: normBox(bbox, width, height),
    };
  });

  const tables: { cells: number; html: string; htmlLen: number }[] = (
    Array.isArray(pr.table_res_list) ? pr.table_res_list : []
  ).map((t) => {
    const html = String(t?.pred_html ?? "");
    return { cells: Array.isArray(t?.cell_box_list) ? t.cell_box_list.length : 0, html, htmlLen: html.length };
  });

  const formulas: { latex: string; bbox: Box | null; norm: Box | null }[] = (
    Array.isArray(pr.formula_res_list) ? pr.formula_res_list : []
  ).map((f) => {
    const bbox = boxOfPoly(f?.dt_polys);
    return { latex: String(f?.rec_formula ?? ""), bbox, norm: normBox(bbox, width, height) };
  });

  const byLabel: Record<string, number> = {};
  for (const b of blocks) byLabel[b.label] = (byLabel[b.label] ?? 0) + 1;

  return {
    page,
    width,
    height,
    markdown: md,
    blocks,
    det,
    lines,
    tables,
    formulas,
    counters: {
      blocks: blocks.length,
      lines: lines.length,
      detBoxes: det.length,
      tables: tables.length,
      cells: tables.reduce((a, t) => a + t.cells, 0),
      formulas: formulas.length,
      byLabel,
      markdownChars: md.length,
    },
  };
}

/* ── 凭据与作业 IO ──────────────────────────────────────────────────────── */

export interface TokenCheck {
  ok: boolean;
  /** `"valid" | "unauthorized" | "http_<code>" | "network"` */
  state: string;
  detail: string;
}

/**
 * 零成本握手：`GET {JOB_URL}/1`。
 * 实测：无/坏 token ⇒ 401 `Unauthorized`；好 token ⇒ 404 `code 11001「jobId 不存在」`。
 * **不提交作业、不花额度**，所以可以放进 `daily` 每次都查。
 */
export async function verifyToken(token?: string): Promise<TokenCheck> {
  const tok = token ?? safeToken();
  if (!tok) return { ok: false, state: "unauthorized", detail: "没有凭据（env / mcp.json 都没有）" };
  try {
    const r = await fetch(`${JOB_URL}/1`, {
      headers: { Authorization: `bearer ${tok}` },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const body = await r.text();
    if (r.status === 401 || r.status === 403) {
      return { ok: false, state: "unauthorized", detail: `HTTP ${r.status} token 无效或已过期` };
    }
    if (r.status === 404 || /11001|jobId/.test(body)) {
      return { ok: true, state: "valid", detail: `HTTP ${r.status}（握手通过：${truncate(body, 80)}）` };
    }
    return { ok: false, state: `http_${r.status}`, detail: truncate(body, 160) };
  } catch (e) {
    return { ok: false, state: "network", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** `readToken()` 会 `process.exit(2)` —— 库函数不能这么干，所以包一层。 */
function safeToken(): string | null {
  const fromEnv = process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return readToken();
  } catch {
    return null;
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface SubmitInput {
  model: PaddleModel;
  /** 本地文件路径（PDF 或图片）。PDF 服务端自己按页展开，省掉逐页往返。 */
  filePath: string;
  /** camelCase 的作业选项；留空则用服务端默认（实测默认即含表格/公式/图表识别）。 */
  options?: Record<string, unknown>;
  token?: string;
  onProgress?: (msg: string) => void;
}

export interface JobOutcome {
  model: PaddleModel;
  jobId: string;
  /** 输入文件 sha256 —— 服务端疑似按字节去重，审计必须能追溯到"哪份字节"。 */
  inputSha256: string;
  pages: number;
  wallMs: number;
  jsonl: string;
  /** `resultUrl` 里的原始地址清单（有效期有限，别当长期凭据）。 */
  resultUrls: Record<string, string>;
}

export async function submitJob(input: SubmitInput): Promise<string> {
  const tok = input.token ?? safeToken();
  if (!tok) throw new Error("缺少 PaddleOCR 凭据（env PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN 或 ~/.workbuddy-ai/mcp.json）");
  const form = new FormData();
  form.append("model", input.model);
  form.append("optionalPayload", JSON.stringify(input.options ?? {}));
  form.append(
    "file",
    new Blob([readFileSync(input.filePath)], { type: input.filePath.endsWith(".pdf") ? "application/pdf" : "image/png" }),
    basename(input.filePath),
  );
  const r = await fetch(JOB_URL, {
    method: "POST",
    headers: { Authorization: `bearer ${tok}` },
    body: form,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`提交失败 HTTP ${r.status}：${truncate(body, 300)}`);
  let j: unknown = null;
  try {
    j = JSON.parse(body);
  } catch {
    throw new Error(`提交响应不是 JSON：${truncate(body, 200)}`);
  }
  const jobId = isObj(j) && isObj(j.data) ? j.data.jobId : undefined;
  if (typeof jobId !== "string" || !jobId) throw new Error(`提交响应里没有 jobId：${truncate(body, 200)}`);
  return jobId;
}

export async function pollJob(jobId: string, onProgress?: (msg: string) => void): Promise<Record<string, any>> {
  const tok = safeToken();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const r = await fetch(`${JOB_URL}/${jobId}`, {
      headers: { Authorization: `bearer ${tok}` },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`轮询失败 HTTP ${r.status}：${truncate(body, 200)}`);
    const payload = JSON.parse(body) as unknown;
    const data = isObj(payload) && isObj(payload.data) ? payload.data : null;
    if (!data) throw new Error(`轮询响应缺 data：${truncate(body, 200)}`);
    const state = String(data.state ?? "");
    const ep = isObj(data.extractProgress) ? data.extractProgress : {};
    const mark = `${state}:${ep.extractedPages ?? "-"}/${ep.totalPages ?? "-"}`;
    if (mark !== last) {
      last = mark;
      onProgress?.(`  ${state} ${ep.extractedPages ?? "-"}/${ep.totalPages ?? "-"}`);
    }
    if (state === "done") return data;
    if (state === "failed") throw new Error(`作业失败：${truncate(String(data.errorMsg ?? ""), 300)}`);
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`作业超时（>${Math.round(POLL_TIMEOUT_MS / 1000)}s）：jobId=${jobId}`);
}

/** `resultUrl.jsonUrl` 是带签名的对象存储地址，**不能带 Authorization 头**（实测 403/`MissingDateHeader`）。 */
export async function fetchJsonl(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`下载结果失败 HTTP ${r.status}：${truncate(await r.text(), 200)}`);
  return r.text();
}

export async function runJob(input: SubmitInput): Promise<JobOutcome> {
  const log = input.onProgress ?? (() => {});
  const t0 = Date.now();
  const jobId = await submitJob(input);
  log(`  jobId=${jobId}`);
  const data = await pollJob(jobId, log);
  const ru = isObj(data.resultUrl) ? (data.resultUrl as Record<string, string>) : {};
  if (!ru.jsonUrl) throw new Error(`作业完成但没有 jsonUrl：${Object.keys(ru).join(",")}`);
  const jsonl = await fetchJsonl(ru.jsonUrl);
  const pages = parseDocParsingJsonl(jsonl);
  if (pages.length === 0) throw new Error(`结果里没有 layoutParsingResults（jobId=${jobId}）`);
  return {
    model: input.model,
    jobId,
    inputSha256: sha256File(input.filePath),
    pages: pages.length,
    wallMs: Date.now() - t0,
    jsonl,
    resultUrls: ru,
  };
}

/**
 * 作业产物的文件名标签：`<模型>-<sha256 前 12 位>`。
 * ⚠️ 落盘与**缓存查找必须用同一个函数**（2026-11-03 踩过：查找拿完整 sha 比 12 位的文件名，
 * 永远不命中 ⇒ 每次重跑都重新提交作业、白烧额度）。
 */
export function jobTag(model: PaddleModel | string, sha256: string): string {
  return `${model}-${sha256.slice(0, 12)}`;
}

/* ── 落盘（产物目录：data/out/<docId>/ocr-jobs/） ─────────────────────────── */

export interface SavedArtifacts {
  dir: string;
  jsonlPath: string;
  pagesPath: string;
  metaPath: string;
}

/**
 * 原样存 JSONL（**事实的来源**）+ 归一化后的 pages + 一份 meta（jobId/sha/耗时）。
 * 只写自己的目录，不碰 `stages.json` / `questions.json`（红线：检测不改写）。
 */
export function saveJobArtifacts(
  outDir: string,
  outcome: JobOutcome,
  options: Record<string, unknown> = {},
): SavedArtifacts {
  const dir = join(outDir, "ocr-jobs");
  mkdirSync(dir, { recursive: true });
  const tag = jobTag(outcome.model, outcome.inputSha256);
  const jsonlPath = join(dir, `${tag}.jsonl`);
  const pagesPath = join(dir, `${tag}.pages.json`);
  const metaPath = join(dir, `${tag}.meta.json`);
  const pages = parseDocParsingJsonl(outcome.jsonl);
  writeFileSync(jsonlPath, outcome.jsonl, "utf8");
  writeFileSync(pagesPath, JSON.stringify(pages, null, 1), "utf8");
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        model: outcome.model,
        jobId: outcome.jobId,
        inputSha256: outcome.inputSha256,
        pages: outcome.pages,
        wallMs: outcome.wallMs,
        options,
        resultUrls: outcome.resultUrls,
        savedAt: new Date().toISOString(),
        // 事实口径提醒：产物不是事实（tasks/lessons.md L7）
        note: "raw jsonl 是服务端原样返回；pages.json 是本地归一化视图，可重生成，不作为判据唯一来源。",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, jsonlPath, pagesPath, metaPath };
}

export function pdfPageCountOf(pdfPath: string): number | null {
  try {
    const out = readFileSync(pdfPath, "latin1");
    const m = /\/Count\s+(\d+)/.exec(out) ?? null;
    return m?.[1] ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/* ── CLI ─────────────────────────────────────────────────────────────────
 *   node --import tsx scripts/paddle-client.ts verify
 *   node --import tsx scripts/paddle-client.ts run --doc "物理_教材基础练 电路" \
 *        [--model PP-StructureV3|PaddleOCR-VL-1.6] [--input <pdf|png>] \
 *        [--options '{"useChartRecognition":false}'] [--no-save]
 * 凭据只走 env / mcp.json，**本文件任何路径都不打印 token**。
 */
async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "verify";
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  if (cmd === "verify") {
    const c = await verifyToken();
    console.log(c.ok ? `✅ 凭据有效 — ${c.detail}` : `❌ 凭据不可用 [${c.state}] — ${c.detail}`);
    process.exit(c.ok ? 0 : 2);
  }
  if (cmd !== "run") {
    console.error("用法: paddle-client.ts verify | run --doc <docId> [--model] [--input] [--options] [--no-save]");
    process.exit(2);
  }
  const doc = flag("doc") ?? "";
  const model = (flag("model") ?? "PP-StructureV3") as PaddleModel;
  if (!DOC_PARSING_MODELS.includes(model)) {
    console.error(`模型 ${model} 不返回 layoutParsingResults；可选：${DOC_PARSING_MODELS.join(" / ")}`);
    process.exit(2);
  }
  const outDir = join("data", "out", doc);
  const input = flag("input") || join(outDir, "origin.pdf");
  const options = JSON.parse(flag("options") || "{}") as Record<string, unknown>;
  if (!safeToken()) {
    console.error("缺少 PaddleOCR 凭据");
    process.exit(2);
  }
  console.log(`▶ ${model} ← ${input}（${(fileSize(input) / 1024 / 1024).toFixed(1)} MB）options=${JSON.stringify(options)}`);
  const outcome = await runJob({ model, filePath: input, options, onProgress: (m) => console.log(m) });
  console.log(`✅ ${outcome.pages} 页 / ${(outcome.wallMs / 1000).toFixed(1)}s`);
  const c = outcome.jsonl ? parseDocParsingJsonl(outcome.jsonl).reduce((a, p) => a + p.counters.blocks, 0) : 0;
  console.log(`   块合计 ${c}`);
  if (!argv.includes("--no-save") && doc) {
    const s = saveJobArtifacts(outDir, outcome, options);
    console.log(`   落盘：${s.jsonlPath}`);
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
