/**
 * oxr-adapter.ts —— OXR 解析响应 → MinerU layout 同构（可复现适配器）
 *
 * 为什么要有这个文件：2026-10-27 的评估里 `data/oxr/oxr-as-layout.json` 是一次性产物，
 * 没有生成器 ⇒ 结论不可复现、缺陷无法迭代。这里把 docs/oxr-evaluation.md §2.4 的
 * 5 条转换规则固化成代码，并修掉首次喂给展示层时暴露的两个适配缺陷：
 *
 *   缺陷 A（图片全 404）：OXR 的 img_url 是**绝对 URL**，而快照契约要求
 *     `images[].path` 是**裸文件名**（展示层无条件拼 `/data/out/<doc>/images/`）。
 *     ⇒ 必须下载落盘（官方 URL 会过期，这也是文档 §2.5 预告的"正式接入必须下载落盘"）。
 *   缺陷 B（正文坍缩到 3px）：OXR 只有**块级** bbox，没有行级 bbox 与 font_size；
 *     引擎 `normalize.ts` 从 `line.font_size` / `span.font_size` 取字号（缺失即 0）
 *     ⇒ 整块多行文本塞进单个 line 时字号失去分母，渲染成 3–4px。
 *     修法：按块内 `\n` **拆成多个 line**，块高按行数均分，font_size = 行高 / 行高比。
 *     附带收益：行级 bbox 让分栏检测拿到行级几何（原先 15 页有 6 页被判成单栏）。
 *
 * 用法：tsx scripts/oxr-adapter.ts <response.json> <docId> [--out <layout.json>] [--no-images]
 *   例：tsx scripts/oxr-adapter.ts data/oxr/book-response.json "23必刷题 2相互作用-OXR"
 *
 * 边界：只做格式适配与图片落盘，**不碰 src/**（红线：换/加解析供应商只改归一化层）；
 *       不接入 `npm run check`（评估期脚本，产物进 data/，git 忽略）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 试卷纸宽（pt）。与 MinerU layout.json 的 page_size[0] 同口径；150dpi 光栅 1243px ⇒ 596pt */
const A4_WIDTH_PT = 596;
/** CJK 行高 / 字号。判遮挡一律用墨迹口径（HANDOFF §5-9），此处只用于反推行高 */
const LINE_HEIGHT_RATIO = 1.45;

/** OXR 免费版块：PascalCase 类型；正式版是小写且更细（adapter 需按服务分支，见文档 §2.2） */
interface OxrBlock {
  idx?: number;
  type?: string;
  bbox?: number[];
  content?: string;
  format?: string;
  img_url?: string;
  captions?: string[];
}

interface OxrPage {
  page_num?: number;
  /** 免费版是 {w,h}，不同版本出现过数组形态，两者都接 */
  page_size?: { w?: number; h?: number } | number[];
  blocks?: OxrBlock[];
}

interface OxrResponse {
  data?: { result?: { outputs?: { json?: { pages?: OxrPage[] } } } };
  pages?: OxrPage[];
  /** 正式版（somark.cn）把 pages 放在这一层 */
  result?: { outputs?: { json?: { pages?: OxrPage[] } } };
}

interface OutLine {
  bbox: [number, number, number, number];
  font_size: number;
  spans: { content: string; font_size: number }[];
}

interface OutBlock {
  type: string;
  bbox: [number, number, number, number];
  lines?: OutLine[];
  /** 图片块必须嵌套 blocks→lines→spans（直接放 lines 顶层会「图片归属 0」，实测踩中） */
  blocks?: { lines: { spans: { image_path: string }[] }[] }[];
}

const args = process.argv.slice(2);
const responsePath = args[0] ?? "";
const docId = args[1] ?? "";
const noImages = args.includes("--no-images");
const outIdx = args.indexOf("--out");
const outPath = (outIdx >= 0 ? args[outIdx + 1] : undefined) ?? `data/oxr/${docId}-as-layout.json`;

if (!responsePath || !docId) {
  console.error("用法：tsx scripts/oxr-adapter.ts <response.json> <docId> [--out <layout.json>] [--no-images]");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(responsePath, "utf8")) as OxrResponse;
