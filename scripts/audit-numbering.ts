// scripts/audit-numbering.ts
/**
 * 题号标注审计（**确定性判定项**，进 `npm run check`）。
 *
 * 目标（用户 2026-10-12 要求）：用**确定性、可锁死**的方式验证「所有题目都已被 100% 标注」，
 * 不能只依赖大模型的主观判断。所以这里的每一条判据都是**机器可判**的，且**与实现不同源**：
 * 判据从「源文本里客观存在的题号标记」出发，而不是复用引擎自己的结论。
 *
 * ## 判定项（任一失败 → 退出码 1）
 *
 * - **N1 题号形态**：每题的 `number` 必须是**纯阿拉伯数字**；`（1）` 这类小问形态**不是题号**
 *   （历史上小问被当题切开，答案册出现 21 个假题、题册 2 个）。
 * - **N2 唯一键**：`(chapter, sectionSeq, number)` 不得重复。
 *   教辅里题号会在**节边界**和「专题/全章综合测试/真题自测」等块边界重启，
 *   实测同一节内会出现多个 `1` ⇒ 只用题号做键必然撞车。
 * - **N3 组内连续**：每个 `(chapter, sectionSeq)` 组内，题号必须**恰好**是 `1..N`
 *   —— 缺号 = 漏标，重号 = 误切。这是「一个都不漏」的核心判据。
 * - **N4 逐页覆盖**：每页**源文本里以题号开头的块数**必须等于**该页起始的题数**。
 *   这条不看引擎内部状态，只看「源里有几个题号、切出几道题」——100% 覆盖的直接证据。
 * - **N5 章节落地**：`chapter` / `sectionSeq` 必须存在（后台必须记录每道题所属章节）。
 *
 * ## 基线（known exceptions）
 *
 * 有些违规是**源文档本身的限制**，不是引擎缺陷，例如：
 * - 答案册是从合订本里截出的片段，开头几页属于**上一章**（章标题不在片段里 ⇒ `chapter` 为空）；
 * - MinerU 漏识别某个题号块（源里根本没有该标记）。
 * 这类逐条写进 `scripts/numbering-baseline.json`（**可追踪、可 review**），
 * 新出现的违规仍然会让门变红 ⇒ 门不会退化成「死门」。
 *
 * 用法：`node --import tsx scripts/audit-numbering.ts [--update-baseline]`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchFirstLine } from "../src/patterns.js";

/** 待审计的文档（docId → 快照/题目所在目录） */
const DOCS = ["23必刷题 2相互作用", "第二章相互作用-答案与解析"];
const BASELINE_PATH = join("scripts", "numbering-baseline.json");

interface Violation {
  doc: string;
  check: "N1" | "N2" | "N3" | "N4" | "N5";
  /** 违规对象的可读定位（组键 / 页码） */
  at: string;
  detail: string;
}

interface Q {
  number: string;
  chapter?: string;
  sectionSeq?: number;
  section?: string;
  sectionNo?: string;
  source?: { pageIndex?: number };
}

const isDigits = (s: string) => /^\d{1,3}$/.test(s);
const isSubQuestionForm = (s: string) => /^[（(]\s*\d{1,2}\s*[)）]$/.test(s);

