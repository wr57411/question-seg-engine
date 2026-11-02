// scripts/select-auto.ts
/**
 * **逐题自动选源**：把两源（MinerU / OXR）按题对齐，逐题决定用谁的文本，并把决定写下来。
 *
 * ## 为什么不是「按书选源」
 *
 * `DECISIONS §67` 的「按书选源」是人肉结论（曲线=OXR、运动/机械能=MinerU、磁场/电路=融合），
 * 每来一本新书就要人工跑金标重新判断 —— 这正是「未集成进 batch」的根因：
 * 批处理没法知道该选哪本。
 *
 * 逐题选源把「选哪本」换成「每题按同一套判据选」，于是可自动化、可复现、可审计。
 *
 * ## 判据（沿用 `DECISIONS §70` + `§73`，不新造口径）
 *
 * 1. 只有一源切出该题 ⇒ 用有的那源；
 * 2. 两源都在：
 *    - 结构都过关（`structOk`）且**两源互相似度 ≥ MUTUAL_MIN** ⇒ 用 **OXR**（§70：文字质量更好）；
 *    - 结构都过关但**互相似度 < MUTUAL_MIN** ⇒ **两源对「这是哪道题」有分歧**，
 *      按 §73 不猜：取 OXR 文本但标 `needs_review`，并记录 `escalate`；
 *    - 只有一源结构过关 ⇒ 用过关那源；
 *    - 都不过关 ⇒ 用 MinerU（题号/切分更保守），标 `needs_review`。
 *
 * ⚠️ 这不是「选对源」的保证：§73 已证明结构判据回答不了「这是不是同一道题」。
 * 它的价值是**把不确定性显式化**（escalate 计数进 meta），而不是悄悄选一个。
 *
 * ## 用法
 *
 * ```bash
 * tsx scripts/select-auto.ts <docId>            # 写回 data/out/<docId>/questions.json（先备份）
 * tsx scripts/select-auto.ts <docId> --dry-run  # 只报告，不写
 * ```
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { similarity } from "./score.js";
import type { Question } from "../src/types.js";

/** 两源文本低于它 ⇒ 判为「对同一题号给了不同的题」（与 §73 的 MUTUAL_MIN 同值） */
export const MUTUAL_MIN = 0.5;

export interface SelectDecision {
  pageIndex: number;
  number: string;
  /** 用了哪一源 */
  picked: "MinerU" | "OXR";
  /** 为什么 */
  reason: "only-one" | "both-clean-agree" | "both-clean-disagree" | "one-clean" | "none-clean";
  /** 需要人工介入 */
  escalate: boolean;
  /** 两源互相似度（只有一源时为 null） */
  mutual: number | null;
}

export interface SelectReport {
  docId: string;
  mineruSource: string;
  oxrSource: string;
  total: number;
  pickedOxr: number;
  pickedMineru: number;
  escalated: number;
  decisions: SelectDecision[];
}

const qText = (q: Question): string =>
  `${q.stem}\n${(q.options ?? []).map((o) => `${o.key}${o.text}`).join("\n")}`;

