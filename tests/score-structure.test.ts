// score-structure.test.ts —— 锁住「结构金标」分支：只算切题 P/R，绝不冒充内容验收通过。
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreQuestions, type GoldDoc } from "../scripts/score.js";

type SysQuestion = Parameters<typeof scoreQuestions>[2][number];

function sys(page: number, number: string): SysQuestion {
  return {
    source: { pageIndex: page },
    number,
    stem: "题干",
    options: [],
    images: [],
    status: "ok",
  } as unknown as SysQuestion;
}

const structure: GoldDoc = {
  docId: "测试册",
  kind: "structure",
  complete: true,
  questions: [
    { page: 0, number: "1", stem: "", ocrEvidence: { file: "p01.txt", line: "1 [人教版…]" } },
    { page: 0, number: "2", stem: "", needsReview: true },
  ],
};

test("结构金标：recall 与 precision 首次同时可算（分母是独立题目清单）", () => {
  const r = scoreQuestions("测试册", structure, [sys(0, "1"), sys(0, "2")]);
  assert.equal(r.goldKind, "structure");
  assert.equal(r.matched, 2);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 1);
});

test("结构金标：漏题同时拉低 recall 与 precision，不能只报好看的那个", () => {
  const r = scoreQuestions("测试册", structure, [sys(0, "1")]);
  assert.equal(r.recall, 0.5);
  assert.equal(r.precision, 1);
  assert.deepEqual(r.unmatchedGold, [{ page: 0, number: "2" }]);
});

test("结构金标：文本/选项/答案/图片类指标一律 null，不冒充通过", () => {
  const r = scoreQuestions("测试册", structure, [sys(0, "1"), sys(0, "2")]);
  assert.equal(r.strictTextMatch, null);
  assert.deepEqual(r.strictTextMismatches, []);
  assert.equal(r.optionCompleteness, null);
  assert.equal(r.optionCer, null);
  assert.equal(r.answerPairing, null);
  assert.equal(r.imageRecall, null);
  assert.equal(r.autoPass, false, "结构金标没转写全文，绝不能判内容自动通过");
  assert.ok(r.notes.some((n) => n.includes("独立 OCR 题号证据 1/2")));
});

test("全文金标行为不变（回归）：strictTextMatch 仍算、autoPass 仍可判", () => {
  const full: GoldDoc = {
    docId: "测试册",
    complete: true,
    questions: [{ page: 0, number: "1", stem: "题干", options: [{ key: "A", text: "选项A" }] }],
  };
  const r = scoreQuestions("测试册", full, [sys(0, "1")]);
  assert.equal(r.goldKind, "full");
  assert.notEqual(r.strictTextMatch, null);
  assert.equal(r.optionCompleteness, 0);
});

test("partial 全文金标仍不算 precision（历史口径不回归）", () => {
  const partial: GoldDoc = {
    docId: "测试册",
    complete: false,
    questions: [{ page: 0, number: "1", stem: "题干" }],
  };
  const r = scoreQuestions("测试册", partial, [sys(0, "1")]);
  assert.equal(r.precision, null);
  assert.equal(r.autoPass, false);
});
