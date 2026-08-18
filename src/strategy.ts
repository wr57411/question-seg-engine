/**
 * strategy.ts —— 切分策略接口（正式接口）
 *
 * SegmentationStrategy 是唯一扩展点：规则实现（本骨架默认）之外，
 * 后续可注册 LLM 实现、或规则+LLM 混合实现，上层调用方零改动。
 * 这就是「垂直演进模型」里占位件有正式接口的体现。
 *
 * ⚠️ 所有策略在输出前必须调用 validateResult（回拼校验层）：
 * 结构化的题目文本必须在原文块中可找回，否则错误会静默入库。
 * 新策略注册时在 segment() 末尾接上校验（参考 ruleStrategy 写法）。
 */
import { segmentWithRules } from "./rule-engine.js";
import type { ParsedDocument, SegmentationResult } from "./types.js";
import { validateResult } from "./validation.js";

export interface SegmentationStrategy {
  readonly name: string;
  segment(doc: ParsedDocument): SegmentationResult;
}

/** 默认实现：双层组合规则引擎 + 回拼校验 */
export const ruleStrategy: SegmentationStrategy = {
  name: "rule-engine-v1",
  segment(doc) {
    const result = segmentWithRules(doc);
    validateResult(doc, result);
    return result;
  },
};

/** 策略注册表：将来 addStrategy("llm-v1", ...) 即可运行时切换 */
const registry = new Map<string, SegmentationStrategy>([["rule-engine-v1", ruleStrategy]]);

export function registerStrategy(s: SegmentationStrategy): void {
  registry.set(s.name, s);
}

export function getStrategy(name: string): SegmentationStrategy {
  const s = registry.get(name);
  if (!s) throw new Error(`未知切分策略: ${name}`);
  return s;
}