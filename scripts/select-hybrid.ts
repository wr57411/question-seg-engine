// scripts/select-hybrid.ts —— 按书选源：OXR 文本为主，只从融合结果补缺失选项。
//
// 用法：tsx scripts/select-hybrid.ts <docId> [--base <questions.json>] [--fill <questions.json>]
// 默认：base=data/out/<docId>-OXR/questions.json，fill=data/out/<docId>/questions.json，
// 输出写回 data/out/<docId>/questions.json（原文件先备份为 questions.before-hybrid.json）。
// 只补「base 该题 options 为空」的选项；不覆盖已有文本/选项，不合并题干。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Question } from "../src/types.js";

const args = process.argv.slice(2);
const docId = args[0] ?? "";
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!docId) {
  console.error("用法：tsx scripts/select-hybrid.ts <docId> [--base <q.json>] [--fill <q.json>]");
  process.exit(2);
}
const outDir = join("data", "out", docId);
const basePath = flag("--base") ?? join("data", "out", `${docId}-OXR`, "questions.json");
const fillPath = flag("--fill") ?? join(outDir, "questions.json");
if (!existsSync(basePath) || !existsSync(fillPath)) {
  console.error(`缺 questions：\n  base ${basePath}\n  fill ${fillPath}`);
  process.exit(2);
}
const base = JSON.parse(readFileSync(basePath, "utf8")) as Question[];
const fill = JSON.parse(readFileSync(fillPath, "utf8")) as Question[];
let filled = 0;
const hybrid = base.map((q) => {
  if ((q.options?.length ?? 0) > 0) return q;
  const other = fill.find((x) => x.source.pageIndex === q.source.pageIndex && x.number === q.number);
  if (!other?.options?.length) return q;
  filled++;
  return { ...q, options: other.options };
});
const outPath = join(outDir, "questions.json");
if (existsSync(outPath)) copyFileSync(outPath, join(outDir, "questions.before-hybrid.json"));
writeFileSync(outPath, JSON.stringify(hybrid, null, 2));
writeFileSync(
  join(outDir, "hybrid.json"),
  JSON.stringify({ docId, generatedAt: new Date().toISOString(), base: basePath, fill: fillPath, filled }, null, 2),
);
console.log(`✓ hybrid ${docId}: base ${base.length} 题，补选项 ${filled} 题；输出 ${outPath}`);
