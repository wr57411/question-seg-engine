// tests/teach-store.test.ts
/**
 * 教学归类纯逻辑：多专题/多类别、幂等开关、anchor 不被无关点击洗白、
 * 空集合删记录、同上题替换语义、最近使用排序、stale 不丢。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addTeachItem,
  assignmentFor,
  badgeCounts,
  emptyTeachBindings,
  moveToFront,
  normalizeTeachBindings,
  normalizeTeachList,
  orderByRecent,
  sameAsPrevious,
  toggleCategory,
  toggleTopic,
} from "../final/teach-store.js";

const anchor = { number: "1", page: 4, firstText: "题干" };

test("normalize：清单只收有 id/name 的项；bindings/stale 不丢、去重", () => {
  const list = normalizeTeachList(
    { topics: [{ id: "tp-1", name: "平抛" }, { id: "tp-1", name: "重复" }, { id: "", name: "空" }, null] },
    "topics",
  );
  assert.deepEqual(list, [{ id: "tp-1", name: "平抛" }]);

  const raw = {
    version: 1,
    bindings: [
      { questionId: "q1", topicIds: ["tp-1"], categoryIds: ["ct-1"], anchor },
      { questionId: "q1", topicIds: ["tp-2"], categoryIds: [] },
      { questionId: "", topicIds: [], categoryIds: [] },
    ],
    stale: [{ questionId: "q9", topicIds: [], categoryIds: [] }],
  };
  const b = normalizeTeachBindings(raw);
  assert.equal(b.bindings.length, 1);
  assert.deepEqual(b.bindings[0]!.topicIds, ["tp-1"]);
  assert.equal(b.stale.length, 1);
  assert.equal(b.stale[0]!.questionId, "q9");
});

test("assignmentFor / badgeCounts：无记录返回空，多项角标正确", () => {
  let s = emptyTeachBindings();
  assert.deepEqual(assignmentFor(s, "q1"), { topicIds: [], categoryIds: [] });
  s = toggleTopic(s, "q1", "tp-1", anchor);
  s = toggleTopic(s, "q1", "tp-2", anchor);
  s = toggleCategory(s, "q1", "ct-1", anchor);
  const a = assignmentFor(s, "q1");
  assert.deepEqual(badgeCounts(a), { topics: 2, categories: 1 });
});

test("开关幂等：同 id 点两次回到原状；两个集合都空时删记录", () => {
  let s = emptyTeachBindings();
  s = toggleTopic(s, "q1", "tp-1", anchor);
  s = toggleTopic(s, "q1", "tp-1", anchor);
  assert.equal(s.bindings.length, 0, "摘光后不留空记录");

  s = toggleTopic(s, "q1", "tp-1", anchor);
  s = toggleCategory(s, "q1", "ct-1", anchor);
  s = toggleTopic(s, "q1", "tp-1", anchor);
  assert.equal(s.bindings.length, 1, "还剩类别时保留记录");
  assert.deepEqual(assignmentFor(s, "q1"), { topicIds: [], categoryIds: ["ct-1"] });
});

test("已有 bindings 的 anchor 不被无关 chip 点击重写；新记录才接受新 anchor", () => {
  let s = toggleTopic(emptyTeachBindings(), "q1", "tp-1", anchor);
  const fresh = { number: "9", page: 9, firstText: "别的题" };
  s = toggleCategory(s, "q1", "ct-1", fresh);
  assert.deepEqual(s.bindings[0]!.anchor, anchor, "加类别不能把 anchor 洗成当前页");
  // 摘光再建 = 接受新 anchor
  s = toggleTopic(s, "q1", "tp-1", fresh);
  s = toggleCategory(s, "q1", "ct-1", fresh);
  assert.equal(s.bindings.length, 0);
  s = toggleTopic(s, "q1", "tp-1", fresh);
  assert.deepEqual(s.bindings[0]!.anchor, fresh);
});

test("同上题：替换而不是合并；当前题已有 anchor 保留", () => {
  let s = toggleTopic(emptyTeachBindings(), "q2", "keep", anchor);
  s = sameAsPrevious(s, "q2", { topicIds: ["tp-1"], categoryIds: ["ct-1"] }, anchor);
  assert.deepEqual(assignmentFor(s, "q2"), { topicIds: ["tp-1"], categoryIds: ["ct-1"] });
  // 再来一次，替换成另一组
  s = sameAsPrevious(s, "q2", { topicIds: ["tp-2"], categoryIds: [] }, anchor);
  assert.deepEqual(assignmentFor(s, "q2"), { topicIds: ["tp-2"], categoryIds: [] });
  // 空集合 = 清空
  s = sameAsPrevious(s, "q2", { topicIds: [], categoryIds: [] }, anchor);
  assert.equal(s.bindings.length, 0);
});

test("新建：去空格、生成唯一 id；同名复用已有项，不产生重复", () => {
  const empty: { id: string; name: string }[] = [];
  let n = 0;
  const gen = (p: string) => `${p}-${++n}`;
  const a = addTeachItem(empty, "  易错  ", "ct", gen);
  assert.equal(a.created, true);
  assert.deepEqual(a.item, { id: "ct-1", name: "易错" });
  assert.deepEqual(a.list, [{ id: "ct-1", name: "易错" }]);

  const b = addTeachItem(a.list, "易错 ", "ct", gen);
  assert.equal(b.created, false);
  assert.deepEqual(b.item, { id: "ct-1", name: "易错" });
  assert.deepEqual(b.list, a.list, "同名不新增");
  assert.equal(b.list.some((x) => x.id === "ct-2"), false, "同名不应吃掉一个新 id");

  const c = addTeachItem(a.list, "   ", "ct", gen);
  assert.equal(c.item, null);
  assert.ok(c.error);
  assert.deepEqual(c.list, a.list);
});

test("新建：id 碰撞时重试，仍碰撞则拒绝", () => {
  const list = [{ id: "tp-dup", name: "已有" }];
  let calls = 0;
  const gen = () => (calls++ < 2 ? "tp-dup" : "tp-new");
  const r = addTeachItem(list, "新专题", "tp", gen);
  assert.equal(r.created, true);
  assert.equal(r.item?.id, "tp-new");
  const bad = addTeachItem(list, "另一个", "tp", () => "tp-dup");
  assert.equal(bad.created, false);
  assert.ok(bad.error);
});

test("最近使用：移到最前、去重、截断；清单按最近重排", () => {
  assert.deepEqual(moveToFront([], "a"), ["a"]);
  assert.deepEqual(moveToFront(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(moveToFront(["a", "b", "c"], "b", 2), ["b", "a"]);
  assert.deepEqual(moveToFront(["a"], "a"), ["a"]);

  const ordered = orderByRecent(
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    ["c", "a"],
  );
  assert.deepEqual(ordered.map((x) => x.id), ["c", "a", "b"]);
});
