// scripts/band-mask.ts
/**
 * 遮框（实验分支 opts.bandMaskFrameBars）：投影切带前把竖条列置白。
 * 泛化判据（轮 4 ask，不限页缘）：任何 x 列满足
 *   ① 纵向墨（灰度<200，与 splitInkLines DEFAULT_SPLIT 同源）>50% 投影窗高，且
 *   ② 墨跨度（该列暗像素 min-y→max-y）>70% 页高
 * 即判为竖条列并整列遮蔽。阈值参数化为导出常量。
 * 只生成遮蔽副本（检测到竖条才复制），不修改入参 img；旗标关时零调用零开销。
 */
import type { GrayImage } from "./export-stages.js";

/** 竖条判定比例①：列暗像素数 >50% 投影窗高 */
export const MASK_BAR_RATIO = 0.5;
/** 竖条判定比例②：列墨跨度（min-y→max-y）>70% 页高 */
export const MASK_BAR_SPAN_RATIO = 0.7;
/** 墨阈值：与 splitInkLines 的 DEFAULT_SPLIT.threshold 同源（bandsForColumn 同参） */
export const MASK_INK_THRESHOLD = 200;

/** 检测并把竖条列置白；无竖条时原样返回入参 img（零副本）。 */
export function maskFrameBars(img: GrayImage, pageW: number): GrayImage {
  const w = img.width;
  const winH = img.height;
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
  const cols: number[] = [];
  for (let x = 0; x < w; x++) {
    const span = lastY[x]! >= 0 ? lastY[x]! - firstY[x]! + 1 : 0;
    if (cnt[x]! > MASK_BAR_RATIO * winH && span > MASK_BAR_SPAN_RATIO * winH) cols.push(x);
  }
  if (!cols.length) return img;
  const data = Uint8Array.from(img.data);
  for (const x of cols) for (let y = 0; y < winH; y++) data[y * w + x] = 255;
  return { width: w, height: winH, data };
}
