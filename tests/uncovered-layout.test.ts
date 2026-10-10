// uncovered-layout.test.ts —— 「解析遗漏」内容级标签落位的回归锁定。
//
// 为什么需要它（修复轮 1 发现 2）：漏识别区域多是一行文字高（~10pt），而标签高 14px
// （对比模式 PANE_W=460 下折算 ~18pt）比它高 ⇒ 直接挂左上角必然压到下一行正文。本测试
// 用**第 5 页（index 4）的真实块与区域**钉死硬不变量：任何产出的标签都不得与任何块相交。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHIP_FONT_PX,
  CHIP_H_PX,
  CHIP_PAD_PX,
  chipPlacements,
  contentLabelPlacements,
  groupContentForLabels,
  labelOverlapsBlock,
  pickChipRect,
  pickLabelRect,
} from "../stages/uncovered-layout.js";

const PAGE_W = 596;
const PAGE_H = 824;
const CANVAS_W = 460; // 对比模式单栏宽

/** 第 5 页（index 4）实测的内容级未覆盖区域（PDF 点）。 */
const CONTENT = [
  { bbox: [53.7, 254.8, 183.2, 265.4] },
  { bbox: [53.7, 204.0, 183.2, 215.0] },
  { bbox: [325.6, 351.8, 454.1, 362.3] },
  { bbox: [67.1, 279.8, 143.8, 290.3] },
  { bbox: [67.1, 228.9, 143.8, 239.5] },
  { bbox: [54.2, 192.4, 91.6, 196.8] },
];

/** 第 5 页实测的行级块 bbox（含图片块；用于「标签不得压正文」的判定）。 */
const BLOCKS = [
  [40, 74, 281, 85], [53, 93, 280, 103], [53, 111, 280, 122], [52, 129, 280, 141],
  [53, 149, 281, 159], [53, 167, 280, 178], [146, 222, 165, 245], [146, 273, 165, 297],
  [194, 201, 282, 283], [53, 304, 280, 316], [65, 321, 137, 335], [52, 341, 281, 353],
  [65, 359, 136, 372], [40, 379, 176, 389], [52, 397, 176, 408], [53, 416, 176, 427],
  [187, 377, 282, 425], [53, 433, 281, 445], [53, 453, 281, 463], [52, 471, 280, 482],
  [53, 490, 281, 500], [53, 508, 280, 520], [53, 527, 281, 537], [53, 543, 284, 558],
  [51, 563, 275, 588], [40, 596, 199, 607], [53, 614, 199, 626], [53, 633, 200, 644],
  [53, 651, 198, 663], [209, 594, 282, 658], [53, 670, 281, 682], [53, 688, 282, 700],
  [52, 707, 281, 720], [53, 725, 281, 738], [52, 744, 281, 757], [53, 762, 285, 777],
  [308, 72, 443, 86], [308, 90, 443, 105], [308, 109, 443, 124], [308, 128, 443, 142],
  [298, 149, 538, 158], [311, 167, 538, 177], [310, 186, 537, 196], [310, 204, 538, 214],
  [311, 222, 538, 232], [310, 239, 541, 254], [310, 259, 435, 270], [324, 276, 407, 289],
  [310, 296, 436, 307], [324, 315, 423, 325], [310, 333, 436, 344], [447, 256, 539, 335],
  [310, 368, 537, 381], [320, 384, 353, 403], [297, 406, 538, 417], [311, 425, 534, 435],
  [311, 443, 538, 454], [311, 462, 538, 473], [311, 480, 538, 491], [309, 498, 537, 511],
  [311, 518, 538, 528], [310, 535, 538, 547], [311, 555, 538, 565], [311, 573, 538, 583],
  [311, 590, 541, 603], [339, 611, 419, 663], [441, 608, 511, 660], [311, 671, 497, 683],
  [311, 689, 498, 702], [311, 707, 539, 720], [322, 726, 392, 738], [311, 744, 538, 757],
  [325, 763, 484, 774],
].map((bbox) => ({ bbox }));

test("labelOverlapsBlock：相交/不相交/边界相切", () => {
  const blocks = [{ bbox: [10, 10, 20, 20] }];
  assert.equal(labelOverlapsBlock([12, 12, 18, 18], blocks), true, "完全在内");
  assert.equal(labelOverlapsBlock([18, 18, 30, 30], blocks), true, "部分相交");
  assert.equal(labelOverlapsBlock([20, 10, 30, 20], blocks), false, "右边相切不算相交");
  assert.equal(labelOverlapsBlock([0, 0, 5, 5], blocks), false, "完全在外");
  assert.equal(labelOverlapsBlock([0, 0, 5, 5], undefined), false, "无块");
});

