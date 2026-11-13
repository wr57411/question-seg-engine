// scripts/ink-band-align.ts
/**
 * V3 行框 → 墨迹行带 配对（几何换源，方案 `docs/plans/2026-11-07-line-ink-align.md`）。
 *
 * 背景（基线实测）：V3 行框偏移 −16～+13pt 逐行乱跳且 x 同样偏，几何不可校准 ⇒
 * 配对成功后**几何整体替换为墨迹带**（真值，0 偏移），V3 只贡献文本。
 *
 * 打分（救「半行距偏移」）：y 重叠/框高为主分；并列时先比带中心距，再比
 * 「文本估计宽 ↔ 带墨迹宽」的比值偏离 1 的程度（宽度比先验，与 judgeHole 同口径思路）。
 * 无带可配返回 null —— **不猜**（调用方标 needs_review）。
 *
 * 容量守卫在聚合层：一条带被 >2 条行框认领 ⇒ 记冲突（V3 把一行拆两框是合法形态，
 * >2 是异常信号），不做硬拦。
 */
import { splitInkLines, DEFAULT_SPLIT } from "./ink-lines.js";
import { maskFrameBars } from "./band-mask.js";
import { inkLineAround } from "./audit-hole-geometry.js";
import type { GrayImage } from "./export-stages.js";

type Box = [number, number, number, number];

/** 配带基础分（§110 第六轮 DP 变体）：「配上」动作的固定收益，使序列唯一但零重叠的行入局。 */
export const ALIGN_BASE_BONUS = 0.1;

/** 带归属行数容量（§110 第七轮去噪）：超过按 DP score 截断，其余降级 noBand——巨组是垃圾拼接源头。 */
export const MAX_BAND_LINES = 3;

/** 组内全重叠豁免的带高守卫系数（实验分支 opts.bandExemptFullyOverlapping）：
 *  带高 ≤1.6×页面行高中位才算「同视觉行/碎片行」合法形态——与单行块锚（§110）同系数口径。 */
export const BAND_EXEMPT_H_FACTOR = 1.6;

export interface InkBand {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  inkPx: number;
  /** 洞带（uncovered content 洞作为 DP 候选）：配中 ⇒ 行几何=洞带，洞匹配必命中 */
  isHole?: boolean;
}

export interface BandPairResult {
  band: InkBand;
  /** 主带在 bands 数组中的下标（聚合层做单调性修正用） */
  bandIndex: number;
  score: number;
  /** 并列打破前的候选带数（>1 说明有歧义，调用方可记录） */
  ties: number;
}

/**
 * 单带打分（DP 转移用）：y 重叠占框高比例为主分，中心距相对量做惩罚。≤0 = 无重叠。
 * 纯函数，可单测。
 */
export function bandScore(box: Box, band: InkBand): number {
  const boxH = box[3] - box[1];
  if (boxH <= 0) return 0;
  const ov = Math.min(box[3], band.y1) - Math.max(box[1], band.y0);
  if (ov <= 0) return 0;
  const main = ov / boxH;
  const boxCY = (box[1] + box[3]) / 2;
  const bandCY = (band.y0 + band.y1) / 2;
  const centerPenalty = Math.abs(boxCY - bandCY) / (boxH + band.y1 - band.y0);
  return main - 0.3 * centerPenalty;
}

/**
 * 单条行框 → 最优墨迹带（y 重叠主分 + 中心距 tie-break），并**合并同视觉行碎片带的 x**：
 * 与主带 y 重叠 >40% 主带高的邻带并入 x（并集）——治两类实测失败：
 * ① 同 y 并排内容连成宽带（标题+装饰横线）；② 行内大空隙把一行切成多条碎片带。
 * ⚠️ y 只用主带（对齐真值），并 y 会把跨行/公式块的带拖偏中心（实测 p91 h3 dy 24.7）。
 * 无带可配返回 null —— **不猜**。纯函数，可单测。box/bands 同为 pt 域。
 */
