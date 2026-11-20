// scripts/table-v3-full.ts
/**
 * M3（no-MinerU 生产化）：**全册** V3 表格三分流产物构建器。
 *
 * 输入：笔记本 broaden_v3 全结构 res JSON（tmp/m3-table-v3/<dNN>/pNN_res.json，含 table_res_list）
 *       + 原卷页图（data/out/<doc>/pages/）+ OXR 骨架快照（stages.json，取页尺寸/§90 合成表框/漏泄行）。
 * 输出：data/out/<doc>/table-v3.json + table-crops/*.png + tmp/m3-table-v3/<dNN>-report.json。
 * 消费方：scripts/export-stages.ts 的 insertTableV3Regions（覆盖+插入双模式）。
 *
 * 三分流（B-40 管家拍板，与 scripts/table-v3-sample.ts 同口径）：
 * - 纯文本表（无 <img> 无 $）→ V3 pred_html（class=text，G3：缺 <table> 响亮中止）；
 * - 含图**或含 $ 公式** → 整表截图（class=image，ffmpeg -vf crop 从页图新裁 bbox+3px，禁 sips，
 *   cropSize 从 PNG IHDR 实测自检，L7）；
 * - 无边框 → G1 墨迹守卫 hRunW<0.3 跳过（class=borderless，不画臆造格网；判据复用 table-guard，
 *   灰度来自原卷页图 ffmpeg PGM，独立于 V3 输出）。
 *
 * V3 漏检兜底（曲线运动 index3 实测：原卷有框表但 V3 tables=0）：
 * 骨架 §90 合成表框无 V3 entry 匹配时，用 G1 守卫复核合成框——有框线且 html 含 markdown 图语法/$
 * ⇒ class=image 整表截图（无损侧）；bbox=合成框 ∪ 表顶漏泄行组（漏泄行是表内图格的 markdown 残字，
 * 实测在真表内却在合成框外）；note 写明来源，不冒充 V3 检出。守卫判无边框 ⇒ 不出 entry（行文本照常）。
 *
 * 页号口径：res 文件 pNN = 1 基 = stages index+1（R5 已抽页核对）；构建器逐页再自检：
 * 页图 IHDR == res 坐标域 + R5 页号守卫（scripts/r5-align.ts）——严判据「V3 首行落在骨架前 3 个
 * text 块」；页眉碎屑假红时退回整页内容重合（≥5 条长行，实测相邻页 ≤3），不符响亮中止（不静默错页）。
 *
 * 用法：npx tsx scripts/table-v3-full.ts <docId> <resDir>
 * 例：npx tsx scripts/table-v3-full.ts "物理_教材基础练 曲线运动-OXR" tmp/m3-table-v3/d08
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePgm, pngSizeFromHeader } from "./export-stages.js";
import { checkR5Alignment } from "./r5-align.js";
import { G1_LINE_THRESHOLD, grayCacheKey, isBorderlessByInk, longestHRunRatio, longestVRunRatio } from "./table-guard.js";

interface ResJson {
  width: number;
  height: number;
  parsing_res_list?: { block_label: string; block_bbox: number[] }[];
  table_res_list?: { pred_html?: string }[];
  overall_ocr_res?: { rec_texts?: string[] };
}
interface SnapBlock { i: number; kind: string; bbox: number[]; text: string; html?: string; leakCoveredBy?: number }
interface SnapPage { index: number; width: number; height: number; blocks: SnapBlock[] }
interface Entry {
  page: number;
  bbox: number[];
  class: "text" | "image" | "borderless";
  source: "v3";
  guard: { hRunW: number; vRunH: number };
  html?: string;
  crop?: string;
  cropSize?: [number, number];
  note?: string;
}

const docArg = process.argv[2];
const resArg = process.argv[3];
if (!docArg || !resArg) {
  console.error("用法：npx tsx scripts/table-v3-full.ts <docId> <resDir>");
  process.exit(1);
}
const doc: string = docArg;
const resDir: string = resArg;
const outDir = join("data", "out", doc);
const snap = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as { pages: SnapPage[] };
const grayDir = join("tmp", "m3-table-v3", "gray");
mkdirSync(grayDir, { recursive: true });
mkdirSync(join(outDir, "table-crops"), { recursive: true });

const isLeakText = (t: string) => t.trimStart().startsWith("![") || t.includes("](http");

/** 页图路径：三种历史命名（3 位/2 位/不补零）都认，缺则响亮报错 */
function pageImageOf(index: number): string {
  const n = index + 1;
  const candidates = [
    join(outDir, "pages", `page-${String(n).padStart(3, "0")}.png`),
    join(outDir, "pages", `page-${String(n).padStart(2, "0")}.png`),
    join(outDir, "pages", `page-${n}.png`),
  ];
  const p = candidates.find((c) => existsSync(c));
  if (!p) throw new Error(`${doc} index${index} 页图缺失：${candidates.join(" / ")}`);
  return p;
}

