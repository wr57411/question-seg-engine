// scripts/export-stages.ts
/**
 * 阶段样品展示快照导出（唯一允许 import 引擎 src/ 的展示层上游）。
 * 跑一遍真实管线（normalizeLayout → layoutPage → segmentFromLayout），
 * 把各阶段中间产物收进 data/out/<docId>/stages.json，
 * 供 stages/ 前端（不 import 引擎代码）做可视化展示。
 *
 * 运行：npm run stages:export -- <docId> <layoutPath>（两参均必传）
 * M5-B（no-MinerU）：MinerU 默认输入已拆 —— 缺 layoutPath 用法报错退出 2，不再落
 * data/smoke/unpacked/layout.json；骨架源无关，喂哪份 layout 由调用方显式决定（daily 自动传）。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ruleStrategy } from "../src/index.js";
import { looksLikeAnswerEntry, matchFirstLine } from "../src/patterns.js";
import { normalizeLayout } from "../src/normalize.js";
import { detectColumnCenters, detectColumns, layoutPage } from "../src/layout.js";
import { applyCorrections, type ApplyReport, type CorrectionFile } from "../src/corrections.js";
import { scanFormulaNoise, type FormulaNoiseReport } from "../src/formula.js";
import {
  planBlockIndexRebuilds,
  type FlatBlock,
  type RebuildReport,
} from "./lib/block-indexes-rebuild.js";
import type { BBox, CrossPageLeakRecord, IndexedBlock, ParsedBlock, ParsedDocument, SegmentationResult } from "../src/types.js";
import { normalizeGuardText, type TitleGuardEntry } from "./oxr-title-guard.js";

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
  /** 上游表格 HTML（MinerU spans[].html；text 路由时被 table-v3.json 的 V3 pred_html 替换） */
  html?: string;
  /** OCR 补入行标记（injectOcrQuestionLines / injectOcrFullTextLines） */
  ocr?: boolean;
  /** 人工已核对修正标记（corrections/） */
  correction?: boolean;
  /* ── S2 放置新增字段（spec 2026-11-13 §5.1，只增不改旧字段；产物缺失时不产出 ⇒ 旧快照逐字节兼容） ── */
  /** 上游表格分类（table-v3.json）：text=V3 HTML / image=整表截图 / borderless=守卫跳过 */
  tableClass?: "text" | "image" | "borderless";
  /** html 的来源旗标（缺省=mineru） */
  tableSource?: "v3" | "mineru";
  /** 相对 doc 目录的裁图子路径（table-crops/… 或 giant-crop/crops/…） */
  crop?: string;
  /** 裁图原生像素 [w,h]（放置器只缩不放的依据） */
  cropSize?: [number, number];
  /** 行级坐标来源：crop=巨带截断回退（B-39 truncationCropFallback），展示层裁图例外放置 */
  coordSource?: "ink" | "crop";
  /** M2 markdown 漏泄组：本块由该 i 的首块并集裁图呈现（展示层不重复画，原文仍留 text/title） */
  leakCoveredBy?: number;
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
  /**
   * 骨架输入溯源（M1 no-MinerU）：本次导出喂入的 layout.json 路径（argv[3] 原样）。
   * 导出器源无关 —— 喂 MinerU layout 产 MinerU 骨架、喂 OXR layout 产 OXR 骨架；
   * 此字段让「blocks 来源是哪份 layout」可从快照自身核对，不靠命令行口说。
   * **仅新增字段**：旧快照缺省（undefined），展示层不消费也不受影响。
   */
  layoutInput?: string;
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
  /**
   * 修正清单应用报告（2026-10-28 新增）。null = 本卷无清单。
   * `unverified` 非空 = 有未逐条回原卷核对但已应用的条目（不静默，meta 体检会显示）。
   */
  corrections: ApplyReport | null;
  /**
   * OCR 输入文件解析错误（文件存在但读不动/结构异常；文件缺失不算错误）。
   * 非空 = 题号补行/候选合并可能被跳过，meta 体检会显示。
   */
  ocrInputErrors: string[];
  /**
   * 跨页泄漏行记录（B-47，normalize 层产）。空/缺省 = 无跨页泄漏
   * （OXR 无 `preproc_blocks` ⇒ 判据整体跳过，产物逐字节不变）。
   * 非空 = 有行从本页滤除并迁回真页；逐条可核对（页 index + bbox + text + 判据）。
   */
  crossPageLeaks?: CrossPageLeakRecord[];
  /**
   * M7-A 标题守卫/补识应用报告（`title-guard.json` 产物驱动）。
   * 缺省 = 本卷无该产物（快照逐字节不变，与 table-v3/giant-crop 同纪律）。
   * 非空 = 补回了 OXR 丢失的内容标题/散文/标签；逐条清单见产物本身。
   */
  titleGuard?: { entries: number; applied: number; skipped: number };
  /**
   * `source.blockIndexes` 导出期重建报告（B-66）。引擎记录的是切题游标区间且边界滞后
   * ⇒ 系统性混入上一题（head 检验 书A 15.8% / 书B 26.1% miss，且低估）；
   * 导出时按「stem 首段文本反查真实块范围」重建（判据纯函数见
   * `scripts/lib/block-indexes-rebuild.ts`，不改引擎切题，stem/options/题数一字不动）。
   * 缺省 = 重建未启用（`--no-block-rebuild`）或旧快照；保留原值的题全量列在 `keptIds`（不静默）。
   */
  blockIndexesRebuild?: RebuildReport;
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
        // 表格块：带上游 HTML，展示层据此画真网格（DECISIONS §76）。
        // 引擎不消费它；切题结果与无此字段时逐字节一致（全量 A/B 已验）。
        ...(b.kind === "table" && b.html ? { html: b.html } : {}),
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
    /** 修正清单应用报告：由 main() 在应用清单后回填 */
    corrections: null,
    /** OCR 输入解析错误：由 main() 在读取 OCR 产物后回填 */
    ocrInputErrors: [],
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
 * 读取一个 OCR JSON 文件。**缺失 = 正常**（未跑 OCR），返回 `{json:null,error:null}`；
 * **存在但读不动/解析失败 = 异常**，返回错误说明，由调用方汇总到 `ocrInputErrors`。
 *
 * 为什么要区分：文件不存在是“用户没跑 OCR”的合法状态；文件存在却读不动
 * （中断、磁盘满、手工编辑）会让题号补行静默失效、题数无声减少 —— 必须可见（G1）。
 */
