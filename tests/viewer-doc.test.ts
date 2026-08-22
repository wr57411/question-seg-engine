import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DOC, resolveDoc, loadWithFallback } from "../viewer/doc-utils.js";

// ============================================================
// 展示层 doc 解析与加载容错单测 —— 直接 import viewer/doc-utils.js（纯函数、无 DOM）。
// 与 viewer/viewer.js 复用同一实现，避免"测试镜像与实现漂移"。
// ============================================================

test("resolveDoc：空/缺省返回默认", () => {
  assert.equal(resolveDoc(""), DEFAULT_DOC);
  assert.equal(resolveDoc("?doc="), DEFAULT_DOC);
  assert.equal(resolveDoc("?doc=   "), DEFAULT_DOC);
  assert.equal(resolveDoc("?doc=23必刷题"), "23必刷题");
});

test("loadWithFallback：真实 doc 正常，截断 doc 回退默认一次，默认仍失败抛错", async () => {
  let calls = 0;
  // fetcher 返回含 ok/.json() 的模拟 fetch Response
  const fetcher = async (doc: string) => {
    calls++;
    if (doc === DEFAULT_DOC) return { ok: true, json: async () => ({ qs: ["a"] }) };
    throw new Error("fetch 404");
  };
  // 截断 doc → 回退默认成功
  const r = await loadWithFallback(fetcher, "23必刷题");
  assert.deepEqual(r, { qs: ["a"] });
  assert.equal(calls, 2);
  // 默认也失败 → 抛（含"回退默认卷也失败/可能不完整"提示）
  const bad = async () => {
    throw new Error("always fail");
  };
  await assert.rejects(loadWithFallback(bad, "23必刷题"), /always fail/);
  await assert.rejects(loadWithFallback(bad, "不存在的卷"), /可能不完整/);
});
