// scripts/audit-topic.ts
/**
 * 专题量化门：**独立复核** `data/out/topics/index.json` 与源的一致性。
 *
 * ## 为什么重新实现一遍（不同源原则，HANDOFF 红线 G7）
 * 如果审计直接 import `topic-export.ts` 的解析/合并函数，导出的 bug 会原样复制到审计里，
 * 「审计通过」就退化成「导出现在自己跟自己对得上」。所以本文件：
 * - **不 import** `scripts/topic-export.ts`；
 * - 不信 index 自带的 stats，也不信 item 里的答案/图片字段；
 * - 重新读 tags / 手工题单 / questions.json / bank.json / 文件系统，独立推导「应该是哪些题」，
 *   再与 index 逐项比对（专题集合、题目集合、层级、题干/选项/页码/状态、图片路径与存在性、
 *   答案键/答案文本/答案图）。
 *
 * 缺题 / 缺答案 / 缺图 / 集合不一致 / stats 说谎 ⇒ 退出码 1。
 * 暂不接入 `npm run check`（SPEC D04，接入时须先反向验证）。
 *
 * 用法：`npm run audit:topic`（`--root <dir>` 供单测/夹具复核）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface IndexItem {
  doc?: unknown;
  number?: unknown;
  page?: unknown;
  questionId?: unknown;
  level?: unknown;
  stem?: unknown;
  options?: unknown;
  images?: unknown;
  answerKey?: unknown;
  answerText?: unknown;
  answerDoc?: unknown;
  answerImages?: unknown;
  status?: unknown;
  confidence?: unknown;
  reviewFlags?: unknown;
  sources?: unknown;
}

interface IndexTopic {
  slug?: unknown;
  name?: unknown;
  items?: unknown;
}

interface Expected {
  topic: string;
  questionId: string;
  doc: string;
  level: "基础" | "培优";
  from: "tag" | "manual";
  /** 标签绑定的锚点（独立核对漂移） */
  anchor?: Record<string, unknown>;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const isLevel = (v: unknown): v is "基础" | "培优" => v === "基础" || v === "培优";
const PRESET_TAG_IDS = new Set(["t-hao", "t-gai", "t-jiao", "t-liu", "t-nan"]);

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 与导出脚本同约定、但独立实现：最后一个 `#` 前是专题名，后是层级。 */
function splitTag(tagId: string): { name: string; level: "基础" | "培优" } | null | "non-topic" {
  if (!tagId.includes("#")) return "non-topic";
  const cut = tagId.lastIndexOf("#");
  const name = tagId.slice(0, cut).trim();
  const level = tagId.slice(cut + 1).trim();
  if (!name || !isLevel(level)) return null;
  return { name, level };
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(suffix))
    .sort()
    .map((n) => join(dir, n));
}

function pageOf(q: Record<string, unknown>): number {
  const src = isRec(q.source) ? q.source : null;
  const idx = src?.pageIndex;
  return typeof idx === "number" && Number.isFinite(idx) ? idx + 1 : 0;
}

/** 比对用文本：去掉空白、标点与 LaTeX 记号，只留字母/数字/汉字。 */
function normText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "");
}

/** 标签锚点独立核对：页码/题号/首行文本。问题=红；弱 anchor=告警。 */
function anchorCheck(q: Record<string, unknown>, anchor: Record<string, unknown> | undefined): { problem: string | null; warning: string | null } {
  if (!anchor) return { problem: null, warning: "缺少 anchor（无法核对标签是否已漂移）" };
  const page = typeof anchor.page === "number" && Number.isFinite(anchor.page) ? anchor.page : null;
  const number = asStr(anchor.number);
  const firstText = asStr(anchor.firstText);
  if (page !== null && pageOf(q) !== page) {
    return { problem: `anchor 记的是 p${page}，当前是 p${pageOf(q)}`, warning: null };
  }
  if (number && asStr(q.number) !== number) {
    return { problem: `anchor 记的是第 ${number} 题，当前是第 ${asStr(q.number) || "?"} 题`, warning: null };
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
      problem: `anchor 首行「${firstText}」与当前题干「${asStr(q.stem).slice(0, 24)}…」对不上`,
      warning: null,
    };
  }
  return { problem: null, warning: null };
}

