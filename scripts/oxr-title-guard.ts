// scripts/oxr-title-guard.ts —— OXR 切换前置：标题级守卫 + 逐条核对的补识清单
//
// 背景（M5-C，tmp/m5-answer-guard/real-loss.json）：答案册-合订本 OXR 解析件比旧 MinerU
// 生产件少 13 页内容 —— 6 处内容标题（第N节 / 专题 / 全章综合测试 / 页首「必刷知识·」）、
// 3 处实质散文行（p14/17/84）、封面标语与栏目标题（p1/101/111/140）。
// 红线「真丢 > 0 不切换」⇒ 切换前必须把这些行补回来。
//
// 两条来源、一条产物：
//   1. **标题守卫**（通用、高精度）：V3（本地 PP-StructureV3 行框）里匹配内容标题形态、
//      置信度 ≥0.98、且 OXR 页文本归一化后不含该标题的行 ⇒ 判为丢标题。
//      实测全册 187 页恰好命中 6 处真丢标题（p79/110/139/162/163/170），零误报。
//   2. **curated 补识**（逐条回原卷核对）：散文/封面/标签不走通用判据（通用判据在散文上
//      误报极高——V3 与 OXR 的行切分/数学记号不同，实测朴素文本匹配全册误报 3968 行），
//      改由 CURATED_RECOVERY 显式列出（文本=原卷核对、bbox=V3 行框换算 PDF 点）。
//
// 产物 `title-guard.json` 由 export-stages 消费（产物缺失 ⇒ 快照逐字节不变）。
// 判据与实现不同源：V3 行框/文本独立于 OXR；curated 文本逐条回原卷页图核对。
//
// 运行：
//   npx tsx scripts/oxr-title-guard.ts <docId> <oxrLayoutPath> [--v3-dir <dir>] [--out <path>]
// 例：
//   npx tsx scripts/oxr-title-guard.ts "答案册-合订本-OXR" \
//     "data/out/答案册-合订本-OXR/layout.json" \
//     --v3-dir "data/out/答案册-合订本/ocr-jobs-cache-localv3"

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface V3Line {
  text: string;
  score?: number;
  bbox: number[];
}

export interface V3Page {
  page_px?: number[];
  lines?: V3Line[];
}

export interface TitleGuardEntry {
  /** 1 基物理页号（与 tmp/m5-answer-guard/real-loss.json 同口径） */
  page: number;
  /** PDF 点 [x0,y0,x1,y1]（OXR layout 同坐标系） */
  bbox: [number, number, number, number];
  /** 文本（curated=原卷核对；guard=V3 原文） */
  text: string;
  origin: "guard" | "curated";
  reason: string;
  /** 类别：title=内容标题 / prose=散文 / label=栏目标签 / cover=封面 */
  category: "title" | "prose" | "label" | "cover";
  score?: number;
  /** 装饰性（封面标语/栏目标签）—— 报告里与实质内容分开统计 */
  decor?: boolean;
}

/** 内容标题形态：节标题 / 专题 / 全章综合测试 / 页首「必刷知识·」。
 *  刻意**不含**栏目标签（刷小题/提分/真题…）——它们是 logo 文字，通用判据会把
 *  「刷基础」对 OXR 的「基础」误判成丢失（实测 15 处误报），故走 curated。 */
export const CONTENT_TITLE_RE: RegExp[] = [
  /^第\s*[一二三四五六七八九十0-9]{1,3}\s*节\s*\S/,
  /^专题\s*\S/,
  /^全章综合测试/,
  /^必刷知识\s*[·•]/,
];

/** V3 行置信度下限：低于此不再当「守卫」证据（curated 不设下限，逐条已核对）。 */
export const GUARD_MIN_SCORE = 0.98;

export function normalizeGuardText(s: string): string {
  return s.replace(/[\s·•]/g, "");
}

