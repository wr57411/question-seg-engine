/**
 * rule-engine.ts —— 组合决策层（正式接口的默认实现）
 *
 * 双层规则的粘合点：版面层给出阅读顺序，语言层给出模式标签，
 * 这里用有限状态机做切割裁决，并产出置信度与 needs_review 标记——
 * 规则允许失败，但不允许静默失败：所有低置信度节点都进 ReviewNote。
 *
 * 演进点：后续 LLM 切分器替换的是「读模式」的方式，本状态机的
 * 结构决策（题/选项/答案区归属）语义保持不变。
 */
import { layoutPage } from "./layout.js";
import {
  matchAnswerEntry,
  matchFirstLine,
  nextKey,
  splitConjoinedOptions,
  stripOptionPrefix,
  stripQuestionPrefix,
} from "./patterns.js";
import type {
  ImageRef,
  IndexedBlock,
  Option,
  ParsedBlock,
  ParsedDocument,
  Question,
  ReviewNote,
  SegmentationResult,
} from "./types.js";

/** 置信度低于该值视为 needs_review（校准点：跑真实样卷后可调） */
export const REVIEW_THRESHOLD = 0.75;

/** 选择题默认 4 个选项；多选题后续扩展 */
const EXPECTED_OPTION_COUNT = 4;

interface Draft {
  seq: number;
  number: string;
  section: string;
  stemParts: string[];
  options: Option[];
  /** 是否见过选项块（区分「无选项题」与「选项收集失败」） */
  optEvidence: boolean;
  images: ImageRef[];
  blockIndexes: number[];
  pageIndex: number;
  firstLineOfQuestion: string;
}

interface AnswerDraft {
  number: string;
  text: string;
}

export function segmentWithRules(doc: ParsedDocument): SegmentationResult {
  const ctx = new Ctx(doc);

  // 逐页布局并按阅读顺序展平为全局块流（序号跨页连续）
  let globalIndex = 0;
  for (const page of doc.pages.slice().sort((a, b) => a.index - b.index)) {
    const layout = layoutPage(page);
    ctx.stats.columnsPerPage.push(layout.columns);
    for (const entry of layout.ordered) {
      entry.index = globalIndex++;
      ctx.process(entry);
    }
  }
  ctx.finish();

  const questions = ctx.questions.map((d) => buildQuestion(d, ctx));
  ctx.questionMap = new Map();
  for (const q of questions) {
    ctx.questionMap.set(q.number, [...(ctx.questionMap.get(q.number) ?? []), q]);
  }
  mergeAnswers(ctx);
  flagDuplicateNumbers(ctx);
  return ctx.result(questions);
}

/** 状态机上下文 */
class Ctx {
  doc: ParsedDocument;
  questions: Draft[] = [];
  answers: AnswerDraft[] = [];
  reviews: ReviewNote[] = [];
  /** 题号 → Question（答案对号与去重用） */
  questionMap = new Map<string, Question[]>();
  stats = {
    totalBlocks: 0,
    questions: 0,
    optionGroups: 0,
    imagesAttached: 0,
    answersMatched: 0,
    reviewCount: 0,
    /** 独立公式块数（公式召回率的分母，配合人工抽检核分子） */
    formulaBlocks: 0,
    /** 行内公式对数（$...$ 出现对数，同样纳入抽检分母） */
    inlineFormulas: 0,
    columnsPerPage: [] as number[],
  };

  private mode: "questions" | "answers" = "questions";
  private current: Draft | null = null;
  private pendingOptions: Option[] = [];
  private expectOptionKey = "A";
  private section = "";
  private seq = 0;
  private answerEntry: AnswerDraft | null = null;

  constructor(doc: ParsedDocument) {
    this.doc = doc;
  }

