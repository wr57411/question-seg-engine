// score.test.ts —— 金标准评分器的数学正确性（纯函数，不依赖 data/）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normForScore, scoreQuestions, type GoldDoc } from "../scripts/score.js";
import type { Question } from "../src/types.js";

function mkQ(
  id: string,
  number: string,
  stem: string,
  options: { key: string; text: string }[],
  extra: Partial<Question> = {},
): Question {
  return {
    id,
    type: "choice",
    number,
    chapter: "",
    chapterTitle: "",
    sectionNo: "",
    section: "",
    subQuestions: [],
    sectionSeq: 0,
    stem,
    options,
    images: [],
    confidence: 1,
    status: "ok",
    source: { file: "t", pageIndex: 0, blockIndexes: [] },
    ...extra,
  };
}

test("scoreQuestions：完整金标准算 recall/precision/选项/答案", () => {
  const gold: GoldDoc = {
    docId: "t",
    complete: true,
    questions: [
      { page: 0, number: "1", stem: "题干一", options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: "A" },
      { page: 0, number: "2", stem: "题干二", options: [{ key: "A", text: "丙" }] },
    ],
  };
  const system = [
    mkQ("q1", "1", "题干一", [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], { answer: "A" }),
    mkQ("q3", "3", "题干二", [{ key: "A", text: "丙" }]),
  ];
  const r = scoreQuestions("t", gold, system);
  assert.equal(r.recall, 0.5);
  assert.equal(r.precision, 0.5);
  assert.equal(r.optionCompleteness, 1);
  assert.equal(r.answerPairing, 1);
  assert.deepEqual(r.unmatchedGold, [{ page: 0, number: "2" }]);
  assert.equal(r.autoPass, false);
});

test("scoreQuestions：部分金标准不算 precision/autoPass，仍算匹配题选项", () => {
  const gold: GoldDoc = {
    docId: "t",
    complete: false,
    questions: [{ page: 0, number: "1", stem: "题干一", options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }] }],
  };
  const system = [mkQ("q1", "1", "题干一", [{ key: "A", text: "甲" }])];
  const r = scoreQuestions("t", gold, system);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, null);
  assert.equal(r.optionCompleteness, 0.5);
  assert.equal(r.autoPass, false);
});

test("normForScore：LaTeX 等价形式与人工纯文本可比较", () => {
  assert.equal(normForScore("$I = \\frac { n _ { 1 } e } { t }$"), "i=n1e/t");
  assert.equal(normForScore("$\\frac{\\sqrt{3}}{3}B_{0}$"), "√3/3b0");
  assert.equal(normForScore("$\\sin37^{\\circ}=0.6$"), "sin37°=06");
  assert.equal(normForScore("$5\\times10^{18}$"), "5×1018");
  assert.equal(normForScore("$1.6\\times10^{-19}\\,\\text{C}$"), "16×10-19c");
});
