// scripts/paddle-structure-audit.ts
/**
 * PaddleOCR 结构计数器 vs MinerU —— **独立分母审计（只报警，不改数据）**。
 *
 * ## 为什么做（2026-11-03）
 *
 * 项目红线：**覆盖率的分母必须来自被检验对象之外的独立来源**。现在能算结构计数的
 * 解析源只有 MinerU（+ OXR 同厂系），而 OCR 线走 MCP 只拿到文本、拿不到结构。
 * `PP-StructureV3` 是**另一厂商的另一条产线**（版面检测 + 专用子模型），整本一次作业
 * 实测 71s / 13 页（≈5.5s/页，见 `docs/evidence/2026-11-03-paddle-two-routes-probe.md`），
 * 于是可以用它的「块/行/表/单元格/公式/chart」计数当**第二意见**。
 *
 * 实测预演（同一本《电路》13 页）：表格 9 = 9、chart 8 = 8（MinerU 完全一致），
 * 但**页级归属有 2 处分歧**（p3/p6 的 chart 与表互换）⇒
 * **计数级可用，位置级只能进 `needs_review`，不许自动改数据**（红线「检测不改写」）。
 *
 * ## 为什么两边的计数不能直接判对错
 *
 * MinerU 与 StructureV3 的分块粒度不同（一个段落可能被切成 2 块或并为 1 块）。
 * 所以本审计的产物是「**差异清单**」而不是「**通过/失败**」：差得多 = 值得回原卷页图看，
 * 差不等于错。金标判定永远回页图（`DECISIONS §106`）。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/paddle-structure-audit.ts                 # 默认：全部 pdf+content_list 且 ≤40 页的书
 * npx tsx scripts/paddle-structure-audit.ts --doc "物理_教材基础练 电路-MinerU"
 * npx tsx scripts/paddle-structure-audit.ts --max-pages 200 # 含答案册（187 页，单本可能 >15 分钟）
 * npx tsx scripts/paddle-structure-audit.ts --report-only   # 只读已落盘结果重出报告，不打接口
 * ```
 *
 * 落盘：`data/out/<docId>/paddle-audit.json`（逐页对照）+ 聚合报告
 * `docs/evidence/2026-11-03-paddle-structure-audit.md`。原始 JSONL 在
 * `data/out/<docId>/ocr-jobs/`（服务端原样返回，是唯一事实来源；`*.pages.json` 可重生成）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fileSize,
  jobTag,
  parseDocParsingJsonl,
  runJob,
  saveJobArtifacts,
  sha256File,
  verifyToken,
  type PaddlePage,
} from "./paddle-client.js";

const ROOT = join(import.meta.dirname, "..");
const OUT_ROOT = join(ROOT, "data", "out");
const REPORT = join(ROOT, "docs", "evidence", "2026-11-03-paddle-structure-audit.md");
/** 与 MinerU `content_list.json` 的 type 对齐的类目；Paddle 侧用 `block_label` 同名匹配。 */
const CATEGORIES = ["text", "image", "table", "chart", "header", "footer"] as const;
type Category = (typeof CATEGORIES)[number];

export interface DocCounts {
  [k: string]: number;
}

/** MinerU `content_list.json` ⇒ 每页各类目计数（纯函数，可单测）。 */
export function countMineruItems(contentList: unknown[]): DocCounts[] {
  const maxPage = contentList.reduce((m: number, it) => {
    const p = (it as { page_idx?: number })?.page_idx;
    return typeof p === "number" && p + 1 > m ? p + 1 : m;
  }, 0);
  const per: DocCounts[] = Array.from({ length: maxPage }, () => ({}));
  for (const raw of contentList) {
    const it = raw as { type?: string; page_idx?: number };
    if (typeof it.page_idx !== "number" || !it.type) continue;
    const bucket = per[it.page_idx];
    if (!bucket) continue;
    bucket[it.type] = (bucket[it.type] ?? 0) + 1;
  }
  return per;
}

/** Paddle 归一化页 ⇒ 与 MinerU 同名类目的计数（走 `parsing_res_list` 的 `block_label`）。 */
export function countPaddleBlocks(page: PaddlePage): DocCounts {
  const out: DocCounts = {};
  for (const [label, n] of Object.entries(page.counters.byLabel)) out[label] = (out[label] ?? 0) + n;
  return out;
}

