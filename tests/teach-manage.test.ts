// tests/teach-manage.test.ts
/**
 * 专题/类别「改名 / 删除」的服务端计划：跨所有卷级联、只写动过的文件、
 * 保留不认识的字段、任何不成立的情况一个文件都不许写。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { countTeachUsage, planTeachManage, validateManageRequest } from "../scripts/teach-manage.js";
import type { ManagePlan } from "../scripts/teach-manage.js";

/** 失败计划的人话原因（成功计划没有 error，测试里宁可写清楚也不硬取字段）。 */
const msg = (plan: ManagePlan) => (plan.ok ? "" : plan.error);

const NOW = "2026-10-30T09:00:00.000Z";

const topicsFile = {
  version: 1,
  updatedAt: "旧时间",
  topics: [
    { id: "tp-1", name: "曲线运动", createdAt: "留着这个字段" },
    { id: "tp-2", name: "平抛运动" },
  ],
};
const catsFile = {
  version: 1,
  updatedAt: "旧时间",
  categories: [
    { id: "ct-1", name: "基础" },
    { id: "ct-2", name: "易错" },
  ],
};
const bindingsA = {
  version: 1,
  updatedAt: "旧时间",
  bindings: [
    { questionId: "a:q0", topicIds: ["tp-1"], categoryIds: ["ct-1", "ct-2"], anchor: { page: 1 }, 备注: "别洗掉" },
    { questionId: "a:q1", topicIds: ["tp-2"], categoryIds: ["ct-2"] },
  ],
  stale: [{ questionId: "a:gone", topicIds: ["tp-1"], categoryIds: [], driftedAt: "x" }],
};
const bindingsB = {
  version: 1,
  updatedAt: "旧时间",
  bindings: [{ questionId: "b:q0", topicIds: ["tp-1"], categoryIds: ["ct-2"] }],
  stale: [],
};
const combosFile = {
  version: 1,
  updatedAt: "旧时间",
  combos: [
    { id: "cb-1", name: "曲线基础", topicIds: ["tp-1"], categoryIds: ["ct-1"] },
    { id: "cb-2", name: "只含待删项", topicIds: ["tp-1"], categoryIds: [] },
    { id: "cb-3", name: "无关", topicIds: ["tp-2"], categoryIds: ["ct-2"] },
  ],
};

const baseInput = {
  list: topicsFile,
  combos: combosFile,
  bindings: [
    { doc: "A", raw: bindingsA },
    { doc: "B", raw: bindingsB },
  ],
  now: NOW,
};

test("validateManageRequest：只认 rename/delete + topics/categories，id/名字有界", () => {
  assert.equal(validateManageRequest({ action: "rename", kind: "topics", id: "tp-1", name: "新名" }), null);
  assert.ok(validateManageRequest({ action: "drop", kind: "topics", id: "tp-1" }));
  assert.ok(validateManageRequest({ action: "delete", kind: "tags", id: "tp-1" }), "业务标签不在这条通道里");
  assert.ok(validateManageRequest({ action: "delete", kind: "topics", id: "" }));
  assert.ok(validateManageRequest({ action: "delete", kind: "topics", id: "../x" }));
  assert.ok(validateManageRequest({ action: "rename", kind: "topics", id: "tp-1" }), "改名必须给名字");
  assert.ok(validateManageRequest({ action: "rename", kind: "topics", id: "tp-1", name: "   " }));
  assert.ok(validateManageRequest({ action: "rename", kind: "topics", id: "tp-1", name: "x".repeat(80) }));
  assert.ok(validateManageRequest("not-an-object"));
});

test("改名：只写清单，一题归属都不动；未知字段保留", () => {
  const plan = planTeachManage({ ...baseInput, action: "rename", kind: "topics", id: "tp-1", name: "  曲线运动·上  " });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.itemName, "曲线运动·上");
  assert.deepEqual(plan.bindingsFiles, [], "改名不能碰任何一卷 bindings");
  assert.equal(plan.combosPayload, null, "改名按 id 走，组合不用改");
  assert.deepEqual(
    (plan.listPayload.topics as { id: string; name: string; createdAt?: string }[]).map((t) => [t.id, t.name]),
    [
      ["tp-1", "曲线运动·上"],
      ["tp-2", "平抛运动"],
    ],
  );
  assert.equal(
    (plan.listPayload.topics as { createdAt?: string }[])[0]?.createdAt,
    "留着这个字段",
    "未知字段必须原样带过去",
  );
  assert.equal(plan.listPayload.updatedAt, NOW);
  assert.equal(plan.affected, 2, "a:q0 + b:q0 两题活着的在用");
  assert.equal(plan.staleAffected, 1);
});

test("改名撞名 / 空名 / 不存在的 id：整体拒绝，不给半截计划", () => {
  assert.match(msg(planTeachManage({ ...baseInput, action: "rename", kind: "topics", id: "tp-1", name: "平抛运动" })), /已有同名/);
  assert.match(msg(planTeachManage({ ...baseInput, action: "rename", kind: "topics", id: "tp-1", name: "  " })), /不能为空/);
  assert.match(msg(planTeachManage({ ...baseInput, action: "rename", kind: "topics", id: "tp-9", name: "新" })), /不存在/);
  assert.match(msg(planTeachManage({ ...baseInput, list: { version: 1 }, action: "rename", kind: "topics", id: "tp-1", name: "新" })), /不存在/);
  assert.match(
    msg(planTeachManage({ ...baseInput, list: { version: 1, topics: "坏了" }, action: "rename", kind: "topics", id: "tp-1", name: "新" })),
    /形状不对/,
  );
});

