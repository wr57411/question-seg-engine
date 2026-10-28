// scripts/build-bank.ts
/**
 * 题目—答案仓库构建（**块级对齐 + 块内配对 + 守恒校验**）。
 *
 * ## 数据来源
 * - **题册**（`23必刷题 2相互作用`）：题目（题干 + 选项），每节题号 1..N；
 * - **答案册**（`第二章相互作用-答案与解析`）：答案条目（选项字母 + 【解析】），同样按题号排。
 *
 * ## 为什么不能用 `(chapter, sectionSeq, number)` 直接 join（旧实现的做法）
 * `sectionSeq` 是**每份文档内部**的编号组计数器（「题号回到 1 就开新组」），
 * 两册的分组个数天然不同 —— 答案册片段开头还有上一章的残留组（`?|0`），
 * 于是同一个 `sectionSeq` 在两册里指向**不同的节**：实测题册组 6（第5节）对上答案册组 6（第4节），
 * 一错到底（旧实现 83 题只配上 68 条，且报告里 30 行「顺序对齐不一致」全是这个错位造成的）。
 * ⇒ 键对齐的前提「两册的组序号一一对应」根本不成立，必须**先把块对齐**。
 *
 * ## 做法（三步，全部确定性）
 * 1. **块级对齐**：把两册各自切成「块」（同 chapter + 同 sectionSeq 的连续题），
 *    在**同一章内**做**单调动态规划**，最大化
 *    `配对得分 = min(两侧题数) − |两侧题数之差| + (节号相同 ? 2 : 0)`；跳过一个块得分 0。
 *    ⇒ 结构相似、顺序一致的块自然配上；结构差异大的宁可不配（得分 ≤ 0 时 DP 会选跳过）。
 * 2. **块内配对**：对齐好的块对内部，**按题号**一一配对。
 * 3. **守恒校验（本脚本的退出码）**：
 *    - **保序**：题册侧顺序递增 ⇒ 答案册侧配对位置必须递增（不允许交叉）；
 *    - **守恒**：题册题数 = 已配对 + 有记录的未配对；答案册（片段章内）同理；
 *    - **每条未配对都要有分类原因**（章节不在片段内 / 源文档缺该号 / 块未对齐），
 *      **不允许出现没有原因的缺口**（不静默失败）。
 *
 * 用法：`node --import tsx scripts/build-bank.ts`（有违规 → 退出码 1）
 *
 * ⚠️ **单册模式**：只配一对（默认那对，或 `--quiz/--answer` 指定），输出覆盖 `bank/bank.json`。
 * 正式产出请用 `npm run bank:all`（多册，`check` 用的就是它）—— 单册命令留作调试与局部复算。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 参数（都可省略，默认值 = 2026-10-14 定案的那一对，保持向后兼容）：
 *   `--quiz <docId>`   题册
 *   `--answer <docId>` 答案册
 *   `--out <path>`     输出 json（默认 `data/out/bank/bank.json`）
 *
 * 为什么加这三个：`scripts/bank-all.ts` 要按「一章一对」逐次调用本脚本（配对逻辑只此一份），
 * 再把各次结果合并 —— 而不是在第二个脚本里重写一遍块级对齐。
 */
function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUIZ_DOC = argOf("quiz") ?? "23必刷题 2相互作用";
const ANSWER_DOC = argOf("answer") ?? "第二章相互作用-答案与解析";
const OUT_JSON = argOf("out") ?? join("data", "out", "bank", "bank.json");

interface Q {
  id: string;
  number: string;
  chapter?: string;
  chapterTitle?: string;
  sectionNo?: string;
  section?: string;
  sectionSeq?: number;
  stem: string;
  options?: { key: string; text: string }[];
  subQuestions?: string[];
  source?: { pageIndex?: number; blockIndexes?: number[] };
  /** 引擎侧的题目图片（裸文件名 + 原卷 bbox）——bank 必须把它带下来，
   *  否则题册面板看答案时**图就没了**（2026-10-15 用户当场指出：第3节第3题答案有受力图，面板里没有）。 */
  images?: { path: string; bbox?: number[] }[];
}

const load = (doc: string): Q[] =>
  JSON.parse(readFileSync(join("data", "out", doc, "questions.json"), "utf8"));

