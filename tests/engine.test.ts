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
import { matchBoxListItem, matchFirstLine } from "../src/patterns.js";
import { segmentFromContentList } from "../src/index.js";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

// ---------- 语言层 ----------

test("语言层：题号/选项/大题/答案区模式", () => {
  const cases: [string, string][] = [
    ["1．设集合 A = {x}，则…", "question_no"],
    // 2026-10-12：括号小问**不是题号**（切题会让小问变成独立题目）
    ["（1）求 a 的值；", "sub_question"],
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
// ---------- 方框守卫：方法技巧/易错警示方框内的编号条目不是题目（2026-10-14） ----------

/** 造一个单页 content_list：blocks = [text, …]（每项一行文字） */
function pageOf(lines: string[]): unknown {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [1654, 2339],
        blocks: lines.map((content, i) => ({
          type: "text",
          bbox: [60, 100 + i * 40, 1600, 130 + i * 40],
          lines: [{ spans: [{ type: "text", content }] }],
        })),
      },
    ],
  };
}

test("语言层：方框编号列表锚点 `▶N.` 才认，`▶(1)` 不认", () => {
  assert.equal(matchBoxListItem("▶1. 质点从竖直圆环上沿不同的光滑弦上端由静止开始滑到"), 1);
  assert.equal(matchBoxListItem("▶ 3、两个竖直圆环相切"), 3);
  assert.equal(matchBoxListItem("▶(1)判断合运动：物体的实际运动就是合运动."), null);
  assert.equal(matchBoxListItem("2. 质点从竖直圆环上最高点沿不同的光滑弦"), null);
  assert.equal(matchBoxListItem("▶分析滑块一木板类模型时要抓住一个转折和两个关联"), null);
});

test("方框守卫：方框内 `2.` `3.` 不切题，真题号保持 1/2/3 连续（2026-10-14 真实回归）", () => {
  const r = segmentFromContentList(
    pageOf([
      "1. BC 必刷模型·等时圆模型",
      "【解析】小滑块a、b均能沿各自斜轨道匀速下滑，则 $mg\\sin\\theta=\\mu mg\\cos\\theta$",
      "方法技巧·等时圆模型",
      "▶1. 质点从竖直圆环上沿不同的光滑弦上端由静止开始滑到环的最低点所用时间相等，如图甲所示.",
      "2. 质点从竖直圆环上最高点沿不同的光滑弦由静止开始滑到下端所用时间相等，如图乙所示.",
      "3.两个竖直圆环相切且两圆环的竖直直径均过切点，质点沿不同的光滑弦上端由静止开始滑到下端所用时间相等，如图丙所示.",
      "2.B必刷模型·等时圆模型",
      "【解析】设该圆弧对应的半径为R，小球沿光滑圆弧面ABD运动到底端的时间相当于摆长为R的单摆周期的1/4",
      "3.B【解析】本题考查运动学公式.物块在桌面上做匀减速直线运动",
    ]),
    "box-guard",
  );

  // 关键：题号必须是 1,2,3 —— 而不是 1,2,3(方框),2,3
  assert.deepEqual(
    r.questions.map((q) => q.number),
    ["1", "2", "3"],
    "方框内的 2./3. 不得成为题目",
  );

  // 不静默：被抑制的方框条目必须有 ReviewNote
  const boxNotes = r.reviews.filter((rv) => rv.reason.includes("方框内编号条目"));
  assert.equal(boxNotes.length, 2, "两条被抑制的方框条目都要有诊断记录");

  // 不丢内容：方框条目的原文并入当前题题干
  const q1 = r.questions[0]!;
  assert.match(q1.stem, /质点从竖直圆环上最高点沿不同的光滑弦/, "方框条目文本必须保留");
  assert.match(q1.stem, /两个竖直圆环相切且两圆环的竖直直径均过切点/, "方框条目文本必须保留");
});

test("方框守卫不误伤：序号不连续时照常切题（锚点 ▶1. 之后出现 5.）", () => {
  const r = segmentFromContentList(
    pageOf([
      "1. A 必刷知识·摩擦力",
      "方法技巧·某技巧",
      "▶1. 方框里的第一条说明",
      "5. B 必刷考点·牛顿第三定律",
    ]),
    "box-guard-negative",
  );
  assert.deepEqual(r.questions.map((q) => q.number), ["1", "5"], "5 不是 1+1，必须照常成为题目");
  assert.equal(r.reviews.filter((rv) => rv.reason.includes("方框内编号条目")).length, 0);
});

test("方框守卫不误吞真题：方框 2 条 + 下一条真题号恰好 3（带答案形态）必须切题", () => {
  const r = segmentFromContentList(
    pageOf([
      "1. A 必刷知识·摩擦力",
      "方法技巧·某技巧",
      "▶1. 方框里的第一条说明",
      "2. 方框里的第二条说明",
      "3.B必刷考点·牛顿第三定律",
      "4. C 必刷模型·板块模型",
    ]),
    "box-guard-answer-shape",
  );
  // 若只看「序号恰好 +1」，真题 3 会被静默吞进方框 —— 这道 AND 条件就是拦它的
  assert.deepEqual(r.questions.map((q) => q.number), ["1", "3", "4"], "带答案形态的 3. 必须切题");
  assert.equal(r.reviews.filter((rv) => rv.reason.includes("方框内编号条目")).length, 1, "只有第 2 条被抑制");
});