export function pairLineToBand(box: Box, bands: InkBand[]): BandPairResult | null {
  const boxH = box[3] - box[1];
  if (!(boxH > 0) || !bands.length) return null;
  let best = -1;
  let bestScore = -Infinity;
  let ties = 0;
  bands.forEach((b, bi) => {
    const s = bandScore(box, b);
    if (s <= 0) return;
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = bi;
      ties = 1;
    } else if (Math.abs(s - bestScore) <= 1e-9) {
      ties++;
    }
  });
  if (best < 0) return null;
  const main = bands[best]!;
  const merged = mergeSameRowX(bands, main);
  return { band: merged, bandIndex: best, score: bestScore, ties };
}

/** 同视觉行碎片带的 x 并集（y 与主带重叠 >40% 主带高的带）。y 保持主带不变。 */
export function mergeSameRowX(bands: InkBand[], main: InkBand): InkBand {
  const merged: InkBand = { ...main };
  for (const b of bands) {
    if (b === main) continue;
    const ovH = Math.min(main.y1, b.y1) - Math.max(main.y0, b.y0);
    if (ovH > 0.4 * (main.y1 - main.y0)) {
      merged.x0 = Math.min(merged.x0, b.x0);
      merged.x1 = Math.max(merged.x1, b.x1);
      merged.inkPx += b.inkPx;
    }
  }
  return merged;
}

/**
 * **DP 单调对齐**：行（y0 序）↔ 带（y0 序）单调匹配，最大化总得分——
 * 全局上下文打破「正中跨两带」的局部 50/50 歧义（贪心在此 50/50 选错，实测污染洞匹配）。
 * 允许：行跳过（无带可配）、多行同带（V3 拆框合法形态）。前缀最大值优化 O(n·m)。
 * 纯函数，可单测。
 */
export function alignMono(
  boxes: Box[],
  bands: InkBand[],
  bonus?: (rowIdx: number, bandIdx: number) => number,
): { bandIdx: number; score: number }[] {
  const n = boxes.length;
  const m = bands.length;
  const result: { bandIdx: number; score: number }[] = boxes.map(() => ({ bandIdx: -1, score: 0 }));
  if (!n || !m) return result;
  const NEG = -1e9;
  // dp[j]：处理到当前行、最后使用带 ≤ j 的最大总得分；take/from 回溯用
  const dpPrev = new Array<number>(m).fill(0); // dp[0][j] = 0（无行）
  const take: number[][] = [];
  const fromJ: number[][] = [];
  for (let i = 1; i <= n; i++) {
    const dpCur = new Array<number>(m).fill(NEG);
    const takeCur = new Array<number>(m).fill(-1);
    const fromCur = new Array<number>(m).fill(-1);
    let bestPrev = NEG;
    let bestPrevJ = -1;
    const sRow = boxes[i - 1]!;
    for (let j = 0; j < m; j++) {
      // 转移 1：行 i 跳过
      if (dpPrev[j]! > dpCur[j]!) {
        dpCur[j] = dpPrev[j]!;
        takeCur[j] = -1;
        fromCur[j] = j;
      }
      // 转移 2：行 i 配带 j（来源 = 前 i-1 行最后带 ≤ j 的最优，含 j —— 多行同带）
      // ⚠️ 允许 bandScore=0（零重叠）的配对进入：p150 h0 实测「正确带与框零重叠」，
      // 序列位置（DP 单调上下文）是这类行唯一的配对证据；总分权衡下只在「配了更优」时选中
      // 配带基础分（§110 第六轮 DP 变体）：「配上」本身优于「跳过」——零重叠/序列唯一的行
      // （洞带候选的正主）靠它入局；全局总分权衡下乱配仍会被更高分带压制
      const s = Math.max(bandScore(sRow, bands[j]!), 0) + (bonus?.(i - 1, j) ?? 0) + ALIGN_BASE_BONUS;
      const srcJ = bestPrevJ >= 0 && bestPrev > dpPrev[j]! ? bestPrevJ : j;
      const base = Math.max(bestPrev, dpPrev[j]!);
      if (base > NEG) {
        const cand = base + s;
        if (cand > dpCur[j]!) {
          dpCur[j] = cand;
          takeCur[j] = j;
          fromCur[j] = srcJ;
        }
      }
      // 更新前缀最大（含 j，为下一列准备）
      if (dpPrev[j]! > bestPrev) {
        bestPrev = dpPrev[j]!;
        bestPrevJ = j;
      }
    }
    take.push(takeCur);
    fromJ.push(fromCur);
    dpPrev.splice(0, m, ...dpCur);
  }
  // 回溯：从最后一行最优状态起
  let j = 0;
  for (let k = 1; k < m; k++) if (dpPrev[k]! > dpPrev[j]!) j = k;
  for (let i = n; i >= 1; i--) {
    const takeCur = take[i - 1]!;
    const fromCur = fromJ[i - 1]!;
    if (takeCur[j] === j) {
      const s = bandScore(boxes[i - 1]!, bands[j]!);
      result[i - 1] = { bandIdx: j, score: s };
      j = fromCur[j]!;
    } else {
      result[i - 1] = { bandIdx: -1, score: 0 };
    }
  }
  return result;
}

