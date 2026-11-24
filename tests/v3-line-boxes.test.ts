// v3-line-boxes.ts 配对判据测试（用 V3 真实行框替换 OXR 合成框）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normText,
  v3BoxToPt,
  pairV3Lines,
  type V3Line,
  type SynthLine,
} from "../scripts/v3-line-boxes.ts";

const OPTS = { pagePx: [993, 1404] as [number, number], pagePt: [596, 842.4] as [number, number] };

/** 造一条 V3 行：给 pt 框，反推 norm */
const v3 = (text: string, x0: number, y0: number, x1: number, y1: number): V3Line => ({
  text,
  bbox: [x0, y0, x1, y1],
  norm: [
    x0 / OPTS.pagePt[0],
    y0 / OPTS.pagePt[1],
    x1 / OPTS.pagePt[0],
    y1 / OPTS.pagePt[1],
  ],
});

test("normText：忽略空格与全半角标点差异", () => {
  assert.equal(normText("A. 图中 三种方案"), normText("a.图中三种方案"));
});

test("v3BoxToPt：norm × 页面 pt 尺寸 = pt 框", () => {
  // 给「pt 框」[100,50,300,70]，助手会把它写成 norm=pt/pagePt ⇒ 还原后应等于原 pt 框
  const box = v3BoxToPt(v3("x", 100, 50, 300, 70), OPTS);
  assert.deepEqual(box.map((v) => Math.round(v * 10) / 10), [100, 50, 300, 70]);
});

test("v3BoxToPt：无 norm 时按像素→pt 比例换算", () => {
  const line: V3Line = { text: "x", bbox: [993, 1404, 1986, 1685], norm: [] };
  const box = v3BoxToPt(line, { pagePx: [993, 1404], pagePt: [596, 842.4] });
  assert.deepEqual(box.map((v) => Math.round(v)), [596, 842, 1192, 1011]);
});

test("pairV3Lines：完美一一对应 ⇒ 返回全部框", () => {
  const synth: SynthLine[] = [
    { text: "1. [陕西西安八校 2022 联考]", bbox: [55, 74, 290, 95] },
    { text: "化量、加速度，下列说法不正确的是", bbox: [55, 98, 290, 119] },
  ];
  const cand = [
    v3("1.[陕西西安八校2022联考]", 55, 74, 290, 95),
    v3("化量、加速度,下列说法不正确的是", 55, 98, 290, 119),
    // 干扰项：同栏另一页区域，离得远不该被选
    v3("别处一行", 55, 400, 290, 420),
  ];
  const r = pairV3Lines(synth, cand, OPTS);
  assert.ok(r);
  assert.equal(r.boxes.length, 2);
  assert.deepEqual(r.boxes[0], [55, 74, 290, 95]);
  assert.deepEqual(r.boxes[1], [55, 98, 290, 119]);
});

test("pairV3Lines：有一行配不上 ⇒ 整体返回 null（回退保真）", () => {
  const synth: SynthLine[] = [
    { text: "甲行", bbox: [55, 50, 290, 70] },
    { text: "乙行", bbox: [55, 74, 290, 95] },
  ];
  const cand = [v3("甲行", 55, 50, 290, 70)]; // 缺乙行
  assert.equal(pairV3Lines(synth, cand, OPTS), null);
});

test("pairV3Lines：垂直距离过远不算同一行（防止跨行错配）", () => {
  const synth: SynthLine[] = [{ text: "第1题题干", bbox: [55, 50, 290, 70] }];
  const cand = [v3("第1题题干", 55, 300, 290, 330)]; // 隔了很远
  assert.equal(pairV3Lines(synth, cand, OPTS), null);
});

test("pairV3Lines：文本覆盖不足 ⇒ 不换（文本是主判据，宁可回退也不误配）", () => {
  const synth: SynthLine[] = [{ text: "完全不同的两句话内容", bbox: [55, 50, 290, 70] }];
  const cand = [v3("八竿子打不着的内容", 55, 50, 290, 70)];
  assert.equal(pairV3Lines(synth, cand, OPTS), null);
});

test("pairV3Lines：标点全半角不同也算同一行（归一化生效）", () => {
  const synth: SynthLine[] = [{ text: "化量、加速度，下列说法不正确的是", bbox: [55, 98, 290, 119] }];
  const cand = [v3("化量、加速度,下列说法不正确的是", 55, 98, 290, 119)];
  assert.ok(pairV3Lines(synth, cand, OPTS));
});

test("pairV3Lines：碎框否决——V3 把一行拆成 A. 小碎框时不换（防拆碎横排）", () => {
  const synth: SynthLine[] = [{ text: "A. 图中三种方案汽车运动的位移相同", bbox: [55, 50, 290, 70] }];
  const cand = [v3("A.", 55, 50, 66, 70)]; // 极窄 + 极短
  assert.equal(pairV3Lines(synth, cand, OPTS), null);
});
