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
  hasMathSource,
  clampByWidth,
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

// ── Task 10：判据统一（含 LaTeX 源码一律用 baseFont，与 clampByWidth 同源）──────────

test("fontForBlock：含 \\angle（有反斜杠、无 _^）的块返回 baseFont —— 判据统一到 hasMathSource", () => {
  // 此前用窄正则（只认 \frac/\sqrt/下标），`\angle A O B` 不命中 → 走行高模型。
  // bboxH=30pt 被二维结构撑高，行高推算会给出偏大的字号（正是第 9 页溢出的来源）。
  const angle = { kind: "text", text: "\\angle A O B", bbox: [0, 0, 80, 30] };
  assert.equal(hasMathSource(angle.text), true, "前提：\\angle 含反斜杠 → 命中 hasMathSource");
  assert.equal(fontForBlock(angle, PAGE_W, CANVAS_W, 12.3), 12.3); // 现用页面基准字号
  // 对照：旧窄判据不命中 → 会走行高模型，字号 ≠ baseFont（且更大）
  const byLineHeight = fontFromLineHeight((30 / PAGE_W) * CANVAS_W);
  assert.notEqual(fontForBlock(angle, PAGE_W, CANVAS_W, 12.3), byLineHeight);
  assert.ok(byLineHeight > 12.3, "行高模型确实会给出更大的字号（故统一判据是缩小方向）");
});

test("fontForBlock：含 $（美元符、无 _^）的块返回 baseFont —— 判据统一到 hasMathSource", () => {
  const dollar = { kind: "text", text: "$v$", bbox: [0, 0, 40, 40] };
  assert.equal(hasMathSource(dollar.text), true);
  assert.equal(fontForBlock(dollar, PAGE_W, CANVAS_W, 12.3), 12.3);
});

test("fontForBlock：纯文本块仍按自身行高推算（不含 LaTeX 源码不受本条裁定影响）", () => {
  const plain = { kind: "text", text: "重力弹力", bbox: [0, 0, 60, 15] };
  assert.equal(hasMathSource(plain.text), false);
  assert.equal(fontForBlock(plain, PAGE_W, CANVAS_W, 12.3), fontFromLineHeight((15 / PAGE_W) * CANVAS_W));
});

