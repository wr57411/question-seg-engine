// scripts/ocr-fill.ts
/**
 * OCR 候选补全（显式步骤，**不进 `npm run check`**）。
 *
 * 背景：MinerU 会漏识别整行/整段（Task 16 的「解析遗漏」就是它的可见化）。实测
 * `data/out/ocr-fill-feasibility.md`：**PaddleOCR-VL 区域 OCR 能把这些行逐字读回来**，
 * 而 MinerU 重解析同一区域会带大量邻行碎片噪声（`data/out/mineru-reparse-feasibility.md`）。
 *
 * 本脚本只做三件事：**裁图 → OCR → 合理性判据**，产出 `data/out/<docId>/ocr-fill.json`；
 * 由 `scripts/export-stages.ts` 合并进快照的 `pages[].ocrFill`（仅新增字段）。
 * 这样 OCR 产物与快照解耦：重导快照不会丢，重跑 OCR 也不会污染其它字段。
 *
 * 三条纪律（都有实测依据）：
 *  1. **只补「引擎为空」的地方** —— 输入就是 Task 16 的 content 级未覆盖区域，不碰已有文本。
 *  2. **裁图必须减去图片块 bbox** —— 实测裁到插图会吐 `<div><img …/></div>` 占位符。
 *  3. **只当候选** —— OCR 会错字（实测 `D 当口将` ← 原卷 `D. 当只将`），故一律标
 *     `source: "paddleocr-vl-1.6"` 并在界面上以**候选**样式渲染，绝不静默替换。
 *
 * 用法：node --import tsx scripts/ocr-fill.ts [docId] [--limit N]
 * 需要环境变量 PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN（或从 ~/.workbuddy-ai/mcp.json 读取）。
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emWidthOf } from "../stages/font-metrics.js";

const DOC = process.argv[2] ?? "23必刷题 2相互作用";
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

const OUT_DIR = join("data", "out", DOC);
const PDF = join(OUT_DIR, "origin.pdf");
const CROP_DIR = join(OUT_DIR, "ocr-fill");
const DPI = 300;
/** 竖向把区域扩成整行（pt）。区域本身只是「行的碎片」。 */
const LINE_PAD_Y = 3;
/** 横向外扩（pt）：给 OCR 一点上下文，但不吞掉相邻内容（如紧邻的分式块）。 */
const PAD_X = 8;
/** 宽度合理性：恢复文本的当量宽 / 窗口宽，落在此区间外视为不可信。 */
const RATIO_MIN = 0.45;
const RATIO_MAX = 1.9;

type Box = [number, number, number, number];
interface OcrFillItem {
  /** 未覆盖区域（碎片）在原卷上的位置 */
  bbox: Box;
  /** **渲染用**位置：裁图窗口（= 整行范围）。OCR 读的是整行，放碎片位置会右移。 */
  win: Box;
  /** 清洗后的文本（候选） */
  text: string;
  /** OCR 原始输出（留证） */
  raw: string;
  /** 该处的原卷裁图（G4 证据），相对项目根的路径 */
  crop: string;
  /** 当量宽 / 窗口宽 */
  ratio: number;
  accepted: boolean;
  reason?: string;
}

/* ── 取 token：env 优先，其次读应用 MCP 配置（只读，不打印）─────────────── */
function readToken(): string {
  const fromEnv = process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  const cfg = join(homedir(), ".workbuddy-ai", "mcp.json");
  if (existsSync(cfg)) {
    try {
      const j = JSON.parse(readFileSync(cfg, "utf8"));
      const t = j?.mcpServers?.["PaddleOCR-VL-1.6"]?.env?.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN;
      if (typeof t === "string" && t) return t;
    } catch {
      /* 读不动就走下面的报错 */
    }
  }
  console.error(
    "缺少 PaddleOCR token：设置 PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN，" +
      "或在 ~/.workbuddy-ai/mcp.json 的 PaddleOCR-VL-1.6.env 里配置。",
  );
  process.exit(2);
}

/* ── MCP stdio 客户端（只用到 initialize / tools/call）─────────────────── */
class OcrMcp {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters = new Map<number, (v: any) => void>();

