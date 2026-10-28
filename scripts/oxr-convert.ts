/**
 * oxr-convert.ts —— OXR 解析响应 → MinerU layout 同构（纯转换模块）
 *
 * 与 `oxr-adapter.ts`（CLI 薄壳）的分工：本文件只做转换，不读 argv、不打印统计。
 * 这样 `npm run daily -- <pdf> --parser oxr` 能直接复用同一套逻辑，
 * 避免「CLI 一份、daily 一份」两处漂移。
 *
 * 转换规则与踩坑记录（每一条都是实测踩出来的，改之前先读 docs/oxr-evaluation.md §4）：
 *
 *  A 图片：快照契约要求 `images[].path` 是**裸文件名**（展示层无条件拼
 *    `/data/out/<doc>/images/`），而 OXR 给绝对 URL（且会过期）⇒ 必须下载落盘。
 *  B 字号：OXR 只有块级 bbox、没有 line/span 的 `font_size`，引擎取不到字号 ⇒
 *    按「文本填满块宽」与「行高=行高比×字号」联立解出字号。
 *  C bbox 口径：line 的 bbox 是**墨迹框**不是行距框（展示层拿 bbox 高当字号用）。
 *  D 块粒度：展示层字号是**块级**模型（`fontFromLineHeight(h)=h×1.03`，即"块高≈字号"），
 *    而 OXR 整段/整题一块（多行）⇒ 块高被当字高、字号放大数倍。故**每行独立成块**，
 *    且块 bbox 高取字号本身。
 *  E 公式原子：折行不能劈开 `$...$`，否则前导 `$` 被分到上一行、公式失去配对，
 *    `prettifyLatex` 不进数学模式 ⇒ 页面显示 `\theta` 源码（上游响应里 `$` 是全部配对的）。
 *  F 宽度同源：折行宽度必须用展示层的 `emWidthOf(renderedTextOf(...))`，
 *    自估（CJK 1em/ASCII 0.55em）会与 `clampByWidth` 对不齐 ⇒ 文字冲出栏宽压到纸边。
 *
 * 解耦红线：本模块**不 import 引擎 `src/`**；只 import 展示层的纯函数（latex-display /
 * font-metrics），因为「折行与渲染必须同一把尺子」——藏在暗处各写一份才是问题。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emWidthOf, renderedTextOf } from "../stages/font-metrics.js";

/** 试卷纸宽（pt）。与 MinerU layout.json 的 page_size[0] 同口径；150dpi 光栅 1243px ⇒ 596pt */
const A4_WIDTH_PT = 596;
/** CJK 行高 / 字号。判遮挡一律用墨迹口径（HANDOFF §5-9），此处只用于反推行高 */
const LINE_HEIGHT_RATIO = 1.45;

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
  page_size?: { w?: number; h?: number } | number[];
  blocks?: OxrBlock[];
}

