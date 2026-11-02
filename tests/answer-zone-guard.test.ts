// tests/answer-zone-guard.test.ts
//
// 答案区守卫（ANSWER_ZONE_GUARD）的**单向状态切换**必须有足够强的判据。
//
// 事故（2026-10-29，bgx 复检发现）：`答案册-合订本` 的 187 页里，p77 有一个
// 上游拆出来的 21×11px 碎片块，文本恰好是 `解析`（本应是 `【解析】` 的一部分）。
// `isAnswerZone` 接受裸 `解析` ⇒ 引擎在 #5893 块切进 answers 模式，**再也不回来**，
// 之后 108 页 / 7,800 块 / 605 道真题全部变成「答案续行」，题数 503 而非 1108，
// 且**没有一条 ReviewNote** —— 典型的静默失败（踩 AGENTS.md 红线 1）。
//
// 判据取最严（本项目 lessons L2）：答案区切换是**不可逆的破坏性状态变化**，
// 只接受「带答案语义的完整词形」，不接受裸 `解析` 这种在教辅正文里高频出现的碎片。

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";
import { ruleStrategy } from "../src/strategy.js";
import type { ParsedBlock, ParsedDocument } from "../src/types.js";

const textBlock = (text: string, y: number): ParsedBlock => ({
  kind: "text",
  bbox: [0, y, 500, y + 20],
  text,
  firstLine: text,
  lineCount: 1,
  maxFontSize: 12,
});

test("答案区守卫：裸「解析」不得开启答案区（上游碎片误判回归）", () => {
  assert.notEqual(matchFirstLine("解析").kind, "answer_zone");
  // 「解析】」是 `【解析】` 被上游拆开的另一半，同样不得触发
  assert.notEqual(matchFirstLine("解析】").kind, "answer_zone");
});

test("答案区守卫：带答案语义的完整词形仍然开启答案区", () => {
  for (const s of ["参考答案", "答案及解析", "答案与解析", "试题答案", "答案解析", "参考答案：", "答案解析:"]) {
    assert.equal(matchFirstLine(s).kind, "answer_zone", `「${s}」应判定为答案区`);
  }
});

test("答案区守卫：`【解析】` 开头是正文标记，不是答案区标题", () => {
  assert.notEqual(matchFirstLine("【解析】由动能定理可知").kind, "answer_zone");
});

test("端到端：正文中间出现裸「解析」碎片，后续题号不得被吞成答案续行", () => {
  const doc: ParsedDocument = {
    docId: "answer-zone-fragment",
    pages: [
      {
        index: 0,
        width: 800,
        height: 1000,
        blocks: [
          textBlock("1.A 必刷知识·波的传播", 0),
          textBlock("【解析】由题图可知", 25),
          textBlock("解析", 50), // ← 上游碎片：旧实现从这里切进 answers 模式
          textBlock("2. BC 必刷知识·波的图像", 75),
          textBlock("【解析】周期为 0.3 s", 100),
          textBlock("3.C 必刷知识·全反射", 125),
        ],
      },
    ],
  };
  const r = ruleStrategy.segment(doc);
  assert.equal(r.questions.length, 3, "碎片之后的题 2、题 3 必须仍被切出");
  assert.deepEqual(r.questions.map((q) => q.number), ["1", "2", "3"]);
});

test("端到端：真正的答案区标题仍然终止试题流", () => {
  const doc: ParsedDocument = {
    docId: "answer-zone-real",
    pages: [
      {
        index: 0,
        width: 800,
        height: 1000,
        blocks: [
          textBlock("1. 题干一", 0),
          textBlock("A.甲", 25),
          textBlock("B.乙", 50),
          textBlock("参考答案", 75),
          textBlock("2. 题干二（本行属于答案区，不应成为新题）", 100),
        ],
      },
    ],
  };
  const r = ruleStrategy.segment(doc);
  assert.equal(r.questions.length, 1, "答案区之后的题号行不得再切题");
  assert.equal(r.questions[0]!.number, "1");
});