/** 原卷页图 → PGM 灰度（ffmpeg，禁 sips）；G1 判据的独立墨迹源 */
function grayOf(index: number, pagePng: string): ReturnType<typeof parsePgm> {
  // 键必须无碰撞：CJK docId 用 \w 折叠会撞名（M7-C ③ 根因），改用 grayCacheKey。
  const pgm = join(grayDir, `${grayCacheKey(doc)}-p${String(index + 1).padStart(3, "0")}.pgm`);
  if (!existsSync(pgm)) {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", pagePng, "-vf", "format=gray", "-pix_fmt", "gray", pgm], { stdio: "pipe" });
  }
  return parsePgm(new Uint8Array(readFileSync(pgm)));
}

function cropTable(pagePng: string, bboxPx: number[], cropRel: string): [number, number] {
  const [pw, ph] = pngSizeFromHeader(new Uint8Array(readFileSync(pagePng)));
  const x0 = Math.max(0, Math.floor(bboxPx[0]! - 3));
  const y0 = Math.max(0, Math.floor(bboxPx[1]! - 3));
  const x1 = Math.min(pw, Math.ceil(bboxPx[2]! + 3));
  const y1 = Math.min(ph, Math.ceil(bboxPx[3]! + 3));
  const abs = join(outDir, cropRel);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", pagePng, "-vf", `crop=${x1 - x0}:${y1 - y0}:${x0}:${y0}`, abs], { stdio: "pipe", timeout: 60_000 });
  const size = pngSizeFromHeader(new Uint8Array(readFileSync(abs)));
  if (size[0] !== x1 - x0 || size[1] !== y1 - y0) {
    throw new Error(`${doc} ${cropRel} 裁图 IHDR 自检失败：${size} ≠ 期望 [${x1 - x0},${y1 - y0}]（L7 不静默）`);
  }
  return size;
}

