// scripts/audit-anchor-reconcile.ts
/**
 * 教材知识锚点对账（**只报警、不改数据**）—— `DECISIONS §102`（原 `§98` 原型转正）。
 *
 * ## 为什么需要第二把尺子
 *
 * `§99` 的题号行交叉核对能发现「某道题不见了」，但它只认**整页 OCR 里有题号行**的情况。
 * 它看不见的另一类：**题号还在、内容却错位**（并进了相邻题、题干被截断），
 * 以及**上游把题号整段认丢**（连 OCR 行都对不上）。
 *
 * 锚点法用的是**不同来源**：用户提出的「目录页码」思路 ——
 * Word（夸克扫描王的真文字版）里 `教材知识N` 全书连续编号，`layout.json` 里同名块所在页
 * 就是它在扫描件中的位置。于是 **Word 段落区间 ↔ PDF 页区间** 一一对应，可**逐段比题数**。
 *
 * ## 判据
 *
 * 对每个锚点区间：`diff = Word 题号行数 − 引擎该页区间的题数`。
 * `|diff| ≥ 2` 才算异常（±1 属已知边界噪声：锚点跨页时边界页的题会被算到相邻段；
 * Word 侧只认 `N[` 与 `N 年份 卷` 两种形态，`N.` 形态不认 ⇒ 偏向少报）。
 *
 * ## 入闸（与 `§99` 同一模式）
 *
 * 登记表 `scripts/anchor-reconcile-baseline.json`：已登记不红、**未登记的新异常 exit 1**。
 *
 * 用法：
 *   npm run audit:anchor               # 闸门模式
 *   npm run audit:anchor -- --report   # 只看表，永远 exit 0
 *   npm run audit:anchor -- --update-baseline
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join("data", "out");
const DOCX = join("books", "物理_教材基础练.docx");
const BASELINE_PATH = join("scripts", "anchor-reconcile-baseline.json");
/** 目录区段数（前 400 段是目录，其里的 `教材知识N` 不是正文锚点）。 */
const TOC_LINES = 400;
/** 判异阈值：|diff| ≥ 2（±1 是已知边界噪声）。 */
const DIFF_THRESHOLD = 2;

/** 6 本「教材基础练」共用同一份合订 Word。 */
const DOCS = [
  "物理_教材基础练 运动和力",
  "物理_教材基础练 曲线运动",
  "物理_教材基础练万有引力",
  "物理_教材基础练机械能守恒定律",
  "物理_教材基础练 电路",
  "教材基础练 磁场",
];