  process(entry: IndexedBlock): void {
    this.stats.totalBlocks++;
    const { block, index: blockIndex } = entry;

    if (this.mode === "answers") {
      this.processAnswerBlock(block, blockIndex);
      return;
    }

    if (block.kind === "image") {
      this.attachImage(block, blockIndex);
      return;
    }
    if (block.kind === "formula") {
      this.stats.formulaBlocks++;
      this.appendToCurrent(`\n$$${block.latex}$$\n`, blockIndex, /*countInline=*/ false);
      return;
    }

    const m = matchFirstLine(block.firstLine);

    switch (m.kind) {
      case "answer_zone": {
        // 参考答案区：试题流终止，之后只解析答案条目
        this.settleOptions(null);
        this.current = null;
        this.mode = "answers";
        return;
      }
      case "section": {
        // 大题标题：如 "一、选择题" —— 更新 section，并结算悬挂选项
        this.settleOptions(null);
        this.section = block.text.trim();
        return;
      }
      case "question_no": {
        this.settleOptions(null);
        this.openDraft(m.captured, block, entry);
        return;
      }
      case "option": {
        // 粘连多选项一行：直接批量入 pending（layout 行级未覆盖时的兜底）
        const splits = splitConjoinedOptions(block.text);
        if (splits.length >= 2 && splits[0]!.key === this.expectOptionKey) {
          // 不连续分支已调 appendToCurrent（其内部自带 blockIndex 登记），尾部登记需跳过避免重复
          let preservedToStem = false;
          for (const s of splits) {
            if (s.key === this.expectOptionKey) {
              this.pendingOptions.push(s);
              this.expectOptionKey = nextKey(s.key);
              if (this.current) this.current.optEvidence = true;
            } else {
              // 先捕获再 settle：settleOptions 会把 expectOptionKey 重置回 "A"
              const expected = this.expectOptionKey;
              this.settleOptions(this.current);
              this.review(blockIndex, `粘连选项键不连续：期待 ${expected}，实际 ${s.key}`, this.current);
              // 宁错审不错放：当前块（含断裂点之后的文本）整体回退题干，与既有 onOption 乱序路径一致
              this.appendToCurrent(block.text, blockIndex);
              preservedToStem = true;
              break;
            }
          }
          if (this.current && !preservedToStem) {
            this.current.blockIndexes = [...this.current.blockIndexes, blockIndex];
          }
          return;
        }
        this.onOption(block, m.optionKey ?? "", blockIndex);
        return;
      }
      default: {
        this.appendToCurrent(block.text, blockIndex);
      }
    }
  }

  /** 答案区：题号条目不匹配任何试题（这里是答案自身的切口），其余行累积 */
  private processAnswerBlock(block: ParsedBlock, blockIndex: number): void {
    if (block.kind !== "text" && block.kind !== "table") return; // 图/公式暂不处理
    const entry = matchAnswerEntry(block.text);
    if (entry) {
      this.answerEntry = { number: entry.number, text: entry.text };
      this.answers.push(this.answerEntry);
    } else if (this.answerEntry) {
      this.answerEntry.text += "\n" + block.text;
    }
    // 无当前条目的零散文本（卷尾说明）直接忽略
  }

  private onOption(block: { text: string }, key: string, blockIndex: number): void {
    const cur = this.current;
    if (!cur) return; // 未进入题目：孤立选项忽略

    if (key === this.expectOptionKey) {
      this.pendingOptions.push({ key, text: stripOptionPrefix(block.text) });
      this.expectOptionKey = nextKey(key);
      cur.optEvidence = true;
      cur.blockIndexes = [...cur.blockIndexes, blockIndex];
      return;
    }

    // 键不连续：结算已收集的选项组，该块按普通文本处理
    if (this.pendingOptions.length > 0) {
      this.settleOptions(cur);
    }
    this.review(blockIndex, `选项乱序：期待 ${this.expectOptionKey}，实际 ${key}`, cur);
    this.appendToCurrent(block.text, blockIndex);
  }

  /** 结算悬挂选项组：>=2 挂为正式选项；仅 1 个回退为题干文本并标记 */
  private settleOptions(cur: Draft | null): void {
    const pending = this.pendingOptions;
    this.pendingOptions = [];
    this.expectOptionKey = "A";
    if (pending.length === 0) return;

    const target = cur ?? this.current;
    if (pending.length >= 2 && target) {
      target.options = pending;
      this.stats.optionGroups++;
      if (pending.length !== EXPECTED_OPTION_COUNT) {
        this.review(-1, `选项组数量异常：${pending.length} 个选项`, target);
      }
      return;
    }

    // 单选项孤悬（常见于 OCR 把 "A．" 断成独立块）：回退文本，不静默丢弃
    if (target) {
      target.stemParts.push(stripOptionPrefix(pending[0]!.text));
      this.review(-1, "选项组中断：仅收集到 1 个选项，已回退为题干文本", target);
    }
  }

  private attachImage(block: Extract<ParsedBlock, { kind: "image" }>, blockIndex: number): void {
    if (!this.current) {
      this.review(blockIndex, "悬空图片：归属不到任何题目", null);
      return;
    }
    this.current.images.push({ path: block.path, bbox: block.bbox });
    this.current.blockIndexes = [...this.current.blockIndexes, blockIndex];
    this.stats.imagesAttached++;
  }

