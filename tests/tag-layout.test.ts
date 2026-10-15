// tag-layout.test.ts —— 标签短码列「三级降级」的回归锁定。
//
// 为什么需要它：号牌当年的事故是「页内找空白、放不下就不挂」⇒ 密页几乎一个都不显示，
// 用户看到的是「题号没识别出来」（见 reconstruct.js 留白注释）。标签若照抄就重演。
// 这里锁的是相反的性质：**打过标的题一定在页面上留痕**，只是详略不同（full/count/chip）。
// 用例锚定：
//   ① 3 个不折叠、4 个显示 3 + `+1`（折叠只影响显示，不影响数据）；
//   ② 同侧密集题 → 先折 count、再降 chip，且 chip 级仍带总数角标（绝不静默）；
//   ③ 左右两栏各自独立（一栏挤不影响另一栏）；
//   ④ 页底越界同样降级，不允许伸出画布（画布 overflow:hidden 会裁掉 = 看不见）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHIP_H,
  MAX_VISIBLE,
  stackContents,
  stackHeight,
  tagStackPlacements,
  TAG_LINE_H,
  TAG_PITCH,
} from "../stages/tag-layout.js";

const item = (key: string, topPx: number, tagCount: number, side: "left" | "right" = "left") => ({
  key,
  side,
  topPx,
  tagCount,
});

test("① 显示上限：≤3 全显示，4 个显示 3 个 + `+1`", () => {
  assert.equal(MAX_VISIBLE, 3);
  assert.deepEqual(stackContents(3, "full"), { visible: 3, more: 0, countBadge: 0 });
  assert.deepEqual(stackContents(4, "full"), { visible: 3, more: 1, countBadge: 0 });
  assert.deepEqual(stackContents(7, "full"), { visible: 3, more: 4, countBadge: 0 });
  // 高度：3 行 + 1 行折叠块；每行占位 = 行高 + 间距（漏掉间距会撞车，见 tag-layout.js 注释）
  assert.equal(stackHeight(7, "full"), 4 * TAG_PITCH);
  assert.equal(TAG_PITCH, TAG_LINE_H + 1);
});

test("② 密页降级：挤不下的先折计数块，再降到号牌角标，且总数不丢", () => {
  // 间距 20px < 一列 full 需要的 4 行 ⇒ 第二题起必然撞车
  const placed = tagStackPlacements([item("a", 0, 5), item("b", 20, 5), item("c", 40, 5)], 900);
  assert.equal(placed.get("a")!.level, "full");
  const levels = ["b", "c"].map((k) => placed.get(k)!.level);
  assert.ok(levels.every((l) => l === "count" || l === "chip"), `降级后只能是 count/chip，实得 ${levels}`);
  for (const k of ["b", "c"]) {
    const p = placed.get(k)!;
    const c = stackContents(p.tagCount, p.level);
    // 关键不变式：无论降到哪一级，页面上都有一个**带总数**的痕迹
    assert.ok(c.countBadge > 0 || c.visible > 0, `${k} 级降级不得静默丢痕`);
  }
  assert.equal(stackContents(5, "chip").countBadge, 5);
});

test("③ 左右两栏各自独立排布，互不挤占", () => {
  const placed = tagStackPlacements(
    [item("L", 0, 5, "left"), item("R", 2, 5, "right")],
    900,
  );
  assert.equal(placed.get("L")!.level, "full");
  assert.equal(placed.get("R")!.level, "full", "右栏从 2px 开始，不该被左栏的列挤掉");
});

test("④ 页底越界必须降级，不能伸到画布外被 overflow:hidden 裁掉", () => {
  const canvasH = 300;
  // 首题就贴到页底：一列 full 需要 4 行 = 48px，放不下
  const placed = tagStackPlacements([item("tail", canvasH - CHIP_H - 2, 5)], canvasH);
  const p = placed.get("tail")!;
  assert.notEqual(p.level, "full");
  assert.ok(p.topPx + stackHeight(p.tagCount, p.level) <= canvasH, "降级后必须仍在页内");
});

test("⑤ 稀疏页（真实两册的密度）不触发任何降级", () => {
  // 题册 15 页 83 题、答案册 23 页 166 题：同侧题间距远大于 4 行
  const tops = [40, 210, 380, 560, 740];
  const placed = tagStackPlacements(tops.map((t, i) => item(`q${i}`, t, 5)), 900);
  assert.deepEqual([...placed.values()].map((v) => v.level), tops.map(() => "full"));
});
