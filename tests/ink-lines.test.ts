// ink-lines.test.ts —— 锁住「洞内按墨迹投影切行」：3 条墨带 ⇒ 3 行；窄缝合并。
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitInkLines } from "../scripts/ink-lines.js";

function makeImg(w: number, h: number, bands: [number, number][]): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(w * h).fill(255);
  for (const [y0, y1] of bands)
    for (let y = y0; y <= y1; y++) for (let x = 10; x < w - 10; x++) data[y * w + x] = 0;
  return { width: w, height: h, data };
}

test("splitInkLines：三条墨带 ⇒ 三行，且行 y 范围对得上", () => {
  const img = makeImg(200, 200, [[20, 30], [50, 60], [80, 90]]);
  const lines = splitInkLines(img, 200, 200, [0, 0, 200, 200]);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.py0, 20);
  assert.equal(lines[0]!.py1, 30);
  assert.equal(lines[2]!.py0, 80);
});

test("splitInkLines：间距小于 minGapPx 的两条带会合并（治上下标/分式横线）", () => {
  const img = makeImg(200, 200, [[20, 30], [33, 40]]); // 中间只隔 2 行白
  const merged = splitInkLines(img, 200, 200, [0, 0, 200, 200]);
  assert.equal(merged.length, 1);
  const separated = splitInkLines(img, 200, 200, [0, 0, 200, 200], { threshold: 200, minInkPx: 1, minGapPx: 1 });
  assert.equal(separated.length, 2);
});

test("splitInkLines：空白区域切出 0 行（不产生幽灵行）", () => {
  const img = makeImg(200, 200, []);
  assert.equal(splitInkLines(img, 200, 200, [0, 0, 200, 200]).length, 0);
});

test("splitTextAmongHoles：一行被 3 个洞碎片共用时，按洞宽切字、不重不漏", async () => {
  const { splitTextAmongHoles } = await import("../scripts/ocr-fill-jobs.js");
  const parts = splitTextAmongHoles("一二三四五六", [
    { holeKey: "h1", width: 3 },
    { holeKey: "h2", width: 1 },
    { holeKey: "h3", width: 2 },
  ]);
  assert.equal(parts.map((p) => p.text).join(""), "一二三四五六");
  assert.equal(parts.length, 3);
  assert.equal(parts[0]!.text.length, 3);
  assert.equal(parts[1]!.text.length, 1);
});

test("splitTextAmongHoles：单个洞拿走整行；空行不产候选", async () => {
  const { splitTextAmongHoles } = await import("../scripts/ocr-fill-jobs.js");
  assert.deepEqual(splitTextAmongHoles("甲乙", [{ holeKey: "h1", width: 5 }]), [{ holeKey: "h1", text: "甲乙" }]);
  assert.deepEqual(splitTextAmongHoles("甲乙", []), []);
});

test("splitTextAmongHoles：切点**跟着几何走**，词被劈开也照劈（用户口径）", async () => {
  const { splitTextAmongHoles } = await import("../scripts/ocr-fill-jobs.js");
  const text = "甲乙丙丁戊己庚辛";
  // 显式传 snap:false —— 不依赖默认值语义（2026-11-03 用户纠正后默认已是 false，
  // 但测试若跟着默认走，将来谁翻默认都会悄悄改掉这条断言的含义）
  const parts = splitTextAmongHoles(text, [{ holeKey: "h1", width: 2 }, { holeKey: "h2", width: 1 }], { snap: false });
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.equal(parts[0]!.text, "甲乙丙丁戊"); // 8×2/3=5.33 ⇒ 取 5，按几何切，不找标点
});

test("splitTextAmongHoles：snap:true 时才吸到标点边界（默认 false，历史口径见上）", async () => {
  const { splitTextAmongHoles } = await import("../scripts/ocr-fill-jobs.js");
  const text = "甲乙丙丁，戊己庚辛";
  // ⚠️ 历史注记（2026-11-05）：`9926ac3` 引入 snap 时默认 `opts = {}`（不吸附）；
  // `ae8199a` 收口改默认 `{ snap: false }` —— 支线已与用户定案「切点跟着几何走」（见上一条测试），
  // 两侧各自动手时也各自把断言改成了显式传参（主分支 a739daf / 支线 640cb3f）。
  // 断言锁「吸附开/关」两种行为本身，不锁默认值。
  const snapped = splitTextAmongHoles(
    text,
    [{ holeKey: "h1", width: 2 }, { holeKey: "h2", width: 1 }],
    { snap: true },
  );
  assert.equal(snapped.map((p) => p.text).join(""), text);
  assert.equal(snapped[0]!.text, "甲乙丙丁，"); // 2:1 的原始切点在 6，吸到逗号之后
});

test("splitTextAmongHoles：洞比字多 ⇒ 不产空片，整行归最宽的洞", async () => {
  const { splitTextAmongHoles } = await import("../scripts/ocr-fill-jobs.js");
  const parts = splitTextAmongHoles("甲", [
    { holeKey: "h1", width: 1 },
    { holeKey: "h2", width: 5 },
    { holeKey: "h3", width: 2 },
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.holeKey, "h2");
  assert.equal(parts[0]!.text, "甲");
});
