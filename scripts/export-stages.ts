// scripts/export-stages.ts
/**
 * 阶段样品展示快照导出（唯一允许 import 引擎 src/ 的展示层上游）。
 * 跑一遍真实管线（normalizeLayout → layoutPage → segmentFromLayout），
 * 把各阶段中间产物收进 data/out/<docId>/stages.json，
 * 供 stages/ 前端（不 import 引擎代码）做可视化展示。
 *
 * 运行：npm run stages:export [-- <docId> <layoutPath>]
 * 默认：docId = 23必刷题 2相互作用，layout = data/smoke/unpacked/layout.json
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ruleStrategy } from "../src/index.js";
import { looksLikeAnswerEntry, matchFirstLine } from "../src/patterns.js";
import { normalizeLayout } from "../src/normalize.js";
import { detectColumnCenters, detectColumns, layoutPage } from "../src/layout.js";
import { applyCorrections, type CorrectionFile } from "../src/corrections.js";
import { scanFormulaNoise, type FormulaNoiseReport } from "../src/formula.js";
import type { BBox, IndexedBlock, ParsedBlock, ParsedDocument, SegmentationResult } from "../src/types.js";

/** 阶段 1：MinerU 原始段级块（保留 MinerU 自身 type，只截断文本） */
export interface RawStageBlock {
  i: number;
  type: string;
  bbox: BBox;
  text: string;
}

/** MinerU 丢弃块（页眉/页脚/页码/侧栏等，type 原样保留） */
export interface DiscardedStageBlock {
  i: number;
  dtype: string;
  bbox: BBox;
  text: string;
}

/** 阶段 2/3：归一化后的行级块（引擎实际处理粒度） */
export interface StageBlock {
  i: number;
  kind: string;
  bbox: BBox;
  text: string;
  /** 图片块的裸文件名（拼 images/ 前缀由展示层负责） */
  img?: string;
}

/**
 * 未覆盖墨迹区域的级别（修复轮 1 引入的分类，判据见 `classifyUncovered`）：
 * - `content`：**内容级** —— 疑似被解析漏掉的正文（整行/整段/选项）。**判据宁可宽松**。
 * - `furniture`：**家具级** —— 页眉色块/横线、栏间竖线、页边章节标、页脚页码等版式装饰。
 */
export type UncoveredKind = "content" | "furniture";

/**
 * 未覆盖墨迹区域（Task 16）：页图上是墨迹、但不在该页**任何** bbox
 * （blocks + raw + discarded，含图片块）内的连通区域。
 * `bbox` 用 **PDF 点**（与既有字段同口径）；`area` 为区域内的未覆盖墨迹像素数；
 * `kind` 为内容级/家具级分类（展示层与审计据此分级）。
 * 这是「上游漏识别」的地面真值信号 —— 展示层据此画「解析遗漏」标记。
 */
export interface UncoveredRegion {
  bbox: BBox;
  area: number;
  kind: UncoveredKind;
}

/** 逐页墨迹覆盖统计（Task 16；供审计在不读 PDF 的前提下算占比与条数） */
export interface InkCoverage {
  /** 渲染 DPI（scale = dpi/72） */
  dpi: number;
  /** 二值化阈值（灰度 < threshold 判为墨） */
  threshold: number;
  /** bbox 外扩像素 */
  expandPx: number;
  /** 聚类膨胀半径像素 */
  dilatePx: number;
  /** 区域面积下限像素 */
  minAreaPx: number;
  /** 全卷墨迹像素总数 */
  totalInkPx: number;
  /** 全卷未覆盖墨迹像素总数（未过面积下限） */
  uncoveredPx: number;
  /** 全卷未覆盖占比 = uncoveredPx / totalInkPx */
  ratio: number;
  /** 全卷内容级未覆盖区域条数（判定项基线） */
  contentCount: number;
  /** 全卷家具级未覆盖区域条数 */
  furnitureCount: number;
  /** 逐页数字 */
  pages: {
    index: number;
    inkPx: number;
    uncoveredPx: number;
    ratio: number;
    contentCount: number;
    furnitureCount: number;
  }[];
}

export interface StageQuestion {
  id: string;
  number: string;
  section: string;
  type: string;
  blocks: number[];
  /** 该题是否在本页起始（false = 本页只是它的跨页续段）；缺省视为 true */
  startsHere?: boolean;
  confidence: number;
  status: string;
  reasons: string[];
}

export interface StagePage {
  index: number;
  width: number;
  height: number;
  columns: number;
  centers: number[];
  raw: RawStageBlock[];
  /** MinerU 判定为页眉页脚等而丢弃的块（展示层以虚线灰块呈现，供对照查漏） */
  discarded: DiscardedStageBlock[];
  blocks: StageBlock[];
  /** 阅读顺序的块 i 序列（数组下标即顺序号） */
  order: number[];
  questions: StageQuestion[];
  /**
   * 未覆盖墨迹区域（Task 16，PDF 点）：页图上是墨迹但不在该页任何 bbox 内的连通区域。
   * 空数组 = 无发现；旧快照或未跑墨迹分析时也缺省为空。**仅新增字段，不改既有字段语义。**
   */
  uncovered: UncoveredRegion[];
  /**
   * OCR 候选补全（`scripts/ocr-fill.ts` 的产物，**显式步骤**，不进 `npm run check`）。
   * 针对「引擎为空」的解析遗漏区域，用 PaddleOCR-VL 读原卷裁图得到的**候选**文本。
   * ⚠️ OCR 会错字（实测），故一律带 `source` 与 `crop`（原卷裁图证据），
   * 展示层以**候选**样式渲染，绝不静默替换引擎文本（G1）。
   * 缺失 `ocr-fill.json` 时为空数组。**仅新增字段，不改既有字段语义。**
   */
  ocrFill: OcrFillItem[];
  /**
   * 该页的**整页 OCR 全文**（`scripts/ocr-page-fill.ts` 的产物）。
   * 整页 OCR 的输出**没有 bbox**，所以它不能单独用来定位；这里存下来只为在对比模式里
   * 提供一份「完整、可通读」的对照文本（用户核对时可一眼看到被漏掉的内容确实读出来了）。
   * 缺失时为空串。**仅新增字段。**
   */
  ocrFullText: string;
}

