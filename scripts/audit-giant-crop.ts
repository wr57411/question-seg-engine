// scripts/audit-giant-crop.ts
/**
 * 巨带裁图回退补充路径（实验：只读测量 + 裁图导出，零 API，不进 check）。
 * goal item 2：墨迹配对在插图/表格巨带（figureGiant）等干扰下失效 ⇒ 被截断的行不丢弃，
 * 改用「V3 行框裁图」作为坐标例外（用户许可截图）。
 *
 * 关键实测（2026-11-13，p76/p127 裁图自检）：巨带内被截断行的 V3 框本身已是紧单行框
 * （h≈medH），noBand 根因是「墨迹带巨带 + 容量截断」而非 V3 框跑偏 ⇒ 回退坐标 = V3 框本身，
 * 不做 inkExtent 扩窗精修（扩窗会吞邻行：p076_g0 实证扩成 33pt 三行）。
 *
 * 三步：① 检测带类型（生产带 h + 吞并 minGapPx=0 原始墨行 runs，判据 import 不重写——B-35）；
 * ② 对 noBand 行按带类型回退（默认仅 figureGiant；--all-noband 扩到全部截断行）→ 裁图；
 * ③ 量覆盖增益 + 机器正确性筛（单行高区间 + 框内有墨），导出裁图供独立核对 / 笔记本 rec。
 * 用法：npx tsx scripts/audit-giant-crop.ts --pages 76,127 [--doc ..] [--nocrop] [--all-noband]
 * 产物：data/out/<doc>/giant-crop.pNN.json + giant-crop/crops/*.png
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderGrayPage, inkExtent } from "./audit-hole-geometry.js";
import { holesOf } from "./ocr-page-fill-jobs.js";
import { splitInkLines, DEFAULT_SPLIT } from "./ink-lines.js";
import { alignLinesToBands, bandsForColumn } from "./ink-band-align.js";
import type { Box } from "./paddle-client.js";

const ROOT = process.cwd();
const DPI = 150;
const S = DPI / 72;
/** figureGiant 判据阈值（与 audit-gap-roots category 同口径）：带高 >25pt 且吞并原始墨行 >1。 */
const GIANT_H_PT = 25;
/** 机器正确性筛：单行高区间 [0.5,2]×medH；框内墨迹 ≥20px 才算「确有字」。 */
const H_LO = 0.5, H_HI = 2, INK_MIN = 20;

const argv = process.argv.slice(2);
const arg = (k: string): string | null => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const doc = arg("doc") ?? "答案册-合订本";
const nocrop = argv.includes("--nocrop");
const allNoband = argv.includes("--all-noband");
const cropFallback = argv.includes("--crop-fallback");
const allPages = argv.includes("--all");
const dir = join(ROOT, "data/out", doc);
const pages = allPages
  ? readdirSync(join(dir, "ocr-jobs-cache-localv3")).filter((f) => /^p\d+\.json$/.test(f)).map((f) => Number(f.slice(1, -5))).sort((a, b) => a - b)
  : (arg("pages") ?? "76,127").split(",").map(Number).filter(Number.isFinite);
const stages = JSON.parse(readFileSync(join(dir, "stages.json"), "utf8")) as {
  pages: { index: number; width: number; height: number; blocks?: { bbox: number[]; text?: unknown; ocr?: unknown; kind?: string }[]; uncovered?: { kind: string; bbox: number[] }[] }[];
};
const cropDir = join(dir, "giant-crop", "crops");
if (!nocrop) mkdirSync(cropDir, { recursive: true });

interface Victim {
  id: string; page: number; text: string; v3box: Box; fallbackBox: Box;
  bandH: number; bandRuns: number; category: string; col: string;
  inkPx: number; heightOk: boolean; inkOk: boolean; crop: string | null;
}

const category = (h: number, runs: number): string =>
  h <= 12 ? "singleLineMultiBox" : runs === 1 ? "zeroGap" : h > GIANT_H_PT ? "figureGiant" : "formulaSmallGap";

/** 跨页聚合收集器（--all 全册测量用；正常裁图模式逐页 push，--crop-fallback 验证模式不收集） */
const agg: { page: number; total: number; paired: number; noBand: number; recovered: number; valid: number }[] = [];

