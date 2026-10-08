#!/usr/bin/env node
/**
 * audit-render.mjs —— 展示层渲染的「全量审计」，替代人工抽查截图。
 *
 * 为什么需要它：2026-10-08 用户对比模式截图报出 A.Fsin^(:)θ（上标噪声）与
 * A.0.20B.0.30（选项粘连）。此前渲染器的验收判据是「语法零残留」——
 * 即输出里没有反斜杠/花括号。但 \varepsilon 会被渲染成裸名字 "varepsilon"、
 * ^{:} 会被渲染成 "(:)"：语法干净、语义是错的，判据漏掉了一整类缺陷。
 *
 * 本工具把判据升级为**语义级**，并在**输入端**补两道检测：
 *   1. 输出端可疑模式：^(标点)、_(标点)、残留 \ 与 {}、行尾裸上下标
 *   2. 输入端覆盖率：输入文本里的 \命令 是否都在渲染器已知集内
 *   3. 选项粘连：同一文本 ≥2 个选项标记却仍无分隔
 *   4. 命令切分歧义（提示级）：整串是命令、其前缀也是命令——两种切法都合法，
 *      原意只能从原卷图像得知（如 \top 可能是 ⊤，也可能是 \to + "p"）。
 *      这一节**不计入退出码**：它报的是"机器无法判断、需人扫一眼"的信息，
 *      不是确定的错误。报出来只产生"待确认项"，猜错才产生"无人察觉的错误"。
 *   5. 字号保真度（判定级）：2026-10-08 的事故根因是**判据太松**——旧审计只看
 *      「语法零残留」，看不到「字号错 30%」。本节对快照逐块，用「行高隐含字号」与
 *      「bbox 宽隐含字号」互相印证：可判块 ratio 中位数必须落在 [0.93, 1.07]。
 *      系数若被写小（如 0.72），ratio 会整体抬到 ~1.49，本节即报红——判据真的能抓 bug。
 *   6. 文字溢出 / 宽度上限触发（**提示项**，不计退出码）：R5 的可见性缺口——第 5 节的
 *      可判块口径排除了含 ASCII 字母数字的块，而横向溢出恰发生在这类行 → 「审计全绿」与
 *      「肉眼可见的压字」可以同时成立（§17 判据粒度决定漏检粒度）。但**不能**把「渲染宽 >
 *      bboxW」写成判定项：渲染层对行级/丢弃块接了 `clampByWidth`（`em·F ≤ bboxW`），而本节用
 *      同一 `emWidthOf` 重算 ⇒ ratio ≡ ≤1，`> 1.05` 数学上不可达（**恒真的死门**，评审裁定）。
 *      故本节改报**真正非恒真的信号**——「宽度上限触发率」（高度模型字号被 bbox 宽压小的块占比），
 *      按行级块 / raw 段级块 / discarded 丢弃块**分组报数**，并附保守模型溢出清单。
 *   7. **覆盖统计（Task 7）**：第 5、6 节各报一行「覆盖块数 / 排除块数 / 排除原因分桶」。
 *      G1「不静默失败」同样适用于**门自身**——C1 之所以能被藏住，正是因为第 5 节的「可判块」
 *      口径静默排除了 `\`/`$`/ASCII 块而不报数。分桶互斥且**相加 = 排除总数**（无未归类残差）。
 *      第 6 节另把**公式源码块**列入排除桶：C1 修复后渲染层对公式块豁免 `clampByWidth`，
 *      触发信号对这类块不再适用（修复前它们 100% 命中，抬高整体触发率）。
 *
 * 用法：node scripts/audit-render.mjs [docId]
 * 退出码：0 = 判定项全部归零；1 = 判定项有发现（可接入 CI / npm run check）
 */
import { readFileSync } from "node:fs";
import { prettifyLatex, KNOWN_COMMANDS, findCommandAmbiguities } from "../stages/latex-display.js";
import { emWidthOf, fontFromLineHeight, fontForBlock, baseFontOfPage, isVerticalText, hasMathSource } from "../stages/font-metrics.js";

const docId = process.argv[2] ?? "23必刷题 2相互作用";
const SNAP = new URL(`../data/out/${docId}/stages.json`, import.meta.url);

