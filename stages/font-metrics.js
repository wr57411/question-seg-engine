/**
 * font-metrics.js —— 重建纸面的字号/全角宽度度量（纯函数，无 DOM；唯一依赖 latex-display 的纯函数）。
 *
 * 定位：stage 6「对比模式」用结构化数据按原坐标重建纸面，但 MinerU 的 layout.json
 * **没有字号字段**（F9）——字号真值不存在，只能由行高反推。本模块把这套数学抽成
 * 纯函数，好让 tests/font-metrics.test.ts 把它钉死；此前它藏在无构建的 stages.js 里、
 * 没有任何测试，一次系数写错就整体偏小 30%（F3）而无人察觉。
 *
 * ⚠️ 唯一依赖：Task 14 起 `clampByWidth` 需按**渲染后的纯文本**度量宽度（见下），
 * 故 import `prettifyLatex`（`./latex-display.js`，同为无 DOM 纯函数，无循环依赖）。
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
 * ── 公式块豁免夹子（C1 修复，Task 7；Task 14 收窄）──
 * `clampByWidth` 曾对**含公式的块**用 `emWidthOf(block.text)` 度量，而 `block.text` 是**原始
 * LaTeX 源码**（如 `\frac{\sqrt3}{3}mg` 记 12.25em），渲染文本只有 3em → 夹子把公式块字号压到
 * 基准的 **0.20–0.75×**（131/1015 块 <0.8×，最极端 **1.76px**），且审计判定项因排除 `\`/`$`/ASCII
 * 块而看不见它。**裁定：公式块不参与宽度夹子**（`hasMathSource` 命中即返回未夹字号）——
 * `emWidthOf` 是线性字符宽度模型，对二维排版（`\frac`/`\sqrt`）不成立，用错误模型夹比不夹更糟。
 * **Task 14 收窄**：豁免只留给**真正二维**的构造（含 `\frac`/`\sqrt`）；其余含 LaTeX 的块
 * （`$\angle AOB$`、`$F_{a}$`）改按**渲染后的纯文本**度量宽度、参与夹子（见 `renderedTextOf`）。
 *
 * ── 短块碎片：bbox 被撑大的结构判据（Task 14）──
 * Task 13 的交叉验证（`reconcileFont`）只在**全角字数 ≥ 6** 时生效，且要求宽、高两估计量**不一致**
 * 才退回基准。它抓不住两类残留（全卷 60 条 `fontForBlock > 1.35× 基准`）：
 *   ① 短块（< 6 全角）—— 判据前置条件直接跳过（`变大`/`增大`/`为零`/`确的是()`…）；
 *   ② **两估计量同时被撑大**的块（`舱的阻力，则下列说法正确的是()`，比值仅 1.04）—— 宽高一致，
 *      但**两者都错**（原卷墨迹高仅 10.6pt、声明 bbox 高 16pt）。
 * 回原卷逐块量墨迹（`pdftoppm -r 300` + 二值化取包围盒，脚本 data/out/_t14-ink.mjs）发现真因：
 * **这些块的声明 bbox 高被 MinerU 撑大**（行续接/并入邻块/并图片），声明高 15–19pt 而真实墨迹
 * 高仅 **10.1–10.8pt**（正文量级）；而真标题的墨迹高 **12.7–15.1pt**（真的大）。
 *
 * ── 修复轮 1：间隙分布直方图 + 两道独立条件（评审发现 1）──
 * 上一轮只按「间隙 ≤ 7pt」压（`isCrampedLine`），触发带覆盖全卷 65% 的块，且「保留下界 9pt」
 * 只差 2pt —— 换一册（标题行距更紧）会误压标题，且无第二条件兜底。修复轮 1 做了三件事：
 *
 * ① **量全卷间隙分布**（脚本 data/out/_t14b-gap-hist.mjs / _t14b-band.mjs）：对**候选块**
 *    （`fontForBlock > baseFont`，即本判据的生效域）按「到最近同栏邻块的垂直间隙」分桶：
 *    `…4:26 5:49 6:59 7:62 8:17 9:5 10:2…` —— 7→8 出现 **3.6× 的陡降**（真实空档，
 *    非 1 样本偶然空档），8→9 再降 3.4×。
 *
 * ② **把间隙阈值选在真实空档上**：`LINE_CLEARANCE_MIN_PT = 6`。且在**加条件二后**，判据生效域
 *    （`rh ≥ 1.4`，见下）内的间隙分布干净双峰：**31 块 @ ≤6、0 块 @ 7–8、18 块 @ ≥9**
 *    —— 阈值 6 与「保留下界 9」之间有 **3pt 宽、0 样本**的真实空档（上一轮只有 1pt 宽的
 *    「8pt 无样本」）。余量 3pt = 上一轮 2pt 的 **1.5×**。「明显」的判定：空档宽 ≥ 3pt
 *    （> 直方图 1pt 分辨率 3 倍）且**两侧各有实质样本峰**（31 / 18），非孤立空点。
 *
 * ③ **加一道独立兜底**（评审建议「行高与基准的比值下界」）：`LINE_INFLATION_MIN = 1.4`
 *    —— 块的行高必须 ≥ 1.4× 页面基准才允许压。它与间隙是**两个独立量**（行高 vs 间距），
 *    单独任一命中都不压。**为什么是这个量**：唯一能把「被撑大的碎片」与「真标题」分开的
 *    渲染期信号就是间隙（实测 6 个候选特征中只有 gap 与标题区间不重叠）；行高下界本身
 *    分不开二者（碎片 rh 1.42–1.73、标题 rh 1.45–2.18），它的作用是**保守量级闸**：
 *    只压「确实显著偏高」的块，把轻微偏高（rh<1.4）的正文行排除在外，从而把判据生效域
 *    收窄到干净双峰，并防止阈值附近抖动误伤。
 *    ⚠️ **为什么不是更宽的量级闸**：全卷有 118 块 `rh ∈ [1.05,1.4)` 且 `gap ≤ 6`，
 *    回原卷量墨迹（脚本 data/out/_t14b-ink-mild.mjs，墨迹高/base 中位 **0.94**）证实
 *    它们**同样是被撑大的正文行**（字形与邻行同大、bbox 被撑高），压回基准是**正确的**；
 *    故量级闸不能设更高（否则回退这 118 块的真实改善）。
 *    **真标题安全**由条件一保证（标题实测间隙 ≥ 9pt，全部落在 6pt 阈值之外）。
 */

