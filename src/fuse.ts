/**
 * fuse.ts —— 两源融合原型：MinerU 行级几何 + OXR 文本内容。
 *
 * 定位（spec 2026-10-28-batch-book-ingestion-spec.md F1）：
 * - MinerU 的强项是**行级 bbox / 阅读顺序 / 纸面排版**；
 * - OXR 的强项是**内容识别**（题号/O→0/图注）；
 * - 本模块把两源的整页文字流做**字符级对齐**（Myers diff），再把 OXR 原文按字符
 *   分配给 MinerU 的行块：**文字用 OXR，位置用 MinerU**。
 *
 * 为什么不是行级一对一：两源换行点不同（同样一句话一行 24 字 vs 27 字），
 * 行级配对会把「MinerU 第 3 行」判成未匹配而整行保留，同时 OXR 又把同一段
 * 文字并进相邻行，成品里就出现重复行。字符级对齐只认字，不认换行，能避免这类重复。
 *
 * OXR 独有文字（MinerU 整行漏识别，如选项 A/B 行）落成独立块（bbox 从 OXR 缩放）；
 * MinerU 独有文字（OXR 漏识别）保留 MinerU 文本。所有采用 OXR 文本的块带 `fromFusion`，
 * 绝不静默改写。
 *
 * 这是**原型**：不写 `data/out`，由 `scripts/fuse-eval.ts` 在现有 8 卷上评估。
 */
import { layoutPage } from "./layout.js";
import type { BBox, IndexedBlock, PageInfo, ParsedBlock, ParsedDocument } from "./types.js";

export interface FusePageStats {
  page: number;
  mineru: number;
  oxr: number;
  matched: number;
  textChanged: number;
  oxrOnly: number;
  mineruOnly: number;
  /** 采用 OXR 文本但 MinerU 有较多字未在 OXR 找到（<COVERAGE_MIN）的块数，供复核 */
  lowCoverage: number;
}

export interface FuseStats {
  pages: number;
  mineruBlocks: number;
  oxrBlocks: number;
  matched: number;
  textChanged: number;
  oxrOnly: number;
  mineruOnly: number;
  lowCoverage: number;
  perPage: FusePageStats[];
  /** OXR 有、MinerU 没有的页（原型不并入） */
  oxrExtraPages: number;
}

export interface FuseResult {
  doc: ParsedDocument;
  stats: FuseStats;
}

/** 一行 MinerU 文字与它在 OXR 里的候选文本要有多像，才整行改用 OXR 文本。 */
const TRUST_MIN_SIM = 0.5;
const TRUST_MIN_RATIO = 0.45;
const TRUST_MAX_RATIO = 3;
/** 采用 OXR 文本但相似度低于此值的块计入 lowCoverage，供人工复核。 */
const REVIEW_SIM = 0.8;