test("groupContentForLabels：同列相邻并组，跨列/远隔不并", () => {
  const groups = groupContentForLabels(CONTENT);
  assert.equal(groups.length, 2, "第 5 页应为 2 组（热狗 A/B 组 + 滑轮 C 行）");
  const sizes = groups.map((g) => g.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [1, 5]);
  // 每组内部按 y 升序
  for (const g of groups) {
    let prev = -Infinity;
    for (const r of g) {
      const y = r.bbox[1] ?? 0;
      assert.ok(y >= prev);
      prev = y;
    }
  }
  // 跨列（无 x 重叠）不并
  const cross = groupContentForLabels([
    { bbox: [10, 10, 100, 20] },
    { bbox: [300, 10, 400, 20] },
  ]);
  assert.equal(cross.length, 2);
});

test("pickLabelRect：优先取不压正文的候选位；全压则返回 null", () => {
  const w = 77.7, h = 18.1;
  // 上下都被块夹住：只有「垂直居中」位落在行间空白
  const blocks = [{ bbox: [300, 330, 440, 345] }, { bbox: [300, 368, 540, 381] }];
  const rect = pickLabelRect([325.6, 351.8, 454.1, 362.3], w, h, PAGE_W, PAGE_H, blocks);
  assert.ok(rect, "应找到候选位");
  assert.equal(labelOverlapsBlock(rect!, blocks), false, "选中的位不得压正文");
  // 四面被块包死 → null
  const wall = [{ bbox: [300, 300, 540, 360] }, { bbox: [300, 364, 540, 420] }];
  assert.equal(pickLabelRect([325.6, 351.8, 454.1, 362.3], w, h, PAGE_W, PAGE_H, wall), null);
  // 越出页外的候选被跳过（区域贴页顶时「上方」位越界）
  const top = pickLabelRect([10, 2, 200, 12], w, h, PAGE_W, PAGE_H, []);
  assert.ok(top && top[1] >= 0, "标签不得越出页顶");
});

test("contentLabelPlacements：窄区域不挂标签", () => {
  const narrow = [{ bbox: [54.2, 192.4, 91.6, 196.8] }]; // 宽 37.4pt → 对比模式 ~29px < 56
  assert.equal(contentLabelPlacements(narrow, BLOCKS, PAGE_W, PAGE_H, CANVAS_W).length, 0);
  // 同样的区域在阶段 1/3 的 CANVAS_W=760 下仍 < 56px（37.4/596*760≈47.7）
  assert.equal(contentLabelPlacements(narrow, BLOCKS, PAGE_W, PAGE_H, 760).length, 0);
});

test("contentLabelPlacements：第 5 页实测——2 个标签，均不压正文、均在页内（硬不变量）", () => {
  const placements = contentLabelPlacements(CONTENT, BLOCKS, PAGE_W, PAGE_H, CANVAS_W);
  assert.equal(placements.length, 2, "热狗组 + 滑轮组各 1 个标签");
  assert.deepEqual(
    placements.map((p) => p.count).sort((a, b) => a - b),
    [1, 5],
  );
  for (const { rect } of placements) {
    assert.equal(labelOverlapsBlock(rect, BLOCKS), false, `标签 ${rect} 压到了正文块`);
    assert.ok(rect[0] >= 0 && rect[1] >= 0 && rect[2] <= PAGE_W && rect[3] <= PAGE_H, `标签 ${rect} 越页`);
  }
});

test("contentLabelPlacements：全卷任意宽区域产出都不得压正文（跨 CANVAS_W）", () => {
  // 对每个内容区域单独当一组，扫两档画布宽，断言不变量
  for (const canvasW of [460, 760]) {
    for (const r of CONTENT) {
      const ps = contentLabelPlacements([r], BLOCKS, PAGE_W, PAGE_H, canvasW);
      for (const { rect } of ps) {
        assert.equal(labelOverlapsBlock(rect, BLOCKS), false, `canvasW=${canvasW} 标签 ${rect} 压正文`);
      }
    }
  }
});

/* ── 题号牌落位（2026-10-10 用户指出的「并排对比」页里题号牌压正文） ──
 * 旧行为：牌子直接挂题首块左上角，而块 bbox 紧贴墨迹（F1）→ 必压题首 1–3 字。
 * 下面的测试**先证明旧落位确实会压**（否则测试抓不到回归），再钉死新落位的不变量。 */
