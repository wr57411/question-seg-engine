// scripts/diag-match.ts
/**
 * 配对诊断：逐洞回答「为什么没配上」。只读，不写产物、不接 daily、不进 `npm run check`。
 *
 * 存在理由（2026-11-06）：一次诊断用 `tsx -e` 内联脚本自己重写了「找最近行框」，
 * 漏掉实现里的「列一致」守卫，得出「框被更近的洞抢走」的错误归因。根因不是缺检查，
 * 是「诊断」只能以一次性命令存在 ⇒ 既不可复现，也不被迫调用实现。
 *
 * 因此本文件**只调用实现、不重写判据**：
 *   - 洞发现：`holesOf`（与 MCP 路径同源）
 *   - 配对：`matchLinesToHoles`（唯一的配对实现）
 *   - 阈值：`LINE_HOLE_CENTER_DY_MAX`（实现常量，禁止在此硬编码 8）
 *   - 重叠：`overlapArea`（与实现同一个函数）
 * 「卡在哪」的归因是**对同一批判据的复述**，不是另写一套；改判据时本文件无需跟着改。
 *
 * 用法：`node --import tsx scripts/diag-match.ts [--doc 答案册-合订本] [--pages 74,91]`
 *   页号口径 = 产物 `page` 字段 = stages 的 0 基 index（缓存文件名 pNN.json 的数字）。
 *   不给 `--pages` 时自动取 `ocr-jobs-cache/` 里已有的页。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hardChars,
  holesOf,
  LINE_HOLE_CENTER_DY_MAX,
  matchLinesToHoles,
} from "./ocr-page-fill-jobs.js";
import { overlapArea, type Box, type PaddleLine } from "./paddle-client.js";
import { inkLineAround, renderGrayPage } from "./audit-hole-geometry.js";
import { alignLinesToBands } from "./ink-band-align.js";

const ROOT = process.cwd();

interface Cand {
  text: string;
  dy: number;
  ov: number;
  hard: number;
  x0: number;
}

interface HoleDiag {
  page: number;
  hole: number;
  bbox: Box;
  owner: { text: string; dy: number; extra: number } | null;
  sameCol: Cand | null;
  crossCol: Cand | null;
  reason: string;
}

function arg(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}

function cachedPages(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^p(\d+)\.json$/.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 终端对齐用：CJK/全角按 2 列宽计，其余 1 列。 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(ch) ? 2 : 1;
  return w;
}

function padEndV(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - dispWidth(s)));
}

/** 按显示宽度截断（不是按字符数），避免中文把表格推歪。 */
function truncV(s: string, maxW: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = dispWidth(ch);
    if (w + cw > maxW) return `${out}…`;
    out += ch;
    w += cw;
  }
  return out;
}

/** 对单个洞复述「同栏最近 / 跨栏最近」两个候选，用于解释未归属原因。 */
function nearest(
  lines: PaddleLine[],
  hole: Box,
  pageW: number,
  pageH: number,
  resolveCenter?: (anchor: Box) => number | null,
): { same: Cand | null; cross: Cand | null } {
  const mid = pageW / 2;
  const hcy = resolveCenter?.(hole) ?? (hole[1] + hole[3]) / 2;
  const holeLeft = hole[0] < mid;
  let same: Cand | null = null;
  let cross: Cand | null = null;
  for (const l of lines) {
    if (!l.norm || !l.text.trim()) continue;
    const lb: Box = [l.norm[0] * pageW, l.norm[1] * pageH, l.norm[2] * pageW, l.norm[3] * pageH];
    const dy = Math.abs((resolveCenter?.(lb) ?? (lb[1] + lb[3]) / 2) - hcy);
    const cand: Cand = {
      text: l.text.trim().slice(0, 18),
      dy,
      ov: overlapArea(lb, hole),
      hard: hardChars(l.text),
      x0: lb[0],
    };
    const isSameCol = lb[0] < mid === holeLeft;
    if (isSameCol) {
      if (!same || dy < same.dy) same = cand;
    } else if (!cross || dy < cross.dy) cross = cand;
  }
  return { same, cross };
}

function explain(d: Omit<HoleDiag, "reason">): string {
  if (d.owner) return "—";
  const s = d.sameCol;
  if (!s) {
    const c = d.crossCol;
    if (!c) return "同栏无行框（该 y 区间无任何行）";
    return `同栏无行框；最近行在另一栏 dy=${c.dy.toFixed(1)} x=${c.x0.toFixed(0)}（洞 x=${d.bbox[0].toFixed(0)}）`;
  }
  if (s.dy > LINE_HOLE_CENTER_DY_MAX) {
    const cross = d.crossCol && d.crossCol.dy < s.dy ? `；跨栏有更近的 dy=${d.crossCol.dy.toFixed(1)}（不可用）` : "";
    return `同栏最近行 dy=${s.dy.toFixed(1)} > ${LINE_HOLE_CENTER_DY_MAX}pt${cross}`;
  }
  if (!(s.ov > 0)) return `同栏最近行无交集（dy=${s.dy.toFixed(1)}，横向不重叠）`;
  if (s.hard < 2) return `同栏最近行硬字符 ${s.hard} < 2`;
  return "同栏有合格候选却未归（被更近的洞取走）";
}

