// scripts/lib/block-indexes-rebuild.ts
/**
 * B-66 —— questions.json `source.blockIndexes` 的**导出期重建**（题干文本反查真实块范围）。
 *
 * 背景（`tmp/astage-rerun/report.md` §结构性发现 + 2026-11-22 修复轮实测归因）：
 * B-66 原假设是「切题游标区间边界滞后 ⇒ 系统性混入上一题」（head 检验 书A 15.8% /
 * 书B 26.1% miss，且低估）。修复轮实测把归因**修正**为**帧漂移**：
 * - 引擎在「OCR 题号注入后的 doc 帧」上记录 blockIndexes，且**在该帧内完全自洽**
 *   （书A 引擎帧 head 检验 miss=0/1048）；
 * - 但导出链的 table-v3 三分流会向快照**插入新块**（书A +20、书B +12），此后
 *   stages.json 的全局拍平帧相对引擎帧整体后移 ⇒ 一切「按 stages.json 拍平序把
 *   blockIndexes 取回块」的下游（A 档抽查裁图、逻辑块裁图器、head 检验）都系统性
 *   取到后移的块 = 表现为「混入上一题」（书A p176:q744：引擎帧 11541 与 stages 帧
 *   11553 是**同一个**题头块；书A p123:q534 同理）。
 *
 * 修法：**不改引擎切题**，在导出链的全部块变更落定之后，用 stem 首段文本在**最终快照帧**
 * （pages[].order 阅读序拍平，含插入块）里反查真实起始块，本题区间 = 真实起始块 →
 * 下一题真实起始块前——把 questions.json 的 blockIndexes 重铸进与 stages.json 同帧的口径。
 * stem 与块文本**同源**（`stem = stripQuestionPrefix(block.text)` + 后续块原文拼接，
 * 见 `src/rule-engine.ts`），所以探针用 norm 字符（汉字+字母+数字，剥空白/标点/LaTeX
 * 包裹符）做**前缀匹配**即可高特异地定位，不需要 numbering-cross 那种跨源容错的滑窗覆盖率。
 *
 * 纪律（B-66 修复要求）：
 * - **宁保原值不猜**：反查不中 ⇒ 保留原值 + 计数（绝不猜一个错区间）。注意保留的
 *   「原值」是引擎帧口径（重建失败即无从换算，宁缺毋错）；
 * - **页邻近约束**：当前页 ±1 页内找，找不到再放宽（±2 → ±4）并单独计数；
 * - **只修 source 元数据**：stem/options/题数一字不动；本模块是纯函数，不改入参。
 */

/** norm：只留汉字/字母/数字（与 `numbering-cross.norm` 同口径；stem 与块同源，剥样式差异即可）。 */
export function normText(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

/** 探针长度（norm 字符）。12 ≈ 两个选项标签的特异度；实测两书 located 1048+1092/2143。 */
export const PROBE_LEN = 12;
/** 探针最短可用长度：低于此无法可靠定位（纯公式/纯字母的答案速查条目）⇒ 保留原值。 */
export const PROBE_MIN = 6;
/** 前缀匹配最小长度（norm 字符）：stem 开头 ≥8 个 norm 字符须原样出现在候选块连跑里。 */
export const PREFIX_NEED = 8;
/** 连跑块数：候选起始块与其后 K 块拼接后做前缀匹配（stem 首段常跨块，实测书B 大量此类）。 */
export const RUN_K = 2;
/** 页邻近半径递增序列：±1 → ±2 → ±4；radius > 1 命中的单独计数（放宽是最后手段）。 */
export const PAGE_RADII = [1, 2, 4];

/** 阅读顺序拍平的块（与引擎 blockIndexes 同一口径：页升序 × 页内阅读序；见 `buildStageSnapshot` 的 globalToPage）。 */
export interface FlatBlock {
  /** 阅读顺序全局下标 */
  index: number;
  /** 所在页（0 基） */
  pageIndex: number;
  /** 块文本（text/table 用 text、formula 用 latex、image 用占位符——与 stem 引用同帧） */
  text: string;
}

/**
 * 参与重建判定的题目最小面（结构子集：引擎 `Question` 天然满足，保持纯函数可单测）。
 */
export interface RebuildQuestionInput {
  id: string;
  stem: string;
  source: {
    /** 题目所在页（0 基） */
    pageIndex: number;
    /** 原始 blockIndexes（重建不中时原样保留） */
    blockIndexes: number[];
  };
}

/** 保留原值的归因（不静默：逐类计数 + 全量 id 列表进快照）。 */
export type KeptReason = "no-probe" | "not-found" | "next-unknown";

export interface RebuildReport {
  total: number;
  /** 重建成功（区间被替换）的题数 */
  rebuilt: number;
  /** 保留原值的题数（= keptReasons 三类之和） */
  kept: number;
  /** 半径 >1（放宽页邻近）才命中的题数 */
  widened: number;
  keptReasons: Record<KeptReason, number>;
  /** 保留原值的题 id 全量列表（可审计） */
  keptIds: string[];
  /** 反查到的真实起始块（按题序；重建/定位成功者有值）——落快照供回溯 */
  starts: (number | null)[];
}

export interface RebuildPlan {
  /** 与输入同序：`null` = 保留原值；否则为新区间（阅读顺序全局下标，含两端） */
  ranges: (number[] | null)[];
  report: RebuildReport;
}

/**
 * 连跑匹配长度：probe 的最长前缀在 `blocks[g..g+RUN_K]` 的 norm 拼接串中**原样出现**，
 * 且匹配起点落在**起始块 g 自身**内（否则 g 不是 stem 开头所在块，而是它后面的块）。
 */
function matchLenAt(g: number, probe: string, run: RunIndex): number {
  const lo = run.starts[g]!;
  const last = Math.min(g + RUN_K, run.texts.length - 1);
  const hi = run.ends[last]!;
  const seg = run.whole.slice(lo, hi);
  const gEnd = run.ends[g]! - lo; // 起始块在拼接串内的终点
  if (!probe.length || !seg.length) return 0;
  const first = probe[0]!;
  let best = 0;
  let from = 0;
  for (;;) {
    const o = seg.indexOf(first, from);
    if (o < 0 || o >= gEnd) break;
    let l = 0;
    while (l < probe.length && o + l < seg.length && probe[l] === seg[o + l]) l++;
    if (l > best) best = l;
    from = o + 1;
    if (from >= gEnd) break;
  }
  return best;
}

/** 全书 norm 拼接串 + 每块在串中的 [start,end) 区间（避免大文本上反复 slice）。 */
interface RunIndex {
  texts: string[];
  starts: number[];
  ends: number[];
  whole: string;
}

function buildRunIndex(blocks: FlatBlock[]): RunIndex {
  // 口径断言：FlatBlock.index 必须与数组位置一致（阅读顺序全局下标，跨页连续）。
  // 喂错拍平口径（比如按页内块序拍平）会整体错位——显式报错，不静默算错区间。
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.index !== i) {
      throw new Error(
        `FlatBlock.index 必须与数组位置一致（阅读顺序全局下标）：位置 ${i} 的 index=${blocks[i]!.index}` +
          "——请检查拍平口径（应为页升序 × 页内阅读序）",
      );
    }
  }
  const texts = blocks.map((b) => normText(b.text));
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (const t of texts) {
    starts.push(pos);
    pos += t.length;
    ends.push(pos);
  }
  return { texts, starts, ends, whole: texts.join("") };
}