/** OCR 候选补全的一条（见 StagePage.ocrFill）。 */
export interface OcrFillItem {
  /** 该区域（碎片）在原卷上的位置（PDF 点） */
  bbox: BBox;
  /** 渲染用位置：裁图窗口（= 整行范围）。OCR 读整行，放碎片位置会右移。 */
  win: BBox;
  /** 清洗后的候选文本 */
  text: string;
  /** OCR 原始输出（留证） */
  raw: string;
  /** 原卷裁图路径（相对项目根，G4 证据） */
  crop: string;
  /**
   * 宽度比。**两种来源口径不同，别混用**：
   * - `"crop"`：窗口宽 / (当量 em × 字号)；
   * - `"page"`：**洞自身**宽 / (当量 em × 字号) —— 整页来源的文本是按洞宽切出来的。
   */
  ratio: number;
  accepted: boolean;
  /**
   * 来源：
   * - `"crop"` = 区域裁图（`scripts/ocr-fill.ts`），窗口按行裁，位置天然对得上；
   * - `"page"` = 整页 OCR（`scripts/ocr-page-fill.ts`），上下文完整、文本更干净，
   *   但会把折行的选项并成一行 ⇒ 只用来**补裁图没补上的洞**。
   */
  source?: "crop" | "page";
  reason?: string;
}

export interface StageSnapshot {
  version: number;
  docId: string;
  generatedAt: string;
  stats: SegmentationResult["stats"];
  /** 答案区条目总数（0 表示本卷无答案区，展示层据此换文案） */
  answerEntriesTotal: number;
  /** 原卷逐页图数量（data/out/<docId>/pages/page-NN.png；0 = 未渲染，展示层降级为 PDF 内嵌） */
  originPages: number;
  /** 公式噪声检测报告（检测不改写） */
  formulaNoise: FormulaNoiseReport;
  /**
   * 墨迹覆盖率统计（Task 16）。null = 未做（pdftoppm 缺失 / 无原卷 PDF）——
   * 审计据此**优雅降级**（跳过该节，不报错）。
   */
  inkCoverage: InkCoverage | null;
  /**
   * 墨迹分析的**非预期异常**（修复轮 1）：非 null 表示 PGM 解析/尺寸/逻辑出错
   * （**不是** pdftoppm 缺失那种可降级情形）。审计见到它就判**失败**——
   * 让「检查自身出 bug」不再静默假绿（G1 同样适用于门自身）。
   */
  inkCoverageError: string | null;
  pages: StagePage[];
  reviews: SegmentationResult["reviews"];
}

const RAW_TEXT_LIMIT = 160;
const BLOCK_TEXT_LIMIT = 240;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** layout.json 的 para_blocks → 阶段 1 段级块（type 原样保留，文本取 spans 拼接） */
export function extractRawBlocks(layoutRaw: unknown): RawStageBlock[][] {
  const root = (layoutRaw ?? {}) as Record<string, unknown>;
  const pages = Array.isArray(root.pdf_info) ? root.pdf_info : [];
  return pages.map((entry) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const paras = Array.isArray(rec.para_blocks) ? rec.para_blocks : [];
    return paras.map((pbRaw, i) => {
      const pb = (pbRaw ?? {}) as Record<string, unknown>;
      let text = "";
      const lines = Array.isArray(pb.lines) ? pb.lines : [];
      for (const lineRaw of lines) {
        const line = (lineRaw ?? {}) as Record<string, unknown>;
        const spans = Array.isArray(line.spans) ? line.spans : [];
        for (const spanRaw of spans) {
          const span = (spanRaw ?? {}) as Record<string, unknown>;
          text += String(span.content ?? "");
        }
      }
      const bbox = Array.isArray(pb.bbox) ? (pb.bbox as BBox) : ([0, 0, 0, 0] as BBox);
      return { i, type: String(pb.type ?? "text"), bbox, text: clip(text.trim(), RAW_TEXT_LIMIT) };
    });
  });
}

/** layout.json 的 discarded_blocks（页眉/页脚/页码/侧栏）→ 展示用丢弃块 */
export function extractDiscardedBlocks(layoutRaw: unknown): DiscardedStageBlock[][] {
  const root = (layoutRaw ?? {}) as Record<string, unknown>;
  const pages = Array.isArray(root.pdf_info) ? root.pdf_info : [];
  return pages.map((entry) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const discarded = Array.isArray(rec.discarded_blocks) ? rec.discarded_blocks : [];
    return discarded.map((pbRaw, i) => {
      const pb = (pbRaw ?? {}) as Record<string, unknown>;
      let text = "";
      const lines = Array.isArray(pb.lines) ? pb.lines : [];
      for (const lineRaw of lines) {
        const line = (lineRaw ?? {}) as Record<string, unknown>;
        const spans = Array.isArray(line.spans) ? line.spans : [];
        for (const spanRaw of spans) {
          const span = (spanRaw ?? {}) as Record<string, unknown>;
          text += String(span.content ?? "");
        }
      }
      const bbox = Array.isArray(pb.bbox) ? (pb.bbox as BBox) : ([0, 0, 0, 0] as BBox);
      return { i, dtype: String(pb.type ?? "other"), bbox, text: clip(text.trim(), RAW_TEXT_LIMIT) };
    });
  });
}

/**
 * 纯函数：引擎产物 → 展示快照。
 * rawPages / discardedPages 与 doc.pages 一一对应（extractRawBlocks /
 * extractDiscardedBlocks 的输出）。
 *
 * 关键口径（两处）：
 * 1. segmentWithRules 会把 IndexedBlock.index 重写为跨页全局序号，
 *    Question.source.blockIndexes 存的是全局序号；此处按阅读顺序重建
 *    「全局序号 → 页内块序号」映射，展示层拿到的一律是页内序号。
 * 2. 题目可能跨页（起始页之后延续到下一页），故按「块的落页」分组：
 *    一道题在其块所在的每一页各出一条（blocks 为该页内的块序号），
 *    展示层在每页都能看到这道题的这一部分。
 */
