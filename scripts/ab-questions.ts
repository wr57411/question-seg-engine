// scripts/ab-questions.ts
/**
 * **切题指纹**：对 `data/out/` 下每册主产物算 `题数 + (章|组|题号) 序列哈希`，
 * 用于「改动前后逐册比对」——任何一行差异都说明切题行为变了。
 *
 * ## 为什么需要它（`DECISIONS §76` / `§77`）
 *
 * 凡动切题输入或判据的改动，都必须回答「有没有把别的地方改坏」。人工逐册看题数不够：
 * 题数不变但**题号序列**变了同样是回归（配对键会错位）。本脚本把两者压成一个指纹。
 *
 * 用法：
 * ```bash
 * npm run audit:ab > tmp/ab-after.txt          # 改动后
 * git stash push -u -- src/ && npm run audit:ab > tmp/ab-before.txt && git stash pop
 * diff tmp/ab-before.txt tmp/ab-after.txt      # 必须逐字节一致（或差异逐条解释）
 * ```
 *
 * ⚠️ 只读 `layout.json`（不走 OCR / 融合 / 选源），所以它衡量的是**引擎行为**，
 * 不含产物链的其它步骤 —— 这正是我们要隔离的变量。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { segmentFromLayout } from "../src/index.js";

const ROOT = "data/out";
const rows: string[] = [];
for (const d of readdirSync(ROOT).sort()) {
  if (/-OXR$|-MinerU$/i.test(d)) continue;
  const p = `${ROOT}/${d}/layout.json`;
  if (!existsSync(p)) continue;
  try {
    const res = segmentFromLayout(JSON.parse(readFileSync(p, "utf8")), d);
    const seq = res.questions.map((q) => `${q.chapter}|${q.sectionSeq}|${q.number}`).join(",");
    rows.push(`${d}\t${res.questions.length}\t${createHash("sha256").update(seq).digest("hex").slice(0, 16)}`);
  } catch (e) {
    rows.push(`${d}\tERR\t${(e as Error).message.slice(0, 40)}`);
  }
}
console.log(rows.join("\n"));
