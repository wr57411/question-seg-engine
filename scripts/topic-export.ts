// scripts/topic-export.ts
/**
 * 专题导出：把「专题标签 / 手工题单」两路输入变成展示层唯一消费源
 * `data/out/topics/index.json`。
 *
 * ## 输入（两路合并，同一道题在同一专题里只出现一次）
 * 1. **标签通道**：`data/out/tags/<doc>.json` 的 bindings。面板新建的标签在
 *    `data/out/tags/library.json` 里是 `{id, name}`，绑定只存 id ⇒ 必须**先用库把 id 解析回
 *    名字**，再判断名字是否形如 `专题名#基础` / `专题名#培优`（`#` 只用于专题标签，其余短码不受影响）。
 *    库里找不到的 id 按其字面值兼容（历史/种子数据）。
 *    `questionId` 是权威键；**anchor 必须与当前题目一致**（页码/题号/首行文本），
 *    不一致 = 切分变了、绑定漂移 ⇒ 退出码 1（不把标签静默挂到别的题上）。
 * 2. **手工题单**：`data/out/topics/<slug>.topic.json`，`{name, items:[{doc, number, level, questionId?, page?}]}`。
 *    教辅题号在每节重新开始，**只给 number 可能撞号** ⇒ 有歧义即报错并列出候选，不猜。
 *
 * ## 合并与校验
 * - 题目快照：`data/out/<doc>/questions.json`（题干/选项/图片/status/confidence）
 * - 答案池：`data/out/bank/bank.json`（`quizId` == 题目 id；answerKey/answerText/answerImages）
 * - 图片：题图相对 `data/out/<doc>/images/`，答案图相对 `data/out/<answerDoc>/images/`
 * - **缺题 / 缺题干 / 缺答案 / 缺图 / 标签漂移 ⇒ 退出码 1 并逐条列出**（不静默丢内容）
 * - needs_review 的题**照收**，但带 `reviewFlags`（R05：不允许静默当干净题）
 * - 失败时仍写 `data/out/topics/export-status.json`（ok:false + 错误），页面据此提示
 *   「当前显示的是旧数据」，不把上次成功的 index 假装成本次结果
 *
 * 用法：`npm run topic:export`（`--root <dir>` 仅供单测指向临时夹具）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TopicLevel = "基础" | "培优";

/** 标签解析结果：`not-topic` = 不是专题标签；`invalid` = 含 `#` 但不符合约定 */
export type ParsedTopicTag =
  | { kind: "not-topic" }
  | { kind: "ok"; name: string; level: TopicLevel }
  | { kind: "invalid"; error: string };

const LEVELS: readonly TopicLevel[] = ["基础", "培优"];

/** 标签库缺失时，只有这些预置 id 允许「解析不到名字」；其它 t- id 视为库丢了。 */
const PRESET_TAG_IDS = new Set(["t-hao", "t-gai", "t-jiao", "t-liu", "t-nan"]);

/** `专题名#基础` → {name, level}；无 `#` 返回 not-topic（既有短码不受影响）。 */
export function parseTopicTag(tagId: string): ParsedTopicTag {
  if (!tagId.includes("#")) return { kind: "not-topic" };
  const cut = tagId.lastIndexOf("#");
  const name = tagId.slice(0, cut).trim();
  const level = tagId.slice(cut + 1).trim();
  if (!name) return { kind: "invalid", error: `专题名为空：${JSON.stringify(tagId)}` };
  if (level !== "基础" && level !== "培优") {
    return {
      kind: "invalid",
      error: `层级必须是「基础」或「培优」：${JSON.stringify(tagId)}（实际层级：${JSON.stringify(level)}）`,
    };
  }
  return { kind: "ok", name, level };
}

export interface TopicItem {
  doc: string;
  number: string;
  /** 1 基页码（快照内部是 pageIndex，展示层用这个） */
  page: number;
  questionId: string;
  level: TopicLevel;
  stem: string;
  options: { key: string; text: string }[];
  images: { path: string; bbox?: number[] }[];
  answerKey: string;
  answerText: string;
  /** 答案来源册（展示层据此标注来源；空 = 不知道） */
  answerDoc: string;
  /** doc = 答案册（answerImages 的 path 相对它的 images/） */
  answerImages: { doc: string; path: string; bbox?: number[] }[];
  status: string;
  confidence: number;
  reviewFlags: string[];
  /** 这道题是怎么进专题的（tag / manual），合并时去重 */
  sources: ("tag" | "manual")[];
}

