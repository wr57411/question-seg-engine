// @ts-check
/**
 * topic/topic-model.js — 专题页的**纯逻辑**（无 DOM，可被 tsc 检查）。
 *
 * 数据只消费 `data/out/topics/index.json`（`npm run topic:export` 的产物）。
 * 解耦红线：本文件不 import `src/`，也不碰 `stages/reconstruct.js`（不重建纸面）。
 */

/** @typedef {{ key: string; text: string }} Option */
/** @typedef {{ path: string; bbox?: number[] }} ImageRef */
/** @typedef {{ doc: string; path: string; bbox?: number[] }} AnswerImage */
/**
 * @typedef {{
 *   doc: string;
 *   number: string;
 *   page: number;
 *   questionId: string;
 *   categories: { id: string; name: string }[];
 *   stem: string;
 *   options: Option[];
 *   images: ImageRef[];
 *   answerKey: string;
 *   answerText: string;
 *   answerDoc: string;
 *   answerImages: AnswerImage[];
 *   status: string;
 *   confidence: number;
 *   reviewFlags: string[];
 *   sources: string[];
 * }} TopicItem
 */
/** @typedef {{ id: string; slug: string; name: string; items: TopicItem[] }} Topic */
/** @typedef {{ topics: number; items: number; needsReview: number; byCategory: Record<string, number> }} TopicStats */
/** @typedef {{ version: number; generatedAt: string; topics: Topic[]; stats: TopicStats }} TopicIndex */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRec = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * 校验并规范化导出快照。**单条坏数据不拖垮整页**：能显示的全部显示，
 * 坏条目收进 `issues`，页面顶部明说（不静默丢）。
 * 只有顶层形状不对才抛错（页面把错误原样显示，不假装空数据）。
 * @param {unknown} raw
 * @returns {{ index: TopicIndex; issues: string[] }}
 */
export function normalizeIndex(raw) {
  if (!isRec(raw) || !Array.isArray(raw.topics)) {
    throw new Error('index.json 形状不对：需要 {version, topics:[...]}');
  }
  /** @type {string[]} */
  const issues = [];
  /** @type {Topic[]} */
  const topics = [];
  for (let i = 0; i < raw.topics.length; i++) {
    const t = normalizeTopic(raw.topics[i], i, issues);
    if (t) topics.push(t);
  }
  const items = topics.flatMap((t) => t.items);
  /** @type {Record<string, number>} */
  const byCategory = {};
  for (const item of items) {
    for (const c of item.categories) byCategory[c.id] = (byCategory[c.id] ?? 0) + 1;
  }
  const stats = {
    topics: topics.length,
    items: items.length,
    needsReview: items.filter((x) => x.status === 'needs_review').length,
    byCategory,
  };
  return {
    index: {
      version: typeof raw.version === 'number' ? raw.version : 1,
      generatedAt: str(raw.generatedAt),
      topics,
      stats,
    },
    issues,
  };
}

/**
 * @param {unknown} raw
 * @param {number} i
 * @param {string[]} issues
 * @returns {Topic | null}
 */
function normalizeTopic(raw, i, issues) {
  if (!isRec(raw) || !Array.isArray(raw.items)) {
    issues.push(`topics[${i}] 形状不对：需要 {name, items:[...]}`);
    return null;
  }
  const name = str(raw.name).trim();
  if (!name) {
    issues.push(`topics[${i}] 缺少 name`);
    return null;
  }
  /** @type {TopicItem[]} */
  const items = [];
  for (let j = 0; j < raw.items.length; j++) {
    const item = normalizeItem(raw.items[j], `${name}[${j}]`, issues);
    if (item) items.push(item);
  }
  if (items.length === 0) issues.push(`专题「${name}」没有可显示的题目`);
  return { id: str(raw.id), slug: str(raw.slug) || name, name, items };
}

/**
 * @param {unknown} raw
 * @param {string} at
 * @param {string[]} issues
 * @returns {TopicItem | null}
 */
