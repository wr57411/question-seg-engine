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
 *
 * ── 行高模型的**适用边界**（Task 4，R1/R2/R4）──
 * `fontFromLineHeight` 只对**行级、水平**块成立。越界的三类块各有专法：
 *   R4 竖排块：bboxH 是文字**长度**方向而非行高 → 用 bboxW 当行高（`isVerticalText`）。
 *   R1 段级块：阶段 1 的 MinerU 块是整段多行，bboxH 是整段高 → 按框宽适配
 *      （`fontForRawBlock`：取 min(行高推算, 框宽当量)，下限 8px，**无 20px 上限**）。
 *   R2 栏宽口径：对比模式单栏是 PANE_W=460，凡在对比栏内渲染的字号换算都必须传 460
 *      （`renderDiscardedInto` 曾硬编码 760 → 丢弃块偏大 760/460 = 1.65×）。
 *
 * ── 行高模型的过冲与宽度安全上限（R3/R5，测量定案）──
 * `fontFromLineHeight` 对**行级水平**块成立，但 bboxH 被行盒/上下延伸撑大的个别行（页眉页脚、
 * `计划用时` 行、短标签）会被高估 → 渲染宽 > bbox 宽 → 压字。`clampByWidth` 把字号夹到
 * `bboxW_px / emWidthOf(text)`（含 ASCII 与纯 CJK 一视同仁；竖排、**公式源码块**与无文本块除外）。
 * **R3 的「拉丁字形失配」假设已被测量推翻**（混合组与纯 CJK 对照几乎相等，换拉丁字体栈无效）——
 * 证据见 data/out/latin-metrics.md，改法依据见 clampByWidth 注释。
 *
 * ── 公式块豁免夹子（C1 修复，Task 7）──
 * `clampByWidth` 曾对**含公式的块**用 `emWidthOf(block.text)` 度量，而 `block.text` 是**原始
 * LaTeX 源码**（如 `\frac{\sqrt3}{3}mg` 记 12.25em），渲染文本只有 3em → 夹子把公式块字号压到
 * 基准的 **0.20–0.75×**（131/1015 块 <0.8×，最极端 **1.76px**），且审计判定项因排除 `\`/`$`/ASCII
 * 块而看不见它。**裁定：公式块不参与宽度夹子**（`hasMathSource` 命中即返回未夹字号）——
 * `emWidthOf` 是线性字符宽度模型，对二维排版（`\frac`/`\sqrt`）不成立，用错误模型夹比不夹更糟。
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
 * 页面基准字号（画布 px）：由该页**不含 LaTeX 源码**（`hasMathSource` 未命中）的文本行
 * bbox 高推算（取中位数）。
 *
 * 为什么需要它：含 \frac 的行，bbox 高包含分式分子/分母的上下延伸，**远大于字号**
 * （第 2 页实测 22pt vs 正文 11pt）——直接按它推字号会让这些行字号翻倍。
 * 判据统一到 `hasMathSource`（Task 10）：凡含 LaTeX 源码的行都不作样本，与
 * `fontForBlock` 的「含 LaTeX 源码即用基准字号」口径一致。
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
    if (hasMathSource(b.text)) continue; // 含 LaTeX 源码的行（bbox 高可能被二维结构撑高）不作样本
    hs.push(b.bbox[3] - b.bbox[1]);
  }
  if (!hs.length) return null;
  hs.sort((a, b) => a - b);
  return fontFromLineHeight((hs[Math.floor(hs.length / 2)] / pageWidth) * canvasW);
}

/** 公式源码判定（C1 修复，Task 7）：文本含 LaTeX 源码特征即命中 —— **反斜杠、美元符、
 * 下划线、脱字符任一**。判据逐字采用裁定 `/[\\$]|[_^]/`，不自创更复杂的启发式。
 *
 * 为什么需要它：`block.text` 是**原始 LaTeX 源码**（如 `$F_{1}$`、`\frac{mg}{k_1+k_2}`），
 * 而实际渲染走的是 `prettifyLatex(b.text)`。源码字符数比渲染文本宽 **3–5 倍**，
 * `emWidthOf(raw)` 会把公式块的当量宽算大几倍 → `clampByWidth` 把字号压到基准的 0.20–0.75×
 * （131/1015 块 <0.8×，最极端 1.76px）。命中本函数即表示「该块的宽度不能按源码度量」。
 *
 * @param {string} text 块的**原始**文本（LaTeX 源码）
 */
export function hasMathSource(text) {
  return /[\\$]|[_^]/.test(text ?? "");
}

/** 竖排文本判定（R4）：bbox **高 > 2×宽**（严格大于，`bboxH == 2*bboxW` 不算竖排）
 * 且文本当量宽 ≥ 2em（1 个字的窄块不算，避免误判）。
 *
 * 为什么需要：竖排文字的「行高」是**横向宽度**，而 bboxH 是文字**长度**方向
 * （侧栏「第二章相互作用」bbox 13×91pt，bboxH=91 是 7 个字的长度）。若仍按 bboxH 推字号，
 * 会把文字长度当行高 → 字号 119.5px，溢出栏外。
 *
 * @param {number[]} bbox [x0, y0, x1, y1]（pt）
 * @param {string} text
 */
export function isVerticalText(bbox, text) {
  return bbox[3] - bbox[1] > 2 * (bbox[2] - bbox[0]) && emWidthOf(text) >= 2;
}

/** 块的渲染字号：纯文本行按自身行高推算（标题自然更大，层级自动复现 F7）；
 * 含 LaTeX 源码的行用页面基准字号（避免分式撑高 bbox 导致字号翻倍）。
 * baseFont 为 null 时回退到自身行高推算。
 * 竖排块（R4）改取 bboxW 当行高——见 isVerticalText。
 *
 * 判据统一到 `hasMathSource`（Task 10）：此前此处用一条**只认 \frac/\sqrt/下标 的窄正则**，
 * 比 `clampByWidth` 的 `hasMathSource`（更宽，含 `\`/`$`）窄 —— 含 `\angle A O B` 这类
 * 「有 `\` 无 `_^`」的块**一边走高度模型（字号偏大）、一边被豁免宽度夹子（无宽度兜底）**
 * → 第 9 页溢出叠字。
 * 现两处判据同源：含 LaTeX 源码的块一律用页面基准字号，且不参与宽度夹子。
 *
 * @param {{text?: string, bbox: number[]}} block
 * @param {number} pageWidth 页面宽度（pt）
 * @param {number} canvasW 画布像素宽
 * @param {number|null} baseFont 页面基准字号（画布 px），可空
 */
export function fontForBlock(block, pageWidth, canvasW, baseFont) {
  if (isVerticalText(block.bbox, block.text ?? "")) {
    // 竖排：行高取 bboxW（横轴），否则用 bboxH 会把「文字长度」当行高 → 字号失控
    return fontFromLineHeight(((block.bbox[2] - block.bbox[0]) / pageWidth) * canvasW);
  }
  if (baseFont && hasMathSource(block.text ?? "")) return baseFont;
  return fontFromLineHeight(((block.bbox[3] - block.bbox[1]) / pageWidth) * canvasW);
}

/** 宽度安全上限（R3/R5）：把行高模型给出的字号夹到「文字当量宽 × 字号 ≤ bbox 宽」，
 * 即 `emWidthOf(text) * F ≤ bboxW_px`。仅在字号会让文字**横向溢出 bbox** 时生效。
 *
 * 为什么需要（测量定案，见 data/out/latin-metrics.md）：
 *   R3 曾假设「含 ASCII 的行溢出，因为浏览器拉丁字形取自 Songti SC、advance 与原卷印刷体不同」。
 *   **测量推翻该假设**：分三组量「渲染宽 / 原卷墨迹宽」——纯 CJK 对照 0.968、CJK+ASCII 混合 0.963，
 *   二者几乎相等（无拉丁特异性）；把 `"Times New Roman"` 提到 `"Songti SC"` 之前，混合组中位仍在
 *   0.99 附近（净样本 cur 0.9917 / times 0.9859），**所有候选字体栈 |偏差| ≤ 1.4%**，换字体栈
 *   **不能显著改善**（详见 latin-metrics.md §M2）。真实原因是**行高模型在个别行上过冲**：
 *   bboxH 被行盒/上下延伸撑大的行（页眉页脚、`计划用时` 行、短标签），`1.03×bboxH` 大于真实字号，
 *   渲染宽 > bbox 宽 → 压到相邻块。**纯 CJK 块同样溢出**（丢弃页脚实测溢出 83px），故不能只夹 ASCII。
 *   逐块夹到 bbox 宽是唯一能同时压住两类溢出的改法。
 *
 * ── 作用域裁定（2026-10-08，**撤销**计划 Task 5「只对含 ASCII 的块生效」）──
 *   原规格写「对含 ASCII 的块生效（纯 CJK 块不受影响，避免削掉保真值）」，**已撤销**。
 *   理由：纯 CJK 的**宽度隐含字号 ≈ 高度模型字号**（实测中位比 1.0048，仅差 0.5%），夹子对它
 *   **无害**，且让渲染**恰好填满 bbox**（正是保真目标）；而「只夹 ASCII」会让纯 CJK 块仍可溢出
 *   （丢弃页脚即纯 CJK 溢出 83px）。故**保留全局 clamp**（仅竖排块与无文本块原样返回）。
 *   见 .superpowers/sdd/2026-10-08-reconstruction-font-fidelity/progress.md 的 Ruling。
 *
 * 纯 CJK 块：`emWidthOf` 恰 = 字数，夹后 `F = bboxW/字数` → 渲染宽恰填满 bbox，**不削保真**
 *   （只有本会溢出的块被夹小；未溢出的块 `min()` 不改其字号，故「字号保真度」中位数不受影响）。
 * 竖排块（R4）：横向宽度不是约束（文字沿纵向排布），原样返回。
 *
 * ── 公式块豁免（C1 修复，Task 7，**Ruling**）──
 * **公式块（`hasMathSource` 命中）不参与宽度夹子，直接返回未夹字号。**
 * 理由：`emWidthOf` 是**线性字符宽度模型**，对 `\frac`/`\sqrt` 这类**二维排版**根本不成立
 *   —— 源码 `\frac{\sqrt{3}}{3}mg` 记 12.25em，实际渲染 `√33mg` 只有 3em；用错误的模型去夹
 *   比不夹更糟（实测把公式块字号压到基准的 0.20–0.75×，最极端 1.76px，肉眼近乎不可见）。
 * 公式块已有专属规则（`fontForBlock` 用页面基准字号 `baseFont`），其溢出风险由视觉审板承担。
 * 代价：公式块的横向溢出不再被结构性防止（审计「文字溢出」节因此把公式块列入排除分桶，
 *   见 scripts/audit-render.mjs）。
 *
 * @param {number} fontPx 行高模型给出的字号（画布 px）
 * @param {{text?: string, bbox: number[]}} block
 * @param {number} pageWidth 页面宽（pt）
 * @param {number} canvasW 画布像素宽
 */
export function clampByWidth(fontPx, block, pageWidth, canvasW) {
  if (isVerticalText(block.bbox, block.text ?? "")) return fontPx; // 竖排：横向宽度非约束
  if (hasMathSource(block.text ?? "")) return fontPx; // 公式块豁免（C1 修复，见上方 Ruling）
  const em = emWidthOf(block.text ?? "");
  if (em <= 0) return fontPx; // 无文字（图片/空块）：无可贴合，不夹
  const wPx = ((block.bbox[2] - block.bbox[0]) / pageWidth) * canvasW;
  return Math.min(fontPx, wPx / em);
}

/** 阶段 1（原料视图）**段级块**的字号（R1）：按**框宽适配**。
 *
 * 为什么不能用行高模型：阶段 1 的块是 MinerU **段级**块（整段多行），bboxH 是整段高度
 * 而非行高（第 1 页整段 bboxH 达 163pt → 行高推算 172.6px，远超页面）。
 * 该视图的定位是「看**框**对不对」（整段有没有被框住、图片框位置、标题有没有被认成正文），
 * **不是看文字保真** —— 故让文字宽度去贴合框宽，字号取两者较小：
 *   min(fontFromLineHeight(bboxH 换算), bboxW_px / emWidthOf(text))
 * 下限 8px；**不加 20px 上限**（上限是上一轮被移除的保真夹子，不恢复）。
 *
 * 边界：`emWidthOf(text) === 0`（图片块 / 空文本块）时宽度项退化（÷0），
 * 无文字可贴合 → 直接取下限 8px。
 *
 * @param {{text?: string, bbox: number[]}} block
 * @param {number} pageWidth 页面宽度（pt）
 * @param {number} canvasW 画布像素宽
 */
export function fontForRawBlock(block, pageWidth, canvasW) {
  const em = emWidthOf(block.text ?? "");
  if (em <= 0) return 8; // 无文本：宽度项退化，取下限
  const hPx = ((block.bbox[3] - block.bbox[1]) / pageWidth) * canvasW;
  const wPx = ((block.bbox[2] - block.bbox[0]) / pageWidth) * canvasW;
  return Math.max(8, Math.min(fontFromLineHeight(hPx), wPx / em));
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
