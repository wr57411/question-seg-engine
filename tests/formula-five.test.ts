// formula-five.test.ts —— 锁住「五方公式对照」的判据本身。
//
// 为什么要有（2026-11-03）：这条链路的全部价值在于**别把格式差当成识别分歧**、
// 也**别把读对的源算成漏**。这两点各栽过一次：
// ① 第一版按 IoU 把五家一起聚类，块级框把整页公式吸进一簇，产出「四家 I=q/t、
//    V3 是 1/R总=…」的假分歧；
// ② 拿"锚"的串当靶时，锚自己读错（V3 把嵌套分式读扁）就会把读对的三家算成未命中。
// 所以这里锁的是**判据**，不是某本书的读数。真实读数由 `npm run audit:formula` 出，
// 判定仍必须回原卷页图（`DECISIONS §106`）。
//
// 样例串全部取自《电路》实测原样输出（`data/_probe/2026-11-03-paddle/` 与各快照）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorRows,
  canonLatex,
  classify,
  dice,
  hasNestedFrac,
  summarize,
  spans,
  type FormulaItem,
} from "../scripts/formula-five-audit.js";

/* ── 1. 格式差必须被抹平 ───────────────────────────────────────────── */

test("canonLatex: 同一式子的三种写法归一后相等", () => {
  const v3 = "I_{保}=0.25\\ A";
  const minicpm = "I_{保} = 0.25 \\, A";
  const oxr = "I_{保}=0.25\\,A";
  assert.equal(canonLatex(v3), canonLatex(minicpm));
  assert.equal(canonLatex(minicpm), canonLatex(oxr));
});

test("canonLatex: MinerU 的字符级空格不算分歧", () => {
  // MinerU 实测把 `10^{18}` 印成 `1 0 ^ { 1 8 }`，剥掉空白后与紧凑写法同串
  assert.equal(canonLatex("5 \\times 1 0 ^ { 1 8 }"), canonLatex("5\\times10^{18}"));
  assert.equal(canonLatex("\\mathrm { ~ V ~ }"), canonLatex("V"));
});

test("canonLatex: 结构差必须保留（扁平 vs 嵌套分式不能归一到一起）", () => {
  const flat = "P_{出}=I^{2}R=\\frac{E^{2}}{\\left(R-r\\right)^{2}}+4r"; // V3 实测（错）
  const nested = "P_{出}=I^{2}R=\\frac{E^{2}}{\\frac{(R-r)^{2}}{R}+4r}"; // VL/MiniCPM/OXR 实测（对）
  assert.notEqual(canonLatex(flat), canonLatex(nested));
  assert.equal(hasNestedFrac(nested), true);
  assert.equal(hasNestedFrac(flat), false);
});

test("canonLatex: 大小写有意义，`UIt` 与 `Ult` 不得归一到一起（原图核验发现的漏判）", () => {
  assert.notEqual(canonLatex("W = Q = UIt = I^{2}Rt"), canonLatex("W=Q=Ult=I^{2}Rt"));
});

test("spans: 页级串比逐条锚宽 ⇒ 算切分边界不同，不算离群", () => {
  assert.equal(spans("q=i^2rt(", "i^2rt"), true);
  assert.equal(spans("i^2rt", "q=i^2rt("), false);
});

test("anchorRows: 页级长串包含逐条短锚时，不把读对的短锚挤成少数派", () => {
  const items: FormulaItem[] = [
    { src: "v3", page: 1, latex: "I^{2}Rt", norm: [0.5, 0.3, 0.62, 0.33], boxKind: "exact", score: null, inTable: true },
    { src: "vl", page: 1, latex: "Q = I^{2}Rt", norm: null, boxKind: "none", score: null, inTable: true },
    { src: "minicpm", page: 1, latex: "Q = I^{2}Rt", norm: null, boxKind: "none", score: null, inTable: true },
  ];
  const r = anchorRows(items)[0]!;
  assert.ok(r.cells.vl, "VL 仍应归到这一槽位");
  assert.ok(!r.outliers.includes("v3"), "V3 的短串是长串的连续片段，不该被判离群");
});

/* ── 2. 乱码判据 ───────────────────────────────────────────────────── */

test("classify: MinerU 把汉字下标映射成 ℝ¹ 时打 garbled 标", () => {
  const tags = classify("I _ { \\mathbb { R } ^ { 1 } } = 0 . 2 5 \\mathrm { ~ A ~ } _ { \\circ }", canonLatex("x"), false);
  assert.ok(tags.includes("garbled"), `期望含 garbled，实得 ${tags.join(",")}`);
});

test("classify: 汉字下标与表内各自打标", () => {
  assert.ok(classify("E = U_{外} + U_{内}", canonLatex("E=U_{外}"), false).includes("cjk"));
  assert.ok(classify("W=UIt", canonLatex("W=UIt"), true).includes("table"));
});

/* ── 3. 归队门槛：单字符不得混进同位 ─────────────────────────────── */

test("dice: 自身为 1、无关串接近 0", () => {
  assert.equal(dice("abcde", "abcde"), 1);
  assert.ok(dice("abcde", "vwxyz") < 0.2);
});

test("anchorRows: 单字符池条目不得靠包含关系混进长串槽位", () => {
  const items: FormulaItem[] = [
    { src: "v3", page: 0, latex: "R_{\\text{总}}=R_1+R_2+\\cdots+R_n", norm: [0.7, 0.4, 0.9, 0.45], boxKind: "exact", score: null, inTable: false },
    { src: "oxr", page: 0, latex: "b", norm: [0.1, 0.1, 0.2, 0.12], boxKind: "block", score: null, inTable: false },
  ];
  const rows = anchorRows(items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cells.oxr, null, "单字符 'b' 不该被算成该槽位的命中");
});

