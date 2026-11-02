// tests/patterns-fraction.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchAnswerEntry, matchFirstLine, stripQuestionPrefix } from "../src/patterns.js";

test("0.x 小数行不再判为题号（幽灵题号守卫）", () => {
  for (const line of ["0.2,最大静摩擦力与滑动摩擦力大小相等", "0.8,不计滑轮与轻绳间的摩擦", "0.5,最大静摩擦力等于滑动摩擦力", "0.4kg的小球，劲度系数为"]) {
    assert.notEqual(matchFirstLine(line).kind, "question_no", `「${line}」不应是题号`);
    assert.equal(matchFirstLine(line).kind, "other");
  }
});

/**
 * 真实回归（2026-10-12）：域约束「题号首位 1-9」。
 * 答案册 p19 第 6 题解答里一行原文 `0.5~1.5 s内 mg sinθ−μmg cosθ=ma₂`，
 * MinerU 把 `0.5` 的 `5` 数学化成 `$5` ⇒ 该行首变成 `0.$5 …`。
 * 旧的「半角点后接数字才算小数」守卫看到 `$` 便放行，凭空切出一道「第 0 题」，
 * 页面上表现为「6 后面跟一个 0」。
 */
test("域约束：题号首位必须是 1-9，`0.$5 …` 这类被读碎的小数不再是题号", () => {
  const brokenDecimal = "0.$5 \\sim 1 . 5 \\mathrm { ~ s ~ }$内$m g \\sin \\theta - \\mu m g \\cos \\theta = m a _ { 2 }$";
  assert.equal(matchFirstLine(brokenDecimal).kind, "other", "`0.$5 …` 不是题号");
  assert.equal(stripQuestionPrefix(brokenDecimal), brokenDecimal, "被拒的形态，剥离层必须一个字都不动");
  assert.equal(matchAnswerEntry("0.$5,不"), null, "答案条目同样不得把 0 当题号");
  assert.equal(matchFirstLine("0.5~1.5 s内，小煤块…").kind, "other", "区间号 `0~` 也不是题号");
  // ⚠️ **残留缺口（不在此处断言，登记备查）**：同族里 `1.$5 …`（即 1.5 被读碎）**仍会被判成题号 1**
  // —— 域约束只挡 0，挡不住首位合法的被读碎小数。这类行只能靠「组内题号非单调」这类
  // **上下文合理性**判据发现（见 scripts/audit-numbering.ts 的 N7 提示项）。
});

test("真题号形态不受影响", () => {
  assert.equal(matchFirstLine("1．设集合 A = {x}，则…").kind, "question_no");
  assert.equal(matchFirstLine("1. 设集合 A = {x}，则…").kind, "question_no");
  assert.equal(matchFirstLine("2.已知函数 f(x) = 2x - 4，则…").kind, "question_no");
  assert.equal(matchFirstLine("3) 求 a、b 的值").kind, "question_no");
  // 2026-10-12：括号小问改为 sub_question（并入当前题，不新开题）
  assert.equal(matchFirstLine("（2）求 f(x) 的最大值").kind, "sub_question");
});

test("分支 1 加固：数字与半角点间空格容忍，但空格后接数字仍拒（0 . 2）", () => {
  assert.equal(matchFirstLine("1 . 设集合 A = {x}，则…").kind, "question_no", "「1 . 设」应恢复容忍");
  assert.equal(matchFirstLine("12 . 已知函数 f(x)，则…").kind, "question_no", "两位数 + 空格 + 半角点也应放行");
  assert.notEqual(matchFirstLine("0 . 2,最大静摩擦力与滑动摩擦力大小相等").kind, "question_no", "「0 . 2,」空格后仍接数字 → 仍应拒");
  assert.equal(matchFirstLine("0 . 2,最大静摩擦力与滑动摩擦力大小相等").kind, "other");
});

