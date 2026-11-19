// tests/crop-placement.test.ts
//
// S2 放置（spec docs/plans/2026-11-13-表格与巨带放置实现.md §2/§3/§5）的 DOM 结构门：
//   ① 三分流消费分支：image 表整表截图内联 / text 表走 tableNode / borderless 双保险跳过；
//   ② 行级 coordSource=crop 裁图例外放置（文本留 title，不丢内容）；
//   ③ 放置器只缩不放（宽=min(nativeW, innerW)，height:auto）；
//   ④ coveredByTable 只对「实际会渲染的表」成立（borderless 不抑制内部行）；
//   ⑤ 宽裁图 data-zoom + 点按浮层**挂 canvas 外**（R8：canvas overflow:hidden 会裁掉浮层）；
//   ⑥ 旧快照（无新字段）渲染逐字节不变（字面量钉死，改动前实测捕获）。
// ⚠️ 只覆盖 DOM 结构层；CSS 观感/真机可读性仍由逐页截图审板负责（与 table-render 同边界）。
// 假 DOM：项目零运行时依赖、无 jsdom，`npm run check` 必须能在任何机器上跑。

import assert from "node:assert/strict";
import { test } from "node:test";

interface Stub {
  tagName: string;
  children: Stub[];
  parent: Stub | null;
  style: Record<string, string> & { cssText?: string };
  className: string;
  textContent: string;
  innerHTML: string;
  title: string;
  src?: string;
  alt?: string;
  dataset: Record<string, string>;
  listeners: Record<string, ((e: unknown) => void)[]>;
  classList: { add: (c: string) => void; contains: (c: string) => boolean };
  append: (...n: Stub[]) => void;
  remove: () => void;
  addEventListener: (t: string, fn: (e: unknown) => void) => void;
  querySelector: (sel: string) => Stub | null;
  querySelectorAll: (sel: string) => Stub[];
}

/** 选择器只支持本渲染器用到的两种：`.class` 与 `[data-attr]`（dataset 驼峰键）。 */
function matches(n: Stub, sel: string): boolean {
  if (sel.startsWith(".")) return n.classList.contains(sel.slice(1));
  const m = /^\[data-([a-z-]+)\]$/.exec(sel);
  if (m) {
    const key = m[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return n.dataset[key] !== undefined;
  }
  return n.tagName === sel;
}

function makeNode(tagName: string): Stub {
  const n: Stub = {
    tagName,
    children: [],
    parent: null,
    style: {},
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    dataset: {},
    listeners: {},
    classList: {
      add: (c: string) => {
        if (!n.className.split(" ").includes(c)) n.className = `${n.className} ${c}`.trim();
      },
      contains: (c: string) => n.className.split(" ").includes(c),
    },
    append: (...kids: Stub[]) => {
      for (const k of kids) {
        k.parent = n;
        n.children.push(k);
      }
    },
    remove: () => {
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = null;
    },
    addEventListener: (t, fn) => {
      (n.listeners[t] ??= []).push(fn);
    },
    querySelector: (sel: string) => n.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel: string) => {
      const out: Stub[] = [];
      const walk = (x: Stub) => {
        for (const c of x.children) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(n);
      return out;
    },
  };
  return n;
}

function findAll(node: Stub, tagName: string, out: Stub[] = []): Stub[] {
  for (const c of node.children) {
    if (c.tagName === tagName) out.push(c);
    findAll(c, tagName, out);
  }
  return out;
}

const fire = (n: Stub, type: string, e: unknown = {}) => {
  for (const fn of n.listeners[type] ?? []) fn(e);
};

const body = makeNode("body");
const docListeners: Record<string, ((e: unknown) => void)[]> = {};
const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  createElement: (t: string) => makeNode(t),
  createTextNode: (t: string) => Object.assign(makeNode("#text"), { textContent: t }),
  body,
  addEventListener: (t: string, fn: (e: unknown) => void) => {
    (docListeners[t] ??= []).push(fn);
  },
  removeEventListener: (t: string, fn: (e: unknown) => void) => {
    docListeners[t] = (docListeners[t] ?? []).filter((f) => f !== fn);
  },
};
// rAF 同步执行：挂载后接线（fitTables / 浮层）在测试里立即可见
g.requestAnimationFrame = (fn: () => void) => {
  fn();
  return 0;
};

