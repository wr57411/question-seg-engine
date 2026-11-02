// scripts/audit-numbering-cross.ts
/**
 * 题号行交叉核对（**只报警、不改数据**）—— `BACKLOG L-06` / `DECISIONS §99`。
 *
 * 背景（2026-10-31 实测）：MinerU 会把一整段题号连出处标注**认成残片** ——
 * 《机械能守恒》p7 原卷 `2 [人教版必修二 P94 第5题模型变式] 易错`，
 * `layout.json` 里只剩 `式易镜` 三个字；而项目自己的整页 OCR
 * (`ocr-page/p07.txt`) 该行**完整存在**。后果是该题整题丢失，还连带把后一题
 * （靠「= 上一题 + 1」认的黏连题号）一起挡掉。
 *
 * 现有的「OCR 补行」只补**墨迹未覆盖的洞**；此处墨迹已被残片占住 ⇒ 补行不介入。
 * 所以需要这条**独立核对通道**：逐页比对「整页 OCR 的题号行」与「layout / 产物」。
 *
 * 判据见 `scripts/lib/numbering-cross.ts`（纯函数，可单测；**不 import `src/`**）：
 * - **X1 上游丢字**：题号行正文在 layout 里就没有。
 * - **X2 切分丢题**：正文在 layout 里，却没成为任何一道题（含被并进相邻题）。
 *
 * 反向（layout 有、OCR 无）不报：OCR 自身也会漏，报了只会是噪声。
 *
 * **入闸方式（`§99` v2 补充）**：命中是**已知缺陷**，不是在办事项 —— 让 `check` 每次都红，
 * 等于逼人忽略它。所以用**登记表**（`scripts/numbering-cross-baseline.json`）：
 * - 已登记 ⇒ 只打印，不算失败；
 * - **未登记的新命中 ⇒ exit 1**（这才是回归）；
 * - 已登记但本次不再命中 ⇒ 打印「已消失，请从登记表移除」，不算失败（修好了是好事）。
 *
 * 用法：
 *   npm run audit:numbering:cross                    # 闸门模式（新命中才红）
 *   npm run audit:numbering:cross -- --report        # 只看清单，永远 exit 0
 *   npm run audit:numbering:cross -- --update-baseline   # 重写登记表
 *   npm run audit:numbering:cross -- --root tmp/fixture  # 自检（不比对登记表）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Q_LINE,
  baselineKeys,
  bodyFromLines,
  cjk,
  gramSet,
  judge,
  type BaselineEntry,
  type Verdict,
} from "./lib/numbering-cross.js";

const DEFAULT_ROOT = join("data", "out");
const BASELINE_PATH = join("scripts", "numbering-cross-baseline.json");
/** 同书的另一种解析副本 + 非文档目录：不重复报。 */
const SKIP_EXACT = new Set(["bank", "tags", "_tablecheck"]);
const SKIP_SUFFIX = /-(?:OXR|MinerU)$/;

interface Hit {
  doc: string;
  page: number;
  number: string;
  ocrLine: string;
  verdict: Verdict;
  covLayout: number;
  covPool: number;
  /** 正文汉字前 8 字，登记表的稳定键 */
  body: string;
}

function parseArgs(argv: string[]): {
  root: string;
  report: boolean;
  updateBaseline: boolean;
  /** 显式指定的登记表路径（自检/测试用）；未指定时按 root 推断 */
  baseline: string | null;
} {
  let root = DEFAULT_ROOT;
  let report = false;
  let updateBaseline = false;
  let baseline: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
    if (argv[i] === "--baseline" && argv[i + 1]) baseline = argv[++i]!;
    if (argv[i] === "--report") report = true;
    if (argv[i] === "--update-baseline") updateBaseline = true;
  }
  return { root, report, updateBaseline, baseline };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface LayoutPage {
  para_blocks?: { lines?: { spans?: { content?: string }[] }[] }[];
}
interface LayoutFile {
  pdf_info?: LayoutPage[];
}

function layoutSpans(lay: LayoutFile): string[] {
  const out: string[] = [];
  for (const p of lay.pdf_info ?? []) {
    for (const b of p.para_blocks ?? []) {
      for (const l of b.lines ?? []) {
        for (const s of l.spans ?? []) out.push(s.content ?? "");
      }
    }
  }
  return out;
}

