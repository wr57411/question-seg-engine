// tags-store.test.ts —— 标签数据层的四条不变量。
//
// 为什么需要它：标签是**用户手工劳动成果**，这一层的每个 bug 都表现为"我的标签少了/串了"，
// 而这类丢失最容易静默发生（切分一重跑，位置型 ID 漂移，绑定就凭空消失）。
// 用例锚定：
//   ① 不静默丢：对不上的绑定进 stale 原样保留，恢复后还能回到 bindings；
//   ② 幂等：同一标签点两次是"加上→摘掉"，不是"加两遍"；不产生空绑定；
//   ③ 级联删除先算准影响数（面板据此要求二次确认）；
//   ④ 预置色板：白字对比 ≥4.5、彼此与既有语义色不撞（这是"先量后定"的锁，不是装饰）。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Binding, DocTags, TagAnchor } from "../final/tag-store.js";
import {
  anchorOf,
  makeTag,
  PRESET_LIBRARY,
  reconcile,
  removeTagFromLibrary,
  tagIdsFor,
  toggleTag,
} from "../final/tag-store.js";

const anc = (number: string, page: number): TagAnchor => ({ number, page, section: "第1节", firstText: "题干首块" });

const doc = (bindings: Binding[] = [], stale: Binding[] = []): DocTags => ({ version: 1, updatedAt: null, bindings, stale });

/* ── ① 漂移：进 stale 不删，回来还能接上 ── */

test("切分重跑后对不上的绑定进 stale，数据与锚点原样保留", () => {
  const s = doc([{ questionId: "d:p0:q0", tagIds: ["t-hao"], anchor: anc("1", 1) }]);
  const r = reconcile(s, new Set(["d:p0:q1"])); // 该题现在落在 q1
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.bindings, []);
  assert.equal(r.state.stale.length, 1);
  assert.deepEqual(r.state.stale[0]!.tagIds, ["t-hao"]);
  assert.equal(r.state.stale[0]!.anchor!.number, "1");
  assert.ok(r.state.stale[0]!.driftedAt, "漂移要留时间戳，便于核对是哪一次重跑");
});

test("重新导出把 ID 变回来时，stale 自动接回 bindings（不要求用户重打）", () => {
  const drifted = doc([], [{ questionId: "d:p0:q0", tagIds: ["t-hao"], anchor: anc("1", 1) }]);
  const r = reconcile(drifted, new Set(["d:p0:q0"]));
  assert.equal(r.state.bindings.length, 1);
  assert.equal(r.state.stale.length, 0);
});

test("对得上的绑定一个字节都不动（不顺手加时间戳、不换对象形状）", () => {
  const b = { questionId: "d:p0:q0", tagIds: ["t-hao"], anchor: anc("1", 1) };
  const r = reconcile(doc([b], []), new Set(["d:p0:q0"]));
  assert.equal(r.changed, false);
  assert.deepEqual(r.state.bindings, [b]);
  assert.equal("driftedAt" in (r.state.bindings[0] as object), false);
});

/* ── ② 幂等与形状 ── */

test("同一标签点两次 = 加上再摘掉；不产生空绑定", () => {
  let s = doc();
  s = toggleTag(s, "q1", "t-hao", undefined);
  assert.deepEqual(tagIdsFor(s, "q1"), ["t-hao"]);
  s = toggleTag(s, "q1", "t-hao", undefined);
  assert.deepEqual(tagIdsFor(s, "q1"), []);
  assert.equal(s.bindings.length, 0, "摘干净后不留空绑定记录");
  // 多标签：摘掉其中一个，另一个还在
  s = toggleTag(s, "q1", "t-hao");
  s = toggleTag(s, "q1", "t-gai");
  s = toggleTag(s, "q1", "t-hao");
  assert.deepEqual(tagIdsFor(s, "q1"), ["t-gai"]);
});

/* ── ③ 级联删除 ── */

test("从库里删标签：剥掉所有绑定里的该 id，并如实报影响题数（含 stale）", () => {
  const s = doc(
    [
      { questionId: "a", tagIds: ["t-hao", "t-gai"] },
      { questionId: "b", tagIds: ["t-hao"] },
      { questionId: "c", tagIds: ["t-jiao"] },
    ],
    [
      { questionId: "z", tagIds: ["t-hao"] },
      { questionId: "w", tagIds: ["t-hao", "t-jiao"] },
    ],
  );
  const { library, state, affected } = removeTagFromLibrary({ version: 1, tags: PRESET_LIBRARY }, s, "t-hao");
  assert.equal(affected, 4, "2 条活绑定 + 2 条 stale（面板据此要求二次确认，少报就是骗用户）");
  assert.equal(library.tags.some((t: any) => t.id === "t-hao"), false);
  assert.deepEqual(tagIdsFor(state, "a"), ["t-gai"]);
  assert.equal(tagIdsFor(state, "b").length, 0, "只剩该标签的绑定应被清掉");
  assert.deepEqual(tagIdsFor(state, "c"), ["t-jiao"], "无关绑定不受影响");
  // stale 与活绑定同一口径：剥掉该 id，空了的整条移除，还有别的标签的留在原处
  assert.equal(state.stale.length, 1);
  assert.equal(state.stale[0]!.questionId, "w");
  assert.deepEqual(state.stale[0]!.tagIds, ["t-jiao"]);
});

/* ── ④ 预置库与色板 ── */

const relLum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrastWhite = (hex: string) => 1.05 / (relLum(hex) + 0.05); // 白字：L白=1.0

test("预置 5 个标签：id 唯一、短码 1–2 字、白字对比 ≥4.5", () => {
  assert.equal(PRESET_LIBRARY.length, 5);
  assert.equal(new Set(PRESET_LIBRARY.map((t) => t.id)).size, 5);
  assert.equal(new Set(PRESET_LIBRARY.map((t) => t.color)).size, 5);
  for (const t of PRESET_LIBRARY) {
    assert.ok([...t.short].length >= 1 && [...t.short].length <= 2, `${t.name} 短码必须 1–2 字`);
    assert.ok(contrastWhite(t.color) >= 4.5, `${t.name} ${t.color} 白字对比仅 ${contrastWhite(t.color).toFixed(2)}`);
  }
});

test("预置色板不得与既有语义色同色（洋红=解析遗漏 青绿=OCR 石青=选择 朱砂=需校对）", () => {
  const taken = new Set(["#d81b60", "#4d7c5f", "#3a6b8a", "#b3432b"]);
  for (const t of PRESET_LIBRARY) assert.equal(taken.has(t.color.toLowerCase()), false, `${t.name} 撞了既有语义色`);
});

/* ── 锚点与新标签 ── */

test("anchor 只截 16 字（文件要能整份读写，不能塞进整段题干）", () => {
  const q = { number: "7", section: "第1节", blocks: [3] };
  const p = { index: 2, blocks: [{ text: "x".repeat(40) }] };
  const a = anchorOf(q, p, p.blocks[3 - 3]);
  assert.equal(a.page, 3);
  assert.equal(a.number, "7");
  assert.equal(a.firstText.length, 16);
});

test("新建标签：去空白、截 20 字、短码取前 2 字；空名不建", () => {
  const t = makeTag("  力学综合题精选  ")!;
  assert.equal(t.name, "力学综合题精选");
  assert.equal(t.short, "力学");
  assert.equal(makeTag("   "), null);
  assert.equal(makeTag("名".repeat(30))!.name.length, 20);
});