/** 从答案条目里抽选项字母：`C必刷知识·重力的方向…` → "C"；`AD必刷知识…` → "AD" */
function answerKeyOf(text: string): string {
  const m = /^\s*([A-H]{1,4})\b/.exec(text.replace(/\s+/g, " "));
  if (!m) return "";
  return [...new Set(m[1]!.split(""))].sort().join("");
}

// ---------- 块：同 (chapter, sectionSeq) 的连续题 ----------

interface Block {
  doc: string;
  chapter: string;
  chapterTitle: string;
  sectionSeq: number;
  sectionNo: string;
  section: string;
  items: Q[];
}

function toBlocks(qs: Q[], doc: string): Block[] {
  const out: Block[] = [];
  for (const q of qs) {
    const chapter = q.chapter ?? "";
    const sectionSeq = q.sectionSeq ?? -1;
    const last = out[out.length - 1];
    if (last && last.chapter === chapter && last.sectionSeq === sectionSeq) {
      last.items.push(q);
      continue;
    }
    out.push({
      doc,
      chapter,
      chapterTitle: q.chapterTitle ?? "",
      sectionSeq,
      sectionNo: q.sectionNo ?? "",
      section: q.section ?? "",
      items: [q],
    });
  }
  return out;
}

const label = (b: Block) =>
  `章${b.chapter || "?"} 组${b.sectionSeq}（${b.section || b.sectionNo || "无标题"}，${b.items.length} 题）`;

// ---------- 块级对齐：单调 DP ----------

/** 块对得分：能对上的题数 − 尺寸失配惩罚 + 节号一致奖励（奖励很小，只用来破平局） */
function pairScore(a: Block, b: Block): number {
  const size = Math.min(a.items.length, b.items.length);
  const mismatch = Math.abs(a.items.length - b.items.length);
  const titleBonus = a.sectionNo && b.sectionNo && a.sectionNo === b.sectionNo ? 2 : 0;
  return size - mismatch + titleBonus;
}

interface Alignment {
  quiz: Block;
  ans: Block | null;
}

/**
 * 同一章内做单调对齐（DP 最大化总分）；允许任一侧跳过某个块（得分 0）。
 *
 * ⚠️ **跳过的答案块必须回传**（2026-10-28 曲线运动实测）：原来 `left` 分支只做 `j--`，
 * 被跳过的答案块连同它的题目**直接消失** —— 既没配对也没进未配对记录，
 * 守恒校验（答案册章内 18 ≠ 配对 16 + 未配对 0）当场红。
 * 现在回传 `skippedAns`，由调用方逐条记入未配对（每条都要有原因）。
 */
function alignChapter(
  quizBlocks: Block[],
  ansBlocks: Block[],
): { rows: Alignment[]; skippedAns: Block[] } {
  const n = quizBlocks.length;
  const m = ansBlocks.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const from: ("up" | "left" | "diag")[][] = Array.from({ length: n + 1 }, () =>
    new Array<"up" | "left" | "diag">(m + 1).fill("up"),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const up = dp[i - 1]![j]!;
      const left = dp[i]![j - 1]!;
      const diag = dp[i - 1]![j - 1]! + pairScore(quizBlocks[i - 1]!, ansBlocks[j - 1]!);
      if (diag >= up && diag >= left) {
        dp[i]![j] = diag;
        from[i]![j] = "diag";
      } else if (up >= left) {
        dp[i]![j] = up;
        from[i]![j] = "up";
      } else {
        dp[i]![j] = left;
        from[i]![j] = "left";
      }
    }
  }
  const out: Alignment[] = [];
  const skippedAns: Block[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = i === 0 ? "left" : j === 0 ? "up" : from[i]![j]!;
    if (dir === "diag") {
      out.push({ quiz: quizBlocks[i - 1]!, ans: ansBlocks[j - 1]! });
      i--;
      j--;
    } else if (dir === "up") {
      out.push({ quiz: quizBlocks[i - 1]!, ans: null });
      i--;
    } else {
      skippedAns.push(ansBlocks[j - 1]!);
      j--;
    }
  }
  return { rows: out.reverse(), skippedAns };
}