const norm = (s: string): string =>
  s
    .replace(/\\[A-Za-z]+/g, "")
    .replace(/[\s${}\\]/g, "")
    .replace(/[，。；：、,.;:!?（）()【】《》“”"'']/g, "")
    .toLowerCase();

/** 字符 bigram Dice（与 score.ts 同口径，但 src 不反向依赖 scripts）。 */
export function fuseSimilarity(a: string, b: string): number {
  const A = norm(a);
  const B = norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;
  const ga = new Map<string, number>();
  for (let i = 0; i + 1 < A.length; i++) {
    const g = A.slice(i, i + 2);
    ga.set(g, (ga.get(g) ?? 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i + 1 < B.length; i++) {
    const g = B.slice(i, i + 2);
    const n = ga.get(g) ?? 0;
    if (n > 0) {
      inter++;
      ga.set(g, n - 1);
    }
  }
  return (2 * inter) / (A.length - 1 + (B.length - 1));
}

function textOf(b: ParsedBlock): string {
  if (b.kind === "text" || b.kind === "table") return b.text;
  if (b.kind === "formula") return b.latex;
  return "";
}

function center(b: ParsedBlock): [number, number] {
  return [(b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2];
}

/** 归一化位置距离（0 = 完全同位置，1 = 最远）。两源页面尺寸可不同。 */
function posDistance(m: ParsedBlock, mp: PageInfo, o: ParsedBlock, op: PageInfo): number {
  const [mx, my] = center(m);
  const [ox, oy] = center(o);
  const dx = Math.abs(mx / Math.max(1, mp.width) - ox / Math.max(1, op.width));
  const dy = Math.abs(my / Math.max(1, mp.height) - oy / Math.max(1, op.height));
  return Math.min(1, dx + dy);
}

/* ------------------------------------------------------------------ */
/* 字符级对齐                                                          */
/* ------------------------------------------------------------------ */

const PUNCT: Record<string, string> = {
  "，": ",",
  "。": ".",
  "；": ";",
  "：": ":",
  "、": ",",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "《": "<",
  "》": ">",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "！": "!",
  "？": "?",
  "—": "-",
  "－": "-",
  "～": "~",
  "·": ".",
  "．": ".",
};
const SKIP = new Set([" ", "\t", "\n", "\r", "$", "{", "}", "\\", "\u3000"]);

/** 参与对齐的字符 key；返回 "" 表示该字符不参与（格式符/空白）。 */
function unitKey(ch: string): string {
  if (SKIP.has(ch)) return "";
  const p = PUNCT[ch];
  if (p !== undefined) return p;
  return ch.toLowerCase();
}

interface Unit {
  key: string;
  start: number;
  end: number;
  block: number;
}

interface Stream {
  raw: string;
  units: Unit[];
  blocks: ParsedBlock[];
  starts: number[];
  ends: number[];
  blockUnits: number[];
}

/** 把一页块序列拼成一个连续文字流；图片不参与对齐。 */
function buildStream(blocks: ParsedBlock[]): Stream {
  let raw = "";
  const units: Unit[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const blockUnits: number[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const t = textOf(blocks[bi]!);
    starts.push(raw.length);
    let n = 0;
    for (let i = 0; i < t.length; i++) {
      const k = unitKey(t[i]!);
      if (!k) continue;
      units.push({ key: k, start: raw.length + i, end: raw.length + i + 1, block: bi });
      n++;
    }
    raw += t;
    ends.push(raw.length);
    blockUnits.push(n);
  }
  return { raw, units, blocks, starts, ends, blockUnits };
}

type DiffOp = { t: 0 | 1 | 2; ai: number; bi: number }; // 0=eq 1=del 2=ins

/**
 * Myers O(ND) diff，返回按顺序的操作。
 * 已验证：5000 组随机序列与暴力 LCS 长度一致，操作可无损重建两串。
 */
function myersDiff(a: Unit[], b: Unit[]): DiffOp[] {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const off = MAX;
  const v = new Int32Array(2 * MAX + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;
  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!)) x = v[k + 1 + off]!;
      else x = v[k - 1 + off]! + 1;
      let y = x - k;
      while (x < N && y < M && a[x]!.key === b[y]!.key) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= N && y >= M) {
        foundD = d;
        break outer;
      }
    }
  }
  const ops: DiffOp[] = [];
  let x = N;
  let y = M;
  for (let d = foundD; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[k - 1 + off]! < vd[k + 1 + off]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[prevK + off]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: 0, ai: x, bi: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ t: 2, ai: x, bi: y });
      } else {
        x--;
        ops.push({ t: 1, ai: x, bi: y });
      }
    }
  }
  ops.reverse();
  return ops;
}

interface Ownership {
  /** OXR 每个 unit 的归属：0 = MinerU 块，1 = OXR 独有块 */
  kind: Uint8Array;
  /** M 块下标或 OXR 独有块编号 */
  idx: Int32Array;
  /** OXR 独有连续段（unit 下标区间） */
  runs: { start: number; end: number }[];
}

/**
 * 把 OXR 的 unit 分配给 MinerU 块；整行/整段无对应的落成 OXR 独有段。
 *
 * `trusted` 之外的 MinerU 块不接收 OXR 文字（它们的行在 OXR 里没有对应，
 * 如 OXR 漏识别的小节标题/页眉家具），这些 unit 会重新找邻行或落成 OXR 独有段。
 */