test("stripQuestionPrefix：小数行前缀保留进题干，真题号正常剥除", () => {
  // 守卫：0.x 行不作为题号剥离，前缀原样保留进题干（Task 2 手工实测的自动化契约）
  assert.equal(stripQuestionPrefix("0.5,最大静摩擦力等于滑动摩擦力，重力加速度"), "0.5,最大静摩擦力等于滑动摩擦力，重力加速度");
  assert.equal(stripQuestionPrefix("0.4kg的小球，劲度系数为"), "0.4kg的小球，劲度系数为");
  // 真题号两分支形态正常剥除（含数字与半角点间空格 → 与 ARABIC_QUESTION 判定层一致）
  assert.equal(stripQuestionPrefix("1．设集合 A = {x}"), "设集合 A = {x}");
  assert.equal(stripQuestionPrefix("2.已知函数 f(x) = 2x - 4"), "已知函数 f(x) = 2x - 4");
  assert.equal(stripQuestionPrefix("1 . 设集合 A = {x}"), "设集合 A = {x}", "「1 . 设」判定层可过，剥离层必须同步剥除");
  // 空格后接数字仍不剥（"0 . 2," 与 "0.2," 同属小数形态）
  assert.equal(stripQuestionPrefix("0 . 2,最大静摩擦力与滑动摩擦力大小相等"), "0 . 2,最大静摩擦力与滑动摩擦力大小相等");
});

test("matchAnswerEntry：答案条目「1．B」正常解析，0.x 行守卫生效", () => {
  assert.deepEqual(matchAnswerEntry("1．B"), { number: "1", text: "B" });
  assert.deepEqual(matchAnswerEntry("2. C"), { number: "2", text: "C" });
  assert.deepEqual(matchAnswerEntry("3) A、B"), { number: "3", text: "A、B" });
  assert.equal(matchAnswerEntry("0.5,不"), null, "0.x 行不应判为答案条目");
  assert.equal(matchAnswerEntry("0 . 5,不"), null, "「0 . 5」空格后仍接数字 → 仍应拒");
  assert.deepEqual(matchAnswerEntry("1 . B"), { number: "1", text: "B" }, "与判定层一致的「1 . B」应可解析");
});
test("徽标题号：数字后接 [ / 【 / 四位年份 才判题号（2026-10-28《教材基础练 磁场》）", () => {
  for (const line of [
    "1 2024年1月浙江卷 [鲁科版选修二P8第3题设问变式]磁电式电表",
    "2[鲁科版必修三 P146 科学书屋拓展变式]中国宋代科学家沈括",
    "3[多选][人教版必修三P108第4题角度变式]如图,某科技小组",
    "4 [人教版必修三 P111 图 13.2]反亥姆霍兹线圈",
    "4 2024 广西卷 [人教版必修三 P71 图 11.4-9 拓展变式]将横截面相同",
    "42024广西卷人教版必修三P71图11.4-9拓展",
    "1 火灾逃生的首要原则",
    "2「粤教版必修一P83图3-5-5角度变式]如图所示",
  ]) {
    assert.equal(matchFirstLine(line).kind, "question_no", `「${line}」应判徽标题号`);
  }
  // 正文数字不误伤：数字后接普通单位/量词 → 仍不是题号
  for (const line of ["10 m 的位移", "2 个相同的小木块", "3 种情况", "2024年1月浙江卷"]) {
    assert.notEqual(matchFirstLine(line).kind, "question_no", `「${line}」不应判题号`);
  }
  assert.equal(stripQuestionPrefix("2[鲁科版必修三 P146 科学书屋拓展变式]"), "[鲁科版必修三 P146 科学书屋拓展变式]");
  assert.equal(stripQuestionPrefix("1 2024年1月浙江卷 [鲁科版]"), "2024年1月浙江卷 [鲁科版]");
  assert.equal(stripQuestionPrefix("4 2024 广西卷 [人教版]"), "2024 广西卷 [人教版]");
  assert.equal(stripQuestionPrefix("42024广西卷人教版"), "2024广西卷人教版", "MinerU 粘连形态也要能剥");
  assert.equal(stripQuestionPrefix("1 火灾逃生的首要原则"), "火灾逃生的首要原则");
});

test("教材栏目标题：教材知识萃取/教材素材变式/变式N 不是题干", () => {
  for (const line of ["教材知识萃取 回归教材，萃精华", "教材知识萃取回归教材，萃精华", "教材素材变式 多维变式，夯基础", "教材素材变式多维变式，夯基础", "教材知识 55 电路中的能量转化", "教材模型3 等时圆模型", "教材模型攻略 剖析模型，通思路", "变式1 磁现象和磁场", "变式3 电路的串、并联", "☑ 变式 3 转动关联模型"]) {
    assert.equal(matchFirstLine(line).kind, "section", `「${line}」应为栏目标题`);
  }
});
