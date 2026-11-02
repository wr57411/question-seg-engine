// @ts-check —— 本文件纳入 tsc 检查（展示层是浏览器直接加载的 .js，没有构建步骤，
// 类型写在 JSDoc 里；见 DECISIONS.md §31）。
/**
 * tag-store.js —— 题目标签的数据层（展示层自有数据，**不 import 引擎 src/**）
 *
 * 为什么标签必须自己存一份文件：`questions.json` / `stages.json` / `bank.json` 都是
 * `npm run stages:export` 的**可再生产物**，写进去必被下一次导出冲掉（需求规格 C3/U20）。
 * 落点：`data/out/tags/library.json`（标签库，全局一份）+ `data/out/tags/<docId>.json`（每卷绑定）。
 *
 * 三条不可让的口径（都有对应验收）：
 * · **不静默丢**：切分一变、`questionId` 对不上时，绑定进 `stale` 原样保留并在页面上说
 *   （U21）—— 宁可显示「找不到它了」，不可悄悄少几个标签；
 * · **改名只动库**：绑定只存 `tagId`，所以库里改名全局传播、摘除只断本题（U12/U17）；
 * · **写失败不装成功**：`save*` 返回 `{ok,error}`，调用方必须把 error 显示给用户（U23），
 *   绝不退回 localStorage 冒充已保存。
 */

/**
 * 类型只有一个来源：**这个文件本身**。
 * （曾经的 `tag-store.d.ts` 已删——手写声明会整体遮蔽实现，tsc 从不校验两者一致：
 *  它曾声明过实现里根本没导出的 `TAG_ROOT`，类型检查全程绿。见 DECISIONS.md §31。）
 *
 * @typedef {Object} Tag
 * @property {string} id
 * @property {string} name
 * @property {string} short 纸面留白里显示的 1–2 字
 * @property {string} color
 * @property {string} [createdAt]
 *
 * @typedef {Object} Binding
 * @property {string} questionId
 * @property {string[]} tagIds
 * @property {TagAnchor} [anchor]
 * @property {string} [driftedAt]
 *
 * @typedef {Object} TagAnchor
 * @property {string} number
 * @property {number} page
 * @property {string} section
 * @property {string} firstText
 *
 * @typedef {Object} DocTags
 * @property {number} version
 * @property {string | null} updatedAt
 * @property {Binding[]} bindings
 * @property {Binding[]} stale
 */

const TAG_ROOT = "/data/out/tags";

/** 预置 5 个标签：短码是主标识、颜色是次要线索。
 *  色值经度量选定（2026-10-15）：白字对比度 4.95–9.13（全部 ≥4.5），
 *  与既有语义色（OCR 青绿 H143 / 石青 H203 / 朱砂 H11 / 洋红 H335）最小色相距离 Δ23°。 */
export const PRESET_LIBRARY = [
  { id: "t-hao", name: "好题", short: "好", color: "#4d7c2f" },
  { id: "t-gai", name: "待改", short: "改", color: "#5b3a8c" },
  { id: "t-jiao", name: "已校对", short: "校", color: "#3f3f8c" },
  { id: "t-liu", name: "留着组卷", short: "留", color: "#8a5a1e" },
  { id: "t-nan", name: "偏题难题", short: "难", color: "#7a2f86" },
];

