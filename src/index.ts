/**
 * index.ts —— 对外出口：把「上游原料 → 结构化题目」的完整流水线
 * 收成三个函数，将来嵌入宿主应用时替换数据源实现即可。
 */
import { normalizeContentList } from "./normalize.js";
import { getStrategy, ruleStrategy } from "./strategy.js";
import type { ParsedDocument, Question, SegmentationResult } from "./types.js";

export type { ParsedDocument, Question, SegmentationResult };
export type { SegmentationStrategy } from "./strategy.js";
export { normalizeContentList, ruleStrategy };

/** 全流程：content_list JSON（任意对象）→ 结构化题目 */
export function segmentFromContentList(raw: unknown, docId: string): SegmentationResult {
  const doc = normalizeContentList(raw, docId);
  return ruleStrategy.segment(doc);
}

/** 用指定策略跑（演示扩展点） */
export function segmentWith(doc: ParsedDocument, strategyName: string): SegmentationResult {
  return getStrategy(strategyName).segment(doc);
}

/** 汇总报告：供宿主应用的质检入口用 */
export function summarize(result: SegmentationResult): string {
  const { questions, reviews, stats } = result;
  const lines = [
    `文档 ${result.docId}: 共 ${questions.length} 道题，${stats.columnsPerPage.join("/")} 栏/页`,
    `  选项组 ${stats.optionGroups} · 图片归属 ${stats.imagesAttached} · 答案匹配 ${stats.answersMatched}/${stats.questions}`,
    `  公式：独立 ${stats.formulaBlocks} 处 / 行内 ${stats.inlineFormulas} 处（人工抽检分母）`,
    `  需人工校对 ${reviews.length} 处：`,
  ];
  for (const r of reviews.slice(0, 10)) {
    lines.push(`    - [${r.questionId ?? "?"}] ${r.reason} (${r.snippet.slice(0, 30)})`);
  }
  return lines.join("\n");
}