const { appendBlockNodes, renderPaper } = await import("../stages/reconstruct.js");

const page = {
  index: 0,
  width: 1000,
  height: 1400,
  columns: 1,
  questions: [] as { id: string; number: string; blocks: number[] }[],
  blocks: [] as Record<string, unknown>[],
};

/* ── ① image 表：整表截图内联（不画网格），内部行被几何抑制（不叠影） ── */

test("image 表：cropFigureNode 内联整表裁图，src 指向 doc 相对子路径，内部行不重复画", () => {
  const table = {
    i: 0, kind: "table", bbox: [10, 100, 410, 300], text: "整表压平文字",
    html: "<table><tr><td>旧网格</td></tr></table>",
    tableClass: "image", tableSource: "v3",
    crop: "table-crops/p03-t0.png", cropSize: [894, 365],
  };
  const inside = { i: 1, kind: "text", bbox: [20, 120, 390, 140], text: "表内第一行" };
  const p = { ...page, blocks: [table, inside] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "doc", true) as (Stub | null)[];
  assert.ok(nodes[0], "image 表必须渲染（截图无损侧）");
  assert.equal(findAll(c, "table").length, 0, "image 表不画 HTML 网格");
  const imgs = findAll(nodes[0]!, "img");
  assert.equal(imgs.length, 1, "整表裁图必须画出来（图一个不丢）");
  assert.equal(imgs[0]!.src, "/data/out/doc/table-crops/p03-t0.png");
  assert.equal(nodes[1], null, "image 表实际渲染 ⇒ 内部行被 coveredByTable 抑制（不叠影）");
  assert.equal(nodes[0]!.dataset.tableClass, "image");
  assert.ok(nodes[0]!.title.includes("整表压平文字"), "原文本必须留在 title（不丢内容）");
  assert.ok(nodes[0]!.title.includes("table-crops/p03-t0.png"), "证据路径必须留在 title");
});

/* ── ② 放置器只缩不放 ── */

test("放置器：宽=min(nativeW, bbox 框宽, 栏宽)，height:auto；窄裁图按原生宽，不放大到框宽", () => {
  // 宽裁图 894px > bbox 框宽（890/1000×350=311.5px）⇒ 缩到框宽（坐标纸面不得越框压邻块）
  const wide = {
    i: 0, kind: "table", bbox: [10, 100, 900, 500], tableClass: "image",
    crop: "table-crops/w.png", cropSize: [894, 365], text: "宽表",
  };
  // 窄裁图 54px（巨带行中位）< 框宽 105px ⇒ 原生 54px，绝不放大到 bbox 的框宽
  const narrow = {
    i: 1, kind: "text", bbox: [100, 600, 400, 620], coordSource: "crop",
    crop: "giant-crop/crops/n.png", cropSize: [54, 20], text: "巨带回退行",
  };
  const p = { ...page, blocks: [wide, narrow] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "doc", true) as (Stub | null)[];
  assert.equal(nodes[0]!.style.width, "311.5px", "超框宽只缩到框宽（越框=压邻块/被 overflow:hidden 裁）");
  assert.equal(nodes[0]!.style.height, "auto", "高按同比例（height:auto）");
  assert.equal(nodes[1]!.style.width, "54px", "原生适配的裁图按原生像素宽，不放大（海报化教训）");
  assert.equal(nodes[1]!.style.height, "auto");
  // 位置仍是 bbox 原位（posStyle 口径）
  assert.equal(nodes[1]!.style.left, "10%");
  assert.equal(nodes[1]!.style.top, `${(600 / 1400) * 100}%`);
});

