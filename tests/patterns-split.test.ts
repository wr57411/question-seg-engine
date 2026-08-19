// tests/patterns-split.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitConjoinedOptions } from "../src/patterns.js";
import { ruleStrategy } from "../src/strategy.js";
import type { ParsedBlock, ParsedDocument } from "../src/types.js";

test("粘连选项拆分：一行四选项", () => {
  const opts = splitConjoinedOptions("A.3:4 B.3:5 C.4:5 D.2:3");
  assert.deepEqual(opts.map((o) => o.key), ["A", "B", "C", "D"]);
  assert.deepEqual(opts.map((o) => o.text), ["3:4", "3:5", "4:5", "2:3"]);
});

test("粘连选项拆分：无空格粘连（A.xxxB.yyy）", () => {
  const opts = splitConjoinedOptions("A.重力的作用点在重心上B.重力的大小与质量成正比C.重力的方向总是竖直向下");
  assert.equal(opts.length, 3);
  assert.equal(opts[0]!.key, "A");
  assert.match(opts[0]!.text, /重力的作用点/);
});

test("粘连选项拆分：普通文本（题干）不拆分", () => {
  assert.equal(splitConjoinedOptions("2. [山东潍坊中学2022摸底]关于相互作用").length, 0);
});

/** 合成单页文档（绕过 normalize，直接验证 rule-engine 批量路径） */
const textBlock = (text: string, y: number): ParsedBlock => ({
  kind: "text",
  bbox: [0, y, 500, y + 20],
  text,
  firstLine: text,
  lineCount: 1,
  maxFontSize: 12,
});

test("批量路径不连续键：断裂文本回退题干不丢，review 期待值取捕获键", () => {
  const doc: ParsedDocument = {
    docId: "split-discontinuity",
    pages: [
      {
        index: 0,
        width: 800,
        height: 1000,
        blocks: [
          textBlock("1. 题干", 0),
          textBlock("A.x C.z", 25), // B 缺失 → 批量路径不连续
        ],
      },
    ],
  };
  const r = ruleStrategy.segment(doc);
  const q1 = r.questions.find((q) => q.number === "1");
  assert.ok(q1, "题 1 应存在");
  // 宁错审不错放：断裂点之后的文本（"C.z"）不得静默丢弃，整块回退进题干
  assert.match(q1!.stem, /A\.x C\.z/);
  // 不连续必须显式 review，且文案用捕获的期待键（B，而非 settle 重置后的 A）
  const rv = r.reviews.find((x) => x.reason.includes("粘连选项键不连续"));
  assert.ok(rv, "键不连续应产生 review");
  assert.match(rv!.reason, /期待 B，实际 C/);
});