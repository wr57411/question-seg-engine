// font-metrics.test.ts —— 重建纸面字号/全角宽度度量的回归锁定。
//
// 为什么需要它：系数是全案唯一的改动点（0.72 → 1.03），却曾藏在无构建的浏览器脚本里、
// 没有任何测试——一次写错就让整体字号偏小 30% 而无人察觉。这里用**精确值**把它钉死。
// 数值权威：data/out/ink-groundtruth.md（对原卷页图墨迹的直接测量）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fontFromLineHeight,
  baseFontOfPage,
  fontForBlock,
  fontForRawBlock,
  isVerticalText,
  emWidthOf,
} from "../stages/font-metrics.js";

/** 近似断言：期望 expected ± tol */
function approx(actual: number | null, expected: number, tol: number, msg?: string) {
  assert.ok(
    actual !== null && Math.abs(actual - expected) <= tol,
    `${msg ?? ""} 期望 ${expected}±${tol}，实际 ${actual}`,
  );
}

// 尺度常量（F10）：CANVAS_W=760（阶段 1–5 画布）、PANE_W=460（对比模式单栏）；页面宽 596pt。
const PAGE_W = 596;
const CANVAS_W = 760;
const PANE_W = 460;

test("fontFromLineHeight：11pt 正文行的 hPx（11*760/596=14.032）→ 14.453（±0.01）", () => {
  approx(fontFromLineHeight(14.032), 14.453, 0.01);
});

test("正文行回归：换算回 pt 的字号 ≈ 11.33（±0.1）—— 修好后应贴回原卷 11.29pt（F2/F4）", () => {
  // 旧系数 0.72 时这里会是 0.72×11 ≈ 7.92pt（F3：偏小 30%）
  approx(fontFromLineHeight((11 * CANVAS_W) / PAGE_W) / (CANVAS_W / PAGE_W), 11.33, 0.1);
});

test("标题行回归：18pt 标题换算回 pt ≈ 18.54（±0.1）—— 标题层级随行高自动放大（F7）", () => {
  approx(fontFromLineHeight((18 * CANVAS_W) / PAGE_W) / (CANVAS_W / PAGE_W), 18.54, 0.1);
});

test("下限：安全网 4px（非保真夹子）—— fontFromLineHeight(0)=4、fontFromLineHeight(1)=4", () => {
  assert.equal(fontFromLineHeight(0), 4);
  assert.equal(fontFromLineHeight(1), 4);
});

test("对比模式口径锁：460 单栏（PANE_W）换算回 pt 仍 ≈ 11.33（±0.1）—— 防混用 760/460 口径", () => {
  // 系数 c 与 canvasW 无关（c=S_ink/bboxH），760 与 460 必须给出同一 pt 字号
  approx(fontFromLineHeight((11 * PANE_W) / PAGE_W) / (PANE_W / PAGE_W), 11.33, 0.1);
});

test("emWidthOf：全角 1.0 / ASCII 字母数字 0.5 / 空格 0.25 / 标点 0.3 / \\n\\t 0", () => {
  assert.equal(emWidthOf("重力"), 2); // 2 个全角字
  assert.equal(emWidthOf("A.0.20"), 2.6); // 0.5+0.3+0.5+0.3+0.5+0.5
  assert.equal(emWidthOf(""), 0);
  assert.equal(emWidthOf("a b\n"), 0.5 + 0.25 + 0.5); // 换行 0
});

test("baseFontOfPage：排除 \\frac 块，取正文块行高中位 → 推得的字号", () => {
  const blocks = [
    { kind: "text", text: "正文甲", bbox: [0, 0, 100, 14] },
    { kind: "text", text: "正文乙", bbox: [0, 0, 100, 15] },
    { kind: "text", text: "正文丙", bbox: [0, 0, 100, 16] },
    { kind: "text", text: "$\\frac { a } { b }$", bbox: [0, 0, 100, 44] }, // 分式撑高，须排除
  ];
  const base = baseFontOfPage(blocks, PAGE_W, CANVAS_W);
  assert.equal(base, fontFromLineHeight((15 / PAGE_W) * CANVAS_W)); // 中位 = 15
  // 若公式块被误纳，中位会变成 16（4 块排序后 index 2）——这一条正是「排除」的锁
  assert.notEqual(base, fontFromLineHeight((16 / PAGE_W) * CANVAS_W));
});

test("baseFontOfPage：无可用文本块返回 null（空页 / 全是公式块）", () => {
  assert.equal(baseFontOfPage([], PAGE_W, CANVAS_W), null);
  assert.equal(
    baseFontOfPage([{ kind: "text", text: "$x ^ { 2 }$", bbox: [0, 0, 40, 30] }], PAGE_W, CANVAS_W),
    null,
  );
});

