// tests/pair-quality.test.ts
//
// 配对质量的**独立内容尺子**（`scripts/pair-quality.ts`，`DECISIONS §72`）。
//
// 背景：`build-bank.ts` 的结构校验（保序/守恒/唯一键/图片守恒）与配对实现同源
// （都基于 `(章, 块号, 题号)`），因此发现不了「两册不是同一本书、只是章号撞上」这类错配。
// 实测 2026-10-29：`物理_教材基础练 曲线运动 × 高考必刷题合订本` 结构校验 4/4 全过，
// 内容却完全不同（题问「xOy 平面合运动」，配到的解析讲「曲线运动基本概念」）。
// 本尺子只看文本重合，与配对键零耦合。

import assert from "node:assert/strict";
import { test } from "node:test";
import { PAIR_QUALITY_MIN, containment, pairQualityByDoc } from "../scripts/pair-quality.js";

test("containment：同一道题的题干与解析应明显重合", () => {
  // 取自真实配对（教材基础练 曲线运动 章4 组1 #1，内容尺子实测 0.3+）
  const stem =
    "某质点在xOy平面上运动，它在x方向运动的速度—时间图像如图甲所示，它在y方向运动的位移—时间图像如图乙所示，有关该质点的运动情况，下列说法正确的是";
  const answer =
    "由速度—时间图像可知，质点在x方向做匀速直线运动；由位移—时间图像可知，质点在y方向做匀加速直线运动，故该质点的合运动为匀变速曲线运动";
  assert.ok(containment(stem, answer) > 0.2, `实测 ${containment(stem, answer).toFixed(3)}`);
});

test("containment：完全不相干的两题重合应接近 0", () => {
  const stem = "嫦娥六号探测器成功发射，开启人类首次从月球背面采样返回之旅，已知地球质量约为月球的81倍";
  const answer = "伽利略设想物体下落的速度与时间成正比，通过数学推导证明位移与时间的平方成正比";
  assert.ok(containment(stem, answer) < 0.05, `实测 ${containment(stem, answer).toFixed(3)}`);
});

test("containment：公式与数字不应主导判据（去公式后按中文二元组算）", () => {
  // 题干几乎全是公式时，中文二元组极少 ⇒ 返回 NaN 或极小值，由聚合层跳过
  const c = containment("$F = k \\frac{q_1 q_2}{r^2}$", "$F = m a$");
  assert.ok(Number.isNaN(c) || c < 0.2, `实测 ${c}`);
});

test("pairQualityByDoc：整册中位重合低于阈值判不合格（跨书错配）", () => {
  const good = Array.from({ length: 10 }, (_, i) => ({
    quizDoc: "同书",
    stem: `如图所示，某质点在平面内做匀速圆周运动，半径保持不变，第${i}次测量`,
    answerText: "由匀速圆周运动可知，质点做圆周运动半径保持不变，向心力指向圆心",
  }));
  const bad = Array.from({ length: 10 }, (_, i) => ({
    quizDoc: "跨书",
    stem: `嫦娥六号探测器成功发射，开启人类首次从月球背面采样返回之旅，第${i}次变轨`,
    answerText: "伽利略设想物体下落速度与时间成正比，通过数学推导证明位移与时间平方成正比",
  }));
  const q = pairQualityByDoc([...good, ...bad]);
  assert.equal(q.get("同书")!.ok, true);
  assert.equal(q.get("跨书")!.ok, false);
  assert.ok(q.get("同书")!.median > PAIR_QUALITY_MIN);
  assert.ok(q.get("跨书")!.median < PAIR_QUALITY_MIN);
});

test("pairQualityByDoc：缺 answerText 的条目不参与统计（不污染中位数）", () => {
  const q = pairQualityByDoc([
    { quizDoc: "A", stem: "甲乙两物体沿同一直线运动", answerText: "甲乙两物体沿同一直线运动，故A正确" },
    { quizDoc: "A", stem: "丙丁", answerText: undefined },
    { quizDoc: "A", stem: "", answerText: "无关" },
  ]);
  assert.equal(q.get("A")!.n, 1, "只有 1 条可算");
});
