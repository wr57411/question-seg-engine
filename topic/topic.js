/**
 * topic/topic.js — 专题页渲染（iPad 优先）。
 *
 * 数据只来自 `/data/out/topics/index.json`（`npm run topic:export` 产物）；
 * 本文件不 import `src/`，不重建纸面。
 * 纯逻辑在 `topic-model.js`（`// @ts-check` 且纳入 tsc）；本文件带 DOM，
 * 与 final.js/stages.js 一样不进入 tsc 程序（见 HANDOFF §6-11），不做假 `@ts-check`。
 *
 * 触屏口径：所有可点元素 ≥44px 高；题干保留换行；答案默认折叠（按钮 44px）。
 * R05：needs_review 的题卡**默认可见**「待复核」徽标与原因，不藏在答案里。
 */

import {
  categoryFacets,
  hasAnswer,
  imageUrl,
  normalizeExportStatus,
  normalizeIndex,
  sourceLabel,
  visibleItems,
} from './topic-model.js';

const els = {
  stats: /** @type {HTMLElement} */ (document.getElementById('stats')),
  topics: /** @type {HTMLElement} */ (document.getElementById('topic-chips')),
  categories: /** @type {HTMLElement} */ (document.getElementById('category-filter')),
  cards: /** @type {HTMLElement} */ (document.getElementById('cards')),
  empty: /** @type {HTMLElement} */ (document.getElementById('empty')),
  banner: /** @type {HTMLElement} */ (document.getElementById('banner')),
  refresh: /** @type {HTMLButtonElement} */ (document.getElementById('refresh')),
};

/** @type {import('./topic-model.js').TopicIndex | null} */
let index = null;
/** @type {ReturnType<typeof normalizeExportStatus>} */
let exportStatus = null;
/** @type {string[]} */
let dataIssues = [];
let currentTopic = '';
/** 类别筛选是**单选**（U24）：存类别 id，'' = 全部 */
let currentCategory = '';
/** @type {Set<string>} */
const openedAnswers = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showFatal(message) {
  els.cards.replaceChildren();
  els.banner.hidden = true;
  els.banner.replaceChildren();
  els.empty.hidden = false;
  els.empty.replaceChildren(
    el('h2', '', '专题数据打不开'),
    el('p', 'empty-reason', message),
    el('p', 'empty-hint', '检查是否已运行 `npm run topic:export`；数据文件：data/out/topics/index.json'),
  );
}

async function load() {
  const stamp = Date.now();
  try {
    const [indexRes, statusRes] = await Promise.all([
      fetch(`/data/out/topics/index.json?t=${stamp}`, { cache: 'no-store' }),
      fetch(`/data/out/topics/export-status.json?t=${stamp}`, { cache: 'no-store' }).catch(() => null),
    ]);
    if (!indexRes.ok) throw new Error(`HTTP ${indexRes.status}`);
    const raw = await indexRes.json();
    const normalized = normalizeIndex(raw);
    index = normalized.index;
    dataIssues = normalized.issues;
    exportStatus = statusRes && statusRes.ok ? normalizeExportStatus(await statusRes.json().catch(() => null)) : null;
  } catch (e) {
    index = null;
    exportStatus = null;
    dataIssues = [];
    showFatal(String(e instanceof Error ? e.message : e));
    return;
  }
  renderBanner();
  if (index.topics.length === 0) {
    els.cards.replaceChildren();
    els.empty.hidden = false;
    els.empty.replaceChildren(
      el('h2', '', '还没有专题'),
      el('p', 'empty-hint', '到成品页开「挑题」，把题目归入专题/类别，再运行 npm run topic:export。'),
    );
  } else {
    els.empty.hidden = true;
    const wanted = new URLSearchParams(location.search).get('topic');
    currentTopic = index.topics.some((t) => t.name === wanted) ? String(wanted) : index.topics[0].name;
    currentCategory = '';
  }
  render();
}

