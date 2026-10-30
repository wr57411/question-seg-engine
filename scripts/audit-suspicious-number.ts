// scripts/audit-suspicious-number.ts
/**
 * 可疑题号行审计（**只报警、不改数据**）—— HANDOFF §6-6 的检测侧护栏。
 *
 * 背景：`1.5` 被上游读碎成 `1.$5` 后，行首 `1.` 仍会被当成题号（`DECISIONS §26` 的残留缺口；
 * 域约束只挡 `0`）。这类行一旦出现，正确做法是**回原卷核对、拿真实案例单独立项修切题判据**，
 * 而不是在这里自动改写 —— 本脚本只把它们列出来（对应红线「检测不改写」）。
 *
 * 判据（**与引擎不同源**：独立正则，不 import `src/patterns.ts`）：
 * - **S1 行首 `N.$<数字>`**：被读碎的小数形态，可能被切出假题（N = 1–99）。
 *   注意 `N.$(1)` / `N.$\frac` 这类是**正常**的「题号 + 公式」，不命中。
 * - **S2 当前题目 `stem` 以 `$<数字>` 开头**：S1 已经切错的产物证据。
 *
 * 命中 ⇒ **exit 1**（进 `npm run check`，看见就提醒）。
 * 确认原卷本该如此（误报）时，手工在 `scripts/suspicious-number-baseline.json` 登记一条，
 * `note` 必须写核对依据（页图路径/原卷文本）；本脚本校验登记的 `note` 非空。
 *
 * 用法：
 *   node --import tsx scripts/audit-suspicious-number.ts
 *   node --import tsx scripts/audit-suspicious-number.ts --root tmp/fixture   # 自检/反向验证
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_ROOT = join("data", "out");
const BASELINE_PATH = join("scripts", "suspicious-number-baseline.json");
/** S1：行首 `N.` 紧跟 `$数字` —— 被读碎的小数（`1.5` → `1.$5`）。 */
const S1 = /^([1-9]\d{0,2})\s*\.\s*\$\s*(\d)/;
/** S2：题干以 `$数字` 开头 —— S1 已经切错的产物形态。 */
const S2 = /^\s*\$\s*(\d)/;
/** 同书的另一种解析副本 + 非文档目录：不重复报。 */
const SKIP_EXACT = new Set(["bank", "tags", "_tablecheck"]);
const SKIP_SUFFIX = /-(?:OXR|MinerU)$/;

interface Hit {
  kind: "S1" | "S2";
  doc: string;
  page: number;
  block: number;
  text: string;
}

interface BaselineEntry {
  kind: "S1" | "S2";
  doc: string;
  page: number;
  block: number;
  text: string;
  /** 必填：核对依据（页图路径 / 原卷文本） */
  note: string;
}

function parseArgs(argv: string[]): { root: string } {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
  }
  return { root };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function main(): void {
  const { root } = parseArgs(process.argv.slice(2));
  if (!existsSync(root)) {
    console.error(`目录不存在：${root}`);
    process.exit(2);
  }

  const docs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((d) => !SKIP_EXACT.has(d) && !SKIP_SUFFIX.test(d))
    .filter((d) => existsSync(join(root, d, "stages.json")));

  const hits: Hit[] = [];
  for (const doc of docs) {
    const snap = readJson<{ pages?: { blocks?: { text?: string }[] }[] }>(join(root, doc, "stages.json"));
    for (const [pi, page] of (snap?.pages ?? []).entries()) {
      for (const [bi, block] of (page.blocks ?? []).entries()) {
        const text = String(block.text ?? "").trim();
        if (S1.test(text)) hits.push({ kind: "S1", doc, page: pi + 1, block: bi, text });
      }
    }
    const raw = readJson<unknown>(join(root, doc, "questions.json"));
    const questions = Array.isArray(raw) ? raw : ((raw as { questions?: unknown[] } | null)?.questions ?? []);
    for (const q of questions as { number?: string; stem?: string }[]) {
      const stem = String(q.stem ?? "").trim();
      if (S2.test(stem)) hits.push({ kind: "S2", doc, page: 0, block: 0, text: `#${q.number ?? "?"} ${stem}` });
    }
  }

  // 基线：只登记「已回原卷核对为误报」的条目；note 必填。
  const baseline = readJson<{ entries?: BaselineEntry[] }>(BASELINE_PATH);
  const badBaseline = (baseline?.entries ?? []).filter((e) => !String(e.note ?? "").trim());
  const key = (h: { kind: string; doc: string; page: number; block: number; text: string }) =>
    `${h.kind}|${h.doc}|${h.page}|${h.block}|${h.text}`;
  const known = new Set((baseline?.entries ?? []).map(key));
  const fresh = hits.filter((h) => !known.has(key(h)));

  console.log("可疑题号行审计（只报警、不改数据）");
  console.log(`  扫描 ${docs.length} 册 · S1 行首 N.$数字 = ${hits.filter((h) => h.kind === "S1").length} 条 · S2 题干以 $数字 开头 = ${hits.filter((h) => h.kind === "S2").length} 条`);
  if (badBaseline.length) {
    console.log(`\n❌ 基线里有 ${badBaseline.length} 条缺 note（豁免必须能追溯）：`);
    for (const e of badBaseline) console.log(`  ${e.doc} p${e.page} b${e.block}`);
  }
  if (fresh.length) {
    console.log(`\n⚠️ 发现 ${fresh.length} 条未登记的可疑行：`);
    for (const h of fresh) {
      console.log(`  [${h.kind}] ${h.doc} p${h.page} b${h.block}：${h.text.slice(0, 80).replace(/\n/g, " ")}`);
    }
    console.log(
      "\n处理：回原卷核对 —— 真实误切 ⇒ 拿这个案例单独立项修切题判据；原卷本该如此 ⇒ " +
        `在 ${BASELINE_PATH} 登记（note 写页图/原文依据）。本审计不改任何数据。`,
    );
    process.exit(1);
  }
  if (badBaseline.length) process.exit(1);
  console.log("✅ 无可疑行");
}

main();