export const emptyDoc = () => ({ version: 1, updatedAt: null, bindings: [], stale: [] });

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null; // 首次使用：文件还没生成，不是错误
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 落盘走 view-server 的 `POST /api/tags`（本项目唯一写通道，doc/路径白名单在服务端校验）。 */
/**
 * @param {string} url
 * @param {unknown} payload
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function postJson(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // `res.json()` 是 unknown（undici 的类型），断言成响应契约的形状
    const out = /** @type {{ok?: boolean, error?: string}} */ (await res.json().catch(() => ({})));
    if (!res.ok || out.ok === false) return { ok: false, error: out.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入请求失败：${String(e).slice(0, 120)}` };
  }
}

/** @returns {Promise<{version: number, tags: Tag[]}>} */
export async function loadLibrary() {
  const data = await getJson(`${TAG_ROOT}/library.json`).catch(() => null);
  // 只有「文件不存在」才用预置库；用户把库清空是合法状态（U18），不能被预置顶回来
  const tags = Array.isArray(data?.tags) ? data.tags : PRESET_LIBRARY;
  return { version: 1, tags };
}

/**
 * @param {{version: number, tags: Tag[]}} library
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const saveLibrary = (library) => postJson("/api/tags?scope=library", library);

/**
 * @param {string} doc
 * @returns {Promise<DocTags>}
 */
export async function loadBindings(doc) {
  const data = await getJson(`${TAG_ROOT}/${encodeURIComponent(doc)}.json`).catch(() => null);
  if (!data || !Array.isArray(data.bindings)) return emptyDoc();
  return {
    version: 1,
    updatedAt: data.updatedAt ?? null,
    bindings: data.bindings,
    stale: Array.isArray(data.stale) ? data.stale : [],
  };
}

/**
 * @param {string} doc
 * @param {DocTags} state
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const saveBindings = (doc, state) =>
  postJson(`/api/tags?doc=${encodeURIComponent(doc)}`, {
    ...state,
    version: 1,
    updatedAt: new Date().toISOString(),
  });

/** 标签本体仍由标签库决定：库里没有的 id 不进渲染（避免"幽灵标签"显示成空白块）。 */
/**
 * @param {{tags: Tag[]}} library
 * @returns {Map<string, Tag>}
 */
export function tagIndex(library) {
  const m = new Map();
  for (const t of library.tags) m.set(t.id, t);
  return m;
}

/**
 * @param {DocTags} state
 * @param {string} questionId
 * @returns {string[]}
 */
export function tagIdsFor(state, questionId) {
  return state.bindings.find((b) => b.questionId === questionId)?.tagIds ?? [];
}

/** 切分重新导出后 `questionId`（位置型 ID）会漂移。对不上的进 stale 保留、对得上的接回来，
 *  永不删除（U21）。返回是否发生变化，供调用方决定是否提示。 */
/**
 * @param {DocTags} state
 * @param {Set<string>} presentIds 当前快照里存在的题目 ID
 * @returns {{state: DocTags, changed: boolean}}
 */
export function reconcile(state, presentIds) {
  const kept = [];
  const stale = [...state.stale];
  for (const b of state.bindings) {
    if (presentIds.has(b.questionId)) kept.push(b);
    else stale.push({ ...b, driftedAt: new Date().toISOString() });
  }
  const stillStale = [];
  for (const s of stale) {
    if (presentIds.has(s.questionId)) {
      if (!kept.some((b) => b.questionId === s.questionId))
        kept.push({ questionId: s.questionId, tagIds: s.tagIds, anchor: s.anchor });
    } else stillStale.push(s);
  }
  const changed = kept.length !== state.bindings.length || stillStale.length !== state.stale.length;
  return { state: { ...state, bindings: kept, stale: stillStale }, changed };
}

/** 打上/摘除（同一个动作，面板里"点选中行"即切换）。幂等：不产生重复 tagId。 */
/**
 * @param {DocTags} state
 * @param {string} questionId
 * @param {string} tagId
 * @param {TagAnchor} [anchor]
 * @returns {DocTags}
 */
export function toggleTag(state, questionId, tagId, anchor) {
  const bindings = state.bindings.filter((b) => b.questionId !== questionId);
  const cur = state.bindings.find((b) => b.questionId === questionId);
  const ids = new Set(cur?.tagIds ?? []);
  if (ids.has(tagId)) ids.delete(tagId);
  else ids.add(tagId);
  if (ids.size) {
    // 已有绑定的 anchor 不因「再加/摘一个标签」而被重写：切分变化后 id 落到别的题上时，
    // 不能让一次无关的点击把旧 anchor 悄悄"洗白"（专题导出靠 anchor 判漂移）。
    // 要把 anchor 更新到当前题，先摘光这条绑定的所有标签再重新打。
    const nextAnchor = cur && cur.tagIds.length ? (cur.anchor ?? anchor) : anchor;
    bindings.push({ questionId, tagIds: [...ids], anchor: nextAnchor });
  }
  return { ...state, bindings };
}

/** 从库里删标签 = 级联摘掉所有绑定（调用方必须先显示"会摘掉 N 题"再确认，U15）。 */
/**
 * @param {{version: number, tags: Tag[]}} library
 * @param {DocTags} state
 * @param {string} tagId
 * @returns {{library: {version: number, tags: Tag[]}, state: DocTags, affected: number}}
 */
export function removeTagFromLibrary(library, state, tagId) {
  // 影响数必须把 stale 一起算：面板拿这个数字要求二次确认，少报就是骗用户
  const affected = [...state.bindings, ...state.stale].filter((b) => b.tagIds.includes(tagId)).length;
  /** @param {Binding[]} list */
  const strip = (list) =>
    list
      .map((b) => ({ ...b, tagIds: b.tagIds.filter((id) => id !== tagId) }))
      .filter((b) => b.tagIds.length > 0);
  return {
    library: { ...library, tags: library.tags.filter((t) => t.id !== tagId) },
    state: { ...state, bindings: strip(state.bindings), stale: strip(state.stale) },
    affected,
  };
}

/** 新标签短码取名字前 2 字（U10）；id 用不可读后缀防撞名。 */
/**
 * @param {string} name
 * @param {string} [color]
 * @returns {Tag | null}
 */
export function makeTag(name, color) {
  const clean = String(name).trim().slice(0, 20);
  if (!clean) return null;
  return { id: `t-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: clean, short: clean.slice(0, 2), color: color || "#4d7c2f" };
}

/** 漂移核对用的锚点：切分一变，用户至少能认出"这原本是第几题的什么内容"。 */
/**
 * @param {{number: string, section?: string}} q
 * @param {{index: number}} p
 * @param {{text?: string}} [firstBlock]
 * @returns {TagAnchor}
 */
export function anchorOf(q, p, firstBlock) {
  return {
    number: q.number,
    page: p.index + 1,
    section: q.section ?? "",
    firstText: String(firstBlock?.text ?? "").slice(0, 16),
  };
}
