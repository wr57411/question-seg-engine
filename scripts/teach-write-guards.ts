// scripts/teach-write-guards.ts
/**
 * 教学归类写通道的守卫（专题 / 类别 / 每题归属）。
 *
 * 这是本项目**第二条写路径**（第一条是题目标签）。判据取最严：
 * - scope 只认 `topics` / `categories` / `bindings`；
 * - `bindings` 的 doc 必须是 `data/out/<doc>/stages.json` 真实存在的目录名；
 * - 拼出的目标路径必须仍在 `data/out/teach/` 内；
 * - 载荷形状不对（缺字段、重复 id/name、重复 questionId、非法 anchor）一律不落盘。
 *
 * 与 `tag-write-guards.ts` 分开：业务标签与教学类别是两套语义（ADR-0001），
 * 守卫也不共用，避免以后一方放宽影响另一方。
 */
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const MAX_BODY = 2 * 1024 * 1024; // 2 MB：单人教学归类用不到，超出即视为异常输入

const DOC_MAX_LEN = 120;
const ID_MAX_LEN = 80;
const NAME_MAX_LEN = 60;
const BAD_DOC_CHARS = /[/\\]|\.\.|[\0-\u001f\u007f]/;

export const TEACH_SCOPES = ["topics", "categories", "bindings", "combos"] as const;
export type TeachScope = (typeof TEACH_SCOPES)[number];

const isStr = (v: unknown): v is string => typeof v === "string";
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function isTeachScope(v: unknown): v is TeachScope {
  return typeof v === "string" && (TEACH_SCOPES as readonly string[]).includes(v);
}

/** doc 必须是 `data/out/<doc>/stages.json` 真实存在的目录名：目录名即白名单。 */
export async function isKnownDoc(root: string, doc: unknown): Promise<boolean> {
  if (typeof doc !== "string" || !doc || doc.length > DOC_MAX_LEN) return false;
  if (BAD_DOC_CHARS.test(doc)) return false;
  const info = await stat(join(root, "data", "out", doc, "stages.json")).catch(() => null);
  return !!info?.isFile();
}

function safeDocName(doc: string): boolean {
  return !!doc && doc.length <= DOC_MAX_LEN && !BAD_DOC_CHARS.test(doc);
}

/** 落盘目标必须仍在 `data/out/teach/` 内（服务端拼路径，客户端只给 scope/doc）。 */
export function teachFilePath(root: string, scope: TeachScope, doc: string): string | null {
  const base = resolve(join(root, "data", "out", "teach"));
  let file: string;
  if (scope === "topics") file = join(base, "topics.json");
  else if (scope === "categories") file = join(base, "categories.json");
  else if (scope === "combos") file = join(base, "combos.json");
  else {
    if (!safeDocName(doc)) return null;
    file = join(base, "bindings", `${doc}.json`);
  }
  const resolved = resolve(file);
  return resolved.startsWith(base + sep) ? resolved : null;
}

/** 校验清单项（专题/类别）的 id/name；返回错误说明或 null。 */
function validateList(scope: "topics" | "categories", list: unknown): string | null {
  if (!Array.isArray(list)) return `${scope} 必须是数组`;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of list) {
    if (!isRec(raw)) return `${scope} 元素必须是对象`;
    const id = raw.id;
    const name = raw.name;
    if (!isStr(id) || !id.trim() || id.length > ID_MAX_LEN) return `${scope}.id 必须是非空字符串（≤${ID_MAX_LEN}）`;
    if (!isStr(name) || !name.trim() || name.length > NAME_MAX_LEN) return `${scope}.name 必须是非空字符串（≤${NAME_MAX_LEN}）`;
    if (raw.createdAt !== undefined && !isStr(raw.createdAt)) return `${scope}.createdAt 必须是字符串`;
    // 软删除（下架）标记：retired 只能是 true，retiredAt 是时间字符串
    if (raw.retired !== undefined && raw.retired !== true) return `${scope}.retired 只能是 true（不下架就不写这个字段）`;
    if (raw.retiredAt !== undefined && !isStr(raw.retiredAt)) return `${scope}.retiredAt 必须是字符串`;
    if (ids.has(id)) return `${scope}.id 重复：${id}`;
    if (names.has(name.trim())) return `${scope}.name 重复：${name.trim()}`;
    ids.add(id);
    names.add(name.trim());
  }
  return null;
}

