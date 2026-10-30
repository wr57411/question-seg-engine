// tests/teach-store.test.ts
/**
 * 教学归类纯逻辑：多专题/多类别、幂等开关、anchor 不被无关点击洗白、
 * 空集合删记录、同上题替换语义、最近使用排序、stale 不丢。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCombo,
  addTeachItem,
  assignmentFor,
  badgeCounts,
  comboMatches,
  emptyTeachBindings,
  filterTeach,
  moveToFront,
  normalizeCombos,
  normalizeTeachBindings,
  normalizeTeachList,
  orderByRecent,
  replaceBinding,
  removeCombo,
  renameCombo,
  restoreCombo,
  retireCombo,
  sameAsPrevious,
  splitRetired,
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

test("常用组合：名字必填且唯一、至少一个专题/类别、id 唯一", () => {
  const empty: { id: string; name: string; topicIds: string[]; categoryIds: string[] }[] = [];
  let n = 0;
  const gen = () => `cb-${++n}`;
  const a = addCombo(empty, "  曲线基础 ", ["tp-1"], ["ct-1"], gen);
  assert.equal(a.created, true);
  assert.deepEqual(a.item, { id: "cb-1", name: "曲线基础", topicIds: ["tp-1"], categoryIds: ["ct-1"] });
  assert.ok(addCombo(a.list, "曲线基础", ["tp-2"], [], gen).error, "同名必须拒");
  assert.ok(addCombo(a.list, "空组合", [], [], gen).error, "空集合必须拒");
  assert.ok(addCombo(a.list, " ", ["tp-2"], [], gen).error, "空名必须拒");
  const b = addCombo(a.list, "圆周培优", ["tp-1", "tp-1"], ["ct-2"], gen);
  assert.deepEqual(b.item?.topicIds, ["tp-1"], "id 去重");
  assert.equal(b.item?.id, "cb-2");
});

test("组合改名：按 id 换名字、成员不动；空名/重名/不存在的 id 一律拒", () => {
  const base = [
    { id: "cb-1", name: "曲线基础", topicIds: ["tp-1"], categoryIds: ["ct-1"] },
    { id: "cb-2", name: "圆周培优", topicIds: ["tp-2"], categoryIds: ["ct-2"] },
  ];
  const r = renameCombo(base, "cb-1", "  曲线·基础题  ");
  assert.equal(r.item?.name, "曲线·基础题", "trim 后入库");
  assert.deepEqual(r.item, { id: "cb-1", name: "曲线·基础题", topicIds: ["tp-1"], categoryIds: ["ct-1"] }, "成员集合不能动");
  assert.equal(r.list.length, 2);
  assert.equal(r.list[1]?.name, "圆周培优", "别的组合一个字都不改");
  assert.ok(renameCombo(base, "cb-1", "圆周培优").error, "跟别的组合重名必须拒");
  assert.ok(renameCombo(base, "cb-1", "   ").error, "空名必须拒");
  assert.ok(renameCombo(base, "cb-9", "随便").error, "id 不存在必须拒");
  assert.equal(renameCombo(base, "cb-1", "曲线基础").item?.name, "曲线基础", "改成自己的原名允许（不误报重名）");
  assert.deepEqual(renameCombo(base, "cb-1", "").list, base, "失败时清单原样返回");
});

test("组合删除：只摘掉预设本身；不存在的 id 报错不静默", () => {
  const base = [
    { id: "cb-1", name: "曲线基础", topicIds: ["tp-1"], categoryIds: ["ct-1"] },
    { id: "cb-2", name: "圆周培优", topicIds: ["tp-2"], categoryIds: ["ct-2"] },
  ];
  const r = removeCombo(base, "cb-1");
  assert.deepEqual(r.list, [base[1]!], "剩下的顺序与内容不变");
  assert.equal(r.item?.name, "曲线基础", "返回被删项，供提示与回滚");
  assert.equal(removeCombo(base, "cb-9").item, null, "删不存在的必须报");
  assert.deepEqual(removeCombo(base, "cb-9").list, base, "失败不动清单");
});

test("filterTeach：忽略首尾空格与英文大小写；空词不过滤；不动原清单", () => {
  const topics = [
    { id: "tp-1", name: "平抛运动" },
    { id: "tp-2", name: "圆周运动" },
  ];
  const categories = [
    { id: "ct-1", name: "易错" },
    { id: "ct-2", name: "基础" },
  ];
  const r = filterTeach(" 平抛 ", { topics, categories });
  assert.deepEqual(r.topics.map((t) => t.id), ["tp-1"], "专题行命中");
  assert.deepEqual(r.categories, [], "类别行没命中就是空，不拿别的凑");
  assert.equal(r.total, 1);
  const eng = filterTeach("AB", { topics: [{ id: "t1", name: "aBc混合" }], categories: [] });
  assert.equal(eng.topics.length, 1, "英文忽略大小写");
  const none = filterTeach("   ", { topics, categories });
  assert.equal(none.topics, topics, "空关键词直接复用原数组：不复制、不重排");
  assert.equal(none.total, 4);
  assert.equal(topics.length, 2, "过滤是只读的，原清单一个字都不动");
});

test("normalizeCombos：丢弃空集合/重复 id；comboMatches 判断完全一致", () => {
  const list = normalizeCombos({
    combos: [
      { id: "cb-1", name: "A", topicIds: ["tp-1"], categoryIds: ["ct-1"] },
      { id: "cb-1", name: "B", topicIds: ["tp-2"], categoryIds: [] },
      { id: "cb-2", name: "空", topicIds: [], categoryIds: [] },
    ],
  });
  assert.deepEqual(list, [{ id: "cb-1", name: "A", topicIds: ["tp-1"], categoryIds: ["ct-1"] }]);
  assert.equal(comboMatches(list[0]!, { topicIds: ["tp-1"], categoryIds: ["ct-1"] }), true);
  assert.equal(comboMatches(list[0]!, { topicIds: ["tp-1"], categoryIds: [] }), false);
});

test("撤销：replaceBinding 精确恢复/删除，不动其它题", () => {
  let s = toggleTopic(emptyTeachBindings(), "q1", "tp-1", anchor);
  s = toggleCategory(s, "q1", "ct-1", anchor);
  const saved = s.bindings.find((b) => b.questionId === "q1")!;
  s = toggleTopic(s, "q1", "tp-1", anchor); // q1 只剩类别
  s = toggleTopic(s, "q2", "tp-9", anchor); // 另一题
  s = replaceBinding(s, "q1", saved);
  assert.deepEqual(assignmentFor(s, "q1"), { topicIds: ["tp-1"], categoryIds: ["ct-1"] });
  assert.deepEqual(assignmentFor(s, "q2"), { topicIds: ["tp-9"], categoryIds: [] }, "其它题不受影响");
  s = replaceBinding(s, "q1", null);
  assert.equal(s.bindings.some((b) => b.questionId === "q1"), false);
  assert.equal(s.bindings.some((b) => b.questionId === "q2"), true);
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

/* ── 软删除（下架 / 恢复，2026-10-30 用户拍板：题上不动） ── */

