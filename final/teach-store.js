// @ts-check
/**
 * final/teach-store.js — 教学归类数据层（展示层自有，不 import 引擎 src/）。
 *
 * 三套独立清单（ADR-0001）：
 * - 专题 topics、类别 categories：全局清单，各自一份 JSON；
 * - 归属 bindings/<doc>.json：每题一条 {topicIds, categoryIds, anchor}；
 * - 业务标签仍走 final/tag-store.js，不在这里。
 *
 * 写路径只有 `POST /api/teach`（服务端守卫见 scripts/teach-write-guards.ts）；
 * 纯函数负责状态变换，便于单测；UI 负责串行写与失败回滚。
 */

const TEACH_ROOT = "/data/out/teach";

/**
 * @typedef {{ id: string, name: string }} TeachItem
 * @typedef {{ questionId: string, topicIds: string[], categoryIds: string[], anchor?: Record<string, unknown> }} TeachBinding
 * @typedef {{ version: 1, updatedAt: string | null, bindings: TeachBinding[], stale: TeachBinding[] }} TeachBindings
 * @typedef {{ topics: TeachItem[], categories: TeachItem[] }} TeachLibrary
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRec = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === "string" ? v : "");

/** @returns {TeachBindings} */
export const emptyTeachBindings = () => ({ version: 1, updatedAt: null, bindings: [], stale: [] });

/**
 * @param {unknown} raw
 * @param {'topics'|'categories'} key
 * @returns {TeachItem[]}
 */
