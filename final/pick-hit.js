// @ts-check
/**
 * final/pick-hit.js — 挑题模式的纯命中逻辑（无 DOM，可被 tsc 检查）。
 *
 * 输入是**页面坐标**（stages.json 的 pt 单位），不是 CSS px；调用方按
 * `canvas.getBoundingClientRect()` 与 `innerW / page.width` 换算后再传进来。
 *
 * 判据：点在题目自己的块内，或距块边 ≤ tolerancePt（默认 6pt）即命中；
 * 题与题之间的空白、页边距不猜（返回 null）。多题都命中时取距离最近；
 * 距离相同按页面阅读顺序取第一个（questions 数组顺序）。
 */

/**
 * @typedef {{ bbox: number[] }} PickBlock
 * @typedef {{ id: string, blocks?: number[] }} PickQuestion
 * @typedef {{ width: number, height: number, blocks?: PickBlock[], questions?: PickQuestion[] }} PickPage
 */

/**
 * @param {PickPage} page
 * @param {number} xPt 页面单位
 * @param {number} yPt 页面单位
 * @param {number} [tolerancePt]
 * @returns {PickQuestion | null}
 */
export function pickQuestionAt(page, xPt, yPt, tolerancePt = 6) {
  if (!page || !Number.isFinite(xPt) || !Number.isFinite(yPt)) return null;
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  const questions = Array.isArray(page.questions) ? page.questions : [];
  /** @type {{ q: PickQuestion, dist: number } | null} */
  let best = null;
  for (const q of questions) {
    for (const bi of q.blocks ?? []) {
      const b = blocks[bi];
      const bbox = b?.bbox;
      if (!Array.isArray(bbox) || bbox.length < 4) continue;
      const x0 = bbox[0];
      const y0 = bbox[1];
      const x1 = bbox[2];
      const y1 = bbox[3];
      if (
        typeof x0 !== 'number' || !Number.isFinite(x0) ||
        typeof y0 !== 'number' || !Number.isFinite(y0) ||
        typeof x1 !== 'number' || !Number.isFinite(x1) ||
        typeof y1 !== 'number' || !Number.isFinite(y1)
      ) {
        continue;
      }
      const dx = xPt < x0 ? x0 - xPt : xPt > x1 ? xPt - x1 : 0;
      const dy = yPt < y0 ? y0 - yPt : yPt > y1 ? yPt - y1 : 0;
      const dist = Math.hypot(dx, dy);
      if (dist > tolerancePt) continue;
      if (!best || dist < best.dist) best = { q, dist };
    }
  }
  return best?.q ?? null;
}
