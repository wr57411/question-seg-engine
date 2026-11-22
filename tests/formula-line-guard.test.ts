// tests/formula-line-guard.test.ts
//
// 「纯公式行守卫」（B-61）：解答过程的编号方程行（`1. $mgh+W=…$`）被切成假题
// （实测 6维解析册 p40 b52 → q298，stem=推导公式，证据
// docs/evidence/2026-11-22-6维解析册-假题q298-动能定理编号方程.png）。
//
// 判据（最严 AND，宁漏不误）：
//   ① 题号分隔符后**紧跟 `$`**（LaTeX 公式开头）；
//   ② **整行无汉字**（真题的公式行后面必然跟中文正文「下列说法…/则…/求…」，
//      编号推导方程是纯公式行——这正是两类形态的唯一可靠分界）。
// 两条同时成立 ⇒ 不是题号，退回普通文本（内容并入当前题，不丢内容）。
//
// 回归红线：真题的「公式 + 中文正文」形态不受影响；`1.5` 小数、`0` 出域等既有守卫不变。

import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";

test("纯公式行守卫：编号方程「1. $mgh+W=…$」（无汉字）不是题号（q298 实测形态）", () => {
  const r = matchFirstLine("1. $1\\,mgh+W=\\frac{1}{2}\\times1.1\\,mv_{1}^{2}-\\frac{1}{2}\\times1.1\\,mv_{0}^{2}$");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "other");
});

test("纯公式行守卫：多字母题号「12. $x=v_0t+…$」纯公式同样不认", () => {
  assert.equal(matchFirstLine("12. $\\frac{U_{1}}{U_{2}}=\\frac{n_{1}}{n_{2}}$").ok, false);
});

test("守卫不误伤：公式后带中文正文仍是题号（真题形态）", () => {
  const r = matchFirstLine("1. $F=ma$ 下列说法正确的是（　　）");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "question_no");
  assert.equal(r.captured, "1");
});

test("守卫不误伤：带出处标注的真题不受影响", () => {
  const r = matchFirstLine("12. [江苏盐城联盟校 2025 联考]2024 年 8 月 5 日，江苏南京部分地区出现短时强降水");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "question_no");
  assert.equal(r.captured, "12");
});

test("守卫不误伤：答案式题号「1. C 考查点…」不受影响", () => {
  const r = matchFirstLine("1. C 考查点 ▸质点、位移、时间间隔、缓冲现象");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "question_no");
  assert.equal(r.captured, "1");
});

test("既有守卫回归：小数 `1.5` 仍不是题号；`0` 仍出域", () => {
  assert.equal(matchFirstLine("1.5 说明物理量间的关系").ok, false);
  assert.equal(matchFirstLine("0.5 说明物理量间的关系").ok, false);
});