/* ── 4. 多数派判定：锚读错时不得把读对的源算成漏 ─────────────────── */

test("anchorRows: 只有一个逐条框家时不选边 —— 整行标待核、各写法都列出来", () => {
  const nested = "P_{出}=I^{2}R=\\frac{E^{2}}{\\frac{(R-r)^{2}}{R}+4r}";
  const items: FormulaItem[] = [
    // 锚只有 V3 的逐条框（内容是错的扁平写法）；其余三家只能页级归队
    { src: "v3", page: 4, latex: "P_{出}=I^{2}R=\\frac{E^{2}}{\\left(R-r\\right)^{2}}+4r", norm: [0.72, 0.27, 0.9, 0.32], boxKind: "exact", score: null, inTable: true },
    { src: "vl", page: 4, latex: nested, norm: [0.03, 0.11, 0.92, 0.4], boxKind: "block", score: null, inTable: true },
    { src: "minicpm", page: 4, latex: "P_{出} = I^{2}R = \\frac{E^{2}}{\\frac{(R - r)^{2}}{R} + 4r}", norm: null, boxKind: "none", score: null, inTable: true },
    { src: "oxr", page: 4, latex: nested, norm: null, boxKind: "none", score: null, inTable: true },
  ];
  const r = anchorRows(items)[0]!;
  assert.ok(r.variants.length >= 2, "应至少分出两种写法");
  assert.equal(r.majority, null, "有分歧时不选边 ⇒ majority 必须是 null");
  assert.equal(r.hardConflict, false, "只有一个逐条框家，不构成 hard 互斥");
  assert.ok(r.outliers.length >= 2, "整行进待核清单");
  assert.ok(r.variants.some((v) => hasNestedFrac(v.latex)), "读对的嵌套写法必须原样列出，供页图判定");
  assert.ok(r.tags.includes("nested"));
});

test("anchorRows: 两个逐条框家互斥 ⇒ 标 hardConflict（位置可比，优先看）", () => {
  const items: FormulaItem[] = [
    { src: "mineru", page: 1, latex: "I = I _ { 1 } = I _ { 2 } = \\cdots = I _ { n }", norm: [0.1, 0.5, 0.5, 0.52], boxKind: "exact", score: 0.94, inTable: true },
    { src: "v3", page: 1, latex: "I=I_{1}+I_{2}+\\cdots+I_{n}", norm: [0.11, 0.501, 0.49, 0.521], boxKind: "exact", score: null, inTable: true },
  ];
  const r = anchorRows(items)[0]!;
  assert.equal(r.hardConflict, true, "《电路》p1 实测：MinerU 把加号读成等号，应被点名待核");
});

test("anchorRows: 一方包含另一方算粒度差，不算分歧", () => {
  const items: FormulaItem[] = [
    { src: "mineru", page: 1, latex: "L _ { 1 } , L _ { 2 }", norm: [0.43, 0.54, 0.49, 0.56], boxKind: "exact", score: 0.89, inTable: false },
    { src: "v3", page: 1, latex: "L_{2}", norm: [0.44, 0.545, 0.485, 0.558], boxKind: "exact", score: null, inTable: false },
  ];
  const r = anchorRows(items)[0]!;
  assert.equal(r.granularity, true);
  assert.equal(r.outliers.length, 0, "粒度差不该产出离群家");
});

/* ── 5. 可核验性分档（决定错误率能不能算） ─────────────────────────── */

test("via 分档：块包含锚点记 block，只有页级文本记 page（page 不进错误率分母）", () => {
  const items: FormulaItem[] = [
    { src: "v3", page: 2, latex: "I_{\\text{保}}=0.25\\ A", norm: [0.8, 0.43, 0.92, 0.46], boxKind: "exact", score: null, inTable: false },
    // 这条块的框**包含**锚点 ⇒ 位置可核验到块一级
    { src: "vl", page: 2, latex: "I_{\\text{保}}=0.25\\ \\text{A}", norm: [0.5, 0.38, 0.95, 0.52], boxKind: "block", score: null, inTable: false },
    // 这条没有任何框 ⇒ 只能页级猜，标 page
    { src: "minicpm", page: 2, latex: "I_{保} = 0.25 \\, A", norm: null, boxKind: "none", score: null, inTable: false },
  ];
  const r = anchorRows(items)[0]!;
  assert.equal(r.cells.vl?.via, "block", "块框包含锚点 ⇒ 应记 block");
  assert.equal(r.cells.minicpm?.via, "page", "无框的页级匹配 ⇒ 必须记 page，不能冒充可核验");
  assert.equal(r.cells.v3?.via, "hard");
});

test("summarize：page 档单独计数，不混进可核验数", () => {
  const items: FormulaItem[] = [
    { src: "v3", page: 0, latex: "R=\\rho\\frac{l}{S}", norm: [0.1, 0.2, 0.4, 0.24], boxKind: "exact", score: null, inTable: false },
    { src: "vl", page: 0, latex: "R = \\rho \\frac{l}{S}", norm: null, boxKind: "none", score: null, inTable: false },
  ];
  const st = summarize(anchorRows(items))[0]!;
  assert.equal(st.per.v3!.hardN, 1);
  assert.equal(st.per.v3!.pageOnly, 0, "V3 有逐条框 ⇒ 不该落到 page 档");
  assert.equal(st.per.vl!.pageOnly, 1, "VL 只有页级匹配 ⇒ 记 page");
  assert.equal(st.per.vl!.hardN, 0);
});
