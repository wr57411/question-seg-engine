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
 * 命中 ⇒ 打印清单；默认 **exit 0**（先观察量级，不卡门）；`--strict` ⇒ exit 1。
 *
 * 用法：
 *   npm run audit:numbering:cross
 *   npm run audit:numbering:cross -- --strict
 *   npm run audit:numbering:cross -- --root tmp/fixture    # 自检
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Q_LINE,
  bodyFromLines,
  cjk,
  gramSet,
  judge,
  type Verdict,
} from "./lib/numbering-cross.js";

const DEFAULT_ROOT = join("data", "out");
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
}

function parseArgs(argv: string[]): { root: string; strict: boolean } {
  let root = DEFAULT_ROOT;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
    if (argv[i] === "--strict") strict = true;
  }
  return { root, strict };
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
  const { root, strict } = parseArgs(process.argv.slice(2));
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
        hits.push({
          doc: name,
          page: pageIdx + 1,
          number: q[1] ?? "?",
          ocrLine: line.slice(0, 46),
          verdict: j.verdict,
          covLayout: j.covLayout,
          covPool: j.covPool,
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
  if (strict && hits.length > 0) process.exit(1);
}

main();