test("放置器：裁图不得越出 bbox 框宽（成品页实测压邻块事故的反例锁）", () => {
  // 整表：bbox 框宽 101.5px（canvas 350），原生 894px ⇒ 必须缩到 101.5px，
  // 否则按原生/栏宽放置会盖住下一块标题并被 canvas overflow:hidden 裁右缘（2026-11-19 实测）
  const table = {
    i: 0, kind: "table", bbox: [10, 100, 300, 300], tableClass: "image",
    crop: "table-crops/t.png", cropSize: [894, 365], text: "整表",
  };
  // 行级：原生 290px（页图 1000px 域）≫ bbox 框宽 101.5px ⇒ 同样缩到框宽（纸面坐标保真）
  const line = {
    i: 1, kind: "text", bbox: [100, 400, 390, 420], coordSource: "crop",
    crop: "giant-crop/crops/l.png", cropSize: [290, 22], text: "回退行",
  };
  const p = { ...page, blocks: [table, line] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "doc", true) as (Stub | null)[];
  assert.equal(nodes[0]!.style.width, "101.5px", "整表裁图宽不得超过 bbox 框宽");
  assert.equal(nodes[1]!.style.width, "101.5px", "行裁图宽不得超过 bbox 框宽");
});

/* ── ③ 行级 coordSource=crop：截图例外放置，文本留 title/快照 ── */

test("行级 crop 回退：img 原位内联，title 留原文本+放置说明+证据，dataset.coordSource=crop", () => {
  const line = {
    i: 0, kind: "text", bbox: [100, 100, 154, 120], text: "1.A【解析】本题考查波的传播",
    coordSource: "crop", crop: "giant-crop/crops/p076_g0-077.png", cropSize: [290, 22],
  };
  const p = { ...page, blocks: [line] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "doc", true) as (Stub | null)[];
  const imgs = findAll(nodes[0]!, "img");
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0]!.src, "/data/out/doc/giant-crop/crops/p076_g0-077.png");
  assert.equal(nodes[0]!.dataset.coordSource, "crop");
  assert.ok(nodes[0]!.title.includes("1.A【解析】本题考查波的传播"), "引擎原文留 title（search/面板不丢）");
  assert.ok(nodes[0]!.title.includes("coordSource=crop"), "放置说明留 title");
  assert.ok(nodes[0]!.title.includes("giant-crop/crops/p076_g0-077.png"), "证据路径留 title");
  assert.ok(!nodes[0]!.classList.contains("blk-ocr"), "回退行是引擎原文+回退坐标，不是 OCR 候选，不套青绿候选框");
});

/* ── ④ borderless 双保险：跳过 tableNode 且不进 coveredByTable（行文本照常） ── */

test("borderless 表：不画网格、不抑制内部行（行文本照常渲染，不丢内容）", () => {
  const table = {
    i: 0, kind: "table", bbox: [0, 100, 400, 300], text: "P118 1. B 2.C",
    html: "<table><tr><td>P118 1. B</td><td>2.C</td></tr><tr><td>P184 1. BD</td><td>2. ACD</td></tr><tr><td>8. ABD</td><td>9. C</td></tr></table>",
    tableClass: "borderless",
  };
  const inside = { i: 1, kind: "text", bbox: [10, 120, 390, 140], text: "答案索引行" };
  const p = { ...page, blocks: [table, inside] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 760, 12, null, "d", true) as (Stub | null)[];
  assert.equal(findAll(c, "table").length, 0, "borderless 即使带 html 也不画网格（G1 双保险）");
  assert.ok(nodes[1], "borderless 不进 coveredByTable：内部行必须照常渲染");
  assert.ok(nodes[0], "borderless 块自身退回文本渲染（不静默丢弃）");
  // 快照 text 被上游 240 字夹过（整页索引实测）⇒ 可见文本必须用 html 全文扁平化，
  // 不能只把全文藏 title（成品页看得见才算不丢内容）
  const txt = nodes[0]!.querySelector(".txt");
  assert.ok(txt && txt.textContent.includes("8. ABD"), "borderless 可见文本含 html 尾部内容（超出夹断 text）");
  assert.equal(nodes[0]!.style.height, "auto", "全文渲染高度自适应，不被 bbox 高夹裁");
});

