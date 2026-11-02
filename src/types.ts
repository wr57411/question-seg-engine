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
      /**
       * **上游表格 HTML**（`<table><tr><td rowspan colspan>…</table>`），只出现在
       * `kind:"table"` 的块上。来源是上游 `spans[].html`，展示层据此画真网格
       * （`DECISIONS §76`）——「按原坐标重建纸面」的同一条原则，不是从空白推断列宽。
       */
      html?: string;
      /**
       * 该块是**从 OCR 候选补进来的**（不是 MinerU 的输出）。
       * 目前只用于「题号行」：MinerU 会整行漏识别，而 OCR 已读对（见 export-stages 的
       * `injectOcrQuestionLines`）。展示层以**候选**样式呈现，绝不当作引擎原文（G1）。
       */
      fromOcr?: boolean;
      /**
       * 该块经**人工已核对的上游错误修正**（`corrections/<docId>.json`）改动或补入。
       * 与 `fromOcr` 同思路但不同来源：来自两源交叉核对 + 逐条回原卷核对，
       * 见 docs/oxr-evaluation.md §4.9。修正清单进仓库、可审计、可撤销。
       */
      fromCorrection?: boolean;
      /** 该块文本来自两源融合（MinerU 几何 + OXR 文本）；展示/审计必须可见（G1） */
      fromFusion?: boolean;
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
      /** 该公式文本来自两源融合（MinerU 几何 + OXR 文本） */
      fromFusion?: boolean;
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
  /** 题号原文（如 "1"），保持原样用于答案对号 */
  number: string;
  /**
   * **章节号**（后台必存，页面可不显示）：如 "2"。
   * 教辅每节内题号从 1 重新开始（实测答案册 `#1` 出现 22 次），
   * 所以「章 + 节 + 题号」才是唯一键 —— 缺了它题库无法一一对应（2026-10-12）。
   */
  chapter: string;
  /** 章节标题（如 "相互作用"） */
  chapterTitle: string;
  /** **节号**：如 "2"（"第2节"）；汉字大题回退为汉字序号（如 "一"） */
  sectionNo: string;
  /** 所属节/大题标题原行，如 "第2节 牛顿第三定律" / "一、选择题" */
  section: string;
  /** 本节内的小问标记（如 ["1","2"]），只记录不切题 */
  subQuestions: string[];
  /**
   * **编号组序号**（全局单调）。教辅里题号会在「节边界」**和**「专题/综合测试/真题自测」
   * 等块边界处重启，实测同一节内会出现多个 `1` ⇒ 唯一键必须是
   * `(chapter, sectionSeq, number)` 三元组，不能只用题号。
   */
  sectionSeq: number;
  /** 题干文本（行内公式已内联为 $...$） */
  stem: string;
  options: Option[];
  images: ImageRef[];
  /**
   * 本题目区域内出现的**表格**（`kind:"table"` 块归属而来，`DECISIONS §76`）。
   *
   * 为什么单独存而不是并进 `stem`：表格是**结构**，压平进 stem 就只剩一串文字，
   * 列边界全丢（实验数据表尤其致命 —— 判分要取「第 3 次的 F 是多少」）。
   * 这里保留上游 HTML，`stem` 一个字不改 ⇒ 切题结果与改动前逐字节一致。
   */
  tables?: { html: string; bbox: BBox; pageIndex: number }[];
  /** 来自参考答案区、按题号对号入座的答案 */
  answer?: string;
  /** 解析：本骨架不拆，预留字段由 LLM/人工补齐 */
  solution?: string;
  source: {
    file: string;
    pageIndex: number;
    /** 参与构成本题的块序号。语义：跨页全局序号（segmentWithRules 展平阅读流后
     * 的连续编号，跨题页累进）——不是页内序号；映射回页内块需按阅读顺序重建，
     * 见 scripts/export-stages.ts 的 buildStageSnapshot。 */
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

/**
 * **教辅栏目板块条目**（`DECISIONS §78`）：`教材实验 10 长度的测量…` / `教材知识萃取 …` /
 * `教材素材变式 …` 这类栏目下的内容归属。
 *
 * 为什么单独一个结构、不塞进 `Question`：
 * 1) 板块**没有题号**。`audit-numbering` 的 N1（纯数字）与 N6（1–99）**不可豁免**，
 *    编一个号进去必然判红，还会污染 `(章, 节, 题号)` 唯一键与 `bank` 配对；
 * 2) 板块是**结构容器**，一个板块内可能既有真题、也有知识条目 —— 它不抢题目的所有权。
 *
 * 块被题目认领时**同时**属于板块（双重引用）：板块只增加「这一段属于哪个栏目」的信息，
 * 不改变任何切题判定。
 */
export interface Band {
  /** 条目唯一键：`<docId>:p<pageIndex>:b<page 内序号>` */
  id: string;
  /** 同一板块跨页时共享的键：`<docId>:band<自增>` —— 用来把跨页的多条拼回一个板块 */
  bandKey: string;
  /** 板块头原文（含栏目标题，如 `教材实验 10 长度的测量及其测量工具的选取`） */
  title: string;
  /** 本条目所属页（0 基） */
  pageIndex: number;
  /**
   * 归属本板块的块索引（**该页内的下标**，与 `stages.json` 的 `pages[].blocks` 直接对齐）。
   * 引擎内部用的是全局块序，`buildBands()` 落库前已换算成页内下标。
   */
  blockIndexes: number[];
  /** 本条目覆盖的文字（拼接，供检索/预览；不含图片） */
  text: string;
  /** 板块内容不保证被切成了正确题目 ⇒ 一律待人确认，不静默算「已通过」 */
  status: "needs_review";
}

export interface SegmentationResult {
  docId: string;
  questions: Question[];
  /** 教辅栏目板块条目（见 `Band`）；没有栏目头的册为空数组 */
  bands: Band[];
  reviews: ReviewNote[];
  stats: SegmentationStats;
  /** 答案区原始条目（供调试/演进） */
  answerEntries: { number: string; text: string }[];
}