function main(): void {
  const { root, report, updateBaseline, baseline: baselineArg } = parseArgs(process.argv.slice(2));
  if (!existsSync(root)) {
    console.error(`目录不存在：${root}`);
    process.exit(1);
  }

  const hits: Hit[] = [];
  let docs = 0;
  for (const name of readdirSync(root).sort()) {
    if (SKIP_EXACT.has(name) || SKIP_SUFFIX.test(name)) continue;
    const dir = join(root, name);
    const ocrDir = join(dir, "ocr-page");
    const lay = readJson<LayoutFile>(join(dir, "layout.json"));
    if (!lay || !existsSync(ocrDir)) continue;

    const layoutGrams = gramSet(cjk(layoutSpans(lay).join("")));
    // 产物题池：没有 questions.json 时置 null ⇒ 只判 X1，不判 X2（不猜）
    const rawQ = readJson<{ questions?: { stem?: string }[] } | { stem?: string }[]>(
      join(dir, "questions.json"),
    );
    let poolGrams: Set<string> | null = null;
    if (rawQ) {
      const qs = Array.isArray(rawQ) ? rawQ : rawQ.questions ?? [];
      poolGrams = gramSet(cjk(qs.map((q) => q.stem ?? "").join("")));
    }

    let reported = false;
    for (const f of readdirSync(ocrDir).sort()) {
      const m = /^p(\d+)\.txt$/.exec(f);
      if (!m) continue;
      const pageIdx = Number(m[1]) - 1;
      const lines = readFileSync(join(ocrDir, f), "utf8").split(/\r?\n/);
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!.trim();
        const q = Q_LINE.exec(line);
        if (!q) continue;
        const j = judge(bodyFromLines(lines, li), layoutGrams, poolGrams);
        if (!j) continue;
        const body = cjk(bodyFromLines(lines, li).slice(0, 12)).slice(0, 8);
        hits.push({
          doc: name,
          page: pageIdx + 1,
          number: q[1] ?? "?",
          ocrLine: line.slice(0, 46),
          verdict: j.verdict,
          covLayout: j.covLayout,
          covPool: j.covPool,
          body,
        });
        reported = true;
      }
    }
    if (reported) docs++;
  }

  const x1 = hits.filter((h) => h.verdict === "X1");
  const x2 = hits.filter((h) => h.verdict === "X2");
  console.log(`题号行交叉核对：扫描 ${root}`);
  console.log(
    `命中 **${hits.length}** 处（涉及 ${docs} 册）：X1 上游丢字 ${x1.length} / X2 切分丢题 ${x2.length}\n`,
  );
  const show = (label: string, list: Hit[]) => {
    console.log(`${label}（${list.length}）`);
    if (!list.length) console.log("  （无）");
    for (const h of list) {
      console.log(
        `  ${h.doc} · p${h.page} · #${h.number} · layout ${h.covLayout.toFixed(2)} / 题池 ${h.covPool.toFixed(2)} | ${h.ocrLine}`,
      );
    }
    console.log("");
  };
  show("X1 上游丢字 —— 该题正文在 layout 里就没有", x1);
  show("X2 切分丢题 —— 正文在输入里，却没成题", x2);
  console.log(
    "说明：覆盖率为「汉字 4 字滑窗命中比例」，不用精确子串（公式/字母写法必然不同）。\n" +
      "处置：回原卷页图核对（红线：检测不改写），确认后再决定是否补切。",
  );

  // ── 登记表比对 ──
  // 生产根目录用默认登记表；换了 `--root`（夹具）却**没**给 `--baseline` 时，不比对，
  // 避免拿生产登记表去量夹具。显式给了 `--baseline` 就一律用它。
  const baselinePath = baselineArg ?? (root === DEFAULT_ROOT ? BASELINE_PATH : null);
  if (!baselinePath) return;

  if (updateBaseline) {
    const entries: BaselineEntry[] = hits.map((h) => ({
      doc: h.doc,
      check: h.verdict,
      at: `p${h.page} #${h.number}`,
      body: h.body,
      detail: h.ocrLine,
    }));
    writeFileSync(baselinePath, `${JSON.stringify(entries, null, 1)}\n`, "utf8");
    console.log(`\n已写入登记表 ${baselinePath}：${entries.length} 条`);
    return;
  }

  const baseline = readJson<BaselineEntry[]>(baselinePath) ?? [];
  const known = new Set<string>();
  for (const e of baseline) {
    for (const k of baselineKeys({
      doc: e.doc,
      verdict: e.check,
      page: Number(/^p(\d+)/.exec(e.at ?? "")?.[1] ?? NaN) || null,
      number: /#(\S+)$/.exec(e.at ?? "")?.[1] ?? null,
      body: e.body ?? "",
    })) {
      known.add(k);
    }
  }
  const isKnown = (h: Hit) =>
    baselineKeys({ doc: h.doc, verdict: h.verdict, page: h.page, number: h.number, body: h.body }).some(
      (k) => known.has(k),
    );

  const fresh = hits.filter((h) => !isKnown(h));
  const seen = new Set<string>();
  for (const h of hits) {
    for (const k of baselineKeys({
      doc: h.doc,
      verdict: h.verdict,
      page: h.page,
      number: h.number,
      body: h.body,
    })) {
      seen.add(k);
    }
  }
  const stale = baseline.filter(
    (e) =>
      !baselineKeys({
        doc: e.doc,
        verdict: e.check,
        page: Number(/^p(\d+)/.exec(e.at ?? "")?.[1] ?? NaN) || null,
        number: /#(\S+)$/.exec(e.at ?? "")?.[1] ?? null,
        body: e.body ?? "",
      }).some((k) => seen.has(k)),
  );

  console.log(
    `登记表：已知 ${baseline.length} 条；本次命中 ${hits.length} 条 ⇒ 已登记 ${hits.length - fresh.length} / **新增 ${fresh.length}**`,
  );
  if (fresh.length) {
    console.log("\n⚠️ **未登记的新命中（回归）**：");
    for (const h of fresh) console.log(`  ${h.doc} · p${h.page} · #${h.number} · ${h.verdict} | ${h.ocrLine}`);
    console.log("\n若是真缺陷：修它；若是判据误报：修判据，别把它塞进登记表。");
  }
  if (stale.length) {
    console.log(`\nℹ️ 已登记但本次未命中 ${stale.length} 条（修好了？请删掉对应条目）：`);
    for (const e of stale.slice(0, 10)) console.log(`  ${e.doc} · ${e.at} · ${e.check} · ${e.body}`);
    if (stale.length > 10) console.log(`  … 其余 ${stale.length - 10} 条`);
  }

  if (report) return;
  if (fresh.length > 0) process.exit(1);
}

main();
