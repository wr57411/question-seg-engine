import assert from "node:assert/strict";
import { test } from "node:test";

// ============================================================
// 展示层适配逻辑单测 —— 把 viewer/docs/CONTRACT.md 的契约规则固化为可回归断言。
// 与 viewer/viewer.js 相同逻辑的纯函数镜像（测试隔离；viewer 是浏览器代码不进 node test runner）。
// ============================================================

// 适配②：图片路径拼接 images/ 前缀（contract：questions[].images[].path 为裸文件名）
function imageSrc(paths: { path: string }[], base: string): string[] {
  return (paths || []).map((i) => `${base}/images/${encodeURIComponent(i.path)}`);
}

// 适配①：answer 形如 "B\n解析：…" → 拆成 { value, solution? }
function splitAnswer(answer?: string): { value: string; solution?: string } {
  if (!answer) return { value: "—" };
  const idx = answer.indexOf("解析：");
  return idx > 0
    ? { value: answer.slice(0, idx).trim(), solution: answer.slice(idx).trim() }
    : { value: answer };
}

test("splitAnswer：真实现状（B\\n解析：…）拆为值+解析", () => {
  const r = splitAnswer("B\n解析：由 f(1)=2 得 f(2)=4。");
  assert.equal(r.value, "B");
  assert.equal(r.solution, "解析：由 f(1)=2 得 f(2)=4。");
});

test("splitAnswer：无解析纯答案 / 空答案", () => {
  assert.deepEqual(splitAnswer("AC"), { value: "AC" });
  assert.deepEqual(splitAnswer(undefined), { value: "—" });
});

test("splitAnswer：解析前文本去首尾空白（与 viewer.js .trim() 一致）", () => {
  const r = splitAnswer("  B\n解析：xyz");
  assert.equal(r.value, "B");
  assert.equal(r.solution, "解析：xyz");
});

test("留白常量：choice 0 / subjective 378（A4 10cm）", () => {
  const pad = { choice: 0, subjective: 378 }; // 与 viewer.css --pad-* 同步
  assert.equal(pad.choice, 0);
  assert.equal(pad.subjective, Math.round(1123 * (100 / 297)));
});

test("imageSrc：裸文件名拼接 images/ 前缀（contract 适配②）", () => {
  const base = "../data/out/23必刷题 2相互作用";
  const imgs = imageSrc([{ path: "p1_img1.png" }, { path: "p2_img2.jpg" }], base);
  assert.deepEqual(imgs, [
    "../data/out/23必刷题 2相互作用/images/p1_img1.png",
    "../data/out/23必刷题 2相互作用/images/p2_img2.jpg",
  ]);
  // 中文/特殊字符路径要 encodeURIComponent
  const cn = imageSrc([{ path: "图片 2.png" }], base);
  assert.equal(cn[0], `${base}/images/${encodeURIComponent("图片 2.png")}`);
  // 空数组 → 空
  assert.deepEqual(imageSrc([], base), []);
});
