// scripts/arbitration-rate.ts
/**
 * **仲裁率在全量语料上的实测**（`DECISIONS §74`）。
 *
 * ## 为什么要这个脚本
 *
 * `DECISIONS §70` 的「8% 需仲裁」是在 **36 题金标**上算的（双源都错 3/36）。
 * 两个问题：
 *   1. 36 题只覆盖 6 本教材基础练，**不能代表整本**，更不能代表 23必刷题 系列；
 *   2. 「双源都错」**需要金标才能判定**，而金标只有 41 题 —— 想扩样只能靠人工重标，
 *      成本高且永远追不上语料增长。
 *
 * 本脚本换一个**不需要金标、可在全量上算**的口径：
 * 两源对「同一 (页, 题号)」给出的文本**是否一致**。
 *   - 一致（similarity ≥ MUTUAL_MIN）⇒ 无需仲裁，直接可用；
 *   - 不一致 ⇒ **升级仲裁**（这是生产上真正要付的成本）。
 * 这个口径与 `scripts/detector-resolve.ts` 里新增的升级分支**同一判据**，
 * 因此量出来的就是生产仲裁率，而不是「金标里双源都错的比例」。
 *
 * ⚠️ 口径差异要说清：本脚本量的是「**需要人工/第三源介入的比例**」，
 * 它 ≥ §70 的「双源都错比例」（因为还包含「两源切到了不同题」这类身份分歧）。
 * 两者不能互相替代，报告里必须分开写。
 *
 * 用法：`npm run audit:arbitration`（纯统计，不改数据，退出码恒 0）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeLayout } from "../src/normalize.js";
import { ruleStrategy } from "../src/strategy.js";
import { similarity } from "./score.js";
import type { Question } from "../src/types.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "data", "out");

/** 两源文本低于它 ⇒ 判为「对同一题号给了不同的题」，必须仲裁 */
const MUTUAL_MIN = 0.5;

const qText = (q: Question): string =>
  `${q.stem}\n${(q.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`;

function load(p: string, id: string): Question[] {
  return ruleStrategy.segment(normalizeLayout(JSON.parse(readFileSync(p, "utf8")), id)).questions;
}

interface Row {
  doc: string;
  /** 两源都有、且文本一致的题数 */
  agree: number;
  /** 两源都有、但文本不一致（身份分歧）⇒ 需仲裁 */
  disagree: number;
  /** 只有一源切出（另一源缺失）⇒ 也需介入 */
  onlyOne: number;
  /** 对齐键总数（agree + disagree + onlyOne） */
  total: number;
}

function main(): void {
  const names = readdirSync(OUT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(OUT, d.name, "layout.json")))
    .map((d) => d.name);

  const pairs: [string, string][] = [];
  for (const n of names) {
    if (/-OXR$|-MinerU$/i.test(n)) continue;
    for (const suf of ["-OXR", "-MinerU"]) if (names.includes(n + suf)) pairs.push([n, n + suf]);
  }
  if (!pairs.length) {
    console.error("没有找到双源成对的文档（需要 <doc> 与 <doc>-OXR/-MinerU 同时存在 layout.json）");
    process.exit(2);
  }

  const rows: Row[] = [];
  for (const [a, b] of pairs) {
    const qa = load(join(OUT, a, "layout.json"), a);
    const qb = load(join(OUT, b, "layout.json"), b);
    const key = (q: Question) => `${q.source.pageIndex}#${q.number}`;
    const mapB = new Map<string, Question>();
    for (const q of qb) if (!mapB.has(key(q))) mapB.set(key(q), q);
    const seen = new Set<string>();
    let agree = 0, disagree = 0, onlyOne = 0;
    for (const q of qa) {
      const k = key(q);
      if (seen.has(k)) continue;
      seen.add(k);
      const other = mapB.get(k);
      if (!other) { onlyOne++; continue; }
      if (similarity(qText(q), qText(other)) >= MUTUAL_MIN) agree++;
      else disagree++;
    }
    // 只有 B 侧有的键
    const seenB = new Set<string>();
    for (const q of qb) {
      const k = key(q);
      if (seen.has(k) || seenB.has(k)) continue;
      seenB.add(k);
      onlyOne++;
    }
    rows.push({ doc: a, agree, disagree, onlyOne, total: agree + disagree + onlyOne });
  }

  rows.sort((x, y) => y.total - x.total);
  const sum = rows.reduce(
    (s, r) => ({ agree: s.agree + r.agree, disagree: s.disagree + r.disagree, onlyOne: s.onlyOne + r.onlyOne, total: s.total + r.total }),
    { agree: 0, disagree: 0, onlyOne: 0, total: 0 },
  );

  console.log("题册".padEnd(30), "对齐键", " 一致", " 分歧", " 单源缺", " 需介入率");
  for (const r of rows) {
    const need = r.disagree + r.onlyOne;
    console.log(
      r.doc.padEnd(30),
      String(r.total).padStart(6),
      String(r.agree).padStart(5),
      String(r.disagree).padStart(5),
      String(r.onlyOne).padStart(6),
      `${((need / r.total) * 100).toFixed(1)}%`.padStart(9),
    );
  }
  const need = sum.disagree + sum.onlyOne;
  console.log("-".repeat(74));
  console.log(
    "合计".padEnd(30),
    String(sum.total).padStart(6),
    String(sum.agree).padStart(5),
    String(sum.disagree).padStart(5),
    String(sum.onlyOne).padStart(6),
    `${((need / sum.total) * 100).toFixed(1)}%`.padStart(9),
  );
  console.log(
    `\n全量口径：${rows.length} 册 / ${sum.total} 个对齐键；` +
      `两源一致 ${sum.agree}（${((sum.agree / sum.total) * 100).toFixed(1)}%），` +
      `身份分歧 ${sum.disagree}，单源缺失 ${sum.onlyOne}；` +
      `**需介入 ${need}（${((need / sum.total) * 100).toFixed(1)}%）**`,
  );
  console.log(`判据：两源同一 (页,题号) 的文本 similarity < ${MUTUAL_MIN} ⇒ 判为「不是同一道题」⇒ 升级仲裁。`);
}

main();