test("normalize：下架标记要带出来；retired 不是 true 的脏值不认", () => {
  const list = normalizeTeachList(
    {
      topics: [
        { id: "tp-1", name: "下架了", retired: true, retiredAt: "2026-10-30T00:00:00.000Z" },
        { id: "tp-2", name: "在用" },
        { id: "tp-3", name: "脏值", retired: "yes" },
      ],
    },
    "topics",
  );
  assert.deepEqual(list, [
    { id: "tp-1", name: "下架了", retired: true, retiredAt: "2026-10-30T00:00:00.000Z" },
    { id: "tp-2", name: "在用" },
    { id: "tp-3", name: "脏值" },
  ]);
});

test("splitRetired：分成两堆且各自保序；空清单/缺字段不崩", () => {
  const items = [
    { id: "a", retired: true as const },
    { id: "b" },
    { id: "c", retired: true as const },
    { id: "d" },
  ];
  const { active, retired } = splitRetired(items);
  assert.deepEqual(active.map((x) => x.id), ["b", "d"]);
  assert.deepEqual(retired.map((x) => x.id), ["a", "c"]);
  assert.deepEqual(splitRetired([]), { active: [], retired: [] });
  assert.deepEqual(splitRetired(undefined as never), { active: [], retired: [] });
});

test("组合下架/恢复：只换标记、成员不动；重复下架与恢复没下架的都报错", () => {
  const list = [{ id: "cb-1", name: "曲线基础", topicIds: ["tp-1"], categoryIds: ["ct-1"] }];
  const off = retireCombo(list, "cb-1", "2026-10-30T02:00:00.000Z");
  assert.equal(off.error, undefined);
  assert.deepEqual(off.item, {
    id: "cb-1",
    name: "曲线基础",
    topicIds: ["tp-1"],
    categoryIds: ["ct-1"],
    retired: true,
    retiredAt: "2026-10-30T02:00:00.000Z",
  });
  assert.equal(off.list.length, 1, "下架不删条目");

  assert.match(String(retireCombo(off.list, "cb-1").error), /已经是下架状态/);
  assert.match(String(retireCombo(list, "cb-9").error), /不存在/);

  const back = restoreCombo(off.list, "cb-1");
  assert.equal(back.error, undefined);
  assert.deepEqual(back.item, { id: "cb-1", name: "曲线基础", topicIds: ["tp-1"], categoryIds: ["ct-1"] });
  assert.equal(back.item?.retired, undefined, "恢复要把 retired/retiredAt 都摘掉");
  assert.equal(back.item?.retiredAt, undefined);
  assert.match(String(restoreCombo(list, "cb-1").error), /没有下架记录/);
});

test("新建同名且那一项已下架：复活（revived）而不是建重复，且必须由调用方落盘", () => {
  const list = [
    { id: "tp-1", name: "曲线运动", retired: true as const, retiredAt: "2026-10-30T00:00:00.000Z" },
    { id: "tp-2", name: "平抛运动" },
  ];
  const r = addTeachItem(list, " 曲线运动 ", "tp", () => "tp-9");
  assert.equal(r.created, false, "不是新建");
  assert.equal(r.revived, true, "调用方据此落盘：只在 created 时写盘 ⇒ 刷新又变回下架");
  assert.deepEqual(r.item, { id: "tp-1", name: "曲线运动" });
  assert.equal(r.list.find((t) => t.id === "tp-1")?.retired, undefined);
  assert.equal(r.list.find((t) => t.id === "tp-1")?.retiredAt, undefined);
  assert.equal(r.list.length, 2, "不许因为复活多出一条");
  assert.equal(r.list.find((t) => t.id === "tp-2")?.name, "平抛运动", "别的项一个字节都不动");
});

