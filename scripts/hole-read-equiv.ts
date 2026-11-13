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
const argv = process.argv.slice(2);
const arg = (k: string): string | null => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const OXR_FILE = arg("oxr") ?? "oxr-v3-filtered.json";
const OUT_FILE = arg("out") ?? "equiv-v4.json";

const rec = JSON.parse(readFileSync(join(DIR, "readings-v3.json"), "utf8")) as { id: string; recText: string | null }[];
const oxrRaw = JSON.parse(readFileSync(join(DIR, OXR_FILE), "utf8")) as unknown;
const oxr: Record<string, string> =
  (typeof oxrRaw === "object" && oxrRaw !== null && "candidates" in oxrRaw)
    ? (oxrRaw as { candidates: Record<string, string> }).candidates
    : (oxrRaw as Record<string, string>);
const iter2 = JSON.parse(readFileSync(join(DIR, "iter2-review-data.json"), "utf8")) as { id: string; stage: string }[];

const recMap = new Map(rec.map((r) => [r.id, r.recText ?? ""]));
const recScoreMap = new Map(rec.map((r) => [r.id, (r as { score?: number | null }).score ?? null]));
const stageMap = new Map(iter2.map((x) => [x.id, x.stage]));
// 采纳基线（jev best 映射）——路由规则产出新采纳，翻转处逐洞审计
const adoptedBase = JSON.parse(readFileSync(join(DIR, "adopted-v3.json"), "utf8")) as Record<string, string>;

const REC_GIVEUP = 0.01; // rec 分数近零 = rec 自弃（识别放弃/乱码），让位 OXR
/** LaTeX 括号畸形检测：花括号不配对，或括号组内无字母/数字/反斜杠（空组/纯标点组）。
 *  依据 = ⑦a 三乱码实证（p023_h3「{}」/p070_h3「201}小球」/p100_h3「a^{，}」——自信的乱码，
 *  rec 分数 0.38~0.63 不低，分数判据被数据否决）。合法读数（$v_{1}^{2}$、$\frac{q}{a^{2}}$ 等）不触发。 */
const malformed = (s: string): boolean => {
  const open = (s.match(/\{/g) ?? []).length;
  const close = (s.match(/\}/g) ?? []).length;
  if (open !== close) return true;
  const groups = s.match(/\{([^{}]*)\}/g) ?? [];
  return groups.some((g) => !/[A-Za-z0-9\\]/.test(g.slice(1, -1)));
};
const rows = [...recMap.keys()].map((id) => {
  const a = recMap.get(id) ?? "";
  const b = oxr[id] ?? "";
  const oldStage = stageMap.get(id) ?? "?";
  const rs = recScoreMap.get(id) ?? null;
  const eq = normalizeEq(a) === normalizeEq(b) && a !== "";
  let route: string;
  let adopted: string;
  if (eq) {
    route = "autoPass(归一化等价)";
    adopted = adoptedBase[id] ?? "?"; // 等价=填谁都对，采纳保持基线
  } else if (malformed(a) && b !== "" && !malformed(b)) {
    route = "adopt-oxr(rec括号畸形)";
    adopted = "oxr";
  } else {
    route = oldStage;
    adopted = adoptedBase[id] ?? "?";
  }
  return { id, rec: a, oxr: b, recScore: rs, oldStage, route, adopted, changed: route !== oldStage };
});

const changed = rows.filter((r) => r.changed);
const flips = rows.filter((r) => r.adopted !== (adoptedBase[r.id] ?? "?"));
console.log(`41 洞路由重演：等价自动过 ${rows.filter((r) => r.route.startsWith("autoPass")).length} 洞；路由变化 ${changed.length} 洞；采纳翻转 ${flips.length} 洞：`);
for (const r of flips) {
  console.log(`  ${r.id}: 采纳 ${adoptedBase[r.id]} → ${r.adopted}（recScore=${r.recScore}）`);
  console.log(`    rec="${r.rec}"`);
  console.log(`    oxr="${r.oxr}"`);
}
writeFileSync(join(DIR, OUT_FILE), JSON.stringify({ oxrSource: OXR_FILE, route: "v4: autoPass/adopt-oxr(rec自弃)/沿用", flips: flips.map((r) => r.id), rows }, null, 1));
console.log(`→ hole-read/` + OUT_FILE);
