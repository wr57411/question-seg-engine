// scripts/r5-align.ts
/**
 * R5 逐页页号守卫（table-v3-full 消费；纯函数、无 DOM、无依赖）。
 *
 * 目的：防 0/1 基错页**静默**——res 文件 pNN 必须是 stages index+1 的那一页。
 * 原判据「V3 rec_texts[0] ∈ 骨架前 3 text 块」在 d13 电路 / d14 磁场上对**页眉碎屑**
 * 假红：V3 首行是装饰头（「第九章」「基础双练教材基础练」），OXR 没读 ⇒ 骨架里没有，
 * 非空书被整册阻断、三分流空转（M5-B codeIssuesForM5B ①）。
 *
 * 修后口径（两段，先严后宽）：
 *   ① strict：V3 首行落在骨架前 3 个 text 块的拼接内 ⇒ 通过（原行为，保留）；
 *   ② overlap：整页骨架文本内命中 ≥ R5_OVERLAP_MIN_LINES 条 V3 **长行**
 *      （归一化去空白后长度 ≥ R5_MIN_LINE_LEN）⇒ 通过。
 *
 * 阈值实测分离（d13/d14 全 23 页，正确页 vs 相邻页各算一次）：
 *   minlen=8 正确页命中 9–35 条 / 相邻页 0–3 条 ⇒ 阈 5 有两倍裕度；
 *   取更长/更短门槛都会缩小裕度（minlen=6 为 13 vs 7，minlen=10 为 5 vs 1）。
 *
 * 两段都失败 ⇒ 抛错理由交调用方**响亮中止**（不静默错页，红线 1）。
 */

/** 重合长行的最小归一化长度（去空白后字符数） */
export const R5_MIN_LINE_LEN = 8;
/** 重合长行达到该条数即认作同页（实测正确页≥9、相邻页≤3） */
export const R5_OVERLAP_MIN_LINES = 5;

export interface R5AlignInput {
  /** V3 整页 OCR 行（overall_ocr_res.rec_texts 原序） */
  v3Lines: string[];
  /** 骨架页全部 text 块文本（顺序无关，只看拼接） */
  skeletonTexts: string[];
}

export type R5AlignResult =
  | { ok: true; mode: "strict"; first: string }
  | { ok: true; mode: "overlap"; matched: number; scanned: number }
  | { ok: false; reason: string };

const norm = (s: string): string => s.replace(/\s/g, "");

/**
 * @param {R5AlignInput} input
 * @returns {R5AlignResult}
 */
export function checkR5Alignment(input: R5AlignInput): R5AlignResult {
  const first = norm(input.v3Lines[0] ?? "");
  const head = norm(input.skeletonTexts.slice(0, 3).join(""));
  if (first && head.includes(first)) return { ok: true, mode: "strict", first };

  const all = norm(input.skeletonTexts.join(""));
  const longLines = input.v3Lines.map(norm).filter((l) => l.length >= R5_MIN_LINE_LEN);
  const matched = longLines.filter((l) => all.includes(l)).length;
  if (matched >= R5_OVERLAP_MIN_LINES) {
    return { ok: true, mode: "overlap", matched, scanned: longLines.length };
  }
  return {
    ok: false,
    reason:
      `V3 首行=${first.slice(0, 30)} 不在骨架前 3 text 块，且长行重合 ${matched}` +
      `<${R5_OVERLAP_MIN_LINES}（页号口径错？中止）`,
  };
}
