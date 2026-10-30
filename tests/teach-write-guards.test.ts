// tests/teach-write-guards.test.ts
/**
 * 教学归类写通道守卫（第二条写路径）。
 *
 * 反向验证优先：非法 scope/doc/路径/形状必须**不落盘**；重复 id/name、重复 questionId、
 * 非法 anchor 都必须拒。合法的 topics/categories/bindings 各放行一次。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isKnownDoc,
  isTeachScope,
  MAX_BODY,
  teachFilePath,
  validateTeachPayload,
} from "../scripts/teach-write-guards.js";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "teachguards-"));
  const docDir = join(root, "data", "out", "真卷甲");
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, "stages.json"), "{}");
  return root;
}

test("scope 只认 topics / categories / bindings", () => {
  for (const s of ["topics", "categories", "bindings"]) assert.equal(isTeachScope(s), true);
  for (const s of ["library", "tags", "", "bindings ", null, 1]) assert.equal(isTeachScope(s), false);
  assert.equal(MAX_BODY, 2 * 1024 * 1024);
});

test("doc 必须是真实存在的快照目录名；路径字符一律拒", async () => {
  const root = fixtureRoot();
  assert.equal(await isKnownDoc(root, "真卷甲"), true);
  assert.equal(await isKnownDoc(root, "不存在的卷"), false);
  for (const d of ["", "../etc", "a/b", "a\\b", "..", "真卷甲/../../x", "真卷\u0000甲", "x\ny", "甲".repeat(130)]) {
    assert.equal(await isKnownDoc(root, d), false, `必须拒绝 ${JSON.stringify(d)}`);
  }
});

test("落盘目标必须仍在 data/out/teach 内", () => {
  const root = "/repo";
  assert.equal(teachFilePath(root, "topics", ""), join(root, "data", "out", "teach", "topics.json"));
  assert.equal(teachFilePath(root, "categories", ""), join(root, "data", "out", "teach", "categories.json"));
  assert.equal(teachFilePath(root, "bindings", "真卷甲"), join(root, "data", "out", "teach", "bindings", "真卷甲.json"));
  assert.equal(teachFilePath(root, "bindings", "../../../etc/passwd"), null);
  assert.equal(teachFilePath(root, "bindings", "a/../../b"), null);
});

test("topics：字段齐全、id/name 唯一才放行", () => {
  const ok = { version: 1, topics: [{ id: "tp-1", name: "平抛运动" }] };
  assert.equal(validateTeachPayload("topics", ok), null);
  assert.ok(validateTeachPayload("topics", { version: 2, topics: [] }));
  assert.ok(validateTeachPayload("topics", { version: 1, topics: {} }));
  assert.ok(validateTeachPayload("topics", { version: 1, topics: [{ id: "", name: "x" }] }));
  assert.ok(validateTeachPayload("topics", { version: 1, topics: [{ id: "tp-1", name: "" }] }));
  assert.ok(validateTeachPayload("topics", { version: 1, topics: [{ id: "tp-1", name: "A" }, { id: "tp-1", name: "B" }] }));
  assert.ok(validateTeachPayload("topics", { version: 1, topics: [{ id: "tp-1", name: "A" }, { id: "tp-2", name: " A " }] }));
  assert.ok(validateTeachPayload("topics", { version: 1, topics: [{ id: "tp-1", name: "A", createdAt: 1 }] }));
  // 错误 scope 用错 key，也必须拒
  assert.ok(validateTeachPayload("topics", { version: 1, categories: [] }));
});

test("categories：与 topics 同标准", () => {
  assert.equal(validateTeachPayload("categories", { version: 1, categories: [{ id: "ct-1", name: "基础" }] }), null);
  assert.ok(validateTeachPayload("categories", { version: 1, categories: [{ id: "ct-1", name: "基础" }, { id: "ct-2", name: "基础" }] }));
});

test("bindings：questionId 唯一、数组元素一致、anchor 合法", () => {
  const anchor = { number: "1", page: 4, section: "", firstText: "题干" };
  const ok = {
    version: 1,
    bindings: [{ questionId: "d:p0:q0", topicIds: ["tp-1"], categoryIds: ["ct-1"], anchor }],
    stale: [],
  };
  assert.equal(validateTeachPayload("bindings", ok), null);
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: "x", stale: [] }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [], stale: null }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [{ questionId: "", topicIds: [], categoryIds: [] }], stale: [] }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [{ questionId: "a", topicIds: "x", categoryIds: [] }], stale: [] }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [{ questionId: "a", topicIds: [], categoryIds: [1] }], stale: [] }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [{ questionId: "a", topicIds: ["tp-1", "tp-1"], categoryIds: [] }], stale: [] }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [{ questionId: "a", topicIds: [], categoryIds: [], anchor: [] }], stale: [] }));
  assert.ok(validateTeachPayload("bindings", { version: 1, bindings: [{ questionId: "a", topicIds: [], categoryIds: [], anchor: { page: "4" } }], stale: [] }));
  // bindings 与 stale 里同一 questionId 也不允许
  const dup = {
    version: 1,
    bindings: [{ questionId: "a", topicIds: [], categoryIds: [] }],
    stale: [{ questionId: "a", topicIds: [], categoryIds: [] }],
  };
  assert.ok(validateTeachPayload("bindings", dup));
});