test("text 表（tableSource=v3）：走现状 tableNode 网格，内部行仍被抑制", () => {
  const table = {
    i: 0, kind: "table", bbox: [0, 100, 400, 300], text: "甲\t乙",
    html: "<table><tr><td>格1</td><td>格2</td></tr></table>", tableClass: "text", tableSource: "v3",
  };
  const inside = { i: 1, kind: "text", bbox: [10, 120, 390, 140], text: "压平行" };
  const p = { ...page, blocks: [table, inside] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 760, 12, null, "d", true) as (Stub | null)[];
  assert.equal(findAll(c, "table").length, 1, "text 表画 V3 HTML 网格");
  assert.equal(nodes[1], null, "text 表内部行被抑制");
});

/* ── ⑤ 宽裁图可读性补丁：data-zoom 阈值 + 浮层挂 canvas 外（R8） ── */

test("宽裁图（nativeW > innerW/0.7）挂 data-zoom；窄裁图不挂", () => {
  const wide = { i: 0, kind: "table", bbox: [0, 0, 900, 400], tableClass: "image", crop: "t/w.png", cropSize: [894, 365] };
  const narrow = { i: 1, kind: "text", bbox: [0, 500, 200, 520], coordSource: "crop", crop: "t/n.png", cropSize: [54, 20] };
  const p = { ...page, blocks: [wide, narrow] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 350, 12, null, "d", true) as (Stub | null)[];
  // 894 > 350/0.7=500 ⇒ 缩放后正文 <10px，必须提供原生尺寸阅读路径
  assert.equal(nodes[0]!.dataset.zoom, "1");
  assert.equal(nodes[0]!.dataset.nativeW, "894");
  assert.equal(nodes[0]!.dataset.nativeH, "365");
  assert.equal(nodes[1]!.dataset.zoom, undefined, "巨带行裁图（中位 54px）不触发浮层阈值");
});

test("点按浮层：挂 document.body（canvas 外），fixed 定位、原生宽；背景/Esc 可关", () => {
  const wide = {
    i: 0, kind: "table", bbox: [10, 100, 900, 500], tableClass: "image",
    crop: "table-crops/w.png", cropSize: [894, 365], text: "宽表",
  };
  const p = { ...page, blocks: [wide] };
  body.children = [];
  const { wrap, canvas } = renderPaper(p as never, { paneW: 372, doc: "doc" });
  const zoomNodes = wrap.querySelectorAll("[data-zoom]");
  assert.equal(zoomNodes.length, 1, "rAF 接线后宽裁图应带 data-zoom");
  fire(zoomNodes[0]!, "click");
  assert.equal(body.children.length, 1, "浮层必须挂 body（canvas 有 overflow:hidden，挂里面会被裁——R8）");
  const ov = body.children[0]!;
  assert.ok(wrap.querySelectorAll(".crop-zoom-overlay").length === 0, "浮层不得在纸面容器内");
  assert.ok(canvas.querySelectorAll(".crop-zoom-overlay").length === 0);
  assert.ok(String(ov.style.cssText ?? "").includes("position:fixed"), "浮层必须 fixed 定位（桩里内联样式走 cssText，与 table-render 同口径）");
  const ovImgs = findAll(ov, "img");
  assert.equal(ovImgs.length, 1);
  assert.equal(ovImgs[0]!.src, "/data/out/doc/table-crops/w.png");
  assert.ok(String(ovImgs[0]!.style.cssText ?? "").includes("width:894px"), "浮层按原生尺寸展示");
  // 点背景关闭
  fire(ov, "click", { target: ov });
  assert.equal(body.children.length, 0, "点背景应关闭浮层");
  // Esc 关闭
  fire(zoomNodes[0]!, "click");
  assert.equal(body.children.length, 1);
  for (const fn of docListeners["keydown"] ?? []) fn({ key: "Escape" });
  assert.equal(body.children.length, 0, "Esc 应关闭浮层");
});

/* ── diagnostics：crop 节点叠 bbox 审计框 ── */

