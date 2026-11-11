// scripts/hole-read-export.ts
/**
 * 轮 6「直接读洞」实验：洞条导出器。holesOf 取框（与生产同源），pdftoppm 150dpi 裁洞条：
 * x=洞 bbox 外扩 6pt，y=洞上下各扩 padY：洞框高 ≥0.8×medH（疑似高字形/分数洞）取 1.1×medH，否则 0.6×medH
 *   （自适应 padding，2026-11-09 p100_h3 ½ 切顶漏读教训）。
 * 输出 holes.json（bbox/medH/inkW/crop），供笔记本 PP-OCRv5_server_rec 逐洞识别。
 * 用法：npx tsx scripts/hole-read-export.ts --pages 74,91,150,159 [--out holes14.json]
 *       npx tsx scripts/hole-read-export.ts --sample 30 [--seed 20261108] [--out holes30.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holesOf } from "./ocr-page-fill-jobs.js";
import { medianLineHeightPt } from "./ocr-lib.js";
import { inkExtent } from "./audit-hole-geometry.js";

const ROOT = process.cwd();
const DOC = "答案册-合订本";
const DIR = join(ROOT, "data/out", DOC);
const PDF = join(DIR, "origin.pdf");
const OUT = join(DIR, "hole-read");
const DPI = 150;
const S = DPI / 72;
const PAD_X = 6;
const PAD_Y_F = 0.6;

const argv = process.argv.slice(2);
const arg = (k: string): string | null => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const pagesArg = arg("pages");
const allFlag = argv.includes("--all");
const outArg = arg("out") ?? (allFlag ? "holes-all.json" : pagesArg ? "holes14.json" : "holes30.json");
mkdirSync(join(OUT, "crops"), { recursive: true });
const stages = JSON.parse(readFileSync(join(DIR, "stages.json"), "utf8")) as {
  pages: { index: number; width: number; height: number; blocks?: { bbox: number[] }[]; uncovered?: { kind: string; bbox: number[] }[] }[];
};

interface HoleRow {
  id: string;
  page: number;
  holeIdx: number;
  bbox: number[];
  medH: number;
  inkW: number | null;
  crop: string;
}

const rows: HoleRow[] = [];
const pick = (pno: number, hi: number, bb: [number, number, number, number]): void => {
  const id = `p${String(pno).padStart(3, "0")}_h${hi}`;
  const pg = stages.pages[pno]!;
  const medH = medianLineHeightPt(pg.blocks ?? []);
  const inkE = inkExtent(gray(pno), pg.width, pg.height, bb as [number, number, number, number]);
  const inkW = inkE.bbox && inkE.inkPx > 0 ? inkE.bbox[2] - inkE.bbox[0] : null;
  // X 向边缘切字检测（2026-11-10 用户指出：左缘字被切一半 ⇒ rec 读不出而 OXR 猜对，
  // 无谓分歧）。最小成本 = 纯像素扫描（灰度图已在内存，零 token）：窗缘贴墨 ⇒
  // 向白缝扩展（连续 ≥3 空白列），护栏 1.5×medH 防吞前字。
  const gimg = gray(pno);
  const syPx = gimg.height / pg.height;
  const yInk0 = Math.max(0, Math.floor((bb[1] - 1) * syPx));
  const yInk1 = Math.min(gimg.height - 1, Math.ceil((bb[3] + 1) * syPx));
  const px = gimg.data as Uint8Array;
  const colInk = (xpx: number): boolean => {
    for (let y = yInk0; y <= yInk1; y++) if ((px[y * gimg.width + xpx] ?? 255) < 200) return true;
    return false;
  };
  const capPx = Math.ceil(1.5 * medH * S);
  let x0px = Math.max(0, Math.floor((bb[0] - PAD_X) * S));
  let x1px = Math.min(gimg.width - 1, Math.ceil((bb[2] + PAD_X) * S));
  if (colInk(x0px)) {
    let run = 0, guard = 0;
    while (x0px > 0 && guard < capPx) {
      if (!colInk(x0px)) { run++; if (run >= 3) { x0px += 3; break; } } else run = 0;
      x0px--; guard++;
    }
  }
  if (colInk(x1px - 1)) {
    let run = 0, guard = 0;
    while (x1px < gimg.width - 1 && guard < capPx) {
      if (!colInk(x1px)) { run++; if (run >= 3) { x1px -= 3; break; } } else run = 0;
      x1px++; guard++;
    }
  }
  const x0 = x0px / S, x1 = x1px / S;
  // 自适应竖向 padding（2026-11-09 L14 教训：0.6×medH 会切掉分数/上下标等高字形，
  // rec 对残缺字形会放弃——p100_h3 的 ½ 漏读实证）。洞框高 ≥0.8×medH 判为疑似高字形洞。
  const bbH = bb[3] - bb[1];
  const padY = bbH >= 0.8 * medH ? 1.1 * medH : PAD_Y_F * medH;
  const y0 = Math.max(0, bb[1] - padY);
  const y1 = Math.min(pg.height, bb[3] + padY);
  execFileSync("pdftoppm", ["-png", "-r", String(DPI), "-f", String(pno + 1), "-l", String(pno + 1),
    "-x", String(x0px), "-y", String(Math.floor(y0 * S)),
    "-W", String(x1px - x0px), "-H", String(Math.ceil((y1 - y0) * S)), PDF, join(OUT, "crops", id)], { stdio: "pipe" });
  const png = join(OUT, "crops", `${id}-${String(pno + 1).padStart(3, "0")}.png`);
  rows.push({ id, page: pno, holeIdx: hi, bbox: bb, medH, inkW, crop: png });
};

const grayCache = new Map<number, ReturnType<typeof import("./audit-hole-geometry.js").renderGrayPage>>();
const gray = (pno: number): ReturnType<typeof import("./audit-hole-geometry.js").renderGrayPage> => {
  let g = grayCache.get(pno);
  if (!g) {
    g = renderGrayPage(join(DIR, "origin.pdf"), pno + 1);
    grayCache.set(pno, g);
  }
  return g;
};
import { renderGrayPage } from "./audit-hole-geometry.js";

const sick = [185, 186, 76, 127];
const pageList = pagesArg
  ? pagesArg.split(",").map(Number).filter(Number.isFinite)
  : stages.pages.filter((p) => holesOf(p).length > 0).map((p) => p.index);
const wanted = new Map<number, number[]>();
for (const p of pageList) wanted.set(p, holesOf(stages.pages[p]!).map((_, i) => i));

let targets: { p: number; h: number }[] = [];
if (allFlag) {
  for (const [p, hs] of wanted) for (const h of hs) targets.push({ p, h });
} else if (pagesArg) {
  for (const p of pageList) for (const h of wanted.get(p) ?? []) targets.push({ p, h });
} else {
  let s = Number(arg("seed") ?? 20261108) >>> 0;
  const rnd = (): number => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sickH: { p: number; h: number }[] = [];
  const rest: { p: number; h: number }[] = [];
  for (const [p, hs] of wanted) for (const h of hs) (sick.includes(p) ? sickH : rest).push({ p, h });
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  const n = Number(arg("sample") ?? 30);
  for (const x of [...sickH, ...rest.slice(0, Math.max(0, n - sickH.length))]) targets.push(x);
}
for (const { p, h } of targets) {
  const bb = holesOf(stages.pages[p]!)[h]! as [number, number, number, number];
  pick(p, h, bb);
}
writeFileSync(join(OUT, outArg), JSON.stringify(rows, null, 1));
console.log(`导出 ${rows.length} 洞条 → ${join(OUT, outArg)}`);