export interface Topic {
  slug: string;
  name: string;
  items: TopicItem[];
}

export interface TopicIndex {
  version: 1;
  generatedAt: string;
  topics: Topic[];
  stats: {
    topics: number;
    items: number;
    needsReview: number;
    byLevel: Record<TopicLevel, number>;
  };
}

export interface TopicExportResult {
  /** 有错误时为 null（不落半成品） */
  index: TopicIndex | null;
  errors: string[];
  warnings: string[];
}

/** 导出状态：成功/失败都写，页面用它判断「看到的是不是上次的旧数据」。 */
export interface TopicExportStatus {
  ok: boolean;
  at: string;
  errors: string[];
  /** 不阻断导出、但必须让人看见的问题（弱 anchor、条目消失、库缺失） */
  warnings: string[];
  /** 当前磁盘上 index.json 的生成时间（没有则 null） */
  indexGeneratedAt: string | null;
}

/* ── 原始快照的最小形状（只取这里用到的字段；畸形数据按错误处理） ── */

interface RawQuestion {
  id?: unknown;
  number?: unknown;
  stem?: unknown;
  options?: unknown;
  images?: unknown;
  status?: unknown;
  confidence?: unknown;
  source?: { pageIndex?: unknown } | null;
}

interface RawBankEntry {
  quizId?: unknown;
  answerDoc?: unknown;
  answerKey?: unknown;
  answerText?: unknown;
  answerImages?: unknown;
}

interface RawStageReview {
  questionId?: unknown;
  reason?: unknown;
}

interface RawAnchor {
  number?: unknown;
  page?: unknown;
  firstText?: unknown;
}

interface Ref {
  topic: string;
  level: TopicLevel;
  doc: string;
  source: "tag" | "manual";
  /** 标签通道直接给 id；手工题单可给 id 或 number(+page) */
  questionId?: string;
  number?: string;
  page?: number;
  /** 标签绑定时记录的锚点：切分变化后必须能识别出「这已经不是原来那道题」 */
  anchor?: RawAnchor;
  origin: string;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readJsonDir(dir: string, suffix: string): { file: string; json: unknown }[] {
  if (!existsSync(dir)) return [];
  const out: { file: string; json: unknown }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(suffix)) continue;
    const file = join(dir, name);
    try {
      out.push({ file, json: readJson(file) });
    } catch (e) {
      out.push({ file, json: { __parseError: String(e) } });
    }
  }
  return out;
}

/** 1 基页码：pageIndex 从 0 开始；缺失记 0（展示层显示「页码未知」，不假装 1） */
function pageOf(q: RawQuestion): number {
  const idx = q.source?.pageIndex;
  return typeof idx === "number" && Number.isFinite(idx) ? idx + 1 : 0;
}

/**
 * 选项数组：`{key,text}`。形状不对或文本为空 ⇒ 记错误（不静默变成空数组，
 * 否则「选项全丢」会以 `options: []` 的形式被导出成一道看起来正常的主观题）。
 */
function optionsOf(q: RawQuestion, label: string, errors: string[]): { key: string; text: string }[] {
  if (q.options === undefined || q.options === null) return [];
  if (!Array.isArray(q.options)) {
    errors.push(`选项字段不是数组（${label}）`);
    return [];
  }
  const out: { key: string; text: string }[] = [];
  for (const o of q.options) {
    if (!isRec(o)) {
      errors.push(`选项元素不是对象（${label}）`);
      continue;
    }
    const key = asStr(o.key);
    const text = asStr(o.text);
    if (!text.trim()) {
      errors.push(`选项文本为空（${label}）`);
      continue;
    }
    out.push({ key, text });
  }
  return out;
}

/** 标签库 id → name（面板新建的标签只把 id 写进绑定；导出必须先还原名字）。 */
function loadTagLibrary(outRoot: string, errors: string[]): { map: Map<string, string>; found: boolean } {
  const map = new Map<string, string>();
  const file = join(outRoot, "tags", "library.json");
  if (!existsSync(file)) return { map, found: false };
  try {
    const json = readJson(file);
    if (!isRec(json) || !Array.isArray(json.tags)) {
      errors.push("标签库形状不对：data/out/tags/library.json 需要 {version:1, tags:[{id,name,...}]}");
      return { map, found: true };
    }
    for (const t of json.tags) {
      if (!isRec(t)) continue;
      const id = asStr(t.id);
      const name = asStr(t.name);
      if (!id || !name) continue;
      if (map.has(id)) errors.push(`标签库 id 重复：${id}（后一条会静默覆盖前一条，拒绝导出）`);
      map.set(id, name);
    }
  } catch (e) {
    errors.push(`标签库解析失败：data/out/tags/library.json —— ${String(e)}`);
  }
  return { map, found: true };
}

