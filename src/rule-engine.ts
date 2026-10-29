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
  isPageFurniture,
  looksLikeAnswerEntry,
  matchAnswerEntry,
  matchBoxListItem,
  matchFirstLine,
  matchGluedQuestionNumber,
  nextKey,
  splitConjoinedOptions,
  startsWithQuestionNumber,
  stripOptionPrefix,
  stripQuestionPrefix,
} from "./patterns.js";
import type {
  BBox,
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

/**
 * 方框内编号列表状态的**存活上限**（块数）。见 Ctx.boxList。
 * 实测该方框内条目间的最大间隔为 5 个块（含跨页与三幅插图），取 12 留 2.4 倍余量。
 */
const BOX_LIST_MAX_IDLE = 12;

interface Draft {
  seq: number;
  number: string;
  chapter: string;
  chapterTitle: string;
  sectionNo: string;
  section: string;
  /** 本节内的小问标记（只记录，不切题） */
  subQuestions: string[];
  /** **编号组序号**（全局单调）：同一节内题号重启即新组，见 Ctx.openDraft */
  sectionSeq: number;
  stemParts: string[];
  options: Option[];
  /** 是否见过选项块（区分「无选项题」与「选项收集失败」） */
  optEvidence: boolean;
  /** 选项键前向断裂（期待 A/B 却先出现 C/D）：组不完整，多半是上游漏检 */
  optGap: boolean;
  images: ImageRef[];
  /** 本题目区域内出现的表格（`kind:"table"` 块归属而来，DECISIONS §76） */
  tables: { html: string; bbox: BBox; pageIndex: number }[];
  blockIndexes: number[];
  pageIndex: number;
  firstLineOfQuestion: string;
}

interface AnswerDraft {
  number: string;
  text: string;
  /** 答案条目所属节号（同号跨节时用于对号入座） */
  sectionNo: string;
}

export function segmentWithRules(doc: ParsedDocument): SegmentationResult {
  const ctx = new Ctx(doc);

  // 逐页布局并按阅读顺序展平为全局块流（序号跨页连续）
  let globalIndex = 0;
  for (const page of doc.pages.slice().sort((a, b) => a.index - b.index)) {
    const layout = layoutPage(page);
    ctx.stats.columnsPerPage.push(layout.columns);
    ctx.pageHeight = page.height;
    ctx.settleAtPageBoundary();
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
  /** 当前处理页的页高（页顶带判定用） */
  pageHeight = 2339;
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
    /** 按「题号黏正文」规则切出的题数（DECISIONS §77；0 表示本册没有这种形态） */
    gluedQuestions: 0,
    columnsPerPage: [] as number[],
  };

  private mode: "questions" | "answers" = "questions";
  private current: Draft | null = null;
  private pendingOptions: Option[] = [];
  private expectOptionKey = "A";
  /**
   * **编号组序号**（全局单调）。为什么需要它：
   * 教辅里「节内题号从 1 重新开始」**不止发生在节边界** —— 实测题册第 5 节里
   * 还并进了「专题」「全章综合测试」「真题自测」三个块，各自也从 1 开始；
   * 答案册第 5 节同样并进 3 组。只靠节号做键，同一节里会出现多个 `1`，唯一键失效。
   * ⇒ 题号**回到 1** 就开新组（确定性信号，不依赖标题是否被 OCR 到）。
   */
  private sectionSeq = 0;
  /** 当前编号组里是否已收过题（用于「题号回到 1 ⇒ 新组」的判定） */
  private groupHasQuestions = false;
  /**
   * **方框内编号列表**状态（见 patterns.ts 的 BOX_LIST_BULLET）。
   * `anchor` = 列表起始编号（`▶N.` 的 N，诊断文案用）；`last` = 最近一条方框条目的编号；
   * `idle` = 距上次方框条目的块数（防状态滞留）。
   * 只在「见过 `▶N.` 锚点」时建立，且只吞**序号恰好 +1** 的行 —— 判据最严，
   * 无编号方框完全不受影响。
   */
  private boxList: { anchor: number; last: number; idle: number } | null = null;
  private chapter = "";
  private chapterTitle = "";
  private sectionNo = "";
  private section = "";
  /** 教材知识萃取参考区：区内「1./2./3.」是表格/参考内容，不是题目（2026-10-29 新书实测） */
  private extractBand = false;
  /** 章/节标题时间线（按 (页, y) 排序）—— 见 buildHeadingTimeline */
  private headings: {
    page: number;
    y: number;
    chapter?: string;
    chapterTitle?: string;
    sectionNo?: string;
    section?: string;
  }[] = [];
  private seq = 0;
  private answerEntry: AnswerDraft | null = null;

  constructor(doc: ParsedDocument) {
    this.doc = doc;
    this.buildHeadingTimeline();
  }

  /**
   * 预扫描全部块，抽出章/节标题，按 **(页, y)** 排序。
   *
   * ⚠️ 为什么不用「阅读顺序」：实测题册 p1 的 `第二章 相互作用` 与题目**不在同一栏**，
   * 按阅读顺序它被排到了题目之后 ⇒ 前 4 道题拿不到章上下文（`chapter` 为空）。
   * 标题永远在页面顶部、内容在其下方 ⇒ 按 (页, y) 传播是**确定且与分栏无关**的。
   */
  private buildHeadingTimeline(): void {
    for (const page of this.doc.pages) {
      for (const b of page.blocks) {
        if (b.kind !== "text") continue;
        const m = matchFirstLine(b.firstLine);
        if (m.kind === "chapter") {
          this.headings.push({ page: page.index, y: b.bbox[1], chapter: m.captured, chapterTitle: m.title ?? "" });
        } else if (m.kind === "section") {
          this.headings.push({
            page: page.index,
            y: b.bbox[1],
            sectionNo: m.captured || (m.indexNumeral ?? ""),
            section: b.text.trim(),
          });
        }
      }
    }
    this.headings.sort((a, b) => a.page - b.page || a.y - b.y);
  }

  /** (page, y) 处生效的章/节上下文（章标题会清空节上下文） */
  private contextAt(page: number, y: number): { chapter: string; chapterTitle: string; sectionNo: string; section: string } {
    let chapter = "";
    let chapterTitle = "";
    let sectionNo = "";
    let section = "";
    for (const h of this.headings) {
      if (h.page > page || (h.page === page && h.y > y)) break;
      if (h.chapter !== undefined) {
        chapter = h.chapter;
        chapterTitle = h.chapterTitle ?? "";
        sectionNo = "";
        section = "";
      } else {
        sectionNo = h.sectionNo ?? "";
        section = h.section ?? "";
      }
    }
    return { chapter, chapterTitle, sectionNo, section };
  }

  process(entry: IndexedBlock): void {
    this.stats.totalBlocks++;
    const { block, index: blockIndex } = entry;

    if (this.mode === "answers") {
      this.processAnswerBlock(block, blockIndex);
      return;
    }

    /**
     * **表格块**（`DECISIONS §76`）：只归属当前题，**不参与任何题号/选项判定**。
     * 为什么必须在这里提前 return：表格块有 `firstLine`，若落到下面的 `matchFirstLine`
     * 就会被当正文甚至切出新题 —— 切题结果必须与改动前逐字节一致，这是本特性的硬约束。
     * 归属不到题时**不静默**：记 ReviewNote（实验题黏连题号导致整页 0 题时会出现，
     * 见 HANDOFF §6-26）。
     */
    if (block.kind === "table") {
      const html = block.html ?? "";
      if (!this.current) {
        this.review(blockIndex, "悬空表格：归属不到任何题目（本页无进行中的题）", null);
        return;
      }
      this.current.tables.push({ html, bbox: block.bbox, pageIndex: this.current.pageIndex });
      this.current.blockIndexes = [...this.current.blockIndexes, blockIndex];
      return;
    }

    // 页内噪声块：答案标记（如 `[答案 P014]`）与被拆出的孤立括号 `()`。
    // 它们不是正文，但可能出现在页面中部（顶部家具守卫管不到），会粘进题干/选项。
    // 只跳过**整块恰好是**这些形态的块，不做子串删除，避免误伤正文。
    if (block.kind === "text") {
      const t = block.text.trim();
      if (/^\[?答案\s*[A-Z]?\d+\]?$/.test(t) || /^[（）()\s]+$/.test(t)) return;
    }

    // 方框列表状态防滞留：距上次方框条目超过 BOX_LIST_MAX_IDLE 个块即失效。
    // 为什么需要：状态要跨页存活（实测该方框从 p15 底跨到 p16 顶），所以不能用页界清；
    // 上限取「实测最大间隔 5 个块」的 2.4 倍，既容得下真实间隔，又不会长期滞留。
    if (this.boxList && ++this.boxList.idle > BOX_LIST_MAX_IDLE) this.boxList = null;

    // 页面家具跳过：页顶带的页眉装饰行（计划用时/必刷知识/单字"刷"logo）。
    // MinerU 对它们的去留不稳定，留在正文时会被上一页跨页未关的题吞进
    // 题干/选项（2026-10-07 p4 假第5题实证）——不归属任何题，也不进题干。
    // ⚠️ **题号优先**：页眉家具守卫不得吃掉题号行。
    // 实测（2026-10-12）：答案册题号行天然带「必刷知识/方法/考点」标签
    // （`7. CD 必刷知识·摩擦力`），同时命中「页顶带」与家具模式 ⇒ 整块被丢，
    // **连题号一起扔掉**（162 个题号里漏了 16 个）。题号是显式结构信号，优先级更高。
    if (
      block.kind === "text" &&
      block.bbox[3] <= this.pageHeight * 0.2 &&
      isPageFurniture(block.text) &&
      !startsWithQuestionNumber(block.firstLine)
    ) {
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

    /**
     * **题号黏正文**（`DECISIONS §77`）：`2为了减少阻力…` —— 数字紧跟汉字，无分隔符。
     * 只在「形状完全没匹配上 + 序号恰好接上一题」时才认，判据见
     * `patterns.ts` 的 `matchGluedQuestionNumber`。
     * 为什么要在这里补：实验题整类切不出来（含实验标记 8 页里 5 页 0 题），
     * 而实验题的题号常常就长这样。
     */
    if (m.kind === "other" && !this.extractBand && !this.boxList) {
      /**
       * 期望题号：
       * - 有当前题 ⇒ 上一题 + 1（序号连续，最强的信号）；
       * - **无当前题**（刚过章/节标题，或本册首题）⇒ 只认 `1`（节内题号从 1 重启）。
       *   少了这条，节边界上的黏连题号（`1小天同学用如图1所示…`）永远切不出来。
       */
      const expected = this.current
        ? /^\d{1,2}$/.test(this.current.number)
          ? Number(this.current.number) + 1
          : null
        : 1;
      const glued = matchGluedQuestionNumber(block.firstLine, expected);
      if (glued !== null) {
        this.settleOptions(null);
        // 剥掉行首题号（`2为了…` → `为了…`），其余文本原样进题干
        const stripped = block.firstLine.trimStart().replace(/^\d{1,2}/, "");
        const restText = block.text.trimStart().replace(/^\d{1,2}/, "");
        this.openDraft(glued, { text: restText }, entry);
        this.stats.gluedQuestions = (this.stats.gluedQuestions ?? 0) + 1;
        this.review(blockIndex, `题号黏正文：按「第 ${glued} 题」切分（原行「${stripped.slice(0, 24)}…」）`, this.current);
        return;
      }
    }

    // 方框内编号列表的锚点 `▶1. …`（方法技巧/易错警示方框）：记下起始编号，
    // 后续「序号恰好 +1」的行按方框条目处理（见 patterns.ts 的 BOX_LIST_BULLET）。
    // 放在这里而不是函数开头：`firstLine` 只对文本块存在（图/公式块没有）。
    const boxAnchor = matchBoxListItem(block.firstLine);
    if (boxAnchor !== null) this.boxList = { anchor: boxAnchor, last: boxAnchor, idle: 0 };

    switch (m.kind) {
      case "answer_zone": {
        // 参考答案区：试题流终止，之后只解析答案条目。
        //
        // **位置守卫（2026-10-29）**：切进 answers 模式是**不可逆**的破坏性状态变化，
        // 而「答案及解析」这类词形在**封面/扉页/页脚**上同样出现（本册页脚就是它）。
        // 没有已收题目就切换，等于把整册正文判成答案续行 —— 实测《答案册-合订本》
        // p0 封面标题一命中就 0 题（A/B 实测：503→0）。
        // ⇒ 要求「已有题目」才允许切换；否则只记 review，不改状态。
        if (this.questions.length === 0 && !this.current) {
          this.review(
            blockIndex,
            `答案区标题出现在首题之前（疑似封面/扉页），不切换状态：「${block.firstLine.trim()}」`,
            null,
          );
          return;
        }
        this.settleOptions(null);
        this.current = null;
        this.boxList = null;
        this.mode = "answers";
        return;
      }
      case "chapter": {
        // 章标题：如 "第二章 相互作用" —— 更新章上下文，并**清空节上下文**
        // （题号会在新章里从 1 重新开始，旧节号留着会造出错误的唯一键）
        this.settleOptions(null);
        this.current = null;
        this.boxList = null;
        this.chapter = m.captured;
        this.chapterTitle = m.title ?? "";
        this.sectionNo = "";
        this.section = "";
        this.extractBand = false;
        return;
      }
      case "section": {
        // 节/大题标题：如 "第2节 牛顿第三定律" / "专题 …" / "一、选择题" —— 更新节上下文
        this.settleOptions(null);
        this.current = null;
        this.boxList = null;
        this.sectionNo = m.captured || (m.indexNumeral ?? "");
        this.section = block.text.trim();
        this.extractBand = /^教材知识萃取/.test(block.text.trim());
        return;
      }
      case "sub_question": {
        // **小问不是题**：并入当前题题干并记录标记，绝不新开一道题（见 patterns.ts）。
        this.settleOptions(this.current);
        if (!this.current) {
          this.review(blockIndex, `孤立小问「（${m.captured}）」：无当前题目可归属`, null);
          return;
        }
        this.appendToCurrent(block.text.trim(), blockIndex);
        this.current.subQuestions.push(m.captured);
        return;
      }
      case "question_no": {
        if (this.extractBand) {
          this.review(blockIndex, `教材知识萃取栏内的编号条目「${m.captured}.」不是题目（参考表格内容）`, this.current);
          return;
        }
        // **方框守卫**：`▶N.` 锚点之后、序号恰好 +1、且**不像答案条目**的行，
        // 是方框内的编号条目（不是题）。判据最严（AND 三条件），且**不静默**：
        // 记 ReviewNote，文本并入当前题（不丢内容）。
        // 第三条件是防「静默误吞真题」——见 patterns.ts 的 ANSWER_SHAPE。
        // 任一条件不满足 ⇒ 方框列表结束，该行按正常题号处理。
        if (
          this.boxList &&
          Number(m.captured) === this.boxList.last + 1 &&
          !looksLikeAnswerEntry(block.firstLine)
        ) {
          const anchor = this.boxList.anchor;
          this.boxList = { anchor, last: Number(m.captured), idle: 0 };
          this.settleOptions(null);
          this.appendToCurrent(block.text, blockIndex);
          this.review(
            blockIndex,
            `方框内编号条目「${m.captured}.」未作为题目（方法技巧/易错警示方框的编号列表，锚点 ▶${anchor}.）`,
            this.current,
          );
          return;
        }
        this.boxList = null;
        this.settleOptions(null);
        this.openDraft(m.captured, block, entry);
        return;
      }
      case "option": {
        // 选项行结构化拆分（含粘连多选项一行：layout 行级未覆盖时的兜底）。
        // 门控 >=1：单段结果（含「连续同键合并」后的上游重复行）同样走结构化路径，
        // 与 onOption 的 stripOptionPrefix 全文回退相比，段文本已去过重复噪声。
        const splits = splitConjoinedOptions(block.text);
        if (splits.length >= 1 && splits[0]!.key === this.expectOptionKey) {
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
        // 选项续行：选项组收集中，非选项行是最后一个已收选项的续行
        // （如 "B. 设 AP 长度为 L" 的下一行 "的变化量，∆L表示L的变"）。
        // 旧实现一律并进题干 → 选项文本残缺、题干被碎片污染
        // （2026-10-07 真实回归 p9 第11题）。题干期（无悬挂选项）行为不变。
        const last = this.pendingOptions[this.pendingOptions.length - 1];
        if (last) {
          last.text += `\n${block.text}`;
          if (this.current) {
            this.current.blockIndexes = [...this.current.blockIndexes, blockIndex];
          }
        } else {
          this.appendToCurrent(block.text, blockIndex);
        }
      }
    }
  }

  /** 答案区：题号条目不匹配任何试题（这里是答案自身的切口），其余行累积 */
  private processAnswerBlock(block: ParsedBlock, blockIndex: number): void {
    if (block.kind !== "text" && block.kind !== "table") return; // 图/公式暂不处理
    // 答案区里也有章/节标题 —— 同号跨节是常态，必须记下节号才能对号入座
    const entry = matchAnswerEntry(block.text);
    if (entry) {
      this.answerEntry = { number: entry.number, text: entry.text, sectionNo: this.sectionNo };
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

    // 前向缺键（期待 A/B 却直接出现 C/D）：收下该选项段并标记缺键，
    // 让缺键+数量扣分把题送进人工校对。典型成因是上游漏检纯公式选项
    // （2026-10-07 真实回归：热狗题 A/B 为 {5/8}G 类公式，layout.json 无字母前缀）。
    // 旧实现整块回退题干 → 选项组静默消失且置信度不降，违反「不静默失败」。
    if (key > this.expectOptionKey) {
      const expected = this.expectOptionKey;
      this.pendingOptions.push({ key, text: stripOptionPrefix(block.text) });
      this.expectOptionKey = nextKey(key);
      cur.optEvidence = true;
      cur.optGap = true;
      cur.blockIndexes = [...cur.blockIndexes, blockIndex];
      this.review(blockIndex, `选项缺键：期待 ${expected}，实际 ${key}（疑似上游漏检）`, cur);
      return;
    }

    // 键回退/重复（乱序噪声）：结算已收集的选项组，该块按普通文本处理。
    // 期望键须在 settle 前捕获——settleOptions 会把 expectOptionKey 重置回 "A"，
    // 否则评审文案永远显示「期待 A」，误导质检（2026-10-07 修复）。
    const expected = this.expectOptionKey;
    if (this.pendingOptions.length > 0) {
      this.settleOptions(cur);
    }
    this.review(blockIndex, `选项乱序：期待 ${expected}，实际 ${key}`, cur);
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
    // **题号回到 1 ⇒ 新的编号组**（确定性信号：不依赖标题有没有被 OCR 到）。
    // 节/章标题也会开新组（见 switch），这里兜住「标题缺失但题号重启」的情况。
    if (number === "1" && this.groupHasQuestions) this.sectionSeq++;
    this.groupHasQuestions = true;
    // 章/节上下文：**阅读顺序为主**（它懂分栏：答案册的节标题在页中部、栏内向下传播），
    // **（页,y）兜底**（题册 p1 的 `第二章` 与题目不在同一栏，阅读顺序把它排到了题目之后）。
    let hctx = { chapter: this.chapter, chapterTitle: this.chapterTitle, sectionNo: this.sectionNo, section: this.section };
    if (!hctx.chapter) hctx = this.contextAt(entry.pageIndex, entry.block.bbox[1]);
    const stem = stripQuestionPrefix(block.text);
    this.stats.inlineFormulas += Math.floor((stem.split("$").length - 1) / 2);
    this.current = {
      seq: this.seq++,
      number,
      chapter: hctx.chapter,
      chapterTitle: hctx.chapterTitle,
      sectionNo: hctx.sectionNo,
      section: hctx.section,
      subQuestions: [],
      sectionSeq: this.sectionSeq,
      stemParts: stem ? [stem] : [],
      options: [],
      optEvidence: false,
      optGap: false,
      images: [],
      tables: [],
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

  /**
   * 页界结算：翻页时若上一页残留悬挂选项组，就地定稿并关闭草稿。
   * 跨页题的「题干期」续行（q7/q6 案例，草稿尚无选项）不受影响；
   * 但选项已收齐的题若保持打开，会吞掉下一页的页眉/标题块
   * （2026-10-07 p5 页首标题被上一页第5题吞掉实证）。
   */
  settleAtPageBoundary(): void {
    if (this.pendingOptions.length > 0) {
      this.settleOptions(this.current);
      this.current = null;
    }
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
    chapter: d.chapter,
    chapterTitle: d.chapterTitle,
    sectionNo: d.sectionNo,
    section: d.section,
    subQuestions: d.subQuestions,
    sectionSeq: d.sectionSeq,
    stem: d.stemParts.join("\n").trim(),
    options: d.options,
    images: d.images,
    ...(d.tables.length ? { tables: d.tables } : {}),
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
  if (d.optGap) c -= 0.3; // 缺键：选项组不完整（上游漏检/误切）
  if (d.options.length > 0 && d.options.length !== EXPECTED_OPTION_COUNT) c -= 0.1;
  return Math.max(0.2, Math.min(1, c));
}

/** 答案区条目按题号对号入座（题号去括号比较） */
function mergeAnswers(ctx: Ctx): void {
  for (const entry of ctx.answers) {
    const qs = ctx.questionMap.get(entry.number) ?? [];
    if (qs.length > 0) {
      // 同号跨节是常态（每节题号从 1 开始）⇒ 先按节号收窄，再取首个未配答案的
      const sameSection = qs.filter((q) => !entry.sectionNo || q.sectionNo === entry.sectionNo);
      const pool = sameSection.length ? sameSection : qs;
      const target = pool.find((q) => !q.answer) ?? pool[0]!;
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