export function buildStageSnapshot(
  doc: ParsedDocument,
  result: SegmentationResult,
  rawPages: RawStageBlock[][],
  discardedPages: DiscardedStageBlock[][] = [],
  uncoveredPages: UncoveredRegion[][] = [],
): StageSnapshot {
  const sortedPages = [...doc.pages].sort((a, b) => a.index - b.index);
  const pageLayouts = sortedPages.map((page) => ({ page, layout: layoutPage(page) }));
  let globalIndex = 0;
  const globalToPage = new Map<number, { page: number; block: number }>();
  for (const { page, layout } of pageLayouts) {
    for (const entry of layout.ordered) {
      globalToPage.set(globalIndex++, { page: page.index, block: entry.index });
    }
  }

  const questionsByPage = new Map<number, StageQuestion[]>();
  for (const q of result.questions) {
    const perPageBlocks = new Map<number, number[]>();
    for (const gi of q.source.blockIndexes) {
      const m = globalToPage.get(gi);
      if (!m) continue;
      const arr = perPageBlocks.get(m.page) ?? [];
      arr.push(m.block);
      perPageBlocks.set(m.page, arr);
    }
    const reasons = result.reviews.filter((r) => r.questionId === q.id).map((r) => r.reason);
    for (const [pageIndex, blocks] of perPageBlocks) {
      const arr = questionsByPage.get(pageIndex) ?? [];
      arr.push({
        id: q.id,
        number: q.number,
        section: q.section,
        type: q.type,
        blocks,
        /**
         * 该题是否**在本页起始**（false = 本页只是它的跨页续段）。
         *
         * 为什么需要这个标记（2026-10-12 用户当场指出）：跨页题会在它涉及的每一页各出一条
         * （`blocks` 是该页内的块），但**续段所在页的原卷上并没有题号**。
         * 若续段也挂 `第N题` 号牌，用户就会在该页看到「不属于这页的题号」
         * （实测答案册第 17 页顶部挂着 `第8题`，而该页原卷的题号是 9/2/3/4/5/6）。
         * ⇒ 号牌只在 `startsHere` 的那一条上挂。
         */
        startsHere: q.source.pageIndex === pageIndex,
        confidence: q.confidence,
        status: q.status,
        reasons,
      });
      questionsByPage.set(pageIndex, arr);
    }
  }

  const pages: StagePage[] = pageLayouts.map(({ page, layout }, p) => {
    const entries: IndexedBlock[] = page.blocks.map((block, index) => ({
      index,
      pageIndex: page.index,
      block,
    }));
    return {
      index: page.index,
      width: page.width,
      height: page.height,
      columns: detectColumns(entries, page.width),
      centers: detectColumnCenters(entries, page.width).map((c) => Math.round(c)),
      raw: rawPages[p] ?? [],
      discarded: discardedPages[p] ?? [],
      blocks: page.blocks.map((b, i) => ({
        i,
        kind: b.kind,
        bbox: b.bbox,
        text: clip(b.kind === "image" ? "[图片]" : b.kind === "formula" ? b.latex : b.text, BLOCK_TEXT_LIMIT),
        ...(b.kind === "image" ? { img: b.path } : {}),
        ...(b.kind === "text" && b.fromOcr ? { ocr: true } : {}),
        // 人工已核对的上游错误修正（corrections/<docId>.json，见 DECISIONS §47）：
        // 快照带 `correction` 标记，展示层用**琥珀虚线框**区分 —— 审阅者要能一眼看出
        // "这块不是上游原文，是被改过的"（与 OCR 候选的青绿框区分开）。
        ...(b.kind === "text" && b.fromCorrection ? { correction: true } : {}),
      })),
      order: layout.ordered.map((e) => e.index),
      questions: questionsByPage.get(page.index) ?? [],
      uncovered: uncoveredPages[p] ?? [],
      ocrFill: [],
      ocrFullText: "",
    };
  });
  return {
    version: 1,
    docId: result.docId,
    generatedAt: new Date().toISOString(),
    stats: result.stats,
    answerEntriesTotal: result.answerEntries.length,
    originPages: 0,
    /** 公式噪声检测报告（检测不改写，见 src/formula.ts） */
    formulaNoise: scanFormulaNoise(result.questions),
    /** 墨迹覆盖率：由 main() 在能渲染页图时回填（见 computeInkCoverage） */
    inkCoverage: null,
    /** 墨迹分析异常：由 main() 在非 ENOENT 失败时回填（见下方 catch） */
    inkCoverageError: null,
    pages,
    reviews: result.reviews,
  };
}

/* ── 墨迹覆盖率检查（Task 16）───────────────────────────────────────────────
 * 目的：用**原卷页图**当地面真值，发现「解析漏掉了哪些墨迹」——这是唯一能系统性
 * 发现「上游漏识别」的办法。动机：第 5 页滑轮题 C 选项第二行在原卷可见，却在
 * MinerU 的 para_blocks / preproc_blocks / discarded_blocks **三层里全都不存在**；
 * 而该题选项键齐全 ⇒ 引擎既有的「选项缺键」检查通过 ⇒ 这处丢失**没有任何标记**。
 *
 * 方法（不依赖任何图像库）：pdftoppm -gray 输出 PGM（P5：文本头 + 二进制灰度字节，
 * node 手写十几行即可解析）；二值化分墨/纸；把该页**全部** bbox（blocks + raw +
 * discarded，含图片块）按 scale=dpi/72 换算像素并外扩；统计「是墨迹但不在任何
 * bbox 内」的像素，膨胀后按连通域聚成矩形区域，过面积下限的落库。
 *
 * ⚠️ 已知局限（如实呈现，勿当噪声抹掉）：原卷是**双栏**排版，栏间有一条印刷竖线、
 * 页眉有色块/横线装饰——它们不是内容、也不在任何 bbox 内，会稳定出现在未覆盖区域里。
 * 故「占比」这个数字被**版式家具**抬高（本卷基线 ~3.8%），它是**粗护栏**；
 * 精确定位漏识别靠逐区域清单（提示项）。
 */

/** 渲染 DPI：页宽 596pt → ~1243px；正文行高 ~11.3pt → ~23px，足够分辨单行。
 *  100–150 是精度/速度平衡点；再高只线性增内存、收益递减（全卷 15 页 ~0.9s）。 */
export const INK_DPI = 150;
/** 二值化阈值：灰度 < 160 判为墨。原卷是扫描件，直方图在 160 处出现拐点
 *  （≤160 覆盖 8.85% 像素，多为笔画的抗锯齿边；152→160 仅 +0.8pp，
 *  而 160→176 跳 +1.1pp 起就开始把纸张纹理当墨）⇒ 取 160 为墨的上界。 */
export const INK_THRESHOLD = 160;
/** bbox 外扩像素：吸收 bbox 与墨迹的亚像素/紧贴差（bbox 通常略小于墨迹）。
 *  上限受已知漏行约束：raw 列表块底边 348pt 与漏行墨迹顶 351.3pt 仅差 ~8px，
 *  外扩须 < 8px 才不吞掉该漏行 ⇒ 取 4px（≈1.9pt，留 4px 余量）。 */
export const INK_EXPAND_PX = 4;
/** 聚类膨胀半径像素：把同一行内的字间/词间缝隙连成一体，避免一行碎成多块。
 *  6px ≈ 2.9pt；行距 ~19pt（≈40px）远大于 2×6px，故不会把相邻行粘在一起。 */
export const INK_DILATE_PX = 6;
/** 区域面积下限像素：丢弃极小碎屑（bbox 边缘亚像素残差、扫描噪点）。
 *  40px 在 150dpi 下 ≈ 2.6pt×2.6pt；已知漏行面积 800–1700px，远高于此。 */
export const INK_MIN_AREA_PX = 40;

