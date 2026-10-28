// fuse.test.ts —— 两源融合原型：MinerU 几何 + OXR 文本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fuseDocuments } from "../src/fuse.js";
import type { ParsedDocument } from "../src/types.js";

const page = (blocks: ParsedDocument["pages"][number]["blocks"]): ParsedDocument => ({
  docId: "t",
  pages: [{ index: 0, width: 100, height: 100, blocks }],
});

test("fuseDocuments：文字用 OXR、位置用 MinerU，OXR-only 行补入并标记", () => {
  const mineru = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "1. 题干", firstLine: "1. 题干", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [10, 30, 40, 40], text: "A. 甲", firstLine: "A. 甲", lineCount: 1, maxFontSize: 0 },
    { kind: "image", bbox: [10, 50, 50, 90], path: "img.png" },
    { kind: "formula", bbox: [60, 50, 90, 60], latex: "x^2" },
  ]);
  const oxr = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "1. 题干 OXR", firstLine: "1. 题干 OXR", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [10, 30, 40, 40], text: "A. 甲", firstLine: "A. 甲", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [50, 30, 90, 40], text: "B. 乙", firstLine: "B. 乙", lineCount: 1, maxFontSize: 0 },
    { kind: "image", bbox: [10, 50, 50, 90], path: "img.png" },
    { kind: "formula", bbox: [60, 50, 90, 60], latex: "x^2" },
  ]);
  const { doc, stats } = fuseDocuments(mineru, oxr);
  assert.equal(stats.matched, 4);
  assert.equal(stats.oxrOnly, 1);
  assert.equal(stats.mineruOnly, 0);
  assert.equal(stats.textChanged, 1);
  const blocks = doc.pages[0]!.blocks;
  const stem = blocks.find((b) => b.kind === "text" && b.text.includes("题干"));
  assert.ok(stem && stem.kind === "text" && stem.text === "1. 题干 OXR" && stem.fromFusion === true);
  assert.ok(blocks.some((b) => b.kind === "text" && b.text === "B. 乙" && b.fromFusion === true));
  // 位置仍是 MinerU 的
  assert.deepEqual(stem?.bbox, [10, 10, 90, 20]);
});

test("fuseDocuments：两源换行点不同不产生重复行", () => {
  const mineru = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "1. ABCDEFGHIJKLMNOPQRSTUVWX", firstLine: "1. ABCDEFGHIJKLMNOPQRSTUVWX", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [10, 22, 90, 32], text: "YZabcdefghijklmnopqrstuvwxyz", firstLine: "YZabcdefghijklmnopqrstuvwxyz", lineCount: 1, maxFontSize: 0 },
  ]);
  const oxr = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "1. ABCDEFGHIJKLMNOPQRSTUVWXYZabcd", firstLine: "1. ABCDEFGHIJKLMNOPQRSTUVWXYZabcd", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [10, 22, 90, 32], text: "efghijklmnopqrstuvwxyz", firstLine: "efghijklmnopqrstuvwxyz", lineCount: 1, maxFontSize: 0 },
  ]);
  const { doc, stats } = fuseDocuments(mineru, oxr);
  assert.equal(stats.matched, 2);
  assert.equal(stats.oxrOnly, 0);
  assert.equal(stats.mineruOnly, 0);
  const joined = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
  assert.equal(joined.replace(/\s/g, ""), "1.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
});

test("fuseDocuments：OXR 缺整行时保留 MinerU 文本，不把邻近文字错贴过去", () => {
  const mineru = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "第1节 标题", firstLine: "第1节 标题", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [10, 30, 90, 40], text: "1. 题目正文", firstLine: "1. 题目正文", lineCount: 1, maxFontSize: 0 },
  ]);
  const oxr = page([
    { kind: "text", bbox: [10, 30, 90, 40], text: "1. 题目正文 OXR", firstLine: "1. 题目正文 OXR", lineCount: 1, maxFontSize: 0 },
  ]);
  const { doc, stats } = fuseDocuments(mineru, oxr);
  assert.equal(stats.mineruOnly, 1);
  assert.equal(stats.matched, 1);
  const title = doc.pages[0]!.blocks.find((b) => b.kind === "text" && b.text.includes("标题"));
  assert.ok(title && title.kind === "text" && title.text === "第1节 标题" && !title.fromFusion);
  const q = doc.pages[0]!.blocks.find((b) => b.kind === "text" && b.text.includes("题目"));
  assert.ok(q && q.kind === "text" && q.text === "1. 题目正文 OXR" && q.fromFusion === true);
});

test("fuseDocuments：同一 bbox 的重复 OXR 块合并，保留更完整文本", () => {
  const mineru = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "2. 题干", firstLine: "2. 题干", lineCount: 1, maxFontSize: 0 },
  ]);
  const oxr = page([
    { kind: "text", bbox: [10, 10, 90, 20], text: "2. 题干", firstLine: "2. 题干", lineCount: 1, maxFontSize: 0 },
    { kind: "text", bbox: [10, 10, 90, 20], text: "2. 题干 完整版", firstLine: "2. 题干 完整版", lineCount: 1, maxFontSize: 0 },
  ]);
  const { doc, stats } = fuseDocuments(mineru, oxr);
  assert.equal(stats.deduped, 1);
  assert.equal(doc.pages[0]!.blocks.length, 1);
  const b = doc.pages[0]!.blocks[0]!;
  assert.ok(b.kind === "text" && b.text.includes("完整版"));
});
