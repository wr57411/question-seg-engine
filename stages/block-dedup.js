/**
 * block-dedup.js —— 同页「同一行被上游读成两个 bbox 重叠的块」的展示层**并集合并**（纯函数，无 DOM）。
 *
 * ── 背景（Task 15 + 修复轮 1）────────────────────────────────────────────────
 * 上游把**同一物理行**读成了两个 bbox 在 y 方向重叠的块 —— 第 9 页第 8 题 D：
 *   blocks[23] = `"D. 绳a的拉力D. 绳a的拉力$F _ { a }$增大.杆的压"` bbox=[49,448,204,462]
 *   blocks[25] = `"增大，杆的压力F大小不变"`                        bbox=[136,449,272,462]
 * 两块 y 区间几乎完全重合（同一行），x 区间相交 68pt ⇒ 渲染后文字互相压叠（叠字）。
 * 原卷（600dpi 裁图核对）该处是**完整一行**：`D. 绳a的拉力F_a增大,杆的压力F大小不变`。
 * 两块是这一行的**两段读数**（较长者缺尾、较短者缺头），**不是**重复块。
 *
 * ⚠️ 修复轮 1 的裁定更正：首轮实现按「保留信息更全（文本更长）者、另一块不渲染」处理，
 * 会**丢掉较短块独有的尾部**（`"力F大小不变"`），渲染行看着就是被截断的。故改为
 * **把两块文本合并成并集**（重叠部分只出现一次）、渲染位置取两块 bbox 的**并集**，界面上不删任何东西。
 *
 * ── 判据（**只此一处定义**）──────────────────────────────────────────────────
 * 计划 Ruling 的字面判据是「一块的文本是另一块的**子串**或**前缀**」。**实测该判据对目标案例
 * 不成立**（`"增大，杆的压力F大小不变"` 既非 `blocks[23]` 的子串也非其前缀；反之亦然），
 * 照字面实现全卷命中 **0 处**、修不了缺陷。故改用下列**结构 + 文本**判据，并**保持最严**
 * （lessons.md L2：搬迁/合并/丢弃类规则的判据宁可漏判不可误判）：
 *   ① 同页（调用方保证：只在本页 `blocks` 内两两比较——**同页守卫**）；
 *   ② 两块都非图片块、文本非空；
 *   ③ **同一行**：y 方向重叠 / 较小块高 ≥ `DUP_Y_OVERLAP_MIN`（0.6）。
 *      取 0.6 的理由：同一行的两块 y 区间几乎重合（目标实测 1.000），而「相邻两行」
 *      的 bbox 天然不相交（行距 > 行高）；0.6 在目标（1.000）与次高对（0.385）之间留了余量。
 *   ④ **横向相交**：x 区间重叠 > 0（排除并排/双栏元素）；
 *   ⑤ **文本有实质公共内容**：去 LaTeX 与空白后的纯文本，最长公共子串 ≥ `DUP_MIN_COMMON`（3）。
 *      取 3 的理由：目标实测公共子串恰为 3（`"杆的压"`），再收紧到 4 会漏掉目标；
 *      而中文 3 字公共子串的随机命中概率可忽略（≈1/3000³），是强信号。
 *
 * 保守性实测（全卷 15 页 / 1061 行级块）：同页非图片块对中 bbox 相交的**只有 4 对**，
 * 其中 y 重叠比 ≥ 0.6（即同一行）的**只有 1 对**（p8[23,25]，即目标）。判据几乎无过拟合空间。
 *
 * ── 合并算法 ────────────────────────────────────────────────────────────────
 * `mergeTexts(a, b)` 求两块文本的并集（重叠只出现一次）：
 *   · 互含（一者含另一者）→ 取长者；
 *   · 否则取「A 的尾部 ⊗ B 的头部」或反向的**最长重叠**：求最大的 k 使 `B.slice(0,k)`
 *     出现在 A 中，取 A 中**最后一次**出现的位置 i 作拼接点 → `A.slice(0,i) + B`
 *     （重叠 k 个字符只保留一份；`i` 取最后一次出现是因为拼接点必在 A 的尾部）；
 *   · **守卫**（防止误并）：`k ≥ MERGE_MIN_OVERLAP`（2，1 字符重叠如都以「的」相接太弱）
 *     且拼接点 `i > 0`（A 必须贡献非空前缀，否则不是「合并」）且并集**严格长于任一单块**
 *     （`|并集| > max(|A|,|B|)`，否则说明匹配落在块中部、会丢 A 的真实尾部）。
 *   · 都不满足 → 返回 `null`，调用方**保留原样不处理**。
 *
 * 顺序（**固定**）：**块内折叠先做（Task 12 的 `collapseImmediateRepeat`）、跨块合并后做**。
 * 理由：合并要在**干净的**文本上找重叠点；块内重复前缀会污染后缀/前缀匹配。
 * 渲染管线里 `prettifyLatex` 会对合并后的文本再跑一次块内折叠（幂等，无副作用）。
 *
 * ── G4 核对 ─────────────────────────────────────────────────────────────────
 * 每一处命中都必须回原卷裁图核对**并集文本与原卷逐字一致**（见 task-15-report.md）。
 * 核不到的（例如两块既不重叠也不互含）**不处理**并如实列出。
 *
 * 供 stages.js 使用；tests/block-dedup.test.ts 回归锁定。
 */
