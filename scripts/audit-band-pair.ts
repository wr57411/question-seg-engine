// scripts/audit-band-pair.ts
/**
 * 大样本配带率审计（2026-11-08 目标）：V3 行框 → 墨迹行带 DP 配带率。
 * 判据唯一来源 = `alignLinesToBands`（ink-band-align.ts，实现本身）；
 * 本脚本只做页循环与聚合，不重写任何判据（B-35 纪律）。
 *
 * 调用形态与 ocr-page-fill-jobs.ts `--experimental-align` 路径相同
 * （`{ mineruBlocks, holes }`），用于检验「云端 4 页  claim 93.9%」在
 * 大样本（本地 4070 全册 187 页 / 云端扩样 34 页）下是否成立。
 *
 * 只读、零 API、不进 check。
 * 用法：npx tsx scripts/audit-band-pair.ts [--doc 答案册-合订本]
 *   [--cache ocr-jobs-cache] [--pages 74,91,150,159] [--out band-pair.xxx.json]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderGrayPage } from "./audit-hole-geometry.js";
import { holesOf } from "./ocr-page-fill-jobs.js";
import { alignLinesToBands } from "./ink-band-align.js";
import type { Box } from "./paddle-client.js";

const ROOT = process.cwd();

interface LineRow {
  page: number;
  total: number;
  paired: number;
  noBand: number;
  overload: number;
  /** paired/total ×100，保留 1 位小数 */
  rate: number;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const doc = arg("--doc") ?? "答案册-合订本";
  const cacheArg = arg("--cache") ?? "ocr-jobs-cache";
  const pagesArg = arg("--pages");
  const outArg = arg("--out") ?? "band-pair.json";
  const dir = join(ROOT, "data/out", doc);

  const stages = JSON.parse(readFileSync(join(dir, "stages.json"), "utf8")) as {
    pages: {
      index: number;
      width: number;
      height: number;
      blocks?: { text?: unknown; ocr?: unknown; bbox?: unknown }[];
    }[];
  };

  const pages = pagesArg
    ? pagesArg.split(",").map(Number).filter(Number.isFinite)
    : readdirSync(join(dir, cacheArg))
        .map((f) => /^p(\d+)\.json$/.exec(f)?.[1])
        .filter((x): x is string => !!x)
        .map(Number)
        .sort((a, b) => a - b);
  if (!pages.length) {
    console.error(`没有可用页：${cacheArg}  里没有 pNN.json，也没有给 --pages`);
    process.exit(1);
  }

  const rows: LineRow[] = [];
  let total = 0;
  let paired = 0;
  let noBand = 0;
  let overload = 0;
  let corrupt = 0;

  for (const pno of pages) {
    const page = stages.pages[pno];
    if (!page) continue;
    const cachePath = join(dir, cacheArg, `p${String(pno).padStart(2, "0")}.json`);
    if (!existsSync(cachePath)) {
      console.error(`缺缓存 p${pno}.json，跳过`);
      continue;
    }
    let raw: { lines?: { text?: unknown; score?: unknown; bbox?: unknown; norm?: unknown }[] };
    try {
      raw = JSON.parse(readFileSync(cachePath, "utf8")) as {
        lines?: { text?: unknown; score?: unknown; bbox?: unknown; norm?: unknown }[];
      };
    } catch {
      console.error(`坏 JSON（截断/损坏）：${cachePath}，计为 corrupt 行`);
      rows.push({ page: pno, total: 0, paired: 0, noBand: 0, overload: 0, rate: -1 });
      corrupt += 1;
      continue;
    }
    const lines = (raw.lines ?? [])
      .filter((l) => !!l.norm && !!String(l.text ?? "").trim())
      .map((l) => ({
        text: String(l.text),
        score: typeof l.score === "number" ? l.score : null,
        bbox: Array.isArray(l.bbox) ? (l.bbox as Box) : null,
        norm: l.norm as Box,
      }));
    if (!lines.length) {
      rows.push({ page: pno, total: 0, paired: 0, noBand: 0, overload: 0, rate: 0 });
      continue;
    }
    const gray = renderGrayPage(join(dir, "origin.pdf"), pno + 1);
    const mineruBlocks = (page.blocks ?? [])
      .filter((b) => b.text && !b.ocr)
      .map((b) => ({ bbox: b.bbox as Box, text: String(b.text) }));
    const holes = holesOf(page);
    const { stats } = alignLinesToBands(lines, gray, page.width, page.height, { mineruBlocks, holes });
    const rate = stats.total > 0 ? +((stats.paired / stats.total) * 100).toFixed(1) : 0;
    rows.push({
      page: pno,
      total: stats.total,
      paired: stats.paired,
      noBand: stats.noBand,
      overload: stats.bandOverload,
      rate,
    });
    total += stats.total;
    paired += stats.paired;
    noBand += stats.noBand;
    overload += stats.bandOverload;
  }

  const rate = total > 0 ? +((paired / total) * 100).toFixed(1) : 0;
  const summary = {
    doc,
    cache: cacheArg,
    pages: rows.length,
    totalLines: total,
    paired,
    rate,
    noBand,
    bandOverload: overload,
    corruptFiles: corrupt,
  };
  console.log(JSON.stringify(summary, null, 1));
  writeFileSync(join(dir, outArg), JSON.stringify({ summary, rows }, null, 1));
  console.log(`→ data/out/${doc}/${outArg}`);
}

main();