test("fontForBlock：含上下标的块用页面基准字号；baseFont 为 null 时回退行高推算", () => {
  const eq = { kind: "text", text: "$F _ { 1 }$", bbox: [0, 0, 60, 44] };
  assert.equal(fontForBlock(eq, PAGE_W, CANVAS_W, 12.3), 12.3); // 含 _ → 用 baseFont
  assert.equal(
    fontForBlock(eq, PAGE_W, CANVAS_W, null),
    fontFromLineHeight((44 / PAGE_W) * CANVAS_W), // null → 回退行高
  );
});

test("fontForBlock：纯文本块始终按自身行高推算（标题自然更大）", () => {
  const plain = { kind: "text", text: "重力", bbox: [0, 0, 60, 15] };
  assert.equal(fontForBlock(plain, PAGE_W, CANVAS_W, 12.3), fontFromLineHeight((15 / PAGE_W) * CANVAS_W));
});

// ── Task 4：适用边界（R1 段级块 / R2 栏宽口径 / R4 竖排块）────────────────────

test("isVerticalText：bboxH > 2×bboxW 且当量宽 ≥2 命中；bboxH == 2×bboxW 严格不算竖排", () => {
  assert.equal(isVerticalText([0, 0, 13, 91], "第二章相互作用"), true); // 91 > 26 → 竖排
  assert.equal(isVerticalText([0, 0, 50, 101], "正文正文正文"), true); // 101 > 100 → 竖排
  assert.equal(isVerticalText([0, 0, 50, 100], "正文正文正文"), false); // 100 == 2×50 → **不算**（严格 >）
  assert.equal(isVerticalText([0, 0, 13, 91], "二"), false); // 当量宽 1 < 2 → 不算
  assert.equal(isVerticalText([0, 0, 100, 14], "横排正文"), false); // 横排
});

test("竖排块字号：行高取 bboxW（13pt）→ 17.08px（±0.1），而非 bboxH 的 119.5px", () => {
  // 侧栏「第二章相互作用」实测 bbox 13×91pt：bboxH 是 7 个字的**长度**方向
  const aside = { kind: "text", text: "第二章相互作用", bbox: [0, 0, 13, 91] };
  approx(fontForBlock(aside, PAGE_W, CANVAS_W, null), 17.08, 0.1);
  // 对照：误用 bboxH(91) 会得到 119.5px —— 正是溢出栏外的那个失控值
  approx(fontFromLineHeight((91 / PAGE_W) * CANVAS_W), 119.5, 0.1);
  assert.notEqual(fontForBlock(aside, PAGE_W, CANVAS_W, null), fontFromLineHeight((91 / PAGE_W) * CANVAS_W));
  // 对比栏口径（PANE_W=460）：同一竖排块 → 17.08 × 460/760 ≈ 10.34px
  approx(fontForBlock(aside, PAGE_W, PANE_W, null), 10.34, 0.1);
});

test("fontForRawBlock：段级块取 min(行高推算, 框宽当量) —— 高而窄的整段被框宽压回", () => {
  // bboxH=300pt（整段高）→ 行高推算 ≈ 394px（失控）；框宽当量 = (100/596*760)/6 ≈ 21.25px
  const para = { kind: "text", text: "重力弹力摩擦", bbox: [0, 0, 100, 300] };
  approx(fontForRawBlock(para, PAGE_W, CANVAS_W), 21.25, 0.1);
  assert.ok(fontForRawBlock(para, PAGE_W, CANVAS_W) < fontFromLineHeight((300 / PAGE_W) * CANVAS_W));
});

test("fontForRawBlock：框宽当量 > 行高推算时取行高推算（短文本不因宽框被放大）", () => {
  const head = { kind: "text", text: "重力弹", bbox: [0, 0, 300, 60] };
  assert.equal(fontForRawBlock(head, PAGE_W, CANVAS_W), fontFromLineHeight((60 / PAGE_W) * CANVAS_W));
});

test("fontForRawBlock：下限 8px、且**无 20px 上限**（上限是上一轮移除的保真夹子，不恢复）", () => {
  const dense = { kind: "text", text: "很长很长的整段文字".repeat(10), bbox: [0, 0, 120, 240] };
  assert.equal(fontForRawBlock(dense, PAGE_W, CANVAS_W), 8); // 框宽当量 < 8 → 夹到下限
  const big = { kind: "text", text: "重力", bbox: [0, 0, 300, 300] };
  assert.ok(fontForRawBlock(big, PAGE_W, CANVAS_W) > 30); // 无上限：> 30 也不夹
});

test("fontForRawBlock：无文本块（图片/空 text）宽度项退化 → 取下限 8px", () => {
  assert.equal(fontForRawBlock({ kind: "image", text: "", bbox: [0, 0, 100, 200] }, PAGE_W, CANVAS_W), 8);
  assert.equal(fontForRawBlock({ kind: "image", bbox: [0, 0, 100, 200] }, PAGE_W, CANVAS_W), 8);
});
