// scripts/audit-feedback.ts —— 经验回流闭环（裁定台账 → 规则归纳 → 回放防退化）
//
// 定位：**只读台账、只出报告，不改规则库、不改产物**。把 AI/人落在
// `tmp/l1-defects/judgements.json` 的裁定变成下一轮的脚本规则：
//   ① 统计各类「已判/待判」与 **AI 裁定率 = 待判数 / 总命中**（越低越好：
//      规则每上线一条形态，下一轮要 AI 逐条裁定的条目就少一截）；
//   ② 对 verdict 已定的条目按「同 class + 同形态（kind）」聚类，
//      **≥3 条同形态 ⇒ 生成规则候选**（输出到 rule-candidates.md，不自动上线）；
//   ③ **回放验证**：候选规则对历史已定条目跑一遍，一致率 100% 才标「可上线」，
//      否则标「冲突待裁」并列出冲突条目（防退化）。
//
// 用法：
//   npm run audit:feedback                          # 读 tmp/l1-defects/judgements.json
//   npm run audit:feedback -- --judgements <path> --out <dir>
//
// 退出码恒 0（报告工具，不是门禁）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFECT_RULES,
  RULES_VERSION,
  type DefectRule,
  type Verdict,
} from "./defect-rules.js";

const DEFAULT_JUDGEMENTS = join("tmp", "l1-defects", "judgements.json");
const DEFAULT_OUT = join("tmp", "l1-defects");
/** 同形态多少条已定条目才提级成候选（低于此=证据不足，不提级）。 */
const DEFAULT_MIN_SUPPORT = 3;

// ──────────────────────────── 类型 ────────────────────────────

/** 裁定台账一行（audit-defects 生成；AI/人只改 verdict + basis 两栏）。 */
export interface JudgementEntry {
  class: string;
  id: string;
  doc: string;
  page?: number;
  bbox: unknown;
  text: string;
  /** 形态标签（扫描器 kind，如 `B-stray}`），规则聚类键。 */
  kind: string;
  evidence: string;
  verdict: Verdict;
  basis: string;
  ruleRef?: string;
  /** 度量类（A/G）：hits 是读数而非缺陷计数，按页级样例记行。 */
  metric?: boolean;
}

export interface JudgementsFile {
  rulesVersion: number;
  generatedAt: string;
  entries: JudgementEntry[];
}

export interface ClassStat {
  total: number;
  decided: number;
  pending: number;
}

export interface FeedbackStats {
  total: number;
  decided: number;
  pending: number;
  /** = 待判 / 总命中 */
  aiRate: number;
  perClass: Record<string, ClassStat>;
}

export interface ReplayConflict {
  id: string;
  doc: string;
  actual: Verdict;
}

export interface RuleCandidate {
  candidateId: string;
  class: string;
  /** 形态（kind 全串，聚类键）。 */
  form: string;
  verdict: Verdict;
  /** 支持该裁定的条目 id（同形态且同 verdict）。 */
  supportIds: string[];
  replayTotal: number;
  replayAgree: number;
  conflicts: ReplayConflict[];
  status: "可上线" | "冲突待裁" | "已有规则覆盖";
  coveredBy?: string;
}

// ──────────────────────────── 统计 ────────────────────────────

export function computeStats(entries: JudgementEntry[]): FeedbackStats {
  const perClass: Record<string, ClassStat> = {};
  let decided = 0;
  let pending = 0;
  for (const e of entries) {
    const c = (perClass[e.class] ??= { total: 0, decided: 0, pending: 0 });
    c.total += 1;
    if (e.verdict === "待判") {
      c.pending += 1;
      pending += 1;
    } else {
      c.decided += 1;
      decided += 1;
    }
  }
  return {
    total: entries.length,
    decided,
    pending,
    aiRate: entries.length ? pending / entries.length : 0,
    perClass,
  };
}

// ──────────────────────────── 归纳 + 回放 ────────────────────────────

function slug(s: string): string {
  const t = s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return t.slice(0, 40) || "class";
}

/**
 * 对已定条目按 class+kind 聚类：同形态 ≥ minSupport 条 ⇒ 一条候选。
 * 候选 verdict 取组内多数裁定；随后**回放**全部已定条目：
 * 命中形态但裁定不同的条目计入 conflicts。一致率 100% 才「可上线」。
 */