export function readOcrJsonFile(path: string): { json: unknown; error: string | null } {
  if (!existsSync(path)) return { json: null, error: null };
  try {
    return { json: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (e) {
    return { json: null, error: `${path} 读取/解析失败：${String(e).slice(0, 120)}` };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * S2 放置上游透传（spec docs/plans/2026-11-13-表格与巨带放置实现.md §5.1）
 *
 * 纪律：
 * - **只消费产物、只增新字段**：table-v3.json / giant-crop.pNN.json 缺失或为空时，
 *   快照逐字节不变（与 B-39 truncationCropFallback 默认关旗标同纪律）。
 * - **判据取最严 AND**：表格按 bbox IoU≥0.5；巨带行按 norm 框四边近等 + 文本归一化包含。
 *   段落块包含某行文本**不挂** —— 整段换单行裁图会丢其余行内容（红线：不丢内容）。
 * - **不静默**：未匹配/缺 html/缺裁图的条目计数返回，由 main() 打日志。
 * - 分类与守卫在 scripts/（上游），展示层只消费快照字段（解耦红线）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** table-v3.json 的一条表格分类（上游显式产物；bbox 为 PDF 点，page 为 0 基页索引） */
export interface TableV3Entry {
  page: number;
  bbox: BBox;
  class: "text" | "image" | "borderless";
  source?: "v3" | "mineru";
  /** text 路由的 V3 结构化 HTML（G3：缺 html 的 text 条目不挂，防半路降级丢格） */
  html?: string;
  /** image 路由：相对 doc 目录的整表裁图 */
  crop?: string;
  cropSize?: [number, number];
  /** G1 墨迹守卫测量值（留证，展示层不重算） */
  guard?: { hRunW: number; vRunH: number };
  note?: string;
}

/** giant-crop.pNN.json 的一条受害者行（scripts/audit-giant-crop.ts 产物） */
export interface GiantCropVictim {
  id: string;
  /** 0 基页索引 */
  page: number;
  text: string;
  v3box: BBox;
  /** 回退框（PDF 点）：B-39 截断行保留 V3 紧框 */
  fallbackBox: BBox;
  /** 裁图绝对路径；null = 未回填 JSON（按约定命名 {id}-{page+1:03d}.png 解析，仍须盘上存在） */
  crop: string | null;
}

/** 表格匹配门槛：IoU≥0.5（两源框实测近等，见 spec §5.1 数值核对） */
const TABLE_MATCH_MIN_IOU = 0.5;

function bboxIoU(a: BBox, b: BBox): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 消费 table-v3.json：按 IoU≥0.5 匹配同页 table 块，挂 tableClass/tableSource/html|crop。
 * - text：必须有 html（G3 完整性门），替换既有 html（tableSource=v3 留来源旗标）；
 * - image：挂 crop/cropSize，**既有 html 保留不丢**（渲染分支优先 crop）；
 * - borderless：只标 class（renderPaper 双保险跳过网格 + coveredByTable）。
 * 返回 {attached, unmatched}：未匹配/缺件条目计数可见，不静默。
 */
export function applyTableV3(page: StagePage, entries: TableV3Entry[]): { attached: number; unmatched: number } {
  let attached = 0;
  let unmatched = 0;
  for (const e of entries) {
    if (e.page !== page.index) continue;
    if (e.class === "text" && !e.html) {
      unmatched++;
      continue;
    }
    if (e.class === "image" && (!e.crop || !e.cropSize)) {
      unmatched++;
      continue;
    }
    let best: StageBlock | null = null;
    let bestIou = TABLE_MATCH_MIN_IOU;
    for (const b of page.blocks) {
      if (b.kind !== "table") continue;
      const iou = bboxIoU(b.bbox, e.bbox);
      if (iou >= bestIou) {
        bestIou = iou;
        best = b;
      }
    }
    if (!best) {
      unmatched++;
      continue;
    }
    best.tableClass = e.class;
    best.tableSource = e.source ?? "v3";
    if (e.class === "text") best.html = e.html;
    if (e.class === "image") {
      best.crop = e.crop;
      best.cropSize = e.cropSize;
    }
    attached++;
  }
  return { attached, unmatched };
}

/**
 * 表格 HTML 压平为纯文本（仅供插入块的快照 text/title/search 用；渲染仍走 html 本体）。
 * 单元格→\t、行→\n、<br>→\n；常见实体还原；不是判据、不参与任何匹配。
 */
function flattenTableHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * M3（no-MinerU）：消费 table-v3.json 的**插入+覆盖**双模式。
 *
 * 背景：OXR 读表为 0，现 kind=table 块来自 DECISIONS §90 压平表格行重建（合成 html，
 * 单元格可能含 markdown 网址残字）；§90 未重建出的表（曲线运动 index 3/8/11、万有引力 index 0）
 * 在旧覆盖模式下整段消失 ⇒ 这里按 V3 bbox **插入** kind=table 块补上。
 *
 * 行为：
 * - 与现有 kind=table 块 IoU≥0.5 匹配 ⇒ **逐条委托 applyTableV3 覆盖**（字段写法/判据完全一致，
 *   全匹配场景与旧 applyTableV3 单跑逐字节相同——行为不变红线）；
 * - 无匹配的完整条目（text 带 html / image 带 crop+cropSize）⇒ 插入新 kind=table 块：
 *   i=现有最大 i+1；order 槽按 y（新表中心 y 与 order 中各块中心 y 比较，插首个更大者之前，
 *   否则追加末尾）；text 路由 html=V3 pred_html 原样 + text=压平全文；image 路由挂 crop/cropSize；
 * - borderless 无匹配块 ⇒ **守卫跳过不插入**（G1：不画臆造格网；行文本本就照常渲染，不丢内容）；
 * - text 缺 html / image 缺裁图 ⇒ unmatched 计数可见（G3/缺件门，不静默）。
 *
 * 返回 {inserted, unmatched, attached, skipped}：inserted=新插块数、attached=覆盖挂接数、
 * skipped=守卫跳过数、unmatched=缺件/无法落位条目数。空 entries/它页 entries ⇒ 页面对象逐字节不变。
 */
export function insertTableV3Regions(
  page: StagePage,
  entries: TableV3Entry[],
): { inserted: number; unmatched: number; attached: number; skipped: number } {
  let inserted = 0;
  let unmatched = 0;
  let attached = 0;
  let skipped = 0;
  const toInsert: TableV3Entry[] = [];
  for (const e of entries) {
    if (e.page !== page.index) continue;
    // 覆盖优先：委托 applyTableV3（同页单条），匹配判据/字段写法与旧路径完全一致。
    // 此时尚未插入任何新块 ⇒ 匹配域=原有 blocks，全匹配场景与旧 main() 逐字节等价。
    const r = applyTableV3(page, [e]);
    if (r.attached) {
      attached++;
      // M3：§90 合成表框可能切掉表顶（曲线运动 index3 实测：漏泄行组在真表内却在合成框外
      // ⇒ coveredByTable 抑不到 ⇒ 整表截图+漏泄裁图双像）。image 路由且被覆盖块是
      // **html 含 markdown 图语法的合成表**时，把其 bbox 校正为「合成框 ∪ entry 验证表框」。
      // 正常表（V3/MinerU html 无残字）框一个字节不动 ⇒ 旧样本/MinerU 册行为不变。
      if (e.class === "image") {
        let best: StageBlock | null = null;
        let bestIou = TABLE_MATCH_MIN_IOU;
        for (const b of page.blocks) {
          if (b.kind !== "table") continue;
          const iou = bboxIoU(b.bbox, e.bbox);
          if (iou >= bestIou) {
            bestIou = iou;
            best = b;
          }
        }
        if (best && best.html?.includes("](http")) {
          best.bbox = [
            Math.min(best.bbox[0], e.bbox[0]),
            Math.min(best.bbox[1], e.bbox[1]),
            Math.max(best.bbox[2], e.bbox[2]),
            Math.max(best.bbox[3], e.bbox[3]),
          ];
        }
      }
      continue;
    }
    if (e.class === "text" && e.html) toInsert.push(e);
    else if (e.class === "image" && e.crop && e.cropSize) toInsert.push(e);
    else if (e.class === "borderless") skipped++;
    else unmatched++;
  }
  // 插入按 y 从上到下，保证多表页的 order 槽位稳定
  toInsert.sort((a, b) => a.bbox[1] - b.bbox[1]);
  for (const e of toInsert) {
    const i = page.blocks.reduce((m, b) => Math.max(m, b.i), -1) + 1;
    const block: StageBlock = {
      i,
      kind: "table",
      bbox: e.bbox,
      text: e.class === "text" ? flattenTableHtml(e.html!) : "",
      tableClass: e.class,
      tableSource: e.source ?? "v3",
    };
    if (e.class === "text") block.html = e.html;
    if (e.class === "image") {
      block.crop = e.crop;
      block.cropSize = e.cropSize;
    }
    page.blocks.push(block);
    // order 槽按 y：插到首个「中心 y 更大」的既有块之前；没有则追加末尾。
    const cy = (e.bbox[1] + e.bbox[3]) / 2;
    const byI = new Map(page.blocks.map((b) => [b.i, b]));
    let slot = page.order.length;
    for (let k = 0; k < page.order.length; k++) {
      const b = byI.get(page.order[k]!);
      if (b && (b.bbox[1] + b.bbox[3]) / 2 > cy) {
        slot = k;
        break;
      }
    }
    page.order.splice(slot, 0, i);
    inserted++;
  }
  return { inserted, unmatched, attached, skipped };
}

/** 从 PNG 文件头读原生宽高（签名 + IHDR，大端 u32 @16/@20）。零依赖，放置器只缩不放的依据。 */
export function pngSizeFromHeader(buf: Uint8Array): [number, number] {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 24 || sig.some((v, i) => buf[i] !== v)) {
    throw new Error("不是 PNG（缺签名/IHDR），无法读原生尺寸");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(12) !== 0x49484452) throw new Error("PNG 首块不是 IHDR");
  return [dv.getUint32(16), dv.getUint32(20)];
}

/** norm 框四边近等的容差（相对页宽/高）：行级紧框 vs 段落框差一个量级以上 */
const CROP_NORM_TOL = 0.005;

/**
 * 消费 giant-crop.pNN.json 的 victims：把「截断巨带行」透传为 coordSource=crop。
 * 判据取最严 AND：同页 + kind=text + 文本归一化互相包含（≥4 字）+ **四边近等**
 * （段落块包含该行文本但框是整段 ⇒ 不挂，防整段换单行裁图丢内容）+ 裁图文件存在。
 * crop 落相对 outDir 的子路径；cropSize 从 PNG IHDR 实测（不信产物里的数字，L7）。
 * 返回 {attached, skipped}：未匹配/缺件计数可见。
 */
export function attachGiantCropVictims(
  page: StagePage,
  victims: GiantCropVictim[],
  outDir: string,
): { attached: number; skipped: number } {
  let attached = 0;
  let skipped = 0;
  const used = new Set<number>();
  const blockNorms = page.blocks.map((b) => normForMatch(b.text));
  for (const v of victims) {
    if (v.page !== page.index) {
      skipped++;
      continue;
    }
    // crop 字段优先；为 null 时按**两个裁图产出方共同的命名约定**解析：
    // audit-giant-crop.ts 与 export-gold-crops.ts 都落 giant-crop/crops/{id}-{page+1:03d}.png
    // （实测 6616 条 victims 的 crop 字段全为 null，裁图在盘上）。仍过存在性 + IHDR 自检，不猜内容。
    const rel = v.crop
      ? isAbsolute(v.crop)
        ? relative(outDir, v.crop)
        : v.crop
      : join("giant-crop", "crops", `${v.id}-${String(v.page + 1).padStart(3, "0")}.png`);
    const abs = join(outDir, rel);
    if (!existsSync(abs)) {
      skipped++;
      continue;
    }
    const vt = normForMatch(v.text);
    if (vt.length < 4) {
      skipped++;
      continue;
    }
    let best: StageBlock | null = null;
    let bestDiff = Infinity;
    for (let bi = 0; bi < page.blocks.length; bi++) {
      const b = page.blocks[bi]!;
      if (b.kind !== "text" || used.has(b.i)) continue;
      const bt = blockNorms[bi]!;
      if (!(bt.includes(vt) || vt.includes(bt))) continue;
      const dx = Math.max(Math.abs(b.bbox[0] - v.fallbackBox[0]), Math.abs(b.bbox[2] - v.fallbackBox[2])) / page.width;
      const dy = Math.max(Math.abs(b.bbox[1] - v.fallbackBox[1]), Math.abs(b.bbox[3] - v.fallbackBox[3])) / page.height;
      if (dx > CROP_NORM_TOL || dy > CROP_NORM_TOL) continue;
      const diff = dx + dy;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = b;
      }
    }
    if (!best) {
      skipped++;
      continue;
    }
    let size: [number, number];
    try {
      size = pngSizeFromHeader(new Uint8Array(readFileSync(abs)));
    } catch {
      skipped++;
      continue;
    }
    best.coordSource = "crop";
    best.crop = rel;
    best.cropSize = size;
    used.add(best.i);
    attached++;
  }
  return { attached, skipped };
}

/**
 * 生产默认通电接线（B-39 用户拍板全量开）：从 outDir 读全部 `giant-crop.pNN.json`，
 * 按页聚合 victims，再逐页调 attachGiantCropVictims 挂 coordSource=crop。
 * **产物在即生效，无布尔旗标**——这就是「生产快照默认带 crop 放置」的实现本体。
 * 纪律与 attachGiantCropVictims 一致：缺产物 ⇒ 快照逐字节不变；损坏产物 ⇒ errors 可见不静默（G1）。
 * 返回 {attached, skipped, errors, files}：files=读到的产物文件数（main() 据此决定是否打透传日志）。
 */
export function consumeGiantCropArtifacts(
  pages: StagePage[],
  outDir: string,
): { attached: number; skipped: number; errors: string[]; files: number } {
  const errors: string[] = [];
  const gcFiles = readdirSync(outDir)
    .filter((f) => /^giant-crop\.p\d+\.json$/.test(f))
    .sort();
  if (!gcFiles.length) return { attached: 0, skipped: 0, errors, files: 0 };
  const victimsByPage = new Map<number, GiantCropVictim[]>();
  for (const f of gcFiles) {
    const r = readOcrJsonFile(join(outDir, f));
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    for (const v of ((r.json as { victims?: GiantCropVictim[] })?.victims ?? [])) {
      const list = victimsByPage.get(v.page) ?? [];
      list.push(v);
      victimsByPage.set(v.page, list);
    }
  }
  let attached = 0;
  let skipped = 0;
  for (const pg of pages) {
    const vs = victimsByPage.get(pg.index);
    if (!vs) continue;
    const r = attachGiantCropVictims(pg, vs, outDir);
    attached += r.attached;
    skipped += r.skipped;
  }
  return { attached, skipped, errors, files: gcFiles.length };
}

/* ── M2：markdown 图片漏泄行 → 原卷页图裁图（no-MinerU 生产化） ── */

/** 漏泄组裁图外扩（PDF 点）：与巨带/整表裁图同量级的边距，防切掉贴边墨迹。 */
const LEAK_PAD_PT = 2;
/** 漏泄组链长上限（块数）：OXR 图描述拆行实测 ≤5 行；超限宁可不吞（最严 AND，防吞正常正文）。 */
const LEAK_GROUP_MAX_BLOCKS = 8;

/** 漏泄行种子：kind=text 且（trim 后以 `![` 开头 或 含 `](http`）。table/image 不在本步处理（M3 范围）。 */
function isMarkdownLeakSeed(b: StageBlock): boolean {
  if (b.kind !== "text") return false;
  return b.text.trimStart().startsWith("![") || b.text.includes("](http");
}

/** y 邻接 + 同栏守卫：gap∈[-0.5×较小行高, 较大行高]，x 重叠 ≥0.7×较小行宽（跨栏绝不聚组）。 */
function leakAdjacent(a: StageBlock, b: StageBlock): boolean {
  const ha = a.bbox[3] - a.bbox[1];
  const hb = b.bbox[3] - b.bbox[1];
  const gap = b.bbox[1] - a.bbox[3];
  if (gap < -0.5 * Math.min(ha, hb) || gap > Math.max(ha, hb)) return false;
  const ox = Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]);
  return ox >= 0.7 * Math.min(a.bbox[2] - a.bbox[0], b.bbox[2] - b.bbox[0]);
}

