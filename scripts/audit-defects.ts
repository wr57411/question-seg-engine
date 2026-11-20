// scripts/audit-defects.ts —— L1 聚合缺陷扫描器（《换源缺陷补偿手册》§1 落地）
//
// 定位：**只检测、不改写**（红线）。把手册 §1 的七类缺陷聚合成一条命令，逐类给
// {class, hits, samples[≤5], suggestedAttribution, evidencePath}，供人工按手册 §2 选点处置。
// 判据**全部复用已有模块**，本文件不自写几何/结构判据（B-35：禁自写重算几何判据）：
//   A 行框几何漂移   → 读 stages.json 的 inkCoverage（audit-render 的读数；缺则标前置）
//   B 文本残留       → 复用 oxr-convert 的 detectOxrTextResidue（\smiles / blank 噪声）+ stray `}` 形态
//   C 题号/结构      → 复用 patterns.matchUnnumberedQuestionLine / matchLabelFragmentQuestionLine
//                       （即 tmp/t2-structure2/scan-badge.ts 的转正版）
//   D 跨页泄漏       → 复用 src/normalize 的跨页泄漏判据（crossPageLeaks 记录）
//   E 标题/补识缺失  → 复用 scripts/oxr-title-guard 的 detectTitleGaps（+ 已有 title-guard.json 产物）
//   F 修正层过期     → 复用 src/corrections 的 applyCorrections 干跑（missed 统计，不改写）
//   G 口径/基线漂移  → meta.json 数字与 scripts/*-baseline.json 的差（只报数，不判）
//
// 退出码语义（自定，写清）：默认**恒 0**——本命令是报告工具、不是门禁，命中是「待人工处置」
// 而不是失败；`--fail-on-hit` 时 B–F 任一类命中即 exit 1（A/G 为度量类，恒可能 >0，不计）。
// 检测门不改写：本文件只读 data/out、corrections、scripts 基线，只写 --out 目录。
//
// 用法：
//   npm run audit:defects                          # 全部生产册 → tmp/l1-defects/{report.md,result.json}
//   npm run audit-defects -- --doc "<docId>"       # 指定册（可重复）
//   npm run audit-defects -- --all                 # 显式全部
//   npm run audit-defects -- --root <dir> --out <dir> [--fail-on-hit]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyCorrections, type CorrectionFile } from "../src/corrections.js";
import { normalizeLayout } from "../src/normalize.js";
import {
  matchFirstLine,
  matchLabelFragmentQuestionLine,
  matchUnnumberedQuestionLine,
} from "../src/patterns.js";
import { detectOxrTextResidue } from "./oxr-convert.js";
import {
  detectTitleGaps as runTitleGuard,
  readV3Dir,
  type TitleGuardEntry,
} from "./oxr-title-guard.js";

// ──────────────────────────── 常量 ────────────────────────────

const DEFAULT_ROOT = join("data", "out");
const DEFAULT_OUT = join("tmp", "l1-defects");
/** 非生产文档目录 / 同书另一种解析副本：不重复报（与 audit-numbering:cross 同口径）。 */
const SKIP_EXACT = new Set(["bank", "tags", "_tablecheck", "teach", "topics"]);
const SKIP_SUFFIX = /-(?:OXR|MinerU)$/;
/** 墨迹内容级基线（DECISIONS §115，OXR 期 7 基线卷实测最大值 378 + 容忍 5）。 */
const INK_CONTENT_BASELINE = 378;
const INK_CONTENT_TOLERANCE = 5;
/** 基线卷（与 scripts/audit-render-all.mjs 的 BASELINE_DOCS 同名单）。 */
const INK_BASELINE_DOCS = [
  "23必刷题 1 直线运动",
  "23必刷题 2相互作用",
  "23必刷题 3 运动和力的关系",
  "23必刷题 4 曲线运动",
  "动量守恒定律23必刷题",
  "机械能23必刷题",
  "第二章相互作用-答案与解析",
];

// ──────────────────────────── 类型 ────────────────────────────

export type DefectClass = "A" | "B" | "C" | "D" | "E" | "F" | "G";
export type Attribution = "真丢" | "伪影" | "口径" | "误报" | "待判";

export interface DefectSample {
  doc: string;
  /** 1 基物理页号（未知时省略） */
  page?: number;
  kind: string;
  detail: string;
  /** 排序权重（A 类按内容级条数降序取样例） */
  weight?: number;
}

export interface ClassReport {
  class: DefectClass;
  name: string;
  hits: number;
  docs: number;
  suggestedAttribution: Attribution;
  evidencePath: string;
  samples: DefectSample[];
  note: string;
  /** 一行读数摘要（报告用；全量读数见 result.json 的 ledger） */
  summary: string;
  /** 度量类（A/G）：hits 是读数而非缺陷计数，不参与 --fail-on-hit */
  metric?: boolean;
  ledger?: Record<string, unknown>;
  needsPrerequisite?: string;
}