function main(): void {
  const argv = process.argv.slice(2);
  const doc = arg(argv, "--doc", "答案册-合订本");
  if (doc.includes("..") || doc.includes("/") || doc.includes("\\")) {
    console.error(`--doc 只接受目录名（不含路径分隔符）：${doc}`);
    process.exit(1);
  }
  const dir = join(ROOT, "data/out", doc);
  const cacheDir = join(dir, "ocr-jobs-cache");
  const stagesPath = join(dir, "stages.json");

  if (!existsSync(stagesPath)) {
    console.error(`缺少 ${stagesPath}（先跑 daily 导出 stages）`);
    process.exit(1);
  }
  const pagesArg = arg(argv, "--pages", "");
  const pages = pagesArg
    ? pagesArg.split(",").map(Number).filter(Number.isFinite)
    : cachedPages(cacheDir);
  if (!pages.length) {
    console.error(`没有可用页：${cacheDir} 里没有 pNN.json，也没有给 --pages`);
    process.exit(1);
  }

  const stages = readJson<{ pages: any[] }>(stagesPath);
  const rows: HoleDiag[] = [];

  for (const pageNo of pages) {
    const page = stages.pages[pageNo];
    if (!page) {
      console.error(`页 ${pageNo} 不在 stages.json（共 ${stages.pages.length} 页）`);
      continue;
    }
    const cachePath = join(cacheDir, `p${pageNo}.json`);
    if (!existsSync(cachePath)) {
      console.error(`缺缓存 ${cachePath}（该页未跑过直连引擎）`);
      continue;
    }
    const lines = (readJson<{ lines?: PaddleLine[] }>(cachePath).lines ?? []).filter(
      (l) => !!l.norm && !!l.text.trim(),
    );
    const holes = holesOf(page);
    const gray = renderGrayPage(join(dir, "origin.pdf"), pageNo + 1);
    // 生产口径（与 ocr-page-fill-jobs 同源）：纯吸附 resolver + 精准融合 gate（§110）
    const resolveCenter = (anchor: Box): number | null => {
      const band = inkLineAround(gray, page.width, page.height, anchor);
      return band ? (band.bbox[1] + band.bbox[3]) / 2 : null;
    };
    const xAligned = alignLinesToBands(lines, gray, page.width, page.height, { replaceY: false });
    const gateMap = new Map<PaddleLine, Box>();
    lines.forEach((l, i) => {
      const an = xAligned.lines[i]?.norm;
      if (an) gateMap.set(l, [an[0] * page.width, an[1] * page.height, an[2] * page.width, an[3] * page.height]);
    });
    const { holeLines } = matchLinesToHoles(lines, holes, page.width, page.height, resolveCenter, (l) =>
      gateMap.get(l) ?? null,
    );
    const centerY = (anchor: Box): number => resolveCenter(anchor) ?? (anchor[1] + anchor[3]) / 2;

    holes.forEach((bbox, i) => {
      const owned = holeLines[i] ?? [];
      const first = owned[0];
      const owner = first
        ? {
            text: first.text.trim().slice(0, 18),
            dy: Math.abs(
              centerY([
                first.norm![0] * page.width,
                first.norm![1] * page.height,
                first.norm![2] * page.width,
                first.norm![3] * page.height,
              ]) - centerY(bbox),
            ),
            extra: owned.length - 1,
          }
        : null;
      const { same, cross } = nearest(lines, bbox, page.width, page.height, resolveCenter);
      const base = { page: pageNo, hole: i, bbox, owner, sameCol: same, crossCol: cross };
      rows.push({ ...base, reason: explain(base) });
    });
  }

  const hit = rows.filter((r) => r.owner).length;
  console.log(`\n=== 配对诊断 · ${doc} · ${pages.length} 页 ${rows.length} 洞 ===`);
  console.log(
    `判据（实现常量）：列一致 + 有交集 + |dy| ≤ ${LINE_HOLE_CENTER_DY_MAX}pt + ≥2 硬字符；排序 dy↑ 再 cov↓`,
  );
  console.log("");
  console.log("页   洞  宽×高      归属行                         卡在哪");
  console.log("─".repeat(100));
  for (const r of rows) {
    const w = r.bbox[2] - r.bbox[0];
    const h = r.bbox[3] - r.bbox[1];
    const owner = r.owner
      ? `「${truncV(r.owner.text, 14)}」${r.owner.extra > 0 ? `+${r.owner.extra}` : ""} dy=${r.owner.dy.toFixed(1)}`
      : "-";
    console.log(
      `${String(r.page).padStart(3)} ${String(r.hole).padStart(3)}  ` +
        `${String(Math.round(w)).padStart(3)}×${padEndV(String(Math.round(h)), 3)} ` +
        `${padEndV(owner, 30)} ${r.reason}`,
    );
  }

  const miss = rows.filter((r) => !r.owner);
  const bucket = new Map<string, number>();
  for (const r of miss) {
    const key = r.reason.startsWith("同栏无行框")
      ? "同栏无行框"
      : r.reason.includes(`> ${LINE_HOLE_CENTER_DY_MAX}pt`)
        ? `同栏 dy > ${LINE_HOLE_CENTER_DY_MAX}pt`
        : r.reason.includes("无交集")
          ? "横向不重叠"
          : r.reason.includes("硬字符")
            ? "硬字符 <2"
            : "被更近的洞取走";
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  console.log("");
  console.log(`合计：命中 ${hit}/${rows.length}`);
  if (miss.length) {
    console.log(`未命中按原因：${[...bucket].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  }
}

main();
