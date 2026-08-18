/**
 * demo.ts —— 三份夹具跑全流程并打印结构化结果
 * 运行：npm run demo
 */
import { readFileSync } from "node:fs";
import { segmentFromContentList, summarize } from "../src/index.js";

const fixtures = ["math-single-choice", "math-two-column", "math-noise"];

for (const name of fixtures) {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  const r = segmentFromContentList(raw, name);
  console.log("=".repeat(72));
  console.log(summarize(r));
  for (const q of r.questions) {
    console.log("-".repeat(72));
    console.log(`[${q.status.toUpperCase()}] #${q.number} (${q.type}, conf ${q.confidence.toFixed(2)}) [${q.section}]`);
    console.log(q.stem.slice(0, 120));
    for (const opt of q.options) console.log(`   ${opt.key}. ${opt.text}`);
    for (const img of q.images) console.log(`   🖼  ${img.path}`);
    if (q.answer) console.log(`   ✔ 答案: ${q.answer.split("\n")[0]}`);
  }
}