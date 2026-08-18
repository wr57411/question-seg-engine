/**
 * engine.test.ts —— 核心机制验收用例
 *
 * 覆盖：单栏全链路、双栏顺序恢复、小题列表行不切题、公式/图片归属、
 * 题号重复误切的 needs_review 标记、答案区解析归属。
 * 运行：npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";
import { segmentFromContentList } from "../src/index.js";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

// ---------- 语言层 ----------

test("语言层：题号/选项/大题/答案区模式", () => {
  const cases: [string, string][] = [
    ["1．设集合 A = {x}，则…", "question_no"],
    ["（1）求 a 的值；", "question_no"],
    ["三、解答题（本大题共 3 小题）", "section"],
    ["参考答案", "answer_zone"],
    ["A．√2", "option"],
    ["当且仅当 x > 0 时…", "other"],
  ];
  for (const [line, kind] of cases) {
    assert.equal(matchFirstLine(line).kind, kind, `行「${line}」应为 ${kind}`);
  }
});

test("语言层：一行（1）…（2）… 的小题列表行不切题", () => {
  const m = matchFirstLine("（1）求 a、b 的值；（2）求 f(x) 在 [0, 2] 上的最大值。");
  assert.equal(m.kind, "other");
});

// ---------- fixture1：单栏选择题全链路 ----------

test("单栏选择题：5 题、选项 4 连、答案全匹配、无 review", () => {
  const r = segmentFromContentList(load("math-single-choice"), "math-single-choice");

  assert.equal(r.stats.columnsPerPage.join(","), "1");
  assert.equal(r.questions.length, 5);
  assert.equal(r.stats.reviewCount, 0);
  assert.equal(r.stats.answersMatched, 5);

  for (const q of r.questions) {
    assert.equal(q.type, "choice");
    assert.equal(q.options.length, 4);
    assert.ok(q.answer, `第 ${q.number} 题应有答案`);
    assert.equal(q.status, "ok");
  }
  // 内联公式保留：题 1 题干含 $x-1=0$
  assert.match(r.questions[0]!.stem, /\$x-1=0\$/);
  // 题 3 图片归属
  const q3 = r.questions.find((q) => q.number === "3")!;
  assert.equal(q3.images.length, 1);
  assert.equal(q3.images[0]!.path, "images/q3_sine_wave.png");
  // 题号切割后题干不带前缀
  assert.ok(r.questions[0]!.stem.startsWith("设集合"));
});

// ---------- fixture2：双栏混排 ----------

test("双栏混排：栏检测、阅读顺序（题号 1,2,3,4）、公式与图片归属", () => {
  const r = segmentFromContentList(load("math-two-column"), "math-two-column");

  assert.equal(r.stats.columnsPerPage.join(","), "2");
  // 阅读顺序：左栏两题在前、右栏两题在后（题号天然递增验证列恢复成功）
  assert.deepEqual(r.questions.map((q) => q.number), ["1", "2", "3", "4"]);

  const q3 = r.questions.find((q) => q.number === "3")!;
  assert.equal(q3.type, "subjective");
  // 独立公式块以 $$..$$ 并入题干
  assert.match(q3.stem, /\$\$f\(x\)=ax\^\{3\}\+bx\^\{2\}\$\$/);
  // 小题列表行并入题干而非切题
  assert.match(q3.stem, /（1）求 a、b 的值；（2）求 f/);
  // 右栏抛物线图归属题 3
  assert.equal(q3.images.length, 1);
  assert.equal(q3.images[0]!.path, "images/q3_parabola.png");

  const q4 = r.questions.find((q) => q.number === "4")!;
  assert.equal(q4.type, "subjective");
  assert.ok(q4.stem.includes("并证明"));
});

// ---------- fixture3：干扰与失败模式 ----------

test("干扰项：正文行首数字被误切为重复题号 → needs_review，不得静默", () => {
  const r = segmentFromContentList(load("math-noise"), "math-noise");

  // 5 道题：1、2、误切 3、真 3、4
  assert.equal(r.questions.length, 5);

  // 题号 "3" 出现两次 → 重复题号机制必须产生 review 并降级两份
  const reviews = r.reviews.filter((rv) => rv.reason.includes("重复题号"));
  assert.equal(reviews.length, 2);
  const threes = r.questions.filter((q) => q.number === "3");
  assert.equal(threes.length, 2);
  for (const q of threes) {
    assert.equal(q.status, "needs_review");
  }

  // 正常链路不受影响：题 1/2/4 状态 ok
  for (const num of ["1", "2", "4"]) {
    const q = r.questions.find((x) => x.number === num)!;
    assert.equal(q.status, "ok", `题 ${num} 不应被降级`);
  }
  assert.equal(r.questions.find((x) => x.number === "1")!.answer, "C");
  assert.ok(r.questions.find((x) => x.number === "2")!.answer!.startsWith("B"));
  // 答案解析续行累积进答案字段
  assert.match(r.questions.find((x) => x.number === "2")!.answer!, /解析：由 f\(1\)=2/);
  // 答案条目全部对号入座
  assert.equal(r.stats.answersMatched, 4);
});