const pages = raw.data?.result?.outputs?.json?.pages ?? raw.result?.outputs?.json?.pages ?? raw.pages ?? [];
if (pages.length === 0) {
  console.error(`✗ ${responsePath} 里找不到 pages[]（免费版/正式版路径都试过了）`);
  process.exit(1);
}

/** 读 page_size，兼容 {w,h} 与 [w,h] 两种形态 */
function readPageSize(page: OxrPage): { w: number; h: number } {
  const ps = page.page_size;
  if (Array.isArray(ps)) return { w: Number(ps[0]) || 0, h: Number(ps[1]) || 0 };
  return { w: Number(ps?.w) || 0, h: Number(ps?.h) || 0 };
}

/** 像素 → pt 缩放系数：以纸宽为锚（同一份卷纸宽恒定，比按 dpi 猜更稳） */
function scaleOf(w: number): number {
  return w > 0 ? A4_WIDTH_PT / w : 1;
}

/**
 * 字符等效宽度（em）：CJK / 全角标点 1.0，ASCII 0.55，空格 0.3。
 * 用来在「没有行级 bbox」时把文本折成物理行 —— 只能用估算，所以下面会迭代自校正。
 */
function charEm(ch: string): number {
  const c = ch.codePointAt(0) ?? 32;
  if (c === 32) return 0.3;
  if (c < 128) return 0.55;
  return 1;
}

function textEm(s: string): number {
  let t = 0;
  for (const ch of s) t += charEm(ch);
  return t;
}

/** 按估算宽度把文本折成物理行（保留原有 \n 的强制分段） */
function wrapByWidth(text: string, widthPt: number, fontSize: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const t = para.trim();
    if (t.length === 0) continue;
    let cur = "";
    let w = 0;
    for (const ch of t) {
      const cw = charEm(ch) * fontSize;
      if (w + cw > widthPt && cur.length > 0) {
        out.push(cur);
        cur = "";
        w = 0;
      }
      cur += ch;
      w += cw;
    }
    if (cur.length > 0) out.push(cur);
  }
  return out.length > 0 ? out : [text.trim()];
}

/** 从 markdown 图片语法或裸 URL 里剥出纯 URL */
function pickImageUrl(block: OxrBlock): string | null {
  if (block.img_url) return block.img_url;
  const md = /!\[[^\]]*\]\(([^)]+)\)/.exec(String(block.content ?? ""));
  if (md?.[1]) return md[1];
  const bare = /^https?:\/\/\S+$/.exec(String(block.content ?? "").trim());
  return bare ? bare[0] : null;
}

const imagesDir = join("data", "out", docId, "images");
let downloaded = 0;
let failed = 0;
const imageMode = noImages ? "跳过（--no-images）" : `落盘到 ${imagesDir}`;
if (!noImages) mkdirSync(imagesDir, { recursive: true });

/** 下载图片并按内容哈希命名（同图去重；文件名不含特殊字符，符合「裸文件名」契约） */
async function fetchImage(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) {
      failed++;
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) {
      failed++;
      return null;
    }
    const name = `${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.png`;
    writeFileSync(join(imagesDir, name), buf);
    downloaded++;
    return name;
  } catch {
    failed++;
    return null;
  }
}

const pdfInfo: { page_idx: number; page_size: [number, number]; para_blocks: OutBlock[] }[] = [];
let lineTotal = 0;
let blockTotal = 0;
let imageBlocks = 0;
let fontSamples: number[] = [];

