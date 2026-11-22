// @ts-check
/**
 * 图形误读判据（B-64，2026-11-22 用户报障 fb-20261122T143030-1q6h）。
 *
 * OXR 把原卷的简单线性图形（数轴「A•—•B—•C—•D•」）读成 LaTeX array
 * `\begin{array}{ccccc}A&&B&&C&D\\\hline\end{array`，渲染退化成源码直出「A&&B&&C&&D」。
 * 判据（AND，宁漏不误）：① 有 `\begin{array}`；② 内容只有大写字母/数字与
 * `&`/`\`/`{}`/`hline`（无 \frac/\sqrt 等真数学记号）；③ 行框高 ≤ 12pt。
 * 处置 = 渲染压制（虚线占位 + title 提示，stages 审计可见；数据不删——红线「检测不改写」）。
 */
/** @param {string} text @param {number} bboxH @returns {boolean} */
export function isMisreadFigureText(text, bboxH) {
  if (!text.includes("\\begin{array}")) return false;
  if (bboxH > 12) return false;
  const body = text.replace(/\\begin\{array\}\{[^}]*\}/, "").replace(/\\end\{array\}?/, "").trim();
  if (!body.length) return false;
  if (/\\(frac|sqrt|sum|int|lim|vec|hat|overline|left|right|cdot|times|div)/.test(body)) return false;
  // 剥掉 \hline（可在任意位置——实测形态是行尾 `\\\hline`）再测字符集
  const core = body.replace(/\\hline/g, "");
  const okChars = /^[A-Z0-9&\\\s{}]*$/.test(core);
  return okChars && /[A-Z]{1,3}&/.test(core);
}
