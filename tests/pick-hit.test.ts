// tests/pick-hit.test.ts
/**
 * 挑题命中：块内、6pt 容差内、空白不猜、两题之间取最近、跨栏题各自命中。
 * 坐标是页面单位（pt），与 stages.json 的 bbox 同源。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickQuestionAt } from "../final/pick-hit.js";

const PAGE = {
  width: 595,
  height: 842,
  blocks: [
    { bbox: [50, 60, 280, 84] }, // q1 第一行
    { bbox: [50, 90, 280, 114] }, // q1 第二行（与第一行隔 6pt）
    { bbox: [320, 60, 545, 84] }, // q2 右栏
    { bbox: [320, 90, 545, 114] },
  ],
  questions: [
    { id: "q1", blocks: [0, 1] },
    { id: "q2", blocks: [2, 3] },
  ],
};

test("块内命中：同一题的任一块都返回该题", () => {
  assert.equal(pickQuestionAt(PAGE, 100, 70)?.id, "q1");
  assert.equal(pickQuestionAt(PAGE, 100, 100)?.id, "q1");
  assert.equal(pickQuestionAt(PAGE, 400, 70)?.id, "q2");
});

test("容差：距块边 5pt 命中，7pt 不命中", () => {
  assert.equal(pickQuestionAt(PAGE, 45, 70)?.id, "q1", "左边界外 5pt");
  assert.equal(pickQuestionAt(PAGE, 43, 70), null, "左边界外 7pt 不该命中");
  assert.equal(pickQuestionAt(PAGE, 100, 87)?.id, "q1", "两行之间 3pt 命中");
  assert.equal(pickQuestionAt(PAGE, 100, 88)?.id, "q1", "两行之间 4pt 命中");
});

test("两题之间的空白不猜：中间 20pt 属于无人区", () => {
  assert.equal(pickQuestionAt(PAGE, 300, 70), null);
  assert.equal(pickQuestionAt(PAGE, 300, 100), null);
});

test("页边距/页外不猜", () => {
  assert.equal(pickQuestionAt(PAGE, 10, 10), null);
  assert.equal(pickQuestionAt(PAGE, 590, 800), null);
  assert.equal(pickQuestionAt(PAGE, 400, 200), null);
});

test("两题都在容差内取最近；相同距离按阅读顺序取第一个", () => {
  // 两题上下只隔 6pt：点中间 23 距两边各 3pt
  const tight = {
    width: 100,
    height: 100,
    blocks: [
      { bbox: [0, 0, 100, 20] },
      { bbox: [0, 26, 100, 46] },
    ],
    questions: [
      { id: "q1", blocks: [0] },
      { id: "q2", blocks: [1] },
    ],
  };
  assert.equal(pickQuestionAt(tight, 50, 23)?.id, "q1", "等距时按 questions 顺序");
  assert.equal(pickQuestionAt(tight, 50, 25)?.id, "q2", "更近 q2 时取 q2");
  // 靠近 q2 的块应取 q2
  assert.equal(pickQuestionAt(PAGE, 318, 70)?.id, "q2");
});

test("坏数据不崩：缺 blocks/空题/非法 bbox 跳过", () => {
  const bad = {
    width: 100,
    height: 100,
    blocks: [{ bbox: [0, 0, 10, 10] }, {}, { bbox: [1, 2] }],
    questions: [{ id: "a", blocks: [0, 1, 2] }, { id: "b" }],
  };
  assert.equal(pickQuestionAt(bad as never, 5, 5)?.id, "a");
  assert.equal(pickQuestionAt(bad as never, 50, 50), null);
  assert.equal(pickQuestionAt({ width: 1, height: 1 } as never, 0, 0), null);
});
