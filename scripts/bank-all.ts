// scripts/bank-all.ts
/**
 * 多册配对：把 `data/out/` 下**每一份题册**配到答案池里最合适的答案册上。
 *
 * ## 为什么需要它（2026-10-27）
 *
 * `build-bank.ts` 只认**一对**硬编码文档（`23必刷题 2相互作用` × `第二章相互作用-答案与解析`）。
 * 用户把 6 本题册 + 1 本 187 页合订本答案放进 `books/` 之后，这个限制就成了死结：
 * 答案全在合订本里，单对模式一本都配不上。
 *
 * ## 做法（配对逻辑只留一份）
 *
 * 本脚本**不重新实现**块级对齐 —— 它对每个「题册 × 候选答案册」组合**调用一次
 * `build-bank.ts`**（子进程，`--out` 到临时文件），然后合并。理由：块级对齐那套判据
 * （单调 DP、得分函数、守恒校验）已经过 83/83 的验证，重写一遍必然漂移。
 *
 * ## 候选答案册怎么选（确定性，不猜）
 *
 * 1. 只考虑**章节有交集**的答案册；
 * 2. 取「该章题数与题册该章题数之差绝对值」最小的那个（题数最接近 = 最可能是同一份卷）；
 * 3. 平局按 docId 字典序（保证可复现）。
 * 选不出候选 ⇒ 该题册**整册记为未配对**，原因写进报告（不静默）。
 *
 * 用法：`npm run bank:all`（有违规 → 退出码 1）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "data", "out");
const BANK_DIR = join(OUT, "bank");

interface DocMeta {
  id: string;
  label: string;
  kind: "quiz" | "answer";
}

interface Q {
  number: string;
  chapter?: string;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 发现可用文档：只认有 meta.json + questions.json 的目录（没体检过的不猜类型） */
function discover(): { quiz: DocMeta[]; answer: DocMeta[] } {
  const quiz: DocMeta[] = [];
  const answer: DocMeta[] = [];
  for (const d of readdirSync(OUT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "bank" || d.name === "tags") continue;
    // 跳过「同书的另一种解析」这类实验产物（如 OXR 实验的 `xxx-OXR`）：
    // 它们与正式册是同一本书，同时进配对会让同题出现两条记录、统计虚高
    // （2026-10-28 实测：混入后 419 → 476）。
    if (/-OXR$/i.test(d.name)) continue;
    const meta = readJson<{ label?: string; kind?: string }>(join(OUT, d.name, "meta.json"));
    if (!meta || !existsSync(join(OUT, d.name, "questions.json"))) continue;
    const item: DocMeta = {
      id: d.name,
      label: meta.label ?? d.name,
      kind: meta.kind === "answer" ? "answer" : "quiz",
    };
    (item.kind === "answer" ? answer : quiz).push(item);
  }
  return { quiz, answer };
}

/** 该册每章的题数 */
function chapterCounts(doc: string): Map<string, number> {
  const qs = readJson<Q[]>(join(OUT, doc, "questions.json")) ?? [];
  const m = new Map<string, number>();
  for (const q of qs) {
    const ch = q.chapter ?? "";
    m.set(ch, (m.get(ch) ?? 0) + 1);
  }
  return m;
}

interface PairResult {
  quizDoc: string;
  quizLabel: string;
  ansDoc: string;
  ansLabel: string;
  bank: unknown[];
  ok: boolean;
  output: string;
}

function runPair(quiz: DocMeta, ans: DocMeta, outJson: string): PairResult {
  let ok = true;
  let output = "";
  try {
    output = execFileSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts", "build-bank.ts"), "--quiz", quiz.id, "--answer", ans.id, "--out", outJson],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    ok = false;
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
  }
  const bank = readJson<unknown[]>(outJson) ?? [];
  return { quizDoc: quiz.id, quizLabel: quiz.label, ansDoc: ans.id, ansLabel: ans.label, bank, ok, output };
}