test("diagnostics 开：crop 节点带 bbox 审计框；默认不画", () => {
  const line = { i: 0, kind: "text", bbox: [100, 100, 390, 120], coordSource: "crop", crop: "t/n.png", cropSize: [54, 20], text: "行" };
  const p = { ...page, blocks: [line] };
  const c1 = makeNode("div");
  appendBlockNodes(c1, p, 350, 12, null, "d", true, true);
  assert.ok(c1.querySelectorAll(".crop-audit-box").length >= 1, "diagnostics 应叠 bbox 审计框");
  const c2 = makeNode("div");
  appendBlockNodes(c2, p, 350, 12, null, "d", true);
  assert.equal(c2.querySelectorAll(".crop-audit-box").length, 0, "默认不画审计框");
});

/* ── ⑦ N12 回归：表内容行框过冲表框仍须抑制（双像），真表外行绝不抑（不丢内容） ──
   几何取自曲线运动 page-10（idx9）实测：表 bbox 右缘 550.84，第4列三行右缘 570.01
   （过冲 19.17pt = 行宽 15.7% = 表宽 3.8%），行中心在表内 ⇒ 截图已含 ⇒ 必须抑制。
   守卫：中心在表外 / 重叠不足 / 单边过冲超表边长 10%（table-render 反例锁同几何）⇒ 不抑。 */

const N12_TABLE_BBOX = [41.32, 89.46, 550.84, 378.89];
const N12_COL4_ROWS = [
  { i: 1, kind: "text", bbox: [448.17, 103.52, 570.01, 113.81], text: "两物块用轻绳连接, 分别位" },
  { i: 2, kind: "text", bbox: [448.17, 118.43, 570.01, 128.72], text: "于圆盘中心两侧 (" },
  { i: 3, kind: "text", bbox: [448.17, 133.34, 570.01, 143.63], text: "rA>rB,mA=mB,μ 相同)" },
  // 底缘过冲同判：过冲 5.11pt（表高 1.8%），垂直重叠 78.7% ≥ 70%，中心在表内
  { i: 4, kind: "text", bbox: [448.17, 360, 540, 384], text: "表底缘过冲行" },
];

test("N12 回归：image 表内容行框过冲表框（中心在表内+实质重叠）⇒ 抑制，不叠双像", () => {
  const table = {
    i: 0, kind: "table", bbox: N12_TABLE_BBOX, text: "整表压平文字",
    tableClass: "image", tableSource: "v3",
    crop: "table-crops/p010-t0.png", cropSize: [895, 490],
  };
  const p = { ...page, blocks: [table, ...N12_COL4_ROWS] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 346, 12, null, "doc", true) as (Stub | null)[];
  assert.ok(nodes[0], "image 表整表截图必须渲染");
  for (const r of N12_COL4_ROWS) {
    assert.equal(nodes[r.i], null, `行 ${r.i}（${r.text}）是表内容且截图已含 ⇒ 必须抑制（否则双像）`);
  }
});

test("N12 回归：text 表网格同样抑制过冲表框的内容行（网格已呈现）", () => {
  const table = {
    i: 0, kind: "table", bbox: N12_TABLE_BBOX, text: "整表压平文字",
    html: "<table><tr><td>格1</td><td>两物块用轻绳连接, 分别位于圆盘中心两侧</td></tr></table>",
    tableClass: "text", tableSource: "v3",
  };
  const p = { ...page, blocks: [table, ...N12_COL4_ROWS] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 346, 12, null, "doc", true) as (Stub | null)[];
  assert.equal(findAll(c, "table").length, 1, "text 表画网格");
  for (const r of N12_COL4_ROWS) {
    assert.equal(nodes[r.i], null, `行 ${r.i} 已由网格呈现 ⇒ 抑制`);
  }
});