import { collapseImmediateRepeat } from "./latex-display.js";

/** y 方向重叠 / 较小块高 的下限（同一行判定；实测目标 = 1.000，次高对 = 0.385）。 */
export const DUP_Y_OVERLAP_MIN = 0.6;
/** 纯文本最长公共子串长度下限（实质公共内容判定）。 */
export const DUP_MIN_COMMON = 3;
/** 合并时的最小重叠长度（1 字符重叠太弱，如两块都以「的」相接）。 */
export const MERGE_MIN_OVERLAP = 2;

const isImage = (b) => b?.kind === "image";
const textOf = (b) => (typeof b?.text === "string" ? b.text : "");

/**
 * 去 LaTeX 命令名、`$`/`\`/`{}` 与全部空白后的可见纯文本（仅用于公共子串比较）。
 * `_`/`^`（上下标标记）保留 —— 比较用，不追求与渲染文本逐字一致。
 * 例：`"D. 绳a的拉力$F _ { a }$增大"` → `"D.绳a的拉力F_a增大"`。
 */
export function dedupPlainText(text) {
  return String(text).replace(/\\[A-Za-z]+/g, "").replace(/[$\\{}]/g, "").replace(/\s+/g, "");
}

/** 两个字符串的最长公共子串长度（朴素 DP，O(m·n)；输入是单块短文本，规模可忽略）。 */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 判据（只此一处定义）：同页两块是否为「同一行被读成两块」的候选。
 * 仅比较形状与文本，不含任何页/栏上下文 —— 同页守卫由调用方（只在本页 blocks 内两两比较）保证。
 * @param {{kind?:string,text?:string,bbox:number[]}} a
 * @param {{kind?:string,text?:string,bbox:number[]}} b
 * @returns {boolean}
 */
export function isCrossBlockDuplicate(a, b) {
  if (isImage(a) || isImage(b)) return false;
  const ta = textOf(a);
  const tb = textOf(b);
  if (!ta || !tb) return false;
  // ③ 同一行：y 方向显著重叠
  const y0 = Math.max(a.bbox[1], b.bbox[1]);
  const y1 = Math.min(a.bbox[3], b.bbox[3]);
  const hMin = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
  if (hMin <= 0 || (y1 - y0) / hMin < DUP_Y_OVERLAP_MIN) return false;
  // ④ 横向相交
  if (Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]) <= 0) return false;
  // ⑤ 文本有实质公共内容
  return longestCommonSubstring(dedupPlainText(ta), dedupPlainText(tb)) >= DUP_MIN_COMMON;
}

/** 在 a 中找 `b` 的最长前缀的最后一次出现（拼接点）。返回 `{ i, k }` 或 null。 */
function joinAtPrefix(a, b) {
  const max = Math.min(a.length, b.length);
  for (let k = max; k >= MERGE_MIN_OVERLAP; k--) {
    const i = a.lastIndexOf(b.slice(0, k));
    if (i > 0) return { i, k }; // i > 0：a 必须贡献非空前缀
  }
  return null;
}

/**
 * 把两块文本拼成并集（重叠部分只保留一次）。
 * @param {string} a
 * @param {string} b
 * @returns {{text:string, overlap:number, dir:"contains"|"ab"|"ba"} | null} null = 无法合并
 */