const Q_BRACKET = /^(\d{1,2})\s*[\[［]/;
const Q_YEAR = /^(\d{1,2})\s+(?:19|20)\d{2}\s+\S{2,8}卷/;
const ANCHOR = /^教材知识\s*(\d+)/;

/**
 * 读 docx 正文段落。
 *
 * ⚠️ 两个必须记得的坑（`§98` 实测）：
 * 1. `mc:AlternateContent` 里 `<mc:Fallback>` 是同一段内容的副本 ⇒ 不去掉题号行会翻倍；
 * 2. 段落正则必须写 `<w:t(?:\s[^>]*)?>`，写成 `<w:t[^>]*>` 会把 `<w:tabs>` 吃进来。
 */
function readDocxParagraphs(path: string): string[] {
  if (!existsSync(path)) return [];
  // Node 无内置 unzip；用系统 unzip（macOS/Linux 均自带）。缺失时明确报错而不是静默空跑。
  const xml = execFileSync("unzip", ["-p", path, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const clean = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "");
  const out: string[] = [];
  for (const p of clean.split("</w:p>")) {
    const t = (p.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g) ?? [])
      .map((m) => m.replace(/<w:t(?:\s[^>]*)?>/, "").replace("</w:t>", ""))
      .join("")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (t) out.push(t);
  }
  return out;
}

interface LayoutPage {
  para_blocks?: { lines?: { spans?: { content?: string }[] }[] }[];
}

function layoutAnchors(doc: string): { pageOf: Map<number, number>; pages: number } {
  const pageOf = new Map<number, number>();
  const path = join(ROOT, doc, "layout.json");
  if (!existsSync(path)) return { pageOf, pages: 0 };
  const lay = JSON.parse(readFileSync(path, "utf8")) as { pdf_info?: LayoutPage[] };
  const pages = lay.pdf_info ?? [];
  pages.forEach((p, pi) => {
    for (const b of p.para_blocks ?? []) {
      const t = (b.lines ?? [])
        .map((l) => (l.spans ?? []).map((s) => s.content ?? "").join(""))
        .join("")
        .trim();
      const m = ANCHOR.exec(t);
      if (!m) continue;
      const n = Number(m[1]);
      if (!pageOf.has(n)) pageOf.set(n, pi + 1);
    }
  });
  return { pageOf, pages: pages.length };
}

interface Row {
  doc: string;
  anchor: number;
  wordLines: string;
  pages: string;
  wordCount: number;
  engineCount: number;
  diff: number;
}

function main(): void {
  const argv = process.argv.slice(2);
  const report = argv.includes("--report");
  const updateBaseline = argv.includes("--update-baseline");

  if (!existsSync(DOCX)) {
    console.log(`跳过：找不到合订 Word（${DOCX}）—— 锚点对账需要它做独立来源。`);
    return;
  }

  const paras = readDocxParagraphs(DOCX);
  if (paras.length === 0) {
    console.error(`无法从 ${DOCX} 读出正文（unzip 失败或文件为空）`);
    process.exit(1);
  }

  // Word 侧锚点：正文（跳过目录）首次出现的段落下标
  const wordAnchor = new Map<number, number>();
  paras.forEach((line, i) => {
    if (i < TOC_LINES) return;
    const m = ANCHOR.exec(line.trim());
    if (!m) return;
    const n = Number(m[1]);
    if (!wordAnchor.has(n)) wordAnchor.set(n, i);
  });

  const rows: Row[] = [];
  for (const doc of DOCS) {
    const qPath = join(ROOT, doc, "questions.json");
    if (!existsSync(qPath)) continue;
    const raw = JSON.parse(readFileSync(qPath, "utf8")) as
      | { questions?: { source?: { pageIndex?: number } }[] }
      | { source?: { pageIndex?: number } }[];
    const qs = (Array.isArray(raw) ? raw : raw.questions ?? []) as {
      source?: { pageIndex?: number };
    }[];
    const { pageOf, pages } = layoutAnchors(doc);
    const ks = [...wordAnchor.keys()].filter((n) => pageOf.has(n)).sort((a, b) => a - b);
    if (ks.length === 0) continue;

    ks.forEach((n, idx) => {
      const a = wordAnchor.get(n)!;
      // 末段边界必须用**全局下一个锚点**（n+1），不能落到全书末尾 ——
      // 否则最后一册的最后一段会把后面所有册的内容算进来（实测 +469 → 是 bug 不是缺陷）。
      const nextA =
        idx + 1 < ks.length ? wordAnchor.get(ks[idx + 1]!)! : wordAnchor.get(n + 1) ?? paras.length;
      const wordCount = paras.slice(a, nextA).filter((l) => {
        const t = l.trim();
        return Q_BRACKET.test(t) || Q_YEAR.test(t);
      }).length;
      const pFrom = pageOf.get(n)!;
      const pTo = idx + 1 < ks.length ? pageOf.get(ks[idx + 1]!)! : pages + 1;
      const engineCount = qs.filter((x) => {
        const p = (x.source?.pageIndex ?? -1) + 1;
        return p >= pFrom && p < pTo;
      }).length;
      rows.push({
        doc,
        anchor: n,
        wordLines: `${a}–${nextA}`,
        pages: `p${pFrom}-${pTo - 1}`,
        wordCount,
        engineCount,
        diff: wordCount - engineCount,
      });
    });
  }

  const abnormal = rows.filter((r) => Math.abs(r.diff) >= DIFF_THRESHOLD);
  console.log(`教材知识锚点对账：${DOCS.length} 册 / ${rows.length} 段`);
  console.log(
    `合计 Word ${rows.reduce((a, r) => a + r.wordCount, 0)} 题 · 引擎 ${rows.reduce((a, r) => a + r.engineCount, 0)} 题`,
  );
  console.log(`异常（|差| ≥ ${DIFF_THRESHOLD}）：**${abnormal.length}** 段\n`);
  for (const r of abnormal) {
    console.log(
      `  ${r.doc} · 教材知识${r.anchor} · Word ${r.wordLines} / ${r.pages} · Word ${r.wordCount} vs 引擎 ${r.engineCount}  ⇒ ${r.diff > 0 ? "+" : ""}${r.diff}`,
    );
  }
  if (abnormal.length === 0) console.log("  （无）");

  if (updateBaseline) {
    const entries = abnormal.map((r) => ({
      doc: r.doc,
      anchor: r.anchor,
      diff: r.diff,
      wordCount: r.wordCount,
      engineCount: r.engineCount,
    }));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(entries, null, 1)}\n`, "utf8");
    console.log(`\n已写入登记表 ${BASELINE_PATH}：${entries.length} 条`);
    return;
  }

  const key = (doc: string, anchor: number) => `${doc}|${anchor}`;
  const baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { doc: string; anchor: number }[])
    : [];
  const known = new Set(baseline.map((e) => key(e.doc, e.anchor)));
  const fresh = abnormal.filter((r) => !known.has(key(r.doc, r.anchor)));
  const seen = new Set(abnormal.map((r) => key(r.doc, r.anchor)));
  const stale = baseline.filter((e) => !seen.has(key(e.doc, e.anchor)));

  console.log(
    `登记表：已知 ${baseline.length} 条；本次异常 ${abnormal.length} 条 ⇒ 已登记 ${abnormal.length - fresh.length} / **新增 ${fresh.length}**`,
  );
  if (fresh.length) {
    console.log("\n⚠️ **未登记的新异常（回归）**：");
    for (const r of fresh) console.log(`  ${r.doc} · 教材知识${r.anchor} · ${r.diff > 0 ? "+" : ""}${r.diff}`);
  }
  if (stale.length) {
    console.log(`\nℹ️ 已登记但本次正常 ${stale.length} 条（修好了？请删掉对应条目）：`);
    for (const e of stale.slice(0, 10)) console.log(`  ${e.doc} · 教材知识${e.anchor}`);
  }

  if (report) return;
  if (fresh.length > 0) process.exit(1);
}

main();