/** 比对用文本：去掉空白、标点与 LaTeX 记号，只留字母/数字/汉字。 */
function normText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * 标签漂移判据：
 * - 页码/题号不一致、或首行文本明显对不上 ⇒ `problem`（导出必须红）；
 * - anchor 缺失 / 首行有效字符 <6（题号独占一行、图题等）⇒ `warning`：
 *   这种题无法可靠核对漂移，只能核对页码+题号；页面上明说「anchor 较弱」，
 *   不因此阻断整本书的导出（重打标仍是同样的短首行）。
 */
function anchorCheck(q: RawQuestion, anchor: RawAnchor | undefined): { problem: string | null; warning: string | null } {
  if (!anchor) return { problem: null, warning: "缺少 anchor（无法核对标签是否已漂移）" };
  const page = typeof anchor.page === "number" && Number.isFinite(anchor.page) ? anchor.page : null;
  const number = asStr(anchor.number);
  const firstText = asStr(anchor.firstText);
  const remedy = "（要接受新位置：先摘光该题所有标签再重打，或改用题单）";
  if (page !== null && pageOf(q) !== page) {
    return { problem: `anchor 记的是 p${page}，当前是 p${pageOf(q)}${remedy}`, warning: null };
  }
  if (number && asStr(q.number) !== number) {
    return { problem: `anchor 记的是第 ${number} 题，当前是第 ${asStr(q.number) || "?"} 题${remedy}`, warning: null };
  }
  if (!firstText.trim()) return { problem: null, warning: "缺少 firstText（只能核对页码+题号）" };
  let a = normText(firstText);
  const num = asStr(q.number);
  if (num && a.startsWith(num)) a = a.slice(num.length);
  const stem = normText(asStr(q.stem));
  const probe = a.slice(0, 10);
  if (probe.length < 6) {
    return { problem: null, warning: `firstText「${firstText}」有效字符不足 6 个（只能核对页码+题号）` };
  }
  if (!stem.slice(0, 160).includes(probe) && !a.includes(stem.slice(0, 10))) {
    return {
      problem: `anchor 首行「${firstText}」与当前题干「${asStr(q.stem).slice(0, 24)}…」对不上${remedy}`,
      warning: null,
    };
  }
  return { problem: null, warning: null };
}

/** 题图/答案图数组：只收有 path 的元素；bbox 有就带、没有不强造 */
function imagesOf(raw: unknown, label: string, errors: string[]): { path: string; bbox?: number[] }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`图片字段不是数组（${label}）`);
    return [];
  }
  const out: { path: string; bbox?: number[] }[] = [];
  for (const im of raw) {
    if (!isRec(im)) {
      errors.push(`图片元素不是对象（${label}）`);
      continue;
    }
    const path = asStr(im.path);
    if (!path) {
      errors.push(`图片缺少 path（${label}）`);
      continue;
    }
    const bbox = Array.isArray(im.bbox) && im.bbox.every((n) => typeof n === "number") ? (im.bbox as number[]) : undefined;
    out.push(bbox ? { path, bbox } : { path });
  }
  return out;
}

/**
 * 构建专题索引（不落盘）。`root` 下应有 `data/out/...` 结构；单测直接指向临时夹具。
 */