/**
 * M2：把 markdown 图片漏泄行组换成原卷页图裁图（检测不改写原文，只增放置字段）。
 *
 * 病灶（M1 查明）：OXR 把 `![图描述](http…)` 当文字行漏出，同一漏泄常被拆成多个相邻 text 块
 * （曲线运动 page index3 实测 i5/6/7：`![` 开头 / 纯描述中间行 / `](http` 收尾）。
 *
 * 聚组判据（最严 AND）：`![` 开头块沿数组序吸收 **kind=text + y 邻接 + 同栏** 的后续块，
 * 直到含 `](http` 的收尾块（含自身即单块组）；链长 ≤ LEAK_GROUP_MAX_BLOCKS；
 * **找不到收尾块 ⇒ 只保留开头块自身**（中间行绝不吞——它们可能是正常正文）。
 * 未被吸收的 `](http` 块自成单块组。
 *
 * 裁图：组 bbox 并集外扩 LEAK_PAD_PT 夹到页界；pt→px 按页图 IHDR 实测宽/页宽 pt 换算
 * （x/y 向下取整、远边向上取整，再夹到页图像素界）；ffmpeg -vf crop（禁 sips）；
 * cropSize 从裁图 IHDR 实测且必须等于换算期望（不符 ⇒ 删件 + skipped，不静默 L7/G1）。
 *
 * 挂接（照 attachGiantCropVictims 的下游消费口径 coordSource=crop + crop + cropSize）：
 * **组首块**挂并集裁图；组内其余块标 leakCoveredBy=首块 i —— 展示层由首块一张图呈现整组
 * （同一并集图各挂一份=叠影），尾块原文仍留快照 text、由展示层补进首块 title（不丢内容）。
 *
 * 返回 {attached, skipped}（按**组**计数）：无漏泄 ⇒ {0,0} 且页面对象逐字节不变；
 * 页图缺失/读不动、ffmpeg 失败、尺寸自检不符 ⇒ 该组 skipped、块不污染。
 */
