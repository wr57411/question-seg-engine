// numbering-cross-gate.test.ts —— `§99` 登记表（baseline）语义回归。
//
// 守的是**入闸的正确性**，不是判据本身（判据见 numbering-cross.test.ts）：
// 1. 已登记的命中不得让门变红 —— 否则 17 条已知缺陷会让 `check` 永远红，
//    结果必然是「习惯性忽略」= 等于没装（`tasks/lessons.md` L2）；
// 2. **未**登记的新命中必须红 —— 否则这套审计对回归完全无感；
// 3. `--report` 只出清单、永远 exit 0（排查用）；
// 4. 已登记但本次不再命中 ⇒ 只提示「请从登记表移除」，不算失败（修好了是好事）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

// 测试产物一律落在 tmp/（仓库已 gitignore），不污染根目录
const BASE = join("tmp", "test-numbering-cross-gate");
const ROOT = join(BASE, "out");
const BASELINE = join(BASE, "baseline.json");
const SCRIPT = join("scripts", "audit-numbering-cross.ts");

const run = (args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8" });

function doc(name: string, ocrLine: string, layoutText: string, stem: string): void {
  const d = join(ROOT, name);
  mkdirSync(join(d, "ocr-page"), { recursive: true });
  writeFileSync(join(d, "ocr-page", "p01.txt"), `${ocrLine}\n`, "utf8");
  writeFileSync(
    join(d, "layout.json"),
    JSON.stringify({
      pdf_info: [{ para_blocks: [{ lines: [{ spans: [{ content: layoutText }] }] }] }],
    }),
    "utf8",
  );
  writeFileSync(join(d, "questions.json"), JSON.stringify({ questions: [{ number: "1", stem }] }), "utf8");
}

rmSync(BASE, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// A：正文在 layout 里没有 ⇒ X1
doc("A册", "1[人教版必修一 P1 第1题情境变式]如图所示一盛有水的容器自倾角为", "完全无关的版面文字", "");
// B：正文在 layout 里有、题池里没有 ⇒ X2
doc("B册", "2[人教版必修二 P2 第2题条件变式]光滑水平面上有一小车正在匀速运动", "光滑水平面上有一小车正在匀速运动", "另一道不相干的题");

after(() => rmSync(BASE, { recursive: true, force: true }));

test("--update-baseline：按当前命中写登记表", () => {
  const r = run(["--root", ROOT, "--baseline", BASELINE, "--update-baseline"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已写入登记表/);
});

test("已登记 ⇒ 闸门不红（已知缺陷不应让 check 永远红）", () => {
  const r = run(["--root", ROOT, "--baseline", BASELINE]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /新增 0/);
});

test("未登记的新命中 ⇒ exit 1（这才是回归）", () => {
  doc("C册", "3[人教版必修三 P3 第3题模型变式]如图所示斜面上有一物块受到外力作用", "毫不相干", "");
  const r = run(["--root", ROOT, "--baseline", BASELINE]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /未登记的新命中/);
  assert.match(r.stdout, /C册/);
});

test("--report：只出清单，永远 exit 0", () => {
  const r = run(["--root", ROOT, "--baseline", BASELINE, "--report"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /未登记的新命中/); // 仍然把新命中打出来，只是不判失败
});

test("已登记但本次未命中 ⇒ 提示移除，不算失败", () => {
  writeFileSync(
    BASELINE,
    JSON.stringify([{ doc: "早已不存在册", check: "X1", at: "p1 #1", body: "某个正文前缀" }]),
    "utf8",
  );
  const r = run(["--root", ROOT, "--baseline", BASELINE]);
  assert.match(r.stdout, /请删掉对应条目|请从登记表移除|未命中/);
});