/** 顶部告示：导出失败 / 旧数据 / 索引与状态不一致 / 单条坏数据。默认隐藏。 */
function renderBanner() {
  /** @type {string[]} */
  const lines = [];
  if (index && dataIssues.length) {
    const more = dataIssues.length > 5 ? `；另有 ${dataIssues.length - 5} 条` : '';
    lines.push(`有 ${dataIssues.length} 条专题数据不完整，已跳过：${dataIssues.slice(0, 5).join('；')}${more}`);
  }
  if (index && exportStatus) {
    if (!exportStatus.ok) {
      const errs = exportStatus.errors.length ? `：${exportStatus.errors.slice(0, 3).join('；')}` : '';
      lines.push(
        `上次导出失败（${exportStatus.at || '时间未知'}）${errs}。当前显示的是 ${index.generatedAt || '更早'} 的旧数据。`,
      );
    } else if (exportStatus.indexGeneratedAt && exportStatus.indexGeneratedAt !== index.generatedAt) {
      lines.push('索引与导出状态不一致（可能被手工改过或来自不同次导出），请重新运行 npm run topic:export。');
    } else if (exportStatus.warnings.length) {
      const shown = exportStatus.warnings.slice(0, 5);
      const more = exportStatus.warnings.length > shown.length ? `；另有 ${exportStatus.warnings.length - shown.length} 条` : '';
      lines.push(`导出告警：${shown.join('；')}${more}`);
    }
  } else if (index && index.topics.length) {
    lines.push('没有 export-status.json：无法确认这份数据是否本次导出的结果，建议重新运行 npm run topic:export。');
  }
  if (!lines.length) {
    els.banner.hidden = true;
    els.banner.replaceChildren();
    return;
  }
  els.banner.hidden = false;
  els.banner.replaceChildren(
    el('strong', 'banner-title', '数据提示'),
    ...lines.map((line) => el('p', '', line)),
  );
}

function render() {
  if (!index) return;
  renderStats();
  renderTopics();
  renderCategories();
  renderCards();
}

function renderStats() {
  if (!index) return;
  const { stats } = index;
  els.stats.replaceChildren(
    el('span', 'stat', `${stats.topics} 个专题`),
    el('span', 'stat', `${stats.items} 道题`),
    el('span', 'stat', `${Object.keys(stats.byCategory ?? {}).length} 个类别`),
    el('span', 'stat' + (stats.needsReview ? ' stat-warn' : ''), `待复核 ${stats.needsReview}`),
  );
}

function renderTopics() {
  if (!index) return;
  const buttons = index.topics.map((topic) => {
    const b = /** @type {HTMLButtonElement} */ (el('button', 'chip'));
    b.type = 'button';
    b.textContent = `${topic.name} · ${topic.items.length}`;
    b.dataset.topic = topic.name;
    b.setAttribute('aria-pressed', String(topic.name === currentTopic));
    b.addEventListener('click', () => {
      currentTopic = topic.name;
      currentCategory = '';
      openedAnswers.clear();
      const url = new URL(location.href);
      url.searchParams.set('topic', topic.name);
      history.replaceState(null, '', url);
      render();
      /** @type {HTMLButtonElement | undefined} */ (
        [...els.topics.querySelectorAll('.chip')].find((x) => x.dataset.topic === currentTopic)
      )?.focus();
    });
    return b;
  });
  els.topics.replaceChildren(...buttons);
}

function currentTopicObj() {
  return index?.topics.find((t) => t.name === currentTopic) ?? null;
}

/**
 * 类别筛选条：**只列这个专题里实际出现的类别**（U24），单选。
 * 一题挂多个类别时，在每个类别下都会出现（过滤逻辑在 `visibleItems`）。
 */
function renderCategories() {
  const topic = currentTopicObj();
  if (!topic) {
    els.categories.replaceChildren();
    return;
  }
  const { total, facets } = categoryFacets(topic.items);
  /** @type {{ value: string; label: string; count: number }[]} */
  const options = [
    { value: '', label: '全部', count: total },
    ...facets.map((f) => ({ value: f.id, label: f.name, count: f.count })),
  ];
  els.categories.replaceChildren(
    ...options.map(({ value, label, count }) => {
      const b = /** @type {HTMLButtonElement} */ (el('button', 'seg'));
      b.type = 'button';
      b.textContent = `${label} ${count}`;
      b.dataset.category = value;
      b.setAttribute('aria-pressed', String(currentCategory === value));
      // 0 结果的类别直接禁用：点进去只有空态，是死胡同（iPad 上尤其没必要）
      b.disabled = value !== '' && count === 0;
      b.addEventListener('click', () => {
        currentCategory = value;
        render();
        /** @type {HTMLButtonElement | undefined} */ (
          [...els.categories.querySelectorAll('.seg')].find((x) => x.dataset.category === currentCategory)
        )?.focus();
      });
      return b;
    }),
  );
}

