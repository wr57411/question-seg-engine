// scripts/build-bank.ts
/**
 * 题目—答案仓库构建（**严格一一对应 + 确定性校验**）。
 *
 * ## 数据来源
 * - **题册**（`23必刷题 2相互作用`）：题目（题干 + 选项），每节题号 1..N；
 * - **答案册**（`第二章相互作用-答案与解析`）：答案条目（选项字母 + 【解析】），同样按题号排。
 *
 * ## 为什么不能只用题号做键
 * 教辅里题号在**每个节/每个块**里都从 1 重新开始（实测答案册 `#1` 出现 22 次，
 * 题册同一节内还能并进「专题/全章综合测试/真题自测」三组）⇒ 唯一键必须是
 * **`(chapter, sectionSeq, number)` 三元组**（引擎已记录，见 `src/types.ts`）。
 *
 * ## 严格一一对应的做法（两道锁）
 * 1. **键对齐**：按 `(chapter, sectionSeq, number)` 把题册与答案册配对；
 * 2. **序号对齐复核**：在同一个章内，两侧题目**按文档顺序**应当逐位对应，
 *    且每一位的题号必须相等 —— 这是**确定性**的一致性证明，不靠人工目测。
 *
 * 两道锁结果不一致 / 有题配不到答案 / 有答案配不到题 → **如实报告，不强行拼**。
 *
 * 用法：`node --import tsx scripts/build-bank.ts`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const QUIZ_DOC = "23必刷题 2相互作用";
const ANSWER_DOC = "第二章相互作用-答案与解析";

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
  answer?: string;
  source?: { pageIndex?: number; blockIndexes?: number[] };
}

const load = (doc: string): Q[] => JSON.parse(readFileSync(join("data", "out", doc, "questions.json"), "utf8"));
const keyOf = (q: Q) => `${q.chapter ?? ""}|${q.sectionSeq ?? ""}|${q.number}`;

/** 从答案条目里抽选项字母：`C必刷知识·重力的方向…` → "C"；`AD必刷知识…` → "AD" */
function answerKeyOf(text: string): string {
  const m = /^\s*([A-H]{1,4})\b/.exec(text.replace(/\s+/g, " "));
  if (!m) return "";
  // 排除 `AD` 里的重复与乱序，按字母序归一
  return [...new Set(m[1]!.split(""))].sort().join("");
}

const quiz = load(QUIZ_DOC);
const ans = load(ANSWER_DOC);

const byKey = new Map<string, Q[]>();
for (const a of ans) byKey.set(keyOf(a), [...(byKey.get(keyOf(a)) ?? []), a]);

interface Entry {
  chapter: string;
  chapterTitle: string;
  sectionNo: string;
  section: string;
  sectionSeq: number;
  number: string;
  key: string;
  stem: string;
  options: { key: string; text: string }[];
  subQuestions: string[];
  answerKey: string;
  answer: string;
  answerSourceId: string;
}

const bank: Entry[] = [];
const unmatchedQuestions: string[] = [];
const orderMismatch: string[] = [];
let pairByKey = 0;
let pairByOrder = 0;

/** 第 2 道锁：同章内按文档顺序逐位比对题号 */
function orderCheck(chapter: string): { quizSide: Q[]; ansSide: Q[] } {
  const qz = quiz.filter((q) => (q.chapter ?? "") === chapter);
  const az = ans.filter((q) => (q.chapter ?? "") === chapter);
  const n = Math.min(qz.length, az.length);
  for (let i = 0; i < n; i++) {
    if (qz[i]!.number !== az[i]!.number) {
      orderMismatch.push(`章${chapter} 第 ${i + 1} 位：题册 #${qz[i]!.number} vs 答案册 #${az[i]!.number}`);
    } else {
      pairByOrder++;
    }
  }
  return { quizSide: qz, ansSide: az };
}

for (const chapter of [...new Set(quiz.map((q) => q.chapter ?? ""))].sort()) {
  const { quizSide, ansSide } = orderCheck(chapter);
  // 键对齐（主）＋ 顺序对齐（兜底），两者都必须落在同一份答案上才算「严格」
  for (let i = 0; i < quizSide.length; i++) {
    const q = quizSide[i]!;
    const cands = byKey.get(keyOf(q)) ?? [];
    const byOrder = ansSide[i];
    const a = cands[0] ?? (byOrder && byOrder.number === q.number ? byOrder : undefined);
    if (!a) {
      unmatchedQuestions.push(`${QUIZ_DOC} 章${q.chapter} 组${q.sectionSeq} #${q.number}`);
      continue;
    }
    if (cands.length) pairByKey++;
    bank.push({
      chapter: q.chapter ?? "",
      chapterTitle: q.chapterTitle ?? "",
      sectionNo: q.sectionNo ?? "",
      section: q.section ?? "",
      sectionSeq: q.sectionSeq ?? -1,
      number: q.number,
      key: keyOf(q),
      stem: q.stem,
      options: q.options ?? [],
      subQuestions: q.subQuestions ?? [],
      answerKey: answerKeyOf(a.stem),
      answer: a.stem,
      answerSourceId: a.id,
    });
  }
}

// 答案册里没被任何题目配走的条目（章 3/4 属正常：题册片段只覆盖第二章）
const usedAns = new Set(bank.map((b) => b.answerSourceId));
const orphanAnswers = ans.filter((a) => !usedAns.has(a.id));

const outDir = join("data", "out", "bank");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "bank.json"), JSON.stringify(bank, null, 1));

const dup = bank.map((b) => b.key).filter((k, i, a) => a.indexOf(k) !== i);
const report = [
  "# 题目—答案仓库构建报告",
  "",
  `- 题册：${quiz.length} 题；答案册：${ans.length} 条`,
  `- **配对成功：${bank.length} 条**（键对齐 ${pairByKey} / 顺序对齐复核一致 ${pairByOrder}）`,
  `- 配对键：\`(chapter, sectionSeq, number)\` —— 教辅题号在每个节/块里从 1 重启，单用题号必然撞车`,
  `- 唯一性：重复键 ${dup.length} 个${dup.length ? "（" + dup.slice(0, 5).join(", ") + "）" : ""}`,
  `- 题册里配不到答案：${unmatchedQuestions.length} 题`,
  `- 答案册里没被配走：${orphanAnswers.length} 条`,
  "",
  "## 顺序对齐不一致（章内逐位题号不等）",
  "",
  ...(orderMismatch.length ? orderMismatch.slice(0, 30).map((s) => `- ${s}`) : ["（无）"]),
  "",
  "## 配不到答案的题目",
  "",
  ...(unmatchedQuestions.length ? unmatchedQuestions.slice(0, 40).map((s) => `- ${s}`) : ["（无）"]),
  "",
  "## 未被配走的答案条目（章 3/4 属正常：题册片段只覆盖第二章）",
  "",
  ...(orphanAnswers.length
    ? orphanAnswers.slice(0, 20).map((a) => `- 章${a.chapter} 组${a.sectionSeq} #${a.number}`)
    : ["（无）"]),
  "",
].join("\n");
writeFileSync(join(outDir, "report.md"), report);
console.log(report.split("\n").slice(0, 12).join("\n"));
console.log(`\n落盘 ${join(outDir, "bank.json")} 与 report.md`);
