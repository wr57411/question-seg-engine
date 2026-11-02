// tests/experiment-subquestions.test.ts
/**
 * 实验区小问切分（`DECISIONS §103`）。
 *
 * 这组用例守四件事：
 * 1. 正常形态能切（单小节 / 多小节各自从 1 重编）；
 * 2. **不该切的必须不切**（编号跳变、首个小问不是 1、只有一个小问、小问正文过短）
 *    —— 误切会把一道题拆成残缺碎片，那是「丢内容」红线；漏切只是继续脏，可回退；
 * 3. 前导背景（栏目标题 / `一题通关` / 方法小标题）留在 `lead`，不被当小问吞掉；
 * 4. `(n-1)` 这类**行中**括号不算小问标记。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { splitExperimentSubQuestions } from "../src/patterns.js";

const L = (...xs: string[]) => xs.join("\n");

test("单小节：连续的 (1)(2)(3) 切成 3 题，前导留作背景", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 11 测量金属丝的电阻率", "一题通关 一题全练，明实验", "某同学做了以下实验。"),
    L("(1)若要研究导体电阻是否与横截面积有关,需选择_____和_____两段金属丝", "（续行）"),
    L("(2)现已完成部分电路连接,试在图1中画出曲线代替导线完成电路图连接"),
    L("(3)完成上述实验之后,该同学进一步测量了镍铬合金的电阻率"),
  ]);
  assert.ok(r);
  assert.equal(r.runs.length, 1);
  assert.deepEqual(
    r.runs[0]!.subs.map((s) => s.no),
    [1, 2, 3],
  );
  assert.equal(r.lead[0], "教材实验 11 测量金属丝的电阻率");
  assert.equal(r.lead.length, 3);
  // 小问正文从标记行开始，包含其续行
  assert.equal(r.runs[0]!.subs[0]!.lines.length, 2);
});

test("多小节：题号回到 1 即开新 run（实验 13 的 9+7）", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验13 测量电源的电动势和内阻", "一题通关一题全练，明实验", "1伏安法测电源电动势和内阻"),
    L("(1)根据闭合电路的欧姆定律,电源电动势 E、内阻 r 的关系为"),
    L("(2)该同学设计了图1中的两种电路图,应该选择的实验电路是_____"),
    L("2 安阻法测电源电动势和内阻"),
    L("(1)若电流表和电压表为理想电表,I 和 U 分别表示"),
    L("(2)按照电路图连接实物图,为了保护电压表"),
  ]);
  assert.ok(r);
  assert.equal(r.runs.length, 2);
  assert.deepEqual(
    r.runs[0]!.subs.map((s) => s.no),
    [1, 2],
  );
  assert.deepEqual(
    r.runs[1]!.subs.map((s) => s.no),
    [1, 2],
  );
  // 小节标题被剥到第二个 run 的 lead；它仍在产物里（进第二组题干的公共背景）
  assert.deepEqual(r.runs[1]!.lead, ["2 安阻法测电源电动势和内阻"]);
  assert.equal(
    r.runs[0]!.subs[1]!.lines.includes("2 安阻法测电源电动势和内阻"),
    false,
    "小节标题不应留在上一题里",
  );
});

test("编号跳变（1,2,4）⇒ 整体放弃，退回「整块一道」", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 10 长度的测量", "一题通关 一题全练，明实验"),
    L("(1)测量玻璃管内径时,应该用如图2中游标卡尺的_____部分"),
    L("(2)如图 3、4、5 所示的三把游标卡尺,读数依次为_____"),
    L("(4)螺旋测微器的读数方法如下所述"),
  ]);
  assert.equal(r, null);
});

test("首个小问不是 1 ⇒ 放弃（可能是正文里的行首编号，不是小问）", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 4 探究加速度与力、质量的关系"),
    L("(2)某同学用如图1所示的实验装置进行实验"),
    L("(3)平衡摩擦力时,下列说法正确的是"),
  ]);
  assert.equal(r, null);
});

test("只有一个小问 ⇒ 放弃（切出来是碎片，不是题）", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 5 探究平抛运动的特点"),
    L("(1)某实验小组为探究平抛运动的特点设计了如图所示的装置"),
  ]);
  assert.equal(r, null);
});

test("小问正文过短（去掉标记后 < 4 字）⇒ 放弃", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 6 探究向心力"),
    L("(1)如图"),
    L("(2)某同学在实验中测量了多组数据并画出了图像"),
  ]);
  assert.equal(r, null);
});

test("行中括号（`(n-1)` / `(0.6 A)`）不算小问标记", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 10 长度的测量"),
    L("(1)游标尺上的 n 条刻线的总长度与主尺上(n-1)条刻线的总长度相等"),
    L("(2)现有干电池、电流表(0~0.6 A)、开关、导线以及以下器材"),
  ]);
  assert.ok(r);
  assert.deepEqual(
    r.runs[0]!.subs.map((s) => s.no),
    [1, 2],
  );
});

test("全角括号同样认（`（1）`）", () => {
  const r = splitExperimentSubQuestions([
    L("教材实验 12 练习使用多用电表"),
    L("（1）该同学用多用电表测量一小段2B铅笔芯的电阻"),
    L("（2）正确操作后,多用电表的指针位置如图1所示"),
  ]);
  assert.ok(r);
  assert.equal(r.runs[0]!.subs.length, 2);
});