for (const pno of pages) {
  const page = stages.pages[pno];
  if (!page) { console.error(`stages.pages[${pno}] 不存在，跳过`); continue; }
  const cp = join(dir, "ocr-jobs-cache-localv3", `p${String(pno).padStart(2, "0")}.json`);
  if (!existsSync(cp)) { console.error(`缺缓存 p${pno}.json，跳过`); continue; }
  const raw = JSON.parse(readFileSync(cp, "utf8")) as { lines?: { text?: unknown; score?: unknown; bbox?: unknown; norm?: unknown }[] };
  const lines = (raw.lines ?? [])
    .filter((l) => !!l.norm && !!String(l.text ?? "").trim())
    .map((l) => ({ text: String(l.text), score: typeof l.score === "number" ? l.score : null, bbox: Array.isArray(l.bbox) ? (l.bbox as Box) : null, norm: l.norm as Box }));
  const pageW = page.width, pageH = page.height;
  const gray = renderGrayPage(join(dir, "origin.pdf"), pno + 1);
  const sy = gray.height / pageH;
  // 行高尺子取 V3 行框高中位（与生产 ink-band-align §110 同口径，独立 OCR 源）。
  // 不用 medianLineHeightPt(page.blocks)：答案表页整页仅 1 个 table 块 ⇒ medH=表高(724pt)，
  // 会把所有正常单行框(h≈10pt)误判 suspect（p185/p186 实测 1083 行假阴性）。
  const lineHs = lines.map((l) => l.norm[3] * pageH - l.norm[1] * pageH).sort((a, b) => a - b);
  const medH = lineHs.length ? lineHs[Math.floor(lineHs.length / 2)]! : 0;
  const mineruBlocks = (page.blocks ?? []).filter((b) => b.text && !b.ocr).map((b) => ({ bbox: b.bbox as Box, text: String(b.text) }));
  const holes = holesOf(page);
  const base = alignLinesToBands(lines, gray, pageW, pageH, { mineruBlocks, holes, diagNoBand: true });

  // ── 生产旗标验证模式（--crop-fallback）：直接跑生产 truncationCropFallback，核对回退坐标=V3 原框。
  //    与上面审计自有的裁图回退（fallbackBox）相互独立——这条验的是 ink-band-align 生产插桩本身。
  if (cropFallback) {
    const prod = alignLinesToBands(lines, gray, pageW, pageH, { mineruBlocks, holes, truncationCropFallback: true });
    let coordExact = 0;
    prod.lines.forEach((l, i) => {
      if (l.coordSource === "crop" && JSON.stringify(l.norm) === JSON.stringify(lines[i]!.norm)) coordExact++;
    });
    const cropRows = prod.lines.filter((l) => l.coordSource === "crop").length;
    console.log(JSON.stringify({
      doc, page: pno, mode: "production-crop-fallback",
      totalLines: prod.stats.total,
      baselinePaired: base.stats.paired, baselineNoBand: base.stats.noBand, baselineNoBandByCause: base.stats.noBandByCause,
      prodPaired: prod.stats.paired, prodNoBand: prod.stats.noBand, prodCropFallback: prod.stats.cropFallback,
      cropRows, coordExactVsV3: coordExact,
      prodWithFallbackRate: +(((prod.stats.paired + (prod.stats.cropFallback ?? 0)) / prod.stats.total) * 100).toFixed(1),
    }, null, 1));
    continue;
  }

  // 每栏生产带 + 类型（吞并 minGapPx=0 原始墨行 runs）
  const mid = pageW / 2;
  const typedBands: { col: number; y0: number; y1: number; h: number; runs: number; category: string }[] = [];
  const bandCat: Record<string, number> = {};
  for (const col of [0, 1]) {
    const colX0 = col === 0 ? 0 : mid, colX1 = col === 0 ? mid : pageW;
    const runs0 = splitInkLines(gray, pageW, pageH, [colX0, 0, colX1, pageH], { ...DEFAULT_SPLIT, minInkPx: 6, minGapPx: 0 });
    for (const b of bandsForColumn(gray, pageW, pageH, colX0, colX1)) {
      const swallowed = runs0.filter((r) => (r.py0 / sy + (r.py1 + 1) / sy) / 2 >= b.y0 && (r.py0 / sy + (r.py1 + 1) / sy) / 2 <= b.y1).length;
      const h = b.y1 - b.y0;
      const cat = category(h, swallowed);
      bandCat[cat] = (bandCat[cat] ?? 0) + 1;
      typedBands.push({ col, y0: b.y0, y1: b.y1, h: +h.toFixed(1), runs: swallowed, category: cat });
    }
  }

  const victims: Victim[] = [];
  const recoveredByCat: Record<string, number> = {};
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (base.lines[i]!.norm !== null) continue;
    const nb = lines[i]!.norm!;
    const v3: Box = [nb[0] * pageW, nb[1] * pageH, nb[2] * pageW, nb[3] * pageH];
    const cy = (v3[1] + v3[3]) / 2;
    const col = v3[0] < mid ? 0 : 1;
    const band = typedBands.find((b) => b.col === col && cy >= b.y0 && cy <= b.y1);
    const cat = band?.category ?? "none";
    if (!allNoband && cat !== "figureGiant") { skipped++; continue; }
    const ext = inkExtent(gray, pageW, pageH, v3);
    const h = v3[3] - v3[1];
    const heightOk = h >= H_LO * medH && h <= H_HI * medH;
    const inkOk = ext.inkPx >= INK_MIN;
    const id = `p${String(pno).padStart(3, "0")}_g${victims.length}`;
    let crop: string | null = null;
    if (!nocrop) {
      const x0px = Math.max(0, Math.floor((v3[0] - 2) * S));
      const x1px = Math.min(gray.width - 1, Math.ceil((v3[2] + 2) * S));
      const y0px = Math.max(0, Math.floor((v3[1] - 2) * S));
      const y1px = Math.min(gray.height - 1, Math.ceil((v3[3] + 2) * S));
      execFileSync("pdftoppm", ["-png", "-r", String(DPI), "-f", String(pno + 1), "-l", String(pno + 1),
        "-x", String(x0px), "-y", String(y0px), "-W", String(x1px - x0px), "-H", String(y1px - y0px),
        join(dir, "origin.pdf"), join(cropDir, id)], { stdio: "pipe" });
      crop = join(cropDir, `${id}-${String(pno + 1).padStart(3, "0")}.png`);
    }
    recoveredByCat[cat] = (recoveredByCat[cat] ?? 0) + 1;
    victims.push({ id, page: pno, text: lines[i]!.text, v3box: v3.map((v) => +v.toFixed(1)) as Box, fallbackBox: v3.map((v) => +v.toFixed(1)) as Box, bandH: band?.h ?? 0, bandRuns: band?.runs ?? 0, category: cat, col: col === 0 ? "L" : "R", inkPx: ext.inkPx, heightOk, inkOk, crop });
  }

  const total = base.stats.total, paired = base.stats.paired, recovered = victims.length;
  const valid = victims.filter((v) => v.heightOk && v.inkOk).length;
  const summary = {
    doc, page: pno, mode: allNoband ? "all-noband" : "figureGiant-only",
    totalLines: total, baselinePaired: paired, baselineRate: +((paired / total) * 100).toFixed(1),
    noBand: base.stats.noBand, noBandByCause: base.stats.noBandByCause,
    bandCategories: bandCat, recovered, recoveredByCat, skippedNotGiant: skipped,
    validRecoveries: valid, suspect: recovered - valid,
    withFallbackRate: +(((paired + recovered) / total) * 100).toFixed(1),
    validWithFallbackRate: +(((paired + valid) / total) * 100).toFixed(1),
    medH: +medH.toFixed(1),
  };
  agg.push({ page: pno, total, paired, noBand: base.stats.noBand, recovered, valid });
  writeFileSync(join(dir, `giant-crop.p${String(pno).padStart(2, "0")}.json`), JSON.stringify({ summary, typedBands, victims }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  console.log(`→ data/out/${doc}/giant-crop.p${String(pno).padStart(2, "0")}.json` + (nocrop ? "" : ` + ${recovered} 裁图`));
}

// ── 跨页聚合（全册测量口径，B-39 前置「全册双向测量」的可执行命令）─────────────
//    覆盖率=(paired+recovered)/total；正确率保守下界=(paired+valid)/total（机器筛：单行高+框内有墨）。
//    95% 正确率金标需笔记本 PP-OCRv5 rec 交叉（独立来源），机器下界达标≠金标达标。
if (!cropFallback && agg.length) {
  const T = agg.reduce((s, p) => s + p.total, 0);
  const P = agg.reduce((s, p) => s + p.paired, 0);
  const R = agg.reduce((s, p) => s + p.recovered, 0);
  const V = agg.reduce((s, p) => s + p.valid, 0);
  const aggregate = {
    doc, pagesMeasured: agg.length, mode: allNoband ? "all-noband" : "figureGiant-only",
    totalLines: T, baselinePaired: P, baselineRate: +((P / T) * 100).toFixed(1),
    recovered: R, validRecoveries: V, suspect: R - V,
    coverageWithFallback: +(((P + R) / T) * 100).toFixed(1),
    validLowerBound: +(((P + V) / T) * 100).toFixed(1),
    target95LowerBoundMet: T > 0 && (P + V) / T >= 0.95,
    perPageByNoBand: [...agg].sort((a, b) => b.noBand - a.noBand),
    note: "validLowerBound=机器筛保守下界（误标合法分式高框/短标签）；95% 正确率金标需笔记本 rec 交叉。覆盖率≠正确率。全册需 --all + 全册 localv3 缓存（笔记本物理开机）。",
  };
  writeFileSync(join(dir, "giant-crop.aggregate.json"), JSON.stringify(aggregate, null, 1));
  console.log("=== AGGREGATE ===");
  console.log(JSON.stringify(aggregate, null, 1));
  console.log(`→ data/out/${doc}/giant-crop.aggregate.json`);
}