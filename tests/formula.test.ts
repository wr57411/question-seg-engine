// formula.test.ts —— 公式噪声检测机制的回归锁定（检测不改写）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNoise, scanFormulaNoise, splitFormulas } from "../src/formula.js";
import type { Question } from "../src/types.js";

test("splitFormulas：成对提取 $...$，不成对尾段忽略", () => {
  assert.deepEqual(splitFormulas("a$x$b$y$"), ["x", "y"]);
  assert.deepEqual(splitFormulas("无公式"), []);
  assert.deepEqual(splitFormulas("odd$one"), []);
});

test("classifyNoise：五类噪声各就各位，干净公式零标记", () => {
  assert.ok(classifyNoise("6 0 ^ { \\circ }").includes("spaced-digits"));
  assert.ok(classifyNoise("6 0 ^ { \\circ }").includes("degree-spelled"));
  assert.ok(classifyNoise("\\mathrm { m }").includes("wrapper"));
  assert.ok(classifyNoise("\\boldsymbol { 1 0 }").includes("wrapper"));
  assert.ok(classifyNoise("\\left( x \\right)").includes("left-right"));
  assert.ok(classifyNoise("x {").includes("unbalanced"));
  assert.ok(classifyNoise("a".repeat(121)).includes("long"));
  assert.deepEqual(classifyNoise("mg/2"), []);
});

test("scanFormulaNoise：总量/受影响题数/类型分桶", () => {
  const q = (id: string, stem: string, options: string[]): Question => ({
    id,
    type: "choice",
    number: id,
    section: "",
    chapter: "",
    chapterTitle: "",
    sectionNo: "",
    subQuestions: [],
    sectionSeq: 0,
    stem,
    options: options.map((text, i) => ({ key: "ABCD"[i]!, text })),
    images: [],
    source: { file: "t", pageIndex: 0, blockIndexes: [] },
    confidence: 1,
    status: "ok",
  });
  const report = scanFormulaNoise([
    q("1", "夹角$\\theta < 9 0 ^ { \\circ }$不变", ["干净选项", "B"]),
    q("2", "纯文本题干", ["$\\boldsymbol { \\frac { m g } { 2 } }$", "B"]),
    q("3", "又一个干净$mg$公式", ["B"]),
  ]);
  assert.equal(report.totalFormulas, 3);
  assert.equal(report.noisyFormulas, 2);
  assert.equal(report.questionsAffected, 2);
  assert.ok(report.kindCounts["degree-spelled"] >= 1);
  assert.ok(report.kindCounts.wrapper >= 1);
  assert.equal(report.items.length, 2);
  assert.equal(report.items[0]?.questionId, "1");
  assert.equal(report.items[0]?.field, "stem");
  assert.equal(report.items[1]?.field, "option");
});
