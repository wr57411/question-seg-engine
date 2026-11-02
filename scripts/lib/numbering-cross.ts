// scripts/lib/numbering-cross.ts
/**
 * 题号行交叉核对的**纯判据**（`DECISIONS §99`）。
 *
 * 抽出来只为可测：脚本本体负责遍历磁盘，这里只负责「一行 OCR 题号 → 判什么」。
 * ⚠️ 刻意 **不依赖 `src/`**：这条审计的意义就是「与引擎不同源」。
 */

/** 题号行：`1[人教版…]` / `2 2024 江西卷 [多选]…`；首数字 1–99，不认 `0`。 */
export const Q_LINE = /^([1-9]\d{0,1})\s*(?:[\[［]|(?:19|20)\d{2}\s+\S{2,8}卷)/;

/**
 * 行首「题号 + 年份卷 + 任意多个方括号标签」。
 * ⚠️ 早期版本直接把 `Q_LINE` replace 掉，连 `[` 一起吃掉，标签于是剥不干净，
 * 比对串变成 `粤教版必修一P121图4…`（实测误报《运动和力》p6 #3）。
 */
export const PREFIX =
  /^\s*(?:[1-9]\d{0,1})?\s*(?:(?:19|20)\d{2}\s+\S{2,8}卷)?\s*(?:[\[［][^\]］]*[\]］]\s*)*/;

/** layout 覆盖率阈值。实测：文字真在 ⇒ 1.00；真丢失 ⇒ 0.00–0.40；没成题 ⇒ 0.78–1.00。 */
export const LAYOUT_HAS = 0.6;
/** 产物题池覆盖率阈值。实测：题真在 ⇒ 1.00；没成题 ⇒ 0.00–0.60。 */
export const POOL_HAS = 0.75;
/** 正文汉字少于此数无法判断（如「如图」「年月日」）⇒ 跳过，宁漏不误。 */
export const MIN_CJK = 6;

export type Verdict = "X1" | "X2";

/** 只留汉字/字母/数字：layout 与 OCR 的空白、标点必然不同。 */
export function norm(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

/** 只留汉字：公式/字母/数字的写法差异不应参与比对（v1 的假阳全来自此）。 */
export function cjk(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5]/g, "");
}

/** n 字滑窗集合，避免大文本上反复 includes（30 万字 × 上千条会卡）。 */
export function gramSet(text: string, n = 4): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + n <= text.length; i++) s.add(text.slice(i, i + n));
  return s;
}

/** body 的 n 字滑窗有多少比例出现在 grams 里。 */
export function coverage(body: string, grams: Set<string>, n = 4): number {
  if (body.length < n) return 0;
  let hit = 0;
  const tot = body.length - n + 1;
  for (let i = 0; i < tot; i++) if (grams.has(body.slice(i, i + n))) hit++;
  return hit / tot;
}

/**
 * 取 OCR 题号行的正文：剥掉「题号 + 年份卷 + 全部前置标签」。
 * 有些行只有「题号 + 出处标签」，正文在**下一行**（实测《机械能守恒》p7 #2），
 * 甚至隔着空行 ⇒ 正文过短时拼「下一个**非空**行」。
 */
export function bodyFromLines(lines: string[], li: number): string {
  const line = (lines[li] ?? "").trim();
  let body = norm(line.replace(PREFIX, ""));
  if (body.length < MIN_CJK) {
    let j = li + 1;
    while (j < lines.length && !lines[j]!.trim()) j++;
    body = norm(line.replace(PREFIX, "") + (lines[j] ?? "").trim());
  }
  return body;
}

export interface Judgement {
  verdict: Verdict;
  covLayout: number;
  covPool: number;
}

/**
 * 判定：
 * - **X1 上游丢字**：layout 覆盖率 < `LAYOUT_HAS` ⇒ 该题正文在**输入**里就没有。
 * - **X2 切分丢题**：layout 覆盖 ≥ `LAYOUT_HAS`，但题池覆盖 < `POOL_HAS`
 *   ⇒ 正文在输入里，却没成为任何一道题（含被并进相邻题）。
 * - `poolGrams` 为 `null`（该册无产物）时只判 X1，不猜。
 */
export function judge(
  bodyNorm: string,
  layoutGrams: Set<string>,
  poolGrams: Set<string> | null,
): Judgement | null {
  const bc = cjk(bodyNorm.slice(0, 12));
  if (bc.length < MIN_CJK) return null; // 正文汉字太少，无法判断（宁漏不误）
  const covLayout = coverage(bc, layoutGrams);
  const covPool = poolGrams ? coverage(bc, poolGrams) : 1;
  if (covLayout < LAYOUT_HAS) return { verdict: "X1", covLayout, covPool };
  if (covPool < POOL_HAS) return { verdict: "X2", covLayout, covPool };
  return null;
}