test("baseFontOfPage：含 \\angle（有反斜杠、无 _^）的行同样被排除出样本 —— 判据同源", () => {
  // 统一前该行不被排除（旧窄正则不命中）→ 会参与中位数；统一后与 \frac 行同等待遇
  const blocks = [
    { kind: "text", text: "正文甲", bbox: [0, 0, 100, 14] },
    { kind: "text", text: "正文乙", bbox: [0, 0, 100, 15] },
    { kind: "text", text: "正文丙", bbox: [0, 0, 100, 16] },
    { kind: "text", text: "\\angle A O B", bbox: [0, 0, 100, 40] }, // 含 \ → 须排除
  ];
  const base = baseFontOfPage(blocks, PAGE_W, CANVAS_W);
  assert.equal(base, fontFromLineHeight((15 / PAGE_W) * CANVAS_W)); // 中位仍为 15（4 块排序后取 index 2 会是 16 若未排除）
  assert.notEqual(base, fontFromLineHeight((16 / PAGE_W) * CANVAS_W));
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

// ── Task 5：宽度安全上限（R3/R5）─────────────────────────────────────────────

test("clampByWidth：文字未溢出 bbox 时原样返回（不削保真）", () => {
  // bbox 宽 200pt → 画布 255px；2 字全角 em=2 → 上限 127.5px，字号 15 < 127.5 → 不变
  const b = { kind: "text", text: "重力", bbox: [0, 0, 200, 15] };
  assert.equal(clampByWidth(15, b, PAGE_W, CANVAS_W), 15);
});

test("clampByWidth：会横向溢出的块被夹到 bboxW_px / emWidthOf（纯 CJK 恰填满）", () => {
  // bbox 宽 60pt → 画布 76.5px；5 字全角 em=5 → 上限 15.3px；行高推算 20 > 15.3 → 夹到 15.3
  const b = { kind: "text", text: "重力弹力摩", bbox: [0, 0, 60, 15] };
  approx(clampByWidth(20, b, PAGE_W, CANVAS_W), 15.3, 0.1);
  // 夹后 5 字 × 15.3 = 76.5 = bbox 宽（画布 px）——恰填满，不溢出也不留白
  approx(emWidthOf("重力弹力摩") * clampByWidth(20, b, PAGE_W, CANVAS_W), (60 / PAGE_W) * CANVAS_W, 0.1);
});

test("clampByWidth：含 ASCII 的块按同一 emWidthOf 夹（与字号保真度节同源度量）", () => {
  // bbox 宽 100pt → 127.5px；"A.0.20" em = 0.5+0.3+0.5+0.3+0.5+0.5 = 2.6 → 上限 49.04px
  const b = { kind: "text", text: "A.0.20", bbox: [0, 0, 100, 15] };
  approx(clampByWidth(80, b, PAGE_W, CANVAS_W), 127.5 / 2.6, 0.01);
});

test("clampByWidth：竖排块（R4）与无文本块原样返回（横向宽度非约束）", () => {
  const v = { kind: "text", text: "第二章相互作用", bbox: [0, 0, 13, 91] };
  assert.equal(clampByWidth(17.08, v, PAGE_W, CANVAS_W), 17.08);
  assert.equal(clampByWidth(9, { kind: "image", text: "", bbox: [0, 0, 10, 200] }, PAGE_W, CANVAS_W), 9);
  assert.equal(clampByWidth(9, { kind: "image", bbox: [0, 0, 10, 200] }, PAGE_W, CANVAS_W), 9);
});

// ── Task 7：公式源码判定 + 公式块豁免夹子（修复 C1 过夹）────────────────────────

test("hasMathSource：反斜杠/美元符/下划线/脱字符任一即命中（逐字用 /[\\\\$]|[_^]/）", () => {
  assert.equal(hasMathSource("$F_{1}$"), true); // 美元符 + 下划线
  assert.equal(hasMathSource("\\frac{mg}{k_1+k_2}"), true); // 反斜杠
  assert.equal(hasMathSource("v_0"), true); // 仅下划线
  assert.equal(hasMathSource("x^2"), true); // 仅脱字符
  assert.equal(hasMathSource("重力弹力摩擦力"), false); // 纯 CJK：无公式源码
  assert.equal(hasMathSource("A.0.20 B.0.30"), false); // 纯 ASCII 标点数字：无公式源码
  assert.equal(hasMathSource(""), false);
  assert.equal(hasMathSource(undefined as unknown as string), false); // 容空
});

test("clampByWidth：含公式源码的块**豁免夹子**（返回未夹字号）—— 修复 C1 过夹", () => {
  // 原始 LaTeX 源码当量宽远大于渲染文本（3–5×），夹子若生效会把字号压到基准的 0.2–0.75×
  const frac = { kind: "text", text: "{ \\frac { \\sqrt { 3 } } { 3 } } m g", bbox: [0, 0, 60, 15] };
  const wPx = (60 / PAGE_W) * CANVAS_W;
  // 先证明「若无豁免，夹子确实会把它压小」：emWidthOf(raw) 远大于渲染文本 → 上限 < 8.74
  assert.ok(wPx / emWidthOf(frac.text) < 8.74, "前提：原始 LaTeX 当量宽会触发夹子");
  // 豁免后：原样返回未夹字号（修复前这里是 ≈6.5px，即基准 8.74px 的 0.74×）
  assert.equal(clampByWidth(8.74, frac, PAGE_W, CANVAS_W), 8.74);
  const sub = { kind: "text", text: "$F_{1}$", bbox: [0, 0, 60, 15] };
  assert.equal(clampByWidth(8.74, sub, PAGE_W, CANVAS_W), 8.74);
});

test("clampByWidth：豁免只针对公式源码块 —— 同一 bbox/字号的纯 CJK 块仍被夹", () => {
  const cjk = { kind: "text", text: "重力弹力摩", bbox: [0, 0, 60, 15] };
  approx(clampByWidth(20, cjk, PAGE_W, CANVAS_W), 15.3, 0.1); // 5 字 → 76.5/5 = 15.3
  // 含 ASCII 但无公式源码的块同样仍被夹（不受豁免影响）
  const ascii = { kind: "text", text: "A.0.20", bbox: [0, 0, 100, 15] };
  approx(clampByWidth(80, ascii, PAGE_W, CANVAS_W), 127.5 / 2.6, 0.01);
});
