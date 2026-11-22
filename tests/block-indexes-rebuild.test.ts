// block-indexes-rebuild.test.ts —— B-66 `source.blockIndexes` 导出期重建的判据回归。
//
// 夹具取自 tmp/astage-rerun/report.md 已裁定的错位实例（真实块文本，书A = 2026《高考必刷题•》新高考版）：
// - p123:q534：记录 8163..8178，真实 8168..8183（记录区间从上一题的选项 A 开始）；
// - p176:q744：记录 11541..11560，真实 11553..11572（记录区间从上一题题头 `12. NEW [湖北…` 开始）。
// 这几条守的是**具体摔过的坑**，不是假想的边界：
// 1. 反查必须用「块连跑拼接 + 匹配起点在起始块内」——stem 首段常跨块，单块覆盖率必然漏
//   （书B 实测：单块口径反查失败 216 题，连跑口径归零）；
// 2. 探针必须用 norm（汉字+字母+数字）——答案式条目（"D 考查点 ▸ …"）stem 开头无汉字，
//   纯汉字探针会从 stem 中段取材锚错块（书B 实测 3 条假命中）；
// 3. 反查不中 ⇒ 保留原值并计数（宁保原值不猜）；
// 4. 题目在块流中单调 ⇒ 从上一题已定位块之后扫（方向守卫）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAGE_RADII,
  planBlockIndexRebuilds,
  type FlatBlock,
  type RebuildQuestionInput,
} from "../scripts/lib/block-indexes-rebuild.js";

/** 汉字 4 字滑窗覆盖率（head 命中检验口径，同 tmp/astage-rerun/report.md §结构性发现）。 */
const cjk = (s: string) => s.replace(/[^\u4e00-\u9fa5]/g, "");
function headCoverage(stem: string, texts: string[]): number {
  const head = cjk(stem).slice(0, 10);
  if (head.length < 4) return 1;
  const hay = texts.map(cjk).join("");
  let hit = 0;
  const tot = head.length - 3;
  for (let i = 0; i < tot; i++) if (hay.includes(head.slice(i, i + 4))) hit++;
  return hit / tot;
}

/**
 * 夹具块序列：index 必须与数组位置一致（阅读顺序全局下标，模块有断言），
 * 起始下标之前补空块占位。
 */
function mkBlocks(start: number, rest: [number, string][]): FlatBlock[] {
  const out: FlatBlock[] = [];
  for (let i = 0; i < start; i++) out.push({ index: i, pageIndex: -1, text: "" });
  rest.forEach(([pageIndex, text], k) => out.push({ index: start + k, pageIndex, text }));
  return out;
}

const q = (id: string, pageIndex: number, stem: string, lo: number, hi: number): RebuildQuestionInput => ({
  id,
  stem,
  source: {
    pageIndex,
    blockIndexes: Array.from({ length: hi - lo + 1 }, (_, k) => lo + k),
  },
});