function assignOwners(m: Stream, o: Stream, matchO: Int32Array, trusted: boolean[]): Ownership {
  const ownerM = new Int32Array(o.units.length).fill(-1);
  for (let u = 0; u < o.units.length; u++) {
    const mi = matchO[u]!;
    if (mi < 0) continue;
    const bi = m.units[mi]!.block;
    if (trusted[bi]) ownerM[u] = bi;
  }

  const kind = new Uint8Array(o.units.length);
  const idx = new Int32Array(o.units.length).fill(-1);
  const runs: { start: number; end: number }[] = [];

  let i = 0;
  while (i < o.units.length) {
    if (ownerM[i]! >= 0) {
      kind[i] = 0;
      idx[i] = ownerM[i]!;
      i++;
      continue;
    }
    let j = i;
    while (j < o.units.length && ownerM[j]! < 0) j++;
    // 整段未匹配区间按 OXR 行边界拆子段：同一行内的补充文字跟该行已匹配块走，
    // 整行都没对应的才是 OXR 独有行（否则一行尾 + 下一行会被并成一个跨行块）。
    const prev = i - 1;
    const next = j < o.units.length ? j : -1;
    const prevBlock = prev >= 0 ? ownerM[prev]! : -1;
    const nextBlock = next >= 0 ? ownerM[next]! : -1;
    let s = i;
    while (s < j) {
      let e = s + 1;
      while (e < j && o.units[e]!.block === o.units[s]!.block) e++;
      const prevSame = prev >= 0 && o.units[prev]!.block === o.units[s]!.block;
      const nextSame = next >= 0 && o.units[next]!.block === o.units[s]!.block;
      let target = -1;
      if (prevSame) target = prevBlock;
      else if (nextSame) target = nextBlock;
      else if (prevBlock >= 0 && prevBlock === nextBlock) target = prevBlock;
      else if (e - s < 2 && (prevBlock >= 0 || nextBlock >= 0)) target = prevBlock >= 0 ? prevBlock : nextBlock;
      if (target >= 0) {
        for (let k = s; k < e; k++) {
          kind[k] = 0;
          idx[k] = target;
        }
      } else {
        const rid = runs.length;
        runs.push({ start: s, end: e });
        for (let k = s; k < e; k++) {
          kind[k] = 1;
          idx[k] = rid;
        }
      }
      s = e;
    }
    i = j;
  }
  return { kind, idx, runs };
}

/** 把 unit 归属展开到每个原始字符（含标点/空白/LaTeX 格式符）。 */
function charOwners(o: Stream, own: Ownership): { kind: Uint8Array; idx: Int32Array } {
  const n = o.raw.length;
  const kind = new Uint8Array(n);
  const idx = new Int32Array(n).fill(-1);
  for (let u = 0; u < o.units.length; u++) {
    kind[o.units[u]!.start] = own.kind[u]!;
    idx[o.units[u]!.start] = own.idx[u]!;
  }
  let lk = 0;
  let li = -1;
  for (let c = 0; c < n; c++) {
    if (idx[c]! >= 0) {
      lk = kind[c]!;
      li = idx[c]!;
    } else if (li >= 0) {
      kind[c] = lk;
      idx[c] = li;
    }
  }
  let first = -1;
  for (let c = 0; c < n; c++) {
    if (idx[c]! >= 0) {
      first = c;
      break;
    }
  }
  if (first > 0) {
    for (let c = 0; c < first; c++) {
      kind[c] = kind[first]!;
      idx[c] = idx[first]!;
    }
  }
  return { kind, idx };
}

/** `$...$` 行内公式不允许被切到两个块里；整段归给占多数的块。 */
function keepFormulasWhole(o: Stream, ck: Uint8Array, ci: Int32Array): void {
  for (let bi = 0; bi < o.blocks.length; bi++) {
    const s = o.starts[bi]!;
    const e = o.ends[bi]!;
    const marks: number[] = [];
    for (let c = s; c < e; c++) if (o.raw[c] === "$") marks.push(c);
    for (let p = 0; p + 1 < marks.length; p += 2) {
      const a = marks[p]!;
      const b = marks[p + 1]!;
      if (b <= a + 1) continue;
      let same = true;
      for (let c = a + 1; c <= b; c++) {
        if (ck[c] !== ck[a] || ci[c] !== ci[a]) {
          same = false;
          break;
        }
      }
      if (same) continue;
      let mCount = 0;
      let sCount = 0;
      for (let c = a; c <= b; c++) {
        if (ck[c] === 0) mCount++;
        else sCount++;
      }
      const targetKind = mCount >= sCount ? 0 : 1;
      let targetIdx = -1;
      let best = -1;
      const votes = new Map<number, number>();
      for (let c = a; c <= b; c++) {
        if (ck[c] === targetKind) {
          const v = (votes.get(ci[c]!) ?? 0) + 1;
          votes.set(ci[c]!, v);
          if (v > best) {
            best = v;
            targetIdx = ci[c]!;
          }
        }
      }
      if (targetIdx < 0) continue;
      for (let c = a; c <= b; c++) {
        ck[c] = targetKind;
        ci[c] = targetIdx;
      }
    }
  }
}