/** ── 聚合层：整页行框 → 墨迹带 几何换源 ────────────────────────────────── */

export interface AlignStats {
  total: number;
  paired: number;
  /** 无带可配（框在无墨区/偏移过大）——保留 V3 原框，不猜 */
  noBand: number;
  /** 一条墨迹带被 >2 条行框认领的异常带数 */
  bandOverload: number;
  /** 实验分支（opts.diagNoBand=true 才产出）：noBand 按降级原因细分，生产默认路径不产出此字段 */
  noBandByCause?: {
    /** MAX_BAND_LINES 组容量截断降级（§110 第七轮去噪） */
    maxTrunc: number;
    /** 截断行里与带真重叠（bandScore>0）——同视觉行多 cell 的合法形态被容量误伤 */
    maxTruncOverlap?: number;
    /** 截断行里与带零重叠（bandScore=0）——§110 担心的「垃圾拼接源头」 */
    maxTruncZero?: number;
    /** 洞带组成员资格过滤降级（§110 第十轮） */
    holeFilter: number;
    /** DP 未配上：真无墨区 / 偏移过大 / 序列权衡牺牲 */
    dpSkip: number;
  };
  /** 实验分支（diagNoBand + bandExemptFullyOverlapping 双开才产出）：被豁免免截断的组数/行数——
   *  豁免 = over-capacity 组整组保留，这些行进 paired，不进 noBandByCause。 */
  exemptGroups?: number;
  exemptRows?: number;
  /** 实验分支（truncationCropFallback 旗标开启才产出）：巨带容量截断行回退保留 V3 紧框的行数——
   *  这些行有坐标（coordSource=crop，裁图例外），不计入 noBand。默认路径不产出此字段。 */
  cropFallback?: number;
}

/** 对齐后的行。coordSource 仅 truncationCropFallback 旗标开启时产出（默认路径无此字段，逐字节不变）。 */
export interface AlignedLine {
  text: string;
  score: number | null;
  bbox: Box | null;
  norm: Box | null;
  /** 坐标来源：crop=巨带截断行回退用 V3 紧框（下游裁图例外）；缺省=墨迹带真值（配对行）/V3 原框（noBand）。 */
  coordSource?: "ink" | "crop";
}

export interface AlignedPage {
  /** 几何替换后的行（配上的行 norm=墨迹带；其余保留 V3 原框） */
  lines: AlignedLine[];
  stats: AlignStats;
}

/** 按栏切墨迹行带（真值几何）。栏 x 区间 = 该栏全部行框的 [min x0, max x1]。 */
export function bandsForColumn(
  img: GrayImage,
  pageW: number,
  pageH: number,
  colX0: number,
  colX1: number,
  opts: { bandMaskFrameBars?: boolean } = {},
): InkBand[] {
  // ── 遮框（实验分支 opts.bandMaskFrameBars）：边缘竖条列置白后再投影切带（旗标关=原 img 直传）
  const eff = opts.bandMaskFrameBars === true ? maskFrameBars(img, pageW) : img;
  const raw = splitInkLines(eff, pageW, pageH, [colX0, 0, colX1, pageH], { ...DEFAULT_SPLIT, minInkPx: 6, minGapPx: 8 });
  const sy = img.height / pageH;
  return raw
    .filter((r) => (r.py1 - r.py0 + 1) / sy >= 3) // 碎带（<3pt 高）不参与配对
    .map((r) => ({ y0: r.py0 / sy, y1: (r.py1 + 1) / sy, x0: r.px0 / (img.width / pageW), x1: (r.px1 + 1) / (img.width / pageW), inkPx: r.inkPx }));
}

