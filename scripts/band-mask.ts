// scripts/band-mask.ts
/**
 * 页缘装饰竖条遮罩（M4b 转生产；原 B-35 实验分支 opts.bandMaskFrameBars 同源实现）。
 *
 * 判据取**最严 AND**（宁可漏遮不误遮，L2）：一段连续 x 列同时满足
 *   ① 页缘：列 x 落在 [0, EDGE_FRAME_PT) ∪ (pageW−EDGE_FRAME_PT, pageW]（pt 域）；
 *   ② 整高：列墨跨度（min-y→max-y）≥ MASK_BAR_SPAN_RATIO × 投影窗高；
 *   ③ 墨比：列暗像素（灰度<MASK_INK_THRESHOLD，与 splitInkLines DEFAULT_SPLIT 同源）
 *      > MASK_BAR_RATIO × 窗高；
 *   ④ 窄：连续命中列组成的 run 宽 ≤ MASK_BAR_WIDTH_PT（pt）。
 * 四者缺一不遮。页中部整高竖线（答案册栏间分隔线实测 x≈页中线）、页缘宽色块
 * （答案册 p185/186 厚边条 8.1pt、封面整页墨）一律不遮 ⇒ 无命中页零副本零行为差。
 *
 * 阈值标定证据（tmp/m4b/probe-cols.ts 实跑，150dpi 灰度列统计）：
 *   - 目标题册装饰条：qx 左缘 x9.7–14.6pt 宽5.1pt span0.999；wy 左右缘宽1.8–4.8pt
 *     span0.848–1.0（设计断口允许 ⇒ 整高阈 0.8）；正文列 x0≥21.5pt ⇒ 页缘zone 20pt 分离；
 *   - 答案册 187 页全探针：页缘整高 run 仅 p0 整页墨(535.9pt)/p185/p186 厚边条(8.1/21.5pt)，
 *     宽≤6pt 命中集合=空 ⇒ 答案册基线逐字节守卫天然成立；
 *   - 窄阈 6pt = 目标条实测上限 5.1pt 留裕量；≥8pt 边条属「拿不准」保守不遮。
 *
 * 只生成遮蔽副本（检测到竖条才复制），不修改入参 img；旗标关时零调用零开销。
 * detectEdgeFrameBars 产出可核对记录（pt 域 x/跨度/墨比），审计侧落进产物 summary。
 * 同页守卫：遮罩只作用于本页灰度副本，不搬迁/不改写任何行内容（检测不改写）。
 */
import type { GrayImage } from "./export-stages.js";

/** 竖条判定比例①：列暗像素数 >50% 投影窗高 */
export const MASK_BAR_RATIO = 0.5;
/** 竖条判定比例②（整高）：列墨跨度（min-y→max-y）≥80% 页高（装饰条实测 0.848–1.0，含设计断口） */
export const MASK_BAR_SPAN_RATIO = 0.8;
/** 墨阈值：与 splitInkLines 的 DEFAULT_SPLIT.threshold 同源（bandsForColumn 同参） */
export const MASK_INK_THRESHOLD = 200;
/** 页缘zone宽（pt）：装饰条实测最远距页缘 19.3pt；正文列 x0≥21.5pt（独立 V3 源）⇒ 20pt 分离 */
export const EDGE_FRAME_PT = 20;
/** 窄条上限（pt）：目标装饰条实测 1.8–5.1pt；答案册厚边条 8.1pt 保守排除 */
export const MASK_BAR_WIDTH_PT = 6;

/** 一段页缘整高窄竖条的可核对记录（x 为 pt 域，px 为像素闭区间） */
export interface EdgeBarRun {
  x0: number;
  x1: number;
  px0: number;
  px1: number;
  spanRatio: number;
  inkRatio: number;
}

/** 检测页缘整高窄竖条 run（最严 AND，见文件头）。无命中返回 []。纯函数，可单测。 */
export function detectEdgeFrameBars(img: GrayImage, pageW: number): EdgeBarRun[] {
  const w = img.width;
  const winH = img.height;
  const sx = w / pageW;
  // 行优先单遍扫描：累计每列暗像素计数与 min/max y
  const cnt = new Int32Array(w);
  const firstY = new Int32Array(w).fill(-1);
  const lastY = new Int32Array(w).fill(-1);
  for (let y = 0; y < winH; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (img.data[base + x]! < MASK_INK_THRESHOLD) {
        cnt[x] = cnt[x]! + 1;
        if (firstY[x]! < 0) firstY[x] = y;
        lastY[x] = y;
      }
    }
  }
  const edgePx = EDGE_FRAME_PT * sx;
  const qual = (x: number): boolean => {
    const inEdge = x < edgePx || x + 1 > w - edgePx;
    if (!inEdge) return false;
    const span = lastY[x]! >= 0 ? lastY[x]! - firstY[x]! + 1 : 0;
    return cnt[x]! > MASK_BAR_RATIO * winH && span >= MASK_BAR_SPAN_RATIO * winH;
  };
  const runs: EdgeBarRun[] = [];
  let s = -1;
  for (let x = 0; x <= w; x++) {
    const q = x < w && qual(x);
    if (q && s < 0) s = x;
    if (!q && s >= 0) {
      const widthPt = (x - s) / sx;
      if (widthPt <= MASK_BAR_WIDTH_PT) {
        let c = 0;
        let sp = 0;
        for (let k = s; k < x; k++) {
          c += cnt[k]!;
          sp = Math.max(sp, lastY[k]! - firstY[k]! + 1);
        }
        runs.push({
          x0: +(s / sx).toFixed(2),
          x1: +(x / sx).toFixed(2),
          px0: s,
          px1: x - 1,
          spanRatio: +(sp / winH).toFixed(3),
          inkRatio: +(c / ((x - s) * winH)).toFixed(3),
        });
      }
      s = -1;
    }
  }
  return runs;
}

/** 检测并把页缘竖条列置白；无竖条时原样返回入参 img（零副本）。runs 可预计算复用（审计记录同源）。 */
export function maskFrameBars(img: GrayImage, pageW: number, runs: EdgeBarRun[] = detectEdgeFrameBars(img, pageW)): GrayImage {
  if (!runs.length) return img;
  const w = img.width;
  const winH = img.height;
  const data = Uint8Array.from(img.data);
  for (const r of runs) for (let y = 0; y < winH; y++) for (let x = r.px0; x <= r.px1; x++) data[y * w + x] = 255;
  return { width: w, height: winH, data };
}