/**
 * 重建计划（纯函数）：
 * 1. 逐题反查真实起始块（探针 = norm(stem) 前 12 字符；页邻近 ±1 → ±2 → ±4；
 *    下界 = 上一题已定位起始块——题目在块流中单调，真实起始必须严格递增）；
 * 2. 区间 = 本题起始块 → 下一题起始块前（下一题未定位 ⇒ 本题保留原值，不猜端点）。
 */
export function planBlockIndexRebuilds(
  questions: RebuildQuestionInput[],
  blocks: FlatBlock[],
): RebuildPlan {
  const run = buildRunIndex(blocks);
  const located: (number | null)[] = new Array(questions.length).fill(null);
  const reasons: (KeptReason | null)[] = new Array(questions.length).fill(null);
  const radii: number[] = new Array(questions.length).fill(0);
  const keptReasons: Record<KeptReason, number> = { "no-probe": 0, "not-found": 0, "next-unknown": 0 };
  let widened = 0;
  let prevFound = -1;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const probe = normText(q.stem).slice(0, PROBE_LEN);
    if (probe.length < PROBE_MIN) {
      reasons[i] = "no-probe";
      continue;
    }
    const need = Math.min(PREFIX_NEED, probe.length);
    const pi = q.source.pageIndex;
    let found = -1;
    let usedRadius = 0;
    for (const radius of PAGE_RADII) {
      // 题目在块流中单调 ⇒ 从上一题已定位起始块的下一块开始扫（同时是假命中的方向守卫）
      for (let gi = prevFound + 1; gi < run.texts.length; gi++) {
        const pg = blocks[gi]!.pageIndex;
        if (pg < pi - radius) continue;
        if (pg > pi + radius) break;
        if (matchLenAt(gi, probe, run) >= need) {
          found = gi;
          usedRadius = radius;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found >= 0) {
      located[i] = found;
      radii[i] = usedRadius;
      if (usedRadius > 1) widened++;
      prevFound = found;
    } else {
      reasons[i] = "not-found";
    }
  }

  const ranges: (number[] | null)[] = new Array(questions.length).fill(null);
  const starts: (number | null)[] = new Array(questions.length).fill(null);
  const keptIds: string[] = [];
  let rebuilt = 0;
  for (let i = 0; i < questions.length; i++) {
    const s = located[i]!; // ! 仅去 noUncheckedIndexedAccess 的 undefined；null 分支在下一行显式处理
    if (s === null) {
      keptIds.push(questions[i]!.id);
      keptReasons[reasons[i] === "no-probe" ? "no-probe" : "not-found"]++;
      continue;
    }
    starts[i] = s;
    const next: number | null = i + 1 < questions.length ? (located[i + 1] ?? null) : null;
    if (next === null) {
      // 最后一题、或下一题反查不中 ⇒ 端点无锚，不猜，保留原值
      keptIds.push(questions[i]!.id);
      keptReasons["next-unknown"]++;
      continue;
    }
    const range: number[] = [];
    for (let g = s; g < next; g++) range.push(g);
    ranges[i] = range;
    rebuilt++;
  }

  return {
    ranges,
    report: {
      total: questions.length,
      rebuilt,
      kept: keptIds.length,
      widened,
      keptReasons,
      keptIds,
      starts,
    },
  };
}