let snap;
try {
  snap = JSON.parse(readFileSync(SNAP, "utf8"));
} catch {
  // 快照是运行时产物（data/ 不入库）：新克隆环境没有它，跳过而非报错，
  // 这样本脚本可以安全接入 npm run check。
  console.log(`渲染审计：跳过（未找到快照 ${docId}，先运行 npm run stages:export）`);
  process.exit(0);
}

/** 输出端可疑模式（语法干净但语义可疑） */
const OUT_PATTERNS = [
  ["上标括号内标点", /\^\([^A-Za-z0-9)]{1,3}\)/],
  ["下标括号内标点", /_\([^A-Za-z0-9)]{1,3}\)/],
  ["残留反斜杠", /\\/],
  ["残留花括号", /[{}]/],
  ["行尾裸上标", /\^\s*$/],
  ["行尾裸下标", /_\s*$/],
];

const outHits = Object.fromEntries(OUT_PATTERNS.map(([n]) => [n, []]));
const unknownCmds = new Map(); // 命令名 → 出现次数
const ambiguityMap = new Map(); // "命令 → 另一种切法" → { n, sample }
const stuckOptions = [];
let total = 0;

for (const p of snap.pages) {
  for (const src of ["blocks", "raw", "discarded"]) {
    for (const b of p[src] ?? []) {
      const raw = b.text ?? "";
      if (!raw) continue;
      total++;
      const shown = prettifyLatex(raw);
      for (const [name, re] of OUT_PATTERNS) {
        if (re.test(shown)) outHits[name].push({ p: p.index, src, i: b.i, shown: shown.slice(0, 80) });
      }
      // 输入端：未覆盖命令。快照文本截断（≤120 字符）会把 "\circ" 切成 "\ci"，
      // 落在文本末尾的命令视为截断伪影，不计入。
      for (const m of raw.matchAll(/\\([A-Za-z]+)/g)) {
        const name = m[1];
        if (m.index + m[0].length >= raw.length - 1) continue;
        if (KNOWN_COMMANDS.has(name)) continue;
        // 渲染器同款「最长已知前缀」回退：\thetaB 会按 \theta + "B" 处理，不算未覆盖
        let covered = false;
        for (let k = name.length - 1; k >= 1; k--) {
          if (KNOWN_COMMANDS.has(name.slice(0, k))) { covered = true; break; }
        }
        if (!covered) unknownCmds.set(name, (unknownCmds.get(name) ?? 0) + 1);
      }
      // 命令切分歧义（提示级，见文件头说明）
      for (const a of findCommandAmbiguities(raw)) {
        const key = `\\${a.command} 也可能切成 \\${a.alternative}`;
        if (!ambiguityMap.has(key)) {
          ambiguityMap.set(key, { n: 0, sample: raw.slice(Math.max(0, a.index - 18), a.index + a.command.length + 12) });
        }
        ambiguityMap.get(key).n++;
      }
      // 选项粘连：≥2 标记但标记间无空白
      const marks = shown.match(/[A-D][.．]/g);
      if (marks && marks.length >= 2 && /[^\s][A-D][.．]/.test(shown)) {
        stuckOptions.push({ p: p.index, src, i: b.i, shown: shown.slice(0, 80) });
      }
    }
  }
}