interface Range {
  min: number;
  max: number;
}

function rangesOf(mCount: number, runCount: number, ck: Uint8Array, ci: Int32Array): { m: (Range | null)[]; s: (Range | null)[] } {
  const m: (Range | null)[] = new Array(mCount).fill(null);
  const s: (Range | null)[] = new Array(runCount).fill(null);
  for (let c = 0; c < ci.length; c++) {
    const i = ci[c]!;
    if (i < 0) continue;
    const arr = ck[c] === 0 ? m : s;
    const r = arr[i];
    if (!r) arr[i] = { min: c, max: c };
    else {
      if (c < r.min) r.min = c;
      if (c > r.max) r.max = c;
    }
  }
  return { m, s };
}

function unionBbox(parts: BBox[]): BBox | null {
  if (parts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of parts) {
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}

/** 把 OXR 原文区间建成独立块：bbox 取覆盖该区间的 OXR 块并集，再缩放到 MinerU 页面。 */
function buildOxrOnly(
  o: Stream,
  range: Range,
  mp: PageInfo,
  op: PageInfo,
): ParsedBlock | null {
  const text = o.raw.slice(range.min, range.max + 1).trim();
  if (!text) return null;
  const boxes: BBox[] = [];
  let base: ParsedBlock | null = null;
  let baseOverlap = -1;
  for (let bi = 0; bi < o.blocks.length; bi++) {
    const s = o.starts[bi]!;
    const e = o.ends[bi]!;
    if (e <= range.min || s > range.max) continue;
    const b = o.blocks[bi]!;
    if (b.kind === "image") continue;
    boxes.push(b.bbox);
    const ov = Math.min(e, range.max + 1) - Math.max(s, range.min);
    if (ov > baseOverlap) {
      baseOverlap = ov;
      base = b;
    }
  }
  const ub = unionBbox(boxes);
  if (!base || !ub) return null;
  const sx = mp.width / Math.max(1, op.width);
  const sy = mp.height / Math.max(1, op.height);
  const bbox: BBox = [ub[0] * sx, ub[1] * sy, ub[2] * sx, ub[3] * sy];
  if (base.kind === "formula") return { ...base, bbox, latex: text, fromFusion: true };
  return { ...base, bbox, text, firstLine: text.split("\n")[0] ?? text, fromFusion: true };
}

function normLen(s: string): number {
  return norm(s).length;
}

/** 一个 MinerU 行在 OXR 里是否有可信对应：文本相似度 + 长度量级。 */
function computeTrust(m: Stream, o: Stream, mRanges: (Range | null)[]): boolean[] {
  return m.blocks.map((b, i) => {
    if (b.kind === "image") return true;
    const r = mRanges[i];
    if (!r) return false;
    const oText = o.raw.slice(r.min, r.max + 1).trim();
    if (!oText) return false;
    const sim = fuseSimilarity(textOf(b), oText);
    const lm = normLen(textOf(b));
    const lo = normLen(oText);
    const ratio = lo / Math.max(1, lm);
    return sim >= TRUST_MIN_SIM && ratio >= TRUST_MIN_RATIO && ratio <= TRUST_MAX_RATIO;
  });
}

/** 页内融合：文字流字符级对齐，文字取 OXR、几何取 MinerU。 */
function fusePage(mPage: PageInfo, oPage: PageInfo): { page: PageInfo; stats: FusePageStats } {
  const mBlocks = layoutPage(mPage).ordered.map((x: IndexedBlock) => x.block);
  const oBlocks = layoutPage(oPage).ordered.map((x: IndexedBlock) => x.block);
  const m = buildStream(mBlocks);
  const o = buildStream(oBlocks);
  const ops = myersDiff(m.units, o.units);
  const matchO = new Int32Array(o.units.length).fill(-1);
  for (const op of ops) if (op.t === 0) matchO[op.bi] = op.ai;

  // 先假设所有 MinerU 块都能接 OXR 文字；对「OXR 根本没收这一行」的块（小节标题、
  // 页眉家具等）取消信任，让它已占的 OXR 字回流给邻行/独有段，再重新分配。
  let trusted = mBlocks.map(() => true);
  let own: Ownership = assignOwners(m, o, matchO, trusted);
  let ck: Uint8Array = new Uint8Array(0);
  let ci: Int32Array = new Int32Array(0);
  let mRanges: (Range | null)[] = [];
  let sRanges: (Range | null)[] = [];
  for (let iter = 0; iter < 4; iter++) {
    const chars = charOwners(o, own);
    ck = chars.kind;
    ci = chars.idx;
    keepFormulasWhole(o, ck, ci);
    const rs = rangesOf(mBlocks.length, own.runs.length, ck, ci);
    mRanges = rs.m;
    sRanges = rs.s;
    const next = computeTrust(m, o, mRanges);
    let changed = false;
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== trusted[i]) {
        changed = true;
        break;
      }
    }
    trusted = next;
    if (!changed) break;
    own = assignOwners(m, o, matchO, trusted);
  }
  // 用最终 trusted 再分配一次，保证输出与信任集一致。
  own = assignOwners(m, o, matchO, trusted);
  const chars = charOwners(o, own);
  ck = chars.kind;
  ci = chars.idx;
  keepFormulasWhole(o, ck, ci);
  const rs = rangesOf(mBlocks.length, own.runs.length, ck, ci);
  mRanges = rs.m;
  sRanges = rs.s;

  const blocks: ParsedBlock[] = [];
  let matched = 0;
  let textChanged = 0;
  let mineruOnly = 0;
  let lowCoverage = 0;

  for (let bi = 0; bi < mBlocks.length; bi++) {
    const b = mBlocks[bi]!;
    if (b.kind === "image") {
      const hit = oBlocks.some((ob) => ob.kind === "image" && posDistance(b, mPage, ob, oPage) <= 0.35);
      if (hit) matched++;
      else mineruOnly++;
      blocks.push(b);
      continue;
    }
    const range = mRanges[bi];
    if (range && trusted[bi]) {
      const text = o.raw.slice(range.min, range.max + 1).trim();
      if (text) {
        const changed = text !== textOf(b);
        const fused: ParsedBlock =
          b.kind === "formula"
            ? { ...b, latex: text, fromFusion: true }
            : { ...b, text, firstLine: text.split("\n")[0] ?? text, fromFusion: true };
        blocks.push(fused);
        matched++;
        if (changed) textChanged++;
        if (fuseSimilarity(textOf(b), text) < REVIEW_SIM) lowCoverage++;
        continue;
      }
    }
    blocks.push(b);
    mineruOnly++;
  }

  let oxrOnly = 0;
  for (const range of sRanges) {
    if (!range) continue;
    const b = buildOxrOnly(o, range, mPage, oPage);
    if (!b) continue;
    blocks.push(b);
    oxrOnly++;
  }

  return {
    page: { index: mPage.index, width: mPage.width, height: mPage.height, blocks },
    stats: {
      page: mPage.index,
      mineru: mPage.blocks.length,
      oxr: oPage.blocks.length,
      matched,
      textChanged,
      oxrOnly,
      mineruOnly,
      lowCoverage,
    },
  };
}