// ---------- T 行交叉核验（独立证据，提示项） ----------
//
// 题册每个块的**块头 T 行**（`必刷知识T1~2、4~5…` / `必刷方法T3` / `必刷考点T6、9、11`）
// 印的是「这个块里哪几道题属于必刷知识 / 方法 / 考点」；答案册每条答案也自带同样的标签
// （`5. AC 必刷考点·…`）。**两者分别印在两本书的不同位置** ⇒ 相互独立。
// 若配对错位（例如整块错开一位），标签一致率会立刻掉下来 —— 见下面的**对照组**。
//
// ⚠️ 没有对照组的「100% 一致」没有意义：标签分布本身不均匀（一个块里多数题同为「必刷知识」），
// 随机错位也能撞上不少。所以这里同时算「同块内答案错位一位」的一致率作为**判别力标定**。
// 只作**提示项**（不进退出码）：覆盖受限于「块头 T 行是否被上游读到」（本卷 6/10 块）。

interface TLineData {
  /** pageIndex → (题号 → 标签集合) */
  byPage: Map<number, Map<string, string[]>>;
}

function loadTLineTags(doc: string): TLineData {
  const p = join("data", "out", doc, "stages.json");
  const byPage = new Map<number, Map<string, string[]>>();
  if (!existsSync(p)) return { byPage };
  const snap = JSON.parse(readFileSync(p, "utf8")) as {
    pages: { index: number; order: number[]; blocks: { i: number; kind?: string; text?: string }[] }[];
  };
  const RE = /必刷(知识|方法|考点)\s*T([\d、~～\-&\s]+)/g;
  for (const pg of snap.pages) {
    const byI = new Map(pg.blocks.map((b) => [b.i, b]));
    for (const k of pg.order) {
      const b = byI.get(k);
      if (!b || b.kind !== "text") continue;
      const t = (b.text ?? "").trim();
      if (!/必刷(知识|方法|考点)\s*T/.test(t)) continue;
      const map = byPage.get(pg.index) ?? new Map<string, string[]>();
      for (const m of t.matchAll(RE)) {
        const tag = m[1]!;
        for (const part of (m[2] ?? "").split(/[、&,，\s]+/)) {
          const r = /^(\d+)\s*[~～\-]\s*(\d+)$/.exec(part);
          if (r) {
            for (let i = Number(r[1]); i <= Number(r[2]); i++) {
              const kk = String(i);
              map.set(kk, [...(map.get(kk) ?? []), tag]);
            }
            continue;
          }
          const o = /^(\d+)$/.exec(part);
          if (o) map.set(o[1]!, [...(map.get(o[1]!) ?? []), tag]);
        }
      }
      byPage.set(pg.index, map);
    }
  }
  return { byPage };
}

/** 答案文本自带的标签：`5. AC 必刷考点·…` → "考点" */
const answerTagOf = (s: string): string => /必刷(知识|方法|考点|模型|真题)/.exec(s ?? "")?.[1] ?? "";

// ---------- 主流程 ----------

const quiz = load(QUIZ_DOC);
const ans = load(ANSWER_DOC);
const quizBlocks = toBlocks(quiz, QUIZ_DOC);
const ansBlocks = toBlocks(ans, ANSWER_DOC);
const pageOfQuiz = new Map(quiz.map((q) => [q.id, q.source?.pageIndex ?? -1]));

const chapters = [...new Set(quizBlocks.map((b) => b.chapter))].sort();
const alignments: Alignment[] = [];
/** 对齐时被跳过的答案块（DP 允许跳过）—— 它们的题目必须逐条记入未配对，否则守恒失败 */
const skippedAnsBlocks: Block[] = [];
for (const ch of chapters) {
  const r = alignChapter(
    quizBlocks.filter((b) => b.chapter === ch),
    ansBlocks.filter((b) => b.chapter === ch),
  );
  alignments.push(...r.rows);
  skippedAnsBlocks.push(...r.skippedAns);
}

interface Entry {
  chapter: string;
  chapterTitle: string;
  sectionNo: string;
  section: string;
  sectionSeq: number;
  /** 块级对齐后的**块序号**（两册一致）—— 比 sectionSeq 可靠的唯一键成分 */
  blockIndex: number;
  number: string;
  key: string;
  stem: string;
  options: { key: string; text: string }[];
  subQuestions: string[];
  answerKey: string;
  answerText: string;
  /** 答案侧的图片（来自**答案册**，路径要配 `data/out/<答案册>/images/` 拼） */
  answerImages: { path: string; bbox?: number[] }[];
  quizId: string;
  answerId: string;
}