const pxPerPt = CANVAS_W / PAGE_W;
const chipW = (label: string) => {
  let em = 0;
  for (const ch of label) em += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.5;
  return (em * CHIP_FONT_PX + CHIP_PAD_PX) / pxPerPt;
};
const chipH = CHIP_H_PX / pxPerPt;


test("pickChipRect：旧落位（挂首块左上角）确实压正文——保证本测试能抓到回归", () => {
  const first: [number, number, number, number] = [40, 74, 281, 85]; // 第 5 页题 1 首块
  const w = chipW("第1题");
  assert.equal(
    labelOverlapsBlock([first[0], first[1], first[0] + w, first[1] + chipH], BLOCKS),
    true,
    "旧落位本该压到首块正文；若此处为 false，说明夹具失效、测试失去意义",
  );
});

test("pickChipRect：新落位不得压任何块、且必须在页内", () => {
  const first = [40, 74, 281, 85];
  const rect = pickChipRect(first, chipW("第1题"), chipH, PAGE_W, PAGE_H, BLOCKS);
  assert.ok(rect, "页边距/上方应能放下题号牌");
  assert.equal(labelOverlapsBlock(rect!, BLOCKS), false, `题号牌 ${rect} 压到正文`);
  assert.ok(rect![0] >= 0 && rect![1] >= 0 && rect![2] <= PAGE_W && rect![3] <= PAGE_H, `题号牌 ${rect} 越页`);
});

test("pickChipRect：四边都被占满时返回 null（宁可不挂牌，也不压正文）", () => {
  // 造一个四周被块包死的首块：上/下/左/右都放不下（只留首块自身与两条 1pt 缝）
  const solid = [
    [0, 0, 596, 99], // 上方整条
    [0, 141, 596, 824], // 下方整条
    [0, 0, 199, 824], // 左侧整条
    [301, 0, 596, 824], // 右侧整条
  ].map((bbox) => ({ bbox }));
  const first = [200, 100, 300, 140];
  assert.equal(pickChipRect(first, chipW("第1题"), chipH, PAGE_W, PAGE_H, solid), null);
});

test("chipPlacements：完整标签放不下时回退紧凑标签，仍不压正文", () => {
  // 只留左侧 40pt 边距：装不下「第1题」（需 ~60pt），但装得下紧凑「1」（需 ~34pt）
  const narrow = [
    [0, 0, 596, 390], // 上方整条（堵住「上方」候选位）
    [0, 430, 596, 824], // 下方整条
  ].map((bbox) => ({ bbox }));
  const first = [40, 400, 596, 412]; // 右端顶到页右缘 → 右侧候选位越页
  const out = chipPlacements([{ bbox: first, label: "第1题", compact: "1" }], narrow, PAGE_W, PAGE_H, CANVAS_W);
  assert.equal(out.length, 1);
  const hit = out[0];
  assert.ok(hit, "紧凑标签应能放进 30pt 边距");
  assert.equal(hit!.label, "1", "应回退到紧凑标签");
  assert.equal(labelOverlapsBlock(hit!.rect, narrow), false);
});

test("chipPlacements：bbox 为 null（无首块）时返回 null，且长度与入参一致", () => {
  const out = chipPlacements(
    [{ bbox: null, label: "第1题", compact: "1" }, { bbox: [40, 400, 281, 412], label: "第2题", compact: "2" }],
    BLOCKS,
    PAGE_W,
    PAGE_H,
    CANVAS_W,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0], null);
  assert.ok(out[1]);
});

test("chipPlacements：第 5 页真实题目首块——所有产出的题号牌都不压正文（硬不变量）", () => {
  // 第 5 页题首块（取自实测快照）：题1 [40,74]、题2 [40,379]、题3 [40,596]、题4 [297,149]、题5 [297,406]
  const firsts = [
    [40, 74, 281, 85],
    [40, 379, 176, 389],
    [40, 596, 199, 607],
    [297, 149, 538, 159],
    [297, 406, 538, 417],
  ];
  const items = firsts.map((bbox, i) => ({ bbox, label: `第${i + 1}题`, compact: String(i + 1) }));
  for (const canvasW of [460, 760]) {
    for (const hit of chipPlacements(items, BLOCKS, PAGE_W, PAGE_H, canvasW)) {
      if (!hit) continue;
      assert.equal(labelOverlapsBlock(hit.rect, BLOCKS), false, `canvasW=${canvasW} 题号牌 ${hit.rect} 压正文`);
      assert.ok(
        hit.rect[0] >= 0 && hit.rect[1] >= 0 && hit.rect[2] <= PAGE_W && hit.rect[3] <= PAGE_H,
        `canvasW=${canvasW} 题号牌 ${hit.rect} 越页`,
      );
    }
  }
});
