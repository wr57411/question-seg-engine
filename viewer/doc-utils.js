// ============================================================
// viewer/doc-utils.js — 展示层 doc 解析与加载容错（纯函数，无 DOM，可被 node:test 复用）
// 解耦红线：本文件不得 import ../src/ 任何内容。数据来源见 docs/CONTRACT.md。
// ============================================================

/** 默认卷（doc 参数缺失/非法时的兜底值），对外导出供 viewer.js 与测试复用 */
export const DEFAULT_DOC = "23必刷题 2相互作用";

/**
 * 从 location.search（如 "?doc=xxx"）解析 doc。
 * 空/全空白 → 返回 DEFAULT_DOC。
 * @param {string} search location.search 字符串（可含或不含前导 "?"）
 * @returns {string}
 */
export function resolveDoc(search) {
  const m = new URLSearchParams(search.replace(/^\?/, "")).get("doc");
  return m && m.trim() ? m : DEFAULT_DOC;
}

/**
 * 加载 questions 数据，带"回退默认"容错：
 * - fetcher(doc) 返回一个 fetch 形式的 Response-ish 对象（需含 ok/status/json()）。
 * - 当前 doc 与 DEFAULT_DOC 不同、且加载失败时，回退 DEFAULT_DOC 再试一次。
 * - 回退仍失败（或本来就是默认卷失败）→ 抛明确错误（含"可能不完整/回退默认卷也失败"提示）。
 * @param {(doc: string) => Promise<Response>} fetcher 可注入的加载函数（测试传模拟响应）
 * @param {string} doc 经 resolveDoc 解析后的目标 doc
 * @returns {Promise<unknown>} questions JSON
 */
export function loadWithFallback(fetcher, doc) {
  const attempt = async (d) => {
    const res = await fetcher(d);
    if (!res || !res.ok) {
      throw new Error(`questions.json 加载失败（${res?.status ?? "unknown"}）`);
    }
    return await res.json();
  };
  return attempt(doc).catch((e) => {
    if (doc !== DEFAULT_DOC) {
      return attempt(DEFAULT_DOC).catch((e2) => {
        throw new Error(
          `${e.message}；且回退默认卷也失败（${e2.message}）——doc 参数可能不完整，请用菜单里的完整地址`,
        );
      });
    }
    throw e;
  });
}
