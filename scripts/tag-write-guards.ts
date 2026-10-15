// scripts/tag-write-guards.ts
/**
 * 标签写通道的守卫（从 view-server.ts 拆出，为的是**能被单测打到**）。
 *
 * 这是本项目第一条写路径，判据取最严：宁可拒掉一次合法写入（用户重试），
 * 也不能让一个未经校验的路径名拼进 `fs.writeFile`。
 * 拆分前它只能靠人 curl，而"人记得 curl"从来不是回归防护。
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

export const MAX_BODY = 2 * 1024 * 1024; // 2 MB：单人手工标签用不到，超出即视为异常输入
const DOC_MAX_LEN = 120;
const BAD_DOC_CHARS = /[/\\]|\.\.|[\0-\u001f\u007f]/;

const isStr = (v: unknown): v is string => typeof v === "string";
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** doc 必须是 `data/out/<doc>/stages.json` 真实存在的目录名：目录名即白名单。 */
export async function isKnownDoc(root: string, doc: unknown): Promise<boolean> {
  if (typeof doc !== "string" || !doc || doc.length > DOC_MAX_LEN) return false;
  if (BAD_DOC_CHARS.test(doc)) return false;
  const info = await stat(join(root, "data", "out", doc, "stages.json")).catch(() => null);
  return !!info?.isFile();
}

/** 只校验「能不能安全落盘」的最小结构；语义正确性由前端负责。返回错误说明或 null（=通过）。 */
export function validatePayload(scope: string, body: unknown): string | null {
  if (!isRec(body)) return "载荷必须是 JSON 对象";
  if (body.version !== 1) return "version 必须为 1";
  if (scope === "library") {
    if (!Array.isArray(body.tags)) return "tags 必须是数组";
    const seen = new Set<string>();
    for (const t of body.tags as unknown[]) {
      if (!isRec(t)) return "tags 元素必须是对象";
      for (const k of ["id", "name", "short", "color"]) {
        if (!isStr(t[k])) return `tags.${k} 必须是字符串`;
      }
      if (seen.has(t.id as string)) return `tags.id 重复：${t.id}`;
      seen.add(t.id as string);
    }
    return null;
  }
  if (!Array.isArray(body.bindings)) return "bindings 必须是数组";
  if (!Array.isArray(body.stale)) return "stale 必须是数组";
  for (const b of [...(body.bindings as unknown[]), ...(body.stale as unknown[])]) {
    if (!isRec(b)) return "bindings/stale 元素必须是对象";
    if (!isStr(b.questionId)) return "questionId 必须是字符串";
    if (!Array.isArray(b.tagIds) || !(b.tagIds as unknown[]).every(isStr)) return "tagIds 必须是字符串数组";
  }
  return null;
}

/** 落盘目标必须仍在 `<root>/data/out/tags/` 内（服务端拼路径，客户端只给 doc/scope）。 */
export function tagFilePath(tagDir: string, scope: string, doc: string): string | null {
  const file = scope === "library" ? join(tagDir, "library.json") : join(tagDir, `${doc}.json`);
  const resolved = file.startsWith(tagDir + "/") || file === tagDir ? file : null;
  return resolved;
}
