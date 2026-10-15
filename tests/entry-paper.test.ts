// entry-paper.test.ts —— 「一条目不是一个矩形」的切段判据锁。
//
// 背景（2026-10-15 用户手机截图报出）：面板按原卷坐标裁条目时，若直接取整条目的 bbox 并集，
// 会把**整页**框进来 —— 中间一大块不属于它的空白 + 最后一行被切一半。
// 切段判据我试错过两次，都写进来了（见 DECISIONS §33 补正）：
//   ✗ 按垂直空洞切 ⇒ 碎成 3–4 段、切出 56×33 的碎条；
//   ✗ 按阅读顺序里"顶边回跳"切 ⇒ **一张高图与文字并排**就被误判成换栏（实测切成 7 段）；
//   ✓ 先按栏分组、组内只在空洞 > 阈值处断。
// 另锁一条：判栏**只用页面中线**，不用 `page.centers`（答案册 p17 的 centers 是退化的 [31,286]）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectEntryItems, columnOf, entryCrop, entrySegments, splitSegments, unionBbox } from "../final/entry-paper.js";

const P2 = { columns: 2, width: 554 }; // 双栏页：中线 277
const P1 = { columns: 1, width: 554 };
const blk = (x0: number, y0: number, x1: number, y1: number) => ({ bbox: [x0, y0, x1, y1] });

test("① 同栏内并排的高图不得被当成换栏（曾经切成 4 段）", () => {
  // 右栏：一行文字 → 一张很高的图（y674..757）→ 文字从 y675 继续（图的左侧并行）
  const blocks = [blk(294, 659, 389, 669), blk(442, 674, 536, 757), blk(304, 675, 438, 684), blk(304, 691, 438, 700)];
  const segs = splitSegments(blocks, P2);
  assert.equal(segs.length, 1, "并排高图产生的是负空洞，不该断");
});

test("② 同栏内真断开（空洞 > 60pt）必须断段", () => {
  // 答案册 p3:q30 左栏：图在页顶 y24..144，正文在栏底 y723..764 —— 中间 579pt 不属于本条目
  const blocks = [blk(212, 24, 277, 144), blk(36, 723, 132, 733), blk(47, 740, 277, 748)];
  const segs = splitSegments(blocks, P2);
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.length, 1, "第一段只有页顶那张图");
  assert.equal(segs[1]!.length, 2, "第二段是栏底的两行正文");
});

test("③ 跨栏续排：左组在前、右组在后，各自成段", () => {
  // 答案从左栏底部续到右栏顶部（书上的读法就是先左后右）
  const blocks = [blk(36, 723, 277, 733), blk(304, 25, 535, 36), blk(304, 42, 535, 51)];
  const segs = splitSegments(blocks, P2);
  assert.equal(segs.length, 2);
  assert.equal(columnOf(segs[0]![0]!, P2), 0, "第一段属左半页");
  assert.equal(columnOf(segs[1]![0]!, P2), 1, "第二段属右半页");
});

test("④ 判栏只用页面中线，不受退化的 page.centers 影响", () => {
  const b = blk(28, 516, 260, 524); // 中心 144 < 277 ⇒ 左栏
  assert.equal(columnOf(b, P2), 0);
  // 答案册 p17 实测 centers=[31,286]：若按"最近栏中心"判，这条会被判去右栏
  const degenerate = { ...P2, centers: [31, 286] };
  assert.equal(columnOf(b, degenerate), 0, "centers 退化不得改变判栏结果");
  assert.equal(columnOf(b, P1), null, "单栏页不分栏");
});

test("⑤ 单栏页里的大空洞仍会断段（不靠分栏也漏不掉）", () => {
  const blocks = [blk(36, 40, 400, 60), blk(36, 400, 400, 420)];
  assert.equal(splitSegments(blocks, P1).length, 2);
});

test("⑥ 并集只用于算裁切框，不用于决定内容归属", () => {
  const u = unionBbox([blk(10, 20, 30, 40), blk(50, 60, 70, 80)]);
  assert.deepEqual(u, [10, 20, 70, 80]);
  assert.equal(unionBbox([]), null);
});

/* ── 内容集合：不能只画 question.blocks（纸面同区域还有候选行与游离块） ── */