// ── 覆盖统计（G1：门自身也不得静默失败）──────────────────────────────────────
// 审计必须报告自己的**覆盖缺口**：多少块被纳入判定、多少被排除、排除原因分桶。
// 「字号保真度」与「文字溢出」两节各报一行。分桶**互斥**且**相加 = 排除总数**（无未归类残差）。
// 前四类为计划钉死的口径：① 含公式源码 ② 含 ASCII 字母数字 ③ 全角字数不足 ④ bbox 异常（比例越界）；
// 另补 ⑤ 其它非覆盖字符（希腊/数学符号等）⑥ 非文本块（图片/空文本）⑦ 竖排块 ⑧ 无当量宽。
// 优先级：**公式源码先于 ASCII 字母数字**（`$F_{1}$` 两者都含，归更具体的「公式源码」）。
// 两节都打印全部桶：某桶为 0 表示**本节不按该原因排除**（即该类块被本节覆盖）——
// 这本身是信息：例如「文字溢出」节「含 ASCII 字母数字 0」正说明它覆盖了保真度节排除的那类块。
const COVERAGE_BUCKETS = [
  "含公式源码",
  "含 ASCII 字母数字",
  "全角字数不足",
  "bbox 异常（比例越界）",
  "其它非覆盖字符",
  "非文本块（图片/空文本）",
  "竖排块（横向非约束）",
  "无当量宽（emWidthOf=0）",
];
const zeroBuckets = () => Object.fromEntries(COVERAGE_BUCKETS.map((b) => [b, 0]));
function reportCoverage(label, covered, buckets) {
  const excluded = COVERAGE_BUCKETS.reduce((a, b) => a + buckets[b], 0);
  const parts = COVERAGE_BUCKETS.map((b) => `${b} ${buckets[b]}`).join(" · ");
  console.log(
    `     覆盖统计（${label}）：覆盖 ${covered} 块 / 排除 ${excluded} 块（分桶合计 ${excluded} = 排除总数 ✓）`,
  );
  console.log(`       排除原因分桶：${parts}`);
}

// ── 5. 字号保真度（判定级）──────────────────────────────────────────────
// 逐块：F_render 由行高反推字号（fontFromLineHeight），F_width 由 bbox 宽 / 全角当量宽
// （emWidthOf）反推「宽度隐含字号」；ratio = F_width / F_render。二者同源则应 ≈ 1。
// 系数写小 → F_render 变小 → ratio 整体抬高，本节即报红。
//
// 取样收窄为「可判块」，排除度量表覆盖不到的字符带来的偏差（emWidthOf 把非 ASCII 窄字符
// 按 1.0em 计，希腊字母/数学符号会让 F_width 偏小、污染中位数）：
//   1. kind 非 image 且有 text
//   2. 每个字符都属度量表覆盖类别：全角/CJK（含全角标点，码位 ≥ U+2E80 且为 BMP）、
//      ASCII 空格、其余可见 ASCII 标点；出现任何其它字符（**ASCII 字母数字 [0-9A-Za-z]**、
//      希腊字母 θ Δ、数学符号 ° × ≈、\ $ { }、控制字符、代理区/非 BMP 等）即排除该块。
//      排除 ASCII 字母数字：emWidthOf 对其用 0.5em 近似权重，纳入会把近似误差注入中位数；
//      纯全角样本下度量精确（CJK 恰 1.0em）。
//   3. 全角字符数 ≥ 6
//   4. bboxW_pt / 全角字符数 ∈ [6, 22]（排除短行与坏 bbox）
const FW_MIN = 0x2e80; // 「全角/CJK（含全角标点）」码位下界；希腊字母(0x3xx)/数学符号(0x22xx)据此排除
const FIDELITY_MIN_FW = 6;
const FIDELITY_PER_FW = [6, 22];
const FIDELITY_MEDIAN = [0.93, 1.07]; // 判定项
const FIDELITY_OUTLIER = [0.85, 1.15]; // 提示项

function isCoveredChar(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0xd800 && c <= 0xdfff) return false; // 代理区（孤立代理）：非覆盖
  if (c > 0xffff) return false; // 非 BMP（代理对，如 emoji）：非覆盖，避免高码位误入全角分支
  if (c >= FW_MIN) return true; // 全角/CJK（含全角标点，BMP 内 U+2E80–U+FFFF）
  if (ch === " ") return true; // ASCII 空格
  if (c >= 0x21 && c <= 0x7e && !/[0-9A-Za-z]/.test(ch) && !"\\${}".includes(ch)) return true; // 其余可见 ASCII 标点
  return false; // ASCII 字母数字 / 控制字符 / \ $ { } / 其它非覆盖字符
}

