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
import { inkLineAround } from "./audit-hole-geometry.js";
import type { GrayImage } from "./export-stages.js";

type Box = [number, number, number, number];

/** 配带基础分（§110 第六轮 DP 变体）：「配上」动作的固定收益，使序列唯一但零重叠的行入局。 */
export const ALIGN_BASE_BONUS = 0.1;

/** 带归属行数上限（§110 第七轮去噪）：超过按 DP score 截断，其余降级 noBand——巨组是垃圾拼接源头。 */
export const MAX_BAND_LINES = 3;

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
}

export interface AlignedPage {
  /** 几何替换后的行（配上的行 norm=墨迹带；其余保留 V3 原框） */
  lines: { text: string; score: number | null; bbox: Box | null; norm: Box | null }[];
  stats: AlignStats;
}

/** 按栏切墨迹行带（真值几何）。栏 x 区间 = 该栏全部行框的 [min x0, max x1]。 */
export function bandsForColumn(
  img: GrayImage,
  pageW: number,
  pageH: number,
  colX0: number,
  colX1: number,
): InkBand[] {
  const raw = splitInkLines(img, pageW, pageH, [colX0, 0, colX1, pageH], { ...DEFAULT_SPLIT, minInkPx: 6, minGapPx: 8 });
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
  opts: { replaceY?: boolean; mineruBlocks?: { bbox: Box; text: string }[]; holes?: Box[] } = {},
): AlignedPage {
  const replaceY = opts.replaceY !== false;
  const mid = pageW / 2;
  const stats: AlignStats = { total: 0, paired: 0, noBand: 0, bandOverload: 0 };
  const out = lines.map((l) => ({ ...l }));
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
    for (const l of out) {
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
    const bands = bandsForColumn(img, pageW, pageH, colX0, colX1);
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
      if (rows.length <= MAX_BAND_LINES) continue;
      rows.sort((a, b) => b.score - a.score);
      for (const r of rows.slice(MAX_BAND_LINES)) {
        mono[r.row]!.bandIdx = -1;
        out[idx[r.row]!.i]!.norm = null;
      }
    }
    const bandHits = new Map<InkBand, number>();
    idx.forEach(({ l, i }, k) => {
      stats.total++;
      const m2 = mono[k]!;
      if (m2.bandIdx < 0) {
        stats.noBand++;
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
