// tests/cleanup-topic-tags.test.ts
/**
 * 一次性清理脚本（`cleanup:topic-tags`）的计划函数：
 * **业务标签一字不动**是这里最重要的不变量 —— 它写的是用户的真实数据。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { applyCleanup, planCleanup } from "../scripts/cleanup-topic-tags.js";

const NOW = "2026-10-31T00:00:00.000Z";

function writeJson(file: string, json: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`, "utf8");
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cleanup-topic-"));
  const out = join(root, "data", "out");
  writeJson(join(out, "tags", "library.json"), {
    version: 1,
    tags: [
      { id: "t-hao", name: "好题", short: "好" },
      { id: "t-jiao", name: "已校对", short: "校" },
      { id: "t-topic-ping", name: "平抛运动#基础", short: "平基" },
    ],
  });
  writeJson(join(out, "tags", "quizA.json"), {
    version: 1,
    updatedAt: "旧",
    bindings: [
      { questionId: "quizA:p0:q0", tagIds: ["t-hao", "t-topic-ping"], anchor: { page: 1 } },
      { questionId: "quizA:p0:q1", tagIds: ["t-topic-ping"], anchor: { page: 1 } },
    ],
    stale: [],
  });
  writeJson(join(out, "teach", "bindings", "quizA.json"), {
    version: 1,
    bindings: [{ questionId: "quizA:p0:q0", topicIds: ["tp-1"], categoryIds: [], anchor: { page: 1 } }],
    stale: [],
  });
  writeJson(join(out, "topics", "index.json"), { version: 2, generatedAt: NOW, topics: [], stats: {} });
  writeJson(join(out, "topics", "export-status.json"), { ok: true, at: NOW });
  return root;
}

test("计划：只删名字含 # 的标签，业务标签与其引用一个都不动", () => {
  const root = makeRoot();
  const plan = planCleanup(root, { clearTeach: false, now: NOW });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.removedTags, [{ id: "t-topic-ping", name: "平抛运动#基础" }]);
  assert.deepEqual(plan.keptTags.map((t) => t.name), ["好题", "已校对"]);
  assert.equal(plan.keptTags[0]!.refs, 1, "好题被引用 1 次，要如实数出来");

  const lib = plan.libraryPayload!.tags as { name: string }[];
  assert.deepEqual(lib.map((t) => t.name), ["好题", "已校对"], "库里的业务标签顺序也不变");

  const f = plan.tagFiles.find((x) => x.doc === "quizA")!;
  assert.deepEqual(f.removedTagIds, ["t-topic-ping"]);
  assert.equal(f.droppedBindings, 1, "只剩专题标签的那条整条删掉（空归属不留记录）");
  assert.equal(f.keptRefs, 1, "好题那条保留");
  const kept = (f.payload.bindings as { questionId: string; tagIds: string[] }[])[0]!;
  assert.deepEqual(kept, { questionId: "quizA:p0:q0", tagIds: ["t-hao"], anchor: { page: 1 } }, "只摘 tagId，anchor 等字段原样");
});

test("计划：没加 --clear-teach 就不碰 teach 归属；加了才清空", () => {
  const root = makeRoot();
  assert.deepEqual(planCleanup(root, { clearTeach: false, now: NOW }).teachFiles, []);
  const plan = planCleanup(root, { clearTeach: true, now: NOW });
  assert.equal(plan.teachFiles.length, 1);
  assert.equal(plan.teachFiles[0]!.bindings, 1);
  assert.deepEqual(plan.teachFiles[0]!.payload.bindings, []);
});

test("落盘：先备份再写，旧索引归档后删除（否则下次导出会报「专题消失」）", () => {
  const root = makeRoot();
  const plan = planCleanup(root, { clearTeach: true, now: NOW });
  const res = applyCleanup(root, plan, "2026-10-31");

  const backup = join(root, res.archive);
  assert.deepEqual(
    JSON.parse(readFileSync(join(backup, "tags", "library.json"), "utf8")).tags.map((t: { name: string }) => t.name),
    ["好题", "已校对", "平抛运动#基础"],
    "备份必须是清理前的样子（能回滚）",
  );
  assert.equal(readFileSync(join(backup, "index.json"), "utf8").length > 0, true);

  const after = JSON.parse(readFileSync(join(root, "data", "out", "tags", "library.json"), "utf8"));
  assert.deepEqual(after.tags.map((t: { name: string }) => t.name), ["好题", "已校对"]);
  assert.equal(after.updatedAt, NOW);
  assert.deepEqual(res.deleted.sort(), ["data/out/topics/export-status.json", "data/out/topics/index.json"]);
});

test("计划有问题（库形状坏）⇒ 拒绝写盘，一个字节都不动", () => {
  const root = makeRoot();
  writeJson(join(root, "data", "out", "tags", "library.json"), { version: 1, tags: "坏了" });
  const plan = planCleanup(root, { clearTeach: true, now: NOW });
  assert.ok(plan.errors.length > 0);
  assert.throws(() => applyCleanup(root, plan, "2026-10-31"), /拒绝写盘/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "data", "out", "tags", "library.json"), "utf8")),
    { version: 1, tags: "坏了" },
    "拒绝时文件必须原样",
  );
});