/* ── 区域分类：内容级 vs 家具级（修复轮 1）───────────────────────────────────
 * 为什么要分类：不分类时，「未覆盖占比」被稳定的版式家具（页眉色块/横线、栏间竖线、
 * 页边章节标）抬高到基线 3.84%，而本任务要防的失效模式（单行/整组选项漏识别，4 处）
 * 仅占 0.66% —— 占比判据对该模式**实质恒绿**。故改为按**内容级条数**判回归。
 * 判据**宁可把可疑的判成内容级**（漏报比误报危险）：只有确证是装饰才判家具级。
 * 命中任一即家具级：
 *   1. **细长线**：long/short ≥ 12 且 short ≤ 4pt —— 印刷栏线/装饰横线；真实文本行高 ~11pt
 *      不可能命中（最细的整行也 ≥ 8pt），故不会把漏识别误判成装饰。
 *   2. **落在页边带**：区域 bbox 完全落在「页眉/页脚/左右页边」带内（带 = 页面尺寸的固定
 *      比例，见下方 *_BAND_FRAC）—— 页眉 logo/横线、页脚页码、装订边章节标。
 *   3. **过半在内容矩形外**：区域 bbox 与该页 `blocks` 并集（内容矩形）的重叠面积 < 50%。
 *      内容矩形由**数据推导**（非魔法常数），换卷自适配；补判据 2 漏掉的「跨带」区域。
 * 风险与边界（如实说明）：判据 2 是**位置启发式** —— 版心顶部的真实标题若被漏识别，会被
 *   判成家具级。实测本卷版心顶部的内容块（章节/节标题）**均已被覆盖**，未触发该风险；
 *   且带比例取得偏小（页眉 15%），正是为压低这个风险。
 * 未采用「墨迹密度」信号：实测正文行密度 ~0.22–0.26、页眉 logo 实心块 ~0.54、
 *   页眉 logo+横线区域 ~0.09、栏间竖线 ~1.0 —— 密度把「实心 logo」与「稀疏横线」推向
 *   两端，无单侧阈值可用；且粗体标题密度接近 logo，会误伤真内容 ⇒ 不引入该信号。 */
export const UNCOVERED_RULE_MIN_ASPECT = 12;
// ⚠️ 2026-10-11：原为 4 —— 实测 p5 有块 80×4pt 的「被切薄的正文行」
//（`静止时，下列说法正确的是（ ）` 只露出 4pt 高）被这条规则判成家具级，
// 于是**内容级清单里没有它、界面上也没有洋红标记**，用户看不到「这里缺了内容」。
// 真正的栏间/页边细线是 1–2pt；4pt 已是字形碎片的高度。⇒ 收到 2.5。
// 方向依据：误判成内容级=保守提示（人看一眼），误判成家具级=**静默丢内容**，代价不对称。
export const UNCOVERED_RULE_MAX_SHORT_PT = 2.5;
export const UNCOVERED_CONTENT_OVERLAP_MIN = 0.5;
export const UNCOVERED_HEADER_BAND_FRAC = 0.15;
export const UNCOVERED_FOOTER_BAND_FRAC = 0.06;
export const UNCOVERED_LEFT_BAND_FRAC = 0.05;
export const UNCOVERED_RIGHT_BAND_FRAC = 0.08;

/** 把未覆盖区域判为内容级 / 家具级（判据与理由见上方注释）。纯函数、可测。 */
export function classifyUncovered(bbox: BBox, contentRect: BBox, pageW: number, pageH: number): UncoveredKind {
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  // 1) 细长线
  if (short > 0 && long / short >= UNCOVERED_RULE_MIN_ASPECT && short <= UNCOVERED_RULE_MAX_SHORT_PT) {
    return "furniture";
  }
  // 2) 完全落在页边带内
  const inHeader = bbox[3] <= pageH * UNCOVERED_HEADER_BAND_FRAC;
  const inFooter = bbox[1] >= pageH * (1 - UNCOVERED_FOOTER_BAND_FRAC);
  const inLeft = bbox[2] <= pageW * UNCOVERED_LEFT_BAND_FRAC;
  const inRight = bbox[0] >= pageW * (1 - UNCOVERED_RIGHT_BAND_FRAC);
  if (inHeader || inFooter || inLeft || inRight) return "furniture";
  // 2.5) **小方块 = 更可能是字符，不是装饰**（2026-10-27 光学卷实测）
  //   题号印在「题目末尾的空白里」，离内容矩形很远 ⇒ 原判据 3 会把它判成家具级
  //   ⇒ 不进 OCR 候选 ⇒ 题号永远补不回来（8 页只切出 15 题）。
  //   版式装饰的形状是**细长线**或**大面积色块**，不会是 25pt 以内、接近正方形的块。
  if (w <= 25 && h <= 25 && long / Math.max(1, short) < 2) return "content";
  // 3) 过半落在内容矩形外
  const ix = Math.max(0, Math.min(bbox[2], contentRect[2]) - Math.max(bbox[0], contentRect[0]));
  const iy = Math.max(0, Math.min(bbox[3], contentRect[3]) - Math.max(bbox[1], contentRect[1]));
  const area = w * h;
  if (area > 0 && (ix * iy) / area < UNCOVERED_CONTENT_OVERLAP_MIN) return "furniture";
  return "content";
}

/** 该页「内容矩形」= 全部行级块（blocks，含图片块）bbox 的并集。无块时退化为整页
 *  （⇒ 什么都不算页边带，全部保守判内容级）。 */
export function contentRectOf(page: StagePage): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of page.blocks ?? []) {
    const bb = b.bbox;
    if (!Array.isArray(bb)) continue;
    x0 = Math.min(x0, bb[0]);
    y0 = Math.min(y0, bb[1]);
    x1 = Math.max(x1, bb[2]);
    y1 = Math.max(y1, bb[3]);
  }
  if (!Number.isFinite(x0)) return [0, 0, page.width, page.height];
  return [x0, y0, x1, y1];
}


/** P5 二进制灰度图（PGM） */
export interface GrayImage {
  width: number;
  height: number;
  /** 行优先灰度字节（长度 = width×height） */
  data: Uint8Array;
}

const isPgmSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * 解析 PGM（P5）：文本头（magic / 宽 / 高 / maxval，空白分隔，# 起注释）+ 原始灰度字节。
 * 纯函数、无依赖（不引入任何图像库）。
 */
export function parsePgm(buf: Uint8Array): GrayImage {
  let i = 0;
  const token = (): string => {
    while (i < buf.length && isPgmSpace(buf[i]!)) i++;
    if (buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i++;
      return token();
    }
    let s = "";
    while (i < buf.length && !isPgmSpace(buf[i]!)) {
      s += String.fromCharCode(buf[i]!);
      i++;
    }
    return s;
  };
  const magic = token();
  if (magic !== "P5") throw new Error(`PGM 头不是 P5：${magic || "(空)"}`);
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !(max > 0 && max <= 255)) {
    throw new Error("PGM 头非法（宽/高/maxval）");
  }
  i++; // maxval 后恰好一个空白（不可跳过多个：灰度值本身可能是空白字节）
  return { width, height, data: buf.subarray(i, i + width * height) };
}

