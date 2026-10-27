// scripts/generalization.ts
/**
 * 泛化矩阵：把 `data/out/` 下**所有**文档的切题质量排成一张表，用来区分
 * 「引擎缺陷」与「输入质量差」—— 这是 2026-10-27 光学卷之后立的方法论。
 *
 * 为什么要这张表：单卷上跑一百遍也看不出问题（题册 83 题一直很稳）。
 * 换一份卷立刻现形，但**现形的原因有两种**，混在一起就会修错东西：
 *   ① 输入质量（手机截图拼接、题号被截在页底、答案区标题图片化）→ 不该改引擎
 *   ② 引擎缺口（答案区无文本标题、栏间同源未归并）→ 该修
 * 判据不同、处置不同，所以先要一张能并排看的表。
 *
 * 用法：`npm run report:generalization`（只读，不写产物；结果同时落到
 * `data/out/generalization.md` 方便贴进文档）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join("data", "out");

interface Row {
  id: string;
  label: string;
  kind: string;
  pages: number;
  questions: number;
  groups: number;
  perPage: number;
  regressions: number;
  missingGroups: number;
  inkPct: number | null;
  contentUncovered: number;
  needsReview: number;
  /** 失败模式初判（机器能确定的那部分） */
  flags: string[];
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function rowOf(dir: string): Row | null {
  const qs = readJson<{ number: string; chapter?: string; sectionSeq?: number; status?: string }[]>(
    join(OUT, dir, "questions.json"),
  );
  const meta = readJson<{
    label?: string;
    kind?: string;
    stats?: { pages?: number; inkCoveragePct?: number | null; contentUncovered?: number };
  }>(join(OUT, dir, "meta.json"));
  if (!qs || !meta) return null;

  const groups = new Map<string, number[]>();
  for (const q of qs) {
    const k = `${q.chapter ?? "?"}|${q.sectionSeq ?? "?"}`;
    groups.set(k, [...(groups.get(k) ?? []), Number(q.number)]);
  }
  // 组内题号**回退**（1,3,2）= 阅读顺序或切题错乱的硬信号；缺号（1,2,4）可能只是源文档缺
  let regressions = 0;
  let missingGroups = 0;
  for (const nums of groups.values()) {
    const n = nums;
    for (let i = 1; i < n.length; i++) if (n[i]! <= n[i - 1]!) regressions++;
    const sorted = [...n].sort((a, b) => a - b);
    if (sorted.some((x, i) => x !== i + 1)) missingGroups++;
  }

  const pages = meta.stats?.pages ?? 0;
  const questions = qs.length;
  const perPage = pages ? questions / pages : 0;
  const inkPct = meta.stats?.inkCoveragePct ?? null;

  const flags: string[] = [];
  if (questions === 0) flags.push("无题");
  if (regressions > 0) flags.push(`题号回退 ${regressions}`);
  if (missingGroups > 0) flags.push(`缺号组 ${missingGroups}`);
  if (inkPct !== null && inkPct >= 8) flags.push("墨迹未覆盖偏高");
  if (pages >= 8 && perPage < 2.5) flags.push("题/页偏低");

  return {
    id: dir,
    label: meta.label ?? dir,
    kind: meta.kind ?? (/答案|解析/.test(dir) ? "answer" : "quiz"),
    pages,
    questions,
    groups: groups.size,
    perPage,
    regressions,
    missingGroups,
    inkPct,
    contentUncovered: meta.stats?.contentUncovered ?? 0,
    needsReview: qs.filter((q) => q.status === "needs_review").length,
    flags,
  };
}

function main(): void {
  if (!existsSync(OUT)) {
    console.error("没有 data/out —— 先跑 npm run daily 导入一份试卷");
    process.exit(2);
  }
  const rows: Row[] = [];
  for (const d of readdirSync(OUT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "bank" || d.name === "tags") continue;
    const r = rowOf(d.name);
    if (r) rows.push(r);
  }
  if (!rows.length) {
    console.error("data/out 里没有可统计的文档（缺 questions.json / meta.json）");
    process.exit(2);
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, "zh"));

  const head = "| 文档 | 类型 | 页 | 题 | 组 | 题/页 | 回退 | 缺号组 | 墨迹% | 内容级 | 待校对 | 初判 |";
  const sep = "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|";
  const body = rows.map((r) =>
    [
      "",
      r.label,
      r.kind === "quiz" ? "题册" : "答案册",
      r.pages,
      r.questions,
      r.groups,
      r.perPage.toFixed(1),
      r.regressions,
      r.missingGroups,
      r.inkPct === null ? "—" : r.inkPct.toFixed(2),
      r.contentUncovered,
      r.needsReview,
      r.flags.length ? r.flags.join("；") : "—",
      "",
    ].join(" | ").trim(),
  );

  const md = [
    "# 泛化矩阵（各卷切题质量并排）",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "判据说明：**回退** = 组内题号倒退（1,3,2）⇒ 阅读顺序或切题错乱，硬信号；",
    "**缺号组** = 组内不是 1..N（可能只是源文档缺号）；",
    "**题/页偏低**（< 2.5 且 ≥ 8 页）⇒ 大概率有题被合并（题号漏识别）。",
    "",
    head,
    sep,
    ...body,
    "",
    "## 怎么读这张表",
    "",
    "- **回退 > 0** ⇒ 引擎或阅读顺序问题，必须修。",
    "- **墨迹未覆盖 ≥ 8%** ⇒ 先怀疑输入质量（截图拼接/低分辨率），换一份源再比。",
    "- **题/页偏低 + 缺号组** ⇒ 题号被上游漏识别，看 `ocr-page-fill.json` 有没有该页全文；",
    "  没有就跑 `--all-pages`，有但读不到就是**双漏**（机器补不回来，只能如实报）。",
    "",
  ].join("\n");

  writeFileSync(join(OUT, "generalization.md"), md);
  console.log(md);
  console.log(`已落盘 ${join(OUT, "generalization.md")}`);
}

main();