import { prettifyLatex } from "./latex-display.js";

/** 行高 → 字号（画布 px）。
 *
 * 定案系数 1.03（F4）。4px 是**安全下限**（防止极小 bbox 推出 0 或负字号），
 * 不是保真夹子——旧的 8–20px 夹子已在上一轮移除，不要加回来：正是它把正文行抬到 8px、
 * 把选项行压到 7px，直接造成字号偏离原卷。
 */
/** @param {number} hPx 行高换算出的字号（画布 px） */
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

/** 二维排版构造判定（Task 14）：文本含 `\frac`/`\dfrac`/`\tfrac`/`\sqrt` 任一。
 *
 * 为什么单独摘出：`emWidthOf` 是**线性字符宽度模型**，对 `\frac`（上下叠放）与 `\sqrt`
 * （被开方数在根号内）**根本不成立** —— 源码 `\frac{\sqrt{3}}{3}mg` 记 12.25em，渲染文本
 * `√33mg` 只有 3em。Task 14 收窄 C1 的豁免范围：**只有这两类块**继续豁免 `clampByWidth`，
 * 其余含 LaTeX 的块（`$\angle AOB$`、`$F_{a}$`）改按**渲染后的纯文本**度量宽度、参与夹子。
 *
 * @param {string} text 块的**原始**文本（LaTeX 源码）
 */
export function hasTwoDimensionalMath(text) {
  // **命令名边界**（修复轮 1 发现 2）：原正则 `\\[dt]?frac|\\sqrt` 无边界，`\fraction` 会被当成
  // `\frac`。用**负向前瞻字母** `(?![A-Za-z])` 而非 `\b`：LaTeX 命令名是 `[A-Za-z]+`，故「后面不是
  // 字母」才是正确边界；`\b`（`\w` 含数字）会连 `\frac12`/`\sqrt3` 这类**数字紧跟**的合法写法
  // 一并排除，导致这些块漏豁免夹子 → C1 过夹回归。⇒ `\frac`/`\dfrac`/`\tfrac`/`\sqrt` 命中，
  // `\fraction`/`\dfracx`/`\fracx`/`\sqrtx` 不命中，而 `\frac12`/`\sqrt3`/`\frac{...}` 命中。
  return /\\(?:d|t)?frac(?![A-Za-z])|\\sqrt(?![A-Za-z])/.test(text ?? "");
}