// ── 夹具 A：书A p123（q533 选项 A 起 → q534 真实题头 8168 → q535 真实题头 8184） ──
// 块文本逐字取自 stages.json 阅读序拍平（data/out/2026《高考必刷题•》新高考版）。
// g8201（q536 题头）为超dump范围的最小补块，形态按 q536 stem 推定（测试内自洽，不验原卷）。
const BOOK_A_P123 = mkBlocks(8161, [
  [123, "放, 所有物体沿竖直方向运动. 则下列说法正确"],
  [123, "的是 (重力加速度为 $g$) ( )"],
  [123, "A. 若 X、Y 恰能分离，则 $E_{p}=(m_{1}+m_{2})g(l_{0}-l)$"],
  [123, "[图片]"],
  [123, "B. 若 X、Y 恰能分离，则 $E_{p}=(m_{1}+m_{2})gl$"],
  [123, "C. 若 X、Y 能分离，则 Y 的最大离地高度为 "],
  [123, "$\\frac{E_{p}}{(m_{1}+m_{2})g}+(l_{0}-l)$"],
  [123, "9.[广东肇庆 2025 二模]如图是简化后的跳台滑雪"],
  [123, "的雪道示意图,运动员从助滑雪道 AB 上由静止"],
  [123, "开始滑下,到达 C 点后水平飞出,落到滑道(足够"],
  [123, "长)上的 D 点,E 是运动轨迹上的一点,在该点运"],
  [123, "动员的速度方向与 CD 平行. 设运动员从 C 到 E "],
  [123, "与从 E 到 D 的运动时间分别为 $t_{1}$、$t_{2}$,EF 垂直"],
  [123, "于 CD,不计空气阻力,则关于运动员离开 C 点后"],
  [123, "的飞行过程.下列说法正确的是()"],
  [123, "飞行过程,下列说法正确的是（）"], // 幻影重复块（B-65 检出那种，反查不该被它骗走起点）
  [123, "A. $t_{1}=t_{2}$，且 $CF<FD$"],
  [123, "B. 在空中飞行时间与运动员离开 C 点的速度成正"],
  [123, "[图片]"],
  [123, "比"],
  [123, "C. CD 的长度与运动员离开 C 点的速度成正比"],
  [123, "D. 若运动员离开 C 点的速度大小改变，则其落在 "],
  [123, "CD 上的速度方向与 CD 的夹角也改变"],
  [123, "10.[河南漯河 2025 期末] 如图所示,质量为 0.3 "],
  [123, "kg 的滑块套在水平固定的光滑轨道上,质量"],
  [123, "为 0.2 kg 的小球(视为质点)通过长为 0.75 m "],
  [123, "的轻杆与滑块上的光滑轴 O 连接,可绕 O 点"],
  [123, "在竖直平面内自由转动.初始时滑块静止,轻"],
  [123, "杆处于水平状态.小球以 3 m/s 的竖直向下的"],
  [123, "初速度 $v_{0}$ 开始运动,g 取 10 m/s²,则()"],
  [123, "[图片]"],
  [123, "A. 小球从初始位置到第一次到达最低点的过程"],
  [123, "中,滑块向右移动了 0.30 m"],
  [123, "B. 小球第一次到达最低点时,滑块的速度大小为 "],
  [123, "2 m/s"],
  [123, "C. 小球第一次到达最低点时,轻杆对小球的拉力"],
  [123, "为 5.84 N"],
  [123, "D. 小球相对于初始位置可以上升的最大高度为 "],
  [123, "0.45 m"],
  [123, "二、非选择题：本题共5小题，共54分."],
  [123, "11.(6分)[广西柳州2025模拟]某实验小组用如图甲"],
]);

const Q533 = q(
  "2026《高考必刷题•》新高考版:p123:q533",
  123,
  "[四川 2025 适应考]如图, 原长为 $l_{0}$ 的轻弹簧\n竖直放置, ",
  8151,
  8162,
);
const Q534 = q(
  "2026《高考必刷题•》新高考版:p123:q534",
  123,
  "[广东肇庆 2025 二模]如图是简化后的跳台滑雪\n的雪道示意图,运动员从助滑雪道 AB 上由静止\n开始滑下,到达 C 点后水平飞出,落到滑道(足够\n长)上的 D 点,E 是运动轨迹上的一点,在该点运动员的速度方向与 CD 平行. 设运动员从 C 到 E 与从 E 到 D 的运动时间分别为 $t_{1}$、$t_{2}$,EF 垂直于 CD,不计空气阻力,则关于运动员离开 C 点后的飞行过程,下列说法正确的是（）",
  8163,
  8178,
);
const Q535 = q(
  "2026《高考必刷题•》新高考版:p123:q535",
  123,
  "[河南漯河 2025 期末] 如图所示,质量为 0.3 \nkg 的滑块套在水平固定的光滑轨道上,质量\n为 0.2 kg 的小球(视为质点)通过长为 0.75 m 的轻杆与滑块上的光滑轴 O 连接,可绕 O 点在竖直平面内自由转动",
  8179,
  8194,
);
const Q536 = q(
  "2026《高考必刷题•》新高考版:p123:q536",
  123,
  "(6分)[广西柳州2025模拟]某实验小组用如图甲\n所示的气垫导轨完成验证动量守恒定律的实验,",
  8196,
  8216,
);