test("删除专题：跨所有卷摘引用、空归属整条删、组合跟着清", () => {
  const plan = planTeachManage({ ...baseInput, action: "delete", kind: "topics", id: "tp-1" });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.itemName, "曲线运动");
  assert.deepEqual((plan.listPayload.topics as { id: string }[]).map((t) => t.id), ["tp-2"]);
  assert.equal(plan.affected, 2, "a:q0 + b:q0 两题活着的在用");
  assert.equal(plan.staleAffected, 1, "a:gone 漂移那条也要算，不能假装不存在");
  assert.deepEqual(plan.bindingsFiles.map((b) => b.doc), ["A", "B"], "只写真的动过的卷");

  const a = plan.bindingsFiles.find((b) => b.doc === "A")!.payload;
  const aBindings = a.bindings as { questionId: string; topicIds: string[]; categoryIds: string[] }[];
  assert.deepEqual(aBindings[0], {
    questionId: "a:q0",
    topicIds: [],
    categoryIds: ["ct-1", "ct-2"],
    anchor: { page: 1 },
    备注: "别洗掉",
  } as never, "还有类别就保留整条，anchor 与未知字段都不动");
  assert.deepEqual(a.stale, [], "漂移条目只剩被删专题 → 整条删掉，不留在文件里当幽灵");
  assert.equal(a.updatedAt, NOW);

  const b = plan.bindingsFiles.find((b) => b.doc === "B")!.payload;
  assert.deepEqual(b.bindings, [{ questionId: "b:q0", topicIds: [], categoryIds: ["ct-2"] }] as never, "专题空了但还挂着类别 → 整条留着，只摘这一项");

  assert.equal(plan.combosChanged, 2);
  assert.equal(plan.combosDropped, 1, "只剩被删专题的组合必须一起删掉");
  const combos = (plan.combosPayload!.combos as { id: string; topicIds: string[] }[]).map((c) => [c.id, c.topicIds]);
  assert.deepEqual(combos, [
    ["cb-1", []],
    ["cb-3", ["tp-2"]],
  ]);
});

test("删除类别：没引用这一项的卷一个字节都不写", () => {
  const plan = planTeachManage({ ...baseInput, list: catsFile, action: "delete", kind: "categories", id: "ct-1" });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.affected, 1);
  assert.deepEqual(plan.bindingsFiles.map((b) => b.doc), ["A"], "B 卷没用到 ct-1，不该被重写");
  assert.deepEqual(
    (plan.bindingsFiles[0]!.payload.bindings as { questionId: string; categoryIds: string[] }[]).map((x) => x.categoryIds),
    [["ct-2"], ["ct-2"]],
  );
  assert.equal(plan.combosChanged, 1, "cb-1 里的类别被摘掉");
  assert.equal(plan.combosDropped, 0, "cb-1 还有专题，留着");
});

test("删除最后一项归属后不留空记录；组合全空才删", () => {
  const plan = planTeachManage({
    list: catsFile,
    combos: { version: 1, combos: [{ id: "cb-9", name: "只有它", topicIds: [], categoryIds: ["ct-1"] }] },
    bindings: [{ doc: "C", raw: { version: 1, bindings: [{ questionId: "c:q0", topicIds: [], categoryIds: ["ct-1"] }], stale: [] } }],
    action: "delete",
    kind: "categories",
    id: "ct-1",
    now: NOW,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual((plan.bindingsFiles[0]!.payload.bindings as unknown[]), [], "空归属整条删除");
  assert.equal(plan.combosDropped, 1);
  assert.deepEqual(plan.combosPayload!.combos, []);
});

test("countTeachUsage：跨卷累计活题与漂移，各清单分开", () => {
  const usage = countTeachUsage({
    bindings: [
      { doc: "A", raw: bindingsA },
      { doc: "B", raw: bindingsB },
    ],
  });
  assert.deepEqual(usage.topics["tp-1"], { live: 2, stale: 1 });
  assert.deepEqual(usage.topics["tp-2"], { live: 1, stale: 0 });
  assert.deepEqual(usage.categories["ct-1"], { live: 1, stale: 0 });
  assert.deepEqual(usage.categories["ct-2"], { live: 3, stale: 0 }, "a:q0 + a:q1 + b:q0 都挂了易错");
  assert.equal(usage.topics["tp-none"], undefined, "没人用过的不编数字");
});

test("坏输入不崩：bindings 里混进非对象/缺字段时按原样留着", () => {
  const plan = planTeachManage({
    list: topicsFile,
    combos: null,
    bindings: [
      { doc: "D", raw: { version: 1, bindings: [null, { questionId: "d:q0" }, { questionId: "d:q1", topicIds: ["tp-1"], categoryIds: [] }], stale: [] } },
    ],
    action: "delete",
    kind: "topics",
    id: "tp-1",
    now: NOW,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const list = plan.bindingsFiles[0]!.payload.bindings as unknown[];
  assert.equal(list.length, 2, "缺 topicIds 的那条原样保留，不猜、不删");
  assert.equal(list[0], null);
});
