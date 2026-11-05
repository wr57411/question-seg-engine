/**
 * 结构金标生成器 + 独立题号交叉（只读源；不写 data/out、不改引擎产物）
 *
 * 用途：给《电路》生成只含 (page, number) 的题目清单，作为**切题 P/R 的分母**。
 * 独立来源：整页 OCR 文本 `data/out/<doc>/ocr-page/pNN.txt`（PaddleOCR-VL 从原卷页图读出，
 *   与 MinerU / 引擎 questions.json 不同源；见 docs/ATTRIBUTION.md、DECISIONS §99）。
 * 骨架来源：`gold/worksheets/<doc>-full.md` 的 31 个题目标题（**只取页号与题号，不取正文**）。
 *
 * 判据取最严（tasks/lessons.md L2）：证据行必须同时满足
 *   ① 行首是该题号（后面不能再跟数字）② 含教辅出处标注 `[X版…]`
 *   ⇒ 宁可标 needs_review，也不把「知识清单 1. 定义:」之类误认成题号。
 *
 * 输出：`gold/<doc>.structure.json`、`docs/evidence/2026-11-05-电路独立题号交叉.md`
 * 用法：npx tsx scripts/gold-structure.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOC = "物理_教材基础练 电路";
const WS = join("gold", "worksheets", `${DOC}-full.md`);
const OCR_DIR = join("data", "out", DOC, "ocr-page");
const OUT = join("gold", `${DOC}.structure.json`);
const REPORT = join("docs", "evidence", "2026-11-05-电路独立题号交叉.md");

interface Evidence {
  file: string;
  line: string;
}
interface PageImageCheck {
  crop: string;
  seen: string;
}
interface StructureQuestion {
  page: number;
  number: string;
  stem: "";
  ocrEvidence?: Evidence;
  needsReview?: boolean;
  pageImageChecked?: PageImageCheck;
}

/**
 * 已回**原卷页图**逐题核实的 needs_review 题（2026-11-05）。
 * 三题的 OCR 证据缺失根因相同：教辅出处标注被折行/截断 ⇒ `[X版…]` 方括号不闭合，
 * 强判据（L2：宁可漏判不能误判）因此不给证据。页图确认题号真实存在，不是漏题。
 * key = `${page(0-based)}|${number}`；crop 为交付证据图（docs/evidence/…）。
 */
const PAGE_IMAGE_CHECKED: Record<string, PageImageCheck> = {
  "1|3": {
    crop: "docs/evidence/2026-11-05-电路独立题号页图/p02-top.png",
    seen: "红底「3」+「[鲁科版必修三 P115 第5题设问变式]」，出处标注折成两行",
  },
  "2|2": {
    crop: "docs/evidence/2026-11-05-电路独立题号页图/p03-top.png",
    seen: "红底「2」+「[多选][鲁科版必修三 P87 第5题题型变式]」，出处标注折成两行",
  },
  "3|2": {
    crop: "docs/evidence/2026-11-05-电路独立题号页图/p04-bottom.png",
    seen: "红底「2」+「[鲁科版必修三 P134 第4题情境变式]」，出处标注折成两行",
  },
};

/** 行首题号 + 出处标注 ⇒ 独立证据。返回 null 表示这道题没有可核验的独立证据。 */
function findOcrEvidence(lines: string[], number: string, file: string): Evidence | null {
  for (const raw of lines) {
    const s = raw.trimStart();
    if (number.startsWith("实验")) {
      const n = number.slice(2);
      if (s.includes(`实验${n}`) || s.includes(`教材实验${n}`)) {
        return { file, line: s.slice(0, 160) };
      }
      continue;
    }
    if (!s.startsWith(number)) continue;
    const rest = s.slice(number.length);
    if (/^[0-9]/.test(rest)) continue; // 「1」后面还是数字 ⇒ 是 12、13，不是题 1
    if (!/\[[^\]]*版[^\]]*\]/.test(s)) continue; // 出处标注：教辅题号强特征，排除知识清单条目
    return { file, line: s.slice(0, 160) };
  }
  return null;
}

