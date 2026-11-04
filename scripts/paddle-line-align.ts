// scripts/paddle-line-align.ts
/**
 * 小样探针：VL 出字 + V3 出行框，逐块做「锚点 → 排除法 → 交人工」（**只读，不写任何快照**）。
 *
 * 方案与失效模式见 `docs/plans/2026-11-03-vl-text-v3-lines.md`。
 * 本脚本只回答一件事：**这套对齐在真数据上能落到什么程度** ——
 * 多少行能靠锚点、多少行靠排除、多少行必须交人工、有没有剩字/剩框。
 *
 * 用法：
 *   npx tsx scripts/paddle-line-align.ts \
 *     --vl-doc "物理_教材基础练 电路" --v3-doc "物理_教材基础练 电路-MinerU"
 *   （可选 --limit N 只看前 N 页）
 *
 * 输入：两本目录下 `ocr-jobs/*.pages.json`（由 `scripts/paddle-client.ts` 落盘）。
 * 输出：`data/out/<vlDoc>/paddle-line-align.json` + `docs/evidence/2026-11-03-line-align-probe.md`。
 * 红线：检测不改写 —— 不碰 stages.json / questions.json / ocr-page-fill.json。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaddlePage } from "./paddle-client.js";
import { hardChars } from "./paddle-pos-diff.js";

type Box = [number, number, number, number];
const ROOT = join(import.meta.dirname, "..");
/** 块框外扩：V3 行框常比 VL 块框略宽/略高（同为版面检测，边界口径不同）。 */
const PAD = 0.002;

export type Verdict = "anchor" | "eliminated" | "guard_blocked" | "needs_human" | "leftover_text" | "leftover_frame";

/**
 * 排除法的**容量守卫**（2026-11-03 用户定：阈值 1.5 倍）。
 * 为什么不用"字号 × 字数"：字号是整页中位行高、字宽又不齐（汉字≈1 宽、数字≈半宽、
 * LaTeX 记号纸面上根本不存在）⇒ 绝对量估不准。改用**同块已锚定行的平均每行字数**当尺子，
 * 数据自校准；缺口超过它的 1.5 倍就判"这一行放不下"，标待核不填。
 * 方向是"不确定就拦"：拦错只多一条待核、页面上看得见；漏拦是静默塞错、看不见。
 */
export const CAPACITY_RATIO = 1.5;

export interface BlockResult {
  page: number;
  label: string;
  lines: number;
  anchor: number;
  /** 锚点里有多少是「乱序匹配」的（行序 ≠ 文本序，说明块内跨栏或续段） */
  outOfOrder?: number;
  eliminated: number;
  /** 排除法被容量守卫拦下的行数（并进「交人工」统计） */
  guardBlocked: number;
  needsHuman: number;
  leftoverText: number;
  leftoverFrame: number;
  chars: number;
  consumed: number;
}

export interface Example {
  kind: Verdict;
  page: number;
  label: string;
  text: string;
  detail: string;
}

const center = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inside = (p: [number, number], b: Box, pad = PAD): boolean =>
  p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;

/**
 * 去掉**标记本身**，只留标记里的字（2026-11-03 实测：表格块的 block_content 是 HTML，
 * `<table><tr><td rowspan="2">` 会被当成"没消费掉的字"，白拉低消费率、还会造成假报警）。
 * 处理：HTML 标签、图片占位符、LaTeX 环境壳（`\begin{...}` / `\end{...}`）。
 */
export function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\\(?:begin|end)\{[^}]*\}/g, " ");
}

/**
 * 匹配前的字符归一化：在 `hardChars` 之上再去掉**标点与符号**。
 * 实测原因（2026-11-03）：VL 出半角 `,`、V3 出全角 `，`，一字之差整行 MISS。
 * 位置对齐只需要"实义字"一致，标点不参与。
 */
