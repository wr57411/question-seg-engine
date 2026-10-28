/**
 * oxr-crosscheck.ts —— 两源交叉核对差异报告（docs/oxr-evaluation.md G11）
 *
 * 目的：把 OXR 当**第二解析源**逐块比对 MinerU 产物，产出「可判定的修复候选」。
 * 这是本分支结论「OXR 的第一落点是第二解析源/交叉核对」的落地实现。
 *
 * 红线约束：
 * - **检测不改写**：只产出候选（markdown + JSON），**不动任何快照数据**。
 * - **判据与实现不同源**：A 类锚定 HANDOFF §6-13 已确诊的错误模式 `[0０][点角]`
 *   （曾用第二套 OCR 独立核对：同模式在夸克扫描王 Word 版出现 0 次），
 *   不是"两版文本不同就算差异"。
 *
 * ⚠️ 匹配方式：**不能用 bbox 中心距**。实测两版的**行级切点完全不同**
 * （MinerU 一行一块、OXR 按宽度重新折行），同位置最近块距离 34.5pt ≈ 跨三行，
 * 匹配到的根本不是同一句（第一版就是这么得出「O→0 候选 0」的错误结论）。
 * 改为**文本上下文匹配**：把 MinerU 的句子（O 化）直接丢进 OXR 同页**原始文本**里搜索 ——
 * 搜得到才说明 OXR 侧确实写的是 `O`；若 OXR 也写成 `0` 则搜不到（正确排除）。
 *
 * 用法：npx tsx scripts/oxr-crosscheck.ts
 * 输出：data/oxr/crosscheck.md + data/oxr/crosscheck.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Blk {
  text?: string;
  bbox?: number[];
  kind?: string;
}
interface Snap {
  pages?: { blocks?: Blk[] }[];
}
interface OxrBlock {
  type?: string;
  content?: string;
  bbox?: number[];
}
interface OxrPage {
  page_size?: { w?: number; h?: number } | number[];
  blocks?: OxrBlock[];
}

/**
 * 卷对：**自动发现** `data/out/*-OXR`，配对同名的 MinerU 卷。
 * 原先硬编码两卷，扩样本时每次都要改代码 —— 改成扫描后，新跑一卷自动纳入。
 * 响应来源优先用 daily 落盘的 `<outDir>/oxr-response.json`（`--parser oxr` 会写），
 * 退回早期的 data/oxr/*.json。
 */
interface DocPair {
  name: string;
  mineru: string;
  oxr: string;
  response: string;
}