const bank: Entry[] = [];
/** 未配对记录：每一条都必须有分类原因（否则校验失败） */
const unmatchedQuiz: { at: string; reason: string }[] = [];
const unmatchedAns: { at: string; reason: string }[] = [];
const alignRows: string[] = [];
const orderViolations: string[] = [];
const pairOrder: { quizIdx: number; ansIdx: number; label: string }[] = [];

const ansIndex = new Map<string, number>();
ans.forEach((a, i) => ansIndex.set(a.id, i));
const quizIndex = new Map<string, number>();
quiz.forEach((q, i) => quizIndex.set(q.id, i));

let blockNo = 0;
for (const al of alignments) {
  const qb = al.quiz;
  if (!al.ans) {
    for (const q of qb.items) {
      unmatchedQuiz.push({ at: `${QUIZ_DOC} 组${qb.sectionSeq} #${q.number}`, reason: "该块在答案册里没有对齐的块" });
    }
    alignRows.push(`| ${label(qb)} | — | 未对齐（答案册无对应块） |`);
    continue;
  }
  const ab = al.ans;
  blockNo++;
  const ansByNumber = new Map<string, Q[]>();
  for (const a of ab.items) ansByNumber.set(a.number, [...(ansByNumber.get(a.number) ?? []), a]);
  const usedAns = new Set<string>();
  let matched = 0;

  for (const q of qb.items) {
    const pool = ansByNumber.get(q.number) ?? [];
    const a = pool.find((x) => !usedAns.has(x.id));
    if (!a) {
      unmatchedQuiz.push({
        at: `${QUIZ_DOC} 组${qb.sectionSeq} #${q.number}`,
        reason: `对齐块内有该块但缺 #${q.number}（源文档缺答案）`,
      });
      continue;
    }
    usedAns.add(a.id);
    matched++;
    pairOrder.push({
      quizIdx: quizIndex.get(q.id) ?? -1,
      ansIdx: ansIndex.get(a.id) ?? -1,
      label: `#${q.number}`,
    });
    bank.push({
      chapter: q.chapter ?? "",
      chapterTitle: q.chapterTitle ?? "",
      sectionNo: q.sectionNo ?? "",
      section: q.section ?? "",
      sectionSeq: q.sectionSeq ?? -1,
      blockIndex: blockNo,
      number: q.number,
      key: `${q.chapter ?? ""}|${blockNo}|${q.number}`,
      stem: q.stem,
      options: q.options ?? [],
      subQuestions: q.subQuestions ?? [],
      answerKey: answerKeyOf(a.stem),
      answerText: a.stem,
      answerImages: a.images ?? [],
      quizId: q.id,
      answerId: a.id,
    });
  }
  for (const a of ab.items) {
    if (!usedAns.has(a.id)) {
      unmatchedAns.push({
        at: `${ANSWER_DOC} 组${ab.sectionSeq} #${a.number}`,
        reason: `对齐块内有该答案但题册缺 #${a.number}（源文档缺题）`,
      });
    }
  }
  alignRows.push(
    `| ${label(qb)} | ${label(ab)} | **${matched}**（题册 ${qb.items.map((x) => x.number).join(",")} / 答案册 ${ab.items
      .map((x) => x.number)
      .join(",")}） |`,
  );
}

// 对齐时被跳过的答案块：逐条记录原因（**不静默**，守恒校验靠它）
for (const b of skippedAnsBlocks) {
  for (const a of b.items) {
    unmatchedAns.push({
      at: `${ANSWER_DOC} 章${b.chapter || "?"} 组${b.sectionSeq} #${a.number}`,
      reason: "该答案块没有对齐的题册块（结构差异过大，DP 跳过）",
    });
  }
}

// 章节只出现在答案册（题册片段不含）：逐条记录原因，不算违规
const alignedAnsIds = new Set(bank.map((b) => b.answerId));
for (const b of ansBlocks) {
  if (chapters.includes(b.chapter)) continue;
  for (const a of b.items) {
    if (!alignedAnsIds.has(a.id)) {
      unmatchedAns.push({
        at: `${ANSWER_DOC} 章${b.chapter || "?"} 组${b.sectionSeq} #${a.number}`,
        reason: `题册片段不含该章（${b.chapterTitle || b.chapter || "无章号"}）`,
      });
    }
  }
}

// ---------- 校验（本脚本的退出码） ----------

