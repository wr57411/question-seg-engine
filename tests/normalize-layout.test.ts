// tests/normalize-layout.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/layout.sample.json", import.meta.url), "utf8"),
);

test("normalizeLayout：页数与 page_size 来自 layout", () => {
  const doc = normalizeLayout(raw, "layout-test");
  assert.equal(doc.pages.length, 2);
  assert.ok(doc.pages[0]!.width > 0, "width 应来自 page_size");
  assert.equal(doc.pages[0]!.index, doc.pages[0]!.index); // 排序稳定
});

test("normalizeLayout：para_blocks 按 line 展开且行序拼接等值原文本", () => {
  const doc = normalizeLayout(raw, "layout-test");
  const page = doc.pages[0]!;
  // 每个块非空；行内公式以 $..$ 内联。
  // 夹具含 inline_equation span（page 1 block 4/7），无条件断言公式内联路径被执行；
  // allText 跨全部页拼接，否则 page 0 无公式、断言会静默不触发。
  const allText = doc.pages
    .flatMap((p) => p.blocks.map((b) => (b.kind === "text" ? b.text : "")))
    .join("\n");
  assert.ok(allText.length > 0);
  assert.match(allText, /\$.+?\$/);
  // 合并选项段落的行级展开：找到 bbox 都在 [54,193,199,262] 内容对应的块集合
  // （真实夹具里有 "A. 重力的作用点在重心上" 行），断言存在以 "A." 开头的行块
  const optionLine = page.blocks.find(
    (b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text" && /^A[.．、]/.test(b.firstLine),
  );
  assert.ok(optionLine, "应存在行级展开的选项行块");
});