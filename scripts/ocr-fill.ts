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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emWidthOf } from "../stages/font-metrics.js";
import { cleanOcr, inter, medianLineHeightPt, OcrMcp, readToken } from "./ocr-lib.js";

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
/**
 * 窗口下限（pt）：**低于此值不去尝试**。
 *
 * ⚠️ 这不是「小内容不重要」的过滤，而是**防幻觉**：
 * 实测 5–7pt 的插图子图标签（A/B/C/D），小裁剪返回**空**，连插图一起裁则**幻觉出假字**
 * （`日去而师形日`，原卷只是 `A`）。而宽度比判据**抓不住幻觉**（该例比值 0.63，落在合格区间内）。
 * ⇒ 宁可在界面上留一个可见的「解析遗漏」，也不收一个看起来合格的假字。
 * 22×11pt 的「分力」这类真实两字内容仍在阈值之上，照常处理。
 */
/**
 * 裁剪的**目标像素宽**（px）：由它反推 DPI（`dpi = 72 * TARGET_PX_W / 窗口宽pt`）。
 * 决定成败的是**像素尺寸**而非 pt 宽：太小读不出（题册的插图子图标签），
 * 太大服务端超时/返回空（答案文档的宽区域，226pt × 600dpi = 1883px 就废了）。
 */
const TARGET_PX_W = 1000;
const MIN_DPI = 300;
const MAX_DPI = 600;

const MIN_WIN_W = 16;
const MIN_WIN_H = 6;
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

