/**
 * formula.ts —— 公式噪声检测（检测机制，不做语义改写）
 *
 * 定位：MinerU 输出的行内公式普遍带 OCR/版式噪声（空格噪声 "6 0 ^ { \circ }"、
 * \mathrm/\boldsymbol 包装、\left/\right、花括号失衡）。按项目红线，
 * 引擎**不静默改写**公式内容（改错比展示丑更危险），但必须**可检测、可量化、
 * 可追踪**：本模块扫描结构化题目里的 $...$ 公式，输出按类型分桶的噪声报告，
 * 供质检页展示与自反馈环迭代（每一轮清洗规则上线，噪声计数应下降）。
 */
import type { Question } from "./types.js";

export type FormulaNoiseKind =
  | "spaced-digits" // 数字间空格："6 0 ^ { \circ }"（应为 60°）
  | "wrapper" // \mathrm/\boldsymbol/\mathbf/\text 包装
  | "left-right" // \left \right 定界符
  | "degree-spelled" // ^ { \circ } 度符号拼写（应为 °）
  | "unbalanced" // 花括号失衡
  | "long"; // 超长公式（疑似 OCR 糊成一团）

export const NOISE_KIND_LABEL: Record<FormulaNoiseKind, string> = {
  "spaced-digits": "数字间空格",
  wrapper: "字体包装命令",
  "left-right": "\\left/\\right 定界",
  "degree-spelled": "度符号拼写",
  unbalanced: "花括号失衡",
  long: "超长公式",
};

export interface FormulaNoiseItem {
  questionId: string;
  field: "stem" | "option";
  /** 原始公式（不含 $ 包裹） */
  latex: string;
  kinds: FormulaNoiseKind[];
}

export interface FormulaNoiseReport {
  /** 全部 $...$ 公式对数 */
  totalFormulas: number;
  /** 含至少一类噪声的公式数 */
  noisyFormulas: number;
  /** 受影响题目数 */
  questionsAffected: number;
  kindCounts: Record<FormulaNoiseKind, number>;
  items: FormulaNoiseItem[];
}

/** 提取文本中的 $...$ 公式段（不含定界符；不成对的尾段忽略并计入失衡外情况——由调用方按对数统计） */
export function splitFormulas(text: string): string[] {
  const out: string[] = [];
  const parts = text.split("$");
  // 成对出现：parts[1], parts[3], …
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const seg = parts[i]?.trim();
    if (seg) out.push(seg);
  }
  return out;
}

const KIND_TESTS: [FormulaNoiseKind, RegExp][] = [
  ["spaced-digits", /\d\s+\d/],
  ["wrapper", /\\(?:mathrm|boldsymbol|mathbf|text|it)\s*\{/],
  ["left-right", /\\(?:left|right)\b/],
  ["degree-spelled", /\^\s*\{\s*\\circ\s*\}/],
];

export function classifyNoise(latex: string): FormulaNoiseKind[] {
  const kinds: FormulaNoiseKind[] = [];
  for (const [kind, re] of KIND_TESTS) {
    if (re.test(latex)) kinds.push(kind);
  }
  if (latex.length > 120) kinds.push("long");
  let depth = 0;
  for (const ch of latex) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) kinds.push("unbalanced");
  return kinds;
}

/** 扫描全部题目的题干与选项，产出噪声报告（items 按 题目顺序 × 出现顺序） */
export function scanFormulaNoise(questions: Question[]): FormulaNoiseReport {
  const kindCounts = Object.fromEntries(
    (Object.keys(NOISE_KIND_LABEL) as FormulaNoiseKind[]).map((k) => [k, 0]),
  ) as Record<FormulaNoiseKind, number>;
  const items: FormulaNoiseItem[] = [];
  let totalFormulas = 0;
  let noisyFormulas = 0;
  const affected = new Set<string>();

  for (const q of questions) {
    const fields: [FormulaNoiseItem["field"], string][] = [
      ["stem", q.stem],
      ...q.options.map((o): [FormulaNoiseItem["field"], string] => ["option", o.text]),
    ];
    for (const [field, text] of fields) {
      for (const latex of splitFormulas(text)) {
        totalFormulas++;
        const kinds = classifyNoise(latex);
        if (kinds.length === 0) continue;
        noisyFormulas++;
        affected.add(q.id);
        for (const k of kinds) kindCounts[k]++;
        items.push({ questionId: q.id, field, latex, kinds });
      }
    }
  }
  return {
    totalFormulas,
    noisyFormulas,
    questionsAffected: affected.size,
    kindCounts,
    items,
  };
}
