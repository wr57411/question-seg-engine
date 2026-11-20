// scripts/export-gold-crops.ts
/**
 * 巨带裁图回退行的**快速裁图导出**（只读，零 API，不进 check）——供独立 rec 金标重读。
 *
 * 为什么不用 audit-giant-crop 的 pdftoppm 逐行裁：那条路径每次裁切都重解析整本 187 页 PDF，
 * 全册 ~6700 回退行会跑数小时。本脚本直接用 data/out/<doc>/pages/ 里现成的页图（~130DPI），
 * 按 scale=imgW/pageW 把 V3 框(pt)换算成像素，ffmpeg 一次裁出（每页只读一次图）。
 *
 * 裁切口径与 audit-giant-crop 完全一致：±2pt padding、floor/ceil 外扩、钳制到图界。
 * 命名 {id}-{page+1:03d}.png 与审计一致 ⇒ rec-batch-laptop.py 的 hid=name.rsplit("-",1)[0] 对得上。
 *
 * 用法：npx tsx scripts/export-gold-crops.ts [--doc ..] [--pages 76,127]
 * 产物：data/out/<doc>/giant-crop/crops/*.png
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Box } from "./paddle-client.js";

/** V3 框(pt) → 页图像素裁切矩形。±2pt padding，floor/ceil 外扩，钳制到 [0,img-1]，w/h≥1。 */
export function cropRect(v3: Box, scale: number, imgW: number, imgH: number): { x: number; y: number; w: number; h: number } {
  const x0 = Math.max(0, Math.floor((v3[0] - 2) * scale));
  const x1 = Math.min(imgW - 1, Math.ceil((v3[2] + 2) * scale));
  const y0 = Math.max(0, Math.floor((v3[1] - 2) * scale));
  const y1 = Math.min(imgH - 1, Math.ceil((v3[3] + 2) * scale));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * 页图路径解析（M4）：不同快照命名不一——答案册 page-001.png（三位）/
 * 曲线运动-OXR page-01.png（两位）/ 万有引力-OXR page-1.png（无填充）。
 * pno 为 0 基页索引，页图 1 基。按候选序取第一个存在的；全缺返回 null（调用方显式报错）。
 */
export function resolvePageImage(pagesDir: string, pno: number): string | null {
  const n = pno + 1;
  for (const name of [`page-${String(n).padStart(3, "0")}.png`, `page-${String(n).padStart(2, "0")}.png`, `page-${n}.png`]) {
    const p = join(pagesDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (k: string): string | null => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

function imgSize(path: string): { w: number; h: number } {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], { encoding: "utf8" }).trim();
  const [w, h] = out.split(",").map(Number);
  if (!w || !h) throw new Error(`ffprobe 读不到尺寸: ${path} → "${out}"`);
  return { w, h };
}

function main(): void {
  const doc = arg("doc") ?? "答案册-合订本";
  const dir = join(process.cwd(), "data/out", doc);
  const stages = JSON.parse(readFileSync(join(dir, "stages.json"), "utf8")) as { pages: { width: number; height: number }[] };
  const pagesFilter = arg("pages")?.split(",").map(Number).filter(Number.isFinite) ?? null;
  const cropDir = join(dir, "giant-crop", "crops");
  mkdirSync(cropDir, { recursive: true });

  const files = readdirSync(dir).filter((f) => /^giant-crop\.p\d+\.json$/.test(f)).sort();
  let total = 0;
  for (const f of files) {
    const pno = Number(f.match(/^giant-crop\.p(\d+)\.json$/)![1]);
    if (pagesFilter && !pagesFilter.includes(pno)) continue;
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { victims?: { id: string; v3box: Box }[] };
    const victims = j.victims ?? [];
    if (!victims.length) continue;
    const imgPath = resolvePageImage(join(dir, "pages"), pno);
    if (!imgPath) throw new Error(`页图缺失: ${dir}/pages page-${pno + 1}（三位/两位/无填充候选全缺）`);
    const { w: imgW, h: imgH } = imgSize(imgPath);
    const scale = imgW / stages.pages[pno]!.width;
    for (const v of victims) {
      const r = cropRect(v.v3box, scale, imgW, imgH);
      const out = join(cropDir, `${v.id}-${String(pno + 1).padStart(3, "0")}.png`);
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", imgPath, "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y}`, out], { stdio: "pipe" });
      total++;
    }
    console.log(`p${pno}: ${victims.length} crops (scale=${scale.toFixed(3)})`);
  }
  console.log(`EXPORT_DONE ${total} crops → ${cropDir}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) main();