const fidelityRows = [];
const fidBuckets = zeroBuckets();
for (const p of snap.pages) {
  for (const b of p.blocks ?? []) {
    const text = b.text;
    // 分桶互斥、按序首次命中；排除原因即桶名，故分桶相加 = 排除总数（见 reportCoverage）
    if (b.kind === "image" || typeof text !== "string" || !text.length) {
      fidBuckets["非文本块（图片/空文本）"]++;
      continue;
    }
    if (hasMathSource(text)) {
      fidBuckets["含公式源码"]++;
      continue;
    }
    if (/[0-9A-Za-z]/.test(text)) {
      fidBuckets["含 ASCII 字母数字"]++;
      continue;
    }
    if (![...text].every(isCoveredChar)) {
      fidBuckets["其它非覆盖字符"]++;
      continue;
    }
    let fw = 0;
    for (const ch of text) if (ch.codePointAt(0) >= FW_MIN) fw++;
    if (fw < FIDELITY_MIN_FW) {
      fidBuckets["全角字数不足"]++;
      continue;
    }
    const bboxW = b.bbox[2] - b.bbox[0];
    const bboxH = b.bbox[3] - b.bbox[1];
    if (bboxW / fw < FIDELITY_PER_FW[0] || bboxW / fw > FIDELITY_PER_FW[1]) {
      fidBuckets["bbox 异常（比例越界）"]++;
      continue;
    }
    const fRender = fontFromLineHeight((bboxH / p.width) * 760);
    const fWidth = ((bboxW / p.width) * 760) / emWidthOf(text);
    fidelityRows.push({ p: p.index, i: b.i, ratio: fWidth / fRender, shown: text.slice(0, 80) });
  }
}

let fidelityMedian = null;
if (fidelityRows.length) {
  const sorted = [...fidelityRows].sort((a, b) => a.ratio - b.ratio);
  const n = sorted.length;
  fidelityMedian = n % 2 ? sorted[(n - 1) / 2].ratio : (sorted[n / 2 - 1].ratio + sorted[n / 2].ratio) / 2;
}
const fidelityOutliers = fidelityRows
  .filter((r) => r.ratio < FIDELITY_OUTLIER[0] || r.ratio > FIDELITY_OUTLIER[1])
  .sort((a, b) => b.ratio - a.ratio);
const fidelityFail =
  fidelityRows.length === 0 || fidelityMedian < FIDELITY_MEDIAN[0] || fidelityMedian > FIDELITY_MEDIAN[1];

// 每节带 fatal 标志：false = 提示级，只展示不计入退出码
const sections = [];
for (const [name] of OUT_PATTERNS) {
  sections.push([name, outHits[name], true]);
}
sections.push(["选项粘连未分隔", stuckOptions, true]);
sections.push(["未覆盖的 LaTeX 命令", [...unknownCmds.entries()].map(([c, n]) => ({ shown: `\\${c} ×${n}` })), true]);
sections.push([
  "命令切分歧义（提示·需人工扫一眼）",
  [...ambiguityMap.entries()].map(([k, v]) => ({ shown: `${k}  ×${v.n}`, sample: v.sample })),
  false,
]);

console.log(`渲染审计 · ${docId}`);
console.log(`扫描文本块 ${total} 个\n`);
let bad = 0;
let hints = 0;
for (const [name, list, fatal] of sections) {
  const flag = list.length === 0 ? "✅" : fatal ? "❌" : "⚠️";
  console.log(`${flag} ${name}：${list.length}`);
  if (list.length > 0) fatal ? (bad += list.length) : (hints += list.length);
  for (const x of list.slice(0, 6)) {
    const loc = x.p === undefined ? "" : `p${x.p} ${x.src}[${x.i}] `;
    console.log(`     ${loc}${JSON.stringify(x.shown)}`);
    if (x.sample) console.log(`        …${JSON.stringify(x.sample)}`);
  }
  if (list.length > 6) console.log(`     …另有 ${list.length - 6} 条`);
}