  constructor(token: string) {
    this.proc = spawn("/Users/john/.local/bin/uvx", ["--from", "paddleocr-mcp", "paddleocr_mcp"], {
      env: {
        ...process.env,
        PADDLEOCR_MCP_MODEL: "PaddleOCR-VL-1.6",
        PADDLEOCR_MCP_PPOCR_SOURCE: "aistudio",
        PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: token,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr!.on("data", () => {}); // 吞掉 banner/日志
    this.proc.stdout!.on("data", (c: Buffer) => {
      this.buf += c.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        // ⚠️ 必须按 id 匹配：server 会先发 notifications/message，
        // 若把第一条消息当响应，会「0.0s 假完成」（实测踩过）。
        if (typeof m.id === "number" && this.waiters.has(m.id)) {
          this.waiters.get(m.id)!(m);
          this.waiters.delete(m.id);
        }
      }
    });
  }

  private send(o: unknown) {
    this.proc.stdin!.write(JSON.stringify(o) + "\n");
  }

  private await(id: number, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  async init(): Promise<void> {
    this.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ocr-fill", version: "1" } },
    });
    const r = await this.await(1, 180_000);
    if (!r) throw new Error("MCP initialize 超时");
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private nextId = 100;

  async ocr(pngBase64: string, timeoutMs = 240_000): Promise<string> {
    const id = ++this.nextId;
    this.send({
      jsonrpc: "2.0", id, method: "tools/call",
      params: {
        name: "paddleocr_vl",
        arguments: { input_data: pngBase64, file_type: "image", output_mode: "simple", return_images: false },
      },
    });
    const r = await this.await(id, timeoutMs);
    if (!r) return "";
    if (r.error) throw new Error(`tools/call 错误: ${JSON.stringify(r.error).slice(0, 200)}`);
    const res = r.result ?? {};
    if (res.isError) throw new Error("tools/call isError");
    return (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
  }

  close() {
    try {
      this.proc.kill();
    } catch {
      /* 已退出 */
    }
  }
}

/* ── 几何工具 ───────────────────────────────────────────────────────── */
const inter = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** 本页正文块的**行高中位**（pt）——当作该页字号，用于宽度合理性判据。 */
function medianLineHeightPt(blocks: any[]): number {
  const hs = blocks.filter((b: any) => b.kind !== "image" && b.text).map((b: any) => b.bbox[3] - b.bbox[1]).sort((a: number, b: number) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
}

/** 把 win 里与 holes 相交的部分切掉，保留面积最大的一块（只求避开插图，不做通用布尔运算）。 */
function clipAway(win: Box, holes: Box[]): Box | null {
  let best: Box | null = win;
  for (const h of holes) {
    if (!best || !inter(best, h)) continue;
    const left: Box = [best[0], best[1], Math.min(best[2], h[0]), best[3]];
    const right: Box = [Math.max(best[0], h[2]), best[1], best[2], best[3]];
    const cands: Box[] = [left, right].filter((r: Box) => r[2] - r[0] > 24 && r[3] - r[1] > 5);
    if (!cands.length) return null;
    cands.sort((a: Box, b: Box) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
    best = cands[0]!;
  }
  return best;
}

/** 清洗 OCR 输出：去掉 markdown/HTML/图片占位符与多余空白（不改字）。 */
function cleanOcr(s: string): string {
  return s
    .replace(/<div[\s\S]*?<\/div>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[#>*\s]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */
const snap = JSON.parse(readFileSync(join(OUT_DIR, "stages.json"), "utf8"));
if (!existsSync(PDF)) {
  console.error(`缺少 ${PDF}（先 npm run stages:export）`);
  process.exit(2);
}
mkdirSync(CROP_DIR, { recursive: true });

type Target = { page: number; bbox: Box; area: number };
const targets: Target[] = [];
for (const p of snap.pages) {
  for (const r of p.uncovered ?? []) {
    if (r.kind === "content") targets.push({ page: p.index, bbox: r.bbox, area: r.area });
  }
}
targets.sort((a, b) => b.area - a.area);
const todo = targets.slice(0, Number.isFinite(LIMIT) ? LIMIT : targets.length);
console.log(`内容级「解析遗漏」区域 ${targets.length} 个，本次处理 ${todo.length} 个`);

const mcp = new OcrMcp(readToken());
await mcp.init();

const byPage = new Map<number, OcrFillItem[]>();
let accepted = 0;
for (const [i, t] of todo.entries()) {
  const p = snap.pages[t.page];
  const [rx0, ry0, rx1, ry1] = t.bbox;

  // ① 竖向扩成整行；横向**从区域本身向外扩固定边距**。
  //
  // ⚠️ 曾经的写法是「取该行上所有块的 x 并集」当左右边界 —— 那是**错的**：
  // 这行的文字**正是缺失的**（否则不会被标成未覆盖区域），所以那行上只剩残存的碎片
  // （热狗题 A/B 第 2 行只剩一个分式块 x 146–165）→ 窗口被推成 23pt 宽 → 判「窗口过小」跳过。
  // 该启发式恰好在它最该起作用的场景下失效（2026-10-10 用户当场指出）。
  // 现在只依赖区域自身，不依赖块。
  let win: Box = [
    Math.max(0, rx0 - PAD_X),
    Math.max(0, ry0 - LINE_PAD_Y),
    Math.min(p.width, rx1 + PAD_X),
    ry1 + LINE_PAD_Y,
  ];

  // ② 减去图片块（实测：裁到插图会吐图片占位符）
  const holes = (p.blocks ?? []).filter((b: any) => b.kind === "image").map((b: any) => b.bbox as Box);
  win = clipAway(win, holes) ?? win;

  if (win[2] - win[0] < 24 || win[3] - win[1] < 5) {
    console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 窗口过小，跳过`);
    continue;
  }

  // ③ 裁图（G4 证据落盘）。⚠️ pdftoppm 会自动加 `-NN` 页码后缀，必须按实际产物改名。
  const cropRel = join(CROP_DIR, `p${String(t.page + 1).padStart(2, "0")}-${i + 1}.png`);
  const prefix = cropRel.replace(/\.png$/, "");
  const s = DPI / 72;
  try {
    execFileSync("pdftoppm", [
      "-r", String(DPI), "-f", String(t.page + 1), "-l", String(t.page + 1), "-png",
      "-x", String(Math.round(win[0] * s)), "-y", String(Math.round(win[1] * s)),
      "-W", String(Math.round((win[2] - win[0]) * s)), "-H", String(Math.round((win[3] - win[1]) * s)),
      PDF, prefix,
    ], { stdio: "ignore" });
    const produced = readdirSync(CROP_DIR)
      .filter((f) => f.startsWith(`${prefix.split("/").pop()!}-`) && f.endsWith(".png"))
      .sort()
      .pop();
    if (!produced) throw new Error("no output");
    renameSync(join(CROP_DIR, produced), cropRel);
  } catch {
    console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 裁图失败`);
    continue;
  }

  // ④ OCR
  const t0 = Date.now();
  let raw = "";
  try {
    raw = await mcp.ocr(readFileSync(cropRel).toString("base64"));
  } catch (e) {
    console.log(`[${i + 1}/${todo.length}] p${t.page + 1} OCR 失败: ${String(e).slice(0, 80)}`);
    continue;
  }
  const text = cleanOcr(raw);
  // ⚠️ emWidthOf 返回的是**当量 em 数**（不是 pt）。要跟窗口宽（pt）比，必须乘字号。
  // 用本页正文块行高中位当字号（与 baseFontOfPage 同口径）—— 曾漏乘，导致比值恒 ≈12 全判 ✗。
  const fontPt = medianLineHeightPt(p.blocks);
  const emW = emWidthOf(text);
  const winW = win[2] - win[0];
  const ratio = emW > 0 && fontPt > 0 ? winW / (emW * fontPt) : 0;
  const ok = text.length > 0 && ratio >= RATIO_MIN && ratio <= RATIO_MAX;
  const item: OcrFillItem = {
    bbox: t.bbox, win, text, raw: raw.trim(), crop: cropRel, ratio: +ratio.toFixed(2),
    accepted: ok, ...(ok ? {} : { reason: text ? `宽度比 ${ratio.toFixed(2)} 越界` : "OCR 无文本" }),
  };
  if (!byPage.has(t.page)) byPage.set(t.page, []);
  byPage.get(t.page)!.push(item);
  if (ok) accepted++;
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[${i + 1}/${todo.length}] p${t.page + 1} ${sec}s 比=${ratio.toFixed(2)} ${ok ? "✓" : "✗"} ${JSON.stringify(text.slice(0, 60))}`,
  );
}
mcp.close();

const out = {
  docId: DOC,
  generatedAt: new Date().toISOString(),
  source: "paddleocr-vl-1.6",
  note: "候选补全：仅供人工核对，不静默替换引擎文本（G1）。",
  total: todo.length,
  accepted,
  pages: [...byPage.entries()].map(([page, items]) => ({ page, items })),
};
writeFileSync(join(OUT_DIR, "ocr-fill.json"), JSON.stringify(out, null, 1));
console.log(`\n===== 候选补全：${accepted}/${todo.length} 条通过合理性判据 =====`);
console.log(`落盘 ${join(OUT_DIR, "ocr-fill.json")}；裁图证据在 ${CROP_DIR}/`);
console.log(`下一步：npm run stages:export（会把 ocr-fill.json 合并进快照）`);