// ── 夹具 B：书A p175-177（q744 实锤：记录 11541..11560，真实 11553..11572） ──
// g11579（q746 题头）同上为最小补块。
const BOOK_A_P176 = mkBlocks(11541, [
  [175, "12. NEW [湖北 2025·14,16分] 如图所示,两平行"],
  [175, "虚线 MN、PQ 间无磁场. MN 左侧区域和 PQ "],
  [175, "右侧区域内均有垂直于纸面向外的匀强磁场,磁"],
  [175, "感应强度大小分别为 B 和 2B. 一质量为 m、电"],
  [175, "荷量为 q 的带正电粒子从 MN 左侧 O 点以大"],
  [175, "小为 $v_{0}$ 的初速度射出,方向平行于 MN 向上. "],
  [175, "已知 O 点到 MN 的距离为 $\\frac{3mv_{0}}{2qB}$,粒子能回"],
  [175, "到 O 点,并在纸面内做周期性运动. 不计重力,求"],
  [176, "(1)粒子在 $MN$ 左侧区域中运动轨迹的半径."],
  [176, "(2)粒子第一次和第二次经过PQ时位置的间距."],
  [176, "(3)粒子的运动周期."],
  [176, "[图片]"],
  [176, "13. NEW [东北三省一区 2025·15,16 分] 如图, "],
  [176, "在 $xOy$ 平面第一、四象限内存在垂直平面向"],
  [176, "里的匀强磁场, 磁感应强度大小为 $B$. 一带正"],
  [176, "电的粒子从 $M(0,-y_{0})$ 点射入磁场, 速度方向与 "],
  [176, "$y$ 轴正方向夹角 $\\theta=30^{\\circ}$, 从 $N(0,y_{0})$ 点射出磁"],
  [176, "场. 已知粒子的电荷量为 $q(q>0)$, 质量为 $m$, 忽"],
  [176, "略粒子重力及磁场边缘效应."],
  [176, "(1)求粒子射入磁场的速度大小 $v_{1}$ 和在磁场中"],
  [176, "运动的时间 $t_{1}$."],
  [176, "(2)若在 $xOy$ 平面内某点固定一负点电荷,电荷"],
  [176, "量为 48q，粒子质量取 $m=\\frac{B^{2}y_{0}^{3}}{k}$（k 为静"],
  [176, "电力常量），粒子仍沿（1）中的轨迹从 M"],
  [176, " 点运动到 N 点，求射入磁场的速度大小 $v_{2}$"],
  [176, "."],
  [176, "(3)在(2)问条件下,粒子从N点射出磁场开始,经"],
  [176, "时间$t_{2}$速度方向首次与N点速度方向相反,求"],
  [176, "$t_{2}$()电荷量为Q的点电荷产生的电场中,取无"],
  [176, "限远处的电势为0时,与该点电荷距离为r处的"],
  [176, "电势$\\varphi=k\\frac{Q}{r}$"],
  [176, "[图片]"],
  [176, "14. NEW [河南 2025·15,17 分] 如图,水平虚线上方"],
  [176, "区域有垂直于纸面向外的匀强磁场,下方区域有竖直"],
  [176, "向上的匀强电场.质量为 $m$、带电量为 $q(q>0)$ 的粒"],
  [176, "子从磁场中的 $a$ 点以速度 $v_{0}$ 向右水平发射,当粒子"],
  [176, "进入电场时其速度沿右下方向并与水平虚线的夹角"],
  [176, "为 $60^{\\circ}$,然后粒子又射出电场重新进入磁场并通过"],
  [177, "15. NEW [浙江 2025 年 1 月·18,13 分] 同位素 "],
]);

const Q743 = q(
  "2026《高考必刷题•》新高考版:p175:q743",
  175,
  "NEW [湖北 2025·14,16分] 如图所示,两平行\n虚线 MN、PQ 间无磁场. MN 左侧区域和 PQ 右侧区域内均有垂直于纸面向外的匀强磁场",
  11529,
  11540,
);
const Q744 = q(
  "2026《高考必刷题•》新高考版:p176:q744",
  176,
  "NEW [东北三省一区 2025·15,16 分] 如图, \n在 $xOy$ 平面第一、四象限内存在垂直平面向\n里的匀强磁场, 磁感应强度大小为 $B$. 一带正电的粒子从 $M(0,-y_{0})$ 点射入磁场",
  11541,
  11560,
);
const Q745 = q(
  "2026《高考必刷题•》新高考版:p176:q745",
  176,
  "NEW [河南 2025·15,17 分] 如图,水平虚线上方\n区域有垂直于纸面向外的匀强磁场,下方区域有竖直\n向上的匀强电场",
  11561,
  11576,
);
const Q746 = q(
  "2026《高考必刷题•》新高考版:p177:q746",
  177,
  "NEW [浙江 2025 年 1 月·18,13 分] 同位素 \n${}_{6}^{14}C$ 相对含量的测量在考古学中",
  11577,
  11610,
);