export function attachMarkdownLeakCrops(
  page: StagePage,
  outDir: string,
  pageImage: string,
): { attached: number; skipped: number } {
  // ── 聚组 ──
  const groups: StageBlock[][] = [];
  const assigned = new Set<number>();
  const blocks = page.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (assigned.has(b.i) || !isMarkdownLeakSeed(b)) continue;
    const group: StageBlock[] = [b];
    assigned.add(b.i);
    if (b.text.trimStart().startsWith("![") && !b.text.includes("](http")) {
      let cur = b;
      for (let j = i + 1; j < blocks.length && group.length < LEAK_GROUP_MAX_BLOCKS; j++) {
        const n = blocks[j]!;
        if (assigned.has(n.i) || n.kind !== "text" || !leakAdjacent(cur, n)) break;
        group.push(n);
        assigned.add(n.i);
        cur = n;
        if (n.text.includes("](http")) break; // 收尾块命中 ⇒ 组闭合
      }
      if (!group[group.length - 1]!.text.includes("](http")) {
        // 没找到收尾块：中间行可能是正常正文 ⇒ 全部退回，只裁开头块自身（最严 AND）
        for (const g of group.slice(1)) assigned.delete(g.i);
        group.length = 1;
      }
    }
    groups.push(group);
  }
  if (!groups.length) return { attached: 0, skipped: 0 };

  // ── 页图尺寸（IHDR 实测，pt→px 换算的分母来自页图自身，不信快照数字 L7） ──
  let imgW: number;
  let imgH: number;
  try {
    [imgW, imgH] = pngSizeFromHeader(new Uint8Array(readFileSync(pageImage)));
  } catch {
    return { attached: 0, skipped: groups.length };
  }
  const sx = imgW / page.width;
  const sy = imgH / page.height;

  let attached = 0;
  let skipped = 0;
  const cropDir = join(outDir, "leak-crops");
  mkdirSync(cropDir, { recursive: true });
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    const u: BBox = [
      Math.max(0, Math.min(...group.map((b) => b.bbox[0])) - LEAK_PAD_PT),
      Math.max(0, Math.min(...group.map((b) => b.bbox[1])) - LEAK_PAD_PT),
      Math.min(page.width, Math.max(...group.map((b) => b.bbox[2])) + LEAK_PAD_PT),
      Math.min(page.height, Math.max(...group.map((b) => b.bbox[3])) + LEAK_PAD_PT),
    ];
    const x = Math.max(0, Math.floor(u[0] * sx));
    const y = Math.max(0, Math.floor(u[1] * sy));
    const w = Math.min(imgW - x, Math.ceil(u[2] * sx) - x);
    const h = Math.min(imgH - y, Math.ceil(u[3] * sy) - y);
    if (w < 1 || h < 1) {
      skipped++;
      continue;
    }
    const rel = join("leak-crops", `p${String(page.index + 1).padStart(3, "0")}-g${String(gi + 1).padStart(2, "0")}.png`);
    const abs = join(outDir, rel);
    try {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", pageImage, "-vf", `crop=${w}:${h}:${x}:${y}`, abs], {
        stdio: "pipe",
        timeout: 60_000,
      });
      const size = pngSizeFromHeader(new Uint8Array(readFileSync(abs)));
      if (size[0] !== w || size[1] !== h) {
        rmSync(abs, { force: true });
        skipped++;
        continue;
      }
      const head = group[0]!;
      head.coordSource = "crop";
      head.crop = rel;
      head.cropSize = size;
      for (const b of group.slice(1)) b.leakCoveredBy = head.i;
      attached++;
    } catch {
      // ffmpeg 不在场/裁切失败：不静默吞组（skipped 计数可见），块保持原样
      rmSync(abs, { force: true });
      skipped++;
    }
  }
  return { attached, skipped };
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
export function injectOcrQuestionLines(doc: ParsedDocument, outDir: string): { injected: number; errors: string[] } {
  const items: { page: number; bbox: BBox; text: string }[] = [];
  const errors: string[] = [];
  for (const name of ["ocr-fill.json", "ocr-page-fill.json"]) {
    const r = readOcrJsonFile(join(outDir, name));
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    if (!r.json) continue;
    try {
      const j = r.json as {
        pages?: { page: number; items?: { bbox: number[]; text?: string }[] }[];
      };
      for (const pg of j.pages ?? []) {
        for (const it of pg.items ?? []) {
          if (it.text) items.push({ page: pg.page, bbox: it.bbox as BBox, text: it.text });
        }
      }
    } catch (e) {
      errors.push(`${name} 结构异常：${String(e).slice(0, 120)}`);
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
    // 同页同号即视为已存在。**不再用绝对 y 判重**：OCR 候选的 bbox 是生成时的坐标系
    // （常见 596×852.5），融合作品用 MinerU 坐标系（宽高都放大约 3 倍），绝对 y 差必然 >24
    // ⇒ 旧判据在融合页上失效，同一题会被补成两道（2026-10-28 电路 p1/p4 实测）。
    const exists = page.blocks.some((b) => {
      if (b.kind !== "text") return false;
      const bm = matchFirstLine(b.firstLine);
      return bm.kind === "question_no" && bm.captured === num;
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
  return { injected, errors };
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
export function injectOcrFullTextLines(doc: ParsedDocument, outDir: string): { injected: number; skipped: number; errors: string[] } {
  const errors: string[] = [];
  const r = readOcrJsonFile(join(outDir, "ocr-page-fill.json"));
  if (r.error) return { injected: 0, skipped: 0, errors: [r.error] };
  if (!r.json) return { injected: 0, skipped: 0, errors: [] };
  const data = r.json as { pages?: { page: number; fullText?: string }[] };
  if (data.pages !== undefined && !Array.isArray(data.pages)) {
    return { injected: 0, skipped: 0, errors: ["ocr-page-fill.json 结构异常：pages 不是数组"] };
  }
  let injected = 0;
  let skipped = 0;
  for (const pg of data.pages ?? []) {
    if (typeof pg.fullText !== "string" || !pg.fullText) continue;
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
      // 题号可能已被并进上一行/选项，或与年份粘连（`42024…`）：在**整块文本**里查行首题号，
      // 不只查 firstLine。否则同一题会被 OCR 全文再补一道（新书 p1/p4 实测）。
      const numPattern = new RegExp(`(^|\\n)\\s*${num}\\s*(?:[.．、)）]|(?=[\\[【]|\\d{4}(?!\\d)))`);
      const exists = page.blocks.some((b) => {
        if (b.kind !== "text") return false;
        const bm = matchFirstLine(b.firstLine);
        if (bm.kind === "question_no" && bm.captured === num) return true;
        return numPattern.test(b.text);
      });
      if (exists) continue; // 该页已有同号题切口
      // 同号题号可能已被并进上一行/选项（firstLine 不是题号形态），但文字已在页内：
      // 用归一化前缀再查一次，避免把同一题补成两道（2026-10-28 新书 p1 实测）。
      const keyText = normForMatch(line).slice(0, 16);
      const existsText =
        keyText.length >= 8 &&
        page.blocks.some(
          (b) => b.kind !== "image" && b.kind !== "formula" && normForMatch(b.text).includes(keyText),
        );
      if (existsText) {
        skipped++;
        continue;
      }
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
        /**
         * ⚠️ 「最后一个」必须是**阅读顺序的末尾**，不是 y 最大的那个。
         * 阅读顺序是栏主序（先左栏上→下，再右栏上→下）：当左栏比右栏更长时，
         * y 最大的块在**左栏**，把题号插到它下面 ⇒ 题号排在右栏内容**之前**，
         * 整页切题错位。实测（2026-10-28）光学 p1 的 `3.` 印在右栏栏底，
         * OXR 漏读它、OCR 全文补行又把它插到左栏 `2.` 正下方 ⇒
         * Q2 只剩一个 `2.`、右栏 17 块全被并进 Q3，p2 无归属块。
         * ⇒ 取**最右栏**里 y 最大的块，保证题号排在该页阅读顺序的最末；
         * 无右栏（单栏页）时退回全局 y 最大，行为不变。
         */
        const half = (page.width > 0 ? page.width : 596) / 2;
        const rightCol = texts.filter((t) => t.bbox[0] >= half);
        const pool = rightCol.length ? rightCol : texts;
        let last = pool[0]!;
        for (const t of pool) if (t.bbox[3] > last.bbox[3]) last = t;
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
  return { injected, skipped, errors };
}

/**
 * M7-A 标题守卫/补识：把 `title-guard.json` 的条目插回 doc（**切题之前**，
 * 让补回的内容标题/散文参与切题与分组）。产物缺失/空 ⇒ doc 逐字节不变。
 *
 * 纪律：
 * - 只增块，不改既有块；补回块标 `fromOcr: true`（来源=独立 OCR/原卷核对，不当上游原文）；
 * - 同页归一化文本已含该文本 ⇒ 跳过（幂等，防重复插入）；
 * - 页不存在 ⇒ 跳过并计数（不静默）。
 */
export function applyTitleGuard(
  doc: ParsedDocument,
  entries: TitleGuardEntry[],
): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;
  for (const e of entries) {
    const page = doc.pages.find((p) => p.index === e.page - 1);
    if (!page) {
      skipped++;
      continue;
    }
    const target = normalizeGuardText(e.text);
    const dup = page.blocks.some(
      (b) => (b.kind === "text" || b.kind === "table") && normalizeGuardText(b.text).includes(target),
    );
    if (dup) {
      skipped++;
      continue;
    }
    page.blocks.push({
      kind: "text",
      bbox: [...e.bbox] as BBox,
      text: e.text,
      firstLine: e.text.split("\n")[0] ?? e.text,
      lineCount: 1,
      maxFontSize: 0,
      fromOcr: true,
    });
    applied++;
  }
  return { applied, skipped };
}

function main(): void {
  const docId = process.argv[2];
  const layoutPath = process.argv[3];
  // M5-B（no-MinerU）：拆掉 MinerU 默认输入（旧缺省 = data/smoke/unpacked/layout.json）。
  // 导出器源无关：喂哪份 layout 产哪份骨架，必须由调用方显式传参（daily/ocr-fill/fuse-doc 均显式传）；
  // 缺参 ⇒ 用法报错退出 2，绝不静默回退任何默认源（红线：不静默失败；拿默认源冒充本书=内容事故）。
  if (!docId || !layoutPath) {
    console.error(
      [
        "用法: npx tsx scripts/export-stages.ts <docId> <layoutPath>",
        "  layoutPath 必须显式传参（OXR layout 或其它骨架源）；M5 起已拆除 MinerU 默认输入。",
        '  例: npx tsx scripts/export-stages.ts "物理_教材基础练 曲线运动" "data/out/物理_教材基础练 曲线运动/layout.json"',
        "  一键导入走 npm run daily -- <pdf|layout.json>（会自动显式传 layout）。",
      ].join("\n"),
    );
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(layoutPath, "utf8"));

  const doc = normalizeLayout(raw, docId);
  const outDir = join("data", "out", docId);
  /** OCR 输入文件“存在但读不动”的错误（不静默：写入快照，meta 体检会显示） */
  const ocrInputErrors: string[] = [];
  /**
   * M7-A 标题守卫/补识（产物驱动）：`title-guard.json` 缺失 ⇒ 跳过（快照逐字节不变）；
   * 存在但读不动 ⇒ 错误进 `ocrInputErrors`（不静默）。在 OCR 补行与切题之前插回，
   * 让补回内容参与切题/分组。
   */
  const titleGuardFile = readOcrJsonFile(join(outDir, "title-guard.json"));
  if (titleGuardFile.error) ocrInputErrors.push(titleGuardFile.error);
  let titleGuardReport: { entries: number; applied: number; skipped: number } | null = null;
  if (titleGuardFile.json) {
    const entries = (titleGuardFile.json as { entries?: TitleGuardEntry[] }).entries ?? [];
    const r = applyTitleGuard(doc, entries);
    titleGuardReport = { entries: entries.length, ...r };
    console.log(
      `  标题守卫/补识：清单 ${entries.length} 条 · 插回 ${r.applied} 行` +
        (r.skipped ? `（跳过 ${r.skipped}：已存在/页缺失）` : ""),
    );
  }
  // 融合作品：两源已覆盖正文，OCR 题号补行只保留展示候选，**不注入切题流**。
  // 原因（2026-10-28 电路实测）：OCR 候选 bbox 是 OXR 坐标系，融合页是 MinerU 坐标系，
  // 绝对坐标判重失效，同一题会被补成多道；且新书的徽标题号常被 OCR 读成正文数字。
  const isFused = existsSync(join(outDir, "fuse.json"));
  // ⚠️ 先补「OCR 读到的题号行」，再切分 —— 否则整行被上游漏掉的题根本不存在（见函数注释）
  const injected = isFused ? { injected: 0, errors: [] } : injectOcrQuestionLines(doc, outDir);
  ocrInputErrors.push(...injected.errors);
  if (isFused) console.log("  OCR 题号补行：融合作品跳过注入（仅展示候选，防重复）");
  else if (injected.injected) console.log(`  OCR 补入题号行 ${injected.injected} 处（上游整行漏识别，展示层以候选样式呈现）`);
  if (injected.errors.length) console.warn(`  ⚠️ OCR 题号补行输入异常：${injected.errors.join("；")}`);
  // 第二来源：整页 OCR 全文（补「墨迹被吞进更宽 bbox、items 看不见」的整行漏识别，见函数注释）
  const full = isFused ? { injected: 0, skipped: 0, errors: [] } : injectOcrFullTextLines(doc, outDir);
  ocrInputErrors.push(...full.errors);
  if (full.injected || full.skipped) {
    console.log(
      `  OCR 整页全文补入题号行 ${full.injected} 处` +
        (full.skipped ? `（另有 ${full.skipped} 处找不到落点，已跳过）` : ""),
    );
  }
  if (full.errors.length) console.warn(`  ⚠️ OCR 整页全文输入异常：${full.errors.join("；")}`);
  // 人工已核对的上游错误修正（corrections/<docId>.json）—— 必须在**切题之前**应用，
  // 否则修正只影响显示、不影响切题判定。清单进仓库、可审计；缺失即跳过（引擎行为不变）。
  let correctionReport: ApplyReport | null = null;
  const correctionPath = join("corrections", `${docId}.json`);
  if (existsSync(correctionPath)) {
    const file = JSON.parse(readFileSync(correctionPath, "utf8")) as CorrectionFile;
    const rep = applyCorrections(doc, file);
    correctionReport = rep;
    console.log(
      `  已核对修正：替换 ${rep.replace} 块` +
        (rep.replaceText > 0 ? ` · 半行修补 ${rep.replaceText} 处` : "") +
        (rep.split > 0 ? ` · 拆块 ${rep.split} 处` : "") +
        ` · 补入图注 ${rep.insert} 处` +
        (rep.unverified.length > 0 ? `（其中 ${rep.unverified.length} 条未逐条回原卷核对，已标记）` : "") +
        (rep.disabled.length > 0 ? `；跳过 ${rep.disabled.length} 条已 disabled` : "") +
        (rep.missed.length > 0 ? `（⚠️ ${rep.missed.length} 条未命中，清单可能已过期）` : ""),
    );
  }

  const result = ruleStrategy.segment(doc);
  const snapshot = buildStageSnapshot(doc, result, extractRawBlocks(raw), extractDiscardedBlocks(raw));
  // 骨架输入溯源（M1）：快照自报喂入的 layout 路径 —— 换源（MinerU→OXR）后可从产物核对来源
  snapshot.layoutInput = layoutPath;
  snapshot.corrections = correctionReport;
  // 跨页泄漏记录（B-47）：随快照落盘，逐条可核对；空/缺省 = 无（OXR 整体跳过）。
  snapshot.crossPageLeaks = doc.crossPageLeaks;
  if (titleGuardReport) snapshot.titleGuard = titleGuardReport;
  if (doc.crossPageLeaks?.length) {
    const moved = doc.crossPageLeaks.filter((r) => r.action === "moved").length;
    const dropped = doc.crossPageLeaks.filter((r) => r.action === "dropped").length;
    console.log(`  跨页泄漏滤除 ${doc.crossPageLeaks.length} 行（迁回真页 ${moved} · 真页已有副本丢弃 ${dropped}）`);
  }
  // 先挂引用：后面候选合并若再发现 OCR 读取错误，会追加到同一数组（写快照前已全部发生）
  snapshot.ocrInputErrors = ocrInputErrors;

  mkdirSync(outDir, { recursive: true });

  // OCR 候选补全（**仅新增字段**，缺失时保持空数组）。两条来源：
  //   - `ocr-fill.json`：**区域裁图**（scripts/ocr-fill.ts）—— 窗口按行裁，位置天然对得上；
  //   - `ocr-page-fill.json`：**整页 OCR**（scripts/ocr-page-fill.ts）—— 上下文完整、文本更干净，
  //     但它会把折行的选项并成一行，按比例切分会把下一行开头派给上一行（热狗题实测）。
  //   ⇒ 合并规则：**裁图已 accepted 的保留，整页只补裁图没补上的洞。**
  // 与快照解耦：重导快照不丢产物，重跑 OCR 也不碰其它字段。
  const readOcrJson = (name: string) => {
    const r = readOcrJsonFile(join(outDir, name));
    if (r.error) {
      ocrInputErrors.push(r.error);
      console.warn(`  ⚠️ ${r.error}（候选合并跳过该文件）`);
    }
    return r.json as {
      pages?: { page: number; items?: OcrFillItem[]; fullText?: string }[];
    } | null;
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
  // ── S2 放置上游透传（spec 2026-11-13 §5.1）：只消费产物、只增新字段，缺失=逐字节不变 ──
  // table-v3.json：上游显式表格三分流（text=V3 HTML / image=整表截图 / borderless=守卫跳过）。
  const tv3 = readOcrJsonFile(join(outDir, "table-v3.json"));
  if (tv3.error) {
    ocrInputErrors.push(tv3.error);
    console.warn(`  ⚠️ ${tv3.error}（表格分类透传跳过）`);
  }
  if (tv3.json) {
    const entries = (tv3.json as { tables?: TableV3Entry[] }).tables ?? [];
    let tAtt = 0;
    let tIns = 0;
    let tSkip = 0;
    let tUnm = 0;
    for (const pg of snapshot.pages) {
      // M3 双模式：IoU 匹配既有 table 块 ⇒ applyTableV3 覆盖（行为不变）；
      // §90 未重建出的表 ⇒ 按 V3 bbox 插入 kind=table 块（order 槽按 y）。
      const r = insertTableV3Regions(pg, entries);
      tAtt += r.attached;
      tIns += r.inserted;
      tSkip += r.skipped;
      tUnm += r.unmatched;
    }
    console.log(
      `  表格三分流（table-v3.json）：覆盖 ${tAtt} 表 · 插入 ${tIns} 表` +
        (tSkip ? ` · 守卫跳过 ${tSkip}（无边框不画臆造格网）` : "") +
        (tUnm ? `（⚠️ ${tUnm} 条未匹配/缺 html/缺裁图，未静默透传）` : ""),
    );
  }
  // giant-crop.pNN.json：B-39 巨带截断回退的受害者行 ⇒ 行级 coordSource=crop 透传。
  // 生产默认通电（产物在即生效，无布尔旗标）；接线本体见 consumeGiantCropArtifacts。
  const gc = consumeGiantCropArtifacts(snapshot.pages, outDir);
  ocrInputErrors.push(...gc.errors);
  for (const e of gc.errors) console.warn(`  ⚠️ ${e}（巨带裁图透传跳过该文件）`);
  if (gc.files) {
    console.log(
      `  巨带裁图回退透传：${gc.attached} 行 coordSource=crop` +
        (gc.skipped ? `（${gc.skipped} 条受害者未匹配/无裁图，原样保留不静默）` : ""),
    );
  }
  // ── B-66：`source.blockIndexes` 导出期重建（stem 文本反查真实块范围；不改引擎切题） ──
  // 根因（2026-11-22 实测修正 B-66 的原假设）：引擎在**注入后 doc 帧**上记录 blockIndexes
  // 且在该帧内自洽（书A 引擎帧 head 检验 miss=0/1048），但 table-v3 三分流会向快照
  // **插入新块**（本册 +20），此后 stages.json 的全局拍平帧相对引擎帧整体后移
  // ⇒ 一切「把 blockIndexes 按 stages.json 拍平序取块」的下游（A 档抽查裁图、逻辑块裁图器、
  //   head 命中检验）都系统性取到后移的块 = 「混入上一题」（书A p176:q744：引擎帧 11541 与
  //   stages 帧 11553 是同一个题头块）。
  // 修法：在**全部块变更（table-v3 插入/巨带/漏泄）落定之后**、写 questions.json 之前，
  // 用 stem 首段在**最终快照帧**（pages[].order 阅读序拍平）里反查真实起始块，
  // 区间 = 真实起始块 → 下一题真实起始块前；反查不中**保留原值并计数**（宁保原值不猜）。
  // 快照 pages[].questions[].blocks（页内下标）不受影响：插入不重编号，页内帧稳定。
  // 判据纯函数在 scripts/lib/block-indexes-rebuild.ts（有单测）；`--no-block-rebuild` 可关（A/B 对照）。
  const blockRebuildEnabled = !process.argv.includes("--no-block-rebuild");
  if (blockRebuildEnabled) {
    // 最终快照帧：页升序 × 页内阅读序（pages[].order，含插入块）——
    // 与一切按 stages.json 拍平回溯的下游同一口径；文本取值同快照（image 占位/公式 latex/text）。
    const flatBlocks: FlatBlock[] = [];
    let globalIndex = 0;
    for (const page of [...snapshot.pages].sort((a, b) => a.index - b.index)) {
      for (const i of page.order) {
        const b = page.blocks[i];
        if (!b) continue;
        flatBlocks.push({ index: globalIndex++, pageIndex: page.index, text: b.text });
      }
    }
    const plan = planBlockIndexRebuilds(result.questions, flatBlocks);
    // 只换 source.blockIndexes，其余字段（stem/options/题数/…）引用原对象一字不动
    result.questions = result.questions.map((q, i) => {
      const range = plan.ranges[i];
      return range ? { ...q, source: { ...q.source, blockIndexes: range } } : q;
    });
    snapshot.blockIndexesRebuild = plan.report;
    const kr = plan.report.keptReasons;
    console.log(
      `  blockIndexes 重建（B-66，最终快照帧 ${flatBlocks.length} 块）：rebuilt ${plan.report.rebuilt}/${plan.report.total}` +
        ` · kept ${plan.report.kept}（无探针 ${kr["no-probe"]} / 反查不中 ${kr["not-found"]} / 端点无锚 ${kr["next-unknown"]}）` +
        (plan.report.widened ? ` · 放宽页邻近命中 ${plan.report.widened}` : ""),
    );
    if (plan.report.keptIds.length) {
      const shown = plan.report.keptIds.slice(0, 8).join("、");
      console.log(
        `    保留原值的题（不静默）: ${shown}` +
          (plan.report.keptIds.length > 8 ? ` … 等 ${plan.report.keptIds.length} 题` : ""),
      );
    }
  }
  // questions.json 与 stages.json 同源重生成：viewer 与 stages 消费同一份引擎产物，
  // 避免算法修复后两个展示层各说各话
  writeFileSync(join(outDir, "questions.json"), JSON.stringify(result.questions, null, 2));
  // 教辅栏目板块条目（`DECISIONS §78`）单独落一份，供 viewer 直接 fetch：
  // stages.json 有 700KB 量级，为几十条板块去拖整份快照不值当。
  writeFileSync(join(outDir, "bands.json"), JSON.stringify(result.bands ?? [], null, 2));
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
      /**
       * **按目标像素宽度渲染，不用固定 DPI**（2026-10-30 实测）。
       *
       * `-r 120` 是「每英寸 120 像素」的绝对分辨率，它假设 PDF 页面是 A4（595×842pt）。
       * 但《教材基础练》整套 6 册的页面是 **2093×2994 pt**（3.5 倍 A4）——
       * 同样是 `-r 120`，渲染出的却是 3489×4990、单张 10MB 的图：
       * 18 页跑到 2 分钟以上，直接撞上调用超时，整册被判「工具不可用」而降级成 PDF 内嵌
       * （浏览器里一片黑），页面加载也因此卡顿。
       *
       * `-scale-to-x 1000` 让「A4 册」和「放大册」产出同一量级（1000×1431、约 1.4MB/页），
       * 同一份 18 页实测 **27.7s**（原 >120s），总量 180MB → 26MB。
       * 1000px 宽也够墨迹覆盖率用：A4 册原本就是 992px，检测精度与之对齐。
       */
      execFileSync(
        "pdftoppm",
        ["-png", "-scale-to-x", "1000", "-scale-to-y", "-1", pdfPath, join(pagesDir, "page")],
        { timeout: 600_000 },
      );
      originPages = readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length;
    } catch (err) {
      // ⚠️ 这里**不许静默吞原因**：曾在 2026-10-30 出现「手动能跑、脚本内失败」，
      // 而 catch 只打印「不可用或渲染失败」，等于把唯一线索丢了。
      const reason = (err instanceof Error ? err.message.split("\n")[0] : String(err)) ?? "";
      // pdftoppm 不可用、或运行环境禁止执行它时，**不要直接放弃原卷对照**：
      // 上一轮渲染好的页图如果张数与本次解析页数一致，说明它们仍对应当前 PDF，可以复用
      // （否则展示层降级成 PDF 内嵌，浏览器里可能整块空白 —— 2026-10-29 实测）。
      // 张数不一致 ⇒ 可能是旧 PDF 的页图，**宁可不显示也不能错配**（对照源错了比没有更坏）。
      const pagesDir = join(outDir, "pages");
      const have = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length : 0;
      if (have > 0 && have === doc.pages.length) {
        originPages = have;
        console.log(`  pdftoppm 失败（${reason}）⇒ 复用已有原卷页图 ${have} 张（张数与本次解析页数一致）`);
      } else {
        console.log(`  pdftoppm 失败（${reason}）⇒ 页图 ${have} 张 / 本次 ${doc.pages.length} 页，张数不符不复用，原卷对照降级为 PDF 内嵌`);
      }
    }
  }

  // ── M2：markdown 漏泄行 → 原卷页图裁图（生产默认通电：页图在即生效，无布尔旗标） ──
  // 与 consumeGiantCropArtifacts 同风格：只消费产物（原卷页图）、只增新字段；
  // 无漏泄/无页图 ⇒ 快照逐字节不变。页图命名两种历史形态都认（3 位/2 位，与 table-v3-sample 同）。
  let leakAttached = 0;
  let leakSkipped = 0;
  for (const pg of snapshot.pages) {
    const pagesDir = join(outDir, "pages");
    const candidates = [
      join(pagesDir, `page-${String(pg.index + 1).padStart(3, "0")}.png`),
      join(pagesDir, `page-${String(pg.index + 1).padStart(2, "0")}.png`),
    ];
    const pageImage = candidates.find((c) => existsSync(c)) ?? candidates[0]!;
    const r = attachMarkdownLeakCrops(pg, outDir, pageImage);
    leakAttached += r.attached;
    leakSkipped += r.skipped;
  }
  if (leakAttached || leakSkipped) {
    console.log(
      `  markdown 漏泄行裁图：${leakAttached} 组挂原卷裁图（coordSource=crop，原文留 text/title）` +
        (leakSkipped ? `（⚠️ ${leakSkipped} 组因页图缺失/裁切失败跳过，原样保留不静默）` : ""),
    );
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