// ── 5. 字号保真度（判定项：可判块 ratio 中位数；提示项：单块 ratio 超界）──
{
  const flag = fidelityFail ? "❌" : "✅";
  console.log(
    `\n${flag} 字号保真度（判定项：可判块 ratio 中位数 ∈ [${FIDELITY_MEDIAN[0]}, ${FIDELITY_MEDIAN[1]}]）`,
  );
  console.log(
    `     可判块 ${fidelityRows.length} 个 · 中位 ratio ${fidelityMedian === null ? "N/A" : fidelityMedian.toFixed(4)}`,
  );
  reportCoverage("字号保真度", fidelityRows.length, fidBuckets);
  if (fidelityRows.length === 0) console.log("     ❌ 可判块为 0：判据被静默架空，判定失败");
  else if (fidelityFail)
    console.log(`     ❌ 中位 ratio ${fidelityMedian.toFixed(4)} 落在 [${FIDELITY_MEDIAN[0]}, ${FIDELITY_MEDIAN[1]}] 之外`);
  console.log(
    `     ⚠️ 单块 ratio 超 [${FIDELITY_OUTLIER[0]}, ${FIDELITY_OUTLIER[1]}]：${fidelityOutliers.length} 个（提示项，不计退出码）`,
  );
  for (const x of fidelityOutliers.slice(0, 10)) {
    console.log(`        p${x.p} blocks[${x.i}] ratio=${x.ratio.toFixed(3)} ${JSON.stringify(x.shown)}`);
  }
  if (fidelityOutliers.length > 10) console.log(`        …另有 ${fidelityOutliers.length - 10} 条`);
  if (fidelityFail) bad++;
}

// ── 6. 文字溢出 / 宽度上限触发（**提示项**，不计退出码）──────────────────────
// R5 的可见性缺口：审计「可判块」口径曾排除含 ASCII 的块，而横向溢出恰发生在这些行
// （§17 判据粒度决定漏检粒度）。本节把「宽度」纳入扫描面。
//
// ⚠️ 但**不能**把「渲染宽 > bboxW」写成判定项（评审裁定：降级为提示项）。原因：
//   渲染层对行级/丢弃块接了 `clampByWidth`，它返回 `min(F, wPx/em)` ⇒ 恒有 `em·F ≤ wPx`；
//   而本节的 ratio 用**同一 `emWidthOf`、同一 text、同一 pageWidth/canvasW** 重算，与
//   `clampByWidth` 内部完全同源 ⇒ `ratio ≡ ≤ 1`，`> 1.05` 在数学上不可达 —— 是一道**恒真的
//   死门**（更甚：审计若自己调用 `clampByWidth` 重算 F，则渲染层绕过夹子也照样测不出）。
//
// 本节改报**真正非恒真的信号**：**宽度上限触发率** —— 高度模型字号被 bbox 宽压小的块占比
//   （`preFont > wPx/em`，只依赖 bbox/em，**不依赖夹子本身**；夹子摘掉或高度模型漂移时它会变化）。
//   分组报数（行级块 / raw 段级块 / discarded 丢弃块），三组都出现，不静默丢组；
//   并附「保守模型下会溢出的块」清单（= 触发集合本身）作为提示信息。
//
// 度量：`emWidthOf`（与「字号保真度」同一套，不另立标准）。preFont = **未接宽度上限**时的字号：
//   · 行级块 / 丢弃块：`fontForBlock(...)`（渲染层随后接 `clampByWidth`），对比模式口径 PANE_W。
//   · 段级块 raw：`fontFromLineHeight(bboxH 换算)`（`fontForRawBlock` 的宽度项即其上限），CANVAS_W。
//   竖排块（R4）横向宽度非约束，不纳入。
//
// ⚠️ **公式源码块（hasMathSource 命中）不纳入**（Task 7 修复 C1 后）：渲染层对公式块豁免
//   `clampByWidth`，且 `emWidthOf(原始 LaTeX)` 本就把当量宽算大 3–5× → 触发信号对这类块无意义
//   （C1 修复前它们 100% 命中「触发」，把触发率整体抬高）。排除并计入「含公式源码」桶 ——
//   这正是审计要报告的**自身覆盖缺口**（G1 同样适用于门自身）。
const AUDIT_PANE_W = 460;   // 对比模式单栏
const AUDIT_CANVAS_W = 760; // 阶段 1 画布