const page0 = (over = {}) => ({
  width: 596,
  height: 824,
  columns: 2,
  blocks: [
    { i: 0, bbox: [40, 74, 281, 85], text: "题干行" },
    { i: 1, bbox: [53, 93, 280, 103], text: "题干次行" },
    { i: 2, bbox: [65, 340, 280, 352], text: "D 选项行" },
    { i: 8, bbox: [194, 201, 282, 283], kind: "image", img: "x.jpg", text: "[图片]" }, // 被别题抢走的图
    { i: 20, bbox: [53, 300, 280, 312], text: "谁都没认领的游离行" },
    { i: 30, bbox: [318, 349, 462, 365], text: "右栏别题的行" },
  ],
  ocrFill: [
    { accepted: true, bbox: [46, 201, 191, 218], win: [46, 201, 191, 218], text: "A. 生“热狗”对单根金属圆" },
    { accepted: true, bbox: [400, 700, 500, 712], win: [400, 700, 500, 712], text: "页脚远处的候选行" },
    { accepted: false, bbox: [60, 120, 150, 132], win: [60, 120, 150, 132], text: "未采纳的候选行" },
  ],
  questions: [
    { id: "q1", blocks: [0, 1, 2] },
    { id: "q2", blocks: [8, 30] },
  ],
  ...over,
});

test("⑦ 区域内的 OCR 候选行必须纳入，区域外/未采纳的不纳入", () => {
  const p = page0();
  const own = [p.blocks[0]!, p.blocks[1]!, p.blocks[2]!];
  const { items } = collectEntryItems(p, own);
  const ocrTexts = items.filter((x) => x.ocr).map((x) => x.ocr!.text);
  assert.ok(ocrTexts.includes("A. 生“热狗”对单根金属圆"), "A 选项那行只存在于候选里，漏了就等于面板缺内容");
  assert.equal(ocrTexts.includes("页脚远处的候选行"), false, "区域外的候选不该被拽进来");
  assert.equal(ocrTexts.includes("未采纳的候选行"), false, "未采纳（accepted:false）的一律不画");
});

test("⑧ 区域内不属于任何题目的引擎块也要纳入（纸面画得出来，裁切不能丢）", () => {
  const p = page0();
  const own = [p.blocks[0]!, p.blocks[1]!, p.blocks[2]!];
  const { items } = collectEntryItems(p, own, { drop: new Set() });
  assert.ok(items.some((x) => x.blk?.i === 20), "游离块 20 在区域内，必须出现");
  assert.equal(items.some((x) => x.blk?.i === 30), false, "右栏别题的块不能被算进本题");
});

test("⑨ 属于别题的块不抢，但要计数（留白得说清原因）", () => {
  const p = page0();
  const own = [p.blocks[0]!, p.blocks[1]!, p.blocks[2]!];
  const { foreignBlocks } = collectEntryItems(p, own, { drop: new Set() });
  assert.equal(foreignBlocks, 1, "只有那张被第 2 题认领的图算『别题的块』");
});

/* ── 跨页条目：同一个 id 在快照里按页各出一条，段段都要裁 ──
   实测（2026-10-15 用户截图报出）：热狗题的答案起始页只有 3 块（3 行），
   续段 11 块在下一页 —— 索引只留第一条，面板就只裁出 3 行。 */

test("⑩ entrySegments 找齐一个条目的全部页段（按页序）", () => {
  const pages = [
    { questions: [{ id: "a", blocks: [84, 85, 86] }, { id: "b", blocks: [0] }] },
    { questions: [{ id: "c", blocks: [0] }, { id: "a", blocks: [71, 72, 1] }] },
    { questions: [{ id: "d", blocks: [0] }] },
  ];
  assert.deepEqual(
    entrySegments(pages, "a").map((s) => s.blocks),
    [[84, 85, 86], [71, 72, 1]],
    "两段都要有，且保持页序与各自页内的块",
  );
  assert.equal(entrySegments(pages, "nope").length, 0);
  assert.equal(entrySegments(undefined as never, "a").length, 0, "快照没到位时不得抛");
});

/* ── 最小 DOM 桩：与 layout-invariant.test.ts 同一套理由（零依赖、任何机器都能跑）。
   `el()` 只在调用时才读 document，故桩可以在 import 之后再装。 ── */

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

(globalThis as unknown as { document: unknown }).document = {
  createElement: (t: string) => makeNode(t),
  createTextNode: (t: string) => Object.assign(makeNode("#text"), { textContent: t }),
};


const textPage = (head: string, tail: string) => ({
  index: 0,
  width: 595,
  height: 842,
  columns: 2,
  centers: [160, 440],
  blocks: [
    { i: 0, bbox: [50, 60, 280, 84], text: head, kind: "text" },
    { i: 1, bbox: [50, 90, 280, 114], text: tail, kind: "text" },
  ],
  order: [0, 1],
  discarded: [],
  uncovered: [],
  ocrFill: [],
  questions: [{ id: "d:p0:q0", number: "1", blocks: [0, 1], startsHere: true }],
});

function allText(node: Stub, out: string[] = []): string[] {
  // `blockNode` 把正文写进 `.txt` 的 innerHTML（不是 textContent），桩里两个都要收
  if (node.textContent) out.push(node.textContent);
  if (node.innerHTML) out.push(node.innerHTML);
  for (const c of node.children) allText(c, out);
  return out;
}