export function induceCandidates(
  entries: JudgementEntry[],
  opts: { minSupport?: number; existingRules?: DefectRule[] } = {},
): RuleCandidate[] {
  const minSupport = opts.minSupport ?? DEFAULT_MIN_SUPPORT;
  const existing = opts.existingRules ?? DEFECT_RULES;
  const decided = entries.filter((e) => e.verdict !== "待判");

  const groups = new Map<string, JudgementEntry[]>();
  for (const e of decided) {
    const key = `${e.class}${e.kind}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const out: RuleCandidate[] = [];
  for (const [key, group] of [...groups.entries()].sort()) {
    if (group.length < minSupport) continue;
    const klass = group[0]!.class;
    const form = group[0]!.kind;

    // 多数裁定（平票时按 verdict 名序取第一个，回放会把它标成冲突）
    const counts = new Map<Verdict, number>();
    for (const e of group) counts.set(e.verdict, (counts.get(e.verdict) ?? 0) + 1);
    const verdict = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];

    const when = (e: JudgementEntry): boolean => e.class === klass && e.kind === form;
    const supportIds = group.filter((e) => e.verdict === verdict).map((e) => e.id);
    const conflicts: ReplayConflict[] = [];
    let replayTotal = 0;
    let replayAgree = 0;
    for (const e of decided) {
      if (!when(e)) continue;
      replayTotal += 1;
      if (e.verdict === verdict) replayAgree += 1;
      else conflicts.push({ id: e.id, doc: e.doc, actual: e.verdict });
    }

    // 覆盖判定：线上规则同类、同 verdict，且形态限定比候选更宽或同级
    // （form 缺省=整类适用；否则要求候选形态包含规则的 form 串）。
    const covered = existing.find(
      (r) =>
        r.class === klass &&
        r.verdict === verdict &&
        (r.form === undefined || form.includes(r.form)),
    );
    // 冲突优先：历史里既有不同裁定，说明该形态尚未收敛，先裁冲突再谈覆盖。
    const status: RuleCandidate["status"] =
      conflicts.length > 0 ? "冲突待裁" : covered ? "已有规则覆盖" : "可上线";

    out.push({
      candidateId: `CAND-${klass}-${slug(form)}`,
      class: klass,
      form,
      verdict,
      supportIds,
      replayTotal,
      replayAgree,
      conflicts,
      status,
      ...(covered ? { coveredBy: covered.ruleId } : {}),
    });
    void key;
  }
  return out;
}

// ──────────────────────────── 渲染 ────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function renderCandidatesMarkdown(cands: RuleCandidate[], rulesVersion = RULES_VERSION): string {
  const lines: string[] = [];
  lines.push("# 规则候选（audit-feedback 归纳，**未自动上线**）");
  lines.push("");
  lines.push(`- 线上规则库版本：v${rulesVersion}`);
  lines.push(`- 候选数：${cands.length}（同 class+同形态 ≥${DEFAULT_MIN_SUPPORT} 条已定条目）`);
  lines.push("- 上线方式：人工批准 → 写入 `scripts/defect-rules.ts` 的 `DEFECT_RULES` 并 bump `RULES_VERSION`。");
  lines.push("");
  if (cands.length === 0) {
    lines.push("无候选（已定条目中没有 ≥3 条的同形态聚类）。");
    lines.push("");
  }
  for (const c of cands) {
    lines.push(`## ${c.candidateId}`);
    lines.push("");
    lines.push(`- 判据：\`class==="${c.class}" && kind==="${c.form}"\``);
    lines.push(`- verdict：${c.verdict}`);
    lines.push(`- 支持：${c.supportIds.length} 条（${c.supportIds.join(", ")}）`);
    lines.push(`- 回放：${c.replayAgree}/${c.replayTotal} 一致（${pct(c.replayTotal ? c.replayAgree / c.replayTotal : 0)}）`);
    lines.push(`- 状态：${c.status}${c.coveredBy ? `（被 ${c.coveredBy} 覆盖）` : ""}`);
    if (c.conflicts.length) {
      lines.push("- 冲突条目：");
      for (const f of c.conflicts) lines.push(`  - \`${f.id}\`（${f.doc}）实际裁定 ${f.actual}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderFeedbackReport(
  stats: FeedbackStats,
  cands: RuleCandidate[],
  meta: { judgementsPath: string; rulesVersion: number; generatedAt?: string },
): string {
  const lines: string[] = [];
  lines.push("# L1 经验回流报告（裁定台账 → 规则归纳 → 回放）");
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 裁定台账：${meta.judgementsPath}`);
  lines.push(`- 线上规则库：v${meta.rulesVersion}`);
  if (meta.generatedAt) lines.push(`- 台账生成时间：${meta.generatedAt}`);
  lines.push("");
  lines.push("## ① AI 裁定率基线");
  lines.push("");
  lines.push("**AI 裁定率 = 待判数 / 总命中**（剩余要 AI/人逐条裁定的比例；越低越好）。");
  lines.push("");
  lines.push(`- 总命中条目：${stats.total}`);
  lines.push(`- 已判：${stats.decided}`);
  lines.push(`- 待判：${stats.pending}`);
  lines.push(`- **AI 裁定率：${stats.pending}/${stats.total} = ${pct(stats.aiRate)}**`);
  lines.push("");
  lines.push("| 类别 | 总数 | 已判 | 待判 |");
  lines.push("|---|---|---|---|");
  for (const c of Object.keys(stats.perClass).sort()) {
    const s = stats.perClass[c]!;
    lines.push(`| ${c} | ${s.total} | ${s.decided} | ${s.pending} |`);
  }
  lines.push("");
  lines.push("> 口径：A/G 为度量类，hits 是读数，judgements 按「页级样例」记行（非逐条计数）；");
  lines.push("> B-stray} 等需回原卷的形态，规则刻意保持「待判」，不自动裁定。");
  lines.push("");
  lines.push("## ② 规则候选（同 class+同形态 ≥3 条）");
  lines.push("");
  if (cands.length === 0) {
    lines.push("无候选。");
  } else {
    lines.push("| 候选 | 类别 | 形态 | verdict | 支持 | 回放 | 状态 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const c of cands) {
      lines.push(
        `| ${c.candidateId} | ${c.class} | ${c.form} | ${c.verdict} | ${c.supportIds.length} | ${c.replayAgree}/${c.replayTotal} | ${c.status} |`,
      );
    }
  }
  lines.push("");
  lines.push("## ③ 回放验证（防退化）");
  lines.push("");
  for (const c of cands) {
    const rate = c.replayTotal ? c.replayAgree / c.replayTotal : 0;
    lines.push(`- ${c.candidateId}：一致率 ${pct(rate)}（${c.replayAgree}/${c.replayTotal}）⇒ ${c.status}`);
    for (const f of c.conflicts) {
      lines.push(`  - 冲突：\`${f.id}\`（${f.doc}）历史裁定 ${f.actual} ≠ 候选 ${c.verdict}`);
    }
  }
  if (cands.length === 0) lines.push("- 无候选可回放。");
  lines.push("");
  lines.push("## 下一步（人工 gate）");
  lines.push("");
  lines.push("1. 「可上线」候选经人工确认后写入 `scripts/defect-rules.ts` 并 bump `RULES_VERSION`；");
  lines.push("2. 「冲突待裁」先补裁定/查证据，再重跑本命令；");
  lines.push("3. 下一轮 `npm run audit:defects` 重新生成台账，规则命中会自动填 verdict+ruleRef，AI 裁定率应下降。");
  lines.push("");
  return lines.join("\n");
}

// ──────────────────────────── CLI ────────────────────────────

interface CliArgs {
  judgements: string;
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  let judgements = DEFAULT_JUDGEMENTS;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--judgements" && argv[i + 1]) judgements = argv[++i]!;
    else if (a === "--out" && argv[i + 1]) out = argv[++i]!;
  }
  return { judgements, out };
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  return argv1 ? fileURLToPath(import.meta.url) === argv1 : false;
}

function readJudgements(path: string): JudgementsFile | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  // 容忍裸数组（人手改过的场合）
  if (Array.isArray(raw)) return { rulesVersion: RULES_VERSION, generatedAt: "", entries: raw };
  const obj = raw as Partial<JudgementsFile>;
  if (!Array.isArray(obj.entries)) return null;
  return { rulesVersion: obj.rulesVersion ?? RULES_VERSION, generatedAt: obj.generatedAt ?? "", entries: obj.entries };
}

