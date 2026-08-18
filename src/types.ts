/**
 * types.ts —— 正式 schema（正式件）
 *
 * 分层冻结原则（评审结论 2026-08-18，详见 docs/DECISIONS.md）：
 * - 核心骨架（Question 实体及其字段）第一天冻结，演进中禁止破坏性迁移；
 * - 扩展形态（材料题、图选项、复合题等）在真实样卷暴露缺口后【增量追加】字段
 *   ——只做加法，不做改名/删字段。
 * 骨架形状由领域模型决定（展现层、答案开关、题库需要什么），
 * 不随切分器实现（规则版/LLM 版）变化。
 */

/** 归一化后的块类型（对齐 MinerU content_list 的 block.type） */
export type BlockKind = "text" | "image" | "table" | "formula";

/** [x0, y0, x1, y1]，页面坐标系，原点左上 */
export type BBox = [number, number, number, number];

export interface ImageRef {
  path: string;
  bbox: BBox;
}

/**
 * 归一化后的文档块：屏蔽 MinerU content_list 的字段细节，
 * 后续换解析供应商（或自部署 MinerU）只改 normalize 一处。
 */
export type ParsedBlock =
  | {
      kind: "text" | "table";
      bbox: BBox;
      /** 全文拼接（行内公式以 $...$ 内联） */
      text: string;
      /** 首行文本，题号/选项判定只针对首行，避免正文内部数字误匹配 */
      firstLine: string;
      lineCount: number;
      /** 块内最大字号，用于大题标题/题号的启发判定 */
      maxFontSize: number;
    }
  | {
      kind: "image";
      bbox: BBox;
      path: string;
    }
  | {
      kind: "formula";
      bbox: BBox;
      /** LaTeX 表达式（不含 $ 包裹） */
      latex: string;
    };

export interface PageInfo {
  index: number;
  width: number;
  height: number;
  blocks: ParsedBlock[];
}

/** 规范化后的解析文档（上游即 MinerU Zip 中的 content_list.json） */
export interface ParsedDocument {
  docId: string;
  pages: PageInfo[];
}

/** 带文档内原始序号与页码的块，供决策层回溯 source.blockIndexes / ReviewNote */
export interface IndexedBlock {
  /** 文档内全局序号（跨页连续） */
  index: number;
  pageIndex: number;
  block: ParsedBlock;
}

export interface Option {
  key: string;
  text: string;
}

export type QuestionStatus = "ok" | "needs_review";

/** 题型推断（启发式：有完整选项组 → 选择题，否则按主观题处理）。展现层按题型配置答题留白 */
export type QuestionType = "choice" | "subjective";

export interface Question {
  /** 全局唯一：<docId>:p<pageIndex>:q<序> */
  id: string;
  type: QuestionType;
  /** 题号原文（如 "1" / "（2）"），保持原样用于答案对号 */
  number: string;
  /** 所属大题标题，如 "一、选择题" */
  section: string;
  /** 题干文本（行内公式已内联为 $...$） */
  stem: string;
  options: Option[];
  images: ImageRef[];
  /** 来自参考答案区、按题号对号入座的答案 */
  answer?: string;
  /** 解析：本骨架不拆，预留字段由 LLM/人工补齐 */
  solution?: string;
  source: {
    file: string;
    pageIndex: number;
    /** 参与构成本题的块序号（按文档内顺序） */
    blockIndexes: number[];
  };
  confidence: number;
  status: QuestionStatus;
}

/** 低置信度 / 规则无法裁决的节点，进人工校对，不允许静默失败 */
export interface ReviewNote {
  questionId?: string;
  reason: string;
  /** 涉及的块序号 */
  blockIndex: number;
  snippet: string;
}

export interface SegmentationStats {
  totalBlocks: number;
  questions: number;
  reviewCount: number;
  optionGroups: number;
  imagesAttached: number;
  answersMatched: number;
  /** 独立公式块数（公式召回率分母，人工抽检核分子） */
  formulaBlocks: number;
  /** 行内公式对数（$...$ 出现对数） */
  inlineFormulas: number;
  /** 每页检测到的栏数 */
  columnsPerPage: number[];
}

export interface SegmentationResult {
  docId: string;
  questions: Question[];
  reviews: ReviewNote[];
  stats: SegmentationStats;
  /** 答案区原始条目（供调试/演进） */
  answerEntries: { number: string; text: string }[];
}