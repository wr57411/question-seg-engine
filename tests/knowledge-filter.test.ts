// tests/knowledge-filter.test.ts
/**
 * 成品页「按知识点筛选」的纯逻辑（final/knowledge-filter.js）。
 * 判据锁四件事：① 小节合并计数按原书顺序、未分节排最后；② 归一只动空白不改字面；
 * ③ 筛选不猜（facetId 空/对不上 ⇒ 空数组），且**不改输入数组**；
 * ④ 含句号的那几格（大题说明/题干残片，全库实测形态）不冒充知识点，且不出现
 *    「面板有这个知识点、点进去 0 题」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildKnowledgeFacets,
  facetLabel,
  facetKeyOf,
  filterByFacet,
  isKnowledgeLabel,
  knowledgeSummary,
  NO_SECTION,
  normalizeSection,
} from "../final/knowledge-filter.js";

/** @type {{ id: string, section?: string }[]} */
const QUESTIONS = [
  { id: "q1", section: "第1节 平抛运动" },
  { id: "q2", section: "第1节 平抛运动" },
  { id: "q3", section: "第2节 圆周运动" },
  { id: "q4", section: "" },
  { id: "q5" },
  { id: "q6", section: "第2节 圆周运动" },
];

test("按出现顺序合并计数，未分节排最后", () => {
  const facets = buildKnowledgeFacets(QUESTIONS);
  assert.deepEqual(facets, [
    { id: "第1节 平抛运动", label: "第1节 平抛运动", count: 2 },
    { id: "第2节 圆周运动", label: "第2节 圆周运动", count: 2 },
    { id: NO_SECTION, label: "未分节", count: 2 },
  ]);
});

test("小节归一：全角空格/换行/首尾空白，但不改字面用词", () => {
  assert.equal(normalizeSection("　第 3 节　共点力\n平衡 "), "第 3 节 共点力 平衡");
  assert.equal(normalizeSection("   "), NO_SECTION);
  assert.equal(normalizeSection(undefined), NO_SECTION);
  assert.equal(normalizeSection(null), NO_SECTION);
  // 归一只动空白：字面不同的小节不会被并成一类（宁可分开也不猜）
  const facets = buildKnowledgeFacets([{ id: "a", section: "第1节 平抛" }, { id: "b", section: "第1节 圆周" }]);
  assert.equal(facets.length, 2);
});

test("filterByFacet 保持原册顺序、不改输入、对不上就空", () => {
  const before = JSON.stringify(QUESTIONS);
  assert.deepEqual(
    filterByFacet(QUESTIONS, "第2节 圆周运动").map((q) => q.id),
    ["q3", "q6"],
  );
  assert.deepEqual(
    filterByFacet(QUESTIONS, NO_SECTION).map((q) => q.id),
    ["q4", "q5"],
  );
  assert.deepEqual(filterByFacet(QUESTIONS, "不存在的小节"), []);
  assert.deepEqual(filterByFacet(QUESTIONS, ""), []);
  assert.deepEqual(filterByFacet(QUESTIONS, null), []);
  assert.deepEqual(filterByFacet([], "第1节 平抛运动"), []);
  assert.equal(JSON.stringify(QUESTIONS), before);
});

test("whitespace-only 小节与缺字段同归未分节", () => {
  const facets = buildKnowledgeFacets([{ id: "q1", section: "  " }, { id: "q2" }]);
  assert.deepEqual(facets, [{ id: NO_SECTION, label: "未分节", count: 2 }]);
});

test("knowledgeSummary 摆出总数，facetLabel 只对未分节换名", () => {
  const s = knowledgeSummary(QUESTIONS);
  assert.equal(s.total, 6);
  assert.equal(s.facets.length, 3);
  assert.equal(facetLabel(NO_SECTION), "未分节");
  assert.equal(facetLabel("第1节 平抛运动"), "第1节 平抛运动");
  assert.deepEqual(knowledgeSummary([]), { facets: [], total: 0 });
});

test("含句号的不是知识点标题：大题说明/题干残片归未分节（实测形态）", () => {
  // 全库实测的三种误当小节形态（2026-11-24 扫描）：都含句号
  assert.equal(isKnowledgeLabel("一、选择题:本题共10小题,共46分.在每小题给出的四个选"), false);
  assert.equal(isKnowledgeLabel("二、非选择题：本题共5小题，共54分."), false);
  assert.equal(isKnowledgeLabel("一、丙第二、乙第三.若甲、乙、丙三人的"), false);
  // 真小节（含顿号、含「专题 N」）照样认
  assert.equal(isKnowledgeLabel("第3节 机械波的干涉、衍射、多普勒效应"), true);
  assert.equal(isKnowledgeLabel("专题 13 电路的动态分析、故障分析和含容电路问题"), true);
  assert.equal(isKnowledgeLabel("第 3 节 光学、热学实验"), true);
  assert.equal(isKnowledgeLabel("  "), false);
});

test("面板与筛题共用同一把尺子：误判的小节不会「有面板项、点进去 0 题」", () => {
  const questions = [
    { id: "q1", section: "第2节 匀变速直线运动的规律（1）" },
    { id: "q2", section: "一、丙第二、乙第三.若甲、乙、丙三人的" },
    { id: "q3", section: "" },
  ];
  const facets = buildKnowledgeFacets(questions);
  assert.deepEqual(facets, [
    { id: "第2节 匀变速直线运动的规律（1）", label: "第2节 匀变速直线运动的规律（1）", count: 1 },
    { id: NO_SECTION, label: "未分节", count: 2 },
  ]);
  for (const f of facets) assert.equal(filterByFacet(questions, f.id).length, f.count);
  // 用户不可能选中的那格（原始小节串）直接筛 ⇒ 0 题，而不是悄悄命中
  assert.deepEqual(filterByFacet(questions, "一、丙第二、乙第三.若甲、乙、丙三人的"), []);
  assert.equal(facetKeyOf("一、丙第二、乙第三.若甲、乙、丙三人的"), NO_SECTION);
});