test("N12 守卫：真表外行（中心在表外 / 重叠不足 / 过冲超表边长10%）绝不抑制", () => {
  const table = {
    i: 0, kind: "table", bbox: N12_TABLE_BBOX, text: "整表压平文字",
    tableClass: "image", tableSource: "v3",
    crop: "table-crops/p010-t0.png", cropSize: [895, 490],
  };
  const outside = [
    // 中心在表外（右侧邻行）：纯表外行
    { i: 1, kind: "text", bbox: [560, 103.52, 680, 113.81], text: "表右邻行" },
    // 跨表右缘但中心在表外：仍是表外行
    { i: 2, kind: "text", bbox: [500, 103.52, 620, 113.81], text: "跨右缘中心在外" },
    // 中心在表内但水平重叠仅 50.2% < 70%：横穿表的宽正文行，不抑
    { i: 3, kind: "text", bbox: [350, 103.52, 750, 113.81], text: "横穿宽行" },
  ];
  const p = { ...page, blocks: [table, ...outside] };
  const c = makeNode("div");
  const nodes = appendBlockNodes(c, p, 346, 12, null, "doc", true) as (Stub | null)[];
  for (const r of outside) {
    assert.ok(nodes[r.i], `行 ${r.i}（${r.text}） genuinely 表外 ⇒ 必须照常渲染（不丢内容红线）`);
  }
  // 过冲超表边长 10% 的反例锁（与 table-render 旧锁同几何）：中心在表内、重叠 79.6%，
  // 但右缘过冲 100pt = 表宽 25% ⇒ 不是表内容框过冲，不抑
  const t2 = {
    i: 0, kind: "table", bbox: [0, 100, 400, 300], text: "甲\t乙",
    html: "<table><tr><td>格</td></tr></table>",
  };
  const bigOver = { i: 1, kind: "text", bbox: [10, 120, 500, 140], text: "越出右边界的行" };
  const c2 = makeNode("div");
  const n2 = appendBlockNodes(c2, { ...page, blocks: [t2, bigOver] }, 760, 12, null, "d", true) as (Stub | null)[];
  assert.ok(n2[1], "过冲达表宽 25% 的行不是表内容框过冲 ⇒ 保留（否则会丢内容）");
});

/* ── ⑥ 旧快照逐字节不变（字面量在改动前用现行实现实测捕获） ── */

test("旧快照（无新字段）：渲染序列化与改动前逐字节一致", () => {
  const p = {
    ...page,
    blocks: [
      { i: 0, kind: "table", bbox: [0, 100, 400, 300], text: "甲\t乙", html: "<table><tr><td>格1</td><td>格2</td></tr></table>" },
      { i: 1, kind: "text", bbox: [10, 120, 390, 140], text: "压平的第一行" },
      { i: 2, kind: "text", bbox: [10, 400, 390, 420], text: "表格外的正文" },
    ],
  };
  const c = makeNode("div");
  appendBlockNodes(c, p, 760, 12, null, "d", true);
  const ser = (node: Stub, out: string[] = []): string[] => {
    for (const k of node.children) {
      out.push(`${k.tagName}|${k.className}|${JSON.stringify(k.style)}|${k.title}|${k.innerHTML}|${JSON.stringify(k.dataset)}`);
      ser(k, out);
    }
    return out;
  };
  const LEGACY_PIN = ["div|blk blk-table kind-table|{\"left\":\"0%\",\"top\":\"7.142857142857142%\",\"width\":\"40%\",\"height\":\"14.285714285714285%\"}|上游表格（按 spans[].html 的 rowspan/colspan 还原网格）||{\"bi\":\"0\"}","table||{\"cssText\":\"width:100%;height:100%;border-collapse:collapse;table-layout:fixed;white-space:normal;font-size:12px;line-height:1.15;\"}|||{}","colgroup||{}|||{}","col||{\"width\":\"50.00%\"}|||{}","col||{\"width\":\"50.00%\"}|||{}","tr||{}|||{}","td||{\"cssText\":\"border:1px solid rgba(0,0,0,.35);padding:1px 3px;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere;\"}||格1|{}","td||{\"cssText\":\"border:1px solid rgba(0,0,0,.35);padding:1px 3px;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere;\"}||格2|{}","div|blk blk-line kind-text|{\"left\":\"1%\",\"top\":\"28.57142857142857%\",\"width\":\"38%\",\"height\":\"1.4285714285714286%\"}|表格外的正文||{\"bi\":\"2\"}","span|txt|{\"fontSize\":\"12px\"}||表格外的正文|{}"];
  assert.deepEqual(ser(c), LEGACY_PIN, "默认关旗标：无新字段的旧快照渲染必须逐字节不变");
});