test("夹具 书A p123:q534：重建首块=含 stem 首段的真实题头块（8168），端界=下一题真实题头前（8183）", () => {
  const { ranges, report } = planBlockIndexRebuilds([Q533, Q534, Q535, Q536], BOOK_A_P123);
  // q533 的真实题头不在夹具块序列里 ⇒ 反查不中，保留原值（宁保原值不猜）
  assert.equal(ranges[0], null);
  // q534：8168 = "9.[广东肇庆 2025 二模]…"（stem 首段所在块）
  assert.deepEqual(ranges[1], Array.from({ length: 16 }, (_, k) => 8168 + k));
  assert.equal(ranges[1]![0], 8168);
  assert.equal(ranges[1]![ranges[1]!.length - 1], 8183); // q535 真实题头 8184 前
  // q535：8184 = "10.[河南漯河 2025 期末]…"；q536 已定位 ⇒ 端界 = 8201 前
  assert.equal(ranges[2]![0], 8184);
  assert.equal(ranges[2]![ranges[2]!.length - 1], 8200);
  // q536 是夹具最后一题 ⇒ 无下一题锚，不猜，保留原值
  assert.equal(ranges[3], null);
  assert.equal(report.rebuilt, 2);
  assert.equal(report.kept, 2);
  assert.equal(report.keptReasons["not-found"], 1);
  assert.equal(report.keptReasons["next-unknown"], 1);
});

test("夹具 书A p123:q534：重建剔除混入的上一题选项（起点 8163→8168）", () => {
  const { ranges } = planBlockIndexRebuilds([Q533, Q534, Q535, Q536], BOOK_A_P123);
  const textOf = (idx: number[]) => idx.map((g) => BOOK_A_P123[g]!.text);
  // ⚠️ 原区间 8163..8178 仍包含自己的真实题头（滞后 = 起点提前 + 终点提前），
  // 所以 head 检验对这种形态**低估**（报告原话）——head hit 但裁图混入上一题选项。
  assert.ok(headCoverage(Q534.stem, textOf(Q534.source.blockIndexes)) >= 0.6, "head 检验对『起点提前』形态低估");
  assert.ok(headCoverage(Q534.stem, textOf(ranges[1]!)) >= 0.6);
  // 混入铁证：原区间含 q533 的选项文本（8163-8167），重建区间不含
  const origText = textOf(Q534.source.blockIndexes).join("");
  const newText = textOf(ranges[1]!).join("");
  assert.ok(origText.includes("若 X、Y 恰能分离"));
  assert.ok(!newText.includes("若 X、Y 恰能分离"));
  assert.ok(!ranges[1]!.includes(8163));
});

test("夹具 书A p176:q744：重建 = 11553..11572（与 tmp/astage-rerun/report.md 实锤一致）", () => {
  const { ranges, report } = planBlockIndexRebuilds([Q743, Q744, Q745, Q746], BOOK_A_P176);
  assert.equal(ranges[0]![0], 11541); // q743 真实题头 "12. NEW [湖北…"
  assert.equal(ranges[0]![ranges[0]!.length - 1], 11552);
  assert.equal(ranges[1]![0], 11553); // "13. NEW [东北三省一区…"
  assert.equal(ranges[1]![ranges[1]!.length - 1], 11572); // q745 真实题头 11573 前（含题图 11572）
  assert.equal(ranges[2]![0], 11573); // "14. NEW [河南…"
  assert.equal(ranges[3], null); // 最后一题保留原值
  assert.equal(report.rebuilt, 3);
  assert.equal(report.kept, 1);
  // 记录区间混入上一题的铁证：原区间文本含 q743 题头「湖北」，重建区间不含
  const origText = Q744.source.blockIndexes.map((g) => BOOK_A_P176[g]!.text).join("");
  const newText = ranges[1]!.map((g) => BOOK_A_P176[g]!.text).join("");
  assert.ok(origText.includes("湖北"));
  assert.ok(!newText.includes("湖北"));
  assert.ok(headCoverage(Q744.stem, ranges[1]!.map((g) => BOOK_A_P176[g]!.text)) >= 0.6);
});