if (isMain()) {
  const { judgements, out } = parseArgs(process.argv.slice(2));
  const file = readJudgements(judgements);
  if (!file) {
    console.error(`经验回流：读不到裁定台账（需要 {entries:[…]}）：${judgements}`);
    process.exit(2);
  }
  const stats = computeStats(file.entries);
  const cands = induceCandidates(file.entries);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "rule-candidates.md"), renderCandidatesMarkdown(cands, file.rulesVersion), "utf8");
  writeFileSync(
    join(out, "feedback-report.md"),
    renderFeedbackReport(stats, cands, {
      judgementsPath: judgements,
      rulesVersion: file.rulesVersion,
      generatedAt: file.generatedAt || undefined,
    }),
    "utf8",
  );

  console.log(`经验回流：${file.entries.length} 条裁定（已判 ${stats.decided} / 待判 ${stats.pending}）`);
  console.log(`  AI 裁定率（待判/总命中）= ${stats.pending}/${stats.total} = ${pct(stats.aiRate)}`);
  console.log(`  规则候选 ${cands.length} 条：${cands.map((c) => `${c.candidateId}[${c.status}]`).join("、") || "无"}`);
  console.log(`  报告：${join(out, "feedback-report.md")} / ${join(out, "rule-candidates.md")}`);
  process.exit(0);
}