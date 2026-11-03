// scripts/ink-lines.ts
/**
 * 洞内「按墨迹投影切行」——**零模型、零新依赖**（2026-11-03 用户提的思路）。
 *
 * 为什么不需要大模型：一行字在像素上就是一条横向墨带，行与行之间是白缝。
 * 对灰度图在洞的 bbox 内做**水平投影**（每行数一次墨迹像素），白缝处切开就是行；
 * 每行的横向范围同理。项目已有 `renderGrayPages`（pdftoppm -gray → PGM）与 `parsePgm`，
 * 直接复用，不引新库。
 *
 * 两个已知坑（必须配一致性校验，否则会切错还不响）：
 * 1. **多切**：上下标、分式横线会把一行切成 2–3 条带 ⇒ 用 `minGapPx` 合并窄缝；
 * 2. **少切**：相邻行贴合（下伸部/上伸部相接）会连成一条。
 * ⇒ 切完必须和「洞高 ÷ 页面行高中位数」比：**行数对不上就整洞标待核**，不硬用。
 *
 * 用法：
 *   npx tsx scripts/ink-lines.ts --doc "物理_教材基础练 电路" [--dpi 150]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderGrayPages, type GrayImage } from "./export-stages.js";

const ROOT = join(import.meta.dirname, "..");
type Box = [number, number, number, number];

export interface InkLineInfo {
  /** 像素坐标（相对灰度图），便于裁剪核对 */
  py0: number;
  py1: number;
  px0: number;
  px1: number;
  inkPx: number;
}

export interface SplitOptions {
  /** 墨迹阈值：灰度 < threshold 视为墨 */
  threshold: number;
  /** 一条带至少要有多少墨迹像素才算一行 */
  minInkPx: number;
  /** 两条带之间白缝 < 该像素数就合并（治上下标/分式横线） */
  minGapPx: number;
}

export const DEFAULT_SPLIT: SplitOptions = { threshold: 200, minInkPx: 1, minGapPx: 4 };

/** 洞内按水平投影切行（纯函数，可单测）。bbox 用页面坐标（pt），内部换算像素。 */
export function splitInkLines(
  img: GrayImage,
  pageW: number,
  pageH: number,
  bbox: Box,
  opts: SplitOptions = DEFAULT_SPLIT,
): InkLineInfo[] {
  const sx = img.width / pageW;
  const sy = img.height / pageH;
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(bbox[0] * sx)));
  const x1 = Math.max(0, Math.min(img.width - 1, Math.ceil(bbox[2] * sx)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(bbox[1] * sy)));
  const y1 = Math.max(0, Math.min(img.height - 1, Math.ceil(bbox[3] * sy)));

  const rows: number[] = [];
  for (let y = y0; y <= y1; y++) {
    let c = 0;
    const base = y * img.width;
    for (let x = x0; x <= x1; x++) if (img.data[base + x]! < opts.threshold) c++;
    rows.push(c);
  }

  const runs: [number, number][] = [];
  let start = -1;
  rows.forEach((c, i) => {
    const hasInk = c >= opts.minInkPx;
    if (hasInk && start < 0) start = i;
    if (!hasInk && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, rows.length - 1]);

  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && r[0] - last[1] - 1 < opts.minGapPx) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }

  return merged.map(([a, b]) => {
    let px0 = Infinity;
    let px1 = -Infinity;
    let inkPx = 0;
    for (let y = y0 + a; y <= y0 + b; y++) {
      const base = y * img.width;
      for (let x = x0; x <= x1; x++) {
        if (img.data[base + x]! < opts.threshold) {
          inkPx++;
          if (x < px0) px0 = x;
          if (x > px1) px1 = x;
        }
      }
    }
    return { py0: y0 + a, py1: y0 + b, px0: Number.isFinite(px0) ? px0 : x0, px1: Number.isFinite(px1) ? px1 : x1, inkPx };
  });
}

/* ── CLI：拿一本的原卷，逐个洞切行，看「切出的行数」和「洞高÷行高中位」是否一致 ── */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const doc = flag("doc");
  if (!doc) {
    console.error('用法: ink-lines.ts --doc "<docId>" [--dpi 150]');
    process.exit(2);
  }
  const dpi = Number(flag("dpi") ?? 150);
  const outDir = join(ROOT, "data", "out", doc);
  const stages = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as {
    pages: { index?: number; width: number; height: number; uncovered?: { bbox?: number[]; kind?: string }[]; blocks?: { bbox: number[]; kind?: string; text?: string }[] }[];
  };
  const pdf = join(outDir, "origin.pdf");
  const images = renderGrayPages(pdf, dpi);

  let holes = 0;
  let single = 0;
  let multi = 0;
  let agree = 0;
  let disagree = 0;
  const counts: number[] = [];
  const samples: { page: number; lines: number; expected: number; h: number; text?: string }[] = [];

  for (const p of stages.pages) {
    const img = images[p.index ?? 0];
    if (!img) continue;
    // 页面行高中位数：正文块 bbox 高度的中位数（与 ocr-page-fill 同口径）
    const hs = (p.blocks ?? [])
      .filter((b) => b.kind !== "image" && b.text)
      .map((b) => b.bbox[3]! - b.bbox[1]!)
      .sort((a, b) => a - b);
    const medH = hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
    for (const u of p.uncovered ?? []) {
      const bb = u.bbox;
      if (!bb || bb.length < 4) continue;
      if (u.kind !== "content") continue;
      const w = bb[2]! - bb[0]!;
      const h = bb[3]! - bb[1]!;
      if (w <= 0 || h <= 0 || w / h < 1.5) continue; // 与 ocr-page-fill 的形状守卫同口径
      holes++;
      const lines = splitInkLines(img, p.width, p.height, bb as Box);
      counts.push(lines.length);
      if (lines.length === 1) single++;
      else multi++;
      const expected = medH > 0 ? Math.max(1, Math.round(h / medH)) : 0;
      if (expected > 0 && lines.length === expected) agree++;
      else disagree++;
      if (samples.length < 8 && expected >= 2) samples.push({ page: (p.index ?? 0) + 1, lines: lines.length, expected, h: +h.toFixed(1) });
    }
  }

  console.log(
    `\n${doc}\n  洞 ${holes}：单行 ${single}、多行 ${multi}\n` +
      `  行数与「洞高÷行高中位」一致 ${agree}（${((agree / Math.max(1, holes)) * 100).toFixed(1)}%）、不一致 ${disagree}\n` +
      `  切出行数分布：${JSON.stringify(counts.reduce((m: Record<number, number>, c) => ((m[c] = (m[c] ?? 0) + 1), m), {}))}`,
  );
  for (const s of samples) console.log(`    p${s.page}: 切出 ${s.lines} 行 / 期望 ${s.expected} 行（洞高 ${s.h}pt）`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