test("反查不中 ⇒ 保留原值并计数（宁保原值不猜，绝不猜一个错区间）", () => {
  const ghost = q("x:p1:q1", 1, "[完全不存在 2025]这段文字在任何块里都找不到甲乙丙丁", 5, 8);
  const { ranges, report } = planBlockIndexRebuilds([ghost], BOOK_A_P123);
  assert.equal(ranges[0], null);
  assert.equal(report.rebuilt, 0);
  assert.equal(report.kept, 1);
  assert.equal(report.keptReasons["not-found"], 1);
  assert.deepEqual(report.keptIds, ["x:p1:q1"]);
});

test("探针过短（norm < 6，如纯符号/题号残段）⇒ no-probe 保留原值", () => {
  const short = q("x:p1:q2", 123, "12", 5, 8);
  const empty = q("x:p1:q3", 123, "（　）", 5, 8);
  const { ranges, report } = planBlockIndexRebuilds([short, empty], BOOK_A_P123);
  assert.equal(ranges[0], null);
  assert.equal(ranges[1], null);
  assert.equal(report.keptReasons["no-probe"], 2);
});

test("区间完全落在上一题的形态（head 检验能抓到的那种）：原区间 head-miss，重建后 hit", () => {
  // 滞后更重的形态：游标区间整段停在上一题里，连本题题头都不在区间内
  const blocks = mkBlocks(0, [
    [4, "0.[前题 2024]上一题的完整内容从这里开始甲乙丙丁"],
    [4, "上一题的题干续段"],
    [4, "A. 上一题的选项"],
    [4, "1.[本题 2025]本题的真实题头块在前一题全部内容之后"],
    [4, "本题的题干续段"],
    [4, "2.[下一题 2025]下一题的真实题头块"],
    [4, "下一题的题干续段"],
  ]);
  const cur = q("x:p4:q1", 4, "[本题 2025]本题的真实题头块在前一题全部内容之后\n本题的题干续段", 0, 2);
  const nxt = q("x:p4:q2", 4, "[下一题 2025]下一题的真实题头块\n下一题的题干续段", 3, 3);
  const { ranges } = planBlockIndexRebuilds([cur, nxt], blocks);
  const textOf = (idx: number[]) => idx.map((g) => blocks[g]!.text);
  assert.ok(headCoverage(cur.stem, textOf(cur.source.blockIndexes)) < 0.6, "原区间应 head-miss");
  assert.ok(headCoverage(cur.stem, textOf(ranges[0]!)) >= 0.6, "重建区间应 head-hit");
  assert.deepEqual(ranges[0], [3, 4]); // 本题区间 = 真实题头 → 下一题真实题头前
  assert.equal(ranges[1], null); // 下一题是最后一题 ⇒ 保留原值
});

test("页邻近：真实题头在 ±2 页内 ⇒ 放宽命中并计数 widened；±4 页外 ⇒ 保留原值", () => {
  // 夹具占位页 -1；构造一页 p10 的题，题头块放在 p12（radius 2 才够到）
  const far = mkBlocks(0, [
    [10, "某题的无关正文"],
    [12, "20.[远页 2025 模拟]这道题的真实题头块在两页之外"],
    [10, "p10 的另一块"],
  ]);
  // 夹具页序无序也允许：扫描按页过滤，不依赖数组页序
  const qq = q("x:p10:q20", 10, "[远页 2025 模拟]这道题的真实题头块在两页之外", 0, 2);
  const { ranges, report } = planBlockIndexRebuilds([qq], far);
  assert.equal(ranges[0], null); // 最后一题无下一题锚 ⇒ next-unknown，但定位应已发生
  assert.equal(report.starts[0], 1); // 反查定位到 g1（p12）
  assert.equal(report.widened, 1); // radius 2 命中
  assert.equal(report.keptReasons["next-unknown"], 1);
  // ±4 页外：p17 的题头（超出 10±4）
  const tooFar = mkBlocks(0, [
    [10, "某题的无关正文"],
    [17, "21.[更远 2025 模拟]这道题的真实题头块在四页之外"],
    [10, "p10 的另一块"],
  ]);
  const qq2 = q("x:p10:q21", 10, "[更远 2025 模拟]这道题的真实题头块在四页之外", 0, 2);
  const r2 = planBlockIndexRebuilds([qq2], tooFar);
  assert.equal(r2.ranges[0], null);
  assert.equal(r2.report.starts[0], null);
  assert.equal(r2.report.keptReasons["not-found"], 1);
});

