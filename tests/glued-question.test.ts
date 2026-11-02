// tests/glued-question.test.ts
//
// 「题号黏正文」判据（`src/patterns.ts` 的 `matchGluedQuestionNumber`，`DECISIONS §77`）。
//
// 背景：实验题的题号常直接黏在正文前（`2为了减少阻力对实验结果的影响…`），既没点也没空格，
// `ARABIC_QUESTION` 认不出 ⇒ 整道实验题被并进上一题的题干。
//
// 为什么必须这么严：全量扫描「数字紧跟汉字」有 **247 行**，绝大多数是续行
// （`30m,汽车减速…`、`45°时…`、`2m的货车…`）或表格/栏目内容（`10分度、20分度`、`2必刷考点`）。
// 放宽形状必然造出大量假题 —— 假题会污染题库、配对与题号审计，比漏切危险得多。

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchGluedQuestionNumber } from "../src/patterns.js";

test("黏连题号：数字紧跟汉字且序号接上一题 ⇒ 认（实测真例）", () => {
  assert.equal(
    matchGluedQuestionNumber("2为了减少阻力对实验结果的影响，小星同学决定用气垫导轨", 2),
    "2",
  );
  assert.equal(
    matchGluedQuestionNumber("2宇宙中存在一些离其他恒星较远的三星系统，通常可忽略", 2),
    "2",
  );
  assert.equal(
    matchGluedQuestionNumber("3如图为一种四颗星体组成的稳定星系,四颗质量均为m", 3),
    "3",
  );
});

test("黏连题号：序号不接上一题 ⇒ 不认（续行里的数字几乎不可能恰好 +1）", () => {
  assert.equal(matchGluedQuestionNumber("2为了减少阻力对实验结果的影响，小星同学", 3), null);
  assert.equal(matchGluedQuestionNumber("2为了减少阻力对实验结果的影响，小星同学", null), null);
});

test("黏连题号：数字后接拉丁字母/单位 ⇒ 不认（`30m`/`45°`/`2m` 是量值不是题号）", () => {
  assert.equal(matchGluedQuestionNumber("30m,汽车减速过程视为匀减速运动.同一条", 30), null);
  assert.equal(matchGluedQuestionNumber("45°时，该体验者所受的摩擦力大小恰好相等", 45), null);
  assert.equal(matchGluedQuestionNumber("2m的货车，以v0=9 m/s的速度匀速", 2), null);
});

test("黏连题号：数字后接量词/标签字 ⇒ 不认（`3题模型变式]` 的 3 是标签的一部分）", () => {
  // 实测反例（磁场 p4）：按题号切出来题干以「题模型变式]」开头，是标签残片
  assert.equal(matchGluedQuestionNumber("3题模型变式]如图所示,在竖直平面内存在垂直", 3), null);
  assert.equal(matchGluedQuestionNumber("10分度、20分度、50分度，它们的读数依次", 10), null);
  assert.equal(matchGluedQuestionNumber("2必刷考点 T1~7", 2), null);
});

test("黏连题号：整行太短 ⇒ 不认（真题干是长句，短碎片是续行）", () => {
  assert.equal(matchGluedQuestionNumber("1所示，粒子", 1), null);
  assert.equal(matchGluedQuestionNumber("2所受向心力", 2), null);
});

test("黏连题号：序号为 0 或越界 ⇒ 不认（题号域 1~99）", () => {
  assert.equal(matchGluedQuestionNumber("0连接在一起，初始时刻滑轮2与P间的轻绳", 0), null);
  assert.equal(matchGluedQuestionNumber("12宇宙中存在一些离其他恒星较远的三星系统", 12), "12");
});
