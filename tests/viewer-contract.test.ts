import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("契约：真实 questions.json 可被 ViewerQuestion 消费（每字段形状校验）", () => {
  const qs = JSON.parse(
    readFileSync("data/out/23必刷题 2相互作用/questions.json", "utf8"),
  ) as unknown[];
  assert.ok(qs.length >= 80, "真实产物至少 80 题");
  for (const q of qs as Record<string, unknown>[]) {
    assert.equal(typeof q.id, "string");
    assert.equal(typeof q.number, "string");
    assert.ok(["choice", "subjective"].includes(q.type as string));
    assert.equal(typeof q.stem, "string");
    assert.ok(Array.isArray(q.options));
    assert.ok(Array.isArray(q.images));
    assert.ok(["ok", "needs_review"].includes(q.status as string));
    assert.equal(typeof q.confidence, "number");
  }
});

test("契约：图片路径是裸文件名（viewer 拼接 images/ 前缀的前提）", () => {
  const qs = JSON.parse(
    readFileSync("data/out/23必刷题 2相互作用/questions.json", "utf8"),
  ) as { images: { path: string }[] }[];
  for (const q of qs) {
    for (const img of q.images) {
      assert.ok(!img.path.includes("/"), `图片路径应为裸文件名: ${img.path}`);
    }
  }
  const imgs = new Set(
    qs.flatMap((q) => q.images.map((i) => i.path)),
  );
  assert.ok(imgs.size >= 90, "真实产物图片数 ≥ 90（v1 观测 97 张）");
});
