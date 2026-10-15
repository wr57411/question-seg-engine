// scripts/audit-numbering.ts
/**
 * 题号标注审计（**确定性判定项**，进 `npm run check`）。
 *
 * 目标（用户 2026-10-12 要求）：用**确定性、可锁死**的方式验证「所有题目都已被 100% 标注」，
 * 不能只依赖大模型的主观判断。所以这里的每一条判据都是**机器可判**的，且**与实现不同源**：
 * 判据从「源文本里客观存在的题号标记」出发，而不是复用引擎自己的结论。
 *
 * ## 判据分级（三级；**级别由判据本身决定，不由人决定**）
 *
 * **A. 判定项·不可豁免（UNEXEMPTIBLE）—— 出问题必红，且**不得出现在基线里**
 * - **N1 题号形态**：`number` 必须是纯阿拉伯数字（`（1）` 这类小问形态不是题号）。
 * - **N6 题号域**：题号必须是 `[1, 99]` 内的整数 —— **`0` 永远不是题号**。
 *
 * **B. 判定项·需证据豁免（HARD, evidence-gated）**
 * - **N7 组内单调**：同一 `(chapter, sectionSeq)` 组内，题号必须**严格递增**（允许缺号，
 *   因为教辅的 T 分组行本身列出的是 `1~2、4~5、7~8、10、12` 这种**有洞的集合**；
 *   但**不得回退** —— 「123456 后面突然跟一个 0」人一眼可见，机器也必须判死）。
 *   若原卷**真的**这么印，只能登记豁免，且豁免**必须附原卷核对证据**
 *   （`verified` 指向 `pages/` 下真实存在的页图；审计会校验文件存在）。
 *
 * **C. 可登记项（SOFT）—— 违规可能来自源文档本身的限制，逐条进基线，可追踪、可 review**
 * - **N2 唯一键**：`(chapter, sectionSeq, number)` 不得重复（教辅题号会在节边界/「专题/全章综合测试/
 *   真题自测」等块边界重启，同一节里会出现多个 `1`）。
 * - **N3 组内连续**：组内题号必须是 `1..N`（缺号=漏标，重号=误切）。
 * - **N4 逐页覆盖**：每页「源文本里以题号开头的块数」必须等于「该页起始的题数」。
 * - **N5 章节落地**：`chapter` / `sectionSeq` 必须存在（后台必须记录每道题所属章节）。
 *
 * **D. 门自身自检（N8，不可豁免）**
 * - 基线里**不得**出现 A 类判据（否则就是把判定项"登记"成了死门）；
 * - 基线里的 B 类豁免**必须**带有效 `verified` 证据（指向存在的页图）。
 *
 * ## 为什么要有这套分级（一次真实事故，2026-10-12）
 *
 * 答案册第 19 页出现了一道「第 0 题」：原文 `0.5~1.5 s内 mg sinθ−μmg cosθ=ma₂` 被 MinerU
 * 读碎成 `0.$5 \sim 1 . 5 …`，绕过了「半角点后接数字才算小数」的守卫（`$` 不是数字）。
 * 页面上表现为「6 后面跟一个 0」——**不合逻辑到人一眼可见**，而 N3 其实早就报了它
 * （`题号不是 1..N：实际 0,1,2,3,4,5,6,7`），却被人当作「源文档限制」**登记进了基线**
 * ⇒ 门照常绿灯。**「任何违规都能登记进基线」= 门迟早退化成死门。**
 * ⇒ 于是把「值域上不可能成立」的判据升级成不可豁免，并让硬豁免必须留下核对痕迹。
 *
 * ## 审计自身的覆盖缺口（G1 同样适用于门本身）
 *
 * - N4 的分子（源题号标记数）与引擎用的是**同一个词法规则**（`matchFirstLine`）：
 *   词法规则本身错时两侧会一起错 ⇒ **N4 对该类错误天然免疫**。N6/N7 正是为补这个洞
 *   （**值域**与**上下文单调性**都不依赖词法规则的正确性）。
 *   因此 N4 只证明「词法层认为存在的题号，全都切成了题」，**不**证明「词法层没冤枉源文本」。
 * - 词法层「冤枉源文本」的地面真值是**原卷页图**，机器判不了，只能靠人回原卷核对
 *   （本项目红线）。已知残留缺口：`1.$5 …`（1.5 被读碎）**仍会被判成题号 1** ——
 *   域约束只挡 0；此类行目前只能靠 N7（它会造成组内回退）间接暴露。
 *
 * 用法：`node --import tsx scripts/audit-numbering.ts [--update-baseline]`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchFirstLine } from "../src/patterns.js";

/** 待审计的文档（docId → 快照/题目所在目录） */
const DOCS = ["23必刷题 2相互作用", "第二章相互作用-答案与解析"];
const BASELINE_PATH = join("scripts", "numbering-baseline.json");

