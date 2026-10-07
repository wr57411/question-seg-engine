// option-regression.test.ts —— 2026-10-07 对比模式暴露的三类真实故障回归锁定。
// 案例：p8 第6题（一行四选项带 LaTeX 噪声）、p10 第6题（"A、B"物体列举误判为选项
// 导致整组丢失）、p15 第12题（上游整行重复拆出连续同键）。数据取自真实样张。
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine, splitConjoinedOptions } from "../src/patterns.js";
import { segmentWithRules } from "../src/rule-engine.js";
import type { ParsedBlock, ParsedDocument } from "../src/types.js";

const t = (text: string): ParsedBlock => ({
  kind: "text",
  bbox: [0, 0, 100, 12],
  text,
  firstLine: text,
  lineCount: 1,
  maxFontSize: 0,
});

test("matchFirstLine：'A、B'物体列举不是选项行，'A、中文'仍是选项", () => {
  assert.equal(matchFirstLine("A、B用两根不可伸长的轻绳连").kind, "other");
  assert.equal(matchFirstLine("A、B、C均处于平衡状态.现将竖直光滑杆D向").kind, "other");
  const m = matchFirstLine("A、如图所示，系统处于静止状态");
  assert.equal(m.kind, "option");
  assert.equal(m.ok && m.optionKey, "A");
});

test("splitConjoinedOptions：一行四选项带 LaTeX 噪声（p8 第6题真实文本）", () => {
  const splits = splitConjoinedOptions(
    "A.$6 0 ^ { \\circ }$B.45°C.$3 7 ^ { \\circ }$D.$3 0 ^ { \\circ }$",
  );
  assert.deepEqual(
    splits.map((s) => s.key),
    ["A", "B", "C", "D"],
  );
  assert.equal(splits[0]?.text, "$6 0 ^ { \\circ }$");
  // "45°C." 中的 "C." 是 C 选项标记（角度题语境），B 的文本到 "45°" 为止
  assert.equal(splits[1]?.text, "45°");
});

test("splitConjoinedOptions：上游整行重复拆出连续同键时合并取更长（p15 第12题）", () => {
  const dup = "C.M所受斜面的摩擦力大C.M所受斜面的摩擦力大小一定一直增加";
  assert.deepEqual(splitConjoinedOptions(dup), [
    { key: "C", text: "M所受斜面的摩擦力大小一定一直增加" },
  ]);
  // 物体列举形态不拆（"A、B"不是选项边界）
  assert.deepEqual(splitConjoinedOptions("A、B,按如图所示放置，设A、B接触的斜面光"), []);
});

test("引擎端到端：物体列举不劫持选项组，一行四选项完整成组", () => {
  const doc: ParsedDocument = {
    docId: "reg",
    pages: [
      {
        index: 0,
        width: 596,
        height: 821,
        blocks: [
          t("6.江西赣州2022模拟]如图所"),
          t("A、B用两根不可伸长的轻绳连接后悬挂于O点"),
          t("施加大小恒为16N、方向可以改变的外力F"),
          t("A.$6 0 ^ { \\circ }$B.45°C.$3 7 ^ { \\circ }$D.$3 0 ^ { \\circ }$"),
          t("7.下一题占位"),
        ],
      },
    ],
  };
  const r = segmentWithRules(doc);
  assert.equal(r.questions.length, 2);
  const q6 = r.questions.find((q) => q.number === "6");
  assert.ok(q6);
  assert.equal(q6.type, "choice");
  assert.deepEqual(
    q6.options.map((o) => o.key),
    ["A", "B", "C", "D"],
  );
  // 列举行必须留在题干，而不是成为伪选项文本
  assert.match(q6.stem, /A、B用两根不可伸长的轻绳连/);
  assert.equal(q6.status, "ok");
  assert.equal(r.reviews.length, 0);
});

