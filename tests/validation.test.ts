/**
 * validation.test.ts —— 回拼校验层用例
 *
 * 核心断言：结构化输出中任何「原文里找不回的文本」必须进 ReviewNote 并降级，
 * 同时归一化差异（题号前缀剥离 / 空白 / $ 标记）不得误报。
 * 运行：npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedDocument, Question, SegmentationResult } from "../src/types.js";
import { normText, validateResult } from "../src/validation.js";

const bbox = (x0: number, y0: number): [number, number, number, number] => [x0, y0, x0 + 400, y0 + 30];

const doc: ParsedDocument = {
  docId: "validation-test",
  pages: [
    {
      index: 0,
      width: 1000,
      height: 2000,
      blocks: [
        {
          kind: "text",
          bbox: bbox(50, 100),
          text: "1．已知 f(x) = 2x + $x - 1=0$，求 f(3) 的值。",
          firstLine: "1．已知 f(x) = 2x + $x - 1=0$，求 f(3) 的值。",
          lineCount: 1,
          maxFontSize: 10,
        },
        { kind: "text", bbox: bbox(80, 160), text: "A．4", firstLine: "A．4", lineCount: 1, maxFontSize: 10 },
        { kind: "text", bbox: bbox(80, 200), text: "B．6", firstLine: "B．6", lineCount: 1, maxFontSize: 10 },
      ],
    },
  ],
};

function makeQuestion(overrides: Partial<Question>): Question {
  return {
    id: "validation-test:p0:q0",
    type: "choice",
    number: "1",
    section: "",
    chapter: "",
    chapterTitle: "",
    sectionNo: "",
    subQuestions: [],
    sectionSeq: 0,
    stem: "已知 f(x) = 2x + $x-1=0$，求 f(3) 的值。",
    options: [{ key: "A", text: "4" }, { key: "B", text: "6" }],
    images: [],
    source: { file: doc.docId, pageIndex: 0, blockIndexes: [0, 1, 2] },
    confidence: 1,
    status: "ok",
    ...overrides,
  };
}

function run(q: Question): SegmentationResult {
  const result: SegmentationResult = {
    docId: doc.docId,
    questions: [q],
    reviews: [],
    stats: {
      totalBlocks: 3,
      questions: 1,
      reviewCount: 0,
      optionGroups: 1,
      imagesAttached: 0,
      answersMatched: 0,
      formulaBlocks: 0,
      inlineFormulas: 0,
      columnsPerPage: [1],
    },
    bands: [],
    answerEntries: [],
  };
  validateResult(doc, result);
  return result;
}

test("归一化：去空白/$ 标记后一致", () => {
  assert.equal(normText("已知 f(x) = 2x + $x - 1=0$，求 f(3) 的值。"), normText("已知 f(x) = 2x + $x-1=0$，求 f(3) 的值。"));
});

test("回拼校验：与原文一致（含归一化差异）不产生 review", () => {
  const r = run(makeQuestion({}));
  assert.equal(r.reviews.length, 0);
  assert.equal(r.questions[0]!.status, "ok");
});

test("回拼校验：题干中出现原文不存在的句子 → review + needs_review", () => {
  const r = run(
    makeQuestion({
      stem: "已知 f(x) = 2x + $x-1=0$，求 f(3) 的值。\n这一段是结构化时凭空生成的内容，原文根本没有",
    }),
  );
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0]!.reason, /回拼失败/);
  assert.equal(r.questions[0]!.status, "needs_review");
  assert.ok(r.questions[0]!.confidence < 0.75);
});

test("回拼校验：选项文本找不到 → review", () => {
  const r = run(makeQuestion({ options: [{ key: "A", text: "4" }, { key: "B", text: "81" }] }));
  // "4" 长度不足跳过校验；"81" 在原文不存在 → 1 条 review
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0]!.reason, /选项 B 回拼失败/);
});