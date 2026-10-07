// stages-export.test.ts —— 阶段展示快照的纯逻辑断言（合成数据，离线可跑）。
// 覆盖：全局序号→页内序号映射、阅读顺序覆盖全块、跨页题按落页分组、
// 质检原因回填、raw 块提取与文本截断。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStageSnapshot, extractRawBlocks } from "../scripts/export-stages.js";
import type { ParsedDocument, SegmentationResult } from "../src/types.js";

// 全局序号口径：第 0 页 3 块 → 全局 0/1/2；第 1 页 2 块 → 全局 3/4。
const doc: ParsedDocument = {
  docId: "测试卷",
  pages: [
    {
      index: 0,
      width: 596,
      height: 821,
      blocks: [
        { kind: "text", bbox: [10, 10, 100, 20], text: "一、选择题", firstLine: "一、选择题", lineCount: 1, maxFontSize: 0 },
        { kind: "text", bbox: [10, 30, 100, 40], text: "1. 题干甲", firstLine: "1. 题干甲", lineCount: 1, maxFontSize: 0 },
        { kind: "image", bbox: [10, 50, 100, 90], path: "img1.jpg" },
      ],
    },
    {
      index: 1,
      width: 596,
      height: 821,
      blocks: [
        { kind: "text", bbox: [10, 10, 100, 20], text: "2. 题干乙", firstLine: "2. 题干乙", lineCount: 1, maxFontSize: 0 },
        { kind: "text", bbox: [10, 30, 100, 40], text: "（第2题续行）", firstLine: "（第2题续行）", lineCount: 1, maxFontSize: 0 },
      ],
    },
  ],
};

const result: SegmentationResult = {
  docId: "测试卷",
  questions: [
    {
      id: "测试卷:p0:q1",
      type: "choice",
      number: "1",
      section: "一、选择题",
      stem: "题干甲",
      options: [
        { key: "A", text: "甲" },
        { key: "B", text: "乙" },
        { key: "C", text: "丙" },
        { key: "D", text: "丁" },
      ],
      images: [{ path: "img1.jpg", bbox: [10, 50, 100, 90] }],
      answer: "A",
      // 全局序号：1=题干甲、2=图片（均落第 0 页）
      source: { file: "测试卷", pageIndex: 0, blockIndexes: [1, 2] },
      confidence: 0.9,
      status: "ok",
    },
    {
      id: "测试卷:p1:q2",
      type: "subjective",
      number: "2",
      section: "一、选择题",
      stem: "题干乙",
      options: [],
      images: [],
      // 全局序号 3 = 第 1 页块 0
      source: { file: "测试卷", pageIndex: 1, blockIndexes: [3] },
      confidence: 0.6,
      status: "needs_review",
    },
    {
      id: "测试卷:p0:q3",
      type: "subjective",
      number: "3",
      section: "一、选择题",
      stem: "跨页题",
      options: [],
      images: [],
      // 跨页题：全局 2（第 0 页图片）+ 全局 4（第 1 页续行）
      source: { file: "测试卷", pageIndex: 0, blockIndexes: [2, 4] },
      confidence: 0.85,
      status: "ok",
    },
  ],
  reviews: [
    {
      questionId: "测试卷:p1:q2",
      reason: "重复题号「2」：第 1 页 2 道题共享，存在误切风险",
      blockIndex: 3,
      snippet: "2. 题干乙",
    },
    { reason: "答案条目 9 未匹配到任何题目", blockIndex: -1, snippet: "9．A" },
  ],
  stats: {
    totalBlocks: 5,
    questions: 3,
    reviewCount: 2,
    optionGroups: 1,
    imagesAttached: 1,
    answersMatched: 0,
    formulaBlocks: 0,
    inlineFormulas: 0,
    columnsPerPage: [1, 1],
  },
  answerEntries: [{ number: "9", text: "A" }],
};

const rawPages = extractRawBlocks({
  pdf_info: [
    {
      para_blocks: [
        {
          type: "title",
          bbox: [0, 0, 10, 10],
          lines: [{ spans: [{ content: "一、选择题" }] }],
        },
        {
          type: "text",
          bbox: [0, 20, 10, 30],
          lines: [{ spans: [{ content: "x".repeat(200) }] }],
        },
      ],
    },
    { para_blocks: [] },
  ],
});

test("extractRawBlocks：段级块保留 MinerU type 并截断长文本", () => {
  assert.equal(rawPages.length, 2);
  const p0 = rawPages[0];
  assert.ok(p0, "第一页存在");
  assert.equal(p0.length, 2);
  assert.equal(p0[0]?.type, "title");
  assert.equal(p0[0]?.text, "一、选择题");
  assert.ok(p0[1]?.text.endsWith("…"), "超长文本应以省略号截断");
  assert.ok((p0[1]?.text.length ?? 0) <= 161, "RAW_TEXT_LIMIT=160");
});

test("buildStageSnapshot：全局序号正确映射回页内块，阅读顺序覆盖全块", () => {
  const snap = buildStageSnapshot(doc, result, rawPages);
  const p0 = snap.pages[0];
  const p1 = snap.pages[1];
  assert.ok(p0 && p1);
  assert.deepEqual(p0.order, [0, 1, 2]);
  assert.deepEqual(p1.order, [0, 1]);
  const imgBlock = p0.blocks[2];
  assert.ok(imgBlock);
  assert.equal(imgBlock.kind, "image");
  assert.equal(imgBlock.img, "img1.jpg");
});

test("buildStageSnapshot：题目按落页分组，跨页题在两页各出现一次", () => {
  const snap = buildStageSnapshot(doc, result, rawPages);
  const p0 = snap.pages[0];
  const p1 = snap.pages[1];
  assert.ok(p0 && p1);

  // 第 0 页：q1（题干+图）、q3（仅图片部分）
  assert.equal(p0.questions.length, 2);
  assert.deepEqual(p0.questions[0]?.blocks, [1, 2]);
  assert.deepEqual(p0.questions[1]?.blocks, [2]);

  // 第 1 页：q2（题干）、q3（仅续行部分）
  assert.equal(p1.questions.length, 2);
  assert.deepEqual(p1.questions[0]?.blocks, [0]);
  assert.deepEqual(p1.questions[1]?.blocks, [1]);

  // 同一题 id 在两页可追溯
  assert.equal(p0.questions[1]?.id, p1.questions[1]?.id);
});

test("buildStageSnapshot：质检原因回填对应题，答案区计数透传", () => {
  const snap = buildStageSnapshot(doc, result, rawPages);
  const p1 = snap.pages[1];
  assert.ok(p1);
  const q2 = p1.questions.find((q) => q.number === "2");
  assert.ok(q2);
  assert.equal(q2.status, "needs_review");
  assert.equal(q2.reasons.length, 1);
  assert.ok(q2.reasons[0]?.includes("重复题号"));
  assert.equal(snap.reviews.length, 2, "全局质检记录原样保留");
  assert.equal(snap.answerEntriesTotal, 1);
  assert.equal(snap.stats.questions, 3);
});