function validateAnchor(anchor: unknown, at: string): string | null {
  if (anchor === undefined || anchor === null) return null;
  if (!isRec(anchor)) return `${at}.anchor 必须是对象`;
  if (anchor.page !== undefined && (typeof anchor.page !== "number" || !Number.isFinite(anchor.page))) {
    return `${at}.anchor.page 必须是数字`;
  }
  for (const k of ["number", "section", "firstText"] as const) {
    if (anchor[k] !== undefined && !isStr(anchor[k])) return `${at}.anchor.${k} 必须是字符串`;
  }
  return null;
}

function validateBindings(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.bindings)) return "bindings 必须是数组";
  if (!Array.isArray(body.stale)) return "stale 必须是数组";
  const seen = new Set<string>();
  for (const [group, list] of [
    ["bindings", body.bindings],
    ["stale", body.stale],
  ] as const) {
    for (const [i, raw] of (list as unknown[]).entries()) {
      const at = `${group}[${i}]`;
      if (!isRec(raw)) return `${at} 必须是对象`;
      if (!isStr(raw.questionId) || !raw.questionId.trim()) return `${at}.questionId 必须是非空字符串`;
      const qid = raw.questionId.trim();
      if (seen.has(qid)) return `questionId 在 bindings/stale 中重复：${qid}`;
      seen.add(qid);
      for (const key of ["topicIds", "categoryIds"] as const) {
        const arr = raw[key];
        if (!Array.isArray(arr) || !arr.every(isStr)) return `${at}.${key} 必须是字符串数组`;
        if (new Set(arr).size !== arr.length) return `${at}.${key} 有重复 id`;
      }
      const aerr = validateAnchor(raw.anchor, at);
      if (aerr) return aerr;
      if (group === "stale" && raw.driftedAt !== undefined && !isStr(raw.driftedAt)) {
        return `${at}.driftedAt 必须是字符串`;
      }
    }
  }
  return null;
}

function validateCombos(list: unknown): string | null {
  if (!Array.isArray(list)) return "combos 必须是数组";
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of list) {
    if (!isRec(raw)) return "combos 元素必须是对象";
    const id = raw.id;
    const name = raw.name;
    if (!isStr(id) || !id.trim() || id.length > ID_MAX_LEN) return `combos.id 必须是非空字符串（≤${ID_MAX_LEN}）`;
    if (!isStr(name) || !name.trim() || name.length > NAME_MAX_LEN) return `combos.name 必须是非空字符串（≤${NAME_MAX_LEN}）`;
    if (raw.createdAt !== undefined && !isStr(raw.createdAt)) return "combos.createdAt 必须是字符串";
    if (raw.retired !== undefined && raw.retired !== true) return "combos.retired 只能是 true";
    if (raw.retiredAt !== undefined && !isStr(raw.retiredAt)) return "combos.retiredAt 必须是字符串";
    if (ids.has(id)) return `combos.id 重复：${id}`;
    if (names.has(name.trim())) return `combos.name 重复：${name.trim()}`;
    for (const key of ["topicIds", "categoryIds"] as const) {
      const arr = raw[key];
      if (!Array.isArray(arr) || !arr.every(isStr)) return `combos.${key} 必须是字符串数组`;
      if (new Set(arr).size !== arr.length) return `combos.${key} 有重复 id`;
    }
    const topicIds = raw.topicIds as string[];
    const categoryIds = raw.categoryIds as string[];
    if (!topicIds.length && !categoryIds.length) return "combos 至少要有 1 个专题或类别";
    ids.add(id);
    names.add(name.trim());
  }
  return null;
}

/** 只校验「能不能安全落盘」的最小结构；语义正确性由导出/审计负责。 */
export function validateTeachPayload(scope: TeachScope, body: unknown): string | null {
  if (!isRec(body)) return "载荷必须是 JSON 对象";
  if (body.version !== 1) return "version 必须为 1";
  if (scope === "topics") return validateList("topics", body.topics);
  if (scope === "categories") return validateList("categories", body.categories);
  if (scope === "combos") return validateCombos(body.combos);
  return validateBindings(body);
}
