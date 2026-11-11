// scripts/hole-read-equiv.ts
/**
 * 问题④ 核验工具：等价性归一化（normalizeEq）下的路由重演。
 * 数据源（均已在仓库内）：
 *   hole-read/readings-v3.json   41 洞 rec v3 读数（id/recText）
 *   hole-read/oxr-v3-filtered.json 41 洞 OXR 洞带过滤后候选（id → 文本）
 *   hole-read/iter2-review-data.json 41 洞旧路由（stage: jev=快扫 / human=人工三方裁决）
 * 规则（用户拍板「一致即过」）：normalizeEq(rec) === normalizeEq(oxr) → autoPass；
 * 其余保持旧路由不动（本工具只演示归一化带来的路由**增量变化**，不重演 jev/人工判定）。
 * 用法：npx tsx scripts/hole-read-equiv.ts   （只读，写 hole-read/equiv-v4.json）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeEq } from "./ocr-lib.js";

const DIR = join(process.cwd(), "data/out", "答案册-合订本", "hole-read");

const rec = JSON.parse(readFileSync(join(DIR, "readings-v3.json"), "utf8")) as { id: string; recText: string | null }[];
const oxr = JSON.parse(readFileSync(join(DIR, "oxr-v3-filtered.json"), "utf8")) as Record<string, string>;
const iter2 = JSON.parse(readFileSync(join(DIR, "iter2-review-data.json"), "utf8")) as { id: string; stage: string }[];

const recMap = new Map(rec.map((r) => [r.id, r.recText ?? ""]));
const stageMap = new Map(iter2.map((x) => [x.id, x.stage]));

const rows = [...recMap.keys()].map((id) => {
  const a = recMap.get(id) ?? "";
  const b = oxr[id] ?? "";
  const oldStage = stageMap.get(id) ?? "?";
  const eq = normalizeEq(a) === normalizeEq(b) && a !== "";
  const newStage = eq ? "autoPass(归一化等价)" : oldStage;
  return { id, rec: a, oxr: b, oldStage, newStage, changed: newStage !== oldStage };
});

const changed = rows.filter((r) => r.changed);
console.log(`41 洞路由重演：等价自动过 ${rows.filter((r) => r.newStage.startsWith("autoPass")).length} 洞；路由变化 ${changed.length} 洞：`);
for (const r of changed) {
  console.log(`  ${r.id}: ${r.oldStage} → ${r.newStage}`);
  console.log(`    rec="${r.rec}"`);
  console.log(`    oxr="${r.oxr}"`);
}
writeFileSync(join(DIR, "equiv-v4.json"), JSON.stringify({ rows, changed: changed.map((r) => r.id) }, null, 1));
console.log(`→ hole-read/equiv-v4.json`);