  private openDraft(number: string, block: { text: string }, entry: IndexedBlock): void {
    const stem = stripQuestionPrefix(block.text);
    this.stats.inlineFormulas += Math.floor((stem.split("$").length - 1) / 2);
    this.current = {
      seq: this.seq++,
      number,
      section: this.section,
      stemParts: stem ? [stem] : [],
      options: [],
      optEvidence: false,
      images: [],
      blockIndexes: [entry.index],
      pageIndex: entry.pageIndex,
      firstLineOfQuestion: block.text.trim().slice(0, 60),
    };
    this.questions.push(this.current);
  }

  private appendToCurrent(text: string, blockIndex: number, countInline = true): void {
    if (!this.current) return;
    if (countInline) {
      this.stats.inlineFormulas += Math.floor((text.split("$").length - 1) / 2);
    }
    this.current.stemParts.push(text);
    this.current.blockIndexes = [...this.current.blockIndexes, blockIndex];
  }

  private review(blockIndex: number, reason: string, cur: Draft | null): void {
    const questionId = cur ? idOf(this.doc, cur) : undefined;
    this.reviews.push({
      questionId,
      reason,
      blockIndex,
      snippet: cur?.firstLineOfQuestion ?? "",
    });
  }

  finish(): void {
    this.settleOptions(null);
  }

  result(questions: Question[]): SegmentationResult {
    this.stats.questions = questions.length;
    this.stats.reviewCount = this.reviews.length;
    return {
      docId: this.doc.docId,
      questions,
      reviews: this.reviews,
      stats: this.stats,
      answerEntries: this.answers,
    };
  }
}

function idOf(doc: ParsedDocument, d: Draft): string {
  return `${doc.docId}:p${d.pageIndex}:q${d.seq}`;
}

function buildQuestion(d: Draft, ctx: Ctx): Question {
  const confidence = confidenceOf(d);
  return {
    id: idOf(ctx.doc, d),
    type: d.options.length >= 2 ? "choice" : "subjective",
    number: d.number,
    section: d.section,
    stem: d.stemParts.join("\n").trim(),
    options: d.options,
    images: d.images,
    source: {
      file: ctx.doc.docId,
      pageIndex: d.pageIndex,
      blockIndexes: d.blockIndexes,
    },
    confidence,
    status: confidence < REVIEW_THRESHOLD ? "needs_review" : "ok",
  };
}

/** 置信度评估：每项扣分对应一种可诊断的失败模式（答案匹配在 merge 后复核由 flagDuplicateNumbers 补扣） */
function confidenceOf(d: Draft): number {
  let c = 1.0;
  if (!d.stemParts.join("").trim()) c -= 0.6; // 空题干：误切高发
  if (d.optEvidence && d.options.length === 0) c -= 0.4; // 有选项痕迹但收集失败
  if (d.options.length > 0 && d.options.length !== EXPECTED_OPTION_COUNT) c -= 0.1;
  return Math.max(0.2, Math.min(1, c));
}

/** 答案区条目按题号对号入座（题号去括号比较） */
function mergeAnswers(ctx: Ctx): void {
  for (const entry of ctx.answers) {
    const qs = ctx.questionMap.get(entry.number) ?? ctx.questionMap.get(`（${entry.number}）`);
    if (qs && qs.length > 0) {
      const target = qs.find((q) => !q.answer) ?? qs[0]!;
      target.answer = entry.text;
      ctx.stats.answersMatched++;
    } else {
      ctx.reviews.push({
        reason: `答案条目 ${entry.number} 未匹配到任何题目`,
        blockIndex: -1,
        snippet: entry.text.slice(0, 40),
      });
    }
  }
}

/**
 * 题号唯一性检查：**同一页内**同号多题 → 大概率误切，全部降置信度。
 * 只按 pageIndex 分组统计：教辅/试卷每页重排题号（页 0:1-7、页 1:1-12…），
 * 跨页同号是正常现象（question.id 已含页码，不构成歧义），不惩罚、不产生 review。
 */
function flagDuplicateNumbers(ctx: Ctx): void {
  for (const [num, qs] of ctx.questionMap) {
    const byPage = new Map<number, Question[]>();
    for (const q of qs) {
      const list = byPage.get(q.source.pageIndex) ?? [];
      list.push(q);
      byPage.set(q.source.pageIndex, list);
    }
    for (const pageQs of byPage.values()) {
      if (pageQs.length <= 1) continue;
      for (const q of pageQs) {
        q.confidence = Math.max(0.2, q.confidence - 0.3);
        if (q.confidence < REVIEW_THRESHOLD) q.status = "needs_review";
        ctx.reviews.push({
          questionId: q.id,
          reason: `重复题号「${num}」：第 ${q.source.pageIndex} 页 ${pageQs.length} 道题共享，存在误切风险`,
          blockIndex: -1,
          snippet: q.stem.slice(0, 40) || q.number,
        });
      }
    }
  }
}