/**
 * 纯函数：页图 + 该页全部 bbox → 未覆盖墨迹矩形区域（PDF 点）+ 像素统计。
 * 聚类用「膨胀 + 8 邻域连通域」（不用复杂的形态学库）：够用、可测。
 * `page.contentRect` 用于区域分类（内容级/家具级，见 classifyUncovered）；缺省整页。
 */
export function findUncoveredInk(
  image: GrayImage,
  page: { width: number; height: number; boxes: BBox[]; contentRect?: BBox },
  opts: { threshold: number; expandPx: number; dilatePx: number; minAreaPx: number },
): { regions: UncoveredRegion[]; inkPx: number; uncoveredPx: number } {
  const { width: W, height: H, data } = image;
  const N = W * H;
  const sx = W / page.width;
  const sy = H / page.height;
  const contentRect: BBox = page.contentRect ?? [0, 0, page.width, page.height];

  // 1) 二值化：墨迹掩码
  const ink = new Uint8Array(N);
  let inkPx = 0;
  for (let k = 0; k < N; k++) {
    if (data[k]! < opts.threshold) {
      ink[k] = 1;
      inkPx++;
    }
  }

  // 2) 覆盖掩码：全部 bbox 换算像素并外扩
  const cov = new Uint8Array(N);
  for (const [x0, y0, x1, y1] of page.boxes) {
    const ax0 = Math.max(0, Math.floor(x0 * sx) - opts.expandPx);
    const ay0 = Math.max(0, Math.floor(y0 * sy) - opts.expandPx);
    const ax1 = Math.min(W - 1, Math.ceil(x1 * sx) + opts.expandPx);
    const ay1 = Math.min(H - 1, Math.ceil(y1 * sy) + opts.expandPx);
    for (let y = ay0; y <= ay1; y++) {
      const base = y * W;
      for (let x = ax0; x <= ax1; x++) cov[base + x] = 1;
    }
  }

  // 3) 未覆盖墨迹 = 是墨迹 ∧ 不在任何覆盖框内
  const un = new Uint8Array(N);
  let uncoveredPx = 0;
  for (let k = 0; k < N; k++) {
    if (ink[k] === 1 && cov[k] === 0) {
      un[k] = 1;
      uncoveredPx++;
    }
  }

  // 4) 膨胀（连接同行内的窄缝）
  const r = opts.dilatePx;
  const dil = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (un[y * W + x] === 0) continue;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H - 1, y + r);
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) {
        const base = yy * W;
        for (let xx = x0; xx <= x1; xx++) dil[base + xx] = 1;
      }
    }
  }

  // 5) 8 邻域连通域（BFS，显式栈）→ 精确 bbox + 真实未覆盖墨迹像素数
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  const regions: UncoveredRegion[] = [];
  for (let s = 0; s < N; s++) {
    if (dil[s] === 0 || seen[s] === 1) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    let minX = W;
    let maxX = -1;
    let minY = H;
    let maxY = -1;
    let area = 0;
    while (sp > 0) {
      const c = stack[--sp]!;
      const cy = (c / W) | 0;
      const cx = c - cy * W;
      if (un[c] === 1) {
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= W) continue;
          const ns = ny * W + nx;
          if (dil[ns] === 1 && seen[ns] === 0) {
            seen[ns] = 1;
            stack[sp++] = ns;
          }
        }
      }
    }
    if (area < opts.minAreaPx) continue;
    const bbox: BBox = [minX / sx, minY / sy, (maxX + 1) / sx, (maxY + 1) / sy];
    regions.push({ bbox, area, kind: classifyUncovered(bbox, contentRect, page.width, page.height) });
  }
  regions.sort((a, b) => b.area - a.area);
  return { regions, inkPx, uncoveredPx };
}

