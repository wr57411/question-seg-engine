// @ts-check
/**
 * v3-line-boxes.ts —— 用本地 PP-StructureV3 的**真实行框**替换 OXR 合成行框（纯函数层）
 *
 * 为什么需要（用户 2026-11-24 提出、实证确认）：
 * - 生产源 OXR 只给「整段外接框 + 纯文本」，**没有行框也没有字号**；
 *   `oxr-convert.ts` 只能按「块高÷行数」均分、联立方程反推字号 ⇒ 行框系统性失真
 *   （短行右缘过冲继承段框、含分式的行高被压扁、一行横排被切成竖排）。
 * - 本地 PP-StructureV3（4070）输出 `lines[]`，每行带**真实 bbox**（像素）与 `norm`（归一化），
 *   坐标尺度与引擎快照一致（实测 norm×页宽 与 stages 逐行吻合）。
 *
 * 本模块只负责「**配对**」：给定一段文本的若干候选 V3 行，判断能否用它们替换合成框，
 * 输出替换用的行框。判据取**最严 AND**，配不上就返回 null（调用方回退到现有合成逻辑）。
 */

/** V3 行（来自 ocr-jobs-cache-localv3/*.json 的 lines[]） */
export interface V3Line {
  text: string;
  score?: number;
  /** 像素坐标 [x0,y0,x1,y1]（V3 输出原值） */
  bbox: number[];
  /** 归一化坐标 [x0,y0,x1,y1]（0..1，除以 page_px） */
  norm: number[];
}

/** 一段待替换的合成行组（OXR 块拆出来的行） */
export interface SynthLine {
  text: string;
  bbox: [number, number, number, number];
}

export interface PairOptions {
  /** 页面像素尺寸 [w,h]（V3 的 page_px），用于把 norm 换成 pt */
  pagePx: [number, number];
  /** 页面 pt 尺寸 [w,h]（引擎快照的 width/height） */
  pagePt: [number, number];
  /** 水平中心距上限（pt） */
  centerTolPt?: number;
  /** 水平重叠比下限（0..1）——几何守卫 */
  overlapMin?: number;
  /** 文本覆盖度下限（0..1）——**主判据**，默认 0.8（子代理标定：≥0.8 时误配率 0） */
  coverageMin?: number;
  /**
   * 同页图片框（pt 坐标 `[x0,y0,x1,y1]`）。给了才启用「不得更糟守卫」⑥——
   * 防止 V3 拆段后尾段伸进图区、把「不压字」变成「压字」。不给则不启用该守卫。
   */
  images?: number[][];
}

/**
 * 归一化：剥 LaTeX 命令 + 去 `${}`/空格 + 统一全半角标点。
 * 口径与仓库 `hardNorm`/`r5-align` 同族（子代理标定实证：文本锚定判据误配率为 0）。
 * @param {string} s
 * @returns {string}
 */