export function buildTopicIndex(root: string): TopicExportResult {
  const outRoot = join(root, "data", "out");
  const errors: string[] = [];
  const warnings: string[] = [];
  const refs: Ref[] = [];

  /* ── 1. 标签通道 ── */
  const tagLibrary = loadTagLibrary(outRoot, errors);
  let sawTagBinding = false;
  /** 库在但 id 找不到 / 库整个丢了（只剩预置 id）都不允许静默当成普通标签。 */
  const resolveTagName = (tagId: string, where: string): string => {
    const name = tagLibrary.map.get(tagId);
    if (name) return name;
    // 历史/种子绑定直接把 `专题名#层级` 当 id：允许按字面值解析
    if (tagId.includes("#")) return tagId;
    if (tagLibrary.found && tagId.startsWith("t-")) {
      errors.push(`标签库缺 id：${where} 的 ${tagId}（library.json 里找不到该标签，绑定成了幽灵标签）`);
    } else if (!tagLibrary.found && tagId.startsWith("t-") && !PRESET_TAG_IDS.has(tagId)) {
      errors.push(`标签库缺失：${where} 的 ${tagId} 无法解析名字（data/out/tags/library.json 不存在）`);
    }
    return tagId;
  };
  for (const { file, json } of readJsonDir(join(outRoot, "tags"), ".json")) {
    const doc = file.slice(file.lastIndexOf("/") + 1, -".json".length);
    if (doc === "library") continue; // 标签定义文件，不是绑定
    if (isRec(json) && typeof json.__parseError === "string") {
      errors.push(`标签文件解析失败：${doc}.json —— ${json.__parseError}`);
      continue;
    }
    if (!isRec(json) || !Array.isArray(json.bindings)) {
      errors.push(`标签文件缺少 bindings 数组：${doc}.json`);
      continue;
    }
    for (const b of json.bindings) {
      if (!isRec(b)) continue;
      const questionId = asStr(b.questionId);
      const tagIds = Array.isArray(b.tagIds) ? b.tagIds.filter((t): t is string => typeof t === "string") : [];
      if (tagIds.length) sawTagBinding = true;
      if (!questionId) {
        errors.push(`标签绑定缺少 questionId：${doc}.json`);
        continue;
      }
      for (const tagId of tagIds) {
        // 绑定里存的是标签 id；专题约定写在标签**名字**上（面板新建才能打 `专题名#基础`）
        const tagName = resolveTagName(tagId, `${doc} · ${questionId}`);
        const parsed = parseTopicTag(tagName);
        if (parsed.kind === "not-topic") continue;
        if (parsed.kind === "invalid") {
          errors.push(`标签格式不合约定（${doc} · ${questionId} · ${tagName}）：${parsed.error}`);
          continue;
        }
        refs.push({
          topic: parsed.name,
          level: parsed.level,
          doc,
          source: "tag",
          questionId,
          anchor: isRec(b.anchor) ? (b.anchor as RawAnchor) : undefined,
          origin: `标签 ${tagName}${tagName === tagId ? "" : `（${tagId}）`}`,
        });
      }
    }

    // stale = 对不上原题、被成品页自动挪走的绑定。专题标签不能在 stale 里静默消失。
    const stale = Array.isArray(json.stale) ? json.stale : [];
    for (const b of stale) {
      if (!isRec(b)) continue;
      const questionId = asStr(b.questionId);
      const tagIds = Array.isArray(b.tagIds) ? b.tagIds.filter((t): t is string => typeof t === "string") : [];
      for (const tagId of tagIds) {
        const tagName = resolveTagName(tagId, `stale ${doc} · ${questionId || "?"}`);
        const parsed = parseTopicTag(tagName);
        if (parsed.kind === "ok") {
          errors.push(
            `标签失效（stale）：${doc} · ${questionId || "?"} · 专题「${parsed.name}」—— 切分变化后找不到原题，专题会缺这道题；请回成品页处理/恢复`,
          );
        } else if (parsed.kind === "invalid") {
          errors.push(`标签格式不合约定（stale ${doc} · ${questionId || "?"} · ${tagName}）：${parsed.error}`);
        }
      }
    }
  }

  if (!tagLibrary.found && sawTagBinding) {
    warnings.push(
      "标签库 data/out/tags/library.json 不存在：所有 t- 绑定只能按预置 id 理解；若曾把标签改名为专题名，会漏导出",
    );
  }

  /* ── 2. 手工题单 ── */
  for (const { file, json } of readJsonDir(join(outRoot, "topics"), ".topic.json")) {
    const stem = file.slice(file.lastIndexOf("/") + 1, -".topic.json".length);
    if (isRec(json) && typeof json.__parseError === "string") {
      errors.push(`手工题单解析失败：${stem}.topic.json —— ${json.__parseError}`);
      continue;
    }
    if (!isRec(json) || !Array.isArray(json.items)) {
      errors.push(`手工题单缺少 items 数组：${stem}.topic.json`);
      continue;
    }
    const name = asStr(json.name).trim();
    if (!name) {
      errors.push(`手工题单缺少 name：${stem}.topic.json`);
      continue;
    }
    for (const [i, item] of json.items.entries()) {
      const at = `${stem}.topic.json items[${i}]`;
      if (!isRec(item)) {
        errors.push(`手工题单条目不是对象：${at}`);
        continue;
      }
      const doc = asStr(item.doc).trim();
      if (!doc) {
        errors.push(`手工题单条目缺少 doc：${at}`);
        continue;
      }
      const level = asStr(item.level).trim();
      if (level !== "基础" && level !== "培优") {
        errors.push(`手工题单条目层级必须是「基础」或「培优」：${at}（实际：${JSON.stringify(level)}）`);
        continue;
      }
      const questionId = asStr(item.questionId).trim();
      const number = asStr(item.number).trim();
      const page = typeof item.page === "number" && Number.isFinite(item.page) ? item.page : undefined;
      if (!questionId && !number) {
        errors.push(`手工题单条目需要 questionId 或 number：${at}`);
        continue;
      }
      refs.push({
        topic: name,
        level,
        doc,
        source: "manual",
        ...(questionId ? { questionId } : {}),
        ...(!questionId ? { number } : {}),
        ...(page !== undefined ? { page } : {}),
        origin: at,
      });
    }
  }

  if (refs.length === 0 && errors.length === 0) {
    warnings.push("没有发现任何专题标签或手工题单：先打标 `专题名#基础/培优`，或写 data/out/topics/*.topic.json");
  }

  /* ── 3. 按专题归组、解析到题 ── */
  const questionsCache = new Map<string, RawQuestion[] | null>();
  const loadQuestions = (doc: string): RawQuestion[] | null => {
    if (questionsCache.has(doc)) return questionsCache.get(doc) ?? null;
    const file = join(outRoot, doc, "questions.json");
    if (!existsSync(file)) {
      questionsCache.set(doc, null);
      return null;
    }
    try {
      const json = readJson(file);
      const list = Array.isArray(json) ? (json as RawQuestion[]) : [];
      questionsCache.set(doc, list);
      return list;
    } catch (e) {
      errors.push(`题目快照解析失败：${doc}/questions.json —— ${String(e)}`);
      questionsCache.set(doc, null);
      return null;
    }
  };

  /** 手工题单只给 number 时按题号找，重号必须显式消歧（page / questionId） */
  const resolveByNumber = (doc: string, number: string, page: number | undefined, origin: string): RawQuestion | null => {
    const list = loadQuestions(doc);
    if (!list) {
      errors.push(`缺题：${doc} 的 questions.json 不存在（${origin}）`);
      return null;
    }
    let candidates = list.filter((q) => asStr(q.number).trim() === number);
    if (page !== undefined) candidates = candidates.filter((q) => pageOf(q) === page);
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) {
      errors.push(`缺题：${doc} 找不到题号 ${number}${page !== undefined ? `（第 ${page} 页）` : ""}（${origin}）`);
      return null;
    }
    const ids = candidates.map((q) => asStr(q.id)).join("、");
    errors.push(
      `题号歧义：${doc} 题号 ${number} 命中 ${candidates.length} 道题（${ids}）⇒ 请在题单里写 questionId 或 page（${origin}）`,
    );
    return null;
  };

  const topics = new Map<
    string,
    {
      slug: string;
      name: string;
      entries: Map<string, { q: RawQuestion; doc: string; levels: Set<TopicLevel>; sources: Set<"tag" | "manual"> }>;
    }
  >();

  for (const ref of refs) {
    let q: RawQuestion | null = null;
    if (ref.questionId) {
      const list = loadQuestions(ref.doc);
      if (!list) {
        errors.push(`缺题：${ref.doc} 的 questions.json 不存在（${ref.origin}）`);
      } else {
        q = list.find((x) => asStr(x.id) === ref.questionId) ?? null;
        if (!q) errors.push(`缺题：${ref.doc} 里找不到 ${ref.questionId}（${ref.origin}）`);
      }
    } else if (ref.number) {
      q = resolveByNumber(ref.doc, ref.number, ref.page, ref.origin);
    }
    if (!q) continue;

    const id = asStr(q.id);
    if (ref.source === "tag") {
      const check = anchorCheck(q, ref.anchor);
      if (check.problem) errors.push(`标签漂移：${ref.doc} · ${id} · ${ref.origin} —— ${check.problem}`);
      if (check.warning) warnings.push(`标签 anchor 较弱：${ref.doc} · ${id} · ${ref.origin} —— ${check.warning}`);
    }
    let topic = topics.get(ref.topic);
    if (!topic) {
      topic = { slug: ref.topic, name: ref.topic, entries: new Map() };
      topics.set(ref.topic, topic);
    }
    const existing = topic.entries.get(id);
    if (existing) {
      if (existing.levels.size > 0 && !existing.levels.has(ref.level)) {
        errors.push(
          `层级冲突：专题「${ref.topic}」里的 ${id} 同时被标成 ${[...existing.levels].join("/")} 与 ${ref.level}（${ref.origin}）`,
        );
      }
      existing.levels.add(ref.level);
      existing.sources.add(ref.source);
    } else {
      topic.entries.set(id, { q, doc: ref.doc, levels: new Set([ref.level]), sources: new Set([ref.source]) });
    }
  }

  /* ── 4. 答案池 + 评审原因（按题逐条 join） ── */
  let bankList: RawBankEntry[] = [];
  const bankFile = join(outRoot, "bank", "bank.json");
  if (existsSync(bankFile)) {
    try {
      const json = readJson(bankFile);
      bankList = Array.isArray(json) ? (json as RawBankEntry[]) : [];
    } catch (e) {
      errors.push(`答案池解析失败：bank/bank.json —— ${String(e)}`);
    }
  }
  const bankByQuizId = new Map<string, RawBankEntry>();
  for (const e of bankList) {
    const qid = asStr(e.quizId);
    if (qid) bankByQuizId.set(qid, e);
  }

  const reviewCache = new Map<string, Map<string, string[]>>();
  const reviewFlagsOf = (doc: string, questionId: string, status: string, confidence: number): string[] => {
    if (status !== "needs_review") return [];
    let byQuestion = reviewCache.get(doc);
    if (!byQuestion) {
      byQuestion = new Map<string, string[]>();
      const stagesFile = join(outRoot, doc, "stages.json");
      if (existsSync(stagesFile)) {
        try {
          const json = readJson(stagesFile);
          const reviews = isRec(json) && Array.isArray(json.reviews) ? (json.reviews as RawStageReview[]) : [];
          for (const r of reviews) {
            if (!isRec(r)) continue;
            const qid = asStr(r.questionId);
            const reason = asStr(r.reason);
            if (!qid || !reason) continue;
            const list = byQuestion.get(qid) ?? [];
            if (!list.includes(reason)) list.push(reason);
            byQuestion.set(qid, list);
          }
        } catch {
          /* stages.json 只是 reviewFlags 的补充来源；读不了就退回通用说明，不阻断导出 */
        }
      }
      reviewCache.set(doc, byQuestion);
    }
    const reasons = byQuestion.get(questionId) ?? [];
    return reasons.length ? [...reasons] : [`待复核（置信度 ${confidence}）`];
  };

  const built: Topic[] = [];
  for (const topic of [...topics.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
    const items: TopicItem[] = [];
    for (const [questionId, { q, doc: docId, levels, sources }] of topic.entries) {
      if (levels.size !== 1) {
        errors.push(`层级冲突：专题「${topic.name}」里的 ${questionId} 同时有多个层级（${[...levels].join("/")}）`);
        continue;
      }
      const level = [...levels][0]!;
      const stem = asStr(q.stem);
      if (!stem.trim()) {
        errors.push(`缺题干：${docId} · ${topic.name} · ${questionId}（快照里的 stem 为空）`);
        continue;
      }
      const bank = bankByQuizId.get(questionId);
      if (!bank) {
        errors.push(`缺答案：${docId} · ${topic.name} · ${questionId}（bank.json 里没有该题）`);
        continue;
      }
      const answerKey = asStr(bank.answerKey);
      const answerText = asStr(bank.answerText);
      const answerDoc = asStr(bank.answerDoc);
      const answerImages = imagesOf(bank.answerImages, `答案图 ${questionId}`, errors);
      if (!answerKey && !answerText && answerImages.length === 0) {
        errors.push(`缺答案：${docId} · ${topic.name} · ${questionId}（bank 条目没有 answerKey / answerText / answerImages）`);
        continue;
      }
      if (answerImages.length && !answerDoc) {
        errors.push(`缺答案：${docId} · ${topic.name} · ${questionId}（答案图存在但 bank 条目缺 answerDoc，无法定位文件）`);
        continue;
      }
      const images = imagesOf(q.images, `题图 ${questionId}`, errors);
      for (const im of images) {
        if (!existsSync(join(outRoot, docId, "images", im.path))) {
          errors.push(`缺图：${docId} · ${topic.name} · ${questionId} 的题图不存在：${im.path}`);
        }
      }
      for (const im of answerImages) {
        if (!existsSync(join(outRoot, answerDoc, "images", im.path))) {
          errors.push(`缺图：${answerDoc} · ${topic.name} · ${questionId} 的答案图不存在：${im.path}`);
        }
      }
      const status = asStr(q.status) || "ok";
      const confidence = typeof q.confidence === "number" ? q.confidence : 0;
      items.push({
        doc: docId,
        number: asStr(q.number),
        page: pageOf(q),
        questionId,
        level,
        stem,
        options: optionsOf(q, `${topic.name} · ${questionId}`, errors),
        images,
        answerKey,
        answerText,
        answerDoc,
        answerImages: answerImages.map((im) => ({ doc: answerDoc, ...im })),
        status,
        confidence,
        reviewFlags: reviewFlagsOf(docId, questionId, status, confidence),
        sources: [...sources].sort(),
      });
    }
    items.sort((a, b) => a.doc.localeCompare(b.doc, "zh") || a.page - b.page || numCompare(a.number, b.number));
    built.push({ slug: topic.slug, name: topic.name, items });
  }

  if (errors.length) {
    return { index: null, errors: [...new Set(errors)].sort(), warnings };
  }

  const allItems = built.flatMap((t) => t.items);
  const index: TopicIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    topics: built,
    stats: {
      topics: built.length,
      items: allItems.length,
      needsReview: allItems.filter((x) => x.status === "needs_review").length,
      byLevel: {
        基础: allItems.filter((x) => x.level === "基础").length,
        培优: allItems.filter((x) => x.level === "培优").length,
      },
    },
  };
  return { index, errors: [], warnings };
}