/** 用 pdftoppm 把原卷渲染成逐页灰度图（PGM）。任何失败都抛异常，由调用方降级。 */
export function renderGrayPages(pdfPath: string, dpi: number): GrayImage[] {
  const dir = mkdtempSync(join(tmpdir(), "ink-"));
  try {
    execFileSync("pdftoppm", ["-gray", "-r", String(dpi), pdfPath, join(dir, "pg")], {
      timeout: 180_000,
    });
    return readdirSync(dir)
      .filter((f) => f.endsWith(".pgm"))
      .sort()
      .map((f) => parsePgm(new Uint8Array(readFileSync(join(dir, f)))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 全卷墨迹覆盖率：渲染灰度页 → 逐页找未覆盖墨迹 → 汇总。
 * 页序与 snapshot.pages 一一对应（都按 index 升序）。
 */
export function computeInkCoverage(
  pdfPath: string,
  pages: StagePage[],
  dpi = INK_DPI,
): { byPage: UncoveredRegion[][]; coverage: InkCoverage } {
  const images = renderGrayPages(pdfPath, dpi);
  const opts = {
    threshold: INK_THRESHOLD,
    expandPx: INK_EXPAND_PX,
    dilatePx: INK_DILATE_PX,
    minAreaPx: INK_MIN_AREA_PX,
  };
  const byPage: UncoveredRegion[][] = [];
  const stats: InkCoverage["pages"] = [];
  let totalInkPx = 0;
  let uncoveredPx = 0;
  let contentCount = 0;
  let furnitureCount = 0;
  pages.forEach((p, i) => {
    const img = images[i];
    if (!img) {
      byPage.push([]);
      stats.push({ index: p.index, inkPx: 0, uncoveredPx: 0, ratio: 0, contentCount: 0, furnitureCount: 0 });
      return;
    }
    const boxes: BBox[] = [];
    for (const src of [p.blocks, p.raw, p.discarded]) {
      for (const b of src ?? []) if (Array.isArray(b.bbox)) boxes.push(b.bbox);
    }
    const { regions, inkPx, uncoveredPx: unPx } = findUncoveredInk(
      img,
      { width: p.width, height: p.height, boxes, contentRect: contentRectOf(p) },
      opts,
    );
    const content = regions.filter((r) => r.kind === "content").length;
    const furniture = regions.length - content;
    byPage.push(regions);
    stats.push({
      index: p.index,
      inkPx,
      uncoveredPx: unPx,
      ratio: inkPx ? unPx / inkPx : 0,
      contentCount: content,
      furnitureCount: furniture,
    });
    totalInkPx += inkPx;
    uncoveredPx += unPx;
    contentCount += content;
    furnitureCount += furniture;
  });
  return {
    byPage,
    coverage: {
      dpi,
      threshold: opts.threshold,
      expandPx: opts.expandPx,
      dilatePx: opts.dilatePx,
      minAreaPx: opts.minAreaPx,
      totalInkPx,
      uncoveredPx,
      ratio: totalInkPx ? uncoveredPx / totalInkPx : 0,
      contentCount,
      furnitureCount,
      pages: stats,
    },
  };
}

/**
 * **把 OCR 读到的「题号行」补成块**（2026-10-12 用户当场指出「第 1 题漏识别」后加）。
 *
 * 动机：MinerU 会**整行漏识别** —— 答案册 p17 的 `1. AD 必刷模型·传送带模型` 在原卷清晰可见，
 * 却在 `para_blocks`/`preproc_blocks`/`discarded_blocks` **三层里都不存在**；
 * 于是引擎看不到题号 ⇒ 那道题不存在，它的【解析】被并进上一题（题号序列缺 1）。
 *
 * 而我们已经有两个现成的独立信号：
 * - **墨迹覆盖率检查**发现了这处墨迹（标为内容级未覆盖区域 `[20,400,260,414]`，240×14pt）；
 * - **OCR 候选补全**读对了文本（`1. AD 必刷模型·传送带模型`），只是被宽度比判据拒了。
 * ⇒ 这里把「读对了的题号行」补回块流，喂给引擎（补进去的块同时进展示层，两边一致）。
 *
 * 三条纪律：
 * 1. **只补题号行**（`matchFirstLine` 判为 `question_no`），不补其它文本；
 * 2. **只补引擎确实没有的题号**（同页同号且位置相近 ⇒ 已有，跳过，避免重复造题）；
 * 3. 补进去的块带 `fromOcr: true`，展示层以**候选**样式呈现（不静默替换，G1）。
 */
function injectOcrQuestionLines(doc: ParsedDocument, docId: string): number {
  const outDir = join("data", "out", docId);
  const items: { page: number; bbox: BBox; text: string }[] = [];
  for (const name of ["ocr-fill.json", "ocr-page-fill.json"]) {
    const f = join(outDir, name);
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as {
        pages?: { page: number; items?: { bbox: number[]; text?: string }[] }[];
      };
      for (const pg of j.pages ?? []) {
        for (const it of pg.items ?? []) {
          if (it.text) items.push({ page: pg.page, bbox: it.bbox as BBox, text: it.text });
        }
      }
    } catch {
      /* 读不动就跳过 */
    }
  }
  let injected = 0;
  for (const it of items) {
    const page = doc.pages.find((pg) => pg.index === it.page);
    if (!page) continue;
    const first = (it.text.split("\n")[0] ?? "").trim();
    const m = matchFirstLine(first);
    if (m.kind !== "question_no") continue; // ① 只补题号行
    const num = m.captured;
    const exists = page.blocks.some((b) => {
      if (b.kind !== "text") return false;
      const bm = matchFirstLine(b.firstLine);
      return bm.kind === "question_no" && bm.captured === num && Math.abs(b.bbox[1] - it.bbox[1]) < 24; // ②
    });
    if (exists) continue;
    page.blocks.push({
      kind: "text",
      bbox: it.bbox,
      text: it.text,
      firstLine: first,
      lineCount: 1,
      maxFontSize: 0,
      fromOcr: true, // ③
    });
    injected++;
  }
  return injected;
}

/** 归一化用于「OCR 行 ↔ 块」匹配：去空白/数学记号/标点，只留字面 */
const normForMatch = (s: string) => s.replace(/[\s$\\{}_^，,。.、;；:：]/g, "");

/** 在页内找「包含某 OCR 行开头」的**文本块**（用于给补入行定位） */
function findBlockByLine(
  page: ParsedDocument["pages"][number],
  line: string,
): Extract<ParsedBlock, { text: string }> | null {
  const key = normForMatch(line).slice(0, 10);
  if (key.length < 6) return null;
  const hit = page.blocks.find((b) => b.kind !== "image" && b.kind !== "formula" && normForMatch(b.text).includes(key));
  return hit && hit.kind !== "image" && hit.kind !== "formula" ? hit : null;
}

/**
 * OCR **整页全文**补行（第二来源；与 items 路径互补）。
 *
 * 为什么需要它：上游偶尔把**整行**吞进一个更宽的 bbox —— 那一行的墨迹落在 bbox 内，
 * 于是墨迹分析**看不到**它（不会被标成「未覆盖」⇒ 不进 `items`），补行链路就漏了。
 * 但整页 OCR 的 `fullText` 里有这一行。实测（2026-10-14）：答案册 p10 的
 * `6. D 必刷考点·共点力平衡` 整行被 MinerU 丢掉，其墨迹被吞进 `【解析】…` 那个块的 bbox
 * （[63,47,353,156]），items 路径看不见它 —— 直接后果是题库里这道题**永远配不到答案**。
 *
 * ⚠️ **判据必须比 items 路径更严**：`items` 的候选来自未覆盖墨迹（位置可靠），
 * `fullText` 只有形状、没有坐标。实测 p15 的 fullText 里混着「方法技巧」方框内的说明条目
 * （`1. 质点从竖直圆环上沿不同的光滑弦…` / `2. 质点从竖直圆环上最高点…`，且 `▶` 被 OCR 读丢）
 * —— 若只看「行首是不是题号形态」，就会把刚修掉的假题**补回来**。
 * ⇒ 只补**像答案条目**的行（题号后紧跟答案字母 / 小问 / 【解析】 / 必刷标签，见 `looksLikeAnswerEntry`）。
 *
 * 定位：用 OCR 的**下一行**在页内找到对应块，把补入行放在它**正上方**（同一栏）。
 * 找不到落点就**跳过并报数**（不猜坐标、不静默）。
 */
function injectOcrFullTextLines(doc: ParsedDocument, docId: string): { injected: number; skipped: number } {
  const f = join("data", "out", docId, "ocr-page-fill.json");
  if (!existsSync(f)) return { injected: 0, skipped: 0 };
  let data: { pages?: { page: number; fullText?: string }[] };
  try {
    data = JSON.parse(readFileSync(f, "utf8")) as typeof data;
  } catch {
    return { injected: 0, skipped: 0 };
  }
  let injected = 0;
  let skipped = 0;
  for (const pg of data.pages ?? []) {
    if (!pg.fullText) continue;
    const page = doc.pages.find((p) => p.index === pg.page);
    if (!page) continue;
    const lines = pg.fullText.split("\n").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = matchFirstLine(line);
      if (m.kind !== "question_no") continue;
      /**
       * 两类候选（判据都取最严）：
       * ① **答案条目**：题号后紧跟答案字母/小问/`$`/【解析】/必刷标签 —— 答案册形态；
       * ② **题号独占一行**（整行只有一个编号 + 分隔符）—— 光学卷形态（2026-10-27 实测）：
       *    题号印在**题目末尾**，题干在下一栏或下一页顶部。这类行 `looksLikeAnswerEntry`
       *    不成立（后面什么都没有），但它是真题号，漏了就会把两三道题并成一道。
       */
      const bareNumber = /^\d{1,2}\s*[.．、)）]\s*$/.test(line);
      if (!looksLikeAnswerEntry(line) && !bareNumber) continue;
      const num = m.captured;
      const exists = page.blocks.some((b) => {
        if (b.kind !== "text") return false;
        const bm = matchFirstLine(b.firstLine);
        return bm.kind === "question_no" && bm.captured === num;
      });
      if (exists) continue; // 该页已有同号题切口
      // 显式声明结构类型：`ParsedBlock` 的 text 与 table 共用同一分支，
      // `Extract<…, {kind:"text"}>` 会退化成 never（2026-10-27 踩到）。
      let target: { bbox: BBox; lineCount: number } | null = findBlockByLine(page, lines[i + 1] ?? "");
      // 题号独占行 + 后面没有可锚定的行 ⇒ 它印在**页尾**（题干在下一页）。
      // 放到本页最后一个文字块的下方：阅读顺序上等于「页尾开新题」，下一页的题干自然接上。
      let below = false;
      if (!target && bareNumber) {
        const texts = page.blocks.filter(
          (b): b is Extract<ParsedBlock, { text: string }> => b.kind === "text" || b.kind === "table",
        );
        if (!texts.length) {
          skipped++;
          continue;
        }
        let last = texts[0]!;
        for (const t of texts) if (t.bbox[3] > last.bbox[3]) last = t;
        target = last;
        below = true;
      }
      if (!target) {
        skipped++;
        continue;
      }
      const h = Math.max(6, (target.bbox[3] - target.bbox[1]) / Math.max(1, target.lineCount));
      page.blocks.push({
        kind: "text",
        bbox: below
          ? [target.bbox[0], target.bbox[3] + 1, target.bbox[2], target.bbox[3] + 1 + h]
          : [target.bbox[0], target.bbox[1] - h, target.bbox[2], target.bbox[1]],
        text: line,
        firstLine: line,
        lineCount: 1,
        maxFontSize: 0,
        fromOcr: true,
      });
      injected++;
    }
  }
  return { injected, skipped };
}

function main(): void {
  const docId = process.argv[2] ?? "23必刷题 2相互作用";
  const layoutPath = process.argv[3] ?? join("data", "smoke", "unpacked", "layout.json");
  const raw = JSON.parse(readFileSync(layoutPath, "utf8"));

  const doc = normalizeLayout(raw, docId);
  // ⚠️ 先补「OCR 读到的题号行」，再切分 —— 否则整行被上游漏掉的题根本不存在（见函数注释）
  const injected = injectOcrQuestionLines(doc, docId);
  if (injected) console.log(`  OCR 补入题号行 ${injected} 处（上游整行漏识别，展示层以候选样式呈现）`);
  // 第二来源：整页 OCR 全文（补「墨迹被吞进更宽 bbox、items 看不见」的整行漏识别，见函数注释）
  const full = injectOcrFullTextLines(doc, docId);
  if (full.injected || full.skipped) {
    console.log(
      `  OCR 整页全文补入题号行 ${full.injected} 处` +
        (full.skipped ? `（另有 ${full.skipped} 处找不到落点，已跳过）` : ""),
    );
  }
  // 人工已核对的上游错误修正（corrections/<docId>.json）—— 必须在**切题之前**应用，
  // 否则修正只影响显示、不影响切题判定。清单进仓库、可审计；缺失即跳过（引擎行为不变）。
  const correctionPath = join("corrections", `${docId}.json`);
  if (existsSync(correctionPath)) {
    const file = JSON.parse(readFileSync(correctionPath, "utf8")) as CorrectionFile;
    const rep = applyCorrections(doc, file);
    console.log(
      `  已核对修正：替换 ${rep.replace} 块 · 补入图注 ${rep.insert} 处` +
        (rep.missed.length > 0 ? `（⚠️ ${rep.missed.length} 条未命中，清单可能已过期）` : ""),
    );
  }

  const result = ruleStrategy.segment(doc);
  const snapshot = buildStageSnapshot(doc, result, extractRawBlocks(raw), extractDiscardedBlocks(raw));

  const outDir = join("data", "out", docId);
  mkdirSync(outDir, { recursive: true });

  // OCR 候选补全（**仅新增字段**，缺失时保持空数组）。两条来源：
  //   - `ocr-fill.json`：**区域裁图**（scripts/ocr-fill.ts）—— 窗口按行裁，位置天然对得上；
  //   - `ocr-page-fill.json`：**整页 OCR**（scripts/ocr-page-fill.ts）—— 上下文完整、文本更干净，
  //     但它会把折行的选项并成一行，按比例切分会把下一行开头派给上一行（热狗题实测）。
  //   ⇒ 合并规则：**裁图已 accepted 的保留，整页只补裁图没补上的洞。**
  // 与快照解耦：重导快照不丢产物，重跑 OCR 也不碰其它字段。
  const readOcrJson = (name: string) => {
    const path = join(outDir, name);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as {
        pages?: { page: number; items?: OcrFillItem[]; fullText?: string }[];
      };
    } catch (e) {
      console.log(`  ${name} 读取失败，跳过：${String(e).slice(0, 80)}`);
      return null;
    }
  };
  const cropJson = readOcrJson("ocr-fill.json");
  const pageJson = readOcrJson("ocr-page-fill.json");
  if (cropJson || pageJson) {
    const cropByPage = new Map<number, OcrFillItem[]>();
    for (const pg of cropJson?.pages ?? []) {
      cropByPage.set(pg.page, (pg.items ?? []).map((x) => ({ ...x, source: x.source ?? "crop" })));
    }
    const pageByPage = new Map<number, { items: OcrFillItem[]; fullText: string }>();
    for (const pg of pageJson?.pages ?? []) pageByPage.set(pg.page, { items: pg.items ?? [], fullText: pg.fullText ?? "" });
    const hit = (a: BBox, b: BBox) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    /**
     * **形状前置条件**：未覆盖区域是「横向文字行碎片」，所以它必须**明显比高宽**。
     *
     * 实测反例（题册 p11 `[548,171,584,219]` = 36×48pt，**高 > 宽**）：那里是页边的一个小标记，
     * 裁图 OCR 给了 `第一章`、整页给了长文本 —— **两条路径都错**，而两条的宽度比都落在合格区间。
     * ⇒ 洞本身的形状不对时，任何文本都不可信。
     *
     * 这里统一判（两种来源都过），并把结果写回 item，保证快照自身自洽。
     */
    const shapeOk = (b: BBox) => {
      const w = b[2] - b[0];
      const h = b[3] - b[1];
      return h > 0 && w / h >= 1.5;
    };
    const fixShape = (x: OcrFillItem): OcrFillItem =>
      x.accepted && !shapeOk(x.bbox)
        ? {
            ...x,
            accepted: false,
            reason: `洞不是横向文字行（${Math.round(x.bbox[2] - x.bbox[0])}×${Math.round(x.bbox[3] - x.bbox[1])}pt，高 ≥ 宽）`,
          }
        : x;
    let nCrop = 0;
    let nPage = 0;
    let nShape = 0;
    for (const pg of snapshot.pages) {
      const crop = (cropByPage.get(pg.index) ?? []).map(fixShape);
      const page = pageByPage.get(pg.index);
      const filled = crop.filter((x) => x.accepted).map((x) => x.bbox);
      const extra = (page?.items ?? [])
        .map(fixShape)
        .filter((x) => x.accepted && !filled.some((f) => hit(f, x.bbox)));
      pg.ocrFill = crop.concat(extra);
      pg.ocrFullText = page?.fullText ?? "";
      nCrop += filled.length;
      nPage += extra.length;
      nShape += crop.concat(extra).filter((x) => !x.accepted && (x.reason ?? "").startsWith("洞不是横向")).length;
    }
    console.log(
      `  OCR 候选补全：裁图 ${nCrop} 条 + 整页补 ${nPage} 条（整页只补裁图没补上的洞）` +
        (nShape ? `；形状前置条件否掉 ${nShape} 条` : ""),
    );
  }
  // questions.json 与 stages.json 同源重生成：viewer 与 stages 消费同一份引擎产物，
  // 避免算法修复后两个展示层各说各话
  writeFileSync(join(outDir, "questions.json"), JSON.stringify(result.questions, null, 2));
  writeFileSync(join(outDir, "stages.json"), JSON.stringify(snapshot, null, 1));

  // 原卷 PDF 一并复制到 data/out/<docId>/，供展示层「原卷对照」内嵌浏览；
  // 本机有 pdftoppm（poppler）时再渲染逐页 PNG（任何浏览器可靠显示，缺工具则跳过降级 PDF）。
  const unpackedDir = join(layoutPath, "..");
  // 原卷 PDF 的命名有**两种**历史形态，都认（否则静默降级成「没有页图、墨迹 —%」）：
  //   · `<docId>_origin.pdf` —— `npm run daily` 与 unpack 的约定（首选）
  //   · `origin.pdf`         —— 早期手工放的文件
  const originPdf =
    readdirSync(unpackedDir).find((f) => f.endsWith("_origin.pdf")) ??
    (existsSync(join(unpackedDir, "origin.pdf")) ? "origin.pdf" : undefined);
  let originPages = 0;
  if (originPdf) {
    const pdfPath = join(outDir, "origin.pdf");
    copyFileSync(join(unpackedDir, originPdf), pdfPath);
    try {
      const pagesDir = join(outDir, "pages");
      mkdirSync(pagesDir, { recursive: true });
      execFileSync("pdftoppm", ["-png", "-r", "120", pdfPath, join(pagesDir, "page")], {
        timeout: 120_000,
      });
      originPages = readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length;
    } catch {
      console.log("  pdftoppm 不可用或渲染失败，原卷对照降级为 PDF 内嵌");
    }
  }

  // 墨迹覆盖率检查（Task 16）：用原卷页图当地面真值，找「解析漏掉的墨迹」。
  //
  // 异常分两类（修复轮 1，勿再合并成 `catch {}`）：
  //   · **ENOENT**（pdftoppm 不存在 / PDF 缺失）→ **优雅降级**：inkCoverage=null，继续，exit 0。
  //     `npm run check` 要能在无 PDF 的环境跑。
  //   · **其它异常**（PGM 解析失败、尺寸不符、逻辑错）→ **绝不吞**：记入 `inkCoverageError`
  //     落库（审计据此判失败 → check 红）**并**抛出（export 自身也红）。
  //     理由：门自身出 bug 若被静默降级，检查会**假绿**——违背 G1「不静默失败」。
  let inkNote = "";
  if (originPdf) {
    try {
      const { byPage, coverage } = computeInkCoverage(join(outDir, "origin.pdf"), snapshot.pages);
      snapshot.pages.forEach((p, i) => {
        p.uncovered = byPage[i] ?? [];
      });
      snapshot.inkCoverage = coverage;
      inkNote =
        `  墨迹覆盖率：全卷未覆盖占比 ${(coverage.ratio * 100).toFixed(2)}%` +
        `（${coverage.uncoveredPx}/${coverage.totalInkPx}px）· 内容级 ${coverage.contentCount} / 家具级 ${coverage.furnitureCount}`;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        console.log("  pdftoppm 不存在（或 PDF 缺失），墨迹覆盖率检查优雅降级跳过（inkCoverage=null）");
      } else {
        snapshot.inkCoverageError = `墨迹分析失败：${err?.stack ?? String(e)}`;
        console.error(`  ❌ 墨迹分析出现非预期异常（非 pdftoppm 缺失）：${err?.message ?? e}`);
        console.error("     → 记入快照 inkCoverageError（审计将判失败），并终止导出。");
      }
    }
  }

  const totalBlocks = snapshot.pages.reduce((a, p) => a + p.blocks.length, 0);
  const flagged = result.questions.filter((q) => q.status === "needs_review").length;
  snapshot.originPages = originPages;
  writeFileSync(join(outDir, "stages.json"), JSON.stringify(snapshot, null, 1));
  console.log(`阶段快照已写入 ${join(outDir, "stages.json")}`);
  if (originPdf) console.log(`原卷 PDF 已复制 ${join(outDir, "origin.pdf")}`);
  if (originPages > 0) console.log(`原卷页图 ${originPages} 张 → ${join(outDir, "pages")}`);
  if (inkNote) console.log(inkNote);
  console.log(
    `  ${snapshot.pages.length} 页 · ${totalBlocks} 行级块 · ${result.questions.length} 题 · ` +
      `质检诊断 ${result.reviews.length} 条（需人工校对 ${flagged} 题）`,
  );

  // 墨迹分析出了非预期异常：快照已落库（审计据此判失败），这里再抛一次让导出自身也红 ——
  // 绝不静默（修复轮 1 发现 1）。
  if (snapshot.inkCoverageError) {
    throw new Error(snapshot.inkCoverageError);
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