export function normalizeTeachList(raw, key) {
  if (!isRec(raw) || !Array.isArray(raw[key])) return [];
  /** @type {TeachItem[]} */
  const out = [];
  const seen = new Set();
  for (const t of raw[key]) {
    if (!isRec(t)) continue;
    const id = str(t.id);
    const name = str(t.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** @param {unknown} raw @returns {TeachBindings} */
export function normalizeTeachBindings(raw) {
  if (!isRec(raw) || !Array.isArray(raw.bindings)) return emptyTeachBindings();
  /** @param {unknown[]} list @returns {TeachBinding[]} */
  const norm = (list) => {
    /** @type {TeachBinding[]} */
    const out = [];
    const seen = new Set();
    for (const b of list) {
      if (!isRec(b)) continue;
      const questionId = str(b.questionId);
      if (!questionId || seen.has(questionId)) continue;
      seen.add(questionId);
      const topicIds = Array.isArray(b.topicIds) ? b.topicIds.filter((x) => typeof x === "string") : [];
      const categoryIds = Array.isArray(b.categoryIds) ? b.categoryIds.filter((x) => typeof x === "string") : [];
      /** @type {TeachBinding} */
      const item = { questionId, topicIds, categoryIds };
      if (isRec(b.anchor)) item.anchor = b.anchor;
      out.push(item);
    }
    return out;
  };
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    bindings: norm(raw.bindings),
    stale: Array.isArray(raw.stale) ? norm(raw.stale) : [],
  };
}

/** @param {TeachBindings} state @param {string} questionId @returns {TeachBinding | null} */
export function bindingFor(state, questionId) {
  return state.bindings.find((b) => b.questionId === questionId) ?? null;
}

/** @param {TeachBindings} state @param {string} questionId @returns {{ topicIds: string[], categoryIds: string[] }} */
export function assignmentFor(state, questionId) {
  const b = bindingFor(state, questionId);
  return { topicIds: [...(b?.topicIds ?? [])], categoryIds: [...(b?.categoryIds ?? [])] };
}

/** @param {{ topicIds: string[], categoryIds: string[] }} a */
export function badgeCounts(a) {
  return { topics: a.topicIds.length, categories: a.categoryIds.length };
}

/**
 * 写入一条归属；两个集合都空时删除该条（不留空记录）。
 * 已有 bindings 的 anchor **不因加/摘一个 chip 被重写**（防漂移洗白）。
 * @param {TeachBindings} state
 * @param {string} questionId
 * @param {string} topicId
 * @param {Record<string, unknown>} [anchor]
 * @returns {TeachBindings}
 */
export function toggleTopic(state, questionId, topicId, anchor) {
  const cur = bindingFor(state, questionId);
  const topicIds = new Set(cur?.topicIds ?? []);
  if (topicIds.has(topicId)) topicIds.delete(topicId);
  else topicIds.add(topicId);
  return writeBinding(state, questionId, [...topicIds], cur?.categoryIds ?? [], cur?.anchor ?? anchor);
}

/** @param {TeachBindings} state @param {string} questionId @param {string} categoryId @param {Record<string, unknown>} [anchor] @returns {TeachBindings} */
export function toggleCategory(state, questionId, categoryId, anchor) {
  const cur = bindingFor(state, questionId);
  const categoryIds = new Set(cur?.categoryIds ?? []);
  if (categoryIds.has(categoryId)) categoryIds.delete(categoryId);
  else categoryIds.add(categoryId);
  return writeBinding(state, questionId, cur?.topicIds ?? [], [...categoryIds], cur?.anchor ?? anchor);
}

/**
 * @param {TeachBindings} state
 * @param {string} questionId
 * @param {string[]} topicIds
 * @param {string[]} categoryIds
 * @param {Record<string, unknown>} [anchor]
 * @returns {TeachBindings}
 */
function writeBinding(state, questionId, topicIds, categoryIds, anchor) {
  const rest = state.bindings.filter((b) => b.questionId !== questionId);
  if (topicIds.length || categoryIds.length) {
    /** @type {TeachBinding} */
    const next = { questionId, topicIds: [...new Set(topicIds)], categoryIds: [...new Set(categoryIds)] };
    if (anchor) next.anchor = anchor;
    rest.push(next);
  }
  return { ...state, bindings: rest };
}

/**
 * 同上题：用上一题的集合**替换**当前题（不是合并）。
 * @param {TeachBindings} state
 * @param {string} questionId
 * @param {{ topicIds: string[], categoryIds: string[] }} prev
 * @param {Record<string, unknown>} [anchor]
 * @returns {TeachBindings}
 */
export function sameAsPrevious(state, questionId, prev, anchor) {
  const cur = bindingFor(state, questionId);
  return writeBinding(state, questionId, prev.topicIds, prev.categoryIds, cur?.anchor ?? anchor);
}

/**
 * 最近使用排序：把 id 移到最前并截断。
 * @param {string[]} list
 * @param {string} id
 * @param {number} [max]
 * @returns {string[]}
 */
export function moveToFront(list, id, max = 12) {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

/** 按“最近使用”重排清单；未在最近里的保持原顺序。 */
/**
 * 新建专题/类别：去首尾空格；同名（trim 后完全一致）复用已有项，不建重复。
 * id 由调用方生成（默认时间戳+随机），守卫会再校验 id/name 唯一。
 * @param {TeachItem[]} list
 * @param {string} name
 * @param {'tp'|'ct'} prefix
 * @param {(prefix: string) => string} [idGen]
 * @returns {{ list: TeachItem[], item: TeachItem | null, created: boolean, error?: string }}
 */
export function addTeachItem(list, name, prefix, idGen) {
  const clean = String(name ?? "").trim();
  if (!clean) return { list, item: null, created: false, error: "名字不能为空" };
  const existing = list.find((t) => t.name.trim() === clean);
  if (existing) return { list, item: existing, created: false };
  const gen = idGen ?? ((p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  let id = gen(prefix);
  let guard = 0;
  while (list.some((t) => t.id === id) && guard++ < 10) id = gen(prefix);
  if (list.some((t) => t.id === id)) return { list, item: null, created: false, error: "生成 id 失败，请重试" };
  const item = { id, name: clean };
  return { list: [...list, item], item, created: true };
}

/** @param {TeachItem[]} items @param {string[]} recent @returns {TeachItem[]} */
export function orderByRecent(items, recent) {
  const rank = new Map(recent.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, key: rank.get(item.id) ?? 1000 + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

/* ── 网络 ── */

/** @param {string} url @returns {Promise<any>} */
async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** @returns {Promise<TeachLibrary>} */
export async function loadTeachLibrary() {
  const [topicsRaw, categoriesRaw] = await Promise.all([
    getJson(`${TEACH_ROOT}/topics.json`),
    getJson(`${TEACH_ROOT}/categories.json`),
  ]);
  return {
    topics: normalizeTeachList(topicsRaw, "topics"),
    categories: normalizeTeachList(categoriesRaw, "categories"),
  };
}

/** @param {string} doc @returns {Promise<TeachBindings>} */
export async function loadTeachBindings(doc) {
  return normalizeTeachBindings(await getJson(`${TEACH_ROOT}/bindings/${encodeURIComponent(doc)}.json`));
}

/**
 * 唯一写路径：POST /api/teach。失败返回 {ok:false,error}，调用方必须显示并回退。
 * @param {'topics'|'categories'|'bindings'} scope
 * @param {unknown} payload
 * @param {string} [doc]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function saveTeach(scope, payload, doc = "") {
  const qs = new URLSearchParams({ scope });
  if (doc) qs.set("doc", doc);
  try {
    const res = await fetch(`/api/teach?${qs.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = /** @type {{ok?: boolean, error?: string}} */ (await res.json().catch(() => ({})));
    if (!res.ok || out.ok === false) return { ok: false, error: out.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入请求失败：${String(e).slice(0, 120)}` };
  }
}

/** @param {string} doc @param {TeachBindings} state */
export const saveTeachBindings = (doc, state) => saveTeach("bindings", state, doc);