function main(): void {
  const ws = readFileSync(WS, "utf8").split("\n");
  const questions: StructureQuestion[] = [];

  for (const line of ws) {
    const m = line.match(/^##\s+\d+\/\d+\s+·\s+p(\d+)\s+#(\S+)/);
    if (!m) continue;
    const page1 = Number(m[1]);
    const number = m[2]!;
    const page = page1 - 1; // 0-based，与 questions.json 的 source.pageIndex 一致
    const file = `p${String(page1).padStart(2, "0")}.txt`;
    const path = join(OCR_DIR, file);
    const evidence = existsSync(path)
      ? findOcrEvidence(readFileSync(path, "utf8").split("\n"), number, file)
      : null;
    const checked = PAGE_IMAGE_CHECKED[`${page}|${number}`];
    questions.push({
      page,
      number,
      stem: "",
      ...(evidence ? { ocrEvidence: evidence } : { needsReview: true }),
      ...(checked ? { pageImageChecked: checked } : {}),
    });
  }

  if (questions.length !== 31) {
    throw new Error(`工作表题数应为 31，实得 ${questions.length}；拒绝生成不完整分母`);
  }

  const gold = {
    docId: DOC,
    kind: "structure" as const,
    complete: true,
    source:
      "题目清单骨架 = gold/worksheets/物理_教材基础练 电路-full.md 的 31 个标题（仅取页号+题号）；" +
      "逐题用整页 OCR 文本 data/out/<doc>/ocr-page/pNN.txt 做独立交叉（与 MinerU/引擎不同源）",
    notes:
      "结构金标：只标 (page, number) + 独立证据，未转写全文 ⇒ 不算文本/公式保真率；" +
      "首本只作评分器联调，不外推到 13 本；(page,number) 骨架与 questions.json 同源，P/R 不可读作系统准确率。",
    questions,
  };
  writeFileSync(OUT, `${JSON.stringify(gold, null, 2)}\n`);

  const withEvidence = questions.filter((q) => q.ocrEvidence);
  const checkedList = questions.filter((q) => q.pageImageChecked);
  const stillMissing = questions.filter((q) => q.needsReview && !q.pageImageChecked);
  const lines = [
    "# 《电路》独立题号清单交叉 + 页图抽检（2026-11-05）",
    "",
    "## 口径",
    "",
    "- 骨架：`gold/worksheets/物理_教材基础练 电路-full.md` 的 31 个标题，**只取 `(page, number)`**，不取任何正文。",
    "- 独立证据：整页 OCR `data/out/<doc>/ocr-page/pNN.txt`（PaddleOCR-VL 读原卷页图，与 MinerU/引擎不同源）。",
    "- 判据（AND，取最严）：行首是该题号且其后不跟数字 **且** 该行含 `[X版…]` 出处标注。",
    "  ⇒ 目的：排除 p04「`1. 定义:`」这类知识清单条目被误当题号（L2：宁可漏判不能误判）。",
    "- 无 OCR 证据的题标 `needsReview`，再**回原卷页图**逐题核实；核实结果写 `pageImageChecked`。",
    "",
    "## 结果",
    "",
    "| 项 | 数 |",
    "|---|---:|",
    `| 清单题数 | ${questions.length} |`,
    `| 有独立 OCR 题号证据 | **${withEvidence.length}** |`,
    `| OCR 缺证据、已回原卷页图确认存在 | **${checkedList.length}** |`,
    `| 仍未核实 | **${stillMissing.length}** |`,
    "",
    "> ⚠ **31/31 都有独立证据，不等于分母完全独立**：骨架 `(page, number)` 与 `questions.json` 同源；",
    "> 独立部分只证明「这些题号在原卷/OCR 里存在」，不证明清单来源独立。见「已知边界」。",
    "",
    "## 页图抽检（页面事实以原图截图为唯一证据）",
    "",
    "| 题 | 原卷截图 | 页图上可见 |",
    "|---|---|---|",
    ...checkedList.map(
      (q) => `| p${q.page + 1}#${q.number} | \`${q.pageImageChecked!.crop}\` | ${q.pageImageChecked!.seen} |`,
    ),
    "| 正例 | `docs/evidence/2026-11-05-电路独立题号页图/p01-bottom.png` | 题 1、2 均为行首独立红底题号 + 完整出处标注 |",
    "",
    "- 三题 OCR 缺证据的**共同根因**：教辅出处标注 `[X版…]` 在 OCR 文本里被折行/截断，方括号不闭合",
    "  （例：p03 的 `2 [多选] [鲁科版必修三 P87` 与下一行 `第5题题型变式]`），强判据因此不给证据。",
    "- 页图确认三题题号**真实存在、不是漏题** ⇒ 与 `tasks/lessons.md` L6（结构性异常先怀疑流水线）一致。",
    "",
    "## 逐题明细",
    "",
    "| # | 页(1基) | 题号 | OCR 证据 | 页图核实 |",
    "|---:|---:|---|---|---|",
    ...questions.map((q, i) => {
      const e = q.ocrEvidence;
      return `| ${i + 1} | p${q.page + 1} | ${q.number} | ${e ? `\`${e.file}\`` : "—"} | ${q.pageImageChecked ? "✓" : "—"} |`;
    }),
    "",
    "## 已知边界（不得外推）",
    "",
    "- **骨架的 `(page, number)` 与 `questions.json` 完全一致 ⇒ 它不是完全独立的分母**；",
    "  独立部分只来自 OCR 题号行交叉与 3 题页图抽检。完全独立分母（逐页回原卷数题号）是下一个子目标 S2。",
    "- 因此 `recall/precision = 100%` 只证明**评分器联调通了**，不能读成「系统切题 100% 准」。",
    "- 结构金标只支持切题 P/R；文本・公式・图保真率另需全文金标与三槽判据（S2/S3）。",
    "- 「两题并一题」仍可能让 precision 虚高：本清单未标起止边界（score.ts 的 notes 已如实提示）。",
    "- 页图抽检只覆盖 3 道待复核题 + 1 个正例，不是全册逐页审板；本报告不外推到 13 本。",
  ];
  writeFileSync(REPORT, `${lines.join("\n")}\n`);

  console.log(
    `清单 ${questions.length} 题 · OCR 证据 ${withEvidence.length} · 页图核实 ${checkedList.length} · 仍未核实 ${stillMissing.length}`,
  );
  console.log(`产出：${OUT}`);
  console.log(`报告：${REPORT}`);
  if (stillMissing.length) {
    console.log(`仍未核实：${stillMissing.map((q) => `p${q.page + 1}#${q.number}`).join("、")}`);
  }
}

main();