for (const [pageIdx, page] of pages.entries()) {
  const { w, h } = readPageSize(page);
  const k = scaleOf(w);
  const paraBlocks: OutBlock[] = [];

  for (const block of page.blocks ?? []) {
    const bb = block.bbox;
    if (!Array.isArray(bb) || bb.length < 4) continue;
    const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = bb;
    const bbox = [bx0 * k, by0 * k, bx1 * k, by1 * k] as [number, number, number, number];
    const type = String(block.type ?? "Text");
    blockTotal++;

    // 映射：Title→title / Text→text / Caption→text（图注也是正文，且正是 MinerU 双漏的那类）
    const lower = type.toLowerCase();
    if (lower === "picture" || lower === "figure" || lower === "image") {
      const url = pickImageUrl(block);
      const name = url && !noImages ? await fetchImage(url) : null;
      imageBlocks++;
      paraBlocks.push({
        type: "image",
        bbox,
        blocks: [{ lines: [{ spans: [{ image_path: name ?? "missing.png" }] }] }],
      });
      continue;
    }

    const text = String(block.content ?? "");
    if (text.trim().length === 0) continue;

    // 拆行 + 反推字号（缺陷 B 的修法）。
    // ⚠️ OXR 的正文块**多数不带 \n**（整段文本 + 块级 bbox），所以不能靠数 \n 得行数。
    // 联立两个约束解字号：① 文本填满块宽 ⇒ 每行 em 数 = 块宽/字号；② 行高 = 行高比×字号。
    //   em总数 × 字号 / 块宽 = 行数 = 块高 / (行高比 × 字号)  ⇒  字号² = 块高×块宽/(行高比×em总数)
    const blockHPt = Math.max(bbox[3] - bbox[1], 1);
    const blockWPt = Math.max(bbox[2] - bbox[0], 1);
    const emTotal = Math.max(textEm(text.replace(/\s+/g, " ").trim()), 1);

    let fontSize = Math.sqrt((blockHPt * blockWPt) / (LINE_HEIGHT_RATIO * emTotal));
    fontSize = Math.min(36, Math.max(5, fontSize));
    let segments = wrapByWidth(text, blockWPt, fontSize);
    // 用实际折出来的行数校正一次（估算宽度必然有误差，一轮即可收敛）
    fontSize = Math.min(36, Math.max(5, blockHPt / (LINE_HEIGHT_RATIO * Math.max(segments.length, 1))));
    segments = wrapByWidth(text, blockWPt, fontSize);
    const lineCount = Math.max(segments.length, 1);
    const lineH = blockHPt / lineCount;
    fontSamples.push(fontSize);

    const lines: OutLine[] = segments.map((seg, i) => {
      // ⚠️ line 的 bbox 是**墨迹框**不是行距框：展示层拿 bbox 高度当字号用
      // （HANDOFF §5-9：CJK 墨迹高 ≈ 1em）。第一版这里给的是行高（1.45×字号），
      // 结果渲染字号被放大 45%，文字横向冲出栏宽压到邻栏（实测截图）。
      const inkH = fontSize;
      const y0 = bbox[1] + i * lineH + (lineH - inkH) / 2;
      return {
        bbox: [bbox[0], y0, bbox[2], y0 + inkH],
        font_size: fontSize,
        spans: [{ content: seg, font_size: fontSize }],
      };
    });
    lineTotal += lines.length;

    const outType = lower === "title" ? "title" : lower === "table" ? "table" : "text";
    paraBlocks.push({ type: outType, bbox, lines });
  }

  // 页高按纸宽等比换算（光栅宽高比即纸宽高比），保证 bbox 与 page_size 同口径
  const pageHPt = Number(((A4_WIDTH_PT * h) / (w || 1)).toFixed(1));
  pdfInfo.push({ page_idx: pageIdx, page_size: [A4_WIDTH_PT, pageHPt], para_blocks: paraBlocks });
}

const layout = { pdf_info: pdfInfo };
mkdirSync(join("data", "oxr"), { recursive: true });
writeFileSync(outPath, JSON.stringify(layout, null, 1));

const sorted = [...fontSamples].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(1) ?? "-";
console.log(`✓ ${outPath}`);
console.log(`  页 ${pdfInfo.length} · 块 ${blockTotal}（图片 ${imageBlocks}）· 行 ${lineTotal}`);
console.log(`  图片 ${imageMode}：成功 ${downloaded} / 失败 ${failed}`);
console.log(`  字号反推 p10/p50/p90 = ${pct(0.1)} / ${pct(0.5)} / ${pct(0.9)} pt`);
if (failed > 0) console.log(`  ⚠️ ${failed} 张图下载失败 ⇒ 对应位置会是 missing.png（不静默：页面显示为破图，不是空白）`);