/** 两边的差值（Paddle − MinerU）；只算共同关心的类目。 */
export function diffCounts(paddle: DocCounts, mineru: DocCounts): Record<Category, number> {
  const d = {} as Record<Category, number>;
  for (const c of CATEGORIES) d[c] = (paddle[c] ?? 0) - (mineru[c] ?? 0);
  return d;
}

/** 找已落盘的结果（幂等：重跑不重复烧接口），按 sha 命中当前 PDF。 */
function cachedPages(outDir: string, sha: string): PaddlePage[] | null {
  const dir = join(outDir, "ocr-jobs");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n === `${jobTag("PP-StructureV3", sha)}.pages.json`);
  if (!f) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PaddlePage[]) : null;
  } catch {
    return null;
  }
}

/** 从 `content_list.json` 所在目录读 MinerU 计数（`-MinerU` 目录才有；非 MinerU 目录走同目录）。 */
function mineruCounts(outDir: string): DocCounts[] | null {
  const p = join(outDir, "content_list.json");
  if (!existsSync(p)) return null;
  try {
    return countMineruItems(JSON.parse(readFileSync(p, "utf8")) as unknown[]);
  } catch {
    return null;
  }
}

export interface AuditRow {
  docId: string;
  pages: number;
  ran: "cached" | "job" | "skipped";
  skipReason?: string;
  wallMs?: number;
  totals: { paddle: DocCounts; mineru: DocCounts; diff: Record<string, number> };
  extra: { paddleLines: number; paddleCells: number; paddleFormulas: number; paddleDetBoxes: number };
  worstPages: { page: number; diff: Record<string, number>; blocks: number }[];
}

function totalsOf(pages: PaddlePage[], per: DocCounts[]): { paddle: DocCounts; mineru: DocCounts; diff: Record<string, number> } {
  const paddle: DocCounts = {};
  const mineru: DocCounts = {};
  for (const p of pages) for (const [k, v] of Object.entries(countPaddleBlocks(p))) paddle[k] = (paddle[k] ?? 0) + v;
  for (const pg of per) for (const [k, v] of Object.entries(pg)) mineru[k] = (mineru[k] ?? 0) + v;
  const diff: Record<string, number> = {};
  for (const c of CATEGORIES) diff[c] = (paddle[c] ?? 0) - (mineru[c] ?? 0);
  return { paddle, mineru, diff };
}

async function auditDoc(docId: string, maxPages: number, reportOnly: boolean): Promise<AuditRow> {
  const outDir = join(OUT_ROOT, docId);
  const pdf = join(outDir, "origin.pdf");
  const per = mineruCounts(outDir);
  if (!per) return skip(docId, "没有 content_list.json（缺 MinerU 基线，无法对照）");
  if (!existsSync(pdf)) return skip(docId, "没有 origin.pdf");
  const sha = sha256File(pdf);
  let pages = cachedPages(outDir, sha);
  let ran: AuditRow["ran"] = "cached";
  let wallMs = 0;
  if (!pages) {
    if (reportOnly) return skip(docId, `只有 --report-only，未落盘（sha ${sha.slice(0, 12)}）`);
    pages = [];
  } else {
    pages = pages as PaddlePage[];
  }
  if (pages.length === 0) {
    const est = per.length;
    if (est > maxPages) return skip(docId, `本审计限 ${maxPages} 页/本（这本 ${est} 页）——加大 --max-pages 再跑`);
    const cred = await verifyToken();
    if (!cred.ok) return skip(docId, `凭据不可用 [${cred.state}] ${cred.detail}`);
    const t0 = Date.now();
    console.log(`  ▶ ${docId}：${est} 页 / ${(fileSize(pdf) / 1024 / 1024).toFixed(1)} MB 提交作业…`);
    const outcome = await runJob({
      model: "PP-StructureV3",
      filePath: pdf,
      // 实测：这三个开关服务端接受；表格/公式/图表识别默认即开
      options: { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: true },
      onProgress: (m) => console.log(`    ${docId}${m}`),
    });
    wallMs = Date.now() - t0;
    saveJobArtifacts(outDir, outcome, { useChartRecognition: true });
    pages = parseDocParsingJsonl(outcome.jsonl);
    ran = "job";
  }
  const paddle = pages;
  const t = totalsOf(paddle, per);
  const perPage = paddle.map((p, i) => ({
    page: i + 1,
    paddle: countPaddleBlocks(p),
    mineru: per[i] ?? {},
    diff: diffCounts(countPaddleBlocks(p), per[i] ?? {}),
    blocks: p.counters.blocks,
  }));
  const worst = [...perPage]
    .sort(
      (a, b) =>
        Math.abs(b.diff.table) + Math.abs(b.diff.chart) + Math.abs(b.diff.image) - (Math.abs(a.diff.table) + Math.abs(a.diff.chart) + Math.abs(a.diff.image)),
    )
    .slice(0, 4);
  const row: AuditRow = {
    docId,
    pages: paddle.length,
    ran,
    wallMs,
    totals: t,
    extra: {
      paddleLines: paddle.reduce((a, p) => a + p.counters.lines, 0),
      paddleCells: paddle.reduce((a, p) => a + p.counters.cells, 0),
      paddleFormulas: paddle.reduce((a, p) => a + p.counters.formulas, 0),
      paddleDetBoxes: paddle.reduce((a, p) => a + p.counters.detBoxes, 0),
    },
    worstPages: worst.map((w) => ({ page: w.page, diff: w.diff, blocks: w.blocks })),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "paddle-audit.json"),
    JSON.stringify(
      {
        docId,
        model: "PP-StructureV3",
        inputSha256: sha,
        generatedAt: new Date().toISOString(),
        note: "只报警：块粒度两边不同源，差值 = 值得回原卷页图看的地方，不等于任何一边错（DECISIONS §106：判定回页图）。",
        totals: t,
        extra: row.extra,
        perPage,
      },
      null,
      2,
    ),
    "utf8",
  );
  return row;
}

