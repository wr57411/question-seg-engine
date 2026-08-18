/**
 * mineru-unpack.test.ts —— 结果 Zip 解包 + 真实 content_list 回归。
 *
 * 覆盖：
 * 1. unpackResult 从合成 Zip 提取 content_list / markdown / images；
 * 2. 真实 v1 扁平 content_list（data/smoke/content_list.json 拷贝）走完整切分管线，
 *    无异常且切出题目（要求断言有意义：questions.length >= 1）。
 * 运行：node --import tsx --test "tests/mineru-unpack.test.ts"
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { unpackResult } from "../src/mineru/unpack.js";

test("unpackResult：提取 content_list / markdown / 图片", () => {
  const zip = new AdmZip();
  zip.addFile("doc/content_list.json", Buffer.from(`{"pdf_info":[],"images":[]}`));
  zip.addFile("doc/full.md", Buffer.from("# demo"));
  zip.addFile("doc/images/img1.png", Buffer.from("fake-png"));
  const out = unpackResult(zip.toBuffer());
  assert.deepEqual((out.contentList as { images: unknown[] }).images, []);
  assert.equal(out.markdown, "# demo");
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0]!.path, "doc/images/img1.png");
});

test("unpackResult：真实 content_list 样本可被切分管线消费（无异常且切出题目）", async () => {
  const { segmentRealContentList } = await import("../src/index.js");
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/real-content-list.sample.json", import.meta.url), "utf8"),
  ) as unknown;
  const r = segmentRealContentList(raw, "real-sample");
  assert.ok(Array.isArray(r.questions));
  assert.ok("stats" in r);
  assert.ok(r.questions.length >= 1, `真实样本应切出题目，实际 ${r.questions.length}`);
  assert.ok(r.stats.totalBlocks > 0, "归一化后应有可处理块");
});