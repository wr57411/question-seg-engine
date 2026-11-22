// tests/cover-nav-guard.test.ts —— B-62 前置页假题抑制（两级守卫）
// ① 语言层：「1 刷基础」封面导航行（BARE_BADGE 弱信号误切）
// ② 页级：页含 CONTENTS/目录锚 ⇒ 目录页整页不开题（rule-engine 预扫描）
// 实测：2026 新高考版 p0 封面 + p1-p4 目录切出 13 道假题（用户报障），全库 CONTENTS 锚仅书A ⇒ 零误伤
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";
import { segmentFromContentList } from "../src/index.js";

test("封面导航行「1 刷基础」不是题号", () => {
  const r = matchFirstLine("1 刷基础");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "other");
});

test("多段连排「5 刷实验 6 刷情境…」整行拒绝", () => {
  assert.equal(matchFirstLine("5 刷实验 6 刷情境 7 刷真题 8 刷综合").ok, false);
});

test("守卫不误伤：徽标题号真题不受影响", () => {
  const r = matchFirstLine("2 [鲁科版选修一 P24]", 1);
  assert.equal(r.ok, true);
  assert.equal(r.captured, "2");
});

test("页级抑制：目录页整页不开题，正文页正常", () => {
  const page = (idx: number, blocks: unknown[]) => ({ page_idx: idx, page_size: [1654, 2339], blocks });
  const blk = (content: string, y: number) => ({
    type: "text",
    bbox: [60, y, 1200, y + 40],
    lines: [{ spans: [{ type: "text", content }] }],
  });
  const fixture = {
    docId: "toc-page-guard",
    pdf_info: [
      page(0, [blk("CONTENTS 目录", 90), blk("第1节 运动的描述 …… (1)(259)", 200), blk("第2节 匀变速…(3)(260)", 240)]),
      page(1, [blk("1．设集合 A = {x}，则 A 的元素个数为（　　）", 90)]),
    ],
  };
  const r = segmentFromContentList(fixture, "toc-page-guard");
  assert.equal(r.questions.length, 1, "目录页抑制后只切 1 题");
  assert.equal(r.questions[0]?.number, "1");
});
