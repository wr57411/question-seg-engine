// tests/section-continuity.test.ts
//
// 「节内题号断档」判据（`src/rule-engine.ts` 的 `sectionNumberGaps`）。
//
// 背景（2026-10-30）：用 Word 真文字与产物做交叉比对，抓到《电路》一整道题
// （三电阻滑片多选题）在切分产物中**完全消失**，且全程零告警：
// 该校 sectionSeq 的题号序列是 `1,2,3,4,2,3` —— 从 4 掉回 2 就是"少了一道题"的脚印。
// 既有的 `flagDuplicateNumbers` **按页**查重，而这两道重号题分处 p4/p5，
// 按页看不见；漏题本身也没有任何出口。
//
// 本判据只报警、不扣分（见 flagSectionContinuity 注释）：先让漏题可见，再谈收口。

import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionNumberGaps } from "../src/rule-engine.js";
import type { Question } from "../src/types.js";

function q(number: string, sectionSeq: number, blockIndex: number, stem = "题干"): Question {
  return {
    id: `t:p0:q${blockIndex}`,
    type: "choice",
    number,
    chapter: "1",
    chapterTitle: "章",
    sectionNo: "1",
    section: "第1节",
    subQuestions: [],
    sectionSeq,
    stem,
    options: [],
    images: [],
    source: { file: "t.pdf", pageIndex: 0, blockIndexes: [blockIndex] },
    confidence: 1,
    status: "ok",
  };
}

test("题号断档：严格递增 ⇒ 不报", () => {
  const qs = [q("1", 0, 0), q("2", 0, 1), q("3", 0, 2)];
  assert.deepEqual(sectionNumberGaps(qs), []);
});

test("题号断档：跳号 ⇒ 报一处 skip，并给出漏切题数", () => {
  const gaps = sectionNumberGaps([q("1", 0, 0), q("2", 0, 1), q("4", 0, 2)]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.kind, "skip");
  assert.equal(gaps[0]!.expected, 3);
  assert.equal(gaps[0]!.actual, 4);
});

test("题号断档：回退 ⇒ 报一处 back（《电路》实测形状 1,2,3,4,2,3）", () => {
  const qs = [q("1", 2, 0), q("2", 2, 1), q("3", 2, 2), q("4", 2, 3), q("2", 2, 4), q("3", 2, 5)];
  const gaps = sectionNumberGaps(qs);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.kind, "back");
  assert.equal(gaps[0]!.expected, 5);
  assert.equal(gaps[0]!.actual, 2);
  assert.equal(gaps[0]!.sectionSeq, 2);
});

test("题号断档：不同 sectionSeq 各自从 1 起 ⇒ 不误报（换节重编号是正常行为）", () => {
  const qs = [q("1", 0, 0), q("2", 0, 1), q("1", 1, 2), q("2", 1, 3)];
  assert.deepEqual(sectionNumberGaps(qs), []);
});

test("题号断档：每组只报第一处（断档后序列整体位移，逐条报会刷屏）", () => {
  const qs = [q("1", 0, 0), q("3", 0, 1), q("4", 0, 2), q("5", 0, 3)];
  const gaps = sectionNumberGaps(qs);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.actual, 3);
});

test("题号断档：非数字题号（汉字大题）不参与，避免误报", () => {
  const qs = [q("一", 0, 0), q("二", 0, 1), q("1", 1, 2), q("2", 1, 3)];
  assert.deepEqual(sectionNumberGaps(qs), []);
});

test("题号断档：组内首题不是 1 ⇒ 不报（片段/夹具可从任意题号起，从 1 起判会误报）", () => {
  // 实测依据：既有 6 个端到端用例首题非 1，早期按"从 1 起"判直接误报 6 条
  assert.deepEqual(sectionNumberGaps([q("5", 0, 0), q("6", 0, 1), q("7", 0, 2)]), []);
  assert.deepEqual(sectionNumberGaps([q("2", 0, 0), q("3", 0, 1)]), []);
});
