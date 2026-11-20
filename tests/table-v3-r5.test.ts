// tests/table-v3-r5.test.ts
//
// M7-C：table-v3-full 的 R5 逐页页号守卫（防 0/1 基错页静默）。
// 原判据「V3 首行 ∈ 骨架前 3 text 块」在 d13 电路 / d14 磁场上对**页眉碎屑**假红
// （V3 rec_texts[0] = 「第九章」「基础双练教材基础练」，OXR 未读 ⇒ 骨架里没有），
// 非空书被整册阻断、三分流空转。修后口径（scripts/r5-align.ts）：
//   ① 严判据保留：V3 首行落在骨架前 3 个 text 块 ⇒ 通过；
//   ② 否则退回**内容重合**：整页骨架文本内命中 ≥5 条 V3 长行（归一后 ≥8 字）⇒ 通过。
// 重合阈值的实测分离（d13/d14 全 23 页，对照正确页 vs 相邻页）：
//   minlen=8 正确页命中 9–35 条，相邻页 0–3 条 ⇒ 阈 5 有两倍裕度。
// 仍失败 ⇒ 响亮中止（不静默错页）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkR5Alignment } from "../scripts/r5-align.js";

/** 骨架页文本块（含表格压平文本；顺序无关，函数只看拼接） */
const skel = (arr: string[]) => arr;

test("R5 严判据：V3 首行落在骨架前 3 text 块 ⇒ strict 通过", () => {
  const r = checkR5Alignment({
    v3Lines: ["第1讲 电路的基本概念和规律", "教材知识 54 电流"],
    skeletonTexts: skel(["第1讲 电路的基本概念和规律", "《高考基础练》对应练见 P062", "教材知识 54"]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.mode, "strict");
});

test("R5 页眉碎屑假红修复：首行是 OXR 没读的装饰头 ⇒ 退回内容重合并通过（d13 p01 形态）", () => {
  // V3 首两行 = 页眉「第九章 / 恒定电流」，骨架无；随后正文行大量命中
  const r = checkR5Alignment({
    v3Lines: [
      "第九章", "恒定电流", "第1讲", "电路的基本概念和规律",
      "电流 电阻定律 欧姆定律 电路的串并联", "教材知识萃取 回归教材，萃精华",
      "教材素材变式 多维变式，夯基础", "闭合电路欧姆定律的表达式与适用条件",
      "电功率的计算公式及其物理意义", "电阻的测量方法与误差分析",
    ],
    skeletonTexts: skel([
      "第1讲 电路的基本概念和规律",
      "《高考基础练》对应练见 P062",
      "教材知识 54 电流 电阻定律 欧姆定律 电路的串并联",
      "教材知识萃取 回归教材，萃精华",
      "教材素材变式 多维变式，夯基础",
      "闭合电路欧姆定律的表达式与适用条件",
      "电功率的计算公式及其物理意义",
      "电阻的测量方法与误差分析",
    ]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.mode, "overlap");
  if (r.ok && r.mode === "overlap") assert.ok(r.matched >= 5, `重合数应≥5，实际 ${r.matched}`);
});

test("R5 错位页：正文与目标页几乎不重合 ⇒ 响亮失败（不静默）", () => {
  const r = checkR5Alignment({
    v3Lines: [
      "第十章", "磁场", "第1讲 磁场的描述", "完全属于另一页的长句子一", "完全属于另一页的长句子二",
      "完全属于另一页的长句子三", "完全属于另一页的长句子四", "完全属于另一页的长句子五",
    ],
    skeletonTexts: skel(["第1讲 电路的基本概念和规律", "教材知识 54 电流", "另一页的正文长句子甲"]),
  });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /中止/);
});

test("R5 空 V3 输出 ⇒ 失败（不把空页当通过）", () => {
  const r = checkR5Alignment({ v3Lines: [], skeletonTexts: skel(["正文"]) });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /中止/);
});

test("R5 重合数差一条不到阈值 ⇒ 仍失败（阈值不放宽）", () => {
  const long = (i: number) => `重合长行编号${i}用于测试阈值边界`;
  const r = checkR5Alignment({
    v3Lines: ["页眉碎屑", long(1), long(2), long(3), long(4)],
    skeletonTexts: skel([long(1), long(2), long(3), long(4)]),
  });
  assert.equal(r.ok, false, "4 条 < 阈 5 必须拦下");
});