export interface DocReport {
  doc: string;
  hits: Record<DefectClass, number>;
  total: number;
  prerequisites: string[];
}

export interface KnownFact {
  label: string;
  expected: string;
  actual: string;
  consistent: boolean;
  source: string;
}

export interface ScanReport {
  generatedAt: string;
  root: string;
  docs: string[];
  /** 是否全量生产册扫描（决定「已知事实对照」是否适用） */
  fullScan: boolean;
  classes: ClassReport[];
  perDoc: DocReport[];
  knownFacts: KnownFact[];
  exitCodeSemantics: string;
}

export interface Baselines {
  anchor: { doc: string; engineCount?: number }[];
  numberingCross: { doc: string }[];
  suspicious: { doc: string }[];
  numbering: { doc: string }[];
}

interface DocScan {
  doc: string;
  hits: Record<DefectClass, number>;
  samples: Record<DefectClass, DefectSample[]>;
  ledgers: Record<DefectClass, Record<string, unknown>>;
  prerequisites: string[];
}

interface TitleGuardArtifact {
  entries: TitleGuardEntry[];
  stats: { pages: number; candidates: number; curated: number; curatedSkipped: number };
}

// ──────────────────────────── 小工具 ────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function countChar(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

// ──────────────────────────── 检测器（纯函数，可单测） ────────────────────────────

/** 生产 layout 的原始行（para_blocks → lines → spans），保留行形态供残留检测。 */
export function rawLayoutLines(layoutRaw: unknown): { page: number; text: string }[] {
  const root = asRecord(layoutRaw);
  const out: { page: number; text: string }[] = [];
  const pages = asArray(root.pdf_info);
  for (let i = 0; i < pages.length; i++) {
    const rec = asRecord(pages[i]);
    for (const pbRaw of asArray(rec.para_blocks)) {
      const pb = asRecord(pbRaw);
      for (const lnRaw of asArray(pb.lines)) {
        const parts: string[] = [];
        for (const spRaw of asArray(asRecord(lnRaw).spans)) {
          const sp = asRecord(spRaw);
          const c = sp.content ?? sp.text ?? "";
          if (c) parts.push(String(c));
        }
        if (parts.length) out.push({ page: i + 1, text: parts.join("") });
      }
    }
  }
  return out;
}

/**
 * C 题号/结构：行首出处标注的**无题号真题块**（C1）+ 标签折行残片（C2）。
 * 判据复用 `matchUnnumberedQuestionLine` / `matchLabelFragmentQuestionLine`（B-56/B-50③）。
 * 注：layout 是上游原始输入，引擎已按反推恢复（questions.json 含真题），但输入仍无题号。
 */
export function detectStructureHits(layoutRaw: unknown, docId: string): DefectSample[] {
  const doc = normalizeLayout(layoutRaw, docId);
  const out: DefectSample[] = [];
  for (const p of doc.pages) {
    let prevLine: string | null = null;
    for (const b of p.blocks) {
      if (b.kind !== "text") {
        prevLine = null;
        continue;
      }
      const fl = (b.firstLine ?? b.text ?? "").trimStart();
      if (!fl) continue;
      if (matchFirstLine(fl).ok) {
        prevLine = fl;
        continue;
      }
      if (matchUnnumberedQuestionLine(fl)) {
        out.push({ doc: docId, page: p.index + 1, kind: "C1-无题号真题块", detail: fl.slice(0, 50) });
      } else if (matchLabelFragmentQuestionLine(fl, prevLine)) {
        out.push({ doc: docId, page: p.index + 1, kind: "C2-标签折行残片", detail: fl.slice(0, 50) });
      }
      prevLine = fl;
    }
  }
  return out;
}

/**
 * B 文本残留：stray `}`（行首 `}` 或行尾 unbalanced `}`）/ `\smiles` 伪包装 / blank 噪声。
 * `\smiles`、blank 判据复用转换层 `detectOxrTextResidue`；stray `}` 是形态候选（折行切裂括号），
 * 需回原卷逐条判（手册 §1：原卷有⇒真缺陷，原卷无⇒旧源泄漏）。
 */
export function detectTextResidue(layoutRaw: unknown, docId: string): DefectSample[] {
  const out: DefectSample[] = [];
  for (const { page, text } of rawLayoutLines(layoutRaw)) {
    for (const raw of text.split("\n")) {
      const t = raw.trim();
      if (!t) continue;
      const residue = detectOxrTextResidue(t);
      const kinds: string[] = [];
      if (residue.smiles) kinds.push("smiles");
      if (residue.blankNoise) kinds.push("blankNoise");
      if (t.startsWith("}") || (t.endsWith("}") && countChar(t, "}") > countChar(t, "{"))) {
        kinds.push("stray}");
      }
      if (kinds.length) out.push({ doc: docId, page, kind: `B-${kinds.join("+")}`, detail: t.slice(0, 50) });
    }
  }
  return out;
}