function skip(docId: string, reason: string): AuditRow {
  return {
    docId,
    pages: 0,
    ran: "skipped",
    skipReason: reason,
    totals: { paddle: {}, mineru: {}, diff: {} },
    extra: { paddleLines: 0, paddleCells: 0, paddleFormulas: 0, paddleDetBoxes: 0 },
    worstPages: [],
  };
}

/** 候选书：有 origin.pdf 且有 content_list.json。 */
export function candidateDocs(): string[] {
  if (!existsSync(OUT_ROOT)) return [];
  return readdirSync(OUT_ROOT)
    .filter((d) => !d.startsWith("_") && d !== "bank" && d !== "archive")
    .filter((d) => existsSync(join(OUT_ROOT, d, "origin.pdf")) && existsSync(join(OUT_ROOT, d, "content_list.json")))
    .sort();
}

function renderReport(rows: AuditRow[]): string {
  const done = rows.filter((r) => r.ran !== "skipped");
  const skipped = rows.filter((r) => r.ran === "skipped");
  const sum = (k: "table" | "chart" | "image" | "text" | "header" | "footer") => ({
    paddle: done.reduce((a, r) => a + (r.totals.paddle[k] ?? 0), 0),
    mineru: done.reduce((a, r) => a + (r.totals.mineru[k] ?? 0), 0),
  });
  const lines: string[] = [
    "# PaddleOCR(StructureV3) 结构计数 vs MinerU —— 独立分母审计",
    "",
    `> 生成：${new Date().toISOString().slice(0, 16)} ｜ 脚本：\`scripts/paddle-structure-audit.ts\` ｜ 逐页明细：各册 \`data/out/<docId>/paddle-audit.json\``,
    ">",
    "> **口径**：差值是「值得回原卷页图看」的清单，**不是对错**。两边分块粒度不同源；",
    "> 金标判定永远回页图（`DECISIONS §106`）。本脚本不写 `stages.json` / `questions.json`（红线：检测不改写）。",
    "",
    "## 一、逐本合计",
    "",
    "| 册 | 页 | 来源 | text | image | table | chart | header | footer | 行框 | 单元格 | 公式 |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of done) {
    const m = r.totals.mineru, p = r.totals.paddle;
    lines.push(
      `| ${r.docId} | ${r.pages} | ${r.ran === "job" ? `新作业 ${(r.wallMs ?? 0) / 1000}s` : "缓存"} | ` +
        `${p.text ?? 0}/${m.text ?? 0} | ${p.image ?? 0}/${m.image ?? 0} | ${p.table ?? 0}/${m.table ?? 0} | ` +
        `${p.chart ?? 0}/${m.chart ?? 0} | ${p.header ?? 0}/${m.header ?? 0} | ${p.footer ?? 0}/${m.footer ?? 0} | ` +
        `${r.extra.paddleLines} | ${r.extra.paddleCells} | ${r.extra.paddleFormulas} |`,
    );
  }
  lines.push("", "## 二、汇总（Paddle / MinerU）", "");
  lines.push("| 类目 | Paddle | MinerU | 差 | 完全一致的册数 |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const c of ["table", "chart", "image", "text", "header", "footer"] as const) {
    const s = sum(c);
    const agree = done.filter((r) => (r.totals.paddle[c] ?? 0) === (r.totals.mineru[c] ?? 0)).length;
    lines.push(`| ${c} | ${s.paddle} | ${s.mineru} | ${s.paddle - s.mineru > 0 ? "+" : ""}${s.paddle - s.mineru} | ${agree}/${done.length} |`);
  }
  lines.push(
    "",
    `> Paddle 独有：行级文本框 **${done.reduce((a, r) => a + r.extra.paddleLines, 0)}** 个、` +
      `表格单元格框 **${done.reduce((a, r) => a + r.extra.paddleCells, 0)}** 个、` +
      `公式条目 **${done.reduce((a, r) => a + r.extra.paddleFormulas, 0)}** 条 —— 这三样 MinerU 侧没有等价物，是新增能力，不是差异。`,
    "",
    "## 三、分歧最大的页（前 4 名/册，按 |Δtable|+|Δchart|+|Δimage|）",
    "",
    "| 册 | 页 | Δtable | Δchart | Δimage | 该页块数 |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const r of done) for (const w of r.worstPages) {
    lines.push(
      `| ${r.docId} | ${w.page} | ${w.diff.table ?? 0} | ${w.diff.chart ?? 0} | ${w.diff.image ?? 0} | ${w.blocks} |`,
    );
  }
  if (skipped.length) {
    lines.push("", "## 四、本轮跳过（如实登记，不算做过）", "", "| 册 | 原因 |", "|---|---|");
    for (const r of skipped) lines.push(`| ${r.docId} | ${r.skipReason} |`);
  }
  lines.push(
    "",
    "## 五、这批数字能用来做什么 / 不能做什么",
    "",
    "**能**：① 给覆盖率提供一个非 MinerU 的分母（类目计数）；② 把两边不一致的页挑出来进 `needs_review`；",
    "③ 用行框/单元格框/公式条目做位置级交叉核对（另一个脚本 `paddle-pos-diff.ts`）。",
    "",
    "**不能**：① 不能因为某边计数多/少就判定另一边漏题或假题（分块粒度不同）；",
    "② 公式条目数**不能当公式认证**——`DECISIONS §106` 三台机器源在公式上集体失明未变，B-25 仍 `DROPPED`；",
    "③ 不能自动写回任何产物。",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const maxPages = Number(flag("max-pages") ?? 40);
  const reportOnly = argv.includes("--report-only");
  const only = flag("doc");
  const docs = only ? [only] : candidateDocs();
  console.log(`审计 ${docs.length} 本（≤${maxPages} 页/本${reportOnly ? "，仅读缓存" : ""}）…`);
  const rows: AuditRow[] = [];
  for (const d of docs) {
    try {
      rows.push(await auditDoc(d, maxPages, reportOnly));
    } catch (e) {
      rows.push(skip(d, `异常：${(e as Error)?.message ?? e}`.slice(0, 180)));
      console.log(`  ⚠️ ${d}：${(e as Error)?.message ?? e}`);
    }
  }
  mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
  writeFileSync(REPORT, renderReport(rows), "utf8");
  const done = rows.filter((r) => r.ran !== "skipped");
  const agree = (c: Category) => done.filter((r) => (r.totals.paddle[c] ?? 0) === (r.totals.mineru[c] ?? 0)).length;
  console.log(
    `\n完成 ${done.length} 本 / 跳过 ${rows.length - done.length} 本；报告 → ${REPORT}\n` +
      `   类目计数与 MinerU 完全一致：table ${agree("table")}/${done.length}、chart ${agree("chart")}/${done.length}、` +
      `image ${agree("image")}/${done.length}、header ${agree("header")}/${done.length}`,
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
