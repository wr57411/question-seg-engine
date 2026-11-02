// scripts/pair-quality.ts
/**
 * 配对质量的**独立内容尺子**：只看「题干」与「答案解析」的文本重合，不看配对键。
 *
 * ## 为什么需要它（2026-10-29，`DECISIONS §72`）
 *
 * `build-bank.ts` 的校验（保序 / 守恒 / 唯一键 / 图片守恒）全部是**结构**判据：
 * 它们能证明「两册的块序列对得上」，**不能证明「配的是同一道题」**。
 * 实测 `物理_教材基础练 曲线运动 × 高考必刷题合订本`：结构校验 4/4 全过，
 * 但题干问「xOy 平面合运动」、配到的解析在讲「曲线运动基本概念」——完全不同的题。
 *
 * 结构判据与配对实现同源（都基于 `(章, 块号, 题号)`），所以它天然发现不了这类错。
 * 本模块用**内容**做判据，与配对键零耦合。
 *
 * ## 判据
 *
 * 对每条配对算：题干的中文二元组集合里，有多大比例出现在答案解析里（containment）。
 * 取该册的**中位数**。实测（2026-10-29，29 册）：
 *   - 正确的 6 对：中位 **0.188 ~ 0.217**（P10 ≥ 0.070）
 *   - 跨书误配的 2 对：中位 **0.054 / 0.081**
 * 阈值 `PAIR_QUALITY_MIN = 0.12`，两侧都有余量。
 *
 * ⚠️ 这是**提示性判据**，不是语义正确性的证明：同一本书里也可能有一两条错配
 * （题干与解析用词差异大）。它的用途是「拦住整册级别的跨书错配」，不是逐条验收。
 *
 * 用法：`npm run audit:pair`（有绑定册低于阈值 → 退出码 1）
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** 整册中位重合低于它 ⇒ 判为「不是同一本书」 */
export const PAIR_QUALITY_MIN = 0.12;

export interface PairQuality {
  doc: string;
  n: number;
  median: number;
  p10: number;
  /** 单条重合 > 0.10 的占比（0~1） */
  fracAbove: number;
  ok: boolean;
}

/** 归一化：去公式、去标点，只留中文/字母/数字的片段 */
function segments(s: string): string[] {
  const noMath = s.replace(/\$[^$]*\$/g, " ");
  return noMath
    .replace(/[\\{}^_]/g, " ")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** 中文二元组集合（数字/字母单字噪声大，先剔除） */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const seg of segments(s)) {
    const t = seg.replace(/[A-Za-z0-9]/g, "");
    for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  }
  return out;
}

/** 单条配对的 containment：题干二元组落在答案解析里的比例 */
export function containment(stem: string, answerText: string): number {
  const a = bigrams(stem);
  if (!a.size) return Number.NaN;
  const b = bigrams(answerText);
  if (!b.size) return Number.NaN;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[i]!;
}

/**
 * 按题册聚合质量。
 * @param items bank 条目（需含 quizDoc / stem / answerText）
 */
export function pairQualityByDoc(
  items: { quizDoc?: string; stem?: string; answerText?: string }[],
): Map<string, PairQuality> {
  const acc = new Map<string, number[]>();
  for (const e of items) {
    const doc = e.quizDoc;
    if (!doc) continue;
    const c = containment(String(e.stem ?? ""), String(e.answerText ?? ""));
    if (Number.isNaN(c)) continue;
    if (!acc.has(doc)) acc.set(doc, []);
    acc.get(doc)!.push(c);
  }
  const out = new Map<string, PairQuality>();
  for (const [doc, xs] of acc) {
    const sorted = [...xs].sort((x, y) => x - y);
    const median = quantile(sorted, 0.5);
    out.set(doc, {
      doc,
      n: xs.length,
      median,
      p10: quantile(sorted, 0.1),
      fracAbove: xs.filter((x) => x > 0.1).length / xs.length,
      ok: median >= PAIR_QUALITY_MIN,
    });
  }
  return out;
}

function main(): void {
  const bankPath = join(ROOT, "data", "out", "bank", "bank.json");
  if (!existsSync(bankPath)) {
    console.error(`没有 ${bankPath} —— 先跑 npm run bank:all`);
    process.exit(2);
  }
  const items = JSON.parse(readFileSync(bankPath, "utf8")) as Parameters<typeof pairQualityByDoc>[0];
  const q = pairQualityByDoc(items);
  const rows = [...q.values()].sort((a, b) => b.median - a.median);
  console.log("题册".padEnd(32), "条数", "中位重合", "  P10", " >0.10", " 判定");
  for (const r of rows) {
    console.log(
      r.doc.padEnd(32),
      String(r.n).padStart(4),
      r.median.toFixed(3).padStart(8),
      r.p10.toFixed(3).padStart(6),
      `${(r.fracAbove * 100).toFixed(0)}%`.padStart(6),
      r.ok ? "✅" : "❌ 疑似跨书错配",
    );
  }
  const bad = rows.filter((r) => !r.ok);
  if (bad.length) {
    console.error(
      `\n❌ ${bad.length} 册中位重合低于阈值 ${PAIR_QUALITY_MIN}：${bad.map((b) => `${b.doc}(${b.median.toFixed(3)})`).join("、")}`,
    );
    console.error("   处置：从 bank-bindings.json 的 bindings 移到 excluded，并写明理由（不猜）。");
    process.exit(1);
  }
  console.log(`\n✅ 配对内容尺子通过：${rows.length} 册中位重合均 ≥ ${PAIR_QUALITY_MIN}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