type Check = "N1" | "N2" | "N3" | "N4" | "N5" | "N6" | "N7" | "N8";

/** 不可豁免：机器能确定对错、且值域/自检上不可能成立 */
const UNEXEMPTIBLE: ReadonlySet<Check> = new Set<Check>(["N1", "N6", "N8"]);
/** 需证据豁免：判定项，但原卷可能真的如此印刷 —— 豁免必须附页图证据 */
const EVIDENCE_GATED: ReadonlySet<Check> = new Set<Check>(["N7"]);

interface Violation {
  doc: string;
  check: Check;
  /** 违规对象的可读定位（组键 / 页码 / 题号） */
  at: string;
  detail: string;
  /** 仅 EVIDENCE_GATED 判据用：原卷核对证据（`pages/page-16.png` 这类，审计校验存在） */
  verified?: string;
  /** 仅 EVIDENCE_GATED 判据用：一行说明原卷实际印的是什么 */
  note?: string;
}

interface Q {
  number: string;
  chapter?: string;
  sectionSeq?: number;
  section?: string;
  sectionNo?: string;
  source?: { pageIndex?: number; blockIndexes?: number[] };
}

const isDigits = (s: string) => /^\d{1,3}$/.test(s);
const isSubQuestionForm = (s: string) => /^[（(]\s*\d{1,2}\s*[)）]$/.test(s);
/** 题号合法值域：1..99（`0` 不是题号；三位数超出教辅任何真实编号习惯） */
const inDomain = (s: string) => isDigits(s) && Number(s) >= 1 && Number(s) <= 99;