/** 结构判据：题干没混进题号/选项/栏目碎片，且选项键齐全 */
export function structOk(q: Question): boolean {
  const stemLines = (q.stem ?? "").split("\n").slice(1);
  const stemBad = stemLines.some((l) => {
    const t = l.trim();
    return (
      /^\d{1,3}\s*[[【「]/.test(t) ||
      /^[A-D][.、．]/.test(t) ||
      /^(教材|答案|☑|▶|变式|第\s*\d+\s*讲)/.test(t)
    );
  });
  if (stemBad) return false;
  if ((q.options ?? []).some((o) => /^\s*\d{1,3}\s*[[【「]/m.test(o.text ?? "") || /教材模型|教材素材变式|教材知识萃取|答案\s*P?\d+/.test(o.text ?? ""))) {
    return false;
  }
  const keys = (q.options ?? []).map((o) => o.key);
  return keys.length >= 3 && keys.length === new Set(keys).size;
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/** 找两源路径：OXR 固定 `-OXR`；MinerU 侧可能是主目录，也可能是 `-MinerU` */
export function resolveSources(docId: string, root = join("data", "out")): { mineru: string; oxr: string } | null {
  const oxr = join(root, `${docId}-OXR`, "questions.json");
  const mineruAlt = join(root, `${docId}-MinerU`, "questions.json");
  const mineruMain = join(root, docId, "questions.json");
  const mineru = existsSync(mineruAlt) ? mineruAlt : existsSync(mineruMain) ? mineruMain : "";
  if (!existsSync(oxr) || !mineru) return null;
  return { mineru, oxr };
}

/** 纯函数：给定两源题目，产出每题决定（不碰磁盘，便于单测） */
export function decide(mineru: Question[], oxr: Question[]): SelectDecision[] {
  const key = (q: Question) => `${q.source.pageIndex}#${q.number}`;
  const mapO = new Map<string, Question>();
  for (const q of oxr) if (!mapO.has(key(q))) mapO.set(key(q), q);
  const mapM = new Map<string, Question>();
  for (const q of mineru) if (!mapM.has(key(q))) mapM.set(key(q), q);

  const keys = [...new Set([...mapM.keys(), ...mapO.keys()])];
  const out: SelectDecision[] = [];
  for (const k of keys) {
    const m = mapM.get(k);
    const o = mapO.get(k);
    const [page, number] = k.split("#") as [string, string];
    const pageIndex = Number(page);
    if (m && !o) { out.push({ pageIndex, number, picked: "MinerU", reason: "only-one", escalate: false, mutual: null }); continue; }
    if (!m && o) { out.push({ pageIndex, number, picked: "OXR", reason: "only-one", escalate: false, mutual: null }); continue; }
    const mo = similarity(qText(m!), qText(o!));
    const okM = structOk(m!);
    const okO = structOk(o!);
    if (okM && okO) {
      if (mo >= MUTUAL_MIN) {
        out.push({ pageIndex, number, picked: "OXR", reason: "both-clean-agree", escalate: false, mutual: mo });
      } else {
        out.push({ pageIndex, number, picked: "OXR", reason: "both-clean-disagree", escalate: true, mutual: mo });
      }
      continue;
    }
    if (okO && !okM) { out.push({ pageIndex, number, picked: "OXR", reason: "one-clean", escalate: false, mutual: mo }); continue; }
    if (okM && !okO) { out.push({ pageIndex, number, picked: "MinerU", reason: "one-clean", escalate: false, mutual: mo }); continue; }
    out.push({ pageIndex, number, picked: "MinerU", reason: "none-clean", escalate: true, mutual: mo });
  }
  return out;
}

/** 纯函数：按决定合并成最终题目列表（以 OXR 顺序为主，缺的从 MinerU 补） */
export function merge(mineru: Question[], oxr: Question[], decisions: SelectDecision[]): Question[] {
  const key = (q: Question) => `${q.source.pageIndex}#${q.number}`;
  const mapM = new Map<string, Question>();
  for (const q of mineru) if (!mapM.has(key(q))) mapM.set(key(q), q);
  const mapO = new Map<string, Question>();
  for (const q of oxr) if (!mapO.has(key(q))) mapO.set(key(q), q);
  const byKey = new Map(decisions.map((d) => [`${d.pageIndex}#${d.number}`, d]));
  const ordered = [...oxr, ...mineru.filter((q) => !mapO.has(key(q)))];
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const q of ordered) {
    const k = key(q);
    if (seen.has(k)) continue;
    seen.add(k);
    const d = byKey.get(k);
    const src = d?.picked === "MinerU" ? mapM.get(k) : mapO.get(k);
    const chosen = src ?? q;
    out.push(d?.escalate ? { ...chosen, status: "needs_review" } : chosen);
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const docId = args.find((a) => !a.startsWith("--")) ?? "";
  const dryRun = args.includes("--dry-run");
  if (!docId) {
    console.error("用法：tsx scripts/select-auto.ts <docId> [--dry-run]");
    process.exit(2);
  }
  const src = resolveSources(docId);
  if (!src) {
    console.error(`缺双源 questions.json（需要 <docId>-OXR 与 <docId> 或 <docId>-MinerU 同时存在）：${docId}`);
    process.exit(2);
  }
  const mineru = readJson<Question[]>(src.mineru);
  const oxr = readJson<Question[]>(src.oxr);
  const decisions = decide(mineru, oxr);
  const merged = merge(mineru, oxr, decisions);
  const report: SelectReport = {
    docId,
    mineruSource: src.mineru,
    oxrSource: src.oxr,
    total: decisions.length,
    pickedOxr: decisions.filter((d) => d.picked === "OXR").length,
    pickedMineru: decisions.filter((d) => d.picked === "MinerU").length,
    escalated: decisions.filter((d) => d.escalate).length,
    decisions,
  };
  console.log(
    `${docId}: ${report.total} 题 → OXR ${report.pickedOxr} / MinerU ${report.pickedMineru}；` +
      `升级仲裁 ${report.escalated}（${((report.escalated / report.total) * 100).toFixed(1)}%）`,
  );
  const byReason = new Map<string, number>();
  for (const d of decisions) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${r}: ${n}`);

  if (dryRun) { console.log("（--dry-run：未写盘）"); return; }
  const outDir = join("data", "out", docId);
  const outPath = join(outDir, "questions.json");
  if (existsSync(outPath)) copyFileSync(outPath, join(outDir, "questions.before-select.json"));
  writeFileSync(outPath, JSON.stringify(merged, null, 2));
  writeFileSync(join(outDir, "select-report.json"), JSON.stringify(report, null, 1));
  console.log(`已写回 ${outPath}（原文件备份为 questions.before-select.json），决定明细见 select-report.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