/**
 * D 跨页泄漏：直接复用 `normalizeLayout` 的跨页泄漏判据与记录（B-47）。
 * OXR layout 无 `preproc_blocks` ⇒ 判据整体跳过 ⇒ 生产 OXR 册恒 0（逐字节保）。
 */
export function detectCrossPageLeaks(layoutRaw: unknown, docId: string): DefectSample[] {
  const doc = normalizeLayout(layoutRaw, docId);
  return (doc.crossPageLeaks ?? []).map((r) => ({
    doc: docId,
    page: r.fromPageIndex + 1,
    kind: `D-${r.action}`,
    detail: `${(r.text ?? "").slice(0, 40)} → p${r.toPageIndex + 1}`,
  }));
}

/**
 * E 标题/补识缺失：优先读 `title-guard.json` 产物（guard + curated 统计）；
 * 无产物时用 V3 缓存**即时算守卫**（`detectTitleGaps`，不含 curated——curated 清单是答案册专用，
 * 泛化到别的册会误插，见 oxr-title-guard 注释）。无 V3 缓存则标前置。
 */
export function detectTitleGapHits(
  layoutRaw: unknown,
  docId: string,
  opts: { artifact?: TitleGuardArtifact | null; v3Dir?: string | null },
): { samples: DefectSample[]; hits: number; ledger: Record<string, unknown>; needsPrerequisite?: string } {
  if (opts.artifact) {
    const entries = opts.artifact.entries;
    const guard = entries.filter((e) => e.origin === "guard");
    return {
      samples: guard.slice(0, 5).map((e) => ({
        doc: docId,
        page: e.page,
        kind: `E-${e.category}`,
        detail: e.text.slice(0, 40),
      })),
      hits: guard.length,
      ledger: {
        ...opts.artifact.stats,
        guardHits: guard.length,
        curatedHits: entries.length - guard.length,
        source: "artifact",
      },
    };
  }
  const v3Dir = opts.v3Dir;
  if (!v3Dir || !existsSync(v3Dir)) {
    return {
      samples: [],
      hits: 0,
      ledger: { missing: true },
      needsPrerequisite: "需先跑 oxr-title-guard（无 V3 缓存）",
    };
  }
  const v3 = readV3Dir(v3Dir);
  if (v3.length === 0) {
    return {
      samples: [],
      hits: 0,
      ledger: { missing: true },
      needsPrerequisite: "需先跑 oxr-title-guard（V3 缓存为空）",
    };
  }
  const r = runTitleGuard(layoutRaw, v3);
  return {
    samples: r.entries.slice(0, 5).map((e) => ({
      doc: docId,
      page: e.page,
      kind: `E-${e.category}`,
      detail: e.text.slice(0, 40),
    })),
    hits: r.entries.length,
    ledger: {
      ...r.stats,
      guardHits: r.entries.length,
      curatedHits: 0,
      source: "computed-guard-only",
    },
  };
}

/**
 * F 修正层过期：`applyCorrections` **干跑**（内存副本，不落盘、不改写产物），统计 missed。
 * missed>0 ⇒ 清单条目在新源骨架里找不到 ⇒ 需退休或更新（手册 §1-F）。
 */
export function detectCorrectionMissed(
  layoutRaw: unknown,
  docId: string,
  corrections: CorrectionFile | null,
): { samples: DefectSample[]; ledger: Record<string, unknown> } {
  if (!corrections || corrections.items.length === 0) {
    return { samples: [], ledger: { applicable: false, items: corrections?.items.length ?? 0 } };
  }
  const doc = normalizeLayout(layoutRaw, docId);
  const report = applyCorrections(doc, corrections);
  const samples = report.missed.map((idx) => {
    const it = corrections.items[idx];
    const what = it?.blockText ?? it?.text ?? "";
    return {
      doc: docId,
      page: it?.page,
      kind: `F-missed#${idx}`,
      detail: `${it?.kind} ${what.slice(0, 40)}`,
    };
  });
  return {
    samples,
    ledger: {
      items: corrections.items.length,
      missed: report.missed.length,
      applied: report.replace + report.replaceText + report.split + report.insert,
      unverified: report.unverified.length,
      disabled: report.disabled.length,
    },
  };
}

/**
 * A 行框几何漂移：读 `stages.json` 的 `inkCoverage`（audit-render 的读数，不重算几何）。
 * hits = 内容级未覆盖条数（度量）；`overBaseline` 标记越界（基线 378 + 容忍 5）。
 */
