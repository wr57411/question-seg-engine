// normalize-preprocess.test.ts —— 归一化层的两条「上游残渣」清洗规则（`§100`）。
//
// 两条都来自实测，不是假想：
// 1. **带圈题号**：上游把题号 `3` 输出成 `③`（U+2460–2473），判据只认 ASCII 数字
//    ⇒ 5 道题整题不入库（《运动和力》p4、《机械能守恒》p1/p4/p6/p15）；
// 2. **纯符号噪声行**：插图里的「× × ×」网格被当成文字行（《磁场》p2 共 154 行）
//    ⇒ 把 x0 直方图左簇灌爆，整页判单栏、题干被几百个 × 灌满。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";

type Line = { bbox: number[]; spans: { content: string }[] };
const line = (content: string, y = 100): Line => ({ bbox: [20, y, 500, y + 10], spans: [{ content }] });

function doc(texts: string[]): unknown {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 852],
        para_blocks: texts.map((t, i) => ({
          type: "text",
          bbox: [20, 100 + i * 14, 500, 112 + i * 14],
          lines: [line(t, 100 + i * 14)],
        })),
      },
    ],
  };
}

const textsOf = (raw: unknown) =>
  normalizeLayout(raw, "t").pages[0]!.blocks.map((b) => ("text" in b ? b.text : ""));

test("带圈题号 + 出处标注 ⇒ 还原成阿拉伯数字", () => {
  const out = textsOf(doc(["③[多选][人教版必修一P96例题1条件变式]如图甲所示，物体在水平恒力F作用下"]));
  assert.equal(out[0]!.startsWith("3[多选][人教版必修一"), true, out[0] ?? "");
});

test("带圈题号 + 四位年份 ⇒ 还原", () => {
  const out = textsOf(doc(["③ 2024新课标卷鲁科版必修二 P17第1题情境变式]福建舰是我国自主设计建造的首艘"]));
  assert.equal(out[0]!.startsWith("3 2024新课标卷"), true, out[0] ?? "");
});

test("正文里的 ①②③ 列举不算题号 ⇒ 不动", () => {
  const out = textsOf(doc(["①当$P_{出}<P_{max}$时，每个输出功率对应的外电阻阻值有两个取值"]));
  assert.equal(out[0]!.startsWith("①当"), true, out[0] ?? "");
});

test("纯符号噪声行（× 网格）被丢弃，并计入 droppedNoiseLines", () => {
  const d = normalizeLayout(doc(["× × × × × × × × × × × ×", "× × × × × × × ×"]), "t");
  assert.equal(d.pages[0]!.blocks.length, 0);
  assert.equal(d.droppedNoiseLines, 2);
});

test("分隔线（—— / ====）不算噪声，不丢", () => {
  const out = textsOf(doc(["—————————", "=========="]));
  assert.equal(out.length, 2);
});

test("含文字的 × 行不算噪声（如判断对错的选项）", () => {
  const out = textsOf(doc(["A. × × × 都不对"]));
  assert.equal(out.length, 1);
});

test("没有噪声时不产生 droppedNoiseLines 字段（不制造假信号）", () => {
  const d = normalizeLayout(doc(["正常的一行题干文字"]), "t");
  assert.equal(d.droppedNoiseLines, undefined);
});