/** 题号排序：数字优先按数值（2 < 10），非数字按字面 */
function numCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, "zh");
}

/** 落盘（原子替换：中断不会留下半截 JSON）。 */
export function writeTopicIndex(root: string, index: TopicIndex): string {
  const outFile = join(root, "data", "out", "topics", "index.json");
  mkdirSync(dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 1)}\n`, "utf8");
  renameSync(tmp, outFile);
  return outFile;
}

/** 导出状态落盘（成功/失败都写；页面据此识别「旧数据」）。 */
export function writeTopicExportStatus(root: string, status: TopicExportStatus): string {
  const outFile = join(root, "data", "out", "topics", "export-status.json");
  mkdirSync(dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 1)}\n`, "utf8");
  renameSync(tmp, outFile);
  return outFile;
}

/** 旧 index 里的 (专题名, questionId) 集合；不存在/读不了 ⇒ null */
function readOldIndexPairs(root: string): Set<string> | null {
  const file = join(root, "data", "out", "topics", "index.json");
  if (!existsSync(file)) return null;
  try {
    const json = readJson(file);
    if (!isRec(json) || !Array.isArray(json.topics)) return null;
    const pairs = new Set<string>();
    for (const t of json.topics) {
      if (!isRec(t) || !Array.isArray(t.items)) continue;
      const topic = asStr(t.name);
      if (!topic) continue;
      for (const item of t.items) {
        if (isRec(item) && asStr(item.questionId)) pairs.add(`${topic}\u0000${asStr(item.questionId)}`);
      }
    }
    return pairs;
  } catch {
    return null;
  }
}

