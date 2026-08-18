/**
 * validation.ts —— 结构化输出回拼校验层（正式件）
 *
 * 评审结论（2026-08-18）：LLM 切分（以及规则切分同样存在）会丢块、错标、
 * 凭空补内容。防护手段是用「题目文本必须能在原文块中找回」约束输出——
 * 但注意不能是字面 diff：切分会剥离题号前缀、公式内联为 $...$、空白差异，
 * 因此用「归一化包含」校验（去空白 / 去 $ / 片段级子串查找）。
 *
 * 所有切分策略（规则版、未来的 LLM 版）在输出前必须调用 validateResult，
 * 失败节点进 ReviewNote 并降置信度——错误不允许静默入库。
 */
import { layoutPage } from "./layout.js";
import { REVIEW_THRESHOLD } from "./rule-engine.js";
import type { ParsedDocument, Question, ReviewNote, SegmentationResult } from "./types.js";

/** 小于该长度的片段不做回拼（单字符选项如 "0" 或 "B" 无法形成有效子串证据） */
const MIN_FRAGMENT = 2;

/** 回拼失败的单次置信度扣分（0.3：1.0-0.3=0.7 < 0.75，必然落入 needs_review） */
const PICK_FAIL_PENALTY = 0.3;

/** 归一化：删除全部空白与公式标记（$），用于宽松比对。
 * 中文文本中空格无语义（换行/span 拼接会引入差异位），直接删除。 */
export function normText(s: string): string {
  return s.replace(/\s+/g, "").replace(/\$/g, "").trim();
}

/**
 * 对结果执行回拼校验：题干每行（独立公式行跳过）与每个选项文本，
 * 必须在题目 source.blockIndexes 指向的原文块中可找回。
 * 找不到 → 追加 ReviewNote + 扣置信度 + （可能）降级 needs_review。
 */
export function validateResult(doc: ParsedDocument, result: SegmentationResult): void {
  const texts = buildBlockTextIndex(doc);
  for (const q of result.questions) {
    const haystack = normText(q.source.blockIndexes.map((i) => texts[i] ?? "").join("\n"));

    for (const lineRaw of q.stem.split("\n")) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("$$")) continue; // 独立公式行与原文 latex 形态一致，由公式抽检覆盖
      const needle = normText(line);
      if (needle.length < MIN_FRAGMENT) continue;
      if (!haystack.includes(needle)) {
        pickFail(result, q, `题干片段回拼失败：${line.slice(0, 60)}`);
      }
    }

    for (const opt of q.options) {
      const needle = normText(opt.text);
      if (needle.length < MIN_FRAGMENT) continue;
      if (!haystack.includes(needle)) {
        pickFail(result, q, `选项 ${opt.key} 回拼失败：${opt.text.slice(0, 60)}`);
      }
    }
  }
}

/** 重建「全局块序号 → 块原文」映射，顺序必须与 rule-engine 的展平方式一致 */
function buildBlockTextIndex(doc: ParsedDocument): string[] {
  const texts: string[] = [];
  for (const page of doc.pages.slice().sort((a, b) => a.index - b.index)) {
    const layout = layoutPage(page);
    for (const entry of layout.ordered) {
      texts.push(blockText(entry.block));
    }
  }
  return texts;
}

function blockText(block: { kind: string; text?: string; latex?: string }): string {
  if (block.kind === "formula") return `$$${block.latex ?? ""}$$`;
  return block.text ?? "";
}

function pickFail(result: SegmentationResult, q: Question, reason: string): void {
  const note: ReviewNote = {
    questionId: q.id,
    reason,
    blockIndex: -1,
    snippet: reason,
  };
  q.confidence = Math.max(0.2, q.confidence - PICK_FAIL_PENALTY);
  if (q.confidence < REVIEW_THRESHOLD) q.status = "needs_review";
  result.reviews.push(note);
  result.stats.reviewCount = result.reviews.length;
}