// tests/ocr-page-fill-jobs.test.ts —— B-28 批次 1：直连作业接口整页补行的 L2 匹配与判据（纯函数）
// SPEC：docs/specs/2026-11-05-ocr-jobs-migration.md §4（重叠≥0.6 + 列一致 + ≥2 硬字符；判据与 MCP 路径同阈值）
// ⚠️ 分母修订（用户 2026-11-05 批准）：重叠比 = 重叠面积/**洞面积**（行框盖住洞）。
//   SPEC 字面的「/行框面积」实测不可达：V3 行框是整视觉行、MinerU 洞是行内碎片（行框比洞高 1.4–1.7 倍），
//   真配对上限 0.33–0.59 ⇒ 4 页 14 洞 0 命中；「/洞面积」下真配对 0.67–0.99（详见脚本文件头）。
// 方案 §11.2 教训：洞↔行不 1:1 会把同一行的字填进好几个洞 ⇒ 一行多洞只取覆盖率最大者、其余记冲突不猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hardChars,
  holesOf,
  judgeFormulaHole,
  judgeHole,
  matchFormulasToHoles,
  matchLinesToHoles,
} from "../scripts/ocr-page-fill-jobs.js";
import type { Box, PaddleLine } from "../scripts/paddle-client.js";

/** 测试页：W=100 / H=200（pt 域），页宽中线 mid=50。 */
const W = 100;
const H = 200;

/** 用 pt 坐标构造行（内部转 0..1 norm，模拟 PaddleLine）。 */
const line = (text: string, x0: number, y0: number, x1: number, y1: number, score = 0.98): PaddleLine => ({
  text,
  score,
  bbox: null,
  norm: [x0 / W, y0 / H, x1 / W, y1 / H] as Box,
});
const box = (x0: number, y0: number, x1: number, y1: number): Box => [x0, y0, x1, y1];

test("hardChars：剥空白与 LaTeX 记号 $ \\ { }，与 ocr-page-fill.ts:hardNorm 同口径", () => {
  assert.equal(hardChars("a b"), 2);
  assert.equal(hardChars("$ \\frac{1}{2} "), 6); // frac12
  assert.equal(hardChars("$ x $"), 1);
  assert.equal(hardChars("。"), 1);
});

test("holesOf：只收 content 且宽/高 ≥1.5（家具、竖条、薄片排除）", () => {
  const page = {
    uncovered: [
      { bbox: box(10, 100, 45, 110), kind: "content" }, // ✓ 宽高比 3.5
      { bbox: box(10, 100, 45, 130), kind: "furniture" }, // 家具排除
      { bbox: box(283, 129, 284.4, 744), kind: "content" }, // 竖条（比 <1.5）排除
      { bbox: box(10, 100, 20, 130), kind: "content" }, // 竖条排除
    ],
  };
  assert.deepEqual(holesOf(page), [box(10, 100, 45, 110)]);
});

test("matchLinesToHoles：中心距 ≤8pt 归洞；一洞多行按 y 序拼接；输入乱序也按 y0 遍历", () => {
  // 洞是横向碎片（宽/高 7，与真实洞同形态）；两行框中心都在半行距内（V3 行框带 padding，相邻行会都压住短洞）
  const hole = box(10, 100, 80, 110); // 面积 700
  const upper = line("上无 $ \\frac{1}{2} $", 10, 100, 80, 108); // 盖住 560/700 = 0.80
  const lower = line("下无而二四", 10, 103, 80, 112); // 盖住 490/700 = 0.70
  const { holeLines, conflicts, orderedLines } = matchLinesToHoles([lower, upper], [hole], W, H);
  assert.deepEqual(
    holeLines[0]!.map((l) => l.text),
    [upper.text, lower.text],
    "两行都归同一洞且按 y 序（上在前）",
  );
  assert.equal(conflicts[0], null);
  assert.deepEqual(orderedLines.map((l) => l.text), [upper.text, lower.text], "orderedLines 按 y0 序（fullText 用）");
});

test("matchLinesToHoles：中心距 >8pt 不归（薄线压洞边）", () => {
  const hole = box(10, 100, 45, 110); // 中心 y=105
  const l = line("上无而二四", 30, 98, 45, 150); // 中心 y=124 ⇒ dy=19pt > 8
  const { holeLines } = matchLinesToHoles([l], [hole], W, H);
  assert.equal(holeLines[0]!.length, 0);
});

test("matchLinesToHoles：列不一致（行与洞的 x0 异侧）不归 —— 几何上重叠再满也不许跨列", () => {
  const hole = box(20, 100, 80, 110); // x0=20 < mid（左列）
  const l = line("上无而二四", 55, 101, 80, 109); // x0=55 > mid（右列），交集=行面积 100%
  const { holeLines } = matchLinesToHoles([l], [hole], W, H);
  assert.equal(holeLines[0]!.length, 0);
});

