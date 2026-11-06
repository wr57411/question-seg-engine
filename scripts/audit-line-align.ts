// scripts/audit-line-align.ts
/**
 * G1 基线测量器：V3 行框 ↔ 墨迹行带 的配对率（2026-11-07 用户目标「尽可能提高，目标 100%」）。
 *
 * 方法：按栏切墨迹行带（`splitInkLines` 水平投影，真值位置）→ 每条 V3 行框在同栏内
 * 配「y 重叠最大」的墨迹带 → dy = 框中心 − 带中心。只读审计，不写快照、不入 check、零 API。
 *
 * 用法：npm run audit:align -- [--doc 答案册-合订本] [--pages 74,91,150,159] [--dpi 150]
 * 产物：data/out/<doc>/line-align-baseline.json（含逐行 dy，可复算）
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderGrayPage } from "./audit-hole-geometry.js";
import { splitInkLines, DEFAULT_SPLIT } from "./ink-lines.js";

type Box = [number, number, number, number];
const ROOT = join(import.meta.dirname, "..");

interface V3Line {
  text: string;
  norm: Box;
}

interface LineRec {
  page: number;
  text: string;
  boxY0: number;
  boxY1: number;
  bandY0: number | null;
  bandY1: number | null;
  dy: number | null; // 框中心 − 带中心（pt）
  overlapRatio: number; // y 重叠 / 框高
}

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const doc = arg("--doc") ?? "答案册-合订本";
const pagesArg = arg("--pages");
const outDir = join(ROOT, "data", "out", doc);
const stages = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as {
  pages: { index: number; width: number; height: number }[];
};

/** 按栏切墨迹行带：栏 x 区间 = 该栏全部行框的 [min x0, max x1]（窄带过滤后）。 */
function columnBands(img: ReturnType<typeof renderGrayPage>, pageW: number, pageH: number, colX0: number, colX1: number) {
  const raw = splitInkLines(img, pageW, pageH, [colX0, 0, colX1, pageH], { ...DEFAULT_SPLIT, minInkPx: 6 });
  // 碎带过滤：高 < 3pt 的非正文带（装饰点、页码边缘）不参与配对
  const sy = img.height / pageH;
  return raw
    .filter((r) => (r.py1 - r.py0 + 1) / sy >= 3)
    .map((r) => ({ y0: r.py0 / sy, y1: (r.py1 + 1) / sy, inkPx: r.inkPx }));
}

function main(): void {
  const pages = pagesArg
    ? pagesArg.split(",").map(Number)
    : // 无 --pages 时自动取有 OCR 缓存的页
      readdirSync(join(outDir, "ocr-jobs-cache"))
        .map((f) => /^p(\d+)\.json$/.exec(f)?.[1])
        .filter((x): x is string => !!x)
        .map(Number);
  const recs: LineRec[] = [];
  let total = 0;
  let noBand = 0;
  let bandConflicts = 0;

  for (const pno of pages) {
    const meta = stages.pages[pno];
    if (!meta) continue;
    const cacheFile = join(outDir, "ocr-jobs-cache", `p${String(pno).padStart(2, "0")}.json`);
    let lines: V3Line[] = [];
    try {
      lines = (JSON.parse(readFileSync(cacheFile, "utf8")).lines ?? []).filter((l: any) => l.norm && (l.text ?? "").trim());
    } catch {
      continue;
    }
    if (!lines.length) continue;
    const gray = renderGrayPage(join(outDir, "origin.pdf"), pno + 1);
    const mid = meta.width / 2;
    for (const col of [0, 1]) {
      const colLines = lines.filter((l) => (l.norm[0] * meta.width < mid) === (col === 0));
      if (!colLines.length) continue;
      const colX0 = Math.min(...colLines.map((l) => l.norm[0] * meta.width));
      const colX1 = Math.max(...colLines.map((l) => l.norm[2] * meta.width));
      const bands = columnBands(gray, meta.width, meta.height, colX0, colX1);
      const bandHits = new Map<number, number>();
      for (const l of colLines) {
        const boxY0 = l.norm[1] * meta.height;
        const boxY1 = l.norm[3] * meta.height;
        let best = -1;
        let bestOv = 0;
        let ties = 0;
        bands.forEach((b, bi) => {
          const ov = Math.min(boxY1, b.y1) - Math.max(boxY0, b.y0);
          if (ov > bestOv) {
            bestOv = ov;
            best = bi;
            ties = 1;
          } else if (ov === bestOv && ov > 0) ties++;
        });
        total++;
        if (best < 0 || bestOv <= 0) {
          noBand++;
          recs.push({ page: pno, text: l.text.slice(0, 24), boxY0, boxY1, bandY0: null, bandY1: null, dy: null, overlapRatio: 0 });
          continue;
        }
        if (ties > 1) bandConflicts++;
        const b = bands[best]!;
        const boxCY = (boxY0 + boxY1) / 2;
        const bandCY = (b.y0 + b.y1) / 2;
        const boxH = boxY1 - boxY0;
        bandHits.set(best, (bandHits.get(best) ?? 0) + 1);
        recs.push({
          page: pno,
          text: l.text.slice(0, 24),
          boxY0,
          boxY1,
          bandY0: b.y0,
          bandY1: b.y1,
          dy: boxCY - bandCY,
          overlapRatio: boxH > 0 ? bestOv / boxH : 0,
        });
      }
    }
  }

  const dys = recs.filter((r) => r.dy !== null).map((r) => r.dy!);
  const withInk = dys.length;
  const a2 = dys.filter((d) => Math.abs(d) <= 2).length;
  const a5 = dys.filter((d) => Math.abs(d) > 2 && Math.abs(d) <= 5).length;
  const a8 = dys.filter((d) => Math.abs(d) > 5 && Math.abs(d) <= 8).length;
  const over8 = dys.filter((d) => Math.abs(d) > 8).length;
  const summary = {
    doc,
    pages: pages.length,
    totalLines: total,
    noBand,
    bandConflicts,
    aligned2pt: a2,
    aligned5pt: a2 + a5,
    aligned8pt: a2 + a5 + a8,
    over8pt: over8,
    alignRate2pt: +((a2 / Math.max(1, total)) * 100).toFixed(1),
    alignRate5pt: +(((a2 + a5) / Math.max(1, total)) * 100).toFixed(1),
    alignRate8pt: +(((a2 + a5 + a8) / Math.max(1, total)) * 100).toFixed(1),
  };
  console.log(JSON.stringify(summary, null, 1));
  writeFileSync(join(outDir, "line-align-baseline.json"), JSON.stringify({ summary, recs }, null, 1));
  console.log(`→ data/out/${doc}/line-align-baseline.json`);
}

main();