export function isContentTitleLine(text: string): boolean {
  const t = text.trim();
  return CONTENT_TITLE_RE.some((re) => re.test(t));
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** OXR layout 单页的纯文本（para_blocks → lines → spans 拼接），用于归一化包含判据。 */
export function layoutPageText(page: unknown): string {
  const rec = asRecord(page);
  let out = "";
  for (const pbRaw of asArray(rec.para_blocks)) {
    for (const lnRaw of asArray(asRecord(pbRaw).lines)) {
      for (const spRaw of asArray(asRecord(lnRaw).spans)) {
        out += String(asRecord(spRaw).content ?? "");
      }
    }
  }
  return out;
}

function layoutPageSize(page: unknown): [number, number] {
  const size = asArray(asRecord(page).page_size);
  return [asNumber(size[0]) ?? 596, asNumber(size[1]) ?? 890.3];
}

/** V3 行 bbox（V3 源图像素）→ PDF 点：以页宽 596pt 与目标页高为锚（同一份卷纸宽恒定）。 */
export function v3LineToPt(
  line: { bbox: number[] },
  pagePx: number[],
  targetPageSize: [number, number],
): [number, number, number, number] {
  const w = pagePx[0] ?? 0;
  const h = pagePx[1] ?? 0;
  const [targetW, targetH] = targetPageSize;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = line.bbox as number[];
  const rx = (n: number): number => (w > 0 ? Number(((n / w) * targetW).toFixed(1)) : 0);
  const ry = (n: number): number => (h > 0 ? Number(((n / h) * targetH).toFixed(1)) : 0);
  return [rx(x0), ry(y0), rx(x1), ry(y1)];
}

export interface GuardStats {
  pages: number;
  candidates: number;
  curated: number;
  curatedSkipped: number;
}

export interface GuardResult {
  entries: TitleGuardEntry[];
  stats: GuardStats;
}

/**
 * 标题守卫：逐页比对 OXR 页文本与 V3 行。
 * 判据（AND，最严）：内容标题形态 + score ≥ 0.98 + OXR 归一化文本不含该标题。
 */
export function detectTitleGaps(layoutRaw: unknown, v3Pages: V3Page[]): GuardResult {
  const root = asRecord(layoutRaw);
  const pages = asArray(root.pdf_info);
  const entries: TitleGuardEntry[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const oxrNorm = normalizeGuardText(layoutPageText(page));
    const size = layoutPageSize(page);
    const v3 = v3Pages[i];
    const px = v3?.page_px ?? [];
    for (const line of v3?.lines ?? []) {
      const text = String(line.text ?? "").trim();
      if (!isContentTitleLine(text)) continue;
      if (line.score != null && line.score < GUARD_MIN_SCORE) continue;
      if (oxrNorm.includes(normalizeGuardText(text))) continue;
      entries.push({
        page: i + 1,
        bbox: v3LineToPt(line, px, size),
        text,
        origin: "guard",
        reason: "content-title-missing-in-oxr",
        category: "title",
        score: line.score,
      });
    }
  }
  return {
    entries,
    stats: { pages: pages.length, candidates: entries.length, curated: 0, curatedSkipped: 0 },
  };
}

/**
 * curated 补识清单（逐条回原卷页图核对，证据=tmp/m5-answer-guard/crops/*.png 与
 * tmp/m7-answer/crops/*.png）。bbox 由 V3 行框换算（V3 与 OXR 同坐标系，实测中位偏差
 * −1～−3pt）；文本为原卷核对稿（V3 有碎片/错字处按原卷订正，红线：不丢内容）。
 *
 * 说明：p101「真题」/ p166「真题」为 real-loss 清单**外**发现（同页 OXR 既无文字也无
 * image 块，原卷页图可见），一并登记；p131/p159 的同名 logo 文字在 OXR 有 image 块，
 * 不算丢失（故不在此列）。
 */
export const CURATED_RECOVERY: TitleGuardEntry[] = [
  // ── p1 封面 ──
  { page: 1, bbox: [88.8, 434.2, 144.6, 619.7], text: "以笔为戈", origin: "curated", reason: "cover-slogan", category: "cover", decor: true },
  { page: 1, bbox: [40.9, 476.5, 94.4, 660.6], text: "直击痛点", origin: "curated", reason: "cover-slogan", category: "cover", decor: true },
  { page: 1, bbox: [465.8, 804.8, 523.9, 863.3], text: "附", origin: "curated", reason: "cover-label", category: "cover", decor: true },
  // ── p14 题3解析首三行（右栏）──
  { page: 14, bbox: [306, 41.2, 459.9, 51.8], text: "【解析】已知一个分力 $F_{1}$ 有确定的方", origin: "curated", reason: "prose-gap", category: "prose" },
  { page: 14, bbox: [306.5, 58.6, 460.4, 69.2], text: "向，与 $F$ 成 $30^{\\circ}$ 夹角，另一个分力的最", origin: "curated", reason: "prose-gap", category: "prose" },
  { page: 14, bbox: [305.1, 74.7, 460.4, 88], text: "小值为 $F\\sin30^{\\circ}=25\\ \\mathrm{N}$，而实际上 $F_{2}$", origin: "curated", reason: "prose-gap", category: "prose" },
  // ── p17 题4解析尾两行（右栏）──
  { page: 17, bbox: [326, 234.7, 573.4, 243.1], text: "不断增大，凹槽对小球的支持力N先变小后变大，C正确，A、", origin: "curated", reason: "prose-gap", category: "prose" },
  { page: 17, bbox: [324.2, 250.2, 367.7, 261], text: "B、D错误.", origin: "curated", reason: "prose-gap", category: "prose" },
  // ── p84 左栏解析首两行 + 右栏散文行 ──
  { page: 84, bbox: [29.8, 414.1, 278.5, 424.2], text: "【解析】设小球A垂直落在斜坡上时的速度大小为v，竖直方", origin: "curated", reason: "prose-gap", category: "prose" },
  { page: 84, bbox: [30.7, 431.5, 279, 441.1], text: "向速度大小为 $v_{y}$，平抛运动的水平位移为x，竖直位移为y，所", origin: "curated", reason: "prose-gap", category: "prose" },
  { page: 84, bbox: [308.3, 24.7, 436.1, 33.4], text: "同步卫星相对地心转过角度为 $\\theta=2\\alpha$，", origin: "curated", reason: "prose-gap", category: "prose" },
  // ── 栏目标签 / logo 文字部 ──
  { page: 101, bbox: [38.7, 51.8, 70.9, 64.4], text: "刷小题", origin: "curated", reason: "label-missing", category: "label", decor: true },
  { page: 101, bbox: [51.9, 29.2, 85.2, 47.7], text: "真题", origin: "curated", reason: "label-missing-outside-real-loss", category: "label", decor: true },
  { page: 111, bbox: [56.6, 31, 84, 47.1], text: "提分", origin: "curated", reason: "label-missing", category: "label", decor: true },
  { page: 140, bbox: [319.8, 28.9, 344.5, 43.5], text: "真题", origin: "curated", reason: "label-missing", category: "label", decor: true },
  { page: 166, bbox: [43.1, 29.3, 67.8, 43.5], text: "真题", origin: "curated", reason: "label-missing-outside-real-loss", category: "label", decor: true },
];

/** 标题守卫 + curated 补识 → 一份清单。curated 逐条检查该页 OXR 是否仍缺该文本（缺才并入）。 */
export function buildTitleGuard(
  layoutRaw: unknown,
  v3Pages: V3Page[],
  opts: { curated?: TitleGuardEntry[] } = {},
): GuardResult {
  const detected = detectTitleGaps(layoutRaw, v3Pages);
  const root = asRecord(layoutRaw);
  const pages = asArray(root.pdf_info);
  const curated = opts.curated ?? CURATED_RECOVERY;
  const entries = [...detected.entries];
  const seen = new Set(entries.map((e) => `${e.page}|${normalizeGuardText(e.text)}`));
  let curatedSkipped = 0;
  for (const e of curated) {
    const page = pages[e.page - 1];
    if (!page) {
      curatedSkipped++;
      continue;
    }
    const oxrNorm = normalizeGuardText(layoutPageText(page));
    if (oxrNorm.includes(normalizeGuardText(e.text))) {
      curatedSkipped++;
      continue;
    }
    const key = `${e.page}|${normalizeGuardText(e.text)}`;
    if (seen.has(key)) {
      curatedSkipped++;
      continue;
    }
    seen.add(key);
    entries.push(e);
  }
  return {
    entries,
    stats: {
      pages: pages.length,
      candidates: detected.stats.candidates,
      curated: entries.length - detected.entries.length,
      curatedSkipped,
    },
  };
}

/** 读 V3 缓存目录（0 基命名 pNN.json；缺页跳过）。 */
export function readV3Dir(dir: string): V3Page[] {
  if (!existsSync(dir)) return [];
  const out: V3Page[] = [];
  for (const f of readdirSync(dir).filter((n) => /^p\d+\.json$/.test(n)).sort()) {
    const idx = Number(f.slice(1, -5));
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as V3Page;
      out[idx] = j;
    } catch {
      // 单个坏文件不静默：留空页（守卫该页无证据 ⇒ 不产条目）
      out[idx] = {};
    }
  }
  return out;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  return argv1 ? fileURLToPath(import.meta.url) === argv1 : false;
}