/**
 * 新旧 index 对比：
 * - **整个专题消失**（旧专题的题没有出现在任何新专题）⇒ error（改名时摘掉 `#` 是常见误操作，
 *   不能让专题悄悄没了；报错则不覆盖旧 index，页面/审计都会红）；
 * - 单个专题少了几条、或改名后题搬到别的专题 ⇒ warning（部分删题/改名是合法操作）。
 */
export function disappearedCheck(root: string, index: TopicIndex): { errors: string[]; warnings: string[] } {
  const oldPairs = readOldIndexPairs(root);
  if (!oldPairs) return { errors: [], warnings: [] };
  const oldByTopic = new Map<string, Set<string>>();
  for (const key of oldPairs) {
    const [topic, qid] = key.split("\u0000");
    if (!topic || !qid) continue;
    const set = oldByTopic.get(topic) ?? new Set<string>();
    set.add(qid);
    oldByTopic.set(topic, set);
  }
  const newByTopic = new Map<string, Set<string>>();
  for (const t of index.topics) newByTopic.set(t.name, new Set(t.items.map((x) => x.questionId)));
  const allNew = new Set<string>();
  for (const set of newByTopic.values()) for (const qid of set) allNew.add(qid);

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [topic, oldQids] of oldByTopic) {
    const newQids = newByTopic.get(topic);
    if (!newQids) {
      const missing = [...oldQids].filter((qid) => !allNew.has(qid));
      if (missing.length) {
        errors.push(
          `专题消失：旧「${topic}」有 ${missing.length} 题没有出现在任何新专题（改名时摘掉 #？）⇒ 不覆盖旧 index；如确要删除该专题，先清空/改名旧 index 再导出`,
        );
      } else {
        warnings.push(`专题改名/合并：旧「${topic}」的题已出现在其它专题`);
      }
      continue;
    }
    const gone = [...oldQids].filter((qid) => !newQids.has(qid));
    if (gone.length) {
      const shown = gone.slice(0, 6).join("、");
      const more = gone.length > 6 ? `；另有 ${gone.length - 6} 条` : "";
      warnings.push(`专题条目减少：「${topic}」少 ${gone.length} 题（${shown}${more}）`);
    }
  }
  return { errors, warnings };
}

