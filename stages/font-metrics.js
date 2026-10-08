/**
 * font-metrics.js —— 重建纸面的字号/全角宽度度量（纯函数，无 DOM、无依赖）。
 *
 * 定位：stage 6「对比模式」用结构化数据按原坐标重建纸面，但 MinerU 的 layout.json
 * **没有字号字段**（F9）——字号真值不存在，只能由行高反推。本模块把这套数学抽成
 * 纯函数，好让 tests/font-metrics.test.ts 把它钉死；此前它藏在无构建的 stages.js 里、
 * 没有任何测试，一次系数写错就整体偏小 30%（F3）而无人察觉。
 *
 * ── 数值权威：data/out/ink-groundtruth.md（对**原卷页图墨迹**的直接测量）──
 * 测量方法：原卷页图 PNG → 逐块 bbox 外扩 6px 后二值化（灰度<128 为墨）→ 扫出真实
 * 墨迹包围盒 → 换算回 pt（scale=图px宽/596pt）→ 纯 CJK 正文行取 `墨迹宽 / 全角字数`。
 *
 * 已定案事实（F1–F6，逐条可回溯 ink-groundtruth.md）：
 *   F1 原卷行 bbox **紧贴墨迹**：横向内边距合计 1.58pt（行宽 0.7%）、纵向 0.22pt
 *      （125 行样本，阈值 100/128/160 下稳定）→ bbox 宽可放心当目标宽。
 *   F2 原卷正文真实字号 S_ink = 墨迹宽/全角字数，中位 **11.29pt**。
 *   F3 旧系数 `fontPx = hPx * 0.72` 等价 `font_pt = 0.72 × bboxH_pt`；对 11pt 正文行
 *      只给出 **7.92pt** → **偏小 30%**（F_cur/F_req = 0.70）。
 *   F4 **定案系数 c = 1.03**：`fontPx = hPx × 1.03`（hPx = bboxH_pt/pageWidth_pt × canvasW）；
 *      相对旧系数修正因子 1.43。区间 1.02–1.04，阈值敏感性极稳。
 *   F5 垂直不成问题：按 F4 渲染，浏览器整行墨迹高 0.961em vs 原卷 0.938em，只高 2.3%
 *      → 宽高可同时对齐，不需牺牲任何一个。
 *   F6 按 F4，渲染宽恒 < bbox 宽 → **不新增块间溢出**（此前测得的 32 对溢出源于系数取
 *      1.475，比真值大 3%）。
 *
 * ── 被推翻的旧前提（必须记录，否则下一轮又会凭推断动手）──
 * 上一轮未提交代码的注释写着「浏览器字体（宋体）比原卷印刷体**宽**，文本会**超出** bbox，
 * 故不裁切」。**实测否定**：CJK 全角在印刷体与 Songti SC 中都精确 1em（度量误差为 0，
 * ink-groundtruth M5 实测浏览器行墨迹宽/字 = 0.994em）；真实缺陷是字号**偏小 30%**、
 * 文字**填不满** bbox。方向搞反了——所以本模块的系数是**放大**（0.72 → 1.03），不是缩字。
 *
 * 尺度常量有两个口径，勿混用（F10）：CANVAS_W = 760（阶段 1–5 画布）、
 * PANE_W = 460（对比模式单栏）。本模块对两者一视同仁，由调用方传 canvasW；
 * 系数 c 与 canvasW 无关（c = S_ink/bboxH），故 760 与 460 共用同一常数。
 */

/** 行高 → 字号（画布 px）。
 *
 * 定案系数 1.03（F4）。4px 是**安全下限**（防止极小 bbox 推出 0 或负字号），
 * 不是保真夹子——旧的 8–20px 夹子已在上一轮移除，不要加回来：正是它把正文行抬到 8px、
 * 把选项行压到 7px，直接造成字号偏离原卷。
 */
export function fontFromLineHeight(hPx) {
  return Math.max(4, hPx * 1.03);
}

/**
 * 页面基准字号（画布 px）：由该页**不含公式/上下标**的文本行 bbox 高推算（取中位数）。
 *
 * 为什么需要它：含 \frac 的行，bbox 高包含分式分子/分母的上下延伸，**远大于字号**
 * （第 2 页实测 22pt vs 正文 11pt）——直接按它推字号会让这些行字号翻倍。
 * 用中位数而非均值，是为了不被标题（字号本来就大）拉偏。
 *
 * @param {Array<{kind?: string, text?: string, bbox: number[]}>|undefined} blocks 页面块（pt 坐标）
 * @param {number} pageWidth 页面宽度（pt，快照为 596）
 * @param {number} canvasW 画布像素宽（CANVAS_W=760 或 PANE_W=460）
 * @returns {number|null} 无可用文本块时返回 null
 */
export function baseFontOfPage(blocks, pageWidth, canvasW) {
  const hs = [];
  for (const b of blocks ?? []) {
    if (b.kind !== "text" || !b.text) continue;
    if (/\\frac|\\sqrt|[_^]/.test(b.text)) continue;
    hs.push(b.bbox[3] - b.bbox[1]);
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return fontFromLineHeight((hs[Math.floor(hs.length / 2)] / pageWidth) * canvasW);
}

/** 块的渲染字号：纯文本行按自身行高推算（标题自然更大，层级自动复现 F7）；
 * 含公式/上下标的行用页面基准字号（避免分式撑高 bbox 导致字号翻倍）。
 * baseFont 为 null 时回退到自身行高推算。
 *
 * @param {{text?: string, bbox: number[]}} block
 * @param {number} pageWidth 页面宽度（pt）
 * @param {number} canvasW 画布像素宽
 * @param {number|null} baseFont 页面基准字号（画布 px），可空
 */
export function fontForBlock(block, pageWidth, canvasW, baseFont) {
  if (baseFont && /\\frac|\\sqrt|[_^]/.test(block.text ?? "")) return baseFont;
  return fontFromLineHeight(((block.bbox[3] - block.bbox[1]) / pageWidth) * canvasW);
}

/**
 * 文本的**全角当量宽度和**（供 Task 2 的字号保真审计用：由 bbox 宽 / 当量字数反推
 * 「宽度隐含字号」，与行高推算的字号对照）。
 *
 * 权重表（逐字，勿自行调整）：
 *   全角/CJK（含全角标点）= 1.0；ASCII 字母数字 = 0.5；ASCII 空格 = 0.25；
 *   其余可见 ASCII 标点 = 0.3；`\n`/`\t` = 0。
 *
 * 「全角/CJK」取非 ASCII 码位：CJK 表意文字、全角标点（、。，…）、全角符号均在
 * U+2E80 以上，一律记 1.0em（与上一轮 stages.js 的 CJK_RE 口径一致）。
 */
export function emWidthOf(text) {
  let ems = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") continue; // 0：换行/制表不占宽度
    if (ch === " ") { ems += 0.25; continue; } // ASCII 空格
    if (ch.charCodeAt(0) < 0x80) {
      // ASCII：字母数字 0.5，其余可见标点 0.3
      ems += /[0-9A-Za-z]/.test(ch) ? 0.5 : 0.3;
    } else {
      ems += 1.0; // 全角/CJK（含全角标点）
    }
  }
  return ems;
}