/** 收集一份文档的全部违规 */
function auditDoc(doc: string): { violations: Violation[]; stats: string[] } {
  const dir = join("data", "out", doc);
  const qPath = join(dir, "questions.json");
  const sPath = join(dir, "stages.json");
  if (!existsSync(qPath) || !existsSync(sPath)) return { violations: [], stats: [`${doc}: 数据缺失，跳过`] };
  const questions = JSON.parse(readFileSync(qPath, "utf8")) as Q[];
  const snap = JSON.parse(readFileSync(sPath, "utf8")) as {
    pages: { index: number; blocks: { text?: string }[] }[];
  };
  const v: Violation[] = [];
  const stats: string[] = [];

  // N1 题号形态
  for (const q of questions) {
    if (isSubQuestionForm(q.number)) {
      v.push({ doc, check: "N1", at: q.number, detail: "小问形态被当成题号" });
    } else if (!isDigits(q.number)) {
      v.push({ doc, check: "N1", at: JSON.stringify(q.number), detail: "题号不是纯阿拉伯数字" });
    }
  }

  // N5 章节落地
  for (const q of questions) {
    if (typeof q.sectionSeq !== "number") {
      v.push({ doc, check: "N5", at: q.number, detail: "缺 sectionSeq（编号组序号）" });
    }
    if (!q.chapter) {
      v.push({ doc, check: "N5", at: `p${(q.source?.pageIndex ?? -1) + 1} #${q.number}`, detail: "缺 chapter（章标题不在文档内）" });
    }
  }

  // N2/N3 组内唯一 + 连续
  const groups = new Map<string, Q[]>();
  for (const q of questions) {
    const k = `${q.chapter ?? "?"}|${q.sectionSeq ?? "?"}`;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  for (const [k, gs] of groups) {
    const nums = gs.map((q) => q.number);
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
    if (dup.length) v.push({ doc, check: "N2", at: k, detail: `组内重号 ${[...new Set(dup)].join(",")}` });
    const ints = [...new Set(nums.filter(isDigits).map(Number))].sort((a, b) => a - b);
    const expect = Array.from({ length: ints.length }, (_, i) => i + 1);
    if (ints.join(",") !== expect.join(",")) {
      v.push({ doc, check: "N3", at: k, detail: `题号不是 1..N：实际 ${ints.join(",")}` });
    }
  }

  // N4 逐页覆盖：源标记数 == 该页起始题数
  let markers = 0;
  for (const page of snap.pages) {
    const onPage = page.blocks.filter((b) => {
      const m = matchFirstLine((b.text ?? "").split("\n")[0] ?? "");
      return m.kind === "question_no";
    }).length;
    const qOn = questions.filter((q) => q.source?.pageIndex === page.index).length;
    markers += onPage;
    if (onPage !== qOn) {
      v.push({ doc, check: "N4", at: `p${page.index + 1}`, detail: `源题号 ${onPage} 个，切出 ${qOn} 道题` });
    }
  }
  stats.push(
    `${doc}: ${questions.length} 题 / ${groups.size} 组；源题号标记 ${markers} 个` +
      (markers === questions.length ? "（覆盖 100% ✓）" : `（差 ${markers - questions.length}）`),
  );
  return { violations: v, stats };
}

const updateBaseline = process.argv.includes("--update-baseline");
const all: Violation[] = [];
const stats: string[] = [];
for (const doc of DOCS) {
  const r = auditDoc(doc);
  all.push(...r.violations);
  stats.push(...r.stats);
}

const baseline: Violation[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Violation[])
  : [];
const key = (x: Violation) => `${x.doc}|${x.check}|${x.at}|${x.detail}`;
const known = new Set(baseline.map((x) => key(x)));
// ⚠️ 必须 `key(x)`：写成 `known.has(key)` 会恒为 false ⇒ 每次全量报「新增」，门形同虚设
const fresh = all.filter((x) => !known.has(key(x)));
// 审计必须**确定**：同一份数据两次跑出的违规集合必须一致（否则门会假红/假绿）。
// 设 `AUDIT_DUMP=<path>` 可把本次违规集合转储出来做两次 diff。
if (process.env.AUDIT_DUMP) {
  writeFileSync(process.env.AUDIT_DUMP, JSON.stringify(all.map((x) => key(x)).sort(), null, 1) + "\n");
}

console.log("题号标注审计");
for (const s of stats) console.log(`  ${s}`);
console.log(`  违规 ${all.length} 条（基线 ${baseline.length} 条；本次新增 ${fresh.length} 条）`);
for (const x of fresh.slice(0, 40)) console.log(`  ✗ [${x.check}] ${x.doc} ${x.at} — ${x.detail}`);
if (fresh.length > 40) console.log(`  … 另有 ${fresh.length - 40} 条`);

if (updateBaseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(all, null, 1) + "\n");
  console.log(`  已写入基线 ${BASELINE_PATH}（${all.length} 条）`);
  process.exit(0);
}
if (fresh.length) {
  console.log("  ⇒ 判定项失败：出现基线外的新违规（基线内的是已登记的源文档限制）");
  process.exit(1);
}
console.log("  判定项全部通过 ✅（基线内的违规已逐条登记在 scripts/numbering-baseline.json）");