const overflowGroups = [
  { key: "blocks", label: "行级块 blocks   ", n: 0, hit: [] },
  { key: "raw", label: "raw 段级块      ", n: 0, hit: [] },
  { key: "discarded", label: "discarded 丢弃块", n: 0, hit: [] },
];
const ovfBuckets = zeroBuckets();
const gOf = (k) => overflowGroups.find((g) => g.key === k);
for (const p of snap.pages) {
  const basePane = baseFontOfPage(p.blocks, p.width, AUDIT_PANE_W);
  for (const src of ["blocks", "discarded"]) {
    const g = gOf(src);
    for (const b of p[src] ?? []) {
      const text = b.text;
      if (b.kind === "image" || typeof text !== "string" || !text.length) {
        ovfBuckets["非文本块（图片/空文本）"]++;
        continue;
      }
      if (isVerticalText(b.bbox, text)) {
        ovfBuckets["竖排块（横向非约束）"]++;
        continue; // R4 竖排：横向宽度非约束
      }
      if (hasMathSource(text)) {
        ovfBuckets["含公式源码"]++;
        continue; // 公式块已豁免夹子，触发率不适用
      }
      const em = emWidthOf(text);
      if (em <= 0) {
        ovfBuckets["无当量宽（emWidthOf=0）"]++;
        continue;
      }
      const preFont = fontForBlock(b, p.width, AUDIT_PANE_W, basePane); // 未接 clampByWidth
      const wPx = ((b.bbox[2] - b.bbox[0]) / p.width) * AUDIT_PANE_W;
      g.n++;
      if (preFont > wPx / em + 1e-9) g.hit.push({ p: p.index, i: b.i, over: (em * preFont) / wPx, shown: text.slice(0, 56) });
    }
  }
  const g = gOf("raw");
  for (const b of p.raw ?? []) {
    if (!b.text) {
      ovfBuckets["非文本块（图片/空文本）"]++;
      continue;
    }
    if (isVerticalText(b.bbox, b.text)) {
      ovfBuckets["竖排块（横向非约束）"]++;
      continue;
    }
    if (hasMathSource(b.text)) {
      ovfBuckets["含公式源码"]++;
      continue;
    }
    const em = emWidthOf(b.text);
    if (em <= 0) {
      ovfBuckets["无当量宽（emWidthOf=0）"]++;
      continue;
    }
    const preFont = fontFromLineHeight(((b.bbox[3] - b.bbox[1]) / p.width) * AUDIT_CANVAS_W);
    const wPx = ((b.bbox[2] - b.bbox[0]) / p.width) * AUDIT_CANVAS_W;
    g.n++;
    if (preFont > wPx / em + 1e-9) g.hit.push({ p: p.index, i: b.i, over: (em * preFont) / wPx, shown: b.text.slice(0, 56) });
  }
}
const overflowN = overflowGroups.reduce((a, g) => a + g.n, 0);
const overflowHit = overflowGroups.reduce((a, g) => a + g.hit.length, 0);

{
  console.log("\n⚠️ 文字溢出 / 宽度上限触发（提示项，不计退出码）");
  console.log("     本节为提示项：clampByWidth 使 emWidthOf 口径下「渲染宽 > bboxW」在构造上不可能");
  console.log("     发生（em·F ≤ bboxW），对其判定是恒真的死门；改报非恒真的「宽度上限触发率」——");
  console.log("     高度模型字号被 bbox 宽压小的块占比（只依赖 bbox/em，不依赖夹子本身）。");
  for (const g of overflowGroups) {
    const pct = g.n ? (g.hit.length / g.n) * 100 : 0;
    console.log(`     · ${g.label}：可判 ${g.n} 个 · 触发 ${g.hit.length} 个（${pct.toFixed(2)}%）`);
    for (const x of [...g.hit].sort((a, b) => b.over - a.over).slice(0, 4)) {
      console.log(`         p${x.p}[${x.i}] 保守溢出比=${x.over.toFixed(3)} ${JSON.stringify(x.shown)}`);
    }
  }
  console.log(
    `     · 合计          ：可判 ${overflowN} 个 · 触发 ${overflowHit} 个（${overflowN ? ((overflowHit / overflowN) * 100).toFixed(2) : "N/A"}%）`,
  );
  reportCoverage("文字溢出", overflowN, ovfBuckets);
}

if (bad === 0) {
  console.log(hints > 0 ? `\n判定项全部归零 ✅（另有 ${hints} 条提示，不影响退出码）` : "\n全部归零 ✅");
} else {
  console.log(`\n合计 ${bad} 条待处理 ❌`);
}
process.exit(bad === 0 ? 0 : 1);
