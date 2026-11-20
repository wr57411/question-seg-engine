// tests/extract-band-region.test.ts —— B-50①②：教材知识萃取区判定不得依赖阅读顺序。
//
// 事故（2026-11-20 M5-A 切 OXR 后）：《运动和力》p1 / 《机械能守恒》p7 的
// 「教材知识萃取」参考框内，编号条目（`1. 提出了惯性的概念…`）被切成空题。
//
// 根因：切源后 OXR 行级框在栏间略有重叠 ⇒ `estimateGutter` 返回 null ⇒
// 阅读顺序退化为「左栏整列在前、右栏整列在后」。栏目头（跨栏横幅）被
// `assignByX0` 分给右栏，于是它**排在左栏正文之后**才处理；
// 等 `extractBand` 置真时，散文编号条目早已开过题。
//
// 修法：把「是否身处教材知识萃取区」改成按 **(页, y)** 时间线判定
// （与 `buildHeadingTimeline` 同思路：标题一定在内容上方，按 y 传播与分栏无关），
// 不再依赖块流先后。本测试锁住该行为：即使栏目头在块流里晚到，
// 它下方的编号散文也不得成题；带教材出处标注的真题仍必须切成题。
import assert from "node:assert/strict";
import { test } from "node:test";
import { segmentFromLayout } from "../src/index.js";

/** 构造一页「行级框栏间重叠」的双栏骨架：左栏块右边界越过右栏块左边界 ⇒ gutter 估不出。 */
function twoColumnOverlappingPage() {
  const blk = (x0: number, y0: number, text: string, w = 250) => ({
    type: "text",
    bbox: [x0, y0, x0 + w, y0 + 12],
    lines: [{ bbox: [x0, y0, x0 + w, y0 + 12], spans: [{ content: text }] }],
  });
  const left = [
    blk(27, 100, "1. 提出了惯性的概念。任何物体在任何状态下都具"),
    blk(27, 120, "有惯性，质量大的物体惯性大。"),
    blk(27, 140, "2. 揭示了力与运动的关系: 力是改变物体运动状态的原因。"),
    blk(27, 160, "3. 物体不受外力时将保持原来的运动状态。"),
    // 真实真题：带教材出处标注，必须仍然切成题
    blk(27, 300, "1.[人教版必修一 P113 第1题情境变式] 下列关于惯性的说法正确的是"),
    blk(27, 320, "A. 一切物体都有惯性"),
    blk(27, 340, "B. 物体的惯性就是惯性定律"),
    blk(27, 360, "C. 质量是惯性大小的量度"),
    blk(27, 380, "D. 速度越大的物体惯性越大"),
  ];
  const right = [
    blk(279, 30, "牛顿第二定律", 240),
    blk(279, 40, "矢量性→$F_{合}$ 与 a 方向相同", 240),
    // 跨栏栏目头（x0 落在右栏一侧）：y 在散文之上，但块流里会排到左栏之后
    blk(184, 50, "教材知识萃取 回归教材，萃精华", 206),
    blk(279, 60, "瞬时性→$F_{合}$ 与 a 对应同一时刻", 240),
    blk(279, 70, "因果性→$F_{合}$ 是 a 产生的原因", 240),
    // 下一个板块头 = 参考区终点（真实真题在其后，必须仍能切题）
    blk(184, 250, "教材素材变式 多维变式，夯基础", 206),
  ];
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 852],
        para_blocks: [...left, ...right],
      },
    ],
  };
}

test("B-50：教材知识萃取区的编号散文不成题（与块流先后无关）", () => {
  const r = segmentFromLayout(twoColumnOverlappingPage(), "t-extract-band");
  const stems = r.questions.map((q) => q.stem).join("\n");
  assert.ok(!stems.includes("提出了惯性的概念"), "散文编号条目被切成了题");
  assert.ok(!stems.includes("揭示了力与运动的关系"), "散文编号条目被切成了题");
  assert.ok(!stems.includes("物体不受外力"), "散文编号条目被切成了题");
});

test("B-50：同一区内带教材出处标注的真题仍必须切成题（不得一刀切抑制）", () => {
  const r = segmentFromLayout(twoColumnOverlappingPage(), "t-extract-band");
  const q = r.questions.find((x) => x.stem.includes("下列关于惯性的说法正确的是"));
  assert.ok(q, "带出处标注的真题应切成题");
  assert.equal(q!.type, "choice");
  assert.deepEqual(
    q!.options.map((o) => o.key),
    ["A", "B", "C", "D"],
  );
});