// 0) T 行交叉核验（独立证据，**提示项**，不进退出码；判据与对照见函数区注释）
const tline = loadTLineTags(QUIZ_DOC);
const firstPageOfBlock = new Map<number, number>();
for (const e of bank) {
  const p = pageOfQuiz.get(e.quizId) ?? -1;
  if (!firstPageOfBlock.has(e.blockIndex) || p < firstPageOfBlock.get(e.blockIndex)!) firstPageOfBlock.set(e.blockIndex, p);
}
const blockByFirstPage = new Map<number, number>();
for (const [bi, p] of [...firstPageOfBlock].sort((a, b) => a[0] - b[0])) {
  if (!blockByFirstPage.has(p)) blockByFirstPage.set(p, bi);
}
const tagsByBlock = new Map<number, Map<string, string[]>>();
for (const [p, map] of tline.byPage) {
  const bi = blockByFirstPage.get(p);
  if (bi !== undefined) tagsByBlock.set(bi, map);
}
let tTotal = 0;
let tAgree = 0;
let tSkipped = 0;
for (const e of bank) {
  const expect = tagsByBlock.get(e.blockIndex)?.get(e.number);
  const got = answerTagOf(e.answerText);
  if (!expect || !got) {
    tSkipped++;
    continue;
  }
  tTotal++;
  if (expect.includes(got)) tAgree++;
}
// 对照组：同块内答案错位一位（标定判别力；没有对照组的一致率没有意义）
const bankByBlock = new Map<number, Entry[]>();
for (const e of bank) bankByBlock.set(e.blockIndex, [...(bankByBlock.get(e.blockIndex) ?? []), e]);
let cTotal = 0;
let cAgree = 0;
for (const list of bankByBlock.values()) {
  const map = tagsByBlock.get(list[0]!.blockIndex);
  if (!map) continue;
  for (let i = 0; i < list.length; i++) {
    const expect = map.get(list[i]!.number);
    const got = answerTagOf(list[(i + 1) % list.length]!.answerText);
    if (!expect || !got) continue;
    cTotal++;
    if (expect.includes(got)) cAgree++;
  }
}
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const tlineLine =
  `T 行交叉核验（独立证据）：可核验 ${tTotal} 条（${tSkipped} 条块头 T 行未读到 ⇒ 无法核验），` +
  `一致 **${tAgree}（${pct(tAgree, tTotal)}）**；对照组（同块内答案错位一位）一致 ${cAgree}（${pct(cAgree, cTotal)}）`;

// 1) 保序：配对必须在两册上同时单调递增
pairOrder.sort((a, b) => a.quizIdx - b.quizIdx);
for (let i = 1; i < pairOrder.length; i++) {
  const p = pairOrder[i - 1]!;
  const c = pairOrder[i]!;
  if (c.ansIdx <= p.ansIdx) {
    orderViolations.push(`题册第 ${c.quizIdx} 题(${c.label}) 的答案位置 ${c.ansIdx} 未超过上一对 ${p.ansIdx}`);
  }
}

// 2) 守恒：题册 = 配对 + 有记录未配对；答案册（片段章内）同理
const ansInChapters = ans.filter((a) => chapters.includes(a.chapter ?? "")).length;
const unmatchedAnsInAligned = unmatchedAns.filter((x) => !x.reason.startsWith("题册片段不含该章")).length;
const conserved = bank.length + unmatchedQuiz.length === quiz.length && bank.length + unmatchedAnsInAligned === ansInChapters;

const dupKeys = bank.map((b) => b.key).filter((k, i, a) => a.indexOf(k) !== i);

// 3) 图片守恒（2026-10-15，用户当场指出「答案有图，面板里没有」）：
//    配对条目**一张图都不许丢**。判据取被检对象之外的独立来源——直接拿引擎 questions.json
//    的 `images` 数量与 bank 条目比，不看 bank 自己算的数（同源就抓不到自己的漏）。
const ansById = new Map(ans.map((a) => [a.id, a]));
const lostImages = bank.filter(
  (e) => (ansById.get(e.answerId)?.images?.length ?? 0) !== e.answerImages.length,
);
const imgOnQuizSide = bank.filter((e) => e.answerImages.length > 0).length;
const imgInSource = bank.filter((e) => (ansById.get(e.answerId)?.images?.length ?? 0) > 0).length;