/* ── 几何工具 ───────────────────────────────────────────────────────── */
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

  // 下限只用来挡「真正的退化窗口」（宽 < 12pt 或高 < 5pt）。
  // ⚠️ 原为 24pt —— 实测它把**插图子图标签 A/B/C/D**（5–7 × 6–9pt）全挡掉了，
  // 而我一直把这些跳过当成「小标点」没去看（2026-10-10 连续第三次同类错误）。
  if (win[2] - win[0] < MIN_WIN_W || win[3] - win[1] < MIN_WIN_H) {
    console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 窗口退化（${(win[2] - win[0]).toFixed(0)}x${(win[3] - win[1]).toFixed(0)}pt），跳过`);
    continue;
  }

  // ③+④ 裁图 → OCR。**最多两轮**，第二轮换「窗口尺寸 + DPI」得到不同的图，
  // 既绕开服务端缓存（实测：同一张图第二次请求会被缓存，空结果也会被缓存），
  // 又给小图更大像素（5–7pt 的插图子图标签在 300dpi 下只有 ~25×30px，OCR 读不出）。
  const t0 = Date.now();
  let raw = "";
  let usedWin = win;
  let usedDpi = 0;
  for (let attempt = 1; attempt <= 2 && !raw.trim(); attempt++) {
    // 第二轮：窗口四边各扩 4pt（内容不变，但字节不同 → 不走缓存）
    usedWin = attempt === 1 ? win : [
      Math.max(0, win[0] - 4), Math.max(0, win[1] - 2),
      Math.min(p.width, win[2] + 4), win[3] + 2,
    ];
    // 选 DPI：**按目标像素宽反推**，不按 pt 分段。
    //
    // ⚠️ 原写法是「pt 宽 < 40 就用 600dpi」，在题册上有效（那些区域只有 5–22pt，600dpi 后仍小），
    // 但在答案文档上**净负面**：区域宽可达 226pt，600dpi → 1883px → 服务端超时/返回空。
    // 实测该文档：300dpi 组通过 11/16（69%），600dpi 组只有 2/34（6%）。
    // ⇒ 决定成败的是**像素尺寸**，不是 pt 宽：太小读不出、太大服务端失败。
    const winWpt = usedWin[2] - usedWin[0];
    usedDpi = Math.round(72 * TARGET_PX_W / winWpt);
    usedDpi = Math.max(MIN_DPI, Math.min(MAX_DPI, usedDpi));
    const cropRel = join(CROP_DIR, `p${String(t.page + 1).padStart(2, "0")}-${i + 1}.png`);
    const prefix = cropRel.replace(/\.png$/, "");
    const sc = usedDpi / 72;
    try {
      execFileSync("pdftoppm", [
        "-r", String(usedDpi), "-f", String(t.page + 1), "-l", String(t.page + 1), "-png",
        "-x", String(Math.round(usedWin[0] * sc)), "-y", String(Math.round(usedWin[1] * sc)),
        "-W", String(Math.round((usedWin[2] - usedWin[0]) * sc)),
        "-H", String(Math.round((usedWin[3] - usedWin[1]) * sc)),
        PDF, prefix,
      ], { stdio: "ignore" });
      // ⚠️ pdftoppm 会自动加 `-NN` 页码后缀，按实际产物改名
      const produced = readdirSync(CROP_DIR)
        .filter((f) => f.startsWith(`${prefix.split("/").pop()!}-`) && f.endsWith(".png"))
        .sort()
        .pop();
      if (!produced) throw new Error("no output");
      renameSync(join(CROP_DIR, produced), cropRel);
    } catch {
      console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 第${attempt}轮裁图失败`);
      continue;
    }
    try {
      raw = await mcp.ocr(readFileSync(cropRel).toString("base64"));
    } catch (e) {
      console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 第${attempt}轮 OCR 异常: ${String(e).slice(0, 60)}`);
    }
    if (!raw.trim() && attempt === 1) {
      console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 第1轮空（${usedDpi}dpi），换尺寸/DPI 重试…`);
    }
  }
  if (!raw.trim()) console.log(`[${i + 1}/${todo.length}] p${t.page + 1} 两轮均为空，记未通过`);
  const cropRel = join(CROP_DIR, `p${String(t.page + 1).padStart(2, "0")}-${i + 1}.png`);
  const text = cleanOcr(raw);
  // ⚠️ emWidthOf 返回的是**当量 em 数**（不是 pt）。要跟窗口宽（pt）比，必须乘字号。
  // 用本页正文块行高中位当字号（与 baseFontOfPage 同口径）—— 曾漏乘，导致比值恒 ≈12 全判 ✗。
  const fontPt = medianLineHeightPt(p.blocks);
  const emW = emWidthOf(text);
  const winW = usedWin[2] - usedWin[0];
  const ratio = emW > 0 && fontPt > 0 ? winW / (emW * fontPt) : 0;
  const ok = text.length > 0 && ratio >= RATIO_MIN && ratio <= RATIO_MAX;
  const item: OcrFillItem = {
    bbox: t.bbox, win: usedWin, text, raw: raw.trim(), crop: cropRel, ratio: +ratio.toFixed(2),
    accepted: ok, ...(ok ? {} : { reason: text ? `宽度比 ${ratio.toFixed(2)} 越界` : "OCR 无文本" }),
  };
  if (!byPage.has(t.page)) byPage.set(t.page, []);
  byPage.get(t.page)!.push(item);
  if (ok) accepted++;
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[${i + 1}/${todo.length}] p${t.page + 1} ${sec}s ${usedDpi}dpi 比=${ratio.toFixed(2)} ${ok ? "✓" : "✗"} ${JSON.stringify(text.slice(0, 60))}`,
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
// 自动重导快照（同一 docId），让候选真正进入 stages.json —— 这样本步骤对**任意文档**都可重复，
// 不必再手工敲 export（export 需要 layout 路径，默认值只对样卷成立）。
const layoutPath = existsSync(join(OUT_DIR, "layout.json"))
  ? join(OUT_DIR, "layout.json")
  : join("data", "smoke", "unpacked", "layout.json");
console.log(`重导快照：export-stages.ts "${DOC}" "${layoutPath}"`);
execFileSync(process.execPath, ["--import", "tsx", "scripts/export-stages.ts", DOC, layoutPath], {
  stdio: "inherit",
});