const iou = (a: number[], b: number[]) => {
  const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = ix * iy;
  const union = (a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter;
  return union > 0 ? inter / union : 0;
};

const entries: Entry[] = [];
const report: {
  doc: string; resDir: string;
  pages: { index: number; v3Tables: number; r5: "strict" | "overlap"; classes: string[]; fallback: string[]; guardSkipped: string[] }[];
  counts: { text: number; image: number; borderless: number; fallbackImage: number; guardSkipped: number };
} = { doc, resDir, pages: [], counts: { text: 0, image: 0, borderless: 0, fallbackImage: 0, guardSkipped: 0 } };

const resFiles = readdirSync(resDir).filter((f) => /^p\d+_res\.json$/.test(f)).sort((a, b) => Number(a.slice(1).split("_")[0]) - Number(b.slice(1).split("_")[0]));
if (!resFiles.length) throw new Error(`${resDir} 无 pNN_res.json`);

for (const f of resFiles) {
  const nn = Number(f.slice(1).split("_")[0]);
  const index = nn - 1;
  const page = snap.pages.find((p) => p.index === index);
  if (!page) throw new Error(`${doc} 快照缺页 index=${index}（res ${f}）`);
  const res = JSON.parse(readFileSync(join(resDir, f), "utf8")) as ResJson;
  const pagePng = pageImageOf(index);
  const [pw, ph] = pngSizeFromHeader(new Uint8Array(readFileSync(pagePng)));
  if (pw !== res.width || ph !== res.height) {
    throw new Error(`${f} 坐标域 ${res.width}x${res.height} ≠ 页图 ${pw}x${ph}（R7 错页/错域，中止）`);
  }
  // R5 逐页页号守卫（纯函数 scripts/r5-align.ts）：严判据=首行落骨架前 3 text 块；
  // 页眉碎屑（OXR 没读的装饰头）致严判据假红时退回整页内容重合（≥5 条长行）。防 0/1 基错页静默。
  const r5 = checkR5Alignment({
    v3Lines: res.overall_ocr_res?.rec_texts ?? [],
    skeletonTexts: page.blocks.filter((b) => b.kind === "text").map((b) => b.text),
  });
  if (!r5.ok) throw new Error(`${f} R5 首行对齐失败：${r5.reason}`);
  const gray = grayOf(index, pagePng);
  const sx = page.width / res.width;
  const sy = page.height / res.height;
  const toPt = (b: number[]) => [b[0]! * sx, b[1]! * sy, b[2]! * sx, b[3]! * sy];

  const v3Boxes = (res.parsing_res_list ?? []).filter((b) => b.block_label === "table").map((b) => b.block_bbox);
  const htmls = res.table_res_list ?? [];
  if (v3Boxes.length !== htmls.length) {
    throw new Error(`${f} table 块数 ${v3Boxes.length} ≠ table_res_list ${htmls.length}（对应关系不明，中止）`);
  }
  const pageRep: (typeof report.pages)[number] = { index, v3Tables: v3Boxes.length, r5: r5.mode, classes: [], fallback: [], guardSkipped: [] };
  let tIdx = 0;
  for (let k = 0; k < v3Boxes.length; k++) {
    const bboxPx = v3Boxes[k]!;
    const html = htmls[k]?.pred_html ?? "";
    const hRunW = longestHRunRatio(gray, bboxPx as [number, number, number, number], G1_LINE_THRESHOLD);
    const vRunH = longestVRunRatio(gray, bboxPx as [number, number, number, number], G1_LINE_THRESHOLD);
    const guard = { hRunW: Number(hRunW.toFixed(3)), vRunH: Number(vRunH.toFixed(3)) };
    const cls: Entry["class"] = isBorderlessByInk(hRunW) ? "borderless" : /<img/i.test(html) || html.includes("$") ? "image" : "text";
    const e: Entry = { page: index, bbox: toPt(bboxPx), class: cls, source: "v3", guard };
    if (cls === "text") {
      if (!html.includes("<table")) throw new Error(`${f} t${k} text 路由缺 pred_html（G3 门）⇒ 中止`);
      e.html = html;
    }
    if (cls === "image") {
      const rel = join("table-crops", `p${String(nn).padStart(3, "0")}-t${tIdx}.png`);
      e.crop = rel;
      e.cropSize = cropTable(pagePng, bboxPx, rel);
    }
    entries.push(e);
    pageRep.classes.push(cls);
    report.counts[cls]++;
    tIdx++;
  }

  // ── V3 漏检兜底：§90 合成表框无 V3 entry 匹配 ⇒ G1 复核 + 整表截图（无损侧） ──
  const lineHs = page.blocks.filter((b) => b.kind === "text").map((b) => b.bbox[3]! - b.bbox[1]!).sort((a, b) => a - b);
  const medH = lineHs.length ? lineHs[Math.floor(lineHs.length / 2)]! : 10;
  for (const b of page.blocks) {
    if (b.kind !== "table") continue;
    if (entries.some((e) => e.page === index && iou(e.bbox, b.bbox) >= 0.5)) continue;
    const bboxPx = [b.bbox[0]! / sx, b.bbox[1]! / sy, b.bbox[2]! / sx, b.bbox[3]! / sy];
    const hRunW = longestHRunRatio(gray, bboxPx as [number, number, number, number], G1_LINE_THRESHOLD);
    const vRunH = longestVRunRatio(gray, bboxPx as [number, number, number, number], G1_LINE_THRESHOLD);
    if (isBorderlessByInk(hRunW)) {
      pageRep.guardSkipped.push(`i${b.i}(hRunW=${hRunW.toFixed(3)})`);
      report.counts.guardSkipped++;
      continue;
    }
    // 表顶漏泄行组并入 bbox：markdown 残字行是表内图格的描述（实测在真表内、合成框外）
    const union = [...b.bbox];
    const leaks = page.blocks.filter((x) => x.kind === "text" && (isLeakText(x.text) || x.leakCoveredBy !== undefined));
    for (const x of leaks) {
      const ox = Math.min(x.bbox[2]!, union[2]!) - Math.max(x.bbox[0]!, union[0]!);
      const xw = Math.min(x.bbox[2]! - x.bbox[0]!, union[2]! - union[0]!);
      const aboveNear = x.bbox[3]! <= union[1]! + 0.5 * medH && x.bbox[1]! >= union[1]! - 6 * medH;
      const inside = x.bbox[1]! >= union[1]! && x.bbox[3]! <= union[3]!;
      if (ox >= 0.7 * xw && (aboveNear || inside)) {
        union[0] = Math.min(union[0]!, x.bbox[0]!);
        union[1] = Math.min(union[1]!, x.bbox[1]!);
        union[2] = Math.max(union[2]!, x.bbox[2]!);
        union[3] = Math.max(union[3]!, x.bbox[3]!);
      }
    }
    const unionPx = [union[0]! / sx, union[1]! / sy, union[2]! / sx, union[3]! / sy];
    const rel = join("table-crops", `p${String(nn).padStart(3, "0")}-t${tIdx}.png`);
    const e: Entry = {
      page: index, bbox: union, class: "image", source: "v3",
      guard: { hRunW: Number(hRunW.toFixed(3)), vRunH: Number(vRunH.toFixed(3)) },
      crop: rel,
      cropSize: cropTable(pagePng, unionPx, rel),
      note: `V3 未检出表；§90 合成框 i${b.i} + G1 墨迹守卫 hRunW=${hRunW.toFixed(3)} 证实有框表；含图/公式走整表截图（无损侧）；bbox=合成框∪表顶漏泄行组`,
    };
    entries.push(e);
    pageRep.classes.push("image(fallback)");
    pageRep.fallback.push(`i${b.i}`);
    report.counts.fallbackImage++;
    tIdx++;
  }
  report.pages.push(pageRep);
  console.log(`${f} ⇒ index${index} v3表=${v3Boxes.length} [${pageRep.classes.join(",")}]` + (pageRep.fallback.length ? ` 兜底=${pageRep.fallback.join(",")}` : "") + (pageRep.guardSkipped.length ? ` 守卫跳过=${pageRep.guardSkipped.join(",")}` : ""));
}

entries.sort((a, b) => a.page - b.page || a.bbox[1]! - b.bbox[1]!);
writeFileSync(join(outDir, "table-v3.json"), JSON.stringify({ version: 1, source: "v3", generatedBy: "scripts/table-v3-full.ts", tables: entries }, null, 1));
writeFileSync(join("tmp", "m3-table-v3", `${resDir.split("/").pop()}-report.json`), JSON.stringify(report, null, 1));
console.log(`TABLE_V3_FULL_DONE ${doc}：text=${report.counts.text} image=${report.counts.image} borderless=${report.counts.borderless} 兜底image=${report.counts.fallbackImage} 守卫跳过=${report.counts.guardSkipped} ⇒ ${join(outDir, "table-v3.json")}`);