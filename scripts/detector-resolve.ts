// 验证：一源错的 22 题，用结构规则自动选源，能选对多少？
import { existsSync, readFileSync } from "node:fs";
import { normalizeLayout } from "../src/normalize.js";
import { ruleStrategy } from "../src/strategy.js";
import { similarity, type GoldDoc } from "../scripts/score.js";
import type { Question } from "../src/types.js";
const DOCS = ["教材基础练 磁场","物理_教材基础练 电路","物理_教材基础练 曲线运动","物理_教材基础练万有引力","物理_教材基础练 运动和力","物理_教材基础练机械能守恒定律"];
function qText(q: Question): string { return `${q.stem}\n${(q.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`; }
function stemBad(q: Question): boolean { const lines = (q.stem ?? "").split("\n").slice(1); return lines.some((l) => { const t = l.trim(); return /^\d{1,3}\s*[\[【「]/.test(t) || /^[A-D][.、．]/.test(t) || /^(教材|答案|☑|▶|变式|第\s*\d+\s*讲)/.test(t); }); }
function optionsBad(q: Question): boolean { return (q.options ?? []).some((o) => /^\s*\d{1,3}\s*[\[【「]/m.test(o.text ?? "") || /教材模型|教材素材变式|教材知识萃取|答案\s*P?\d+/.test(o.text ?? "")); }
function optionsComplete(q: Question): boolean { const k = (q.options ?? []).map((o) => o.key); return k.length >= 3 && k.length === new Set(k).size; }
function structOk(q?: Question): boolean { return !!q && !stemBad(q) && !optionsBad(q) && optionsComplete(q); }
function first(a: string, b: string): string { return existsSync(a) ? a : existsSync(b) ? b : a; }
function load(p: string, id: string): Question[] { return ruleStrategy.segment(normalizeLayout(JSON.parse(readFileSync(p, "utf8")), id)).questions; }

/**
 * **两源互不相似 ⇒ 不能靠结构裁决**（2026-10-29，`DECISIONS §73`）。
 *
 * 旧规则最后一条是「两源都过结构校验 ⇒ 选 OXR（文字质量更好）」。
 * 这条在「两源对『p3#1 是哪道题』本身就有分歧」时**等于掷硬币**：
 * 实测金标 36 题里这类只有 2 例，两例的两源相似度分别 **0.045 / 0.081**
 * （完全不同的两道题）—— 一例 OXR 对（运气），一例 OXR 错（`运动和力 p3#1`）。
 * 结构校验只问「题干干不干净、选项齐不齐」，**问不出「这是不是同一道题」**。
 * ⇒ 两源相似度低于阈值时升级到 Word/页图仲裁，不再默认选一个。
 */
const MUTUAL_MIN = 0.5;
let escalated = 0;

let oneBad = 0, resolved = 0, wrongPick = 0; const fails: string[] = [];
let bothBad = 0;
for (const doc of DOCS) {
  const gold = JSON.parse(readFileSync(`gold/${doc}.pilot.json`, "utf8")) as GoldDoc;
  const mineru = load(first(`data/out/${doc}-MinerU/layout.json`, `data/out/${doc}/layout.mineru.json`), `${doc}-MinerU`);
  const oxr = load(first(`data/out/${doc}-OXR/layout.json`, `data/out/${doc}/layout.oxr.json`), `${doc}-OXR`);
  for (const gq of gold.questions) {
    const m = mineru.find((q) => q.source.pageIndex === gq.page && q.number === gq.number);
    const o = oxr.find((q) => q.source.pageIndex === gq.page && q.number === gq.number);
    const g = `${gq.stem}\n${(gq.options ?? []).map((x) => `${x.key}${x.text}`).join("\n")}`;
    const mb = !m || similarity(g, qText(m)) < 0.8;
    const ob = !o || similarity(g, qText(o)) < 0.8;
    if (mb && ob) { bothBad++; continue; }
    if (!mb && !ob) continue;
    oneBad++;
    // 两源都在、都干净、但彼此对不上 ⇒ 结构裁决无依据，升级仲裁
    if (m && o && structOk(m) && structOk(o) && similarity(qText(m), qText(o)) < MUTUAL_MIN) {
      escalated++;
      continue;
    }
    // 结构规则选源：结构过关优先；都过关选 OXR（文字质量）；都不过选 MinerU
    const pick = structOk(m) && structOk(o) ? (o ?? m) : structOk(o) ? o : structOk(m) ? m : (m ?? o);
    const good = !pick || similarity(g, qText(pick)) >= 0.8;
    if (good) resolved++; else { wrongPick++; fails.push(`${doc} p${gq.page + 1}#${gq.number} 选了${pick === m ? "MinerU" : "OXR"}`); }
  }
}
console.log(`一源错 ${oneBad} 题：结构规则选对 ${resolved}（${(resolved / oneBad * 100).toFixed(1)}%），选错 ${wrongPick}，升级仲裁 ${escalated}`);
if (fails.length) console.log("选错明细:", fails.join(" ; "));
console.log(`双源都错 ${bothBad} 题 → 需要 Word/夸克第三源或人工`);
