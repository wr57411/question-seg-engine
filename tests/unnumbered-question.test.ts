// tests/unnumbered-question.test.ts —— B-56 / B-50③：无题号真题块必须恢复成题。
//
// 事故（2026-11-20 M5-A 切 OXR 后）：OXR 解析**偶发丢掉行首题号**，块首直接是
// 「年份卷 [出处]」或「[出处]」标注（同一页里 `2.[…]` / `4 2024 安徽卷` 又带着题号，
// 故不是格式差异而是上游逐块丢失）。引擎的 `matchFirstLine` 认不出 ⇒ 整题丢失，
// 或更糟：被并进上一题题干（实测《曲线运动》p15 的「2024 江西卷」被并进 #1）。
//
// 实测命中（生产 layout 全量扫描，14 处）：《机械能守恒》p1/p2/p4/p15/p17、
// 《运动和力》p3/p8、《曲线运动》p7/p15、《万有引力》p3/p7。
// 逐页回原卷核对（tmp/t2-structure2/crops/R1–R8）全部是真题。
//
// 修法：`matchUnnumberedQuestionLine` 认行首出处标注；号数由**向后看下一个题号块**
// 反推（`nextNum - 1`），与「节内题号重启」无关，故跨页/跨栏都成立。
// 判据最严（AND）：行首必须是出处标注 + 块足够长 + 后方确实存在下一个题号块。
// 不满足则返回 null，退回原行为（正文并入当前题），不硬切、不造假题。
import assert from "node:assert/strict";
import { test } from "node:test";
import { segmentFromLayout } from "../src/index.js";

/** 文本块：单行，bbox 高 12pt（行级框）。 */
function blk(x0: number, y0: number, text: string, w = 280) {
  return {
    type: "text",
    bbox: [x0, y0, x0 + w, y0 + 12],
    lines: [{ bbox: [x0, y0, x0 + w, y0 + 12], spans: [{ content: text }] }],
  };
}

test("B-56：同页内「年份卷 [出处]」无题号真题块恢复为下一题（号数由后一块反推）", () => {
  const r = segmentFromLayout(
    {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [596, 852],
          para_blocks: [
            blk(27, 100, "1. 下列关于惯性的说法正确的是"),
            blk(27, 116, "A. 一切物体都有惯性"),
            blk(27, 132, "B. 物体的惯性就是惯性定律"),
            // 原卷 `2 2023 北京卷 [人教版必修二 P74 图 8.1-1 拓展变式] …`，OXR 丢了 `2`
            blk(27, 170, "2023 北京卷 [人教版必修二 P74 图 8.1-1 拓展变式] 如图所示, 一物体在力 F 作用下沿水平桌面做匀加速直线运动。"),
            blk(27, 186, "A. 摩擦力做功大小与 F 方向无关"),
            blk(27, 202, "B. 合力做功大小与 F 方向有关"),
            blk(27, 240, "3. [多选][鲁科版必修二P7第4题情境变式] 如图所示, 长为 L 的平板静置于光滑的水平面上。"),
          ],
        },
      ],
    },
    "t-unnumbered",
  );
  const nums = r.questions.map((q) => q.number);
  assert.ok(nums.includes("2"), `无题号真题块未成题：${JSON.stringify(nums)}`);
  const q2 = r.questions.find((q) => q.number === "2")!;
  assert.match(q2.stem, /2023 北京卷/, "第 2 题题干应保留出处标注");
  // 不得把该块并进第 1 题（那是当前的病态行为）
  const q1 = r.questions.find((q) => q.number === "1")!;
  assert.ok(!q1.stem.includes("2023 北京卷"), "无题号真题块被并进上一题题干");
});

test("B-56：跨页续题的无题号真题块恢复为上一题 + 1（不因页边界重置为 1）", () => {
  const r = segmentFromLayout(
    {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [596, 852],
          para_blocks: [
            blk(27, 100, "8. [粤教版必修二 P114 第5题条件变式] 总质量为 m 的动车组在平直的轨道上行驶。"),
            blk(27, 116, "A. 选项一"),
            blk(27, 132, "B. 选项二"),
          ],
        },
        {
          page_idx: 1,
          page_size: [596, 852],
          para_blocks: [
            // 原卷 `9[人教版必修二 P94 第5题设问变式] 把一个小球放在竖立的弹簧上…`，OXR 丢了 `9`
            blk(27, 60, "[人教版必修二 P94 第 5 题设问变式] 把一个小球放在竖立的弹簧上, 并把小球向下按至 A 位置。"),
            blk(27, 76, "A. 选项一"),
            blk(27, 92, "B. 选项二"),
            blk(27, 130, "10. [鲁科版必修二 P13 迷你实验室模型变式] 如图所示, 有一长为 L 的软绳。"),
          ],
        },
      ],
    },
    "t-unnumbered-crosspage",
  );
  const nums = r.questions.map((q) => q.number);
  assert.ok(nums.includes("9"), `跨页无题号真题块未成题：${JSON.stringify(nums)}`);
  const q9 = r.questions.find((q) => q.number === "9")!;
  assert.match(q9.stem, /把一个小球放在竖立的弹簧上/);
});

test("B-56：行首像出处标注但不是题的块不得硬切（负向守卫）", () => {
  const r = segmentFromLayout(
    {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [596, 852],
          para_blocks: [
            blk(27, 100, "1. 下列说法正确的是"),
            // 续行以年份开头（不是出处标注、无方括号标签）⇒ 必须仍是第 1 题题干
            blk(27, 116, "2023 年 6 月, 某同学做实验时观察到如下现象。"),
            blk(27, 132, "A. 选项一"),
            blk(27, 148, "B. 选项二"),
          ],
        },
      ],
    },
    "t-unnumbered-negative",
  );
  assert.equal(r.questions.length, 1, "把题干续行切成了假题");
  assert.match(r.questions[0]!.stem, /2023 年 6 月/);
});