test("方向守卫：同文重复（幻影块/解析引用）不会把后一题锚回同一块", () => {
  // 两道题 stem 开头相同，全书只有一块含该文本 ⇒ 第一题定位成功，第二题从上一题定位块之后扫，不中 ⇒ 保留
  const blocks = mkBlocks(0, [
    [5, "1.[重复 2025 模拟]两道题的开头一模一样的情形"],
    [5, "其余正文块"],
  ]);
  const a = q("x:p5:q1", 5, "[重复 2025 模拟]两道题的开头一模一样的情形甲", 0, 1);
  const b = q("x:p5:q2", 5, "[重复 2025 模拟]两道题的开头一模一样的情形乙", 0, 1);
  const { ranges, report } = planBlockIndexRebuilds([a, b], blocks);
  assert.equal(ranges[0], null); // a 定位成功但 b 无锚 ⇒ a 保留（next-unknown）
  assert.equal(ranges[1], null);
  assert.equal(report.starts[0], 0);
  assert.equal(report.starts[1], null);
  assert.equal(report.keptReasons["not-found"], 1);
  assert.equal(report.keptReasons["next-unknown"], 1);
});

test("stem 首段跨块：题头块只含 stem 开头几个字，连跑（RUN_K）拼接后仍能定位", () => {
  // 书B 实测形态："3. D 考查点 ▸ $a-t$ 图像、急动度" + "【解析】…" 分两块，
  // stem = "D 考查点 ▸ …【解析】…"，单块覆盖不足 0.75，连跑命中
  const blocks = mkBlocks(0, [
    [3, "3. D 考查点 ▸ $a-t$ 图像、急动度"],
    [3, "【解析】根据题意有 $k=\\frac{\\Delta a}{\\Delta t}$"],
    [3, "后续解析正文"],
  ]);
  const qq = q("x:p3:q3", 3, "D 考查点 ▸ $a-t$ 图像、急动度\n【解析】根据题意有 $k=\\frac{\\Delta a}{\\Delta t}$", 0, 1);
  const { report } = planBlockIndexRebuilds([qq], blocks);
  assert.equal(report.starts[0], 0); // 锚在题头块，不是解析块
});

test("纯函数：不改入参（questions 与 blocks 均不被修改）", () => {
  const qsBefore = JSON.parse(JSON.stringify([Q533, Q534, Q535, Q536]));
  const blocksBefore = JSON.parse(JSON.stringify(BOOK_A_P123));
  planBlockIndexRebuilds([Q533, Q534, Q535, Q536], BOOK_A_P123);
  assert.deepEqual([Q533, Q534, Q535, Q536], qsBefore);
  assert.deepEqual(BOOK_A_P123, blocksBefore);
});

test("页邻近半径序列哨兵：放宽上限为 ±4（PAGE_RADII 不被悄悄改小）", () => {
  assert.deepEqual(PAGE_RADII, [1, 2, 4]);
});

test("FlatBlock.index 与数组位置不一致 ⇒ 显式报错（口径断言，不静默错位）", () => {
  const bad: FlatBlock[] = [
    { index: 0, pageIndex: 1, text: "a" },
    { index: 5, pageIndex: 1, text: "b" }, // 位置 1 却标 index 5
  ];
  assert.throws(() => planBlockIndexRebuilds([q("x:p1:q1", 1, "某段题干文字甲乙丙丁", 0, 1)], bad), /阅读顺序全局下标/);
});