function countClass(node: Stub, cls: string): number {
  let n = node.classList.contains(cls) ? 1 : 0;
  for (const c of node.children) n += countClass(c, cls);
  return n;
}

/** 深度优先找第一个带该 class 的后代（含自身） */
function findClass(node: Stub, cls: string): Stub | null {
  if (node.classList.contains(cls)) return node;
  for (const c of node.children) {
    const hit = findClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

/** 深度优先收集**所有**带该 class 的后代（不含自身）：一段一页可能有多只裁切框 */
function findAll(node: Stub, cls: string): Stub[] {
  const out: Stub[] = [];
  for (const c of node.children) {
    if (c.classList.contains(cls)) out.push(c);
    out.push(...findAll(c, cls));
  }
  return out;
}

test("⑪ entryCrop 把跨页条目的每一页都裁出来（只裁第一页 = 内容不见）", () => {
  const p1 = textPage("第 1 页首行", "第 1 页次行");
  const p2 = { ...textPage("第 2 页续行", "第 2 页末行"), index: 1 };
  const box = entryCrop(
    [
      { page: p1, blocks: [0, 1] },
      { page: p2, blocks: [0, 1] },
    ],
    "d",
    600,
  );
  assert.ok(box, "两段都有块，必须产出容器");
  const txt = allText(box).join("|");
  assert.ok(txt.includes("第 1 页首行") && txt.includes("第 2 页续行"), "两页的内容都要在面板里");
  assert.equal(countClass(box, "entry-crop"), 2, "一页一段");

  // 只给一段时仍要工作（绝大多数条目不跨页）
  const one = entryCrop([{ page: p1, blocks: [0, 1] }], "d", 600);
  assert.ok(one && !allText(one).join("|").includes("第 2 页续行"));
  assert.equal(entryCrop([], "d", 600), null, "空段列表 ⇒ null，让调用方走降级路径");
});

/* ── 区域口径：按栏分开，不是 own 的外接单矩形（2026-10-15 用户报"选错了 OCR 方框"） ──
   实测 题册 p5 第3题：题干在左栏底 y594..777、四个选项在右栏顶 y72..142（书上跨栏续排）。
   单矩形并集 ⇒ x[40,443] × y[72,777] ≈ 整页 ⇒ 第1题热狗题的 6 行候选被吸进第3题面板，
   还排在第一段；第1题的引擎块因"别题不抢"只计数不画 ⇒ 中间一片空洞 + "另有 57 个块"。 */

const crossCol = () => ({
  columns: 2,
  width: 554, // 中线 277
  blocks: [
    { i: 0, bbox: [40, 100, 260, 112], text: "A 题题干行" },
    { i: 1, bbox: [40, 120, 260, 132], text: "A 题次行" },
    { i: 2, bbox: [40, 400, 260, 412], text: "B 题左栏底行" },
    { i: 3, bbox: [300, 100, 520, 112], text: "B 题右栏顶行" },
  ],
  ocrFill: [
    // A 题被上游整行漏掉的第三行：在 A 题两块**下方** 8pt，但落在 B 题的单矩形并集里
    { accepted: true, bbox: [40, 140, 200, 152], win: [37, 137, 203, 155], text: "A 题漏掉的第三行" },
  ],
  questions: [
    { id: "a", blocks: [0, 1] },
    { id: "b", blocks: [2, 3] },
  ],
});

test("⑫ 跨栏条目的区域按栏分开：不得把别题的候选行吸进单矩形并集", () => {
  const page = crossCol();
  const ownOf = (id: string) => (page.questions.find((q) => q.id === id) as any).blocks.map((i: number) => page.blocks[i]);
  const a = collectEntryItems(page as any, ownOf("a"), { drop: new Set() });
  const b = collectEntryItems(page as any, ownOf("b"), { drop: new Set() });

  assert.equal(b.boxes.length, 2, "B 题跨栏 ⇒ 区域是左右两块，不是一个盖住整页的矩形");
  assert.equal(b.items.filter((x) => x.ocr).length, 0, "A 题的候选行不得被 B 题认领");
  assert.equal(a.items.filter((x) => x.ocr).length, 1, "补洞的候选行必须归 A 题（同栏、正上方、洞 ≤ 60pt）");
});

test("⑬ 一行候选全局只有一个主人（同栏两题矩形上下重叠时也要唯一）", () => {
  const page = crossCol();
  // 把 B 题的左栏块挪到 A 题候选的两侧，制造"两个栏矩形都碰到它"的重叠
  (page.blocks[2] as any).bbox = [40, 130, 260, 160];
  const ownOf = (id: string) => (page.questions.find((q) => q.id === id) as any).blocks.map((i: number) => page.blocks[i]);
  const a = collectEntryItems(page as any, ownOf("a"), { drop: new Set() });
  const b = collectEntryItems(page as any, ownOf("b"), { drop: new Set() });
  const got = a.items.filter((x) => x.ocr).length + b.items.filter((x) => x.ocr).length;
  assert.equal(got, 1, "同一行候选最多被一个条目认领（多认领 = 面板里出现两遍）");
});

/* ── 洞必须可见（红线 G1）：图注天然在图的**下方**，比本题块底边还低几 pt ──
   实测 答案册 p4 第3题：解析写"如图甲/乙/丙所示"，三个图注位各有一个 content 洞
   （距图底边 2pt），MinerU 与夸克扫描王都没读出来。修前面板一个都不显示。 */

const holePage = () => ({
  columns: 2,
  width: 554,
  blocks: [
    { i: 0, bbox: [36, 500, 277, 512], text: "3. 解析首行" },
    { i: 1, bbox: [53, 671, 176, 705], kind: "image", img: "a.jpg", text: "[图片]" },
  ],
  uncovered: [
    { bbox: [86, 707, 92, 715], area: 102, kind: "content" }, // 图注「甲」：在图下方 2pt
    { bbox: [300, 707, 306, 715], area: 99, kind: "content" }, // 右栏别题的洞，不得抢
    { bbox: [200, 40, 206, 48], area: 60, kind: "content" }, // 同栏但在本题上方很远
  ],
  ocrFill: [{ accepted: true, bbox: [120, 707, 130, 715], win: [118, 705, 132, 717], text: "乙" }],
  questions: [
    { id: "a", blocks: [0, 1] },
    { id: "b", blocks: [2] },
  ],
});

test("⑭ 归属本题的洞必须返回，且不与别题抢、不与已补上的候选重复", () => {
  const page = holePage();
  const own = [page.blocks[0], page.blocks[1]];
  const { holes } = collectEntryItems(page as never, own as never, { drop: new Set() } as never);
  assert.equal(holes.length, 1, "只收图下方那个洞：右栏的归别题，上方远距的不归本题");
  assert.deepEqual(holes[0]!.bbox, [86, 707, 92, 715]);
  // 已被 accepted 候选盖住的洞由 unfilledContentHoles 挡掉，这里不重复断言
});

/* ⑭ 只锁了"洞被认领"，没锁"洞画得出来"。2026-10-15 用户当场反馈「我并没有看到」：
   标记确实 append 了，但裁切框只按**文字块**并集算高度，图注天然比正文低几 pt ⇒
   框底在标记上边，`overflow:hidden` 把它整颗切掉。下面这条锁的是几何，不是 DOM 里有没有。 */

test("⑮ 洞标记必须落在承载它的裁切框**里面**（画在框外 = 等于没画）", () => {
  // 这一条**不能**带 ocrFill：候选块自己会把框撑到洞以下，反过来验时看不出回归（实测踩过）。
  const page = {
    ...holePage(),
    ocrFill: [],
    index: 0,
    height: 780,
    order: [0, 1],
    discarded: [],
    questions: [{ id: "a", number: "3", blocks: [0, 1], startsHere: true }],
  };
  const box = entryCrop([{ page: page as never, blocks: [0, 1] }] as never, "d", 380) as unknown as Stub;
  assert.equal((box as unknown as { holes: number }).holes, 1, "容器上要带洞数，面板才知道要不要写那句说明");
  assert.equal(countClass(box, "hole"), 1, "洞标记要挂进裁切容器");

  // 正文与图差 > 60pt ⇒ 切成两段，洞挂在**含图那一段**上（图注天然贴着图底）
  const crops = findAll(box, "entry-crop");
  assert.ok(crops.length >= 2, "本题被切成多段，洞只会挂到其中一段上");
  const crop = crops.find((c) => findClass(c, "hole"))!;
  assert.ok(crop, "必须有一段把洞框进来");
  const mark = findClass(crop, "hole")!;
  const canvas = findClass(crop, "canvas")!;

  const k = parseFloat(canvas.style.width!) / page.width; // 页坐标 → 屏幕像素
  const topPx = -parseFloat(/translate\([^,]+,\s*(-?[\d.]+)px/.exec(canvas.style.transform!)![1]!);
  const markBottomPx = ((parseFloat(mark.style.top!) + parseFloat(mark.style.height!)) / 100) * page.height * k;
  // `.entry-crop` 是 border-box 带 1px 边框 ⇒ 可用高 = style 高 - 2；
  // 容差 1px：translate 用 Math.round 落位，本身就有半像素误差。
  const usablePx = parseFloat(crop.style.height!) - 2;
  assert.ok(
    markBottomPx - topPx <= usablePx + 1,
    `标记底边在框内 ${markBottomPx.toFixed(1)}px − 框顶 ${topPx.toFixed(1)}px = ${(markBottomPx - topPx).toFixed(1)}px，超出可用高 ${usablePx}px`,
  );
});