export interface AuditResult {
  errors: string[];
  warnings: string[];
  summary: {
    topics: { name: string; items: number; byLevel: Record<"基础" | "培优", number> }[];
    items: number;
    needsReview: number;
  } | null;
}

export function auditTopicIndex(root: string): AuditResult {
  const outRoot = join(root, "data", "out");
  const errors: string[] = [];
  const warnings: string[] = [];

  const indexFile = join(outRoot, "topics", "index.json");
  if (!existsSync(indexFile)) {
    return {
      errors: [`专题索引不存在：${indexFile} ⇒ 先跑 npm run topic:export`],
      warnings: [],
      summary: null,
    };
  }
  let indexJson: unknown;
  try {
    indexJson = readJson(indexFile);
  } catch (e) {
    return { errors: [`专题索引解析失败：${String(e)}`], warnings: [], summary: null };
  }
  if (!isRec(indexJson) || indexJson.version !== 1 || !Array.isArray(indexJson.topics)) {
    return { errors: ["专题索引形状不对：需要 {version:1, topics:[...]}"], warnings: [], summary: null };
  }
  const topics = indexJson.topics as IndexTopic[];
  const indexGeneratedAt = asStr(indexJson.generatedAt);
  if (!indexGeneratedAt) errors.push("索引缺 generatedAt");

  /* ── 0. 导出状态：上次导出失败 / 索引与状态不一致，都必须红 ── */
  const statusFile = join(outRoot, "topics", "export-status.json");
  if (!existsSync(statusFile)) {
    errors.push("缺少 data/out/topics/export-status.json ⇒ 重新跑 npm run topic:export（无法判断索引是否本次产物）");
  } else {
    try {
      const status = readJson(statusFile);
      if (!isRec(status)) {
        errors.push("export-status.json 形状不对");
      } else {
        if (status.ok !== true) {
          const errs = Array.isArray(status.errors) ? status.errors.map(String) : [];
          errors.push(`上次导出失败（status.ok=false）⇒ 当前 index.json 是旧数据${errs.length ? `：${errs.join("；")}` : ""}`);
        } else if (Array.isArray(status.errors) && status.errors.length) {
          errors.push(`export-status 自称成功却带着 ${status.errors.length} 条错误，状态自相矛盾`);
        }
        if (asStr(status.indexGeneratedAt) !== indexGeneratedAt) {
          errors.push(
            `索引与导出状态不一致：index.generatedAt=${indexGeneratedAt || "(空)"} / status.indexGeneratedAt=${asStr(status.indexGeneratedAt) || "(空)"}（可能被手工改过或是旧产物）`,
          );
        }
      }
    } catch (e) {
      errors.push(`export-status.json 解析失败：${String(e)}`);
    }
  }

  /* ── 1. 独立推导「应该是哪些题」 ── */
  const expected: Expected[] = [];

  /** 标签库 id → name（面板新建的标签只存 id） */
  const library = new Map<string, string>();
  const libraryFile = join(outRoot, "tags", "library.json");
  const libraryFound = existsSync(libraryFile);
  if (libraryFound) {
    try {
      const json = readJson(libraryFile);
      if (!isRec(json) || !Array.isArray(json.tags)) {
        errors.push("标签库形状不对：data/out/tags/library.json 需要 {version:1, tags:[{id,name,...}]}");
      } else {
        for (const t of json.tags) {
          if (!isRec(t)) continue;
          const id = asStr(t.id);
          const name = asStr(t.name);
          if (!id || !name) continue;
          if (library.has(id)) errors.push(`标签库 id 重复：${id}`);
          library.set(id, name);
        }
      }
    } catch (e) {
      errors.push(`标签库解析失败：${String(e)}`);
    }
  }

  /** 与导出同口径（但独立实现）：库在但 id 找不到 / 库丢了都不能静默。 */
  const resolveTagName = (tagId: string, where: string): string => {
    const name = library.get(tagId);
    if (name) return name;
    if (tagId.includes("#")) return tagId; // 历史/种子直接写专题名
    if (libraryFound && tagId.startsWith("t-")) {
      errors.push(`标签库缺 id：${where} 的 ${tagId}`);
    } else if (!libraryFound && tagId.startsWith("t-") && !PRESET_TAG_IDS.has(tagId)) {
      errors.push(`标签库缺失：${where} 的 ${tagId} 无法解析名字（library.json 不存在）`);
    }
    return tagId;
  };

  for (const file of listFiles(join(outRoot, "tags"), ".json")) {
    const name = file.slice(file.lastIndexOf("/") + 1, -".json".length);
    if (name === "library") continue;
    let json: unknown;
    try {
      json = readJson(file);
    } catch (e) {
      errors.push(`标签文件解析失败：${name}.json —— ${String(e)}`);
      continue;
    }
    if (!isRec(json) || !Array.isArray(json.bindings)) {
      errors.push(`标签文件缺少 bindings：${name}.json`);
      continue;
    }
    for (const b of json.bindings) {
      if (!isRec(b)) continue;
      const questionId = asStr(b.questionId);
      if (!questionId) {
        errors.push(`标签绑定缺少 questionId：${name}.json`);
        continue;
      }
      const tagIds = Array.isArray(b.tagIds) ? b.tagIds.filter((t): t is string => typeof t === "string") : [];
      for (const tagId of tagIds) {
        const tagName = resolveTagName(tagId, `${name} · ${questionId}`);
        const parsed = splitTag(tagName);
        if (parsed === "non-topic") continue;
        if (!parsed) {
          errors.push(`标签格式不合约定（${name} · ${questionId} · ${tagName}）：${JSON.stringify(tagName)}`);
          continue;
        }
        expected.push({
          topic: parsed.name,
          questionId,
          doc: name,
          level: parsed.level,
          from: "tag",
          anchor: isRec(b.anchor) ? b.anchor : undefined,
        });
      }
    }

    // stale 里的专题标签 = 切分后找不到原题；必须在审计里红（不能从专题里静默消失）
    const stale = Array.isArray(json.stale) ? json.stale : [];
    for (const b of stale) {
      if (!isRec(b)) continue;
      const questionId = asStr(b.questionId);
      const tagIds = Array.isArray(b.tagIds) ? b.tagIds.filter((t): t is string => typeof t === "string") : [];
      for (const tagId of tagIds) {
        const tagName = resolveTagName(tagId, `stale ${name} · ${questionId || "?"}`);
        const parsed = splitTag(tagName);
        if (parsed && parsed !== "non-topic") {
          errors.push(`标签失效（stale）：${name} · ${questionId || "?"} · 专题「${parsed.name}」—— 专题会缺这道题`);
        } else if (parsed === null) {
          errors.push(`标签格式不合约定（stale ${name} · ${questionId || "?"} · ${tagName}）`);
        }
      }
    }
  }

  const questionsByDoc = new Map<string, Record<string, unknown>[] | null>();
  const questionsOf = (doc: string): Record<string, unknown>[] | null => {
    if (questionsByDoc.has(doc)) return questionsByDoc.get(doc) ?? null;
    const file = join(outRoot, doc, "questions.json");
    if (!existsSync(file)) {
      questionsByDoc.set(doc, null);
      return null;
    }
    try {
      const json = readJson(file);
      const list = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
      questionsByDoc.set(doc, list);
      return list;
    } catch (e) {
      errors.push(`题目快照解析失败：${doc}/questions.json —— ${String(e)}`);
      questionsByDoc.set(doc, null);
      return null;
    }
  };

  for (const file of listFiles(join(outRoot, "topics"), ".topic.json")) {
    const stem = file.slice(file.lastIndexOf("/") + 1, -".topic.json".length);
    let json: unknown;
    try {
      json = readJson(file);
    } catch (e) {
      errors.push(`手工题单解析失败：${stem}.topic.json —— ${String(e)}`);
      continue;
    }
    if (!isRec(json) || !Array.isArray(json.items)) {
      errors.push(`手工题单缺少 items：${stem}.topic.json`);
      continue;
    }
    const topicName = asStr(json.name).trim();
    if (!topicName) {
      errors.push(`手工题单缺少 name：${stem}.topic.json`);
      continue;
    }
    for (const [i, item] of json.items.entries()) {
      if (!isRec(item)) continue;
      const at = `${stem}.topic.json items[${i}]`;
      const doc = asStr(item.doc).trim();
      const questionId = asStr(item.questionId).trim();
      const number = asStr(item.number).trim();
      const page = typeof item.page === "number" && Number.isFinite(item.page) ? item.page : undefined;
      if (!doc || !isLevel(item.level)) {
        errors.push(`手工题单条目缺 doc 或层级非法：${at}`);
        continue;
      }
      if (!questionId && !number) {
        errors.push(`手工题单条目缺 questionId/number：${at}`);
        continue;
      }
      if (questionId) {
        const list = questionsOf(doc);
        if (!list) {
          errors.push(`缺题：${doc}/questions.json 不存在（${at}）`);
        } else if (!list.some((q) => asStr(q.id) === questionId)) {
          errors.push(`缺题：${doc} 找不到 ${questionId}（${at}）`);
        } else {
          expected.push({ topic: topicName, questionId, doc, level: item.level, from: "manual" });
        }
        continue;
      }
      const list = questionsOf(doc);
      if (!list) {
        errors.push(`缺题：${doc}/questions.json 不存在（${at}）`);
        continue;
      }
      let candidates = list.filter((q) => asStr(q.number).trim() === number);
      if (page !== undefined) candidates = candidates.filter((q) => pageOf(q) === page);
      if (candidates.length !== 1) {
        errors.push(
          candidates.length === 0
            ? `缺题：${doc} 找不到题号 ${number}${page !== undefined ? `（第 ${page} 页）` : ""}（${at}）`
            : `题号歧义：${doc} 题号 ${number} 命中 ${candidates.length} 道题（${at}）`,
        );
        continue;
      }
      expected.push({ topic: topicName, questionId: asStr(candidates[0]!.id), doc, level: item.level, from: "manual" });
    }
  }

  /* ── 1b. 标签漂移独立核对：源绑定指向的题必须仍是 anchor 记的那道题 ── */
  for (const e of expected) {
    if (e.from !== "tag") continue;
    const list = questionsOf(e.doc);
    if (!list) continue; // 缺文档已由上面的 questionsOf 记录
    const q = list.find((x) => asStr(x.id) === e.questionId);
    if (!q) {
      errors.push(`缺题：${e.doc} 找不到 ${e.questionId}（标签「${e.topic}」指向的题不在快照里）`);
      continue;
    }
    const check = anchorCheck(q, e.anchor);
    if (check.problem) errors.push(`标签漂移：${e.doc} · ${e.questionId} · 专题「${e.topic}」 —— ${check.problem}`);
    if (check.warning) warnings.push(`标签 anchor 较弱：${e.doc} · ${e.questionId} · 专题「${e.topic}」 —— ${check.warning}`);
  }
  if (!libraryFound && expected.some((e) => e.from === "tag")) {
    warnings.push("标签库 data/out/tags/library.json 不存在：t- 绑定只能按预置 id 理解，专题标签可能漏导出");
  }

  /* ── 2. 答案池 ── */
  const bankByQuizId = new Map<string, Record<string, unknown>>();
  const bankFile = join(outRoot, "bank", "bank.json");
  if (existsSync(bankFile)) {
    try {
      const json = readJson(bankFile);
      if (Array.isArray(json)) {
        for (const e of json) {
          if (isRec(e) && typeof e.quizId === "string") bankByQuizId.set(e.quizId, e);
        }
      }
    } catch (e) {
      errors.push(`答案池解析失败：bank/bank.json —— ${String(e)}`);
    }
  }

  /* ── 3. 索引侧：扁平化 + 守恒 ── */
  const indexEntries: { topic: string; questionId: string; item: IndexItem }[] = [];
  const seen = new Set<string>();
  for (const t of topics) {
    if (!isRec(t)) {
      errors.push("topics 元素不是对象");
      continue;
    }
    const topicName = asStr(t.name);
    if (!topicName) {
      errors.push("专题缺少 name");
      continue;
    }
    if (!Array.isArray(t.items)) {
      errors.push(`专题「${topicName}」缺少 items 数组`);
      continue;
    }
    if (t.items.length === 0) errors.push(`专题「${topicName}」没有题目`);
    for (const item of t.items) {
      if (!isRec(item)) {
        errors.push(`专题「${topicName}」有非对象条目`);
        continue;
      }
      const questionId = asStr(item.questionId);
      if (!questionId) {
        errors.push(`专题「${topicName}」有条目缺 questionId`);
        continue;
      }
      const key = `${topicName}\u0000${questionId}`;
      if (seen.has(key)) {
        errors.push(`索引重复：专题「${topicName}」里的 ${questionId} 出现多次（守恒失败）`);
        continue;
      }
      seen.add(key);
      indexEntries.push({ topic: topicName, questionId, item });
    }
  }

  const expectedKeys = new Set<string>();
  for (const e of expected) {
    const key = `${e.topic}\u0000${e.questionId}`;
    if (expectedKeys.has(key)) {
      // 同一题在同一专题出现两次（标签 + 题单 / 两条标签）：层级必须一致
      const prev = expected.find((x) => x.topic === e.topic && x.questionId === e.questionId)!;
      if (prev.level !== e.level) {
        errors.push(`源数据层级冲突：专题「${e.topic}」里的 ${e.questionId} 同时是 ${prev.level}/${e.level}`);
      }
      continue;
    }
    expectedKeys.add(key);
  }
  const levelByKey = new Map<string, "基础" | "培优">();
  const sourcesByKey = new Map<string, Set<"tag" | "manual">>();
  for (const e of expected) {
    levelByKey.set(`${e.topic}\u0000${e.questionId}`, e.level);
    const key = `${e.topic}\u0000${e.questionId}`;
    const set = sourcesByKey.get(key) ?? new Set<"tag" | "manual">();
    set.add(e.from);
    sourcesByKey.set(key, set);
  }

  /** 独立重算 reviewFlags：stages.json 里该题的原因（去重），空则通用说明 */
  const stagesCache = new Map<string, Map<string, string[]>>();
  const expectedReviewFlags = (doc: string, questionId: string, status: string, confidence: unknown): string[] => {
    if (status !== "needs_review") return [];
    let byQuestion = stagesCache.get(doc);
    if (!byQuestion) {
      byQuestion = new Map<string, string[]>();
      const stagesFile = join(outRoot, doc, "stages.json");
      if (existsSync(stagesFile)) {
        try {
          const json = readJson(stagesFile);
          const reviews = isRec(json) && Array.isArray(json.reviews) ? json.reviews : [];
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
          /* 读不了就只靠通用说明；不阻断审计 */
        }
      }
      stagesCache.set(doc, byQuestion);
    }
    const reasons = byQuestion.get(questionId) ?? [];
    const conf = typeof confidence === "number" ? confidence : 0;
    return reasons.length ? [...reasons] : [`待复核（置信度 ${conf}）`];
  };

  for (const key of expectedKeys) {
    if (!seen.has(key)) {
      const [topic, qid] = key.split("\u0000");
      errors.push(`索引缺少条目：专题「${topic}」应有 ${qid}，但 index.json 里没有`);
    }
  }
  for (const key of seen) {
    if (!expectedKeys.has(key)) {
      const [topic, qid] = key.split("\u0000");
      errors.push(`索引多出条目：专题「${topic}」里的 ${qid} 不在源标签/题单里`);
    }
  }

  /* ── 4. 逐条回源核对（题干/选项/页码/状态/图片/答案） ── */
  const byDoc = new Map<string, Record<string, unknown>[]>();
  for (const { topic, questionId, item } of indexEntries) {
    const doc = asStr(item.doc);
    if (!doc) {
      errors.push(`条目缺 doc：${topic} · ${questionId}`);
      continue;
    }
    let list = byDoc.get(doc);
    if (!list) {
      const loaded = questionsOf(doc);
      if (!loaded) {
        errors.push(`缺题：${doc}/questions.json 不存在（索引条目 ${questionId}）`);
        continue;
      }
      list = loaded;
      byDoc.set(doc, list);
    }
    const q = list.find((x) => asStr(x.id) === questionId);
    if (!q) {
      errors.push(`缺题：${doc} 找不到 ${questionId}（索引里有，快照里没有）`);
      continue;
    }

    if (!asStr(q.stem).trim()) errors.push(`缺题干：${questionId}（快照里的 stem 为空）`);
    if (q.options !== undefined && q.options !== null && !Array.isArray(q.options)) {
      errors.push(`选项字段不是数组：${questionId}`);
    }
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (!isRec(o) || !asStr(o.text).trim()) errors.push(`选项文本为空/形状坏：${questionId}`);
      }
    }
    if (asStr(item.stem) !== asStr(q.stem)) errors.push(`题干不一致：${questionId}`);
    if (asStr(item.number) !== asStr(q.number)) errors.push(`题号不一致：${questionId}`);
    if (item.page !== pageOf(q)) errors.push(`页码不一致：${questionId}（索引 ${String(item.page)} / 源 ${pageOf(q)}）`);
    if (asStr(item.status) !== (asStr(q.status) || "ok")) errors.push(`状态不一致：${questionId}`);
    if (JSON.stringify(item.options) !== JSON.stringify(Array.isArray(q.options) ? q.options : [])) {
      errors.push(`选项不一致：${questionId}`);
    }
    const wantedLevel = levelByKey.get(`${topic}\u0000${questionId}`);
    if (wantedLevel && item.level !== wantedLevel) {
      errors.push(`层级不一致：${questionId}（索引 ${String(item.level)} / 源 ${wantedLevel}）`);
    }
    const wantedSources = [...(sourcesByKey.get(`${topic}\u0000${questionId}`) ?? [])].sort();
    if (JSON.stringify(item.sources) !== JSON.stringify(wantedSources)) {
      errors.push(`来源不一致：${questionId}（索引 ${JSON.stringify(item.sources)} / 源 ${JSON.stringify(wantedSources)}）`);
    }
    const srcConfidence = typeof q.confidence === "number" ? q.confidence : 0;
    if (item.confidence !== srcConfidence) {
      errors.push(`置信度不一致：${questionId}（索引 ${String(item.confidence)} / 源 ${srcConfidence}）`);
    }
    const wantedFlags = expectedReviewFlags(doc, questionId, asStr(q.status) || "ok", q.confidence);
    if (JSON.stringify(item.reviewFlags) !== JSON.stringify(wantedFlags)) {
      errors.push(`reviewFlags 不一致：${questionId}（索引 ${JSON.stringify(item.reviewFlags)} / 源 ${JSON.stringify(wantedFlags)}）`);
    }

    const srcImages = Array.isArray(q.images) ? q.images : [];
    if (JSON.stringify(item.images) !== JSON.stringify(srcImages)) {
      errors.push(`题图字段不一致：${questionId}`);
    }
    for (const im of Array.isArray(item.images) ? item.images : []) {
      const path = isRec(im) ? asStr(im.path) : "";
      if (!path || !existsSync(join(outRoot, doc, "images", path))) {
        errors.push(`缺图：${doc} · ${questionId} 的题图不存在：${path || "(空 path)"}`);
      }
    }

    const bank = bankByQuizId.get(questionId);
    if (!bank) {
      errors.push(`缺答案：${questionId}（bank.json 里没有该题）`);
      continue;
    }
    if (asStr(item.answerKey) !== asStr(bank.answerKey)) errors.push(`答案键不一致：${questionId}`);
    if (asStr(item.answerText) !== asStr(bank.answerText)) errors.push(`答案解析不一致：${questionId}`);
    const answerDoc = asStr(bank.answerDoc);
    if (asStr(item.answerDoc) !== answerDoc) {
      errors.push(`答案来源册不一致：${questionId}（索引 ${asStr(item.answerDoc) || "(空)"} / bank ${answerDoc || "(空)"}）`);
    }
    const srcAnswerImages = Array.isArray(bank.answerImages) ? bank.answerImages : [];
    const indexAnswerImages = Array.isArray(item.answerImages) ? item.answerImages : [];
    if (srcAnswerImages.length !== indexAnswerImages.length) {
      errors.push(`答案图数量不一致：${questionId}（索引 ${indexAnswerImages.length} / bank ${srcAnswerImages.length}）`);
    }
    if (srcAnswerImages.length && !answerDoc) {
      errors.push(`缺答案：${questionId} 的答案图缺 answerDoc，无法定位文件`);
    }
    for (const [i, im] of indexAnswerImages.entries()) {
      const src = srcAnswerImages[i];
      const path = isRec(im) ? asStr(im.path) : "";
      const docOfImage = isRec(im) ? asStr(im.doc) : "";
      if (!isRec(im) || !isRec(src) || docOfImage !== answerDoc || path !== asStr(src.path)) {
        errors.push(`答案图字段不一致：${questionId}[${i}]`);
      }
      const srcBbox = isRec(src) && Array.isArray(src.bbox) && src.bbox.every((n) => typeof n === "number") ? src.bbox : undefined;
      const idxBbox = isRec(im) && Array.isArray(im.bbox) && im.bbox.every((n) => typeof n === "number") ? im.bbox : undefined;
      if (JSON.stringify(idxBbox) !== JSON.stringify(srcBbox)) {
        errors.push(`答案图 bbox 不一致：${questionId}[${i}]`);
      }
      if (!path || !answerDoc || !existsSync(join(outRoot, answerDoc, "images", path))) {
        errors.push(`缺图：${answerDoc || "(缺 doc)"} · ${questionId} 的答案图不存在：${path || "(空 path)"}`);
      }
    }
    if (!asStr(bank.answerKey) && !asStr(bank.answerText) && srcAnswerImages.length === 0) {
      errors.push(`缺答案：${questionId}（bank 条目没有答案内容）`);
    }
  }

  /* ── 5. stats 不能自说自话：独立重算 ── */
  const summary = new Map<string, { items: number; byLevel: Record<"基础" | "培优", number> }>();
  for (const { topic, item } of indexEntries) {
    const s = summary.get(topic) ?? { items: 0, byLevel: { 基础: 0, 培优: 0 } };
    s.items += 1;
    if (isLevel(item.level)) s.byLevel[item.level] += 1;
    summary.set(topic, s);
  }
  const totalItems = indexEntries.length;
  const needsReview = indexEntries.filter(({ item }) => asStr(item.status) === "needs_review").length;
  const stats = isRec(indexJson.stats) ? indexJson.stats : null;
  if (!stats) {
    errors.push("索引缺 stats 对象");
  } else {
    if (stats.topics !== topics.length) errors.push(`stats.topics 说谎：索引 ${String(stats.topics)} / 实算 ${topics.length}`);
    if (stats.items !== totalItems) errors.push(`stats.items 说谎：索引 ${String(stats.items)} / 实算 ${totalItems}`);
    if (stats.needsReview !== needsReview) {
      errors.push(`stats.needsReview 说谎：索引 ${String(stats.needsReview)} / 实算 ${needsReview}`);
    }
    const byLevel = isRec(stats.byLevel) ? stats.byLevel : null;
    const calcBasic = indexEntries.filter(({ item }) => item.level === "基础").length;
    const calcPeiyou = indexEntries.filter(({ item }) => item.level === "培优").length;
    if (!byLevel || byLevel.基础 !== calcBasic || byLevel.培优 !== calcPeiyou) {
      errors.push(`stats.byLevel 说谎：索引 ${JSON.stringify(stats.byLevel)} / 实算 基础 ${calcBasic} · 培优 ${calcPeiyou}`);
    }
  }

  const summaryList = [...summary.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh"))
    .map(([name, s]) => ({ name, items: s.items, byLevel: s.byLevel }));

  return {
    errors: [...new Set(errors)].sort(),
    warnings: [...new Set(warnings)].sort(),
    summary: { topics: summaryList, items: totalItems, needsReview },
  };
}

function main(): void {
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? (process.argv[i + 1] ?? process.cwd()) : process.cwd());
  const { errors, warnings, summary } = auditTopicIndex(root);
  if (!summary) {
    console.log(`✗ ${errors.join("\n✗ ")}`);
    process.exit(1);
  }
  console.log(
    `专题审计：${summary.topics.length} 个专题 / ${summary.items} 道题（待复核 ${summary.needsReview}）`,
  );
  for (const t of summary.topics) {
    console.log(`  ${t.name}：${t.items} 题（基础 ${t.byLevel.基础} / 培优 ${t.byLevel.培优}）`);
  }
  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (errors.length) {
    console.log(`✗ 专题审计失败：${errors.length} 处问题`);
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
  console.log("✅ index.json 与源（标签/题单/快照/题库/文件系统）一致");
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
