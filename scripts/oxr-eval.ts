/**
 * oxr-eval.ts —— OXR 解析产物适配性实验（docs/oxr-evaluation.md G6）
 *
 * 把 data/oxr/oxr-as-layout.json（OXR 免费版产物转成 MinerU layout 同构形状，
 * 由 docs/oxr-evaluation.md 记录的转换规则生成）喂给现有引擎 segmentFromLayout，
 * 一行不改引擎，验证「OXR 做上游时现有管线能走多远」。
 *
 * 仅评估用，不接入 npm run check；不修改 src/。
 */
import { readFileSync } from "node:fs";
import { segmentFromLayout, summarize } from "../src/index.js";

const path = process.argv[2] ?? "data/oxr/oxr-as-layout.json";
const docId = process.argv[3] ?? "23必刷题 2相互作用(OXR)";

const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
const result = segmentFromLayout(raw, docId);
console.log(summarize(result));

const byStatus = { ok: 0, needs_review: 0 } as Record<string, number>;
for (const q of result.questions) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
console.log("status:", JSON.stringify(byStatus));

// 题号完整性（与 HANDOFF 口径对照：83 题 / 0 缺号 0 重号）
const nums = result.questions.map((q) => q.number);
const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
console.log("questions:", nums.length, "| duplicated:", [...new Set(dup)].join(",") || "无");
console.log("reviewNotes:", result.reviews.length);
// ReviewNote 的正式字段是 { questionId?, reason, blockIndex, snippet }（src/types.ts）；
// `code`/`message` 是早期实验字段，这里做兼容读取，不改引擎类型（2026-10-27 修门时补）。
for (const r of result.reviews.slice(0, 8)) {
  const legacy = r as unknown as { code?: string; message?: string };
  console.log(`  [${legacy.code ?? "?"}] ${(legacy.message ?? r.reason ?? JSON.stringify(r)).slice(0, 80)}`);
}