test("引擎端到端：上游整行重复不丢选项组", () => {
  const doc: ParsedDocument = {
    docId: "reg-dup",
    pages: [
      {
        index: 0,
        width: 596,
        height: 821,
        blocks: [
          t("12.[全国Ⅰ2019·19,6分](多选)如图，一粗糙"),
          t("A. 水平拉力的大小可能"),
          t("B.M所受细绳的拉力大"),
          t("C.M所受斜面的摩擦力大C.M所受斜面的摩擦力大小一定一直增加"),
          t("D. M所受斜面的摩擦力D.M所受斜面的摩擦力大小可能先减小后"),
          t("13.下一题占位"),
        ],
      },
    ],
  };
  const r = segmentWithRules(doc);
  const q12 = r.questions.find((q) => q.number === "12");
  assert.ok(q12);
  assert.deepEqual(
    q12.options.map((o) => o.key),
    ["A", "B", "C", "D"],
  );
  // C/D 取合并后的更长文本，不再含整行重复
  assert.equal(q12.options[2]?.text, "M所受斜面的摩擦力大小一定一直增加");
  assert.equal(
    q12.options[3]?.text,
    "M所受斜面的摩擦力大小可能先减小后",
  );
  assert.equal(r.reviews.length, 0);
});

test("引擎端到端：前向缺键（A/B 上游漏检）收下 C/D 并降置信度送人工校对", () => {
  // 真实案例：p5 热狗题 A/B 为纯公式选项，layout.json 无字母前缀
  const doc: ParsedDocument = {
    docId: "reg-gap",
    pages: [
      {
        index: 0,
        width: 596,
        height: 821,
        blocks: [
          t("1.[山东泰安2022一模]路边小吃烤热狗的截面如图所示"),
          t("{ \\frac { 5 } { 8 } } G"),
          t("C.两根金属圆柱对生热狗的合力大于对熟"),
          t("D.单根金属圆柱对生热狗的弹力小于对熟"),
          t("2.下一题占位"),
        ],
      },
    ],
  };
  const r = segmentWithRules(doc);
  const q1 = r.questions.find((q) => q.number === "1");
  assert.ok(q1);
  // 旧实现：C/D 回退题干 → 0 选项且 conf 1.0 静默 ok；新实现：收下 C/D 并标记缺键
  assert.deepEqual(
    q1.options.map((o) => o.key),
    ["C", "D"],
  );
  assert.equal(q1.status, "needs_review");
  assert.ok(q1.confidence < 0.75);
  assert.ok(
    r.reviews.some((rev) => rev.reason.includes("选项缺键")),
    "应产生缺键评审",
  );
});

test("引擎端到端：选项续行归入选项而非题干（p9 第11题真实形态）", () => {
  const doc: ParsedDocument = {
    docId: "reg-cont",
    pages: [
      {
        index: 0,
        width: 596,
        height: 821,
        blocks: [
          t("11.[湖北部分重点中学2022联考]如图所示，在"),
          t("竖直平面内的固定光滑圆环上，套有一质量"),
          t("为m的小球，使小球缓慢上升，下列说法正确的是()"),
          t("A. 绳的拉力先减小后增大"),
          t("B. 设 AP 长度为 L,∆F 表示 F"),
          t("的变化量，∆L表示L的变"),
          t("化量，则比值$\\frac { \\Delta F } { \\Delta L }$不变"),
          t("C. 环对小球的弹力方向是沿半径背离圆心，"),
          t("大小恒为$\\frac { m g } { 2 }$"),
          t("D.环对小球的弹力方向是沿半径指向圆心，"),
          t("大小恒为$2 m g$"),
          t("12.下一题占位"),
        ],
      },
    ],
  };
  const r = segmentWithRules(doc);
  const q11 = r.questions.find((q) => q.number === "11");
  assert.ok(q11);
  assert.deepEqual(
    q11.options.map((o) => o.key),
    ["A", "B", "C", "D"],
  );
  // B 的续行归入 B 选项文本，而不是碎片化污染题干
  assert.match(q11.options[1]!.text, /的变化量，∆L表示L的变/);
  assert.doesNotMatch(q11.stem, /的变化量/);
  assert.match(q11.options[2]!.text, /大小恒为/);
  assert.equal(q11.status, "ok");
  assert.equal(r.reviews.length, 0);
});
