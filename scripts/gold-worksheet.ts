// scripts/gold-worksheet.ts —— 生成人工标注工作表（不生成金标本身）。
//
// 用法：
//   npm run gold:worksheet -- --all
//   npm run gold:worksheet -- "23必刷题 3 运动和力的关系"
//
// 每本抽 5 题（首/25%/50%/75%/末），列出页图路径、系统草稿（仅参考）、金标 JSON 模板。
// 标注规则：必须回原卷页图转写；不能从 questions.json 复制；整本标完才把 complete 改 true。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Question } from "../src/types.js";

interface RegistryBook {
  docId: string;
  class: "A" | "B" | "C";
  pages: number;
  questions: number;
  sourcePdf: string;
  status: string;
  gold: string | null;
}

const REG = JSON.parse(readFileSync("gold/registry.json", "utf8")) as { books: RegistryBook[] };
const args = process.argv.slice(2);
const all = args.includes("--all");
const docArg = args.find((a) => !a.startsWith("--"));
const books = all ? REG.books : REG.books.filter((b) => b.docId === docArg);
if (books.length === 0) {
  console.error("用法：npm run gold:worksheet -- --all | <docId>");
  process.exit(2);
}

function pageImage(docId: string, page: number): string | null {
  const n = page + 1;
  for (const name of [`page-${n}.png`, `page-${String(n).padStart(2, "0")}.png`, `page-${String(n).padStart(3, "0")}.png`]) {
    const p = join("data", "out", docId, "pages", name);
    if (existsSync(p)) return `../../${p}`;
  }
  return null;
}

mkdirSync(join("gold", "worksheets"), { recursive: true });
for (const b of books) {
  const qs = JSON.parse(readFileSync(join("data", "out", b.docId, "questions.json"), "utf8")) as Question[];
  const n = qs.length;
  const idxs = [...new Set([0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1])].filter(
    (i) => i >= 0 && i < n,
  );
  const lines: string[] = [
    `# ${b.docId} 标注工作表`,
    "",
    `- 类别：${b.class}（A=原书扫描 / B=手机截图 / C=答案册）`,
    `- 页数 / 题数：${b.pages} / ${b.questions}`,
    `- 原卷：\`${b.sourcePdf}\``,
    `- 规则：**只用原卷页图转写**；下面的“系统草稿”只作定位参考，不能直接当金标。`,
    `- 整本标完后，把 \`gold/${b.docId}.json\` 的 \`complete\` 改成 \`true\`，才算整本金标准。`,
    "",
  ];
  idxs.forEach((qi, k) => {
    const q = qs[qi]!;
    const page = q.source.pageIndex;
    const img = pageImage(b.docId, page);
    lines.push(
      `## 样本 ${k + 1} · p${page + 1} #${q.number}`,
      "",
      img ? `![页图](${img})` : `（页图缺失；请用原卷 PDF：\`data/out/${b.docId}/origin.pdf\`）`,
      "",
      "### 系统草稿（仅参考，必须回页图核对）",
      "```text",
      q.stem,
      ...q.options.map((o) => `${o.key}. ${o.text}`),
      "```",
      "",
      "### 金标填写（转写后替换下面的值）",
      "```json",
      JSON.stringify(
        {
          page,
          number: q.number,
          stem: "← 用页图转写",
          options: q.options.map((o) => ({ key: o.key, text: "← 用页图转写" })),
        },
        null,
        2,
      ),
      "```",
      "",
    );
  });
  const out = join("gold", "worksheets", `${b.docId}.md`);
  writeFileSync(out, lines.join("\n"));
  console.log(`${b.docId} → ${out}（${idxs.length} 题样本）`);
}