export function detectGeometry(
  stages: unknown,
  docId: string,
): {
  samples: DefectSample[];
  hits: number;
  ledger: Record<string, unknown>;
  needsPrerequisite?: string;
} {
  const ic = asRecord(asRecord(stages).inkCoverage);
  if (Object.keys(ic).length === 0) {
    return {
      samples: [],
      hits: 0,
      ledger: { missing: true },
      needsPrerequisite: "需 audit-render 先跑（stages.json 无 inkCoverage）",
    };
  }
  const contentCount = Number(ic.contentCount ?? 0);
  const over = contentCount > INK_CONTENT_BASELINE + INK_CONTENT_TOLERANCE;
  const top = asArray(ic.pages)
    .map((p, i) => ({ page: i + 1, contentCount: Number(asRecord(p).contentCount ?? 0) }))
    .filter((p) => p.contentCount > 0)
    .sort((a, b) => b.contentCount - a.contentCount)
    .slice(0, 5)
    .map((p) => ({
      doc: docId,
      page: p.page,
      kind: over ? "A-内容级未覆盖(超基线)" : "A-内容级未覆盖",
      detail: `内容级 ${p.contentCount} 条`,
      weight: p.contentCount,
    }));
  return {
    samples: top,
    hits: contentCount,
    ledger: {
      contentCount,
      furnitureCount: Number(ic.furnitureCount ?? 0),
      ratio: ic.ratio,
      baseline: INK_CONTENT_BASELINE,
      tolerance: INK_CONTENT_TOLERANCE,
      overBaseline: over,
    },
  };
}

/**
 * G 口径/基线漂移：meta 数字与登记基线的差（**只报数，不判**）。
 * hits = 非零差分个数（度量类，不参与 --fail-on-hit）。
 */
export function detectBaselineDrift(
  meta: unknown,
  docId: string,
  baselines: Baselines,
): { samples: DefectSample[]; hits: number; ledger: Record<string, unknown> } {
  const stats = asRecord(asRecord(meta).stats);
  const metrics: { name: string; value: number; baseline: number; delta: number }[] = [];
  const anchor = baselines.anchor.filter((e) => e.doc === docId);
  if (anchor.length) {
    const engine = anchor.reduce((a, e) => a + (e.engineCount ?? 0), 0);
    const q = Number(stats.questions ?? 0);
    metrics.push({ name: "questions vs anchorEngine", value: q, baseline: engine, delta: q - engine });
  }
  const cross = baselines.numberingCross.filter((e) => e.doc === docId).length;
  metrics.push({ name: "numberingCrossBaselineEntries", value: cross, baseline: 0, delta: cross });
  const suspicious = baselines.suspicious.filter((e) => e.doc === docId).length;
  metrics.push({ name: "suspiciousBaselineEntries", value: suspicious, baseline: 0, delta: suspicious });
  const numbering = baselines.numbering.filter((e) => e.doc === docId).length;
  metrics.push({ name: "numberingBaselineEntries", value: numbering, baseline: 0, delta: numbering });

  const samples = metrics
    .filter((m) => m.delta !== 0)
    .slice(0, 5)
    .map((m) => ({
      doc: docId,
      kind: "G-口径",
      detail: `${m.name}: ${m.value} vs 基线 ${m.baseline}（Δ${m.delta > 0 ? "+" : ""}${m.delta}）`,
    }));
  return { samples, hits: samples.length, ledger: { metrics } };
}

// ──────────────────────────── 聚合 ────────────────────────────

export function listProductionDocs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .filter((name) => !SKIP_EXACT.has(name) && !SKIP_SUFFIX.test(name))
    .filter((name) => existsSync(join(root, name, "layout.json")));
}

function emptyDocScan(doc: string): DocScan {
  const classes: DefectClass[] = ["A", "B", "C", "D", "E", "F", "G"];
  const hits = {} as Record<DefectClass, number>;
  const samples = {} as Record<DefectClass, DefectSample[]>;
  const ledgers = {} as Record<DefectClass, Record<string, unknown>>;
  for (const c of classes) {
    hits[c] = 0;
    samples[c] = [];
    ledgers[c] = {};
  }
  return { doc, hits, samples, ledgers, prerequisites: [] };
}

