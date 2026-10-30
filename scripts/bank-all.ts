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
 * ## 候选答案册怎么选（2026-10-29 起：显式绑定，不再自动猜）
 *
 * 旧做法是「章节有交集 + 题数差最小」自动选。它有一个致命盲区：**不同书可能共享章号**。
 * 实测 `物理_教材基础练 曲线运动` 与 `高考必刷题合订本` 都有第四章 ⇒ 键 `(章,块号,题号)`
 * 撞上就配，结构校验（保序/守恒/唯一键/图片守恒）全过，内容却是别的题
 * （题干问「xOy 平面合运动」，配到的解析讲「曲线运动基本概念」）。
 *
 * 现在改为：
 * 1. **只配 `bank-bindings.json` 里登记的题册**（`bindings`）；
 * 2. 明确排除的写 `excluded`（含理由，可审计）；已知不配的写 `unbound`；
 * 3. **未登记的题册一律不配**，报告里写「未登记（不猜）」——宁可少配，不可错配。
 * 4. 配完再用**独立内容尺子**（`scripts/pair-quality.ts`，只看题干与解析的文本重合，
 *    与配对键零耦合）复核整册：中位重合 < 0.12 ⇒ 判为跨书错配，退出码 1。
 *
 * 用法：`npm run bank:all`（有违规 → 退出码 1）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PAIR_QUALITY_MIN, pairQualityByDoc } from "./pair-quality.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "data", "out");
const BANK_DIR = join(OUT, "bank");
const BINDINGS_PATH = join(ROOT, "bank-bindings.json");

interface Bindings {
  bindings: {
    quiz: string;
    answer: string;
    verified?: boolean;
    metric?: number;
    note?: string;
    /**
     * **题册侧显式章号**（`DECISIONS §81`）：该册 PDF 本身没有章标题时（如夸克拍的光学 8 页节选），
     * 引擎把 `chapter` 留空，配对键永远进不了任何章。显式声明后由 `build-bank --quiz-chapter` 补上，
     * 只补空章号的题。不信推断 —— 补章号必须显式绑定（`§6-24`）。
     */
    quizChapter?: string;
  }[];
  excluded: { quiz: string; answer?: string; reason: string }[];
  unbound: { quiz: string; reason: string }[];
}