/** HTML 片段 → 纯文本：剥掉标签、还原 `escapeHtml` 转义的三字符。
 * 供 `renderedTextOf` 使用（标签只由 latex-display 生成，属性值不含 `>`）。 */
/** @param {string} html */
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 块的**渲染后纯文本**（Task 14）：`stripTags(prettifyLatex(text))`。
 *
 * 为什么需要：`clampByWidth` 的目标是「**渲染出来的**文字不横向溢出 bbox」，
 * 故宽度度量必须用渲染文本，而不是原始 LaTeX 源码（后者宽 3–5×）——
 * 这正是 C1 过夹（字号压到基准 0.20–0.75×、最极端 1.76px）的根因。
 *
 * ⚠️ 渲染文本与源码的差异（都由 prettifyLatex 的展示层变换引入，且**都是原卷就有**的）：
 *   - `()` → `(　　)`：空括号补 2 个 EM SPACE（原卷作答空隙）；
 *   - 选项粘连 → 补 EM SPACE 分隔；
 *   - 即时重复前缀 → 折叠一份（原卷只有一份）；
 *   - LaTeX 命令 → 渲染字符（`\frac`→竖排、`\sqrt`→`√`、`\theta`→`θ`、`^{2}`→`2`）。
 *   EM SPACE（U+2003）在 `emWidthOf` 里按 1.0em 计（全角档），与实际宽度相符。
 *
 * @param {string} text 块的**原始**文本
 */