function discoverDocs(): DocPair[] {
  const outRoot = join("data", "out");
  if (!existsSync(outRoot)) return [];
  const pairs: DocPair[] = [];
  for (const dir of readdirSync(outRoot)) {
    if (!dir.endsWith("-OXR")) continue;
    const base = dir.slice(0, -4);
    if (!existsSync(join(outRoot, base, "stages.json"))) continue;
    const resp = join(outRoot, dir, "oxr-response.json");
    if (!existsSync(resp)) continue;
    pairs.push({ name: base, mineru: base, oxr: dir, response: resp });
  }
  return pairs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

const DOCS = discoverDocs();

/** 归一化：去空白与常见标点，用于跨源文本比对 */
function norm(s: string): string {
  return s
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。、；：？！,.;:?!"'“”‘’（）()【】\[\]·]/g, "");
}

interface OxrPageInfo {
  text: string;
  captions: { text: string; bbox: number[] }[];
  /** 光栅像素 → pt 的缩放（以纸宽 596pt 为锚） */
  scale: number;
}

/** 从 OXR 原始响应取每页文本与 caption（快照会重排行，故用原始响应判类型） */
function oxrPages(responsePath: string): OxrPageInfo[] {
  const raw = JSON.parse(readFileSync(responsePath, "utf8")) as {
    data?: { result?: { outputs?: { json?: { pages?: OxrPage[] } } } };
    result?: { outputs?: { json?: { pages?: OxrPage[] } } };
    pages?: OxrPage[];
  };
  const pages =
    raw.data?.result?.outputs?.json?.pages ?? raw.result?.outputs?.json?.pages ?? raw.pages ?? [];
  const out: OxrPageInfo[] = [];
  for (const p of pages) {
    const all: string[] = [];
    const caps: { text: string; bbox: number[] }[] = [];
    const ps = p.page_size;
    const w = Array.isArray(ps) ? Number(ps[0]) : Number((ps as { w?: number })?.w);
    for (const b of p.blocks ?? []) {
      const t = String(b.content ?? "");
      if (t.trim().length === 0) continue;
      all.push(t);
      const type = String(b.type ?? "").toLowerCase();
      if (type === "caption" || type === "figure_caption") {
        caps.push({ text: t.trim(), bbox: Array.isArray(b.bbox) ? b.bbox : [] });
      }
    }
    out.push({ text: norm(all.join("")), captions: caps, scale: w > 0 ? 596 / w : 1 });
  }
  return out;
}

/** 两个 bbox 是否相交（面积 > 0） */
function intersects(a: number[], b: number[] | undefined): boolean {
  if (!b || b.length < 4 || a.length < 4) return false;
  const [ax0 = 0, ay0 = 0, ax1 = 0, ay1 = 0] = a;
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = b;
  return Math.min(ax1, bx1) > Math.max(ax0, bx0) && Math.min(ay1, by1) > Math.max(ay0, by0);
}

interface Candidate {
  doc: string;
  page: number;
  kind: "O2ZERO" | "CAPTION_MISSING";
  mineru: string;
  oxr: string;
  note: string;
}

const report: Candidate[] = [];
const summary: { doc: string; o2zero: number; caption: number; capTotal: number; matched: number }[] = [];

for (const pair of DOCS) {
  const mPath = join("data", "out", pair.mineru, "stages.json");
  const oPath = join("data", "out", pair.oxr, "stages.json");
  if (!existsSync(mPath) || !existsSync(oPath) || !existsSync(pair.response)) {
    console.log(`跳过 ${pair.name}：缺文件`);
    continue;
  }
  const m = JSON.parse(readFileSync(mPath, "utf8")) as Snap;
  const oxr = oxrPages(pair.response);
  let o2zero = 0;
  let caption = 0;
  let capTotal = 0;
  let matched = 0;

  for (const [pi, mPage] of (m.pages ?? []).entries()) {
    const info = oxr[pi];
    const oxrPage = info?.text ?? "";

    // ---- A 类：MinerU 把字母 O 读成数字 0 ----
    for (const mb of mPage.blocks ?? []) {
      const mt = mb.text ?? "";
      if (!/[0０][点角]/.test(mt)) continue;
      // 把 MinerU 的句子 O 化后，直接去 OXR **原始**文本里找
      // ⇒ 找得到 = OXR 侧写的就是字母 O；找不到 = OXR 也写成 0（不算差异）
      const probe = norm(mt).replace(/[0０]/g, "O");
      if (probe.length < 4) continue;
      const at = /O[点角]/.exec(probe);
      let hit = oxrPage.includes(probe);
      if (!hit && at) {
        // 整句可能因标点差异找不到 ⇒ 退一步用该字符前后各 6 字的片段
        const frag = probe.slice(Math.max(0, at.index - 6), Math.min(probe.length, at.index + 7));
        hit = frag.length >= 8 && oxrPage.includes(frag);
      }
      if (!hit) continue;
      matched++;
      o2zero++;
      report.push({
        doc: pair.name,
        page: pi + 1,
        kind: "O2ZERO",
        mineru: mt.slice(0, 90),
        oxr: "（OXR 同页文本含该句的字母 O 版）",
        note: "MinerU 侧 `0点/0角`，OXR 同句写字母 O ⇒ 高置信错读",
      });
    }

    // ---- B 类：OXR 判定为图注，而 MinerU 在**同一区域**没有任何文本 ----
    // ⚠️ 不能用「全页文本里有没有这几个字」判：图注多为单字（甲/乙/丙），整页文本里
    // 几乎必然出现（别的题的甲乙），会得出「0 缺失」的假结论（第一版实测正是 0）。
    // 故按**区域**判：把 OXR caption 的 bbox 缩放到 pt，看 MinerU 同页哪些块与之相交。
    const mBlocks = m.pages?.[pi]?.blocks ?? [];
    for (const cap of info?.captions ?? []) {
      const c = norm(cap.text);
      if (c.length === 0 || c.length > 12) continue;
      // 单拉丁字母（A/B/C/D）是**选项键**，不是图注 —— 实测多卷都出现这类假候选，
      // 必须在这里排除，否则图注候选数会被虚高（build-corrections 的中文过滤也拦住了它，
      // 这里保持同一口径，避免两份报告数字对不上）。
      if (/^[A-Za-z]$/.test(c)) continue;
      capTotal++;
      const boxPt = cap.bbox.map((v) => v * (info?.scale ?? 1));
      const occupied = mBlocks.some(
        (mb) => intersects(boxPt, mb.bbox) && (mb.text ?? "").trim().length > 0,
      );
      if (occupied) continue;
      caption++;
      report.push({
        doc: pair.name,
        page: pi + 1,
        kind: "CAPTION_MISSING",
        mineru: "（该区域在 MinerU 里没有文本块）",
        oxr: cap.text.slice(0, 40),
        note: "OXR Caption 类型读出，MinerU 同区域无内容 ⇒ 候选补入，须回原卷核对",
      });
    }
  }

  summary.push({ doc: pair.name, o2zero, caption, capTotal, matched });
}

const lines: string[] = [];
lines.push("# 两源交叉核对差异报告（MinerU vs OXR）");
lines.push("");
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push("");
lines.push("> **本报告只列候选，不改写任何数据。** 改写须走独立决策；遵守「检测不改写」红线。");
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push("| 卷 | A 类 O→0 候选 | B 类图注候选 | OXR caption 总数 |");
lines.push("|---|---:|---:|---:|");
for (const s of summary) lines.push(`| ${s.doc} | **${s.o2zero}** | ${s.caption} | ${s.capTotal} |`);
lines.push("");
lines.push("### 判据");
lines.push("");
lines.push("**A 类**（MinerU 把字母 O 读成数字 0）：");
lines.push("1. MinerU 块文本命中 `[0０][点角]`（错误模式来自 HANDOFF §6-13，曾用第二套 OCR 独立核对）；");
lines.push("2. 把该句的 `0/０` 换成 `O` 后，能在 OXR **同页原始文本**里找到（整句或用该字符前后 6 字片段）。");
lines.push("   ⇒ 找得到说明 OXR 侧确实写的是字母 O；若 OXR 也写成 0 则找不到，自动排除。");
lines.push("");
lines.push("**B 类**（图注缺失，§6-14 双漏）：");
lines.push("1. 取 OXR **原始响应**里 `Caption` / `figure_caption` 类型的块（不靠「短文本」猜类型）；");
lines.push("2. 该内容在 MinerU 同页文本里**完全不存在**。");
lines.push("");
lines.push("⚠️ **匹配不能用 bbox**：实测两版行级切点完全不同（MinerU 一行一块、OXR 按宽度重折），");
lines.push("同位置最近块距离 34.5pt ≈ 跨三行，匹配到的不是同一句 —— 第一版按 bbox 匹配得出");
lines.push("「O→0 候选 0」的错误结论，改用文本上下文匹配后才对得上。");
lines.push("");

for (const kind of ["O2ZERO", "CAPTION_MISSING"] as const) {
  const items = report.filter((r) => r.kind === kind);
  lines.push(`## ${kind === "O2ZERO" ? "A 类：字母 O 被读成数字 0" : "B 类：图注缺失候选"}（${items.length} 条）`);
  lines.push("");
  if (items.length === 0) {
    lines.push("（无）");
    lines.push("");
    continue;
  }
  lines.push("| 卷 | 页 | MinerU 原文 | OXR | 说明 |");
  lines.push("|---|---:|---|---|---|");
  for (const it of items.slice(0, 80)) {
    const esc = (s: string) => s.replace(/\|/g, "\\|");
    lines.push(`| ${esc(it.doc)} | ${it.page} | ${esc(it.mineru)} | ${esc(it.oxr)} | ${esc(it.note)} |`);
  }
  if (items.length > 80) lines.push(`| … | | | | 另有 ${items.length - 80} 条，见 JSON |`);
  lines.push("");
}

writeFileSync(join("data", "oxr", "crosscheck.md"), lines.join("\n"));
writeFileSync(join("data", "oxr", "crosscheck.json"), JSON.stringify(report, null, 1));

console.log("汇总：");
for (const s of summary) {
  console.log(`  ${s.doc}：O→0 候选 ${s.o2zero}｜图注候选 ${s.caption}（OXR caption 共 ${s.capTotal}）`);
}
console.log(`✓ data/oxr/crosscheck.md（${report.length} 条候选）`);
