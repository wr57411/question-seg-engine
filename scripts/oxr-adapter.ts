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
// 折行宽度必须与展示层**同一把尺子**：展示层的 clampByWidth 用的就是
// `emWidthOf(renderedTextOf(text))`。各自估算（我原先用 CJK 1em / ASCII 0.55em 平均）
// 必然对不齐 ⇒ 文字横向冲出栏外、压到纸边（实测 p01 右栏）。
// emWidthOf 是逐字实测的 ASCII 推进表；renderedTextOf 会先把 LaTeX 渲染成符号再量。
import { emWidthOf, renderedTextOf } from "../stages/font-metrics.js";

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
 * 字符等效宽度（em）：直接复用展示层 `emWidthOf`（逐字实测表），不自己拍系数。
 */
function emOf(s: string): number {
  return emWidthOf(renderedTextOf(s));
}

/**
 * 切成"不可分割"的折行单元。
 * ⚠️ `$...$` 必须整体算一个 token —— 第一版逐字符折行，切点落在公式中间时
 * 前导 `$` 被分到上一行，公式失去配对 ⇒ `prettifyLatex` 不进入数学模式 ⇒
 * 页面直接显示 `\theta`、`\frac{kR}{mg}` 源码（实测 p01「θ应满足」那行）。
 * 上游原始响应里 `$` 是**全部配对**的（120 块 0 例外），劈开是折行造成的。
 * 公式宽度按**渲染后文本**量（`renderedTextOf` 会剥掉 `\frac` 等命令的源码体积）。
 */
function tokenizeByWidth(text: string): { s: string; em: number }[] {
  const toks: { s: string; em: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "$") {
      const j = text.indexOf("$", i + 1);
      if (j > i) {
        const seg = text.slice(i, j + 1);
        toks.push({ s: seg, em: Math.max(1, emOf(seg)) });
        i = j + 1;
        continue;
      }
    }
    toks.push({ s: ch, em: Math.max(0.1, emOf(ch)) });
    i++;
  }
  return toks;
}

/** 按渲染宽度把文本折成物理行（保留原有 \n 的强制分段；公式整体不可分） */
function wrapByWidth(text: string, widthPt: number, fontSize: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const t = para.trim();
    if (t.length === 0) continue;
    let cur = "";
    let w = 0;
    for (const tok of tokenizeByWidth(t)) {
      const cw = tok.em * fontSize;
      if (w + cw > widthPt && cur.length > 0) {
        out.push(cur);
        cur = "";
        w = 0;
      }
      cur += tok.s;
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

const pdfInfo: {
  page_idx: number;
  page_size: [number, number];
  para_blocks: OutBlock[];
  /** 页眉页脚等：**保留可见**（展示层有「已丢弃」样式），不静默丢（红线 G1）。MinerU 也放这里 */
  discarded_blocks?: OutBlock[];
}[] = [];
let lineTotal = 0;
let blockTotal = 0;
let imageBlocks = 0;
let fontSamples: number[] = [];

for (const [pageIdx, page] of pages.entries()) {
  const { w, h } = readPageSize(page);
  const k = scaleOf(w);
  const paraBlocks: OutBlock[] = [];
  const discarded: OutBlock[] = [];

  for (const block of page.blocks ?? []) {
    const bb = block.bbox;
    if (!Array.isArray(bb) || bb.length < 4) continue;
    const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = bb;
    const bbox = [bx0 * k, by0 * k, bx1 * k, by1 * k] as [number, number, number, number];
    const type = String(block.type ?? "Text");
    blockTotal++;
    const lower = type.toLowerCase();

    // footer 是**正式版专有**类型（答案册 46 块，内容如「答案及解析」）。
    // 归入 discarded_blocks 而不是正文：MinerU 同样把页眉页脚放这里；
    // 但**必须保留**（展示层有「已被解析器丢弃」样式 + title 悬浮原文），不能静默删。
    if (lower === "footer") {
      const t = String(block.content ?? "").trim();
      if (t.length > 0) {
        const fs = 8;
        discarded.push({
          type: "footer",
          bbox,
          lines: [{ bbox, font_size: fs, spans: [{ content: t, font_size: fs }] }],
        });
      }
      continue;
    }

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
    const emTotal = Math.max(emOf(text.replace(/\s+/g, " ").trim()), 1);

    let fontSize = Math.sqrt((blockHPt * blockWPt) / (LINE_HEIGHT_RATIO * emTotal));
    fontSize = Math.min(36, Math.max(5, fontSize));
    let segments = wrapByWidth(text, blockWPt, fontSize);
    // 用实际折出来的行数校正一次（估算宽度必然有误差，一轮即可收敛）
    fontSize = Math.min(36, Math.max(5, blockHPt / (LINE_HEIGHT_RATIO * Math.max(segments.length, 1))));
    segments = wrapByWidth(text, blockWPt, fontSize);
    const lineCount = Math.max(segments.length, 1);
    const lineH = blockHPt / lineCount;
    fontSamples.push(fontSize);

    // 引擎的 BlockKind 只有 `text | image | table | formula`，**没有 title** ——
    // 造枚举外的值不合契约（实测：MinerU 原始 layout 有 10 个 title，引擎产物里 0 个，
    // 说明 title 最终都归 text）。图注(Caption/figure_caption)、choice、equation、blank 同理归 text。
    const outType = lower === "table" ? "table" : "text";
    // 每行**独立成块**（关键）：展示层的字号是**块级**模型 ——
    // `fontForBlock` 取块的 bbox 高，`fontFromLineHeight(h) = h × 1.03` 即"块高 ≈ 字号"。
    // OXR 的块粒度粗（整段/整题一块 = 多行），塞进一个块里 ⇒ 块高被当成字高 ⇒
    // 字号放大数倍、文字横向冲出栏宽（实测截图：压到邻栏）。
    // 故每行一个块，且块 bbox 高取**字号本身**（墨迹口径），行位置仍按行距 lineH 步进。
    segments.forEach((seg, i) => {
      const y0 = bbox[1] + i * lineH;
      const one: [number, number, number, number] = [bbox[0], y0, bbox[2], y0 + fontSize];
      paraBlocks.push({
        type: outType,
        bbox: one,
        lines: [{ bbox: one, font_size: fontSize, spans: [{ content: seg, font_size: fontSize }] }],
      });
      lineTotal++;
    });
  }

  // 页高按纸宽等比换算（光栅宽高比即纸宽高比），保证 bbox 与 page_size 同口径
  const pageHPt = Number(((A4_WIDTH_PT * h) / (w || 1)).toFixed(1));
  pdfInfo.push({
    page_idx: pageIdx,
    page_size: [A4_WIDTH_PT, pageHPt],
    para_blocks: paraBlocks,
    ...(discarded.length > 0 ? { discarded_blocks: discarded } : {}),
  });
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
