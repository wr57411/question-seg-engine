// @ts-check
/**
 * choice-row.js —— 「一行多选项被上游竖切」的识别（展示层纯逻辑，不改数据）
 *
 * 背景（2026-11-24 用户反馈 fb-20261122T143209-vk62「排得太挤」）：
 * OXR 有时把原卷**同一行横排的 A/B/C/D 四个选项**切成四个块、每个块带一个 `\n`
 * （实证：书A p8 第7题，四选项 `A. s/2v B. s/3v C. s/4v D. s/5v`，原卷为一行横排，
 * stages 里是四块 y=202.3/210.1/218.0/225.8、每块宽 219pt 高仅 5.4pt）。
 * 渲染时四个分式被压进 5–8pt 的窄框里竖着叠，观感就是「挤成一团」。
 *
 * 判据取**最严 AND**（宁漏不误：真竖排选项绝不能被拉横）：
 * ① 连续 ≥3 个文本块，文本以 A./B./C./D. 开头且互不相同；
 * ② 同栏：水平范围基本一致（左缘差 ≤ 页宽 5%）；
 * ③ **块很矮**：组内块高中位 < 9pt（正常竖排行高 ≥10pt，实测中位 10.1）；
 * ④ **块很宽**：组内块宽中位 > 页宽 25%（够横排放多个选项）；
 * ⑤ **垂直间距紧**：相邻块间隙 ≤ 组内块高中位 × 1.6。
 * 满足全部 ⇒ 判定为「横排误切」，渲染时按一行横排摆放（见 reconstruct.js）。
 *
 * 为什么放在展示层而不在转换层改：转换层改动会重导出全库（代价大、需逐页审板），
 * 而这是**纯显示几何**问题——数据不动、只把四个块摆回同一行，符合红线「检测不改写」。
 */

/** @typedef {{ i: number, kind?: string, bbox: number[], text?: string }} CRBlock */

/** 选项字母前缀，如 "A." / "B." */
const CHOICE_PREFIX = /^([A-D])\.\s*/;

/**
 * 一组候选是否构成「横排误切」。
 * @param {CRBlock[]} group 连续的同类候选块（已按阅读序）
 * @param {number} pageW 页宽（pt）
 * @returns {boolean}
 */
export function isHorizontalChoiceRow(group, pageW) {
  if (!Array.isArray(group) || group.length < 3) return false;
  const letters = new Set();
  for (const b of group) {
    const m = CHOICE_PREFIX.exec((b.text ?? "").trim());
    if (!m) return false;
    letters.add(m[1]);
  }
  // ① 至少 3 个不同字母（避免 A/A/A 之类重复）
  if (letters.size < 3) return false;

  /** bbox 分量可能缺失（快照形状不齐）——取 number，缺则 NaN */
  const num = (/** @type {number | undefined} */ v) =>
    typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
  const heights = group.map((b) => num(b.bbox[3]) - num(b.bbox[1])).filter((h) => h > 0);
  const widths = group.map((b) => num(b.bbox[2]) - num(b.bbox[0])).filter((w) => w > 0);
  if (heights.length < group.length || widths.length < group.length) return false;

  /** 中位数 @param {number[]} a */
  const med = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  };
  const hMed = med(heights);
  const wMed = med(widths);

  // ② 同栏（左缘基本对齐）
  const lefts = group.map((b) => num(b.bbox[0]));
  if (lefts.some((v) => Number.isNaN(v))) return false;
  const leftSpread = Math.max(...lefts) - Math.min(...lefts);
  if (leftSpread > pageW * 0.05) return false;

  // ③ 块很矮（正常竖排行高 ≥10pt）
  if (!(hMed < 9)) return false;
  // ④ 块很宽（够横排）
  if (!(wMed > pageW * 0.25)) return false;
  // ⑤ 垂直间隙紧
  const gaps = [];
  for (let k = 1; k < group.length; k++) {
    const cur = group[k];
    const prev = group[k - 1];
    if (!cur || !prev) return false;
    gaps.push(num(cur.bbox[1]) - num(prev.bbox[3]));
  }
  const usable = gaps.filter((g) => Number.isFinite(g) && g >= 0);
  if (usable.length < gaps.length) return false;
  const gMed = med(usable);
  if (!(gMed <= hMed * 1.6)) return false;

  return true;
}

/**
 * 在页内块序列中找出所有「横排误切」组（彼此不重叠；按起始块 i 升序）。
 * @param {CRBlock[]} blocks 页内块（任意顺序，内部按 i 排序）
 * @param {number} pageW
 * @returns {CRBlock[][]}
 */
export function findHorizontalChoiceRows(blocks, pageW) {
  const sorted = [...blocks].filter((b) => b.kind === "text" && (b.text ?? "").trim()).sort(
    (a, b) => a.i - b.i,
  );
  /** @type {CRBlock[][]} */
  const out = [];
  /** @type {CRBlock[]} */
  let run = [];
  const flush = () => {
    if (run.length >= 3 && isHorizontalChoiceRow(run, pageW)) out.push([...run]);
    run = [];
  };
  for (const b of sorted) {
    if (CHOICE_PREFIX.test((b.text ?? "").trim()) && (b.text ?? "").trim().length < 48) {
      run.push(b);
    } else {
      flush();
    }
  }
  flush();
  return out;
}
