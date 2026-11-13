// scripts/audit-gap-roots.ts
/**
 * 密集页 noBand 根因测量：行内缝 vs 行间断缝宽度分布 + 超容量带根因细分。
 * 判据唯一来源 = splitInkLines / bandsForColumn（ink-lines.ts / ink-band-align.ts），
 * 本脚本只做测量与归类，不重写任何判据（B-35 纪律）。只读、零 API、不进 check。
 *
 * 口径：minGapPx=0 取未合并原始墨行；缝归属用 V3 行框（norm）y 中心标注
 * （同框 = 行内缝，异框 = 行间断缝）；生产带用 bandsForColumn 默认（minGapPx=8）。
 * 超容量带（认领框数 > MAX_BAND_LINES）四分类：
 *   singleLineMultiBox  h≤12pt（带=一条视觉行，V3 拆多框 ⇒ 容量按框计误截）
 *   zeroGap             runs=1 且 h>12pt（墨迹竖直连通，白缝=0，阈值不敏感）
 *   figureGiant         runs>1 且 h>25pt（插图/表格混排巨带）
 *   formulaSmallGap     其余（公式小缝带，缝宽与行内分式缝同档）
 *
 * 用法：npx tsx scripts/audit-gap-roots.ts [--doc 答案册-合订本] [--page 76]
 * 产物：data/out/<doc>/gap-roots.pNN.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderGrayPage } from "./audit-hole-geometry.js";
import { splitInkLines, DEFAULT_SPLIT } from "./ink-lines.js";
import { bandsForColumn, MAX_BAND_LINES } from "./ink-band-align.js";

const ROOT = process.cwd();

interface Gap {
  gapPx: number;
  gapPt: number;
  label: string;
  y: number;
  textA?: string;
  textB?: string;
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const doc = arg("--doc") ?? "答案册-合订本";
  const pno = Number(arg("--page") ?? 76);
  const dir = join(ROOT, "data/out", doc);
  const stages = JSON.parse(readFileSync(join(dir, "stages.json"), "utf8")) as {
    pages: { index: number; width: number; height: number }[];
  };
  const page = stages.pages[pno];
  if (!page) {
    console.error(`stages.pages[${pno}] 不存在`);
    process.exit(1);
  }
  const pageW = page.width;
  const pageH = page.height;
  const gray = renderGrayPage(join(dir, "origin.pdf"), pno + 1);
  const sx = gray.width / pageW;
  const sy = gray.height / pageH;
  const raw = JSON.parse(readFileSync(join(dir, "ocr-jobs-cache-localv3", `p${String(pno).padStart(2, "0")}.json`), "utf8")) as {
    lines?: { text?: unknown; norm?: number[] }[];
  };
  const lines = (raw.lines ?? [])
    .filter((l) => !!l.norm && !!String(l.text ?? "").trim())
    .map((l) => ({
      text: String(l.text),
      box: [l.norm![0]! * pageW, l.norm![1]! * pageH, l.norm![2]! * pageW, l.norm![3]! * pageH] as number[],
    }));

  const mid = pageW / 2;
  const BUCKETS = [1, 2, 3, 4, 6, 8, 12, 20, Infinity];
  const hist = (gaps: Gap[]): Record<string, number> => {
    const h: Record<string, number> = {};
    let lo = 0;
    for (const hi of BUCKETS) {
      h[hi === Infinity ? `≥${lo}` : `${lo}-${hi - 1}`] = gaps.filter((g) => g.gapPx >= lo && g.gapPx < hi).length;
      lo = hi;
    }
    return h;
  };
  const quant = (xs: number[], q: number): number => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  };
  const category = (h: number, runs: number): string =>
    h <= 12 ? "singleLineMultiBox" : runs === 1 ? "zeroGap" : h > 25 ? "figureGiant" : "formulaSmallGap";

  const columns: unknown[] = [];
  const allIntra: Gap[] = [];
  const allInter: Gap[] = [];
  const overBands: { col: string; y0: number; y1: number; h: number; claims: number; runs: number; category: string; trunc: number; texts: string[] }[] = [];

  for (const col of [0, 1]) {
    const colX0 = col === 0 ? 0 : mid;
    const colX1 = col === 0 ? mid : pageW;
    const runs = splitInkLines(gray, pageW, pageH, [colX0, 0, colX1, pageH], {
      ...DEFAULT_SPLIT,
      minInkPx: 6,
      minGapPx: 0,
    }).map((r) => ({ y0: r.py0 / sy, y1: (r.py1 + 1) / sy, py0: r.py0, py1: r.py1 }));
    const colLines = lines.filter((l) => (l.box[0]! < mid) === (col === 0));
    const owners = runs.map((r) => {
      const cy = (r.y0 + r.y1) / 2;
      return colLines.filter((l) => cy >= l.box[1]! - 1 && cy <= l.box[3]! + 1);
    });
    const gaps: Gap[] = [];
    for (let i = 1; i < runs.length; i++) {
      const a = runs[i - 1]!;
      const b = runs[i]!;
      const oa = owners[i - 1]!;
      const ob = owners[i]!;
      gaps.push({
        gapPx: b.py0 - a.py1 - 1,
        gapPt: +(b.y0 - a.y1).toFixed(2),
        label: oa.length && ob.length ? (oa.some((x) => ob.includes(x)) ? "intra" : "inter") : "unlabeled",
        y: +a.y1.toFixed(1),
        textA: oa[0]?.text.slice(0, 14),
        textB: ob[0]?.text.slice(0, 14),
      });
    }
    const intra = gaps.filter((g) => g.label === "intra");
    const inter = gaps.filter((g) => g.label === "inter");
    allIntra.push(...intra);
    allInter.push(...inter);
    const bands = bandsForColumn(gray, pageW, pageH, colX0, colX1);
    const bandInfo = bands.map((b) => {
      const claims = colLines.filter((l) => {
        const cy = (l.box[1]! + l.box[3]!) / 2;
        return cy >= b.y0 && cy <= b.y1;
      });
      const swallowed = runs.filter((r) => (r.y0 + r.y1) / 2 >= b.y0 && (r.y0 + r.y1) / 2 <= b.y1).length;
      const h = +(b.y1 - b.y0).toFixed(1);
      return {
        y0: +b.y0.toFixed(1),
        y1: +b.y1.toFixed(1),
        h,
        claims: claims.length,
        runs: swallowed,
        category: category(h, swallowed),
        trunc: Math.max(0, claims.length - MAX_BAND_LINES),
        texts: claims.slice(0, 8).map((l) => l.text.slice(0, 16)),
      };
    });
    for (const b of bandInfo.filter((x) => x.claims > MAX_BAND_LINES)) overBands.push({ col: col === 0 ? "L" : "R", ...b });
    columns.push({
      col: col === 0 ? "L" : "R",
      runs: runs.length,
      v3lines: colLines.length,
      bands: bands.length,
      intra: { n: intra.length, histPx: hist(intra), median: quant(intra.map((g) => g.gapPx), 0.5), max: Math.max(0, ...intra.map((g) => g.gapPx)), lt8px: intra.filter((g) => g.gapPx < 8).length },
      inter: { n: inter.length, histPx: hist(inter), median: quant(inter.map((g) => g.gapPx), 0.5), min: quant(inter.map((g) => g.gapPx), 0), max: Math.max(0, ...inter.map((g) => g.gapPx)), lt8px: inter.filter((g) => g.gapPx < 8).length },
      unlabeled: gaps.filter((g) => g.label === "unlabeled").length,
    });
  }

  const intraPx = allIntra.map((g) => g.gapPx);
  const interPx = allInter.map((g) => g.gapPx);
  const byCategory: Record<string, { bands: number; trunc: number }> = {};
  for (const b of overBands) {
    const c = (byCategory[b.category] ??= { bands: 0, trunc: 0 });
    c.bands += 1;
    c.trunc += b.trunc;
  }
  const out = {
    doc,
    page: pno,
    dpi: 150,
    pxPerPt: +sy.toFixed(3),
    pageW,
    pageH,
    maxBandLines: MAX_BAND_LINES,
    columns,
    total: {
      intra: { n: allIntra.length, histPx: hist(allIntra), median: quant(intraPx, 0.5), max: Math.max(0, ...intraPx), lt8px: allIntra.filter((g) => g.gapPx < 8).length },
      inter: { n: allInter.length, histPx: hist(allInter), median: quant(interPx, 0.5), min: Math.min(Infinity, ...interPx), max: Math.max(0, ...interPx), lt8px: allInter.filter((g) => g.gapPx < 8).length },
      separableBySingleThreshold: Math.max(0, ...intraPx) < Math.min(Infinity, ...interPx),
    },
    overCapacityBands: overBands,
    byCategory,
    interGapsLt8: allInter.filter((g) => g.gapPx < 8).sort((a, b) => a.gapPx - b.gapPx),
  };
  const outPath = join(dir, `gap-roots.p${String(pno).padStart(2, "0")}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ page: pno, total: out.total, byCategory }, null, 1));
  console.log(`→ ${outPath}`);
}

main();