test("matchLinesToHoles：单硬字符行不落位（无法核对），但仍进 orderedLines（fullText 不丢）", () => {
  const hole = box(10, 100, 45, 110);
  const l = line("$ x $", 10, 100, 45, 110); // 硬字符 1
  const { holeLines, orderedLines } = matchLinesToHoles([l], [hole], W, H);
  assert.equal(holeLines[0]!.length, 0);
  assert.equal(orderedLines.length, 1);
});

test("matchLinesToHoles：同排多洞中心相同时取覆盖率最大者，其余记 lineMultiHole 冲突（不猜）", () => {
  // 现实形态（分母=洞面积后可双命中）：同一行盖住同排两个不相交的窄洞
  const c1 = box(10, 100, 35, 110); // 面积 250
  const c2 = box(45, 100, 80, 110); // 面积 350
  const l = line("上无而二四", 10, 100, 70, 110); // 盖 c1 100%、盖 c2 250/350 = 0.71 ⇒ 双命中
  const { holeLines, conflicts } = matchLinesToHoles([l], [c1, c2], W, H);
  assert.equal(holeLines[0]!.length, 1, "行归覆盖率最大者 c1（1.0 > 0.71）");
  assert.equal(holeLines[1]!.length, 0, "c2 不猜");
  assert.match(conflicts[1]!, /lineMultiHole/);
  assert.equal(conflicts[0], null);
});

test("matchFormulasToHoles：公式框盖住洞 ≥0.6 归洞、无硬字符门槛、跨列不归、LaTeX 原样保留", () => {
  const f = (latex: string, x0: number, y0: number, x1: number, y1: number) => ({
    latex,
    bbox: null,
    norm: [x0 / W, y0 / H, x1 / W, y1 / H] as Box,
  });
  const hole = box(10, 100, 80, 110);
  const { holeFormulas, conflicts } = matchFormulasToHoles(
    [f("\\frac { 1 } { 2 }", 10, 100, 80, 108), f("跨列公式", 55, 100, 95, 108)],
    [hole],
    W,
    H,
  );
  assert.deepEqual(holeFormulas[0]!.map((x) => x.latex), ["\\frac { 1 } { 2 }"], "跨列公式不归；LaTeX 不清洗");
  assert.equal(conflicts[0], null);
  const { holeFormulas: hf2 } = matchFormulasToHoles([f("x", 10, 100, 80, 108)], [box(10, 100, 45, 110), box(45, 100, 80, 110)], W, H);
  assert.equal(hf2[0]!.length, 1, "一行盖住两洞：归覆盖率相同者中的先到者（稳定序）");
  assert.equal(hf2[1]!.length, 0);
});

test("judgeFormulaHole：只两道门（几何已在匹配层过 + 洞大小），宽度比/$成对不参与拒绝", () => {
  assert.equal(judgeFormulaHole(120, 9).ok, true, "期望 13.3 字");
  const j = judgeFormulaHole(12, 9); // expected = 1.33 < 1.6
  assert.equal(j.ok, false);
  assert.match(j.reason!, /洞太小/);
});

test("judgeHole：合格候选接受（含 $ 成对形态）", () => {
  assert.equal(judgeHole(18, 9, "误误", "").ok, true, "expected=2.0 ratio=1.0");
  const j = judgeHole(18, 9, "误 $ 5 $", "");
  assert.equal(j.ok, true, `$ 成对且比例合格：ratio=${j.ratio}`);
});

test("judgeHole：$ 不成对拒（半个公式渲染出来是噪声）", () => {
  const j = judgeHole(18, 9, "误 $ 5", "");
  assert.equal(j.ok, false);
  assert.match(j.reason!, /不成对/);
});

test("judgeHole：宽度比越界拒（[0.45,1.9]）", () => {
  const j = judgeHole(18, 9, "误误误误误误误误误误", ""); // ratio=0.2
  assert.equal(j.ok, false);
  assert.match(j.reason!, /越界/);
});

test("judgeHole：洞期望字数 <1.6 拒（单字符候选无法核对，宁可不补）", () => {
  const j = judgeHole(12, 9, "误", ""); // expected=1.33
  assert.equal(j.ok, false);
  assert.match(j.reason!, /洞太小/);
});

test("judgeHole：与裁图路径明显矛盾拒（两条独立路径打架 ⇒ 宁可不补）；无裁图产物放行", () => {
  assert.equal(judgeHole(18, 9, "误误", "").ok, true, "无裁图结果 ⇒ 交叉核对自动放行");
  const j = judgeHole(18, 9, "误误", "完全不同的内容");
  assert.equal(j.ok, false);
  assert.match(j.reason!, /不一致/);
});

test("judgeHole：空文本拒", () => {
  const j = judgeHole(18, 9, "", "");
  assert.equal(j.ok, false);
  assert.match(j.reason!, /无行压中此洞/);
});