interface DocMeta {
  id: string;
  label: string;
  kind: "quiz" | "answer";
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

interface PairResult {
  quizDoc: string;
  quizLabel: string;
  ansDoc: string;
  ansLabel: string;
  bank: unknown[];
  ok: boolean;
  output: string;
}

function runPair(quiz: DocMeta, ans: DocMeta, outJson: string, quizChapter?: string): PairResult {
  let ok = true;
  let output = "";
  try {
    output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts", "build-bank.ts"),
        "--quiz",
        quiz.id,
        "--answer",
        ans.id,
        "--out",
        outJson,
        ...(quizChapter ? ["--quiz-chapter", quizChapter] : []),
      ],
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

  const bindings = readJson<Bindings>(BINDINGS_PATH);
  if (!bindings) {
    console.error(`缺少或无法解析 ${BINDINGS_PATH} —— 配对必须显式绑定（不猜），先补这个文件`);
    process.exit(2);
  }

  const quizById = new Map(quiz.map((q) => [q.id, q]));
  const answerById = new Map(answer.map((a) => [a.id, a]));
  const boundQuiz = new Set<string>();

  const tmp = mkdtempSync(join(tmpdir(), "bank-all-"));
  const results: PairResult[] = [];
  const skipped: { doc: string; label: string; reason: string }[] = [];

  // 1) 只配显式绑定的组合
  for (const b of bindings.bindings) {
    const q = quizById.get(b.quiz);
    const a = answerById.get(b.answer);
    if (!q || !a) {
      // 绑定表指向了不存在的册 ⇒ 必须响亮失败，不能静默少配一本
      console.error(
        `❌ bank-bindings.json 绑定了不存在的册：quiz=${b.quiz}(${q ? "有" : "缺"}) × answer=${b.answer}(${a ? "有" : "缺"})`,
      );
      process.exit(2);
    }
    boundQuiz.add(b.quiz);
    const outJson = join(tmp, `${results.length}.json`);
    console.log(`\n=== ${q.label} × ${a.label}（显式绑定${b.verified ? "" : "，⚠️ 未核对"}） ===`);
    const r = runPair(q, a, outJson, b.quizChapter);
    for (const line of r.output.split("\n")) {
      if (/配对成功|未配对|✅|✗|违规/.test(line)) console.log(`  ${line.trim()}`);
    }
    results.push(r);
  }

  // 2) 明确排除 / 已知不配 / 未登记：全部进报告，不静默
  for (const x of bindings.excluded) {
    const q = quizById.get(x.quiz);
    skipped.push({ doc: x.quiz, label: q?.label ?? x.quiz, reason: `**已排除**（不配）：${x.reason}` });
    boundQuiz.add(x.quiz);
  }
  for (const u of bindings.unbound) {
    const q = quizById.get(u.quiz);
    skipped.push({ doc: u.quiz, label: q?.label ?? u.quiz, reason: `未绑定：${u.reason}` });
    boundQuiz.add(u.quiz);
  }
  for (const q of quiz) {
    if (boundQuiz.has(q.id)) continue;
    if (/-OXR$/i.test(q.id) || /-MinerU$/i.test(q.id)) {
      skipped.push({ doc: q.id, label: q.label, reason: "同书的另一种解析（实验产物），按约定不进配对" });
      continue;
    }
    skipped.push({ doc: q.id, label: q.label, reason: "**未登记**（不猜）：`bank-bindings.json` 里没有它，补登记后才配" });
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

  // 独立内容尺子：结构校验过了不代表配的是同一道题（DECISIONS §72）
  const quality = pairQualityByDoc(
    merged as { quizDoc?: string; stem?: string; answerText?: string }[],
  );
  const badQuality = [...quality.values()].filter((q) => !q.ok);

  const rows = results.map((r) => {
    const q = quality.get(r.quizDoc);
    const verdict = !r.ok ? "✗ 校验未通过" : q && !q.ok ? `✗ 内容尺子 ${q.median.toFixed(3)}` : "✅";
    const metric = q ? `中位重合 ${q.median.toFixed(3)}` : "—";
    return `| ${r.quizLabel} | ${r.ansLabel} | ${r.bank.length} | ${metric} | ${verdict} |`;
  });
  const report = [
    "# 题库配对（多册）",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "> 配对**只按 `bank-bindings.json` 的显式绑定**，不再按章交集自动猜（`DECISIONS §72`）。",
    "> 「中位重合」是独立内容尺子（题干与答案解析的文本重合，与配对键无关），阈值 " +
      `**${PAIR_QUALITY_MIN}**；低于它即判跨书错配。`,
    "",
    "| 题册 | 答案册 | 配对条数 | 内容尺子 | 单册校验 |",
    "|---|---|---:|---|---|",
    ...rows,
    ...skipped.map((s) => `| ${s.label} | — | 0 | — | 跳过：${s.reason} |`),
    "",
    `**合计 ${merged.length} 条**；唯一键重复 ${dup.length} 条${dup.length ? `（${[...new Set(dup)].slice(0, 5).join(", ")}）` : ""}；` +
      `归属对不上 ${orphan.length} 条${orphan.length ? `（${orphan.slice(0, 3).join("、")}）` : "（每条 quizId 都能在该册 questions.json 找到）"}；` +
      `内容尺子不合格 ${badQuality.length} 册${badQuality.length ? `（${badQuality.map((b) => `${b.doc} ${b.median.toFixed(3)}`).join("、")}）` : ""}。`,
    "",
    "> 配对逻辑只有一份（`scripts/build-bank.ts`）；本脚本只负责「选哪一对 + 合并 + 复核」。",
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
  if (dup.length || failed.length || orphan.length || badQuality.length) {
    console.error(
      `\n❌ 多册配对未通过：唯一键重复 ${dup.length} 条，单册校验失败 ${failed.length} 册，` +
        `归属对不上 ${orphan.length} 条，内容尺子不合格 ${badQuality.length} 册` +
        (badQuality.length ? `（${badQuality.map((b) => `${b.doc} ${b.median.toFixed(3)}`).join("、")}）` : ""),
    );
    process.exit(1);
  }
  console.log(`✅ 多册配对通过：${merged.length} 条，唯一键无重复，内容尺子全部达标`);
}

main();
