// audit-crop-gold.test.ts —— 锁住「独立 rec 重读是坐标正确性的金标裁判」这条判据。
//
// 反向验证链（与 goal item 2「95% 行坐标正确」的金标口径一一对应）：
//   ① 裁图重读文本 == V3 行文本 ⇒ sim=1 ⇒ correct（框确实圈住这行字）
//   ② 重读文本完全不同 ⇒ sim=0 ⇒ not correct（框圈错了行）
//   ③ 短答案标签 "B"=="B" ⇒ correct；"B" vs "C" ⇒ not correct
//   ④ 无重读结果的行不计入 precision 分母（覆盖率单独报），避免把「没读」当「读错」
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeCropGold } from "../scripts/audit-crop-gold.js";

const V = (id: string, text: string) => ({ id, text });
const R = (id: string, recText: string | null) => ({ id, recText });

test(" identical text ⇒ correct, sim=1", () => {
  const out = judgeCropGold([V("p076_g0", "易错警示：未能判断出波的传播方向")], [R("p076_g0", "易错警示：未能判断出波的传播方向")]);
  assert.equal(out.rows[0]!.correct, true);
  assert.equal(out.rows[0]!.sim, 1);
  assert.equal(out.precision, 1);
});

test(" completely different text ⇒ not correct", () => {
  const out = judgeCropGold([V("a", "甲乙丙丁戊己庚辛")], [R("a", "子丑寅卯辰巳午未")]);
  assert.equal(out.rows[0]!.correct, false);
  assert.ok(out.rows[0]!.sim < 0.8);
  assert.equal(out.precision, 0);
});

test(" short answer labels: B==B correct, B vs C not", () => {
  const out = judgeCropGold([V("a", "B"), V("b", "B")], [R("a", "B"), R("b", "C")]);
  assert.equal(out.rows[0]!.correct, true);
  assert.equal(out.rows[1]!.correct, false);
  assert.equal(out.precision, 0.5);
});

test(" missing reading excluded from precision denominator, coverage reported", () => {
  const out = judgeCropGold([V("a", "甲乙丙"), V("b", "丁戊己")], [R("a", "甲乙丙")]);
  assert.equal(out.judged, 1); // 只有 a 有重读
  assert.equal(out.coverage, 0.5); // 2 行里 1 行有重读
  assert.equal(out.precision, 1); // 有重读的里 1/1 正确
  assert.equal(out.rows.length, 1);
});

test(" threshold boundary: sim just below 0.8 ⇒ not correct", () => {
  // "甲乙丙丁" vs "甲乙丙戊"：bigram dice = 2*2/(3+3)=0.667 < 0.8
  const out = judgeCropGold([V("a", "甲乙丙丁")], [R("a", "甲乙丙戊")]);
  assert.ok(out.rows[0]!.sim < 0.8);
  assert.equal(out.rows[0]!.correct, false);
});

test(" empty victim list ⇒ precision 0, judged 0 (no NaN)", () => {
  const out = judgeCropGold([], []);
  assert.equal(out.judged, 0);
  assert.equal(out.precision, 0);
  assert.equal(out.coverage, 0);
});