// tests/table-render.test.ts
//
// 表格渲染的**结构断言**（`stages/reconstruct.js` 的 tableNode + 覆盖隐藏，`DECISIONS §76`）。
//
// ⚠️ 这条门只覆盖 **DOM 结构层**：能证明「产出了 <table>、行/列/合并对不对、
// 被表格覆盖的行块有没有被跳过」。CSS 层面（框线粗细、溢出、字号观感）它看不见
// —— 那一层仍由人工截图审板负责（与 tests/layout-invariant.test.ts 同一条边界）。
//
// 为什么用假 DOM：项目零运行时依赖、无 jsdom，`npm run check` 必须能在任何机器上跑。

import assert from "node:assert/strict";
import { test } from "node:test";

interface Stub {
  tagName: string;
  children: Stub[];
  style: Record<string, string>;
  className: string;
  textContent: string;
  innerHTML: string;
  title: string;
  rowSpan?: number;
  colSpan?: number;
  dataset: Record<string, string>;
  classList: { add: (c: string) => void; contains: (c: string) => boolean };
  append: (...n: Stub[]) => void;
  addEventListener: () => void;
}

function makeNode(tagName: string): Stub {
  const n: Stub = {
    tagName,
    children: [],
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    dataset: {},
    classList: {
      add: (c: string) => {
        if (!n.className.split(" ").includes(c)) n.className = `${n.className} ${c}`.trim();
      },
      contains: (c: string) => n.className.split(" ").includes(c),
    },
    append: (...kids: Stub[]) => {
      n.children.push(...kids);
    },
    addEventListener: () => {},
  };
  return n;
}

/** 递归收集指定 tagName 的后代 */
function findAll(node: Stub, tagName: string, out: Stub[] = []): Stub[] {
  for (const c of node.children) {
    if (c.tagName === tagName) out.push(c);
    findAll(c, tagName, out);
  }
  return out;
}

const g = globalThis as unknown as { document?: unknown };
g.document = { createElement: (t: string) => makeNode(t) };

const { appendBlockNodes, tableNode } = await import("../stages/reconstruct.js");

/** 一页两栏的假页面（够 tableNode/posStyle 用） */
const page = {
  index: 0,
  width: 1000,
  height: 1400,
  columns: 1,
  blocks: [] as Record<string, unknown>[],
};

const tableBlock = (i: number, html: string, bbox: number[]) => ({
  i,
  kind: "table",
  bbox,
  text: "甲\t乙",
  html,
});

test("tableNode：产出 <table>，行/单元格数量与 rowspan/colspan 正确", () => {
  const b = tableBlock(
    0,
    '<table><tr><td rowspan=2 colspan=1>甲</td><td colspan=2>乙丙</td></tr><tr><td>丁</td><td>戊</td></tr></table>',
    [0, 0, 400, 200],
  );
  const p = { ...page, blocks: [b] };
  const node = tableNode(b, p, 760, 12) as Stub;
  assert.ok(node, "应返回节点");
  const tables = findAll(node, "table");
  assert.equal(tables.length, 1, "应有一个 <table>");
  const trs = findAll(node, "tr");
  assert.equal(trs.length, 2, "两行");
  const tds = findAll(node, "td");
  assert.equal(tds.length, 4, "四个单元格");
  assert.equal(tds[0]!.rowSpan, 2, "第一个单元格 rowspan=2");
  assert.equal(tds[1]!.colSpan, 2, "第二个单元格 colspan=2");
});

test("tableNode：解析不出行时返回 null（调用方退回文本渲染，不丢内容）", () => {
  const b = tableBlock(0, "<p>不是表格</p>", [0, 0, 100, 50]);
  const p = { ...page, blocks: [b] };
  assert.equal(tableNode(b, p, 760, 12), null);
});

test("appendBlockNodes：表格块画网格，被它覆盖的行块被跳过（不叠压平文字）", () => {
  const table = tableBlock(0, "<table><tr><td>格1</td><td>格2</td></tr></table>", [0, 100, 400, 300]);
  const inside = { i: 1, kind: "text", bbox: [10, 120, 390, 140], text: "压平的第一行" };
  const outside = { i: 2, kind: "text", bbox: [10, 400, 390, 420], text: "表格外的正文" };
  const p = { ...page, blocks: [table, inside, outside] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 760, 12, null, "d", true) as (Stub | null)[];
  assert.equal(nodes[1], null, "被表格覆盖的行块必须不渲染");
  assert.ok(nodes[2], "表格外的正文照常渲染");
  assert.equal(findAll(c, "table").length, 1, "画布里有且仅有一个表格");
});

test("appendBlockNodes：表格外的正文块不受影响（几何包含判据不误伤）", () => {
  // 只部分重叠（右边界越出）的块**不应**被隐藏 —— 判据要求完整包含
  const table = tableBlock(0, "<table><tr><td>格</td></tr></table>", [0, 100, 400, 300]);
  const partial = { i: 1, kind: "text", bbox: [10, 120, 500, 140], text: "越出右边界的行" };
  const p = { ...page, blocks: [table, partial] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 760, 12, null, "d", true) as (Stub | null)[];
  assert.ok(nodes[1], "只部分重叠的块必须保留（否则会丢内容）");
});
