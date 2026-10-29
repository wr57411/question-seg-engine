// stages/table-html.js
// @ts-check
/**
 * 上游表格 HTML → 行/单元格（`DECISIONS §76`）。
 *
 * ## 为什么要它
 *
 * MinerU 把表格放在 `spans[].html`（带 `rowspan`/`colspan`），而 `content` 只有**压平后的
 * 文字**：行与行靠换行拼，列边界只剩空白。所以成品页上「表格」看起来就是几行文字。
 * 这里把上游**本来就给出的**结构解析出来给展示层画网格 —— 是「按原坐标重建纸面」的同一条
 * 原则，**不是**从空白推断列宽（那属于猜，红线不允许）。
 *
 * ## 为什么不用 DOM 解析
 *
 * 本模块要能在 node 测试里跑（项目无 DOM 测试设施）。表格 HTML 形态很规整
 * （只有 `tr/td/th` + 内联 `<eq>`），正则解析足够，且不会把 `<eq>` 里的公式字符当标签吃掉。
 */

/**
 * @typedef {object} TableCell
 * @property {string} text 单元格文本（公式已转成 `$…$`）
 * @property {number} rowspan
 * @property {number} colspan
 *
 * @typedef {object} TableRow
 * @property {TableCell[]} cells
 *
 * @typedef {object} ParsedTable
 * @property {TableRow[]} rows
 * @property {number} cols 网格列数（按 colspan 展开后的最大列数）
 */

/**
 * HTML 实体 → 字符（只处理表格里实际会出现的几个）
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 单元格内容归一：
 * - `<eq>…</eq>` → `$…$`（上游的行内公式标记，渲染层按 LaTeX 处理）
 * - `<br>` → 换行；其余标签剥掉，只留文本
 * - 连续空白压成一个空格（表格里靠空白对齐，压掉更可读）
 * @param {string} raw
 * @returns {string}
 */
export function cellText(raw) {
  const withMath = String(raw ?? "").replace(/<eq>([\s\S]*?)<\/eq>/g, (_, m) => `$${String(m).trim()}$`);
  const stripped = withMath.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

/**
 * 解析表格 HTML。
 * @param {string} html
 * @returns {ParsedTable}
 */
export function parseTableHtml(html) {
  /** @type {TableRow[]} */
  const rows = [];
  const src = String(html ?? "");
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  /** @type {RegExpExecArray | null} */
  let rm;
  while ((rm = rowRe.exec(src)) !== null) {
    const inner = rm[1] ?? "";
    /** @type {TableCell[]} */
    const cells = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    /** @type {RegExpExecArray | null} */
    let cm;
    while ((cm = cellRe.exec(inner)) !== null) {
      const attrs = cm[2] ?? "";
      const body = cm[3] ?? "";
      const rs = Number((/rowspan\s*=\s*["']?(\d+)/i.exec(attrs) ?? [])[1] ?? 1);
      const cs = Number((/colspan\s*=\s*["']?(\d+)/i.exec(attrs) ?? [])[1] ?? 1);
      cells.push({
        text: cellText(body),
        rowspan: Number.isFinite(rs) && rs > 0 ? rs : 1,
        colspan: Number.isFinite(cs) && cs > 0 ? cs : 1,
      });
    }
    if (cells.length) rows.push({ cells });
  }
  let cols = 0;
  for (const r of rows) cols = Math.max(cols, r.cells.reduce((n, c) => n + c.colspan, 0));
  return { rows, cols };
}