const violations: string[] = [
  ...orderViolations.map((s) => `保序失败：${s}`),
  ...(conserved
    ? []
    : [
        `守恒失败：题册 ${quiz.length} ≠ 配对 ${bank.length} + 未配对 ${unmatchedQuiz.length}；` +
          `或答案册（片段章内 ${ansInChapters}）≠ 配对 ${bank.length} + 未配对 ${unmatchedAnsInAligned}`,
      ]),
  ...(dupKeys.length ? [`唯一键重复 ${dupKeys.length} 个：${[...new Set(dupKeys)].slice(0, 5).join(", ")}`] : []),
  ...(lostImages.length
    ? [
        `图片丢失 ${lostImages.length} 条：答案册原题有图，bank 条目却没带上` +
          `（例：${lostImages.slice(0, 3).map((e) => e.key).join(", ")}）`,
      ]
    : []),
];

const outDir = join("data", "out", "bank");
mkdirSync(outDir, { recursive: true });
mkdirSync(join(OUT_JSON, ".."), { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify(bank, null, 1));

const report = [
  "# 题目—答案仓库构建报告",
  "",
  `- 题册：${quiz.length} 题（${quizBlocks.length} 块）；答案册：${ans.length} 条（${ansBlocks.length} 块）`,
  `- **配对成功：${bank.length} 条**；题册未配对 ${unmatchedQuiz.length} 题；答案册未配对 ${unmatchedAns.length} 条`,
  "- 配对键：`(chapter, blockIndex, number)` —— blockIndex 是**块级对齐后**的块序号，两册一致；",
  "  旧实现的 `(chapter, sectionSeq, number)` **不可用**：sectionSeq 是各册内部计数器，两册分组数不同（见脚本头注释）",
  `- 唯一性：重复键 ${dupKeys.length} 个`,
  "",
  "## 块级对齐表（证据）",
  "",
  "| 题册块 | 答案册块 | 块内配对 |",
  "|---|---|---|",
  ...alignRows,
  "",
  "## 题册里没配上答案的题（每条都带原因）",
  "",
  ...(unmatchedQuiz.length ? unmatchedQuiz.map((x) => `- ${x.at} —— ${x.reason}`) : ["（无）"]),
  "",
  "## 答案册里没被配走的条目（每条都带原因）",
  "",
  ...(unmatchedAns.length ? unmatchedAns.map((x) => `- ${x.at} —— ${x.reason}`) : ["（无）"]),
  "",
  "## 校验结果",
  "",
  ...(violations.length ? violations.map((s) => `- ✗ ${s}`) : ["- ✅ 保序 + 守恒 + 唯一键 全部通过"]),
  "",
  "## 配对正确性的独立证据（提示项，不进退出码）",
  "",
  `- ${tlineLine}`,
  "- 为什么这条有意义：题册的块头 T 行与答案册的答案标签**分别印在两本书上**，相互独立；",
  "  配对一旦错位，一致率会掉向对照组水平。对照组本身说明「标签分布不均匀」⇒ 不看对照组的一致率不可信。",
  "- 覆盖缺口：本卷 10 个块里只有 6 个块的块头 T 行被上游读到，故只能核验 55/83 条。",
  "",
].join("\n");
// 默认路径写 bank/report.md；`--out` 指定时写同名 .report.md（多册合并时互不覆盖）
writeFileSync(
  OUT_JSON === join(outDir, "bank.json") ? join(outDir, "report.md") : OUT_JSON.replace(/\.json$/, ".report.md"),
  report,
);

console.log(`题册 ${quiz.length} 题 / 答案册 ${ans.length} 条`);
console.log(`配对成功 ${bank.length} 条；未配对：题册 ${unmatchedQuiz.length} 题 / 答案册 ${unmatchedAns.length} 条`);
console.log(`  ${tlineLine}`);
for (const s of violations) console.log(`  ✗ ${s}`);
if (violations.length) {
  console.log("  ⇒ 校验失败（报告已落盘，供人工核对）");
  process.exit(1);
}
console.log(`  答案侧图片：源里有图 ${imgInSource} 条 ⇒ bank 带图 ${imgOnQuizSide} 条（逐条数量相等才算过）`);
console.log("  ✅ 保序 + 守恒 + 唯一键 + 图片守恒 全部通过");
console.log(`落盘 ${join(outDir, "bank.json")} 与 report.md`);