/** 收集一份文档的全部违规 */
function auditDoc(doc: string): { violations: Violation[]; stats: string[]; suppressionNotes: string[] } {
  const dir = join("data", "out", doc);
  const qPath = join(dir, "questions.json");
  const sPath = join(dir, "stages.json");
  if (!existsSync(qPath) || !existsSync(sPath))
    return { violations: [], stats: [`${doc}: 数据缺失，跳过`], suppressionNotes: [] };
  const questions = JSON.parse(readFileSync(qPath, "utf8")) as Q[];
  const snap = JSON.parse(readFileSync(sPath, "utf8")) as {
    pages: { index: number; order: number[]; blocks: { text?: string }[] }[];
    reviews?: { reason?: string; blockIndex?: number }[];
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

  // N6 题号域：`0` / 非 1..99 —— **不可豁免**（2026-10-12 的「第 0 题」事故）
  for (const q of questions) {
    if (isDigits(q.number) && !inDomain(q.number)) {
      v.push({
        doc,
        check: "N6",
        at: `p${(q.source?.pageIndex ?? -1) + 1} #${q.number}`,
        detail: `题号 ${q.number} 不在合法值域 [1,99]（0 不是题号）`,
      });
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

  // N2/N3/N7 组内唯一 + 连续 + 单调
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
    // N7 组内单调：按阅读顺序（questions.json 即生成顺序），题号不得回退。
    // 缺号合法（T 分组行本身就是有洞的集合），回退不合法（「6 后面跟 0」）。
    const seq = gs.filter((q) => isDigits(q.number)).map((q) => Number(q.number));
    for (let i = 1; i < seq.length; i++) {
      if (seq[i]! <= seq[i - 1]!) {
        v.push({
          doc,
          check: "N7",
          at: k,
          detail: `组内题号回退：…${seq.slice(Math.max(0, i - 2), i + 2).join(",")}…（第 ${i} 项 ${seq[i - 1]} → ${seq[i]}；实际序列 ${seq.join(",")}）`,
        });
        break; // 一个组只报首处回退，避免同因刷屏
      }
    }
  }

  // N4 逐页覆盖：源标记数 == 该页起始题数（差额必须**有记录**，见下）
  //
  // 「不静默失败」在审计里的形式化：**每一个没变成题目的题号标记，都必须有一条可核对的记录**。
  // 引擎主动抑制某个题号标记时（如「方法技巧」方框内的编号条目，见 BOX_LIST_BULLET），
  // 会产出 `未作为题目` 的 ReviewNote。审计**独立**数「标记数」与「切题数」，
  // 只要求差额被这些记录解释 —— 所以它不是循环论证（差额无解释 ⇒ 红），
  // 也不需要审计再实现一遍方框判据（不堆砌重复实现）。
  const SUPPRESSED = /未作为题目/;
  const reviews = snap.reviews ?? [];
  const suppressedByPage = new Map<number, number>();
  let gOffset = 0;
  for (const page of snap.pages) {
    const lo = gOffset;
    const hi = lo + page.order.length; // 全局块序号区间 [lo, hi)
    suppressedByPage.set(
      page.index,
      reviews.filter(
        (r) =>
          SUPPRESSED.test(r.reason ?? "") &&
          typeof r.blockIndex === "number" &&
          r.blockIndex >= lo &&
          r.blockIndex < hi,
      ).length,
    );
    gOffset = hi;
  }

  let markers = 0;
  let explained = 0;
  const explainedPages: string[] = [];
  for (const page of snap.pages) {
    const onPage = page.blocks.filter((b) => {
      const m = matchFirstLine((b.text ?? "").split("\n")[0] ?? "");
      return m.kind === "question_no";
    }).length;
    const qOn = questions.filter((q) => q.source?.pageIndex === page.index).length;
    markers += onPage;
    if (onPage === qOn) continue;
    const recorded = suppressedByPage.get(page.index) ?? 0;
    if (onPage - qOn === recorded) {
      explained += recorded;
      explainedPages.push(`p${page.index + 1}:${recorded}`);
      continue;
    }
    v.push({
      doc,
      check: "N4",
      at: `p${page.index + 1}`,
      detail:
        `源题号 ${onPage} 个，切出 ${qOn} 道题；差额 ${onPage - qOn} 条中仅 ${recorded} 条有抑制记录` +
        `（无记录的差额 = 静默丢题）`,
    });
  }
  // 已记录抑制逐条列出（不埋在计数里）——审计输出即证据链
  const suppressionNotes: string[] = [];
  let gOff = 0;
  for (const page of snap.pages) {
    const lo = gOff;
    const hi = lo + page.order.length;
    for (const r of reviews) {
      if (SUPPRESSED.test(r.reason ?? "") && typeof r.blockIndex === "number" && r.blockIndex >= lo && r.blockIndex < hi) {
        suppressionNotes.push(`${doc} p${page.index + 1} — ${r.reason}`);
      }
    }
    gOff = hi;
  }
  stats.push(
    `${doc}: ${questions.length} 题 / ${groups.size} 组；源题号标记 ${markers} 个` +
      (markers === questions.length
        ? "（覆盖 100% ✓）"
        : `（差 ${markers - questions.length}：${explained} 条为已记录抑制 ${explainedPages.join(",")}）`),
  );
  return { violations: v, stats, suppressionNotes };
}

const updateBaseline = process.argv.includes("--update-baseline");
const all: Violation[] = [];
const stats: string[] = [];
const suppressionNotes: string[] = [];
for (const doc of DOCS) {
  const r = auditDoc(doc);
  all.push(...r.violations);
  stats.push(...r.stats);
  suppressionNotes.push(...r.suppressionNotes);
}

const baseline: Violation[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Violation[])
  : [];
const key = (x: Violation) => `${x.doc}|${x.check}|${x.at}|${x.detail}`;
const known = new Map(baseline.map((x) => [key(x), x]));
// ⚠️ 必须 `key(x)`：写成 `known.has(key)` 会恒为 false ⇒ 每次全量报「新增」，门形同虚设
const fresh = all.filter((x) => !known.has(key(x)));
// 审计必须**确定**：同一份数据两次跑出的违规集合必须一致（否则门会假红/假绿）。
// 设 `AUDIT_DUMP=<path>` 可把本次违规集合转储出来做两次 diff。
if (process.env.AUDIT_DUMP) {
  writeFileSync(process.env.AUDIT_DUMP, JSON.stringify(all.map((x) => key(x)).sort(), null, 1) + "\n");
}

/** N8 门自身自检：基线条目本身是否合法（不可豁免项 / 缺证据的硬豁免） */
const selfCheck: Violation[] = [];
for (const b of baseline) {
  if (UNEXEMPTIBLE.has(b.check)) {
    selfCheck.push({
      doc: "(基线)",
      check: "N8",
      at: `${b.doc} ${b.check} ${b.at}`,
      detail: `基线条目属**不可豁免**判据（${b.check}）—— 这是把门登记成死门的路径，必须删除该条目并修引擎`,
    });
  }
  if (EVIDENCE_GATED.has(b.check)) {
    const ev = b.verified ?? "";
    const evPath = join("data", "out", b.doc, ev);
    if (!ev || !existsSync(evPath)) {
      selfCheck.push({
        doc: "(基线)",
        check: "N8",
        at: `${b.doc} ${b.check} ${b.at}`,
        detail: `硬豁免缺原卷核对证据：verified=${JSON.stringify(ev)}${ev ? "（文件不存在）" : ""}，须指向 data/out/${b.doc}/pages/ 下的真实页图`,
      });
    }
  }
}

console.log("题号标注审计");
for (const s of stats) console.log(`  ${s}`);
if (suppressionNotes.length) {
  console.log(`  已记录抑制（题号形态但未切题，逐条可核对）：`);
  for (const n of suppressionNotes) console.log(`    · ${n}`);
}
const exemptSoft = all.filter((x) => known.has(key(x)) && !UNEXEMPTIBLE.has(x.check) && !EVIDENCE_GATED.has(x.check));
const exemptHard = all.filter((x) => known.has(key(x)) && EVIDENCE_GATED.has(x.check));
console.log(
  `  违规 ${all.length} 条（基线 ${baseline.length} 条：可登记项豁免 ${exemptSoft.length} 条、` +
    `带证据硬豁免 ${exemptHard.length} 条；本次新增 ${fresh.length} 条）`,
);
if (exemptHard.length) {
  console.log("  带证据硬豁免（判定项 N7，原卷确实如此印刷）：");
  for (const x of exemptHard) console.log(`    · ${x.doc} ${x.at} — ${known.get(key(x))?.note ?? "(缺 note)"} [${known.get(key(x))?.verified}]`);
}
for (const x of fresh.slice(0, 40)) console.log(`  ✗ [${x.check}] ${x.doc} ${x.at} — ${x.detail}`);
if (fresh.length > 40) console.log(`  … 另有 ${fresh.length - 40} 条`);
for (const x of selfCheck) console.log(`  ✗ [${x.check}] ${x.at} — ${x.detail}`);

if (updateBaseline) {
  // 保留已登记的豁免证据（`--update-baseline` 不负责替人做原卷核对）
  const carried = all.map((x) => {
    const prev = known.get(key(x));
    return prev ? { ...x, verified: prev.verified, note: prev.note } : x;
  });
  writeFileSync(BASELINE_PATH, JSON.stringify(carried, null, 1) + "\n");
  const needEvidence = carried.filter((x) => EVIDENCE_GATED.has(x.check) && !x.verified);
  console.log(`  已写入基线 ${BASELINE_PATH}（${carried.length} 条）`);
  if (needEvidence.length) {
    console.log("  ⚠️ 以下硬豁免**尚无原卷核对证据**，门会保持红，须人工回原卷核对后补 verified/note：");
    for (const x of needEvidence) console.log(`    · ${x.doc} ${x.check} ${x.at} — ${x.detail}`);
  }
  if (selfCheck.length) process.exit(1);
  process.exit(0);
}
if (selfCheck.length) {
  console.log("  ⇒ 判定项失败：基线自身不合法（见 N8）");
  process.exit(1);
}
if (fresh.length) {
  console.log("  ⇒ 判定项失败：出现基线外的新违规（基线内的是已登记的源文档限制）");
  process.exit(1);
}
console.log("  判定项全部通过 ✅（可登记项豁免逐条在 scripts/numbering-baseline.json；硬豁免均附原卷核对证据）");
