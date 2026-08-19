// tests/normalize-layout.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";
import { layoutPage } from "../src/layout.js";

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

test("normalizeLayout：image/chart 块挂回为 image ParsedBlock（path/bbox 正确）", () => {
  const doc = normalizeLayout(raw, "layout-test");
  const imgs = doc.pages.flatMap((p) =>
    p.blocks.filter((b): b is Extract<typeof b, { kind: "image" }> => b.kind === "image"),
  );
  // 夹具 3 张图（page0 一张 [225,192,286,269]、page1 两张 [167,94,294,158] / [207,279,295,324]）
  assert.equal(imgs.length, 3, "夹具 image 块应全部产出 image ParsedBlock");
  // path 取自嵌套 blocks[].lines[].spans[].image_path，而非空串/占位
  const first = imgs.find((i) => i.bbox[1] === 192);
  assert.ok(first, "page0 的图应在 y=192");
  assert.match(first!.path, /\.(jpg|jpeg|png)$/, "path 应挂回真实图片路径");
  assert.deepEqual(first!.bbox, [225, 192, 286, 269], "bbox 应取自 span/块 bbox");
  // 图片块按 bbox y 参与版面层阅读顺序：page0 的 y=192 图应出现在阅读顺序中，
  // 且位于 y=193 文本行之前（阅读顺序由 layoutPage 决定，normalizeLayout 保留原块序）
  const ordered = layoutPage(doc.pages[0]!).ordered;
  const imgEntry = ordered.find((e) => e.block.kind === "image" && e.block.bbox[1] === 192);
  assert.ok(imgEntry, "图片块应参与版面层阅读顺序");
  const imgOrder = ordered.findIndex((e) => e.block === imgEntry!.block);
  const nextByY = ordered
    .slice(imgOrder + 1)
    .find((e) => e.block.kind !== "image" && e.block.bbox[1] >= 193);
  assert.ok(nextByY, "阅读顺序中图片后应还有后续文本块");
});