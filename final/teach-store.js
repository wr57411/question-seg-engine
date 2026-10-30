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
 * @typedef {{ id: string, name: string, topicIds: string[], categoryIds: string[] }} TeachCombo
 * @typedef {{ topics: TeachItem[], categories: TeachItem[], combos: TeachCombo[] }} TeachLibrary
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
 * 用给定 binding 精确替换某题（含 anchor），用于撤销；binding=null 或空集合则删除该题。
 * @param {TeachBindings} state
 * @param {string} questionId
 * @param {TeachBinding | null} binding
 * @returns {TeachBindings}
 */
export function replaceBinding(state, questionId, binding) {
  const rest = state.bindings.filter((b) => b.questionId !== questionId);
  if (binding && (binding.topicIds.length || binding.categoryIds.length)) {
    /** @type {TeachBinding} */
    const next = {
      questionId,
      topicIds: [...new Set(binding.topicIds)],
      categoryIds: [...new Set(binding.categoryIds)],
    };
    if (binding.anchor) next.anchor = binding.anchor;
    rest.push(next);
  }
  return { ...state, bindings: rest };
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

/** @param {unknown} raw @returns {TeachCombo[]} */
export function normalizeCombos(raw) {
  if (!isRec(raw) || !Array.isArray(raw.combos)) return [];
  /** @type {TeachCombo[]} */
  const out = [];
  const seen = new Set();
  for (const c of raw.combos) {
    if (!isRec(c)) continue;
    const id = str(c.id);
    const name = str(c.name).trim();
    if (!id || !name || seen.has(id)) continue;
    const topicIds = Array.isArray(c.topicIds) ? c.topicIds.filter((x) => typeof x === "string") : [];
    const categoryIds = Array.isArray(c.categoryIds) ? c.categoryIds.filter((x) => typeof x === "string") : [];
    if (!topicIds.length && !categoryIds.length) continue;
    seen.add(id);
    out.push({ id, name, topicIds, categoryIds });
  }
  return out;
}

/**
 * 新建常用组合：名字必须自己起、trim 后唯一；至少含 1 个专题或类别。
 * @param {TeachCombo[]} list
 * @param {string} name
 * @param {string[]} topicIds
 * @param {string[]} categoryIds
 * @param {(prefix: string) => string} [idGen]
 * @returns {{ list: TeachCombo[], item: TeachCombo | null, created: boolean, error?: string }}
 */
export function addCombo(list, name, topicIds, categoryIds, idGen) {
  const clean = String(name ?? "").trim();
  if (!clean) return { list, item: null, created: false, error: "组合名不能为空" };
  if (!topicIds.length && !categoryIds.length) {
    return { list, item: null, created: false, error: "当前题还没有专题/类别，不能存成组合" };
  }
  if (list.some((c) => c.name.trim() === clean)) {
    return { list, item: null, created: false, error: `已有同名组合：${clean}` };
  }
  const gen = idGen ?? ((p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  let id = gen("cb");
  let guard = 0;
  while (list.some((c) => c.id === id) && guard++ < 10) id = gen("cb");
  if (list.some((c) => c.id === id)) return { list, item: null, created: false, error: "生成 id 失败，请重试" };
  const item = { id, name: clean, topicIds: [...new Set(topicIds)], categoryIds: [...new Set(categoryIds)] };
  return { list: [...list, item], item, created: true };
}

/** 判断当前题的集合是否与组合完全一致（用于高亮“正在用”）。 */
/** @param {TeachCombo} combo @param {{topicIds:string[],categoryIds:string[]}} a */
export function comboMatches(combo, a) {
  /** @param {string[]} x @param {string[]} y @returns {boolean} */
  const same = (x, y) => x.length === y.length && x.every((v) => y.includes(v));
  return same(combo.topicIds, a.topicIds) && same(combo.categoryIds, a.categoryIds);
}

/**
 * 组合改名：按 id 更新名字，成员集合一个都不动（组合只是预设，不是归属）。
 * 名字 trim 后必须非空，且不能和别的组合重名（重名会让“套用哪个”变成猜）。
 * @param {TeachCombo[]} list
 * @param {string} id
 * @param {string} name
 * @returns {{ list: TeachCombo[], item: TeachCombo | null, error?: string }}
 */
export function renameCombo(list, id, name) {
  const cur = list.find((c) => c.id === id);
  if (!cur) return { list, item: null, error: "组合不存在，请刷新后重试" };
  const clean = String(name ?? "").trim();
  if (!clean) return { list, item: null, error: "组合名不能为空" };
  if (list.some((c) => c.id !== id && c.name.trim() === clean)) {
    return { list, item: null, error: `已有同名组合：${clean}` };
  }
  const item = { ...cur, name: clean };
  return { list: list.map((c) => (c.id === id ? item : c)), item };
}

/**
 * 删除组合：只删这套预设本身。
 * 已经按它归好类的题**不受影响**——归属写在 bindings 里，与组合无关。
 * @param {TeachCombo[]} list @param {string} id
 * @returns {{ list: TeachCombo[], item: TeachCombo | null, error?: string }}
 */
export function removeCombo(list, id) {
  const cur = list.find((c) => c.id === id);
  if (!cur) return { list, item: null, error: "组合不存在，可能已经删过了" };
  return { list: list.filter((c) => c.id !== id), item: cur };
}

/** @param {TeachItem[]} items @param {string[]} recent @returns {TeachItem[]} */
export function orderByRecent(items, recent) {
  const rank = new Map(recent.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, key: rank.get(item.id) ?? 1000 + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

/**
 * 托盘搜索：一个关键词同时过滤专题与类别（只读，绝不改清单、绝不写盘）。
 * 忽略首尾空格与英文大小写；空关键词等于不过滤，原样返回两份完整清单。
 * @param {string} query
 * @param {{ topics: TeachItem[], categories: TeachItem[] }} lists
 * @returns {{ q: string, topics: TeachItem[], categories: TeachItem[], total: number }}
 */
export function filterTeach(query, lists) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) {
    return { q: "", topics: lists.topics, categories: lists.categories, total: lists.topics.length + lists.categories.length };
  }
  const hit = (/** @type {TeachItem} */ item) => item.name.toLowerCase().includes(q);
  const topics = lists.topics.filter(hit);
  const categories = lists.categories.filter(hit);
  return { q, topics, categories, total: topics.length + categories.length };
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
  const [topicsRaw, categoriesRaw, combosRaw] = await Promise.all([
    getJson(`${TEACH_ROOT}/topics.json`),
    getJson(`${TEACH_ROOT}/categories.json`),
    getJson(`${TEACH_ROOT}/combos.json`),
  ]);
  return {
    topics: normalizeTeachList(topicsRaw, "topics"),
    categories: normalizeTeachList(categoriesRaw, "categories"),
    combos: normalizeCombos(combosRaw),
  };
}

/** @param {string} doc @returns {Promise<TeachBindings>} */
export async function loadTeachBindings(doc) {
  return normalizeTeachBindings(await getJson(`${TEACH_ROOT}/bindings/${encodeURIComponent(doc)}.json`));
}

/**
 * 唯一写路径：POST /api/teach。失败返回 {ok:false,error}，调用方必须显示并回退。
 * @param {'topics'|'categories'|'bindings'|'combos'} scope
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

/**
 * 某个专题/类别在**所有卷**上被多少题在用。客户端只看得见当前卷，
 * 删除前那句「会影响 N 题」必须由服务端跨文件数出来，不能拿本卷数字糊弄。
 * @returns {Promise<{topics: Record<string, {live:number,stale:number}>, categories: Record<string, {live:number,stale:number}>} | null>}
 */
export async function loadTeachUsage() {
  try {
    const res = await fetch("/api/teach-usage", { cache: "no-store" });
    if (!res.ok) return null;
    const out = /** @type {{ok?: boolean, usage?: any}} */ (await res.json().catch(() => ({})));
    return out.ok ? out.usage : null;
  } catch {
    return null;
  }
}

/**
 * 改名 / 删除：一次请求让服务端跨所有卷级联改写（失败整体回滚）。
 * @param {'rename'|'delete'} action
 * @param {'topics'|'categories'} kind
 * @param {string} id
 * @param {string} [name]
 * @returns {Promise<{ok: boolean, error?: string, item?: string, affected?: number, staleAffected?: number,
 *   combosChanged?: number, combosDropped?: number, list?: unknown, combos?: unknown, bindings?: Record<string, unknown>}>}
 */
export async function manageTeach(action, kind, id, name) {
  try {
    const res = await fetch("/api/teach-manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, kind, id, ...(name === undefined ? {} : { name }) }),
    });
    const out = /** @type {Record<string, unknown>} */ (await res.json().catch(() => ({})));
    if (!res.ok || out.ok === false) return { ok: false, error: String(out.error || `HTTP ${res.status}`) };
    return { ...out, ok: true };
  } catch (e) {
    return { ok: false, error: `管理请求失败：${String(e).slice(0, 120)}` };
  }
}