/** 整卷融合：按页号配对；MinerU 页面为几何基座，OXR 文本为内容源。 */
export function fuseDocuments(mineru: ParsedDocument, oxr: ParsedDocument): FuseResult {
  const oByPage = new Map(oxr.pages.map((p) => [p.index, p]));
  const pages: PageInfo[] = [];
  const perPage: FusePageStats[] = [];
  let usedOxrPages = 0;
  for (const mp of mineru.pages) {
    const op = oByPage.get(mp.index);
    if (!op) {
      pages.push(mp);
      perPage.push({ page: mp.index, mineru: mp.blocks.length, oxr: 0, matched: 0, textChanged: 0, oxrOnly: 0, mineruOnly: mp.blocks.length, lowCoverage: 0 });
      continue;
    }
    const r = fusePage(mp, op);
    pages.push(r.page);
    perPage.push(r.stats);
    usedOxrPages++;
  }
  const sum = (k: keyof FusePageStats) => perPage.reduce((a, p) => a + (p[k] as number), 0);
  return {
    doc: { docId: mineru.docId, pages },
    stats: {
      pages: pages.length,
      mineruBlocks: sum("mineru"),
      oxrBlocks: perPage.reduce((a, p) => a + p.oxr, 0),
      matched: sum("matched"),
      textChanged: sum("textChanged"),
      oxrOnly: sum("oxrOnly"),
      mineruOnly: sum("mineruOnly"),
      lowCoverage: sum("lowCoverage"),
      perPage,
      oxrExtraPages: oxr.pages.length - usedOxrPages,
    },
  };
}