/**
 * 整页对齐：按栏切带 → 逐行 `pairLineToBand` → 配上的行 **norm 替换为墨迹带几何**
 * （y=带 y 范围、x=带内墨迹 x 范围），失败的行保留 V3 原框（调用方按 stats 处置）。
 * 纯函数（img 由调用方渲染），可单测。
 */
export function alignLinesToBands(
  lines: { text: string; score: number | null; bbox: Box | null; norm: Box | null }[],
  img: GrayImage,
  pageW: number,
  pageH: number,
  opts: {
    replaceY?: boolean;
    mineruBlocks?: { bbox: Box; text: string }[];
    holes?: Box[];
    /** 实验分支（audit-band-pair --diag）：noBand 降级原因记账旗标——只加记账，不改任何判定 */
    diagNoBand?: boolean;
    /** 实验分支（audit-band-pair --max-band-lines）：MAX_BAND_LINES 实验旋钮，默认 = 生产默认 3 */
    maxBandLines?: number;
    /** 实验分支（audit-band-pair --band-exempt）：组内全重叠豁免——over-capacity 组先判组：
     *  组内每个成员与该带真重叠（bandScore>0）且带高 ≤1.6×页面行高中位 → 整组免截断；
     *  任一成员零重叠或带过高（多行连墨巨带）→ 维持 top-3 截断（零重叠「不猜」底线不动）。
     *  默认关闭 = 生产路径逐字节不变。 */
    bandExemptFullyOverlapping?: boolean;
    /** 实验分支（audit-band-pair --band-mask）：切带投影前遮蔽页边缘竖条列（x<15pt ∪ x>页宽−15pt
     *  且列墨>50% 窗高，scripts/band-mask.ts）。默认关闭=原 img 直传。 */
    bandMaskFrameBars?: boolean;
    /** 实验分支（B-39 巨带裁图坐标补充）：容量截断行不再置 norm=null，而是保留该行 V3 紧框
     *  作为回退坐标并标 coordSource=crop（下游裁图例外，goal item 2）。巨带吞行的 V3 框本就是
     *  紧单行框（audit-giant-crop 实测 p76/p127），故回退坐标=V3 框本身，无需重新切带。
     *  只作用于 MAX_BAND_LINES 容量截断（maxTrunc），不动 holeFilter/dpSkip。默认关闭=生产路径逐字节不变。 */
    truncationCropFallback?: boolean;
  } = {},
): AlignedPage {
  const replaceY = opts.replaceY !== false;
  const mid = pageW / 2;
  // ── 实验分支记账：只加 diag 常量与旋钮回退，生产默认路径所有判定/输出逐字节不变
  const diag = opts.diagNoBand === true;
  const maxBandLines = opts.maxBandLines ?? MAX_BAND_LINES;
  const exemptOn = opts.bandExemptFullyOverlapping === true;
  const cropFallbackOn = opts.truncationCropFallback === true;
  // 页面行高中位数（豁免带高守卫用）：口径与单行块锚（§110）一致——有效行（norm 非空且
  // 文本非空白）框高 ×pageH，排序取中位。旗标关时不计算（生产路径零额外工作）；
  // medH=0（页面无有效行）时守卫 `bandH ≤ 1.6×medH` 永不通过 → 豁免不触发（保守）。
  let medHPage = 0;
  if (exemptOn) {
    const hs = lines
      .filter((l) => l.norm && (l.text ?? "").trim())
      .map((l) => l.norm![3] * pageH - l.norm![1] * pageH)
      .sort((a, b) => a - b);
    medHPage = hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
  }
  const stats: AlignStats = { total: 0, paired: 0, noBand: 0, bandOverload: 0 };
  if (diag) stats.noBandByCause = { maxTrunc: 0, holeFilter: 0, dpSkip: 0 };
  if (diag && exemptOn) { stats.exemptGroups = 0; stats.exemptRows = 0; }
  /** noBand 降级原因记账（全局行下标 → 降级机制）；diag 旗标下才填充 */
  const noBandCause = diag ? new Map<number, "maxTruncOv" | "maxTruncZ" | "holeFilter">() : null;
  const out: AlignedLine[] = lines.map((l) => ({ ...l }));
  /** 被单行块锚定的行（out 下标）——洞带组成员资格过滤用（§110 第十轮） */
  const anchoredRows = new Set<number>();
  /** 巨带截断回退行（out 下标）——truncationCropFallback 旗标开启才填充，统计与 coordSource 标记用 */
  const cropFallbackRows = new Set<number>();
  // ── 单行块锚（§110 第六轮 DP 变体）：V3 框集体偏移的行，用「文本包含匹配到的单行 MinerU 块」
  //    的 bbox 替代行框——解「拆行错占带 → 单调锁死」（p91 h1 实测根因链）。
  //    条件取严（AND）：行 hardNorm ≥4 字（短文本防误匹配）+ 块 hardNorm 包含行 hardNorm +
  //    块高 ≤1.6×页面行高中位（单行块）+ 框与块 y 距离 >8pt（框没跑偏的不动）。
  if (opts.mineruBlocks?.length) {
    const hs = lines
      .filter((l) => l.norm && (l.text ?? "").trim())
      .map((l) => l.norm![3] * pageH - l.norm![1] * pageH)
      .sort((a, b) => a - b);
    const medH = hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
    const hard = (s: string): string => s.replace(/[\s$\\{}]/g, "");
    const singleLineBlocks = opts.mineruBlocks.filter((b) => {
      const bh = b.bbox[3] - b.bbox[1];
      return bh > 0 && medH > 0 && bh <= 1.6 * medH && hard(b.text ?? "").length >= 4;
    });
    for (const [li, l] of out.entries()) {
      if (!l.norm) continue;
      const lt = hard(l.text ?? "");
      if (lt.length < 4) continue;
      const ly0 = l.norm[1] * pageH;
      const ly1 = l.norm[3] * pageH;
      let best: { bbox: Box; dist: number } | null = null;
      for (const b of singleLineBlocks) {
        if (!hard(b.text ?? "").includes(lt)) continue;
        const dist = Math.max(0, b.bbox[1] - ly1, ly0 - b.bbox[3]);
        if (dist <= 8) continue; // 框没跑偏，不动
        if (!best || dist < best.dist) best = { bbox: b.bbox, dist };
      }
      if (best) {
        anchoredRows.add(li);
        l.norm = [
          best.bbox[0] / pageW,
          best.bbox[1] / pageH,
          best.bbox[2] / pageW,
          best.bbox[3] / pageH,
        ];
      }
    }
  }
  for (const col of [0, 1]) {
    const idx = out
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.norm && (l.text ?? "").trim() && (l.norm[0] * pageW < mid) === (col === 0));
    if (!idx.length) continue;
    // 栏界 = 页中线（与洞匹配的「列一致」判据同源）——
    // ⚠️ 不用行框 min/max x 聚类：跨栏离群框（p150 实测）会把栏区间撑到全页宽，
    // 左右栏墨迹在同 y 交错 ⇒ 投影无白缝 ⇒ 切出 109pt 巨带，整片行配带全错
    const colX0 = col === 0 ? 0 : mid;
    const colX1 = col === 0 ? mid : pageW;
    const bands = bandsForColumn(img, pageW, pageH, colX0, colX1, opts.bandMaskFrameBars ? { bandMaskFrameBars: true } : {});
    // ── 洞带候选（§110 第六轮 DP 变体）：uncovered content 洞是「应有行」的真值信号——
    //    框集体偏移的行与正确带零重叠，但洞带在 DP 序列上位置唯一（p91 h1 实测根因链）。
    if (opts.holes?.length) {
      for (const h of opts.holes) {
        if ((h[0] < mid) !== (col === 0)) continue;
        bands.push({ y0: h[1], y1: h[3], x0: h[0], x1: h[2], inkPx: 0, isHole: true });
      }
      bands.sort((a, b) => a.y0 - b.y0);
    }
    // ⚠️ 行序必须按 y0 排（DP 单调对齐的输入序），不是 V3 缓存序
    idx.sort((a, b) => a.l.norm![1] - b.l.norm![1]);
    const boxes: Box[] = idx.map(({ l }) => [
      l.norm![0] * pageW,
      l.norm![1] * pageH,
      l.norm![2] * pageW,
      l.norm![3] * pageH,
    ]);
    // 局部吸附锚带（扩带口径的精华，实测 11/14 的来源）：行框锚点 inkLineAround 吸附到的
    // 墨迹带，与其同视觉行（y 重叠 >40%）的候选带在 DP 打分里 +0.5 —— 两口径融合。
    // ⚠️ 锚带高 >22pt（跨行拖偏带，p91 标签行实测 36pt）不可信——吸附本身被密集区粘连拖偏时
    // bonus 会把 DP 一起带偏——此时不给 bonus，让重叠主分与单调上下文自己决定。
    const anchorIdx = boxes.map((box) => {
      const ab = inkLineAround(img, pageW, pageH, box);
      if (!ab) return -1;
      const abH = ab.bbox[3] - ab.bbox[1];
      if (abH > 22) return -1; // 拖偏带不可信
      let best = -1;
      let bestOv = 0;
      bands.forEach((b, bi) => {
        const ov = Math.min(ab.bbox[3], b.y1) - Math.max(ab.bbox[1], b.y0);
        if (ov > bestOv) {
          bestOv = ov;
          best = bi;
        }
      });
      return best;
    });
    const sameGroup = (j: number, k: number): boolean => {
      if (k < 0 || j === k) return k >= 0;
      const a = bands[j]!;
      const c = bands[k]!;
      const ovH = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
      return ovH > 0.4 * (c.y1 - c.y0);
    };
    const mono = alignMono(
      boxes,
      bands,
      (ri, j) =>
        (sameGroup(j, anchorIdx[ri]!) ? 0.5 : 0) +
        // 洞带 bonus 只给有几何重叠的行（§110 第七轮去噪）：零重叠行配洞带没有证据，
        // 只拿基础分——否则洞带吸引巨组（p159 h0 一洞 12 条实测）
        (bands[j]!.isHole && bandScore(boxes[ri]!, bands[j]!) > 0 ? 0.5 : 0),
    );
    // ── 组级行数上限（§110 第七轮去噪）：一条带的归属行 >MAX 时按 DP score 截断，
    //    其余降级 noBand（norm=null，不进洞匹配）——巨组的零重叠基础分行是垃圾拼接的源头
    const bandRows = new Map<number, { row: number; score: number }[]>();
    mono.forEach((m, i) => {
      if (m.bandIdx < 0) return;
      const arr = bandRows.get(m.bandIdx) ?? [];
      arr.push({ row: i, score: m.score });
      bandRows.set(m.bandIdx, arr);
    });
    for (const [bi, rows] of bandRows) {
      if (rows.length <= maxBandLines) continue;
      // ── 组内全重叠豁免（实验分支 opts.bandExemptFullyOverlapping）：截断循环先判组——
      //    组内每个成员与该带真重叠（bandScore>0）且带高 ≤1.6×页面行高中位（BAND_EXEMPT_H_FACTOR，
      //    同视觉行/碎片行的合法形态）→ 整组免截断；任一成员零重叠（bandScore≤0）或带过高
      //    （多行连墨巨带：网格页全页带/公式块巨带）→ 维持 top-3 截断——保住零重叠行的
      //    「不猜」底线（diag-mbl3q 实测全册仅 12 条零重叠截断行）。
      if (exemptOn) {
        const band = bands[bi]!;
        const bandH = band.y1 - band.y0;
        const allOv = rows.every((r) => bandScore(boxes[r.row]!, band) > 0);
        if (allOv && bandH <= BAND_EXEMPT_H_FACTOR * medHPage) {
          if (stats.exemptRows !== undefined) {
            stats.exemptGroups = (stats.exemptGroups ?? 0) + 1;
            stats.exemptRows = stats.exemptRows + rows.length;
          }
          continue;
        }
      }
      rows.sort((a, b) => b.score - a.score);
      for (const r of rows.slice(maxBandLines)) {
        mono[r.row]!.bandIdx = -1;
        const oi = idx[r.row]!.i;
        if (cropFallbackOn) {
          // 巨带吞行回退：保留该行 V3 紧框（out[oi].norm 此刻仍是 V3/锚定框，配对替换在后面的
          // bandHits 循环才发生；bandIdx=-1 使其不会被替换），标 coordSource=crop 供下游裁图例外。
          out[oi]!.coordSource = "crop";
          cropFallbackRows.add(oi);
        } else {
          out[oi]!.norm = null;
        }
        if (noBandCause) noBandCause.set(oi, bandScore(boxes[r.row]!, bands[bi]!) > 0 ? "maxTruncOv" : "maxTruncZ");
      }
    }
    // ── 洞带组成员资格过滤（§110 第十轮 · B-27 最小可交付）：洞带组内存在「几何重叠

    //    （bandScore>0）或块锚定」的行（A 类）时，纯基础分行（B 类）出局——
    //    巨组的零重叠行是垃圾拼接源头（p159 h0 一洞 12 条实测）；全 B 类组全留
    //    （p91 h1 形态：零重叠行是序列唯一正主，不能误伤）。
    for (const [bi, rows] of bandRows) {
      if (!bands[bi]?.isHole) continue;
      const live = rows.filter((r) => mono[r.row]!.bandIdx >= 0);
      if (live.length < 2) continue;
      const isA = (r: { row: number }): boolean =>
        bandScore(boxes[r.row]!, bands[bi]!) > 0 || anchoredRows.has(idx[r.row]!.i);
      if (!live.some(isA)) continue;
      for (const r of live) {
        if (isA(r)) continue;
        mono[r.row]!.bandIdx = -1;
        out[idx[r.row]!.i]!.norm = null;
        if (noBandCause) noBandCause.set(idx[r.row]!.i, "holeFilter");
      }
    }
    const bandHits = new Map<InkBand, number>();
    idx.forEach(({ l, i }, k) => {
      stats.total++;
      const m2 = mono[k]!;
      if (m2.bandIdx < 0) {
        if (cropFallbackOn && cropFallbackRows.has(i)) {
          // 回退行有坐标（V3 紧框，coordSource=crop），不算 noBand；单独记账。
          stats.cropFallback = (stats.cropFallback ?? 0) + 1;
          return;
        }
        stats.noBand++;
        if (stats.noBandByCause) {
          const cause = noBandCause?.get(i) ?? "dpSkip";
          if (cause === "maxTruncOv") { stats.noBandByCause.maxTrunc++; stats.noBandByCause.maxTruncOverlap = (stats.noBandByCause.maxTruncOverlap ?? 0) + 1; }
          else if (cause === "maxTruncZ") { stats.noBandByCause.maxTrunc = stats.noBandByCause.maxTrunc + 1; stats.noBandByCause.maxTruncZero = (stats.noBandByCause.maxTruncZero ?? 0) + 1; }
          else { stats.noBandByCause[cause]++; }
        }
        return;
      }
      stats.paired++;
      const band = bands[m2.bandIdx]!;
      bandHits.set(band, (bandHits.get(band) ?? 0) + 1);
      const merged = mergeSameRowX(bands, band);
      out[i]!.norm = replaceY
        ? [merged.x0 / pageW, band.y0 / pageH, merged.x1 / pageW, band.y1 / pageH]
        : // 只换 x：y 保留 V3 原框（吸附中心口径的行侧 y 不动，x 用墨迹真值救横向交集）
          [merged.x0 / pageW, l.norm![1], merged.x1 / pageW, l.norm![3]];
    });
    for (const n of bandHits.values()) if (n > 2) stats.bandOverload++;
  }
  return { lines: out, stats };
}