/** 与 `hardChars` 同口径的**去标点**版本，同时记录每个字符在原串中的下标（回填原文用）。 */
export function hardNormWithMap(s: string): { chars: string[]; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  const stripped = stripMarkup(s);
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (/\s/.test(ch)) continue;
    if (ch === "$" || ch === "\\" || ch === "{" || ch === "}") continue;
    if (/[，。、；：？！“”‘’（）《》〈〉「」【】,.;:?!"'()\[\]<>=+*/~—…·\-]/.test(ch)) continue;
    out.push(ch);
    map.push(i);
  }
  return { chars: out, map };
}

export function matchChars(s: string): string[] {
  return hardChars(stripMarkup(s)).filter((c) => !/[，。、；：？！“”‘’（）《》〈〉「」【】,.;:?!"'()\[\]<>=+*/~—…·\-]/.test(c));
}

/** 在 `hay` 里从 `from` 起找 `needle`（都已是硬字符数组）。 */
export function findSub(hay: string[], needle: string[], from: number): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  for (let i = Math.max(0, from); i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/**
 * 单块对齐（纯函数，可单测）。
 * `lines` 必须已按阅读顺序（y 再 x）排好；`blockText` 是该 VL 块的内容。
 */
export function alignBlock(blockText: string, lines: { text: string }[]): {
  result: Omit<BlockResult, "page" | "label">;
  examples: { kind: Verdict; detail: string }[];
} {
  const hay = matchChars(blockText);
  const used: { start: number; end: number }[] = [];
  const overlaps = (a: number, b: number) => used.some((u) => a < u.end && b > u.start);
  const examples: { kind: Verdict; detail: string }[] = [];
  const anchors = new Map<number, { start: number; end: number; outOfOrder: boolean }>();
  let cursor = 0;

  lines.forEach((l, idx) => {
    const needle = matchChars(l.text);
    if (needle.length === 0) return;
    let at = -1;
    // ① 顺序匹配（游标之后、且不与已占用区间重叠）
    for (let i = cursor; i + needle.length <= hay.length; i++) {
      if (hay.slice(i, i + needle.length).join("") === needle.join("") && !overlaps(i, i + needle.length)) { at = i; break; }
    }
    let outOfOrder = false;
    // ② 乱序兜底：从头再找一次（实测行序与文本序会不一致，尤其跨栏/跨页续段）
    if (at < 0) {
      for (let i = 0; i + needle.length <= hay.length; i++) {
        if (hay.slice(i, i + needle.length).join("") === needle.join("") && !overlaps(i, i + needle.length)) { at = i; outOfOrder = true; break; }
      }
    }
    if (at >= 0) {
      used.push({ start: at, end: at + needle.length });
      anchors.set(idx, { start: at, end: at + needle.length, outOfOrder });
      if (!outOfOrder) cursor = at + needle.length;
      if (outOfOrder) examples.push({ kind: "anchor", detail: "乱序匹配（行序与文本序不一致）" });
    }
  });

  // 容量尺子：同块已锚定行的平均硬字符数（只算真锚上的行）
  const anchoredLens = [...anchors.keys()].map((i) => matchChars(lines[i]!.text).length).filter((n) => n > 0);
  const avgChars = anchoredLens.length ? anchoredLens.reduce((a, b) => a + b, 0) / anchoredLens.length : 0;

  const res = {
    lines: lines.length,
    anchor: anchors.size,
    guardBlocked: 0,
    outOfOrder: [...anchors.values()].filter((a) => a.outOfOrder).length,
    eliminated: 0,
    needsHuman: 0,
    leftoverText: 0,
    leftoverFrame: 0,
    chars: hay.length,
    consumed: [...anchors.values()].reduce((a, m) => a + (m.end - m.start), 0),
  };

  // 按行序把「连续未锚定的行」聚成 run；每 run 的缺口 = 上一个锚点结束 → 下一个锚点开始
  let prevEnd = 0;
  let i = 0;
  const sortedAnchorIdx = [...anchors.keys()].sort((a, b) => a - b);
  const anchorPos = new Map(sortedAnchorIdx.map((k, n) => [k, n]));
  while (i < lines.length) {
    if (anchors.has(i)) {
      prevEnd = anchors.get(i)!.end;
      i++;
      continue;
    }
    const run: number[] = [];
    const gapStart = prevEnd;
    while (i < lines.length && !anchors.has(i)) { run.push(i); i++; }
    const next = i < lines.length ? anchors.get(i)! : null;
    const gapLen = Math.max(0, (next ? next.start : hay.length) - gapStart);
    if (run.length === 1 && gapLen > 0) {
      // 容量守卫：这条线放得下这段字吗？（拿同块已锚定行的平均字数当尺子）
      const fits = avgChars > 0 && gapLen <= avgChars * CAPACITY_RATIO;
      if (fits) {
        res.eliminated++;
        examples.push({ kind: "eliminated", detail: `1 行 / ${gapLen} 字（邻行均 ${avgChars.toFixed(1)}）⇒ 排除法定行` });
      } else {
        res.guardBlocked++;
        examples.push({
          kind: "guard_blocked",
          detail: `1 行 / ${gapLen} 字（邻行均 ${avgChars ? avgChars.toFixed(1) : "无可比"}）⇒ 超过 ${CAPACITY_RATIO} 倍，不填`,
        });
      }
    } else if (run.length >= 2 && gapLen > 0) {
      res.needsHuman++;
      examples.push({ kind: "needs_human", detail: `${run.length} 行 / ${gapLen} 字 ⇒ 有歧义` });
    } else if (run.length >= 1) {
      res.leftoverFrame++;
      examples.push({ kind: "leftover_frame", detail: `${run.length} 行没有对应的字` });
    }
  }

  // 锚点之间（含头尾）一个未锚行都没有、但缺口里还有字 ⇒ 剩字
  for (let k = 0; k <= sortedAnchorIdx.length; k++) {
    const gapStart = k === 0 ? 0 : anchors.get(sortedAnchorIdx[k - 1]!)!.end;
    const gapEnd = k === sortedAnchorIdx.length ? hay.length : anchors.get(sortedAnchorIdx[k]!)!.start;
    const gapLen = Math.max(0, gapEnd - gapStart);
    if (gapLen === 0) continue;
    // 这个缺口里是否有未锚定的行？
    const lo = k === 0 ? -1 : sortedAnchorIdx[k - 1]!;
    const hi = k === sortedAnchorIdx.length ? lines.length : sortedAnchorIdx[k]!;
    const hasUnanchored = lines.slice(lo + 1, hi).some((_l, n) => !anchors.has(lo + 1 + n));
    if (!hasUnanchored) {
      res.leftoverText++;
      examples.push({ kind: "leftover_text", detail: `${gapLen} 个字没有落点` });
    }
  }
  void anchorPos;
  return { result: res, examples };
}


/**
 * 每行最终「拿走哪段文字」（锚点行取命中片段；排除法行取缺口片段）。
 * 供产线用：洞与行框对齐后，洞里的字就取它所在那一行的这段。
 */
export interface LineText {
  lineIdx: number;
  /** `anchor` 文字对得上；`eliminated` 由排除法得到；`blocked` 守卫/歧义，不给文字 */
  kind: "anchor" | "eliminated" | "blocked";
  /** 该行拿走的文字（硬字符）；原文请用 `span` 回填 */
  text: string;
  /** `[start, end)`：在硬字符序列里的区间；blocked 时为 null */
  span: [number, number] | null;
}

export function alignBlockLines(blockText: string, lines: { text: string }[]): LineText[] {
  const hay = matchChars(blockText);
  const used: { start: number; end: number }[] = [];
  const overlaps = (a: number, b: number) => used.some((u) => a < u.end && b > u.start);
  const anchors = new Map<number, { start: number; end: number }>();
  let cursor = 0;
  lines.forEach((l, idx) => {
    const needle = matchChars(l.text);
    if (needle.length === 0) return;
    let at = -1;
    for (let i = cursor; i + needle.length <= hay.length; i++) {
      if (hay.slice(i, i + needle.length).join("") === needle.join("") && !overlaps(i, i + needle.length)) { at = i; break; }
    }
    if (at < 0) {
      for (let i = 0; i + needle.length <= hay.length; i++) {
        if (hay.slice(i, i + needle.length).join("") === needle.join("") && !overlaps(i, i + needle.length)) { at = i; break; }
      }
    }
    if (at >= 0) {
      used.push({ start: at, end: at + needle.length });
      anchors.set(idx, { start: at, end: at + needle.length });
      cursor = Math.max(cursor, at + needle.length);
    }
  });

  const anchoredLens = [...anchors.keys()].map((i) => matchChars(lines[i]!.text).length).filter((n) => n > 0);
  const avg = anchoredLens.length ? anchoredLens.reduce((a, b) => a + b, 0) / anchoredLens.length : 0;

  const out: LineText[] = lines.map((l, i) => ({ lineIdx: i, kind: "blocked" as const, text: l.text, span: null }));
  for (const [idx, a] of anchors)
    out[idx] = { lineIdx: idx, kind: "anchor", text: hay.slice(a.start, a.end).join(""), span: [a.start, a.end] };

  // 缺口：未被占用的 hard 区间，按行序分配给未锚定的行
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (anchors.has(i)) { prevEnd = anchors.get(i)!.end; i++; continue; }
    const run: number[] = [];
    const gs = prevEnd;
    while (i < lines.length && !anchors.has(i)) { run.push(i); i++; }
    const ge = i < lines.length ? anchors.get(i)!.start : hay.length;
    const gapLen = Math.max(0, ge - gs);
    const fits = run.length === 1 && gapLen > 0 && avg > 0 && gapLen <= avg * CAPACITY_RATIO;
    if (fits) out[run[0]!] = { lineIdx: run[0]!, kind: "eliminated", text: hay.slice(gs, ge).join(""), span: [gs, ge] };
  }
  return out;
}

function loadPages(doc: string): PaddlePage[] {
  const dir = join(ROOT, "data", "out", doc, "ocr-jobs");
  if (!existsSync(dir)) throw new Error(`没有 ${dir}`);
  const f = readdirSync(dir).find((n) => n.endsWith(".pages.json"));
  if (!f) throw new Error(`${dir} 里没有 *.pages.json（先跑 npm run ocr:job）`);
  return JSON.parse(readFileSync(join(dir, f), "utf8")) as PaddlePage[];
}

const KIND_ZH: Record<Verdict, string> = {
  anchor: "锚点",
  eliminated: "排除法定行",
  guard_blocked: "容量守卫拦下",
  needs_human: "交人工",
  leftover_text: "剩字报警",
  leftover_frame: "剩框报警",
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const vlDoc = flag("vl-doc");
  if (!vlDoc) {
    console.error('用法: paddle-line-align.ts --vl-doc "<VL 目录>" [--v3-doc "<V3 目录>"] [--limit N]');
    process.exit(2);
  }
  const v3Doc: string = flag("v3-doc") ?? vlDoc;
  const limit = Number(flag("limit") ?? 0);
  const vl = loadPages(vlDoc);
  const v3 = loadPages(v3Doc);
  const n = limit > 0 ? Math.min(limit, vl.length, v3.length) : Math.min(vl.length, v3.length);

  const blocks: BlockResult[] = [];
  const examples: Example[] = [];
  const totals = { anchor: 0, eliminated: 0, guardBlocked: 0, needsHuman: 0, leftoverText: 0, leftoverFrame: 0, chars: 0, consumed: 0, blocks: 0, lines: 0 };

  let cover = { lines: 0, assigned: 0, ambiguous: 0, orphan: 0 };
  const byLabel = new Map<string, { blocks: number; lines: number; anchor: number; eliminated: number; guardBlocked?: number; needsHuman: number; chars: number; consumed: number }>();
  for (let p = 0; p < n; p++) {
    const vlPage = vl[p]!;
    const v3Page = v3[p]!;
    const allLines = v3Page.lines.filter((l) => l.norm && l.text);
    // 按**重叠面积占该行面积的比例**归块：行框常比 VL 块框宽/高，用中心点判会大量落空
    const byBlock = new Map<number, typeof allLines>();
    cover.lines += allLines.length;
    for (const l of allLines) {
      const ln: Box = l.norm!;
      const area = Math.max(0, ln[2] - ln[0]) * Math.max(0, ln[3] - ln[1]) || 1e-9;
      let best = -1;
      let bestRatio = 0;
      let hits = 0;
      vlPage.blocks.forEach((b, bi) => {
        if (!b.norm) return;
        const w = Math.min(ln[2], b.norm[2]) - Math.max(ln[0], b.norm[0]);
        const h = Math.min(ln[3], b.norm[3]) - Math.max(ln[1], b.norm[1]);
        const ov = w > 0 && h > 0 ? w * h : 0;
        const r = ov / area;
        if (r >= 0.5) hits++;
        if (r > bestRatio) { bestRatio = r; best = bi; }
      });
      if (hits >= 2) cover.ambiguous++;
      if (best < 0 || bestRatio < 0.5) { cover.orphan++; continue; }
      cover.assigned++;
      const arr = byBlock.get(best) ?? [];
      arr.push(l);
      byBlock.set(best, arr);
    }
    for (const [bi, candRaw] of byBlock) {
      const b = vlPage.blocks[bi]!;
      if (!b.norm || !b.content) continue;
      const cand = [...candRaw].sort((a, c) => a.norm![1] - c.norm![1] || a.norm![0] - c.norm![0]);
      const { result, examples: ex } = alignBlock(b.content, cand);
      blocks.push({ page: p + 1, label: b.label, ...result });
      totals.blocks++;
      totals.lines += result.lines;
      totals.anchor += result.anchor;
      totals.eliminated += result.eliminated;
      totals.guardBlocked += result.guardBlocked;
      totals.needsHuman += result.needsHuman;
      totals.leftoverText += result.leftoverText;
      totals.leftoverFrame += result.leftoverFrame;
      totals.chars += result.chars;
      totals.consumed += result.consumed;
      const L0 = byLabel.get(b.label) ?? { blocks: 0, lines: 0, anchor: 0, eliminated: 0, needsHuman: 0, chars: 0, consumed: 0 };
      L0.blocks++; L0.lines += result.lines; L0.anchor += result.anchor; L0.eliminated += result.eliminated;
      L0.guardBlocked = (L0.guardBlocked ?? 0) + result.guardBlocked;
      L0.needsHuman += result.needsHuman; L0.chars += result.chars; L0.consumed += result.consumed;
      byLabel.set(b.label, L0);
      for (const e of ex) {
        if (examples.filter((x) => x.kind === e.kind).length < 6) {
          examples.push({ kind: e.kind, page: p + 1, label: b.label, text: b.content.slice(0, 40), detail: e.detail });
        }
      }
    }
  }

  const outDir = join(ROOT, "data", "out", vlDoc);
  writeFileSync(
    join(outDir, "paddle-line-align.json"),
    JSON.stringify(
      {
        vlDoc,
        v3Doc,
        generatedAt: new Date().toISOString(),
        note: "只读探针：VL 出字 + V3 出行框，锚点→排除法→交人工；不变式是块内文字必须全部消费，剩字/剩框即报警。不写任何快照。",
        totals,
        blocks,
        examples,
      },
      null,
      2,
    ),
    "utf8",
  );

  const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;
  const L: string[] = [
    "# 小样探针：VL 出字 + V3 出行框（锚点 / 排除 / 交人工）",
    "",
    `> 生成：${new Date().toISOString().slice(0, 16)} ｜ 脚本：\`scripts/paddle-line-align.ts\` ｜ 方案：\`docs/plans/2026-11-03-vl-text-v3-lines.md\``,
    `> VL 目录：\`${vlDoc}\` ｜ V3 目录：\`${v3Doc}\` ｜ 页数：${n} ｜ 参与统计的块：${totals.blocks}（只算有行框的文字块）`,
    "",
    "| 指标 | 数 | 占行框 |",
    "|---|---:|---:|",
    `| V3 行框（落在 VL 块内） | ${totals.lines} | 100% |`,
    `| 靠文字锚点定行 | ${totals.anchor} | ${pct(totals.anchor, totals.lines)} |`,
    `| 靠排除法定行 | ${totals.eliminated} | ${pct(totals.eliminated, totals.lines)} |`,
    `| 排除法被容量守卫拦下（≥${CAPACITY_RATIO}× 邻行字数） | ${totals.guardBlocked} | ${pct(totals.guardBlocked, totals.lines)} |`,
    `| **交人工（歧义 + 守卫拦截）** | **${totals.needsHuman + totals.guardBlocked}** | ${pct(totals.needsHuman + totals.guardBlocked, totals.lines)} |`,
    `| 剩框报警（有框没字） | ${totals.leftoverFrame} | ${pct(totals.leftoverFrame, totals.lines)} |`,
    `| 剩字报警（有字没框） | ${totals.leftoverText} | — |`,
    `| 文字消费率 | ${totals.consumed} / ${totals.chars} | ${pct(totals.consumed, totals.chars)} |`,
    "",
    "### 行框归块覆盖率（诊断用）",
    "",
    `- 页面上 V3 行框共 **${cover.lines}** 个：按「与该行重叠 ≥50% 面积」归块 ⇒ 唯一归属 **${cover.assigned}**（${pct(cover.assigned, cover.lines)}）、`,
    `跨多块 **${cover.ambiguous}**、无归属（不在任何文字块内）**${cover.orphan}**（${pct(cover.orphan, cover.lines)}）`,
    "",
    "",
    "### 按块类型拆开（看是谁在拖后腿）",
    "",
    "| 块标签 | 块数 | 行框 | 锚点 | 排除 | 交人工 | 锚点+排除率 | 文字消费率 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...[...byLabel.entries()].sort((a, b) => b[1].lines - a[1].lines).map(([k, v]) =>
      `| ${k || "（空）"} | ${v.blocks} | ${v.lines} | ${v.anchor} | ${v.eliminated} | ${v.needsHuman} | ${pct(v.anchor + v.eliminated, v.lines)} | ${pct(v.consumed, v.chars)} |`),
    "",
    "## 样例（每类最多 6 条）",
    "",
    "| 类型 | 页 | 块标签 | 详情 | 块文本（截断） |",
    "|---|---:|---|---|---|",
  ];
  for (const e of examples) {
    L.push(`| ${KIND_ZH[e.kind]} | ${e.page} | ${e.label} | ${e.detail} | ${e.text.replace(/\|/g, "\\|")} |`);
  }
  L.push(
    "",
    "## 怎么读这张表",
    "",
    "- `锚点 + 排除法` = 这套方案能自动定的行；`交人工` = 连续多行都对不上（公式密集页常见）。",
    "- `剩字报警` 是本方案的**安全阀**：V3 漏行时不会把邻行文字塞进去，而是整块不补。",
    "- 本表只测**能不能落位**，不测**字对不对**（字一律来自 VL；VL 的准确率见 `DECISIONS §108`）。",
    "",
  );
  const reportPath = join(ROOT, "docs", "evidence", `2026-11-03-line-align-${vlDoc}.md`);
  writeFileSync(reportPath, L.join("\n"), "utf8");

  console.log(
    `\n${vlDoc}\n  行框 ${totals.lines}：锚点 ${totals.anchor}（${pct(totals.anchor, totals.lines)}）、` +
      `排除 ${totals.eliminated}（${pct(totals.eliminated, totals.lines)}）、` +
      `交人工 ${totals.needsHuman}（${pct(totals.needsHuman, totals.lines)}）、守卫拦下 ${totals.guardBlocked}（${pct(totals.guardBlocked, totals.lines)}）、` +
      `剩框 ${totals.leftoverFrame}、剩字 ${totals.leftoverText}\n` +
      `  文字消费 ${totals.consumed}/${totals.chars}（${pct(totals.consumed, totals.chars)}）；行框归块 ${cover.assigned}/${cover.lines}、无归属 ${cover.orphan}、跨块 ${cover.ambiguous}\n` +
      `  报告 → ${reportPath}`);
  for (const [k, v] of [...byLabel.entries()].sort((a, b) => b[1].lines - a[1].lines).slice(0, 5)) {
    console.log(`    ${k || "(空)"}: 行 ${v.lines} 锚点+排除 ${pct(v.anchor + v.eliminated, v.lines)} 消费 ${pct(v.consumed, v.chars)}`);
  }
  console.log(``,
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main().catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