function normalizeItem(raw, at, issues) {
  if (!isRec(raw)) {
    issues.push(`${at} 不是对象`);
    return null;
  }
  const questionId = str(raw.questionId);
  const stem = str(raw.stem);
  if (!questionId) {
    issues.push(`${at} 缺少 questionId`);
    return null;
  }
  if (!stem.trim()) {
    issues.push(`${at}（${questionId}）题干为空`);
    return null;
  }
  // v2：类别是数组，且**可以为空**（一题只进专题、不挂类别是合法状态）
  /** @type {{ id: string; name: string }[]} */
  const categories = [];
  if (raw.categories !== undefined && raw.categories !== null) {
    if (!Array.isArray(raw.categories)) {
      issues.push(`${at}（${questionId}）categories 不是数组，已按无类别显示`);
    } else {
      for (const c of raw.categories) {
        if (!isRec(c) || !str(c.id) || !str(c.name)) {
          issues.push(`${at}（${questionId}）有类别缺 id/name，已跳过`);
          continue;
        }
        if (categories.some((x) => x.id === str(c.id))) continue;
        categories.push({ id: str(c.id), name: str(c.name) });
      }
    }
  }
  if (raw.options !== undefined && raw.options !== null && !Array.isArray(raw.options)) {
    issues.push(`${at}（${questionId}）选项字段不是数组，已按无选项显示`);
  }
  /** @type {Option[]} */
  const options = [];
  if (Array.isArray(raw.options)) {
    for (const o of raw.options) {
      if (!isRec(o)) {
        issues.push(`${at}（${questionId}）有选项不是对象，已跳过`);
        continue;
      }
      const text = str(o.text);
      if (!text.trim()) {
        issues.push(`${at}（${questionId}）有选项文本为空，已跳过`);
        continue;
      }
      options.push({ key: str(o.key), text });
    }
  }
  /** @type {ImageRef[]} */
  const images = [];
  if (Array.isArray(raw.images)) {
    for (const im of raw.images) {
      if (!isRec(im) || !str(im.path)) {
        issues.push(`${at}（${questionId}）有题图缺 path，已跳过`);
        continue;
      }
      /** @type {ImageRef} */
      const out = { path: str(im.path) };
      if (Array.isArray(im.bbox) && im.bbox.every((n) => typeof n === 'number')) out.bbox = /** @type {number[]} */ (im.bbox);
      images.push(out);
    }
  }
  /** @type {AnswerImage[]} */
  const answerImages = [];
  if (Array.isArray(raw.answerImages)) {
    for (const im of raw.answerImages) {
      if (!isRec(im) || !str(im.path) || !str(im.doc)) {
        issues.push(`${at}（${questionId}）有答案图缺 doc/path，已跳过`);
        continue;
      }
      /** @type {AnswerImage} */
      const out = { doc: str(im.doc), path: str(im.path) };
      if (Array.isArray(im.bbox) && im.bbox.every((n) => typeof n === 'number')) out.bbox = /** @type {number[]} */ (im.bbox);
      answerImages.push(out);
    }
  }
  return {
    doc: str(raw.doc),
    number: str(raw.number),
    page: typeof raw.page === 'number' && Number.isFinite(raw.page) ? raw.page : 0,
    questionId,
    categories,
    stem,
    options,
    images,
    answerKey: str(raw.answerKey),
    answerText: str(raw.answerText),
    answerDoc: str(raw.answerDoc),
    answerImages,
    status: str(raw.status) || 'ok',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
    reviewFlags: Array.isArray(raw.reviewFlags) ? raw.reviewFlags.filter((x) => typeof x === 'string') : [],
    sources: Array.isArray(raw.sources) ? raw.sources.filter((x) => typeof x === 'string') : [],
  };
}

/**
 * 导出状态（`export-status.json`）：页面用它识别「上次导出失败 / 显示的是旧数据」。
 * @param {unknown} raw
 * @returns {{ ok: boolean; at: string; errors: string[]; warnings: string[]; indexGeneratedAt: string } | null}
 */
export function normalizeExportStatus(raw) {
  if (!isRec(raw)) return null;
  return {
    ok: raw.ok === true,
    at: str(raw.at),
    errors: Array.isArray(raw.errors) ? raw.errors.filter((x) => typeof x === 'string') : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((x) => typeof x === 'string') : [],
    indexGeneratedAt: str(raw.indexGeneratedAt),
  };
}

/**
 * 类别筛选（**单选**，U24）：`''` = 全部；一题挂多个类别时，在每个类别筛选项下都出现。
 * @param {TopicItem[]} items
 * @param {string} categoryId
 * @returns {TopicItem[]}
 */
export function visibleItems(items, categoryId) {
  if (!categoryId) return items;
  return items.filter((x) => x.categories.some((c) => c.id === categoryId));
}

/**
 * 这个专题里**实际出现**的类别 + 计数（按名字排序，供筛选条渲染）。
 * 空类别不返回 —— 点进去只有空态，是死胡同。
 * @param {TopicItem[]} items
 * @returns {{ total: number; facets: { id: string; name: string; count: number }[] }}
 */
export function categoryFacets(items) {
  /** @type {Map<string, { id: string; name: string; count: number }>} */
  const map = new Map();
  for (const item of items) {
    for (const c of item.categories) {
      const cur = map.get(c.id) ?? { id: c.id, name: c.name, count: 0 };
      cur.count += 1;
      map.set(c.id, cur);
    }
  }
  const facets = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { total: items.length, facets };
}

/**
 * 来源徽标：`doc p17 · 第7题`；页码未知时明说，不假装第 1 页。
 * @param {TopicItem} item
 * @returns {string}
 */
export function sourceLabel(item) {
  const page = item.page > 0 ? `p${item.page}` : '页码未知';
  const number = item.number ? `第${item.number}题` : '题号未知';
  return `${item.doc} ${page} · ${number}`;
}

/**
 * 图片 URL：快照里 path 相对 `data/out/<doc>/images/`。
 * @param {string} doc
 * @param {string} path
 * @returns {string}
 */
export function imageUrl(doc, path) {
  const safePath = path.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `/data/out/${encodeURIComponent(doc)}/images/${safePath}`;
}

/**
 * 答案区该不该画：有 key/文本/图任一项就算有。
 * @param {TopicItem} item
 * @returns {boolean}
 */
export function hasAnswer(item) {
  return Boolean(item.answerKey || item.answerText || item.answerImages.length);
}