if (isMain()) {
  const docId = process.argv[2];
  const layoutPath = process.argv[3];
  if (!docId || !layoutPath) {
    console.error(
      [
        "用法: npx tsx scripts/oxr-title-guard.ts <docId> <oxrLayoutPath> [--v3-dir <dir>] [--out <path>]",
        "  --v3-dir 默认 data/out/<docId>/ocr-jobs-cache-localv3，缺失时回退去掉 -OXR 后缀的目录",
        "  --out    默认 data/out/<docId>/title-guard.json",
      ].join("\n"),
    );
    process.exit(2);
  }
  const argv = process.argv.slice(4);
  const opt = (name: string, dflt: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
  };
  const v3Dir = opt("--v3-dir", join("data", "out", docId, "ocr-jobs-cache-localv3"));
  const v3DirFallback = v3Dir.startsWith(join("data", "out", docId)) && docId.endsWith("-OXR")
    ? join("data", "out", docId.slice(0, -4), "ocr-jobs-cache-localv3")
    : v3Dir;
  const outPath = opt("--out", join("data", "out", docId, "title-guard.json"));
  const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
  const v3Pages = readV3Dir(existsSync(v3Dir) ? v3Dir : v3DirFallback);
  const { entries, stats } = buildTitleGuard(layout, v3Pages);
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        docId,
        generatedAt: new Date().toISOString(),
        note: "M7-A 标题级守卫（V3 内容标题，score≥0.98）+ curated 补识（逐条回原卷核对）；export-stages 消费",
        stats,
        entries,
      },
      null,
      2,
    ),
  );
  console.log(
    `标题守卫：内容标题 ${stats.candidates} 条 + curated ${stats.curated} 条（跳过 ${stats.curatedSkipped}）→ ${outPath}`,
  );
  if (v3Pages.length === 0) console.warn(`⚠️ V3 缓存未找到（${v3Dir}）：仅出 curated 清单`);
}
