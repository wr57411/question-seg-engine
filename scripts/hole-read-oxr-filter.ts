// scripts/hole-read-oxr-filter.ts
/**
 * 问题⑤ 修复：OXR 候选过滤 v2 —— 洞带墨量归属门。
 * 规则：洞带内总墨量中，某块 y 域圈住的墨量 >=50% 才保留；其余丢弃。
 * 纯像素判据（pdftoppm 渲染 PGM 灰度图，零第三方依赖解析）。
 *
 * 判据演变（对抗性自查记录）：
 *   框相交（v1 内联版）-> 洞带重叠占比（否决：8 个用户已核验的 legit 块占比 <0.5，与肇事块同值）
 *   -> 块中心±tol（否决：p103_h0 legit 需 0.29×bbH 容差 vs 肇事块 0.28 倒挂，无分离面）
 *   -> 洞带墨量归属（41 洞重放：40 洞候选逐字节不变；肇事块 share 0.05/0.42 vs 真行 0.58）
 *
 * 背景：p027_h0 的「师提分」块框膨胀（横向 515/528 全宽、纵向跨进洞带）+ 同一 logo 行被读两遍
 * （帅提分/师提分），v1 框相交过滤放行 -> 候选带渗入。框会说谎，墨不会。
 *
 * 输入：oxr-v3-raw-batches/（manifest + batch*.raw.json）、oxr-v3-strips/*.pdf、holes-v3.json、
 *       readings-v3.json（洞 id 与顺序）、oxr-v3-filtered.json（v1 对照）
 * 输出：hole-read/oxr-v3-filtered-v2.json（v2 候选 + 与 v1 差异 + 每块 share 审计）
 * 用法：npx tsx scripts/hole-read-oxr-filter.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "data/out", "答案册-合订本", "hole-read");
const DPI = 300;
const RATIO = 0.5;
const INK = 128;
const S = DPI / 72;

const stripSize = (pdf: string): [number, number] => {
  const out = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  const m = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(out);
  if (!m) throw new Error("pdfinfo 解析失败: " + pdf);
  return [Number(m[1]!), Number(m[2]!)];
};

/** 渲染 strip 为 PGM 并按行统计墨量（P5 二进制灰度，零依赖解析）。 */
const rowInkMass = (pdf: string, cachePrefix: string): { mass: number[]; h: number } => {
  const pgm = cachePrefix + ".pgm";
  // strip PDF 是不可变输入（发 OXR 的原件拷贝），skip-if-exists 缓存安全
  if (!existsSync(pgm)) {
    mkdirSync(join(cachePrefix, ".."), { recursive: true });
    execFileSync("pdftoppm", ["-gray", "-r", String(DPI), "-singlefile", pdf, cachePrefix], { stdio: "pipe" });
  }
  const buf = readFileSync(pgm);
  let off = 0;
  const tok = (): string => {
    for (;;) {
      while (off < buf.length && /\s/.test(String.fromCharCode(buf[off]!))) off++;
      if (buf[off] === 0x23) { while (off < buf.length && buf[off] !== 0x0a) off++; continue; }
      break;
    }
    const st = off;
    while (off < buf.length && !/\s/.test(String.fromCharCode(buf[off]!))) off++;
    return buf.subarray(st, off).toString("latin1");
  };
  const magic = tok();
  if (magic !== "P5") throw new Error("PGM 魔数异常: " + pgm);
  const w = Number(tok());
  const h = Number(tok());
  tok(); // maxval
  off += 1; // maxval 后单个空白字节
  const px = buf.subarray(off, off + w * h);
  const mass: number[] = new Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (px[y * w + x]! < INK) c++;
    mass[y] = c;
  }
  return { mass, h };
};

const holes = JSON.parse(readFileSync(join(DIR, "holes-v3.json"), "utf8")) as { id: string; bbox: number[] }[];
const recIds = (JSON.parse(readFileSync(join(DIR, "readings-v3.json"), "utf8")) as { id: string }[]).map((r) => r.id);
const v1 = JSON.parse(readFileSync(join(DIR, "oxr-v3-filtered.json"), "utf8")) as Record<string, string>;
const mani = JSON.parse(readFileSync(join(DIR, "oxr-v3-raw-batches/manifest.json"), "utf8")) as { batch: number; holes: string[] }[];
const raws = new Map<string, { page_size: { w: number; h: number }; blocks: { bbox: number[]; content: string }[] }>();
for (const b of mani) {
  const d = JSON.parse(readFileSync(join(DIR, "oxr-v3-raw-batches/batch" + b.batch + ".raw.json"), "utf8"));
  b.holes.forEach((hid, i) => { if (!raws.has(hid)) raws.set(hid, d.pages[i]); });
}

const holeMap = new Map(holes.map((h) => [h.id, h]));
const candidates: Record<string, string> = {};
const audit: Record<string, { content: string; share: number; keep: boolean }[]> = {};
let diffCount = 0;

for (const hid of recIds) {
  const h = holeMap.get(hid)!;
  const bb = h.bbox as [number, number, number, number];
  const bbH = bb[3] - bb[1];
  const [sw, sh] = stripSize(join(DIR, "oxr-v3-strips/" + hid + ".pdf"));
  const padY = (sh - bbH) / 2;
  const band0 = padY, band1 = padY + bbH;
  const pg = raws.get(hid)!;
  const s = pg.page_size.w / sw;
  const { mass, h: H } = rowInkMass(join(DIR, "oxr-v3-strips/" + hid + ".pdf"), join(DIR, "oxr-v3-strips-png/" + hid));
  const bandMass = mass.slice(Math.floor(band0 * S), Math.ceil(band1 * S)).reduce((a, b) => a + b, 0);
  const keep: { content: string; y0: number }[] = [];
  audit[hid] = [];
  for (const blk of pg.blocks) {
    const y0 = blk.bbox[1]! / s, y1 = blk.bbox[3]! / s;
    const a = Math.max(0, Math.floor(y0 * S));
    const b = Math.min(H, Math.max(a + 1, Math.ceil(y1 * S)));
    const bA = Math.max(a, Math.floor(band0 * S));
    const bB = Math.min(b, Math.max(bA, Math.ceil(band1 * S)));
    const selBand = mass.slice(bA, bB).reduce((x, y) => x + y, 0);
    const share = bandMass > 0 ? selBand / bandMass : (bB > bA ? 1 : 0);
    const ok = share >= RATIO;
    audit[hid]!.push({ content: blk.content, share: Math.round(share * 100) / 100, keep: ok });
    if (ok) keep.push({ content: blk.content, y0: blk.bbox[1]! });
  }
  const cand = keep.sort((x, y) => x.y0 - y.y0).map((z) => z.content).join(" ");
  candidates[hid] = cand;
  if (cand !== (v1[hid] ?? "")) {
    diffCount++;
    console.log("DIFF " + hid + ":");
    console.log("  v1=" + JSON.stringify(v1[hid] ?? ""));
    console.log("  v2=" + JSON.stringify(cand));
  }
}

writeFileSync(join(DIR, "oxr-v3-filtered-v2.json"), JSON.stringify({ ratio: RATIO, candidates, audit }, null, 1));
console.log("候选变化 " + diffCount + "/" + recIds.length);
console.log("-> hole-read/oxr-v3-filtered-v2.json");
