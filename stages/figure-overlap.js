// @ts-check
/**
 * figure-overlap.js —— 「文字框右缘过冲到图片上」的识别与收缘（展示层纯逻辑，不改数据）
 *
 * 背景（2026-11-24 用户报障 fb-20261122T134356-rdwi「内容明显有遮挡」、fb-20261124T015614-8f0e
 * 「图层重叠的方式不好」）：原卷里常见「**左文右图**」并排（例：书A p6 第 3 题，选项 A–D 文字在
 * x310–455、导航路线图在 x458–553）。OXR 合成的文字块 bbox 常**继承段框右缘**（scripts/oxr-convert.ts
 * 的每行 `[bbox.x0, y0, bbox.x1, y0+fontSize]`），于是文字块一直延伸到图下方（实测该处文字框宽 247pt、
 * 右缘 557 > 图左缘 458，越过 99pt）。渲染时 `.blk{white-space:nowrap}` 不能换行 ⇒ 字号被 clampByWidth
 * 压小（15.0 vs 基准 15.4）并挤在图左侧；z 序只保证文字在上层（内容不丢），观感仍是「字压图」。
 *
 * 判据取**最严 AND**（宁漏不误）：
 * ① 文字块与图片块**同一栏**（用 centers 分界，或页宽对半）；
 * ② 文字块右缘越过图左缘 > 页宽 2%（实质越界，不是贴边）；
 * ③ 文字块**位于图的左侧**（文字右缘 ≤ 图右缘 + 页宽 5%）——只收「左文右图」，不动「上图下文」；
 * ④ 文字块中心不在图内（那是图内标注，如「甲」「乙」「图3」，本来就该印在图上）；
 * ⑤ 图足够大（宽 > 页宽 15%），排除细线/小图标造成的误伤。
 * 命中 ⇒ 渲染时把文字块**右缘收紧到图左缘**并允许换行（见 reconstruct.js applyFigureEdges）。
 */

/** @typedef {{ i: number, kind?: string, bbox: number[], text?: string }} FBlock */

/**
 * 栏归属：快照 `centers` 是各栏**簇心 x**（引擎 detectColumnCenters，用块左缘聚类；
 * 例：书A p6 = [42, 308] 表示左栏簇心 42、右栏簇心 308）。归属规则与引擎 restoreReadingOrder
 * 的 `assign` 一致——**取距哪个簇心最近**，不靠固定中线。缺 centers 时按页宽对半分。
 * @param {number} x
 * @param {number} pageW
 * @param {number[]} [centers]
 * @returns {number} 栏号（0 起）
 */
export function columnIndexOf(x, pageW, centers) {
  if (!Array.isArray(centers) || centers.length < 2) return x < pageW / 2 ? 0 : 1;
  let best = 0;
  let bestDist = Infinity;
  centers.forEach((c, i) => {
    const d = Math.abs(c - x);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

/**
 * 找出需要收缘的文字块：返回 `Map<文字块i, 新右缘pt>`。
 * @param {FBlock[]} blocks 页内块
 * @param {number} pageW
 * @param {number[]} [centers]
 * @returns {Map<number, number>}
 */
export function figureEdgeClamps(blocks, pageW, centers) {
  const out = new Map();
  const imgs = (blocks ?? []).filter((b) => b.kind === "image");
  const texts = (blocks ?? []).filter((b) => b.kind === "text" && (b.text ?? "").trim());
  for (const t of texts) {
    if (!Array.isArray(t.bbox) || t.bbox.length < 4) continue;
    const [tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0] = t.bbox;
    if ([tx0, ty0, tx1, ty1].some((v) => typeof v !== "number")) continue;
    const cx = (tx0 + tx1) / 2;
    const cy = (ty0 + ty1) / 2;
    const col = columnIndexOf(cx, pageW, centers);
    for (const im of imgs) {
      if (!Array.isArray(im.bbox) || im.bbox.length < 4) continue;
      const [ix0 = 0, iy0 = 0, ix1 = 0, iy1 = 0] = im.bbox;
      if ([ix0, iy0, ix1, iy1].some((v) => typeof v !== "number")) continue;
      const icx = (ix0 + ix1) / 2;
      // ① 同栏
      if (columnIndexOf(icx, pageW, centers) !== col) continue;
      // ⑤ 排除极小的碎图/细线（否则误伤）；竖长图（坐标轴、标尺）按高算也够格
      const figW = ix1 - ix0;
      const figH = iy1 - iy0;
      if (figW <= pageW * 0.08 && figH <= pageW * 0.2) continue;
      // ④ 文字中心在图内 ⇒ 图内标注，跳过
      if (cx >= ix0 && cx <= ix1 && cy >= iy0 && cy <= iy1) continue;
      // ③ 文字在图左侧
      if (tx1 > ix1 + pageW * 0.05) continue;
      if (tx0 >= ix0) continue; // 文字整体在图右，不在本判据范围
      // ② 右缘越过图左缘（>2% 页宽）
      const over = tx1 - ix0;
      if (over <= pageW * 0.02) continue;
      // 垂直方向要真有交集（否则只是横向越界、纵向不相干）
      const oy = Math.min(ty1, iy1) - Math.max(ty0, iy0);
      if (oy <= 0) continue;
      const prev = out.get(t.i);
      // 多图时取最保守（最小）的右缘
      out.set(t.i, prev === undefined ? ix0 : Math.min(prev, ix0));
    }
  }
  return out;
}