export interface OxrResponse {
  data?: { result?: { outputs?: { json?: { pages?: OxrPage[] } } } };
  result?: { outputs?: { json?: { pages?: OxrPage[] } } };
  pages?: OxrPage[];
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

export interface ConvertOptions {
  docId: string;
  /** 图片落盘目录（通常是 data/out/<docId>）；实际写入 `<outDir>/images/` */
  outDir: string;
  /** 跳图片下载（离线对比用；此时 image_path 为 missing.png） */
  noImages?: boolean;
  /** 进度回调（daily 用来打点） */
  onProgress?: (msg: string) => void;
}

export interface ConvertStats {
  pages: number;
  blocks: number;
  lines: number;
  imageBlocks: number;
  imageOk: number;
  imageFail: number;
  fontSize: { p10: number; p50: number; p90: number };
}

/** 取 pages[]，兼容免费版 / 正式版 / 裸结构三种响应形态 */
export function readPages(raw: OxrResponse): OxrPage[] {
  return raw.data?.result?.outputs?.json?.pages ?? raw.result?.outputs?.json?.pages ?? raw.pages ?? [];
}

function readPageSize(page: OxrPage): { w: number; h: number } {
  const ps = page.page_size;
  if (Array.isArray(ps)) return { w: Number(ps[0]) || 0, h: Number(ps[1]) || 0 };
  return { w: Number(ps?.w) || 0, h: Number(ps?.h) || 0 };
}

/** 像素 → pt 缩放系数：以纸宽为锚（同一份卷纸宽恒定，比按 dpi 猜更稳） */
function scaleOf(w: number): number {
  return w > 0 ? A4_WIDTH_PT / w : 1;
}

/** 字符等效宽度（em）：直接复用展示层 `emWidthOf`（逐字实测表），不自己拍系数 */
function emOf(s: string): number {
  return emWidthOf(renderedTextOf(s));
}

/**
 * 切成"不可分割"的折行单元：`$...$` 整体一个 token（缺陷 E）。
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

/** 按渲染宽度折成物理行（保留原有 \n 的强制分段；公式整体不可分） */
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

/** 把 OXR 响应转换成 MinerU 同构 layout（同时把图片下载到 outDir/images） */
export async function convertOxrResponse(
  raw: OxrResponse,
  opts: ConvertOptions,
): Promise<{ layout: { pdf_info: unknown[] }; stats: ConvertStats }> {
  const pages = readPages(raw);
  if (pages.length === 0) throw new Error("响应里找不到 pages[]（免费版/正式版路径都试过了）");

  const imagesDir = join(opts.outDir, "images");
  if (!opts.noImages) mkdirSync(imagesDir, { recursive: true });
  let imageOk = 0;
  let imageFail = 0;

  /** 下载并按内容哈希命名（同图去重；文件名不含特殊字符，符合「裸文件名」契约） */
  async function fetchImage(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, { redirect: "follow" });
      if (!resp.ok) {
        imageFail++;
        return null;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) {
        imageFail++;
        return null;
      }
      const name = `${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.png`;
      writeFileSync(join(imagesDir, name), buf);
      imageOk++;
      return name;
    } catch {
      imageFail++;
      return null;
    }
  }

  const pdfInfo: {
    page_idx: number;
    page_size: [number, number];
    para_blocks: OutBlock[];
    /** 页眉页脚等：**保留可见**（展示层有「已丢弃」样式），不静默丢（红线 G1） */
    discarded_blocks?: OutBlock[];
  }[] = [];
  let lineTotal = 0;
  let blockTotal = 0;
  let imageBlocks = 0;
  const fontSamples: number[] = [];

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

      // footer 是正式版专有类型（答案册 46 块，如「答案及解析」）。
      // 归入 discarded_blocks：MinerU 同样把页眉页脚放这里；但**必须保留**（不静默删）。
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
        const name = url && !opts.noImages ? await fetchImage(url) : null;
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

      // 拆行 + 反推字号（缺陷 B）。OXR 正文块**多数不带 \n**，不能靠数 \n 得行数。
      // 联立：① 文本填满块宽 ⇒ 每行 em 数 = 块宽/字号；② 行高 = 行高比×字号
      //   ⇒ 字号² = 块高×块宽/(行高比×em总数)
      const blockHPt = Math.max(bbox[3] - bbox[1], 1);
      const blockWPt = Math.max(bbox[2] - bbox[0], 1);
      const emTotal = Math.max(emOf(text.replace(/\s+/g, " ").trim()), 1);

      let fontSize = Math.sqrt((blockHPt * blockWPt) / (LINE_HEIGHT_RATIO * emTotal));
      fontSize = Math.min(36, Math.max(5, fontSize));
      let segments = wrapByWidth(text, blockWPt, fontSize);
      // 用实际折出来的行数校正一次（估算宽度必有误差，一轮即可收敛）
      fontSize = Math.min(36, Math.max(5, blockHPt / (LINE_HEIGHT_RATIO * Math.max(segments.length, 1))));
      segments = wrapByWidth(text, blockWPt, fontSize);
      const lineCount = Math.max(segments.length, 1);
      const lineH = blockHPt / lineCount;
      fontSamples.push(fontSize);

      // 引擎 BlockKind 只有 text|image|table|formula，**没有 title**（MinerU 原始有 10 个
      // title、引擎产物 0 个 ⇒ 最终都归 text）。figure_caption/choice/equation/blank 同理。
      const outType = lower === "table" ? "table" : "text";

      // 每行**独立成块**（缺陷 D）：块 bbox 高取字号本身（墨迹口径），行位置按 lineH 步进。
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

    const pageHPt = Number(((A4_WIDTH_PT * h) / (w || 1)).toFixed(1));
    pdfInfo.push({
      page_idx: pageIdx,
      page_size: [A4_WIDTH_PT, pageHPt],
      para_blocks: paraBlocks,
      ...(discarded.length > 0 ? { discarded_blocks: discarded } : {}),
    });
  }

  const sorted = [...fontSamples].sort((a, b) => a - b);
  const pct = (p: number): number => Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(1));

  return {
    layout: { pdf_info: pdfInfo },
    stats: {
      pages: pdfInfo.length,
      blocks: blockTotal,
      lines: lineTotal,
      imageBlocks,
      imageOk,
      imageFail,
      fontSize: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) },
    },
  };
}
