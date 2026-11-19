// scripts/table-guard.ts
/**
 * G1 无边框守卫（spec docs/plans/2026-11-13-表格与巨带放置实现.md §4.1）。
 *
 * 判据全部来自**原卷灰度墨迹**（独立于 V3 输出——判据与实现不同源红线）：
 * 表区域内最长水平连续墨迹 run / 区域宽（hRunW）。浅灰表格线灰度落在 160–240，
 * 故线阈取 <240（文字/图墨 <160 是另一口径，勿混用）。
 *
 * 实测分离（tmp/table-broaden-v3/ 附录 B，9 页 PGM 探针）：
 * 8 张真表 hRunW ∈ [0.62, 1.00]；da-p186 无边框两栏答案索引 = 0.04
 * （灰阈 160/200/230/240/245/250 全稳定）⇒ 阈值 0.3，分离裕度 >15×。
 *
 * 误杀方向安全：更浅线的真表若 hRunW<0.3 会被判 borderless —— 只失格网视觉，
 * 行文本照常渲染（不丢内容），诊断注记可见（R4）。
 *
 * 纯函数、无 DOM、无依赖：上游分类脚本（scripts/table-v3-sample.ts 等）消费；
 * 展示层只消费分类产物 table-v3.json，**不 import 本模块**（解耦红线）。
 */

/** 灰度图（与 export-stages.parsePgm 产物同形；这里只声明读过的字段） */
export interface GuardGray {
  width: number;
  height: number;
  /** 行优先灰度字节 */
  data: Uint8Array;
}

/** 浅灰表格线阈：灰度 <240 判为线墨（本轮实测线灰度 160–240） */
export const G1_LINE_THRESHOLD = 240;
/** hRunW <0.3 ⇒ borderless（实测 0.04 vs ≥0.62，裕度 >15×） */
export const G1_BORDERLESS_HRUN_MAX = 0.3;

/** bbox 像素域夹到图界（防越界读） */
function clampRegion(img: GuardGray, bboxPx: [number, number, number, number]): [number, number, number, number] {
  const x0 = Math.max(0, Math.floor(bboxPx[0]));
  const y0 = Math.max(0, Math.floor(bboxPx[1]));
  const x1 = Math.min(img.width, Math.ceil(bboxPx[2]));
  const y1 = Math.min(img.height, Math.ceil(bboxPx[3]));
  return [x0, y0, Math.max(x0, x1), Math.max(y0, y1)];
}

/**
 * 表区域内最长水平连续墨迹 run / 区域宽。空区域返回 0（保守：无墨不当有框表）。
 * @param bboxPx 像素域 [x0,y0,x1,y1]（原卷页图坐标系）
 */
export function longestHRunRatio(img: GuardGray, bboxPx: [number, number, number, number], threshold = G1_LINE_THRESHOLD): number {
  const [x0, y0, x1, y1] = clampRegion(img, bboxPx);
  const w = x1 - x0;
  if (w <= 0 || y1 <= y0) return 0;
  let best = 0;
  for (let y = y0; y < y1; y++) {
    let run = 0;
    const base = y * img.width;
    for (let x = x0; x < x1; x++) {
      if (img.data[base + x]! < threshold) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
  }
  return best / w;
}

/** 最长竖直连续墨迹 run / 区域高（佐证信号，非主判据；da-p186 单竖分隔线亦浅，仅 0.14） */
export function longestVRunRatio(img: GuardGray, bboxPx: [number, number, number, number], threshold = G1_LINE_THRESHOLD): number {
  const [x0, y0, x1, y1] = clampRegion(img, bboxPx);
  const h = y1 - y0;
  if (h <= 0 || x1 <= x0) return 0;
  let best = 0;
  for (let x = x0; x < x1; x++) {
    let run = 0;
    for (let y = y0; y < y1; y++) {
      if (img.data[y * img.width + x]! < threshold) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
  }
  return best / h;
}

/** G1 判定：hRunW <0.3 ⇒ 无边框（不当表格渲染，行文本照常）。边界取 <（等于不判）。 */
export function isBorderlessByInk(hRunW: number): boolean {
  return hRunW < G1_BORDERLESS_HRUN_MAX;
}