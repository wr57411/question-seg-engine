// scripts/audit-band-exempt-samples.ts
/**
 * 实验抽样自查器（只读、零 API、不进 check）。
 * 对每页跑两次 alignLinesToBands（基线=无旗标 / 目标=组合旗标），列「旗标后新配对行」：
 * text + 带高 + 同带新成员数，并统计每带配对行数分布（P50/P90/max）。
 * 用法：npx tsx scripts/audit-band-exempt-samples.ts <pages...> [--mask] [--exempt] [--n 10]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderGrayPage } from "./audit-hole-geometry.js";
import { holesOf } from "./ocr-page-fill-jobs.js";
import { alignLinesToBands } from "./ink-band-align.js";
import type { Box } from "./paddle-client.js";

const dir = join(process.cwd(), "data/out", "答案册-合订本");
const argv = process.argv.slice(2);
const flag = (k: string): boolean => argv.includes("--" + k);
const nIdx = argv.indexOf("--n");
const mblIdx = argv.indexOf("--mbl");
const n = Number(argv[nIdx + 1] ?? 10) || 10;
const mbl = Number(argv[mblIdx + 1] ?? 0) || 0;
const pages = argv.filter((a, i) => /^\d+$/.test(a) && i !== nIdx + 1 && i !== mblIdx + 1).map(Number);
if (!pages.length) {
  console.error("用法：npx tsx scripts/audit-band-exempt-samples.ts 185 186 [--mask] [--exempt] [--n 10]");
  process.exit(1);
}
const stages = JSON.parse(readFileSync(join(dir, "stages.json"), "utf8")) as {
  pages: { width: number; height: number; blocks?: { text?: unknown; ocr?: unknown; bbox?: unknown }[] }[];
};

for (const pno of pages) {
  const page = stages.pages[pno];
  if (!page) continue;
  const cp = join(dir, "ocr-jobs-cache-localv3", `p${String(pno).padStart(2, "0")}.json`);
  if (!existsSync(cp)) {
    console.error(`缺缓存 p${pno}.json，跳过`);
    continue;
  }
  const raw = JSON.parse(readFileSync(cp, "utf8")) as { lines?: { text?: unknown; score?: unknown; bbox?: unknown; norm?: unknown }[] };
  const lines = (raw.lines ?? [])
    .filter((l) => !!l.norm && !!String(l.text ?? "").trim())
    .map((l) => ({ text: String(l.text), score: typeof l.score === "number" ? l.score : null, bbox: Array.isArray(l.bbox) ? (l.bbox as Box) : null, norm: l.norm as Box }));
  const gray = renderGrayPage(join(dir, "origin.pdf"), pno + 1);
  const blocks = (page.blocks ?? []).filter((b) => b.text && !b.ocr).map((b) => ({ bbox: b.bbox as Box, text: String(b.text) }));
  const holes = holesOf(page);
  const a = alignLinesToBands(lines, gray, page.width, page.height, { mineruBlocks: blocks, holes });
  const b = alignLinesToBands(lines, gray, page.width, page.height, {
    mineruBlocks: blocks,
    holes,
    ...(flag("mask") ? { bandMaskFrameBars: true } : {}),
    ...(flag("exempt") ? { bandExemptFullyOverlapping: true } : {}),
    ...(mbl ? { maxBandLines: mbl } : {}),
  });
  const hs = lines.map((l) => l.norm![3] * page.height - l.norm![1] * page.height).sort((x, y) => x - y);
  const medH = hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
  const keyOf = (n: [number, number, number, number]): string => n[1].toFixed(4) + "-" + n[3].toFixed(4);
  const newOnBand = new Map<string, number>();
  const perBand = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const nb = b.lines[i]!.norm;
    if (nb === null) continue;
    const k = keyOf(nb);
    perBand.set(k, (perBand.get(k) ?? 0) + 1);
    if (a.lines[i]!.norm === null) newOnBand.set(k, (newOnBand.get(k) ?? 0) + 1);
  }
  const counts = [...perBand.values()].sort((x, y) => x - y);
  const pct = (arr: number[], q: number): number => arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]! : 0;
  console.log(`p${pno}: total=${a.stats.total} newPaired=${b.stats.paired - a.stats.paired} medH=${medH.toFixed(1)} guardH=${(1.6 * medH).toFixed(1)}`);
  console.log(`  每带配对行数分布: bands=${counts.length} P50=${pct(counts, 0.5)} P90=${pct(counts, 0.9)} max=${counts.at(-1) ?? 0}`);
  let shown = 0;
  for (let i = 0; i < lines.length && shown < n; i++) {
    if (a.lines[i]!.norm === null && b.lines[i]!.norm !== null) {
      const nn = b.lines[i]!.norm!;
      console.log(`  [y0=${(nn[1] * page.height).toFixed(0)} bandH=${((nn[3] - nn[1]) * page.height).toFixed(1)}pt 新同带成员=${newOnBand.get(keyOf(nn)) ?? 1}] ${String(lines[i]!.text).slice(0, 60)}`);
      shown++;
    }
  }
}