function renderCards() {
  const topic = currentTopicObj();
  if (!topic) {
    els.cards.replaceChildren();
    return;
  }
  const items = visibleItems(topic.items, currentCategory);
  if (items.length === 0) {
    els.empty.hidden = false;
    els.empty.replaceChildren(
      el('h2', '', '这个类别还没有题'),
      el('p', 'empty-hint', '换「全部」看看，或回成品页给题目补类别。'),
    );
    els.cards.replaceChildren();
    return;
  }
  els.empty.hidden = true;
  els.cards.replaceChildren(...items.map((item, i) => renderCard(item, i + 1)));
  renderMath(els.cards);
}

function renderCard(item, ordinal) {
  const card = el('article', 'card' + (item.status === 'needs_review' ? ' is-review' : ''));
  card.dataset.questionId = item.questionId;

  const head = el('header', 'card-head');
  head.append(el('span', 'ordinal', String(ordinal)));
  // v2：类别是一组（可以为空），逐个小徽标显示；不再有单一「层级」
  for (const c of item.categories) head.append(el('span', 'badge badge-cat', c.name));
  if (item.status === 'needs_review') head.append(el('span', 'badge badge-review', '待复核'));
  head.append(el('span', 'source', sourceLabel(item)));
  card.append(head);

  if (item.status === 'needs_review' && item.reviewFlags.length) {
    const flags = el('ul', 'review-flags');
    flags.append(el('li', 'review-title', '为什么需要复核'));
    for (const flag of item.reviewFlags) flags.append(el('li', '', flag));
    card.append(flags);
  }

  card.append(el('div', 'stem', item.stem));

  if (item.options.length) {
    const list = el('ol', 'options');
    for (const option of item.options) {
      const li = el('li', 'option');
      li.append(el('b', 'option-key', option.key));
      li.append(el('span', 'option-text', option.text.replace(/\s*\n\s*/g, ' ')));
      list.append(li);
    }
    card.append(list);
  }

  if (item.images.length) {
    const figs = el('div', 'figures');
    for (const im of item.images) {
      const img = /** @type {HTMLImageElement} */ (document.createElement('img'));
      img.src = imageUrl(item.doc, im.path);
      img.alt = `${sourceLabel(item)} 的题图`;
      img.loading = 'lazy';
      figs.append(img);
    }
    card.append(figs);
  }

  if (hasAnswer(item)) {
    const key = item.questionId;
    const toggle = /** @type {HTMLButtonElement} */ (el('button', 'answer-toggle'));
    toggle.type = 'button';
    const answer = el('section', 'answer');
    answer.hidden = !openedAnswers.has(key);
    const label = () => {
      const open = !answer.hidden;
      toggle.textContent = open ? '收起答案 ▴' : '显示答案 ▾';
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => {
      answer.hidden = !answer.hidden;
      if (answer.hidden) openedAnswers.delete(key);
      else openedAnswers.add(key);
      label();
    });
    card.append(toggle);

    if (item.answerKey) {
      const row = el('div', 'answer-key');
      row.append(el('span', 'answer-label', '答案'));
      row.append(el('span', 'answer-value', item.answerKey));
      answer.append(row);
    }
    if (item.answerText) answer.append(el('div', 'answer-text', item.answerText));
    answer.append(el('div', 'answer-source', `答案来源：${item.answerDoc || '未知（bank 缺 answerDoc）'}`));
    if (item.answerImages.length) {
      const figs = el('div', 'figures answer-figures');
      for (const im of item.answerImages) {
        const img = /** @type {HTMLImageElement} */ (document.createElement('img'));
        img.src = imageUrl(im.doc, im.path);
        img.alt = `${sourceLabel(item)} 的答案图`;
        img.loading = 'lazy';
        figs.append(img);
      }
      answer.append(figs);
    }
    card.append(answer);
    label();
  }
  return card;
}

/** KaTeX 联网加载成功才渲染；离线保持 $..$ 原文（与 viewer 同一降级口径） */
function renderMath(root) {
  const render = /** @type {any} */ (window).renderMathInElement;
  if (typeof render !== 'function') return;
  try {
    render(root, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  } catch {
    /* 公式渲染失败不能让题干消失；保持纯文本 */
  }
}

els.refresh.addEventListener('click', () => {
  openedAnswers.clear();
  load();
});

load();