export function renderedTextOf(text) {
  return stripTags(prettifyLatex(text ?? ""));
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

/** 两估计量不一致的判定阈值（Task 13）：`max(fontH, fontW) / min(fontH, fontW) > 1.3`
 * 即认为该块 bbox 至少一个维度不可信 → 退回页面基准字号。
 * 1.3 的由来：真标题（宽高一致）实测比值 ≤ 1.10（第二章 1.03 / 第3节 1.10 / 专题 1.03 /
 * 全章综合测试 1.09），而被撑大的框比值 ≥ 1.34（见 reconcileFont）。 */
const FONT_ESTIMATOR_MAX_RATIO = 1.3;

/** 交叉验证生效所需的最小**全角字数**（Task 13 修复轮 1）。
 *
 * 为什么需要这道前置条件：`fontW = bboxW_px / emWidthOf(text)` 只有在文本**足够长**时才可信
 * ——2–3 个字的块，`bboxW / emWidthOf` 的噪声极大（一个字的 bbox 边界误差就能把 fontW 拉动
 * 30%+），拿它去否定 `fontH` 不成立。实测：`刷易错`/`刷基础`/`刷提分`/`刷真题`（均 3 字）
 * 被 1.3 阈值误判为「框被撑大」而压到基准，与验收「真标题/横幅标签必须保留」冲突。
 * 故：全角字数 < 6 的块**不比较**，直接用 `fontH`。
 * 取 6 与审计「字号保真度」节的可判块门槛（`FIDELITY_MIN_FW = 6`）一致。 */
const FONT_ESTIMATOR_MIN_FW = 6;

/** 全角/CJK 字数：码位 ≥ U+2E80 的字符计数（与 `emWidthOf` 的「全角/CJK」口径、
 * 审计 `FW_MIN = 0x2e80` 一致）。供交叉验证的「全角字数 ≥ 6」前置条件使用。 */
/** @param {string} text */
export function fullWidthCount(text) {
  let n = 0;
  // `codePointAt` 返回 `number | undefined`（空串/越界）。原写法依赖 `undefined >= n` 恒 false，
  // 加类型检查后暴露（`TS2532`）；显式取 0 语义完全一致，但不再是"靠隐式转换成立"。
  for (const ch of text ?? "") if ((ch.codePointAt(0) ?? 0) >= 0x2e80) n++;
  return n;
}

/** 两个独立估计量的交叉验证（Task 13，**判据只此一处定义**）。
 *
 * 背景：块 `p10[18]` 文本 `"弹力先变大后变小E"` bbox `[68,367,212,391]`（宽 144pt / 高 24pt）
 * ——MinerU 把它和旁边图片块并到一起、还带进游离字符 `E`，**两个方向都被撑大**：
 *   fontH = 19.08px（2.18× 页面基准），fontW = 13.08px（1.50× 基准）；
 * `clampByWidth` 只把它压到 1.47×（宽度也是错的，宽度上限救不了）→ 渲染成 2 倍字号。
 * 同一页 `p10[20]` 同样 8 个字，bbox `[67,406,160,419]`（宽 93pt / 高 13pt）→ 正常字号。
 *
 * 判据（**两段**）：
 *   ① 前置条件：全角字数 ≥ `FONT_ESTIMATOR_MIN_FW`(6) —— 短块的 `fontW` 噪声大，不可用于否定
 *      `fontH`（修复轮 1）；不满足则**不比较**，直接返回 `fontH`。
 *   ② 交叉验证：宽、高是两条独立路径。一致 ⇒ 块确实更大（真标题，保留 fontH）；
 *      不一致（比值 > 1.3）⇒ 框被撑大（用 baseFont 兜底）。baseFont 为 null 时退回 fontH。
 *
 * @param {number} fontH 行高模型给出的字号（画布 px）
 * @param {number} fontW 宽度模型给出的字号（画布 px）＝ bboxW_px / emWidthOf(text)
 * @param {number|null} baseFont 页面基准字号（画布 px），可空
 * @param {number} fwCount 该块文本的**全角字数**（见 fullWidthCount）
 */
export function reconcileFont(fontH, fontW, baseFont, fwCount) {
  if (fwCount < FONT_ESTIMATOR_MIN_FW) return fontH; // 短块：fontW 噪声大，不比较
  const hi = Math.max(fontH, fontW);
  const lo = Math.min(fontH, fontW);
  if (lo > 0 && hi / lo > FONT_ESTIMATOR_MAX_RATIO) return baseFont ?? fontH;
  return fontH;
}

/** 同栏相邻行的最小垂直间隙（pt）—— 结构判据「框被撑大」的**条件一**（Task 14；修复轮 1 收紧）。
 *
 * 由来（**回原卷逐块量墨迹** + 全卷间隙分布直方图，脚本 data/out/_t14-ink.mjs /
 * _t14b-gap-hist.mjs / _t14b-band.mjs）：
 * MinerU 偶发把**行续接的碎尾**、**并入邻块**或**并入图片**的块给一个被撑大的 bbox
 * （声明高 15–19pt，真实墨迹高仅 10.1–10.8pt = 正文量级）。被撑大的框**挤在相邻行上**。
 *
 * **修复轮 1 收紧到 6**（上一轮是 7，余量只有 2pt）：候选块（`fontForBlock > baseFont`）
 * 的间隙直方图为 `…5:49 6:59 7:62 8:17 9:5…`——7→8 陡降 3.6×（真实空档）。取 **6** 后，
 * 判据生效域（加条件二 `rh ≥ 1.4`）内间隙分布干净双峰：31 块 @ ≤6、0 块 @ 7–8、18 块 @ ≥9，
 * 阈值 6 与保留下界 9 之间是 **3pt 宽、0 样本**的真实空档（余量 3pt = 上一轮 2pt 的 1.5×）。
 *
 * 用**结构证据**（框与谁相邻）而非再收紧比值阈值：比值是「拿一个噪声量卡另一个噪声量」，
 * 而「挤在邻行上」直接反映 bbox 被撑大的成因。
 */
const LINE_CLEARANCE_MIN_PT = 6;

/** 行高相对页面基准的最小倍数 —— 结构判据「框被撑大」的**条件二**（独立量级闸；Task 14 修复轮 1）。
 *
 * 为什么需要（评审发现 1：单靠间隙判据余量不足、缺独立兜底）：
 * 间隙是「框被撑大」的**唯一**可分信号（实测 6 个候选特征里只有间隙能把碎片与标题分开），
 * 但它单独用仍可能被相邻排版抖动误触发。加一道**独立的量级闸**：块的行高必须显著高于
 * 页面基准（`fontH ≥ 1.4 × baseFont`），才允许压回基准。
 *
 * 取 1.4：实测碎片 rh 1.42–1.73、真标题 rh 1.45–2.18（二者重叠，故 1.4 **不能**单独区分
 * 碎片与标题——标题安全靠条件一）；它把**轻微偏高**（rh < 1.4）的块排除在外，使条件一生效域
 * 收窄为干净双峰。**不能再高**：全卷 118 块 `rh ∈ [1.05,1.4)` 且 `gap ≤ 6`，回原卷量墨迹
 * （脚本 data/out/_t14b-ink-mild.mjs，墨迹高/base 中位 0.94）证实它们同样是被撑大的正文行，
 * 压回基准是对的；量级闸设更高（如 1.4 以上）会回退这批真实改善。
 */
const LINE_INFLATION_MIN = 1.4;

/** 「同栏」判据：横向重叠 ≥ 该比例 × 较小块宽（Task 14）。
 * 取 0.4：行续接的碎尾与原行横向高度重合（实测 ≥ 90%）；而页边标签/另一栏的块只与
 * 本块**擦边**重叠（p0[1]「第1节…」与右栏标签 `必刷知识T1~2…` 仅重叠 15/194 = 7.7%）——
 * 用 0.4 把「擦边」排除，避免把标题旁边的栏外标签当成同栏邻行。 */
const LINE_OVERLAP_MIN = 0.4;

/** 块 bbox 被撑大的**结构判据·条件一**（Task 14）：同页存在一个「同栏、纵向挤在一起」的文本块。
 *
 * 定义：存在另一文本块 A（非图片、有文本），使
 *   ① 同栏：A 与本块的横向重叠 ≥ `LINE_OVERLAP_MIN` × min(两块宽)；
 *   ② 纵向挤：两块的垂直间隙 ≤ `LINE_CLEARANCE_MIN_PT`（重叠时间隙记 0）。
 *
 * 命中 ⇒ 本块与邻块挤在一起（bbox 可能被撑大，见文件头「短块碎片」节）。
 * ⚠️ 这只是**条件一**；完整判据还需**条件二**（量级闸 `fontH ≥ LINE_INFLATION_MIN × baseFont`），
 * 由调用方 `fontForBlock` 一并判定。**只在会缩小字号时使用**（调用方判 `F > baseFont`）——绝不放大。
 *
 * @param {{bbox: number[], text?: string, kind?: string}} block 待判块
 * @param {Array<{bbox: number[], text?: string, kind?: string}>|undefined} pageBlocks 同页候选邻块
 */
export function isCrampedLine(block, pageBlocks) {
  if (!pageBlocks) return false;
  /** @param {{bbox: number[]}} b */
  const w = (b) => b.bbox[2] - b.bbox[0];
  const bw = w(block);
  if (bw <= 0) return false;
  for (const a of pageBlocks) {
    if (a === block || a.kind === "image" || !a.text) continue;
    const ov = Math.min(block.bbox[2], a.bbox[2]) - Math.max(block.bbox[0], a.bbox[0]);
    if (ov < LINE_OVERLAP_MIN * Math.min(bw, w(a))) continue;
    const gap = Math.max(block.bbox[1] - a.bbox[3], a.bbox[1] - block.bbox[3]);
    if (gap <= LINE_CLEARANCE_MIN_PT) return true;
  }
  return false;
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
 * 两估计量交叉验证（Task 13）：非公式文本块在返回前过
 * `reconcileFont(fontH, fontW, baseFont, fullWidthCount(text))` —— **全角字数 ≥ 6** 且宽高两路
 * 不一致（比值 > 1.3）时退回页面基准字号，修掉 `p10[18]` 的 2 倍字号；短块（< 6 字）不比较。
 *
 * 结构判据（Task 14；修复轮 1 加条件二）：若给了 `pageBlocks`，再判「框被撑大」——需**同时**满足
 *   条件一 `isCrampedLine`（块与同栏邻行挤在一起，间隙 ≤ 6pt）**且**
 *   条件二 `fontH ≥ LINE_INFLATION_MIN × baseFont`（行高显著高于基准，量级闸）
 * ⇒ 退回页面基准字号。**仅在会缩小时生效**（`F > baseFont`），绝不放大；这覆盖了 Task 13
 * 抓不住的两类残留（短块 + 宽高同时被撑大者）。两道条件相互独立（间距 vs 行高量级），
 * 真标题因间隙 ≥ 9pt 不满足条件一而全部安全。
 *
 * @param {{text?: string, bbox: number[]}} block
 * @param {number} pageWidth 页面宽度（pt）
 * @param {number} canvasW 画布像素宽
 * @param {number|null} baseFont 页面基准字号（画布 px），可空
 * @param {Array<{text?: string, bbox: number[], kind?: string}>} [pageBlocks] 同页候选邻块（判「同栏挤压」用）
 */
export function fontForBlock(block, pageWidth, canvasW, baseFont, pageBlocks) {
  if (isVerticalText(block.bbox, block.text ?? "")) {
    // 竖排：行高取 bboxW（横轴），否则用 bboxH 会把「文字长度」当行高 → 字号失控
    return fontFromLineHeight(((block.bbox[2] - block.bbox[0]) / pageWidth) * canvasW);
  }
  if (baseFont && hasMathSource(block.text ?? "")) return baseFont;
  const fontH = fontFromLineHeight(((block.bbox[3] - block.bbox[1]) / pageWidth) * canvasW);
  const em = emWidthOf(block.text ?? "");
  if (em <= 0) return fontH; // 无文本：没有宽度估计量可交叉验证，退回行高模型
  const fontW = (((block.bbox[2] - block.bbox[0]) / pageWidth) * canvasW) / em;
  const F = reconcileFont(fontH, fontW, baseFont, fullWidthCount(block.text ?? ""));
  // Task 14 / 修复轮 1：框被撑大 → 基准字号。条件一（同栏挤压）+ 条件二（量级闸）**都要**满足；
  // 只在会缩小时生效（绝不放大）。
  if (
    baseFont &&
    F > baseFont &&
    fontH >= LINE_INFLATION_MIN * baseFont &&
    isCrampedLine(block, pageBlocks)
  ) {
    return baseFont;
  }
  return F;
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
 * ── 公式块豁免（C1 修复 Task 7；Task 14 **收窄**）──
 * Task 7 曾对**所有**含 LaTeX 源码的块（`hasMathSource` 命中）豁免夹子，理由是
 * `emWidthOf` 是线性字符宽度模型、对二维排版不成立（源码 `\frac{\sqrt{3}}{3}mg` 记 12.25em，
 * 渲染 `√33mg` 只有 3em）——用错误模型夹比不夹更糟（实测压到基准 0.20–0.75×、最极端 1.76px）。
 * **代价**：公式块横向溢出 **4.24%**（Task 11 真实 DOM 实测），超出部分被 `.canvas{overflow:hidden}` 裁掉。
 *
 * **Task 14 Ruling：把度量从「原始源码」换成「渲染后的纯文本」，豁免只留给真正二维的构造。**
 *   - 宽度度量改用 `emWidthOf(renderedTextOf(text))`（= `stripTags(prettifyLatex(text))` 的纯文本）
 *     —— 度量对象从「源码」变成「**真正渲染出来的字符**」，线性模型对一维文本重新成立；
 *   - **仅 `hasTwoDimensionalMath`（含 `\frac`/`\sqrt`）的块**继续豁免（二维叠放/根号，线性模型确实不成立）；
 *   - 其余含 LaTeX 的块（`$\angle AOB$`、`$F_{a}$` 等）**参与夹子**，用渲染文本宽度兜底。
 *
 * @param {number} fontPx 行高模型给出的字号（画布 px）
 * @param {{text?: string, bbox: number[]}} block
 * @param {number} pageWidth 页面宽（pt）
 * @param {number} canvasW 画布像素宽
 */
export function clampByWidth(fontPx, block, pageWidth, canvasW) {
  if (isVerticalText(block.bbox, block.text ?? "")) return fontPx; // 竖排：横向宽度非约束
  // 仅真正二维的构造（\frac/\sqrt）豁免；其余（含 $\angle AOB$、$F_{a}$）参与夹子（Task 14）
  if (hasTwoDimensionalMath(block.text ?? "")) return fontPx;
  // 度量对象是**渲染后的纯文本**，不是原始 LaTeX 源码（后者宽 3–5×，是 C1 过夹的根因）
  const em = emWidthOf(renderedTextOf(block.text ?? ""));
  if (em <= 0) return fontPx; // 无文字（图片/空块）：无可贴合，不夹
  const wPx = ((block.bbox[2] - block.bbox[0]) / pageWidth) * canvasW;
  /**
   * **画布夹**（`DECISIONS §86`）：上面的 `wPx/em` 只保证「文字宽 ≤ **块**宽」，
   * 它管不到「块自己贴着画布右边」。块左缘靠右 + 块宽本身大时，字号合规也会让
   * 文字右缘越过画布，被 `.canvas{overflow:hidden}` 裁掉（G1：裁切 = 静默丢内容）。
   * 实测：答案册 p17 一行超出 **0.6px**，就是这么来的。
   *
   * 可用宽 = 画布宽 − 块左缘（换算到画布 px）。左缘已在画布外（avail ≤ 0）时不夹 ——
   * 那是上游 bbox 本身越界，压字号也救不回来，交给审计提示项。
   */
  const leftPx = (block.bbox[0] / pageWidth) * canvasW;
  const availPx = canvasW - leftPx;
  const byCanvas = availPx > 0 ? availPx / em : fontPx;
  return Math.min(fontPx, wPx / em, byCanvas);
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
 * 权重表：
 *   全角/CJK（含全角标点）= 1.0；ASCII 可打印区 = **逐字实测 advance**（见 ASCII_ADVANCE）；
 *   控制字符 / `\n` / `\t` = 0。
 *
 * ⚠️ 2026-10-10 修正（有实测依据，非凭推断）：ASCII 原先**一律按 0.5em**（字母数字）/
 * 0.3em（标点）/ 0.25em（空格）估。实测 Songti SC 下字母实际宽度在 **0.177（'）～0.917（@）**
 * 之间，大写字母普遍 0.6–0.89（M=0.847、W=0.888、N=0.773、Q=0.770），远大于 0.5
 * → 含 ASCII 的行宽度被低估 **6–8%** → `clampByWidth` 的「文字不溢出 bbox」保证对这类行失效。
 * 实测（DOM，对比模式 15 页）：**纯 CJK 块零溢出**，而含 ASCII 的块最多溢出 +14px。
 * 数字实测恰为 0.469、多数标点 0.219–0.292（与旧常数接近），偏差主要来自**字母**。
 * 测量脚本：`data/out/probe-adv2.html`（0x20–0x7E 全量，100px 下量 boundingRect 宽 / 100）。
 *
 * 「全角/CJK」取非 ASCII 码位：CJK 表意文字、全角标点（、。，…）、全角符号均在
 * U+2E80 以上，一律记 1.0em（与上一轮 stages.js 的 CJK_RE 口径一致）。
 */
const ASCII_ADVANCE = (() => {
  // 0x20–0x7E 共 95 个字符，每字符 3 位「毫 em」（实测值 ×1000）
  const s =
    "250219406667448823729177292292427667219313219500" +
    "469469469469469469469469469469" +
    "219219667667667365917" +
    "679618635771658566771766354333741576847773780566770636477617710680888700659653" +
    "271500271500501333" +
    "504521412514431327469532270224474272785532508525523362364323518470667457422424" +
    "479500479667";
  const a = new Float64Array(95);
  for (let i = 0; i < 95; i++) a[i] = Number(s.slice(i * 3, i * 3 + 3)) / 1000;
  return a;
})();

/** @param {string} text */
export function emWidthOf(text) {
  let ems = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue; // 控制字符 / 换行 / 制表：不占宽
    if (c <= 0x7e) {
      ems += ASCII_ADVANCE[c - 0x20]; // ASCII 可打印区：逐字实测
      continue;
    }
    ems += 1.0; // 全角/CJK（含全角标点）
  }
  return ems;
}