/** 磁盘上现有 index.json 的 generatedAt（没有/读不了 ⇒ null） */
function readIndexGeneratedAt(root: string): string | null {
  const file = join(root, "data", "out", "topics", "index.json");
  if (!existsSync(file)) return null;
  try {
    const json = readJson(file);
    return isRec(json) && typeof json.generatedAt === "string" ? json.generatedAt : null;
  } catch {
    return null;
  }
}

/* ── CLI ── */

function main(): void {
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? (process.argv[i + 1] ?? process.cwd()) : process.cwd());
  const { index, errors, warnings } = buildTopicIndex(root);
  if (!index) {
    const at = new Date().toISOString();
    for (const w of warnings) console.log(`⚠️  ${w}`);
    try {
      const statusFile = writeTopicExportStatus(root, {
        ok: false,
        at,
        errors,
        warnings,
        indexGeneratedAt: readIndexGeneratedAt(root),
      });
      console.log(`✗ 专题导出失败：${errors.length} 处问题（未覆盖 index.json；状态写入 ${statusFile}）`);
    } catch (e) {
      console.log(`✗ 专题导出失败：${errors.length} 处问题（状态也写不了：${String(e)}）`);
    }
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
  const diff = disappearedCheck(root, index);
  if (diff.errors.length) {
    const at = new Date().toISOString();
    try {
      writeTopicExportStatus(root, {
        ok: false,
        at,
        errors: diff.errors,
        warnings: [...warnings, ...diff.warnings],
        indexGeneratedAt: readIndexGeneratedAt(root),
      });
    } catch {
      /* 状态写不了也要在 stdout 说清 */
    }
    console.log(`✗ 专题导出失败：${diff.errors.length} 处问题（未覆盖 index.json）`);
    for (const e of diff.errors) console.log(`  - ${e}`);
    process.exit(1);
  }
  const allWarnings = [...new Set([...warnings, ...diff.warnings])];
  for (const w of allWarnings) console.log(`⚠️  ${w}`);
  let file: string;
  try {
    file = writeTopicIndex(root, index);
  } catch (e) {
    const at = new Date().toISOString();
    const msg = `index.json 写入失败：${String(e)}`;
    try {
      writeTopicExportStatus(root, { ok: false, at, errors: [msg], warnings: allWarnings, indexGeneratedAt: readIndexGeneratedAt(root) });
    } catch {
      /* 状态也写不了，下面 stdout 报 */
    }
    console.log(`✗ ${msg}（旧 index 未覆盖）`);
    process.exit(1);
  }
  try {
    writeTopicExportStatus(root, {
      ok: true,
      at: new Date().toISOString(),
      errors: [],
      warnings: allWarnings,
      indexGeneratedAt: index.generatedAt,
    });
  } catch (e) {
    console.log(`⚠️  导出状态写入失败：${String(e)}（页面会提示「无法确认数据新鲜度」）`);
  }
  console.log(
    `专题导出：${index.stats.topics} 个专题 / ${index.stats.items} 道题（基础 ${index.stats.byLevel.基础} · 培优 ${index.stats.byLevel.培优} · 待复核 ${index.stats.needsReview}）`,
  );
  for (const t of index.topics) {
    const levels = LEVELS.map((lv) => `${lv} ${t.items.filter((x) => x.level === lv).length}`).join(" / ");
    console.log(`  ✓ ${t.name}：${t.items.length} 题（${levels}）`);
  }
  console.log(`落盘 ${file}`);
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
