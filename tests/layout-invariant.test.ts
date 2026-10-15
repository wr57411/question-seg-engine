// layout-invariant.test.ts —— 「标签层不得改变纸面版式」的门（需求规格接缝 C）。
//
// 为什么用假 DOM 而不是浏览器截图：项目零运行时依赖、没有 jsdom，而 `npm run check` 必须
// 能在任何机器上跑。浏览器实测已经做过一次（两册最密态下 .blk/.q-chip 几何哈希完全相同），
// 但"人记得去测"不是回归防护。这里把同一条不变量搬到 `node:test` 里：
//   ① 标签层开/关两跑，所有 .blk 与 .q-chip 的定位与字号必须**逐字节相等**；
//   ② 画布宽度钉死为 paneW − GUTTER —— 谁想把留白加宽给标签腾地方，这条立刻红
//      （那正是 6c26e9d「留白收窄 —— 页面不再被挤小」修复的东西）；
//   ③ 标签节点只能追加、不能替换：.blk/.q-chip 的数量与顺序在两跑之间不变。
// ⚠️ 这条门**只**覆盖 DOM 结构层；CSS 层面（比如给 .canvas 加 padding）它看不见，
//    那一层仍由 `npm run view:cap` 的逐页截图审板负责。
import assert from "node:assert/strict";
import { test } from "node:test";

/* ── 最小 DOM 桩：只实现 renderPaper 用到的那几件事 ── */

interface Stub {
  tagName: string;
  children: Stub[];
  style: Record<string, string>;
  className: string;
  textContent: string;
  innerHTML: string;
  title: string;
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

// renderPaper 内部通过 `document.createElement` 建节点；模块加载时不碰 document，故可安全注入
(globalThis as unknown as { document: unknown }).document = {
  createElement: (t: string) => makeNode(t),
  createTextNode: (t: string) => Object.assign(makeNode("#text"), { textContent: t }),
};

const { GUTTER, renderPaper } = await import("../stages/reconstruct.js");

/* ── 夹具：一页两题双栏（够触发号牌分栏与标签列，不依赖 git 忽略的 data/） ── */

const PAGE = {
  index: 0,
  width: 595,
  height: 842,
  columns: 2,
  centers: [160, 440],
  blocks: [
    { i: 0, bbox: [50, 60, 280, 84], text: "1. 第一题题干", kind: "text" },
    { i: 1, bbox: [50, 90, 280, 114], text: "A. 选项甲 B. 选项乙", kind: "text" },
    { i: 2, bbox: [320, 60, 545, 84], text: "2. 右栏题目", kind: "text" },
    { i: 3, bbox: [320, 90, 545, 114], text: "C. 选项丙", kind: "text" },
  ],
  order: [0, 1, 2, 3],
  discarded: [],
  uncovered: [],
  ocrFill: [],
  questions: [
    { id: "d:p0:q0", number: "1", section: "第1节", type: "choice", blocks: [0, 1], startsHere: true, confidence: 1, status: "ok", reasons: [] },
    { id: "d:p0:q1", number: "2", section: "第1节", type: "choice", blocks: [2, 3], startsHere: true, confidence: 1, status: "ok", reasons: [] },
  ],
};

const TAGS = [
  { short: "好", name: "好题", color: "#4d7c2f" },
  { short: "改", name: "待改", color: "#5b3a8c" },
  { short: "校", name: "已校对", color: "#3f3f8c" },
  { short: "留", name: "留着组卷", color: "#8a5a1e" },
  { short: "难", name: "偏题难题", color: "#7a2f86" },
];

/** 只序列化"版式相关"的信息：正文块与号牌的定位 + 字号。标签层不该动到它们。 */
function paperGeometry(node: Stub, out: string[] = []): string[] {
  for (const c of node.children) {
    if (c.classList.contains("blk") || c.classList.contains("q-chip")) {
      const s = c.style;
      const txt = c.children.find((k) => k.classList.contains("txt"));
      out.push(`${c.className}|${s.left},${s.top},${s.width},${s.height}|${txt?.style.fontSize ?? ""}|${txt?.innerHTML ?? c.textContent}`);
    }
    paperGeometry(c, out);
  }
  return out;
}

function render(resolveTags: null | ((q: unknown) => unknown[])) {
  const { wrap, canvas, innerW } = renderPaper(PAGE, { paneW: 760, resolveTags } as never);
  return { geo: paperGeometry(wrap), innerW, canvas, wrap };
}

test("① 标签层开/关：正文块与号牌的几何、字号逐字节相同", () => {
  const off = render(null);
  const on = render(() => TAGS);
  assert.ok(on.geo.length > 0, "夹具没产出版式节点，这条门就是死门");
  assert.deepEqual(on.geo, off.geo);
});

test("② 标签层只追加节点：.blk/.q-chip 数量与顺序不变", () => {
  const off = render(null);
  const on = render(() => TAGS);
  assert.equal(on.geo.length, off.geo.length);
  const stacks = (n: Stub): number =>
    n.children.reduce((acc, c) => acc + (c.classList.contains("qtag-stack") ? 1 : 0) + stacks(c), 0);
  assert.equal(stacks(on.wrap), 2, "两道题各一列");
  assert.equal(stacks(off.wrap), 0);
});

test("③ 留白与画布宽度钉死成字面量（给标签腾地方=把页面挤小，改动必须撞红）", () => {
  const off = render(null);
  const on = render(() => TAGS);
  // ⚠️ 数字**故意不写成 `760 - GUTTER*2`**：那样一改 GUTTER 断言就跟着自适应，
  // 成了一道恒真的死门（反向验证实测过：GUTTER 22→40 时它照样绿）。
  // 留白 22 / 画布 716（双栏两侧）/ 738（单栏一侧）都是**钉死的口径**，
  // 要改就得连这条测试一起改，逼一次显式决策（6c26e9d 的教训）。
  assert.equal(GUTTER, 22);
  assert.equal(off.innerW, 716);
  assert.equal(on.innerW, 716, "标签层不得改变内容区宽度");
  assert.equal(on.canvas.style.width, "716px");
});

test("③b 单栏页只留一侧留白：738（号牌全在左侧，右侧不该被白占）", () => {
  const single = { ...PAGE, columns: 1, questions: [PAGE.questions[0]] };
  const { innerW } = renderPaper(single, { paneW: 760, resolveTags: () => TAGS } as never);
  assert.equal(innerW, 738);
});

test("④ 标签列挂在号牌所在的同一侧（右栏题不能标到左栏去）", () => {
  const { wrap } = render(() => TAGS);
  const stacks = (n: Stub, acc: Stub[] = []): Stub[] => {
    for (const c of n.children) {
      if (c.classList.contains("qtag-stack")) acc.push(c);
      stacks(c, acc);
    }
    return acc;
  };
  const [left, right] = stacks(wrap);
  assert.ok(left && right, "夹具应产出两列");
  assert.ok(left.style.right, "左栏题的标签列挂左侧留白");
  assert.ok(right.style.left, "右栏题的标签列挂右侧留白");
});