function main(): void {
  const { quiz, answer } = discover();
  if (!quiz.length) {
    console.error("没有可配对的题册（data/out 里没有 kind=quiz 且有 questions.json 的文档）");
    process.exit(2);
  }
  if (!answer.length) {
    console.error("没有答案册（data/out 里没有 kind=answer 的文档）");
    process.exit(2);
  }

  const tmp = mkdtempSync(join(tmpdir(), "bank-all-"));
  const results: PairResult[] = [];
  const skipped: { doc: string; label: string; reason: string }[] = [];

  for (const q of quiz) {
    const qCh = chapterCounts(q.id);
    // 候选：章节有交集的答案册
    const cands = answer
      .map((a) => {
        const aCh = chapterCounts(a.id);
        let overlap = 0;
        let diff = 0;
        for (const [ch, n] of qCh) {
          // 只认**真章号**：空串 / `?` 是「该册没识别到章标题」，两册的 `?` 组各有各的残留，
          // 按它对齐会造出假配对（2026-10-27 实测：曲线运动/光学各误配 4 条）。
          if (!ch || ch === "?") continue;
          if (!aCh.has(ch)) continue;
          overlap++;
          diff += Math.abs((aCh.get(ch) ?? 0) - n);
        }
        return { a, overlap, diff };
      })
      .filter((c) => c.overlap > 0)
      .sort((x, y) => x.diff - y.diff || x.a.id.localeCompare(y.a.id, "zh"));

    if (!cands.length) {
      const realCh = [...qCh.keys()].filter((c) => c && c !== "?").sort();
      skipped.push({
        doc: q.id,
        label: q.label,
        reason: realCh.length
          ? `答案池里没有任何册含它的章节（${realCh.join("、")}）`
          : "该册**没有识别到章标题**（chapter 为空）⇒ 无法按章对齐，不猜",
      });
      continue;
    }
    const best = cands[0]!;
    const outJson = join(tmp, `${results.length}.json`);
    console.log(`\n=== ${q.label} × ${best.a.label}（章交集 ${best.overlap}，题数差 ${best.diff}） ===`);
    const r = runPair(q, best.a, outJson);
    // 把子进程的关键行透出来（不吞输出）
    for (const line of r.output.split("\n")) {
      if (/配对成功|未配对|✅|✗|违规/.test(line)) console.log(`  ${line.trim()}`);
    }
    results.push(r);
  }

  // 合并：key 加 quizDoc 前缀（不同题册可能都有「第2章」，块序号会撞）
  const merged: Record<string, unknown>[] = [];
  for (const r of results) {
    for (const e of r.bank as Record<string, unknown>[]) {
      merged.push({ ...e, quizDoc: r.quizDoc, answerDoc: r.ansDoc, key: `${r.quizDoc}|${String(e.key)}` });
    }
  }

  // 全局唯一键
  const dup = merged.map((e) => e.key).filter((k, i, a) => a.indexOf(k) !== i);

  // 归属自检：每条配对的 `quizId` 必须能在该册 questions.json 里找到 ——
  // 否则成品页点号牌会「查不到这道题」（2026-10-15 踩过同类：面板渲染成 undefined）。
  const idSets = new Map<string, Set<string>>();
  const orphan: string[] = [];
  for (const e of merged) {
    const doc = String(e.quizDoc);
    if (!idSets.has(doc)) {
      const qs = readJson<{ id: string }[]>(join(OUT, doc, "questions.json")) ?? [];
      idSets.set(doc, new Set(qs.map((q) => q.id)));
    }
    if (!idSets.get(doc)!.has(String(e.quizId))) orphan.push(`${doc} ${String(e.quizId)}`);
  }
  // 每册守恒：题册题数 = 该册配对 + 该册未配对（未配对由子进程报告，这里只能核配对上限）
  const perQuiz = new Map<string, number>();
  for (const e of merged) perQuiz.set(String(e.quizDoc), (perQuiz.get(String(e.quizDoc)) ?? 0) + 1);

  mkdirSync(BANK_DIR, { recursive: true });
  writeFileSync(join(BANK_DIR, "bank.json"), JSON.stringify(merged, null, 1));

  const rows = results.map(
    (r) => `| ${r.quizLabel} | ${r.ansLabel} | ${r.bank.length} | ${r.ok ? "✅" : "✗ 校验未通过"} |`,
  );
  const report = [
    "# 题库配对（多册）",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "| 题册 | 答案册 | 配对条数 | 单册校验 |",
    "|---|---|---:|---|",
    ...rows,
    ...skipped.map((s) => `| ${s.label} | — | 0 | 跳过：${s.reason} |`),
    "",
    `**合计 ${merged.length} 条**；唯一键重复 ${dup.length} 条${dup.length ? `（${[...new Set(dup)].slice(0, 5).join(", ")}）` : ""}；` +
      `归属对不上 ${orphan.length} 条${orphan.length ? `（${orphan.slice(0, 3).join("、")}）` : "（每条 quizId 都能在该册 questions.json 找到）"}。`,
    "",
    "> 配对逻辑只有一份（`scripts/build-bank.ts`）；本脚本只负责「选哪一对 + 合并」。",
    "> 每册的详细报告见 `data/out/bank/<quizDoc>.report.md`。",
    "",
  ].join("\n");
  writeFileSync(join(BANK_DIR, "report.md"), report);

  // 各册明细另存一份，避免合并报告丢掉块级对齐证据
  for (const r of results) {
    const src = join(tmp, `${results.indexOf(r)}.report.md`);
    if (existsSync(src)) writeFileSync(join(BANK_DIR, `${r.quizDoc}.report.md`), readFileSync(src, "utf8"));
  }

  console.log(`\n${report}`);
  rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  if (dup.length || failed.length || orphan.length) {
    console.error(
      `\n❌ 多册配对未通过：唯一键重复 ${dup.length} 条，单册校验失败 ${failed.length} 册，` +
        `归属对不上 ${orphan.length} 条`,
    );
    process.exit(1);
  }
  console.log(`✅ 多册配对通过：${merged.length} 条，唯一键无重复`);
}

main();