export function mergeTexts(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return null;
  // 互含：并集就是长者本身
  if (a.includes(b)) return { text: a, overlap: b.length, dir: "contains" };
  if (b.includes(a)) return { text: b, overlap: a.length, dir: "contains" };
  const ab = joinAtPrefix(a, b); // A 的尾部 ⊗ B 的头部 → a.slice(0,i) + b
  const ba = joinAtPrefix(b, a); // 反向
  const build = (x, y, j) => ({ text: x.slice(0, j.i) + y, overlap: j.k, dir: x === a ? "ab" : "ba" });
  const cands = [];
  if (ab) cands.push(build(a, b, ab));
  if (ba) cands.push(build(b, a, ba));
  // 守卫：并集必须严格长于任一单块（否则匹配落在块中部，会丢真实尾部）
  const ok = cands.filter((c) => c.text.length > Math.max(a.length, b.length));
  if (!ok.length) return null;
  ok.sort((p, q) => q.overlap - p.overlap); // 取重叠更长的一侧
  return ok[0];
}

/** 两块 bbox 的并集 [min x0, min y0, max x1, max y1]。 */
export function unionBbox(ba, bb) {
  return [
    Math.min(ba[0], bb[0]),
    Math.min(ba[1], bb[1]),
    Math.max(ba[2], bb[2]),
    Math.max(ba[3], bb[3]),
  ];
}

/**
 * 本页同页块级重复的**合并计划**（同页守卫：只在本页 `blocks` 内两两比较）。
 * 顺序固定：**先对每块做块内即时重复折叠（Task 12），再跨块合并**。
 * @param {{i:number,kind?:string,text?:string,bbox:number[]}[]} blocks
 * @returns {{
 *   keepI:number, dropI:number,
 *   merged:{text:string,overlap:number,dir:string}|null,
 *   text?:string, bbox?:number[], a:object, b:object
 * }[]} `merged === null` 表示「命中但**无法合并**」→ 调用方保留原样不处理
 */
export function crossBlockMerges(blocks) {
  const list = blocks ?? [];
  const out = [];
  const used = new Set();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (used.has(a.i) || used.has(b.i)) continue;
      if (!isCrossBlockDuplicate(a, b)) continue;
      used.add(a.i);
      used.add(b.i);
      // 块内折叠先做（Task 12）：在干净文本上找重叠点
      const ta = collapseImmediateRepeat(textOf(a));
      const tb = collapseImmediateRepeat(textOf(b));
      const merged = mergeTexts(ta, tb);
      if (!merged) {
        out.push({ keepI: a.i, dropI: b.i, merged: null, a, b });
        continue;
      }
      // 承载块取文本更长者（信息更全）；渲染位置取两块 bbox 并集（更接近原卷该行真实范围）
      const keep = ta.length >= tb.length ? a : b;
      const drop = keep === a ? b : a;
      out.push({ keepI: keep.i, dropI: drop.i, merged, text: merged.text, bbox: unionBbox(a.bbox, b.bbox), a, b });
    }
  }
  return out;
}

/**
 * 由合并计划派生**渲染上下文**（`drop` 集 / `keep` 映射），供 `stages.js` 直接消费。
 *
 * ⚠️ 关键不变式（G1：不静默失败）：**只有真的合并成功（`merged !== null`）才丢弃 `dropI`**。
 * 命中但无法合并（`merged === null`）时**两块都必须原样渲染** —— 若无条件 `drop.add(dropI)`，
 * 该块**没有对应的 keep 条目**，会被静默丢弃（丢内容）。修复轮 2 的 Critical 即此。
 * 把「丢弃」与「保留」**绑定在同一分支**，使这条不变式只有一处实现、可被测试锁定。
 * @param {{i:number,kind?:string,text?:string,bbox:number[]}[]|undefined} blocks
 * @returns {{drop:Set<number>, keep:Map<number,{text:string,bbox:number[]}>}}
 */
export function mergePlan(blocks) {
  const drop = new Set();
  const keep = new Map();
  for (const m of crossBlockMerges(blocks)) {
    if (!m.merged) continue; // 命中但无法合并 → 两块都原样渲染，不丢弃、不保留
    drop.add(m.dropI);
    keep.set(m.keepI, { text: m.text, bbox: m.bbox });
  }
  return { drop, keep };
}