function scanDoc(docId: string, root: string, baselines: Baselines): DocScan {
  const dir = join(root, docId);
  const layout = readJson<unknown>(join(dir, "layout.json"));
  const scan = emptyDocScan(docId);
  if (!layout) {
    scan.prerequisites.push("缺 layout.json");
    return scan;
  }

  // A
  const stages = readJson<unknown>(join(dir, "stages.json"));
  const geo = detectGeometry(stages ?? {}, docId);
  scan.samples.A = geo.samples;
  scan.hits.A = geo.hits;
  scan.ledgers.A = geo.ledger;
  if (geo.needsPrerequisite) scan.prerequisites.push(`A: ${geo.needsPrerequisite}`);

  // B
  scan.samples.B = detectTextResidue(layout, docId);
  scan.hits.B = scan.samples.B.length;
  const cleanup = readJson<{ smilesUnwrapped?: unknown[]; blankDropped?: unknown[] }>(
    join(dir, "oxr-text-cleanup.json"),
  );
  scan.ledgers.B = {
    cleanupSmilesUnwrapped: cleanup?.smilesUnwrapped?.length ?? 0,
    cleanupBlankDropped: cleanup?.blankDropped?.length ?? 0,
  };

  // C
  scan.samples.C = detectStructureHits(layout, docId);
  scan.hits.C = scan.samples.C.length;
  scan.ledgers.C = {
    C1: scan.samples.C.filter((s) => s.kind.startsWith("C1")).length,
    C2: scan.samples.C.filter((s) => s.kind.startsWith("C2")).length,
  };

  // D
  scan.samples.D = detectCrossPageLeaks(layout, docId);
  scan.hits.D = scan.samples.D.length;
  scan.ledgers.D = { records: scan.samples.D.length, note: "OXR 无 preproc_blocks ⇒ 判据整体跳过" };

  // E
  const artifact = readJson<TitleGuardArtifact>(join(dir, "title-guard.json"));
  const title = detectTitleGapHits(layout, docId, {
    artifact,
    v3Dir: join(dir, "ocr-jobs-cache-localv3"),
  });
  scan.samples.E = title.samples;
  scan.hits.E = title.hits;
  scan.ledgers.E = title.ledger;
  if (title.needsPrerequisite) scan.prerequisites.push(`E: ${title.needsPrerequisite}`);

  // F
  const corrections = readJson<CorrectionFile>(join("corrections", `${docId}.json`));
  const corr = detectCorrectionMissed(layout, docId, corrections);
  scan.samples.F = corr.samples;
  scan.hits.F = corr.samples.length;
  scan.ledgers.F = corr.ledger;

  // G
  const meta = readJson<unknown>(join(dir, "meta.json"));
  const drift = detectBaselineDrift(meta ?? {}, docId, baselines);
  scan.samples.G = drift.samples;
  scan.hits.G = drift.hits;
  scan.ledgers.G = drift.ledger;

  return scan;
}

const CLASS_META: Record<
  DefectClass,
  { name: string; suggestedAttribution: Attribution; evidencePath: string; note: string; metric?: boolean }
> = {
  A: {
    name: "A 行框几何漂移",
    suggestedAttribution: "口径",
    evidencePath: "data/out/<doc>/stages.json#inkCoverage",
    note: "OXR 合成行框与墨迹系统性错位；基线 378+5（DECISIONS §115）。只读读数，不改框。",
    metric: true,
  },
  B: {
    name: "B 文本残留",
    suggestedAttribution: "伪影",
    evidencePath: "data/out/<doc>/layout.json + oxr-text-cleanup.json",
    note: "stray `}` / `\\smiles` / blank 误判；转换层已清洗留痕，layout 原始输入仍含残留形态。",
  },
  C: {
    name: "C 题号/结构",
    suggestedAttribution: "真丢",
    evidencePath: "data/out/<doc>/layout.json（matchUnnumberedQuestionLine）",
    note: "行首出处标注无题号块 / 标签折行残片；引擎已按 B-56 反推恢复，layout 原始输入仍无题号。",
  },
  D: {
    name: "D 跨页泄漏",
    suggestedAttribution: "伪影",
    evidencePath: "data/out/<doc>/layout.json（normalize.crossPageLeaks）",
    note: "OXR 无 preproc_blocks ⇒ 判据整体跳过（逐字节保）；MinerU 形态才可能命中。",
  },
  E: {
    name: "E 标题/补识缺失",
    suggestedAttribution: "真丢",
    evidencePath: "data/out/<doc>/title-guard.json（V3 守卫 + curated 补识）",
    note: "答案册已有产物；其余册由扫描器即时算守卫（curated 清单是答案册专用，不泛化）。",
  },
  F: {
    name: "F 修正层过期",
    suggestedAttribution: "口径",
    evidencePath: "corrections/<docId>.json（干跑 applyCorrections）",
    note: "missed>0 ⇒ 清单与新源不匹配，需退休或更新；只干跑不改写。",
  },
  G: {
    name: "G 口径/基线漂移",
    suggestedAttribution: "口径",
    evidencePath: "data/out/<doc>/meta.json + scripts/*-baseline.json",
    note: "只报数不判：meta 数字与登记基线的差。",
    metric: true,
  },
};

