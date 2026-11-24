// @ts-check —— 本文件纳入 tsc 检查（展示层是浏览器直接加载的 .js，没有构建步骤，
// 类型写在 JSDoc 里；见 DECISIONS.md §31）。
/**
 * knowledge-filter.js —— 成品页「按知识点筛选」的纯逻辑（无 DOM，可被 tsc 检查）。
 *
 * 口径（用户 2026-11-24 反馈：希望成品页能按知识点筛选题目）：
 * · 知识点 = **题目自带的小节**（`stages.json` 里每题的 `section`，如「第2节 匀变速直线运动的
 *   规律（1）」「专题 连接体动态平衡问题」）—— 这是原书自己的知识组织，全库 15 册都有值，
 *   **不需要用户先手工归类**（手工专题 `teach/topics` 实测绑定为 0 条，拿它做筛选等于没数据）；
 * · 小节读不出（原书未分节 / 上游把题干、大题说明当成小节）的题归到「未分节」，**排在最后**，
 *   不混进任何真知识点；
 * · 筛选只**标记与列清单**，不从纸面上删题（红线：不静默丢内容）—— 本文件只算「哪些题属于
 *   这个知识点」，隐不隐藏是展示层的决定。
 *
 * 纯函数、无副作用、同输入同输出：调用方（final.js）只负责画。
 */

/** 快照里的一道题（`stages.json` 的 pages[i].questions[j]）——只声明本文件读过的字段，
 *  完整形状见 `scripts/export-stages.ts`。 */
/** @typedef {{ id: string, number?: string, section?: string }} KnowledgeQuestion */

/** 没有知识点归属的题的 facet id（常量而非空串：空串会跟「拼错的小节」撞语义） */
export const NO_SECTION = "__none__";

/** @typedef {{ id: string, label: string, count: number }} KnowledgeFacet */

/**
 * 小节标签归一：全角空格转半角、去首尾空白、压缩连续空白。
 * 归一只是让同一小节能对上（上游 OXR/MinerU 的空白不一致），**不改字面用词**。
 * @param {unknown} raw
 * @returns {string} 归一后的小节名；没有任何有效字 → `NO_SECTION`
 */
export function normalizeSection(raw) {
  const s = String(raw ?? "")
    .replace(/[\u3000\s]+/g, " ")
    .trim();
  return s || NO_SECTION;
}

/** 「未分节」的展示名（面板与结果条共用一处，别两处各写一遍）
 * @param {string} id @returns {string} */
export function facetLabel(id) {
  return id === NO_SECTION ? "未分节" : id;
}

/** 标题里不会出现的标点：句号/分号/问号/叹号（中英各一套）。
 *  小节名是原书标题；出现这些标点说明这一格装的不是标题，而是题干或大题说明。 */
const SENTENCE_PUNCT = /[。．.；;！？!?]/;

/**
 * 这一格像不像一个知识点标题（判据取最严：像标题才当知识点，否则归「未分节」）。
 * 实测依据（2026-11-24 全库扫描）：被误当小节的三种形态**都含句号**——
 * 大题说明「一、选择题:本题共10小题,共46分.在每小题给出的四个选…」（2 册 24 题）、
 * 题干残片「一、丙第二、乙第三.若甲、乙、丙三人的」（直线运动 8 题）；
 * 真小节（「第3节 机械波的干涉、衍射、多普勒效应」「专题 13 电路的动态分析…」）从不含句号。
 * 判错的代价是这些题落进「未分节」——题仍在、仍可读，只是不冒充知识点。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isKnowledgeLabel(raw) {
  const s = normalizeSection(raw);
  if (s === NO_SECTION) return false;
  return !SENTENCE_PUNCT.test(s);
}

/**
 * 一道题的小节归属键：像标题 ⇒ 用标题本身；否则（读不出/不是标题）⇒ `NO_SECTION`。
 * 建面板与筛题**必须共用这一个函数**，否则会出现「面板有这个知识点、点进去 0 题」。
 * @param {unknown} raw
 * @returns {string}
 */
export function facetKeyOf(raw) {
  const s = normalizeSection(raw);
  return isKnowledgeLabel(s) ? s : NO_SECTION;
}

/**
 * 按**题目在册中的出现顺序**（= 原书顺序）列知识点；同一小节合并计数。
 * 顺序即书的顺序，不做字典序重排 —— 用户翻的是书，不是字母表。
 * @param {KnowledgeQuestion[]} questions
 * @returns {KnowledgeFacet[]}
 */
export function buildKnowledgeFacets(questions) {
  /** @type {KnowledgeFacet[]} */
  const named = [];
  /** @type {Map<string, KnowledgeFacet>} */
  const namedById = new Map();
  let noneCount = 0;
  for (const q of questions) {
    const id = facetKeyOf(q.section);
    if (id === NO_SECTION) {
      noneCount++;
      continue;
    }
    const hit = namedById.get(id);
    if (hit) hit.count++;
    else {
      const facet = { id, label: facetLabel(id), count: 1 };
      namedById.set(id, facet);
      named.push(facet);
    }
  }
  // 未分节永远排最后：它有题不代表它是一个知识点
  if (noneCount) named.push({ id: NO_SECTION, label: facetLabel(NO_SECTION), count: noneCount });
  return named;
}

/**
 * 某个知识点下的题（保持原册顺序）。`facetId` 为空/对不上 ⇒ 空数组（不猜）。
 * 泛型是为了让调用方拿回**自己的题目类型**（快照题带更多字段，不该在这里被削）。
 * @template {KnowledgeQuestion} T
 * @param {T[]} questions
 * @param {string | null | undefined} facetId
 * @returns {T[]}
 */
export function filterByFacet(questions, facetId) {
  const id = String(facetId ?? "").trim();
  if (!id) return [];
  return questions.filter((q) => facetKeyOf(q.section) === id);
}

/** 知识点列表 + 本册总题数（面板抬头要摆出来，别让空面板看着像坏了）
 * @param {KnowledgeQuestion[]} questions
 * @returns {{ facets: KnowledgeFacet[], total: number }}
 */
export function knowledgeSummary(questions) {
  return { facets: buildKnowledgeFacets(questions), total: questions.length };
}