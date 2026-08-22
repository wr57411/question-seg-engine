/**
 * viewer/doc-utils 的类型声明 —— 供 node:test / typecheck 消费。
 * 纯函数、无 DOM；与 doc-utils.js 同步。
 * 红线：本文件不得 import src/ 下的任何内容。
 */

export const DEFAULT_DOC: string;

export function resolveDoc(search: string): string;

export type Fetcher = (doc: string) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

export function loadWithFallback(fetcher: Fetcher, doc: string): Promise<unknown>;
