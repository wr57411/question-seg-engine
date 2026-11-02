// tests/select-auto.test.ts
//
// 逐题自动选源（`scripts/select-auto.ts`，`DECISIONS §75`）。
//
// 为什么要有它：`DECISIONS §67` 的「按书选源」是人肉结论（曲线=OXR、运动=MinerU…），
// 每来一本新书都要人工跑金标重判 —— 批处理没法知道该选哪本，所以「自动选源」一直没接进 batch。
// 逐题选源把「选哪本」换成「每题按同一套判据选」，于是可自动化、可复现、可审计。
//
// 判据沿用 §70（结构过关优先，都过关取 OXR 文字质量）+ §73（两源互不相似 ⇒ 不猜，升级仲裁）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { MUTUAL_MIN, decide, merge, structOk } from "../scripts/select-auto.js";
import type { Question } from "../src/types.js";

function q(page: number, number: string, stem: string, options?: string[], status?: string): Question {
  return {
    id: `d:p${page}:q${number}`,
    type: "choice",
    number,
    chapter: "",
    chapterTitle: "",
    sectionNo: "",
    section: "",
    subQuestions: [],
    sectionSeq: 0,
    stem,
    options: (options ?? ["甲", "乙", "丙", "丁"]).map((t, i) => ({
      key: String.fromCharCode(65 + i),
      text: t,
    })),
    images: [],
    source: { file: "d", pageIndex: page, blockIndexes: [0] },
    confidence: 1,
    status: (status as Question["status"]) ?? "ok",
  };
}

test("structOk：题干混进题号/选项/栏目碎片即判不合格", () => {
  assert.equal(structOk(q(0, "1", "题干\n2【2023 全国卷】下一道题")), false, "题号紧跟来源标记");
  assert.equal(structOk(q(0, "1", "题干\nA. 混进来的选项")), false, "选项行混入题干");
  assert.equal(structOk(q(0, "1", "题干\n教材知识萃取 回归教材")), false, "栏目标题混入题干");
  assert.equal(structOk(q(0, "1", "干净题干")), true);
});

test("structOk 的已知边界：题号带点再接来源标记（`2. 【2023】`）不判不合格", () => {
  // 这是沿用 §70 检测器的既有口径（`/^\d{1,3}\s*[[【「]/` 要求数字后**紧跟**括号）。
  // 本模块不擅自放宽：放宽会改变 1300+ 题的选源结果，须先有金标验证。
  // 记录在此，避免后来者误以为这一形态已被覆盖。
  assert.equal(structOk(q(0, "1", "题干\n2. 【2023 全国卷】下一道题")), true);
});

test("structOk：选项键不足 3 个或重复即不合格", () => {
  assert.equal(structOk(q(0, "1", "题干", ["甲", "乙"])), false);
  const dup = q(0, "1", "题干", ["甲", "乙", "丙"]);
  dup.options = [
    { key: "A", text: "甲" },
    { key: "A", text: "乙" },
    { key: "B", text: "丙" },
  ];
  assert.equal(structOk(dup), false);
});

test("decide：只有一源切出 ⇒ 用有的那源，不升级", () => {
  const d = decide([q(0, "1", "只在 MinerU")], [q(0, "2", "只在 OXR")]);
  assert.equal(d.length, 2);
  const m = d.find((x) => x.number === "1")!;
  const o = d.find((x) => x.number === "2")!;
  assert.equal(m.picked, "MinerU");
  assert.equal(m.reason, "only-one");
  assert.equal(m.escalate, false);
  assert.equal(o.picked, "OXR");
  assert.equal(o.reason, "only-one");
});

test("decide：两源都干净且互相一致 ⇒ 取 OXR（§70 文字质量）", () => {
  const stem = "某质点在 xOy 平面上运动，x 方向速度—时间图像如图甲所示";
  const d = decide([q(0, "1", stem)], [q(0, "1", stem)]);
  assert.equal(d[0]!.reason, "both-clean-agree");
  assert.equal(d[0]!.picked, "OXR");
  assert.equal(d[0]!.escalate, false);
  assert.ok(d[0]!.mutual! >= MUTUAL_MIN);
});

test("decide：两源都干净但互不相似（对「这是哪道题」有分歧）⇒ 升级仲裁（§73）", () => {
  const d = decide(
    [q(0, "1", "如图所示，桥式起重机由桥架、小车和固定轨道三部分组成，位移大小")],
    [q(0, "1", "伽利略设想物体下落速度与时间成正比，通过数学推导证明位移与时间平方成正比")],
  );
  assert.equal(d[0]!.reason, "both-clean-disagree");
  assert.equal(d[0]!.escalate, true, "两源对不上时必须标升级，不能悄悄选一个");
  assert.ok(d[0]!.mutual! < MUTUAL_MIN);
});

test("decide：只有一源结构过关 ⇒ 用过关那源", () => {
  const clean = q(0, "1", "干净题干");
  const dirty = q(0, "1", "题干\nA. 混入的选项行");
  const a = decide([dirty], [clean]);
  assert.equal(a[0]!.picked, "OXR");
  assert.equal(a[0]!.reason, "one-clean");
  const b = decide([clean], [dirty]);
  assert.equal(b[0]!.picked, "MinerU");
  assert.equal(b[0]!.reason, "one-clean");
});

test("decide：两源都不干净 ⇒ 用 MinerU 并升级", () => {
  const d = decide([q(0, "1", "题干\n2【2023】下一道")], [q(0, "1", "题干\nA. 混入")]);
  assert.equal(d[0]!.reason, "none-clean");
  assert.equal(d[0]!.picked, "MinerU");
  assert.equal(d[0]!.escalate, true);
});

test("merge：按决定取源；升级的题标 needs_review；只在一源里的题不丢", () => {
  const mineru = [q(0, "1", "M 版题干"), q(0, "2", "只在 MinerU 的题")];
  const oxr = [q(0, "1", "O 版题干"), q(0, "3", "只在 OXR 的题")];
  const decisions = decide(mineru, oxr);
  const merged = merge(mineru, oxr, decisions);
  assert.equal(merged.length, 3, "三题都要在，不能因为选源丢题");
  assert.equal(merged.find((x) => x.number === "1")!.stem, "O 版题干", "一致时取 OXR");
  assert.equal(merged.find((x) => x.number === "2")!.stem, "只在 MinerU 的题");
  assert.equal(merged.find((x) => x.number === "3")!.stem, "只在 OXR 的题");
});

test("merge：升级仲裁的题必须显式标 needs_review（不静默）", () => {
  const decisions = [
    {
      pageIndex: 0,
      number: "1",
      picked: "OXR" as const,
      reason: "both-clean-disagree" as const,
      escalate: true,
      mutual: 0.05,
    },
  ];
  const merged = merge([q(0, "1", "M 版")], [q(0, "1", "O 版")], decisions);
  assert.equal(merged[0]!.status, "needs_review");
});
