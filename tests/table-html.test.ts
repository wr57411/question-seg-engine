// tests/table-html.test.ts
//
// 上游表格 HTML → 行/单元格（`stages/table-html.js`，`DECISIONS §76`）。
//
// 背景：上游把表格网格放在 `spans[].html`（带 rowspan/colspan），`content` 只有压平后的
// 文字 ⇒ 成品页上「表格」看着就是几行字。展示层改为解析上游本来就给出的结构画真网格
// —— 这是「按原坐标重建」的同一条原则，**不是**从空白猜列宽。

import assert from "node:assert/strict";
import { test } from "node:test";
import { cellText, parseTableHtml } from "../stages/table-html.js";

test("parseTableHtml：基本两行三列", () => {
  const t = parseTableHtml(
    "<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></table>",
  );
  assert.equal(t.rows.length, 2);
  assert.equal(t.cols, 3);
  assert.deepEqual(
    t.rows.map((r) => r.cells.map((c) => c.text)),
    [
      ["a", "b", "c"],
      ["d", "e", "f"],
    ],
  );
});

test("parseTableHtml：rowspan / colspan 原样保留，列数按 colspan 展开", () => {
  const t = parseTableHtml(
    '<table><tr><td rowspan=2 colspan=1>甲</td><td rowspan=1 colspan=2>乙丙</td></tr><tr><td>丁</td><td>戊</td></tr></table>',
  );
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0]!.cells[0]!.rowspan, 2);
  assert.equal(t.rows[0]!.cells[1]!.colspan, 2);
  assert.equal(t.cols, 3);
});

test("cellText：`<eq>…</eq>` 转成 `$…$`（上游行内公式标记）", () => {
  assert.equal(cellText("电流<eq>I=\\frac{U}{R}</eq>定义式"), "电流$I=\\frac{U}{R}$定义式");
});

test("cellText：其余标签剥掉、实体解码、空白压缩", () => {
  assert.equal(cellText("<span>a</span>&nbsp;&nbsp;b &amp; c"), "a b & c");
  assert.equal(cellText("x<br>y"), "x\ny");
});

test("parseTableHtml：空/无表格输入返回空 rows（调用方据此退回文本渲染，不丢内容）", () => {
  assert.deepEqual(parseTableHtml("").rows, []);
  assert.deepEqual(parseTableHtml("<p>不是表格</p>").rows, []);
  assert.equal(parseTableHtml("").cols, 0);
});

test("parseTableHtml：th 与 td 同等对待（表头也是单元格）", () => {
  const t = parseTableHtml("<table><tr><th>表头</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>");
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0]!.cells[0]!.text, "表头");
});

test("parseTableHtml：单元格内的 `<img src>` 单独保留（cellText 会剥标签，图片不能跟着丢）", () => {
  // 2026-10-29 对照原卷发现：电路 p5 表格左下格的 P–R 曲线图被 cellText 当标签剥掉
  const t = parseTableHtml(
    '<table><tr><td>说明<img src="abc123.jpg"/></td><td>无图</td></tr></table>',
  );
  assert.equal(t.rows[0]!.cells[0]!.images.length, 1);
  assert.equal(t.rows[0]!.cells[0]!.images[0], "abc123.jpg");
  assert.equal(t.rows[0]!.cells[0]!.text, "说明", "文本里不留 img 标签");
  assert.deepEqual(t.rows[0]!.cells[1]!.images, []);
});
