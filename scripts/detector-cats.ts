// 分类：bothBad / oneBad / noneBad，并看 P3 标记覆盖哪类。
import { existsSync, readFileSync } from "node:fs";
import { normalizeLayout } from "../src/normalize.js";
import { ruleStrategy } from "../src/strategy.js";
import { similarity, type GoldDoc } from "../scripts/score.js";
import type { Question } from "../src/types.js";
const DOCS = ["教材基础练 磁场","物理_教材基础练 电路","物理_教材基础练 曲线运动","物理_教材基础练万有引力","物理_教材基础练 运动和力","物理_教材基础练机械能守恒定律"];
function qText(q: Question): string { return `${q.stem}\n${(q.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`; }
function first(a: string, b: string): string { return existsSync(a) ? a : existsSync(b) ? b : a; }
function load(p: string, id: string): Question[] { return ruleStrategy.segment(normalizeLayout(JSON.parse(readFileSync(p, "utf8")), id)).questions; }
let both = 0, one = 0, none = 0; const bothList: string[] = []; const oneList: string[] = [];
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
    const tag = `${doc.slice(0, 6)} p${gq.page + 1}#${gq.number}`;
    if (mb && ob) { both++; bothList.push(tag); } else if (mb || ob) { one++; oneList.push(`${tag} ${mb ? "MinerU坏" : "OXR坏"}`); } else none++;
  }
}
console.log(`bothBad ${both} | oneBad ${one} | noneBad ${none}`);
console.log("bothBad:", bothList.join(" ; "));
console.log("oneBad:", oneList.join(" ; "));