function sortSamples(list: DefectSample[]): DefectSample[] {
  return [...list].sort((a, b) => {
    if (a.weight !== undefined || b.weight !== undefined) {
      return (b.weight ?? 0) - (a.weight ?? 0);
    }
    if (a.doc !== b.doc) return a.doc < b.doc ? -1 : 1;
    return (a.page ?? 0) - (b.page ?? 0);
  });
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 每类一行读数摘要（报告用；全量逐册读数见 result.json 的 ledger）。 */
function summarizeClass(c: DefectClass, docScans: DocScan[], hits: number): string {
  const docsWith = docScans.filter((d) => d.hits[c] > 0).length;
  switch (c) {
    case "A": {
      const over = docScans.filter((d) => d.ledgers.A.overBaseline === true).length;
      let maxDoc = "-";
      let max = 0;
      for (const d of docScans) {
        const n = num(d.ledgers.A.contentCount);
        if (n > max) {
          max = n;
          maxDoc = d.doc;
        }
      }
      return `内容级合计 ${hits} · 越界 ${over} 册 · 单册最大 ${maxDoc} ${max} 条`;
    }
    case "B": {
      let stray = 0;
      let smiles = 0;
      let blank = 0;
      for (const d of docScans) {
        for (const s of d.samples.B) {
          if (s.kind.includes("stray}")) stray++;
          if (s.kind.includes("smiles")) smiles++;
          if (s.kind.includes("blankNoise")) blank++;
        }
      }
      const cSmiles = docScans.reduce((a, d) => a + num(d.ledgers.B.cleanupSmilesUnwrapped), 0);
      const cBlank = docScans.reduce((a, d) => a + num(d.ledgers.B.cleanupBlankDropped), 0);
      return `stray} ${stray} / smiles ${smiles} / blankNoise ${blank}；清洗留痕 smiles ${cSmiles} / blank ${cBlank}（涉及 ${docsWith} 册）`;
    }
    case "C": {
      const c1 = docScans.reduce((a, d) => a + num(d.ledgers.C.C1), 0);
      const c2 = docScans.reduce((a, d) => a + num(d.ledgers.C.C2), 0);
      return `C1 无题号真题块 ${c1} / C2 标签折行残片 ${c2}（涉及 ${docsWith} 册）`;
    }
    case "D":
      return `跨页泄漏记录 ${hits} 条（OXR 无 preproc_blocks ⇒ 判据整体跳过）`;
    case "E": {
      const guard = docScans.reduce((a, d) => a + num(d.ledgers.E.guardHits), 0);
      const curated = docScans.reduce((a, d) => a + num(d.ledgers.E.curatedHits), 0);
      return `守卫命中 ${guard} / curated 补识 ${curated}（涉及 ${docsWith} 册）`;
    }
    case "F": {
      const missed = docScans.reduce((a, d) => a + num(d.ledgers.F.missed), 0);
      const applied = docScans.reduce((a, d) => a + num(d.ledgers.F.applied), 0);
      const unver = docScans.reduce((a, d) => a + num(d.ledgers.F.unverified), 0);
      const disab = docScans.reduce((a, d) => a + num(d.ledgers.F.disabled), 0);
      return `missed ${missed} / applied ${applied} / unverified ${unver} / disabled ${disab}`;
    }
    case "G":
      return `非零差 ${hits} 处（只报数，不判）`;
  }
}

function aggregate(docScans: DocScan[]): { classes: ClassReport[]; perDoc: DocReport[] } {
  const classes = [] as ClassReport[];
  const classIds: DefectClass[] = ["A", "B", "C", "D", "E", "F", "G"];
  for (const c of classIds) {
    const meta = CLASS_META[c];
    const allSamples = docScans.flatMap((d) => d.samples[c]);
    const hits = docScans.reduce((a, d) => a + d.hits[c], 0);
    const docs = docScans.filter((d) => d.hits[c] > 0).length;
    // 读数按册保留（同名字段跨册会互相覆盖，不能 Object.assign）
    const ledger: Record<string, unknown> = {};
    for (const d of docScans) ledger[d.doc] = d.ledgers[c];
    const prereq = docScans.map((d) => d.prerequisites.find((p) => p.startsWith(`${c}:`))).find(Boolean);
    classes.push({
      class: c,
      name: meta.name,
      hits,
      docs,
      suggestedAttribution: meta.suggestedAttribution,
      evidencePath: meta.evidencePath,
      samples: sortSamples(allSamples).slice(0, 5),
      note: meta.note,
      summary: summarizeClass(c, docScans, hits),
      ...(meta.metric ? { metric: true } : {}),
      ledger,
      ...(prereq ? { needsPrerequisite: prereq.slice(3) } : {}),
    });
  }
  const perDoc: DocReport[] = docScans.map((d) => {
    const total = (Object.keys(d.hits) as DefectClass[]).reduce((a, c) => a + d.hits[c], 0);
    return { doc: d.doc, hits: d.hits, total, prerequisites: d.prerequisites };
  });
  return { classes, perDoc };
}

function buildKnownFacts(docScans: DocScan[]): KnownFact[] {
  const cSamples = docScans.flatMap((d) => d.samples.C);
  const c1 = cSamples.filter((s) => s.kind.startsWith("C1"));
  const c1Docs = new Set(c1.map((s) => s.doc)).size;
  const dTotal = docScans.reduce((a, d) => a + d.hits.D, 0);
  const fTotal = docScans.reduce((a, d) => a + d.hits.F, 0);
  const answer = docScans.find((d) => d.doc === "答案册-合订本");
  const answerGuard = answer ? answer.ledgers.E.guardHits ?? 0 : 0;
  const answerCurated = answer ? answer.ledgers.E.curatedHits ?? 0 : 0;
  const aOver = docScans.filter((d) => d.ledgers.A.overBaseline === true).length;
  const aBaselineOver = docScans.filter(
    (d) => INK_BASELINE_DOCS.includes(d.doc) && d.ledgers.A.overBaseline === true,
  ).length;
  return [
    {
      label: "C 无题号真题块",
      expected: "≈14 处 / 4 册",
      actual: `${c1.length} 处 / ${c1Docs} 册`,
      consistent: c1.length === 14 && c1Docs === 4,
      source: "tmp/t2-structure2/scan-badge.ts（2026-11-20 实测）",
    },
    {
      label: "D 跨页泄漏（OXR 生产册）",
      expected: "0（OXR 无 preproc_blocks，判据整体跳过）",
      actual: `${dTotal}`,
      consistent: dTotal === 0,
      source: "src/normalize.ts B-47",
    },
    {
      label: "F 修正层 missed",
      expected: "0（15 册干跑全命中）",
      actual: `${fTotal}`,
      consistent: fTotal === 0,
      source: "corrections/<docId>.json 干跑",
    },
    {
      label: "E 答案册标题守卫",
      expected: "guard 6 + curated 16",
      actual: `guard ${answerGuard} + curated ${answerCurated}`,
      consistent: answerGuard === 6 && answerCurated === 16,
      source: "tmp/m7-answer/report.md / title-guard.json",
    },
    {
      label: "A 墨迹内容级（7 基线册越界数）",
      expected: "0（audit:render:baseline 7/7 通过）",
      actual: `${aBaselineOver} 册越界（全量超基线 ${aOver} 册，含非基线册）`,
      consistent: aBaselineOver === 0,
      source: "DECISIONS §115 + scripts/audit-render-all.mjs BASELINE_DOCS",
    },
  ];
}

export interface ScanResult {
  report: ScanReport;
  docScans: DocScan[];
}

export function scanAll(docIds: string[], root: string): ScanResult {
  const baselines: Baselines = {
    anchor: readJson<Baselines["anchor"]>(join("scripts", "anchor-reconcile-baseline.json")) ?? [],
    numberingCross: readJson<Baselines["numberingCross"]>(join("scripts", "numbering-cross-baseline.json")) ?? [],
    suspicious: readJson<{ entries?: { doc: string }[] }>(join("scripts", "suspicious-number-baseline.json"))
      ?.entries ?? [],
    numbering: readJson<Baselines["numbering"]>(join("scripts", "numbering-baseline.json")) ?? [],
  };
  const docScans = docIds.map((doc) => scanDoc(doc, root, baselines));
  const { classes, perDoc } = aggregate(docScans);
  const report: ScanReport = {
    generatedAt: new Date().toISOString(),
    root,
    docs: docIds,
    fullScan: docIds.length === listProductionDocs(root).length,
    classes,
    perDoc,
    knownFacts: buildKnownFacts(docScans),
    exitCodeSemantics:
      "默认恒 0（报告工具，不做门禁）；--fail-on-hit 时 B–F 任一类命中即 exit 1（A/G 为度量类不计）。检测不改写。",
  };
  return { report, docScans };
}

// ──────────────────────────── 报告渲染 ────────────────────────────

function renderMarkdown(report: ScanReport): string {
  const lines: string[] = [];
  lines.push("# L1 聚合缺陷扫描报告");
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 扫描根目录：${report.root}`);
  lines.push(`- 扫描册数：${report.docs.length}`);
  lines.push(`- 退出码语义：${report.exitCodeSemantics}`);
  lines.push("");
  lines.push("## 用法");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run audit:defects                                  # 全部生产册 → tmp/l1-defects/{report.md,result.json}");
  lines.push('npm run audit:defects -- --doc "物理_教材基础练 电路"     # 指定册（可重复）');
  lines.push("npm run audit:defects -- --all --fail-on-hit           # 显式全部 + 有缺陷即 exit 1");
  lines.push("npm run audit:defects -- --root <dir> --out <dir>      # 夹具/自检");
  lines.push("```");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 类别 | 命中数 | 涉及册 | 建议归因 | 证据路径 |");
  lines.push("|---|---|---|---|---|");
  for (const c of report.classes) {
    lines.push(
      `| ${c.name}${c.metric ? "（度量）" : ""} | ${c.hits} | ${c.docs} | ${c.suggestedAttribution} | ${c.evidencePath} |`,
    );
  }
  lines.push("");
  lines.push("> 归因口诀（手册 §1）：真丢（原卷有产物无）/ 伪影（多出的假内容）/ 口径（尺子旧）/ 误报（判据错）/ 待判。");
  lines.push("> 命中是「待人工处置」而非失败；扫描器只检测不改写。");
  lines.push("");
  lines.push("## 各类详述");
  for (const c of report.classes) {
    lines.push("");
    lines.push(`### ${c.name}（建议归因：${c.suggestedAttribution}）`);
    lines.push("");
    lines.push(`- 判据/说明：${c.note}`);
    lines.push(`- 命中数：${c.hits}（涉及 ${c.docs} 册）`);
    if (c.needsPrerequisite) lines.push(`- ⚠️ 前置：${c.needsPrerequisite}`);
    lines.push(`- 证据路径：${c.evidencePath}`);
    if (c.samples.length) {
      lines.push("- 样例（≤5）：");
      for (const s of c.samples) {
        const page = s.page ? ` p${s.page}` : "";
        lines.push(`  - \`${s.doc}\`${page} · ${s.kind} · ${s.detail}`);
      }
    } else {
      lines.push("- 样例：无");
    }
    lines.push(`- 读数：${c.summary}`);
  }
  lines.push("");
  lines.push("## 与已知事实对照");
  lines.push("");
  if (!report.fullScan) {
    lines.push("> ⚠️ 本次为**指定册**扫描；下列对照为**全量 15 册口径**，单册时可能不适用，仅供参照。");
    lines.push("");
  }
  lines.push("| 事实 | 期望 | 实测 | 一致 | 来源 |");
  lines.push("|---|---|---|---|---|");
  for (const f of report.knownFacts) {
    lines.push(`| ${f.label} | ${f.expected} | ${f.actual} | ${f.consistent ? "✅" : "❌"} | ${f.source} |`);
  }
  lines.push("");
  lines.push("## 逐册命中");
  lines.push("");
  lines.push("| 册 | A | B | C | D | E | F | G | 合计 | 前置 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const d of report.perDoc) {
    const h = d.hits;
    lines.push(
      `| ${d.doc} | ${h.A} | ${h.B} | ${h.C} | ${h.D} | ${h.E} | ${h.F} | ${h.G} | ${d.total} | ${d.prerequisites.join("；") || "—"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ──────────────────────────── CLI ────────────────────────────

interface CliArgs {
  root: string;
  out: string;
  docs: string[];
  all: boolean;
  failOnHit: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let root = DEFAULT_ROOT;
  let out = DEFAULT_OUT;
  let all = false;
  let failOnHit = false;
  const docs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--root" && argv[i + 1]) root = argv[++i]!;
    else if (a === "--out" && argv[i + 1]) out = argv[++i]!;
    else if (a === "--doc" && argv[i + 1]) docs.push(argv[++i]!);
    else if (a === "--all") all = true;
    else if (a === "--fail-on-hit") failOnHit = true;
  }
  void all;
  return { root, out, docs, all, failOnHit };
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  return argv1 ? fileURLToPath(import.meta.url) === argv1 : false;
}

if (isMain()) {
  const { root, out, docs: docArgs, failOnHit } = parseArgs(process.argv.slice(2));
  if (!existsSync(root)) {
    console.error(`目录不存在：${root}`);
    process.exit(2);
  }
  const prod = listProductionDocs(root);
  const docIds = docArgs.length ? docArgs : prod;
  if (docIds.length === 0) {
    console.error(`聚合缺陷扫描：${root} 下没有可扫描的生产册（需 layout.json）`);
    process.exit(2);
  }
  const missing = docIds.filter((d) => !existsSync(join(root, d, "layout.json")));
  if (missing.length) {
    console.error(`聚合缺陷扫描：指定册缺 layout.json：${missing.join("、")}`);
    process.exit(2);
  }

  const { report } = scanAll(docIds, root);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(out, "report.md"), renderMarkdown(report), "utf8");

  console.log(`聚合缺陷扫描：${docIds.length} 册 → ${out}`);
  for (const c of report.classes) {
    console.log(`  ${c.name}：${c.hits}（${c.docs} 册）· 归因 ${c.suggestedAttribution}`);
  }
  const facts = report.knownFacts;
  console.log(`  已知事实对照：${facts.filter((f) => f.consistent).length}/${facts.length} 一致`);
  console.log(`  退出码语义：${report.exitCodeSemantics}`);

  if (failOnHit) {
    const defectHits = report.classes.filter((c) => !c.metric).reduce((a, c) => a + c.hits, 0);
    if (defectHits > 0) process.exit(1);
  }
  process.exit(0);
}