export function normText(s: string): string {
  return String(s ?? "")
    .replace(/\\(?:frac|sqrt|text|mathrm|begin\{array\}|end\{array\}|left|right|sin|cos|tan|theta|alpha|beta|gamma|pi|Delta|times|cdot|leq|geq|approx)/g, "")
    .replace(/[${}\\^_]/g, "")
    .replace(/\s+/g, "")
    .replace(/[，。；：（）“”‘’、]/g, (c) => {
      const map = { "，": ",", "。": ".", "；": ";", "：": ":", "（": "(", "）": ")", "“": '"', "”": '"', "‘": "'", "’": "'", "、": "," } as Record<string, string>;
      return map[c] ?? c;
    })
    .replace(/[,.;;:()"'?!/]/g, "")
    .toLowerCase();
}

/** 文本覆盖度：b 的字符在 a 中出现的占比（双序列 LCS 近似，行都很短）
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function textCoverage(a: string, b: string): number {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return 0;
  // 以较短者为分母；逐字符贪心匹配（等价于「b 有多大部分被 a 覆盖」）
  const [long, short] = na.length >= nb.length ? [na, nb] : [nb, na];
  let i = 0;
  let hit = 0;
  for (const ch of short) {
    const found = long.indexOf(ch, i);
    if (found >= 0) { hit++; i = found + 1; }
  }
  return hit / short.length;
}

/**
 * 把 V3 行的 norm 坐标换算成引擎 pt 坐标。
 * @param {V3Line} line
 * @param {PairOptions} opts
 * @returns {[number, number, number, number]}
 */
export function v3BoxToPt(line: V3Line, opts: PairOptions): [number, number, number, number] {
  const [pxW, pxH] = opts.pagePx;
  const [ptW, ptH] = opts.pagePt;
  // 像素 → pt 的比例（两方向各自算，容忍非等比缩放）
  const sx = pxW > 0 ? ptW / pxW : 1;
  const sy = pxH > 0 ? ptH / pxH : 1;
  // 项目惯用写法：解构 + 默认值（与 oxr-convert.ts 取 bbox 一致，避开索引 undefined 推断）
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = Array.isArray(line.bbox) ? line.bbox : [];
  const [nx0 = NaN, ny0 = NaN, nx1 = NaN, ny1 = NaN] = Array.isArray(line.norm) ? line.norm : [];
  // norm 优先（V3 原生的页内归一化坐标）：乘页面 **pt** 尺寸
  if ([nx0, ny0, nx1, ny1].every((v) => Number.isFinite(v))) {
    return [nx0 * ptW, ny0 * ptH, nx1 * ptW, ny1 * ptH];
  }
  // 退回像素换算
  return [bx0 * sx, by0 * sy, bx1 * sx, by1 * sy];
}

/**
 * 一个 OXR **块**（含若干合成行）能否整体换成一组 V3 行的并集框。
 *
 * 为什么按**块**配而不是按行配：OXR 与 V3 的**行切分点不同**（实测同一句被切成不同两段，
 * 逐行文本覆盖只有 0.62），按行比必然大量漏配；按块比（块全文 vs 若干 V3 行拼接）才稳定。
 *
 * @param {string} blockText OXR 块全文（换行连接）
 * @param {[number,number,number,number]} blockBox 块框
 * @param {V3Line[]} cand 该页 V3 行候选
 * @param {PairOptions} opts
 * @returns {{ boxes: [number,number,number,number][], score: number } | null}
 */
export function pairBlockToV3(
  blockText: string,
  blockBox: [number, number, number, number],
  cand: V3Line[],
  opts: PairOptions,
): { boxes: [number, number, number, number][]; score: number } | null {
  if (!blockText?.trim() || !Array.isArray(cand) || cand.length === 0) return null;
  const cov = opts.coverageMin ?? 0.8;
  // ① 候选行先按几何粗筛：与块框有水平交集且垂直相交
  const geo = cand.filter((l) => {
    const b = v3BoxToPt(l, opts);
    const ox = Math.min(blockBox[2], b[2]) - Math.max(blockBox[0], b[0]);
    const oy = Math.min(blockBox[3], b[3]) - Math.max(blockBox[1], b[1]);
    return ox > 0 && oy > 0;
  });
  if (geo.length === 0) return null;
  // ② 文本覆盖：块全文的字符有多少被候选行（拼接后）覆盖
  const joined = geo.map((l) => l.text).join("");
  const c = textCoverage(blockText, joined);
  if (c < cov) return null;
  // ③ 碎框否决：候选里若有一堆极窄极短的碎片（V3 把横排拆碎的表现），不替换
  const frags = geo.filter((l) => {
    const b = v3BoxToPt(l, opts);
    return (b[2] - b[0]) < (blockBox[2] - blockBox[0]) * 0.25 && normText(l.text).length < 4;
  });
  if (frags.length >= 2 && frags.length >= geo.length / 2) return null;
  const boxes = geo
    .map((l) => v3BoxToPt(l, opts))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  // ④ **并集尺寸守卫**（防「一个块吃到几行、并集远超原块」——实测书A p0 封面块旧宽 86pt
  // 被换成 378pt 的并集，反而制造新的压字/串位）：并集相对原块的**水平扩张**不得超过 25%，
  // **垂直不得超过 50%**（V3 行高通常略大于合成框，留余量）。
  const uL = Math.min(...boxes.map((b) => b[0]));
  const uR = Math.max(...boxes.map((b) => b[2]));
  const uT = Math.min(...boxes.map((b) => b[1]));
  const uB = Math.max(...boxes.map((b) => b[3]));
  const oldW = blockBox[2] - blockBox[0];
  const oldH = blockBox[3] - blockBox[1];
  if (oldW > 0 && (uR - uL) > oldW * 1.25) return null;
  if (oldH > 0 && (uB - uT) > oldH * 1.5) return null;

  // ⑤ **覆盖守卫**（2026-11-24 实测补）：并集必须**盖住原块的水平范围**≥60%——
  // 否则就是「一个整行块被换成其中一小片」（实测 p5 i69 整行 [313..557] 被换成 [514..524]，
  // 文字全丢、只剩一个碎片压在图上）。这是「文本覆盖」判据的必要补充。
  const coverX = Math.min(blockBox[2], uR) - Math.max(blockBox[0], uL);
  if (oldW > 0 && coverX < oldW * 0.6) return null;

  // ⑥ **不得更糟守卫**：替换后若任一段比原块**更往右越过本栏图片**（即制造了新的图压字），
  // 则整体放弃（保持 OXR 原框）。实测书A p5/p12/p21 等：V3 把「横跨图左侧的行」拆成多段，
  // 尾段落进图区 ⇒ 从「不压」变「压」。**保守优先：宁可不动，不可变差。**
  const imgs = (opts as PairOptions & { images?: number[][] }).images ?? [];
  if (imgs.length > 0) {
    for (const box of boxes) {
      for (const ib of imgs) {
        const [ix0 = 0, iy0 = 0, ix1 = 0, iy1 = 0] = ib;
        const ox = Math.min(box[2], ix1) - Math.max(box[0], ix0);
        const oy = Math.min(box[3], iy1) - Math.max(box[1], iy0);
        if (ox <= 0 || oy <= 0) continue;
        // 新段是否比原块更深入图内？（右缘越界更多即「更糟」）
        const newOver = box[2] - ix0;
        const oldOver = blockBox[2] - ix0;
        if (newOver > oldOver + Math.max(oldW * 0.05, 4)) return null;
      }
    }
  }

  return { boxes, score: c };
}

/**
 * 一组 V3 行能否作为某合成行组的替身（**逐行精确**场景：已知切分一致时用）。
 *
 * @param {SynthLine[]} synth 引擎合成的行（按 y 升序）
 * @param {V3Line[]} cand 候选 V3 行（同区域，顺序不限）
 * @param {PairOptions} opts
 * @returns {{ boxes: [number, number, number, number][], score: number } | null}
 *   配不上返回 null（调用方回退）。score 越高越好。
 */
export function pairV3Lines(
  synth: SynthLine[],
  cand: V3Line[],
  opts: PairOptions,
): { boxes: [number, number, number, number][]; score: number } | null {
  if (!Array.isArray(synth) || synth.length === 0) return null;
  if (!Array.isArray(cand) || cand.length === 0) return null;

  const centerTol = opts.centerTolPt ?? 24;
  const overlapMin = opts.overlapMin ?? 0.5;
  // 文本覆盖度下限：**主判据**（子代理标定：文本锚定误配率 0，几何单独用误配近 3 成）
  const coverageMin = opts.coverageMin ?? 0.8;

  /** 文本相似度：归一后取较长串的子串包含或编辑距离代理（这里用「共同字符占比」） */
  const sim = (a: string, b: string): number => {
    const na = normText(a);
    const nb = normText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.9;
    // 最长公共子串长度占比（O(n*m) 但行都很短）
    let best = 0;
    for (let i = 0; i < na.length; i++) {
      for (let len = na.length - i; len > best; len--) {
        if (nb.includes(na.slice(i, i + len))) { best = len; break; }
      }
    }
    return best / Math.max(na.length, nb.length);
  };

  const used = new Set<number>();
  const picks: { idx: number; box: [number, number, number, number]; score: number }[] = [];

  for (const s of synth) {
    let bestIdx = -1;
    let bestScore = 0;
    let bestBox: [number, number, number, number] | null = null;
    for (let k = 0; k < cand.length; k++) {
      // 候选可被多个合成块复用吗？**不可**——同一 V3 行不能同时是两个合成行的替身。
      if (used.has(k)) continue;
      const c = cand[k];
      if (!c) continue;
      const box = v3BoxToPt(c, opts);
      // ① 水平重叠比（用交集/较窄者）
      const ox = Math.min(s.bbox[2], box[2]) - Math.max(s.bbox[0], box[0]);
      const minW = Math.min(s.bbox[2] - s.bbox[0], box[2] - box[0]);
      const ov = minW > 0 ? ox / minW : 0;
      if (ov < overlapMin) continue;
      // ② 垂直邻近（行与行不该跨行错配）。容差取**两框较大高度**的 1.5 倍——
      // V3 行框通常比合成框高（实测 22 vs 18px），按合成框高算会漏配（p01/p03 实证）。
      const sCy = (s.bbox[1] + s.bbox[3]) / 2;
      const cCy = (box[1] + box[3]) / 2;
      const hMax = Math.max(s.bbox[3] - s.bbox[1], box[3] - box[1]);
      const tolY = Math.max(hMax * 1.5, 10);
      if (Math.abs(sCy - cCy) > tolY) continue;
      // ③ 水平中心距
      const dx = Math.abs((s.bbox[0] + s.bbox[2]) / 2 - (box[0] + box[2]) / 2);
      if (dx > centerTol) continue;
      const textSim = sim(s.text, c.text);
      const cov = textCoverage(s.text, c.text);
      // **主判据 = 文本覆盖**（≥0.8）；几何（重叠比/中心距）作守卫与排序。
      if (cov < coverageMin) continue;
      // 碎框否决：V3 有时把一行横排拆成 A./B. 小碎框 ⇒ 整块不替换（否则行被拆碎）
      const cW = box[2] - box[0];
      const sW = s.bbox[2] - s.bbox[0];
      if (cW < sW * 0.4 && normText(c.text).length < 6) continue;
      const score = cov * 0.7 + ov * 0.3 - dx / (centerTol * 4);
      if (score > bestScore) { bestScore = score; bestIdx = k; bestBox = box; }
    }
    if (bestIdx < 0 || !bestBox) return null; // 有一行配不上就整体放弃（保真优先）
    used.add(bestIdx);
    picks.push({ idx: bestIdx, box: bestBox, score: bestScore });
  }

  const total = picks.reduce((a, p) => a + p.score, 0);
  return { boxes: picks.map((p) => p.box), score: total / picks.length };
}
