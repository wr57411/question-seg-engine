// scripts/formula-five-audit.ts
/**
 * 五方公式对照审计 —— **只报警、不改数据、不打接口**（2026-11-03）。
 *
 * ## 为什么是「五方」而不是「两方」
 *
 * `DECISIONS §106` 写着「三台机器源在公式上集体失明」。同一本《电路》把五家的原始结果摆在一起后，
 * 这句话**太粗**：失明的只有 MinerU 的**汉字下标**一类（410 条公式里 0 条含汉字，而纸面确实印着
 * 「保/总/出/内/外/电/热」，已用原卷裁图证过 3 处）；MiniCPM / VL / OXR 在同样这几条上都能读对。
 * 所以判「谁做得好」必须先按**类别**拆开，否则又会得到「集体失明」这种把不同病混成一病的结论。
 *
 * ## 归一化为什么是这套脚本的核心
 *
 * 各家 LaTeX 写法不同（`0.25\ A` vs `0.25\,A` vs `0 . 2 5`），直接字符串比会把**格式变体**
 * 误报成**识别分歧**——第一轮我就是这样把五方一致率算成 12% 的。`canonLatex()` 负责把格式差异
 * 抹平，只留结构差异；剩下的不一致才是值得回页图看的。
 *
 * ## 位置可核验性（`B-30` 的教训）
 *
 * `boxKind` 三档：`exact`（该条公式自带框，只有 StructureV3 / MinerU）> `block`（只有所在块框）
 * > `none`（整页级，只能靠文本命中）。**`none`/`block` 的行不许参与位置判据**，只能进内容对照；
 * 短碎片（`tiny`，归一化后 <6 字符）同理——`audit:pos` 实测 98.2% 的碎片无法用文本独立核验位置。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/formula-five-audit.ts                       # 默认《电路》（五源齐全的唯一一本）
 * npx tsx scripts/formula-five-audit.ts --doc "教材基础练 磁场"
 * npx tsx scripts/formula-five-audit.ts --review 30           # 出 30 行待原图核验清单（带裁图框）
 * ```
 *
 * 输入全部来自已落盘快照（`data/` 下，git 忽略）：MinerU `layout.json`、OXR `oxr-response.json`、
 * MiniCPM 异步结果、Paddle 作业 JSONL（`ocr-jobs/`，服务端原样返回）。缺哪个源就在报告里显式记
 * 「缺源」，**不猜、不用别本补**。
 *
 * 落盘：`data/out/<docId>/formula-five.csv`（逐条五列）+ `formula-five.md`（分类矩阵）
 * + `formula-five-review.json`（待核清单，含裁图参数）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocParsingJsonl, type PaddlePage } from "./paddle-client.js";

const ROOT = join(import.meta.dirname, "..");
const OUT_ROOT = join(ROOT, "data", "out");

/* ── 类型 ──────────────────────────────────────────────────────────────── */

export type Source = "mineru" | "vl" | "v3" | "minicpm" | "oxr";
export const SOURCES: readonly Source[] = ["mineru", "vl", "v3", "minicpm", "oxr"];
export type BoxKind = "exact" | "block" | "none";

export interface FormulaItem {
  src: Source;
  /** 0-based 页号（各家实测都是 0 基，见 `B-30` 的页序教训）。 */
  page: number;
  latex: string;
  /** 归一化到 0..1 的框；`null` = 该源给不出位置。 */
  norm: [number, number, number, number] | null;
  boxKind: BoxKind;
  score: number | null;
  inTable: boolean;
}

/* ── 纯函数：归一化与分类（可单测） ───────────────────────────────────── */

/** 抹平格式差异，只留结构差异。**不做**语义判断（不判对错）。 */
export function canonLatex(s: string): string {
  let t = s;
  // 装饰性命令：只影响排版，不影响内容
  // 命令名以「后面不是字母」结束（`\b` 在 `\times10^{18}` 这种紧跟数字的场合不成立，实测踩过）
  t = t.replace(/\\(?:left|right|mathrm|mathbf|mathit|mathsf|mathbb|operatorname|text|textrm)(?![a-zA-Z])/g, "");
  // 标点型命令（`\,` `\;` `\!` `\:` `\ `）后面**可以**紧跟字母，不能加字母否定预查；
  // 单词型命令（`\quad` `\hspace`）才需要，否则 `\quadA` 会被误剥。实测踩在前者上。
  t = t.replace(/\\[,;!: ]/g, "").replace(/\\(?:quad|qquad|space)(?![a-zA-Z])/g, "").replace(/\\hspace(?:\{[^}]*\})?/g, "");
  t = t.replace(/~+/g, "");
  // 语义别名
  const end = String.raw`(?![a-zA-Z])`;
  t = t.replace(new RegExp(String.raw`\\colon` + end, "g"), ":").replace(new RegExp(String.raw`\\cdot` + end, "g"), ".")
    .replace(new RegExp(String.raw`\\times` + end, "g"), "x")
    .replace(new RegExp(String.raw`\\div` + end, "g"), "/")
    .replace(new RegExp(String.raw`\\leq?` + end, "g"), "<=").replace(new RegExp(String.raw`\\geq?` + end, "g"), ">=");
  t = t.replace(/\\dfrac|\\tfrac/g, "\\frac");
  // 上标字符 ⇒ 幂形式（OXR 常直接印 ²）
  t = t.replace(/²/g, "^2").replace(/³/g, "^3").replace(/₁|₂|₃/g, "");
  // 题号/序号属于文本、不属于公式：`(2) I=U/R` 与 `I=U/R` 不是识别分歧（2026-11-03 原图核验发现）
  t = t.replace(/^[\\(（【]?\s*\d{1,2}\s*[)）】]\.?\s*/, "").replace(/^\s*[①②③⑤⑥⑦⑨]/, "");
  t = t.replace(/[;；,，]\s*\(?\d{1,2}\)?\s*$/, "");
  // 去掉所有空白、定界符与反斜杠（\frac 已在上一步统一）
  t = t.replace(/\s+/g, "");
  t = t.replace(/[{}()\\\[\]$]/g, "");
  // 全角标点 ⇒ 半角
  t = t.replace(/[（）]/g, (c) => (c === "（" ? "(" : ")")).replace(/[，、]/g, ",");
  // **不做 lowercase**：大小写在物理式里有意义（`UIt` vs `Ult`），归一会藏住真错。
  return t;
}

/** 按花括号深度取 `\\frac` 的两个参数；任一参数里还有 `\\frac` ⇒ 嵌套分式（各家最容易读丢层次的一类）。 */
export function hasNestedFrac(s: string): boolean {
  for (let i = s.indexOf("\\frac"); i >= 0; i = s.indexOf("\\frac", i + 1)) {
    let j = i + 5; const args: string[] = [];
    for (let k = 0; k < 2 && j < s.length; k++) {
      while (j < s.length && /\s/.test(s[j]!)) j += 1;
      if (s[j] !== "{") { j += 1; args.push(""); continue; }
      let depth = 1; let start = ++j;
      while (j < s.length && depth > 0) { if (s[j] === "{") depth += 1; else if (s[j] === "}") depth -= 1; j += 1; }
      args.push(s.slice(start, j - 1));
    }
    if (args.some((a) => a.includes("\\frac"))) return true;
  }
  return false;
}

const CJK = /[\u4e00-\u9fff]/;
/** 物理公式里几乎不该出现的映射产物 ⇒ 出现即「乱码嫌疑」（判据取严，只报警）。 */
const GARBLED = /\\(?:mathbb|scriptscriptstyle|textmu|Psi|Phi|downarrow|uparrow|widehat|widetilde|boldsymbol|nabla|triangledown|vert|Diamond|Box|parallel|stackrel|oplus|otimes|#)/;

export function classify(latex: string, canon: string, inTable: boolean): string[] {
  const tags: string[] = [];
  if (CJK.test(latex)) tags.push("cjk");
  if (/\\frac/.test(latex)) tags.push("frac");
  if (hasNestedFrac(latex)) tags.push("nested");
  if (inTable) tags.push("table");
  if (/\\(?:mathrm|text|,)?\s*(?:V|A|W|kg|Ω|\\Omega|m\/s|cm|mm|s)\b/.test(latex) || /\b(?:V|A|W|Ω)\s*$/.test(latex.trim())) tags.push("unit");
  if (GARBLED.test(latex)) tags.push("garbled");
  if (canon.length < 6) tags.push("tiny");
  return tags;
}

/** 归一化框的重叠（0..1，按较小面积归一）。 */
export function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return small > 0 ? inter / small : 0;
}

/** 从任意文本里抠出 `$...$` / `$$...$$`。 */
export function dollars(s: string): string[] {
  const out: string[] = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const t = (m[1] ?? m[2] ?? "").trim();
    if (t) out.push(t);
  }
  return out;
}

/* ── 五个源的抽取（全部读已落盘快照） ─────────────────────────────────── */

type Any = Record<string, unknown>;
const isObj = (v: unknown): v is Any => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function normOf(b: unknown, w: number, h: number): [number, number, number, number] | null {
  if (!Array.isArray(b) || b.length < 4 || !(w > 0) || !(h > 0)) return null;
  const [x0, y0, x1, y1] = b as [number, number, number, number];
  if (![x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [x0 / w, y0 / h, x1 / w, y1 / h];
}

/** MinerU `layout.json`：`inline_equation` span（逐条框 + score）+ 表格 `<eq>`。 */
export function extractMineru(json: unknown): FormulaItem[] {
  const out: FormulaItem[] = [];
  const pages = isObj(json) && Array.isArray(json.pdf_info) ? json.pdf_info : [];
  pages.forEach((pg, pi) => {
    const size = isObj(pg) && Array.isArray(pg.page_size) ? (pg.page_size as number[]) : [1, 1];
    const W = num(size[0]) ?? 1;
    const H = num(size[1]) ?? 1;
    const eqs: FormulaItem[] = [];
    const htmls: string[] = [];
    const walk = (o: unknown, inTable: boolean): void => {
      if (Array.isArray(o)) {
        for (const v of o) walk(v, inTable);
        return;
      }
      if (!isObj(o)) return;
      const isTbl = inTable || o.type === "table";
      if (o.type === "inline_equation" && typeof o.content === "string") {
        eqs.push({
          src: "mineru", page: pi, latex: o.content, norm: normOf(o.bbox, W, H),
          boxKind: Array.isArray(o.bbox) ? "exact" : "none",
          score: num(o.score), inTable,
        });
      }
      if (typeof o.html === "string") htmls.push(o.html);
      for (const v of Object.values(o)) walk(v, isTbl);
    };
    walk(pg, false);
    out.push(...eqs);
    for (const html of htmls) {
      for (const m of html.matchAll(/<eq>([\s\S]*?)<\/eq>/g)) {
        const t = (m[1] ?? "").trim();
        if (t) out.push({ src: "mineru", page: pi, latex: t, norm: null, boxKind: "none", score: null, inTable: true });
      }
    }
  });
  return out;
}

/** OXR `oxr-response.json`：块级 bbox + 块内容里的 `$..$`（OXR 常把汉字留在 `$` 外）。 */
export function extractOxr(json: unknown): FormulaItem[] {
  const out: FormulaItem[] = [];
  const pages = isObj(json) && Array.isArray(json.pages) ? json.pages : [];
  pages.forEach((pg, pi) => {
    if (!isObj(pg) || !Array.isArray(pg.blocks)) return;
    const ps = isObj(pg.page_size) ? pg.page_size : {};
    const W = num(ps.w) ?? 1;
    const H = num(ps.h) ?? 1;
    for (const raw of pg.blocks) {
      if (!isObj(raw) || typeof raw.content !== "string") continue;
      const inTable = raw.type === "Table";
      const box = normOf(raw.bbox, W, H);
      for (const t of dollars(raw.content)) {
        out.push({ src: "oxr", page: pi, latex: t, norm: box, boxKind: box ? "block" : "none", score: null, inTable });
      }
      // OXR 的非 $ 数学（`P电=UI`、`I²Rt`）也收，标 block，避免把「不包 LaTeX」误报成「漏公式」
      if (inTable) {
        for (const t of raw.content.match(/[^<>]*[=²][^<>]*/g) ?? []) {
          const s = t.trim();
          if (s.length >= 3 && s.length <= 60 && /[A-Za-zΩ]/.test(s) && !dollars(s).length) {
            out.push({ src: "oxr", page: pi, latex: s, norm: box, boxKind: box ? "block" : "none", score: null, inTable });
          }
        }
      }
    }
  });
  return out;
}

/** MiniCPM 异步结果：`pages[].ocr.blocks`（块框 + content）与整页 markdown 里的 `$..$`。 */
export function extractMinicpm(json: unknown): FormulaItem[] {
  const out: FormulaItem[] = [];
  const pages = isObj(json) && Array.isArray(json.pages) ? json.pages : [];
  pages.forEach((pg, pi) => {
    if (!isObj(pg)) return;
    const ocr = isObj(pg.ocr) ? pg.ocr : {};
    const W = num(ocr.image_width) ?? 1;
    const H = num(ocr.image_height) ?? 1;
    const blocks = Array.isArray(ocr.blocks) ? ocr.blocks : [];
    for (const raw of blocks) {
      if (!isObj(raw) || typeof raw.content !== "string") continue;
      const inTable = /<table/.test(raw.content);
      const box = normOf(raw.bbox, W, H);
      for (const t of dollars(raw.content)) {
        out.push({ src: "minicpm", page: pi, latex: t, norm: box, boxKind: box ? "block" : "none", score: null, inTable });
      }
    }
    const md = Array.isArray(pg.choices) && isObj(pg.choices[0]) && isObj(pg.choices[0].message)
      ? String(pg.choices[0].message.content ?? "") : "";
    for (const t of dollars(md)) {
      out.push({ src: "minicpm", page: pi, latex: t, norm: null, boxKind: "none", score: null, inTable: false });
    }
  });
  return dedupe(out);
}

/** Paddle 归一化页：V3 用逐条公式框；VL 只有块级 ⇒ 从块内容抠 `$..$` 挂块框。 */
export function extractPaddle(pages: PaddlePage[], src: "v3" | "vl"): FormulaItem[] {
  const out: FormulaItem[] = [];
  for (const pg of pages) {
    // 表内判定：V3 的 formula_res_list 不带 inTable，用表格块框包含关系补上
    const tableBoxes = pg.blocks.filter((b) => b.label === "table" && b.norm).map((b) => b.norm as [number, number, number, number]);
    const inTableBox = (n: [number, number, number, number] | null): boolean => {
      if (!n) return false;
      const cx = (n[0] + n[2]) / 2; const cy = (n[1] + n[3]) / 2;
      return tableBoxes.some((t) => t[0] <= cx && cx <= t[2] && t[1] <= cy && cy <= t[3]);
    };
    for (const f of pg.formulas) {
      const norm = f.norm ? ([f.norm[0], f.norm[1], f.norm[2], f.norm[3]] as [number, number, number, number]) : null;
      out.push({
        src, page: pg.page, latex: f.latex, norm,
        boxKind: norm ? "exact" : "none", score: null,
        inTable: src === "v3" ? inTableBox(norm) : false,
      });
    }
    for (const b of pg.blocks) {
      const inTable = b.label === "table";
      for (const t of dollars(b.content ?? "")) {
        out.push({ src, page: pg.page, latex: t, norm: b.norm ?? null, boxKind: b.norm ? "block" : "none", score: null, inTable });
      }
    }
    for (const tb of pg.tables) {
      for (const t of dollars(tb.html ?? "")) {
        out.push({ src, page: pg.page, latex: t, norm: null, boxKind: "none", score: null, inTable: true });
      }
    }
  }
  return dedupe(out);
}

function dedupe(items: FormulaItem[]): FormulaItem[] {
  const seen = new Set<string>();
  const out: FormulaItem[] = [];
  for (const it of items) {
    const k = `${it.page}|${canonLatex(it.latex)}|${it.norm ? it.norm.map((n) => Math.round(n * 200)).join(",") : "-"}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/* ── 槽位聚类：位置锚用逐条框，其余源按"同位变体"归队 ─────────────────
 *
 * 两条实测教训决定了这套结构：
 * ① 只有 MinerU span 与 StructureV3 `formula_res_list` 是**逐条框**，能当位置锚；
 *    VL/MiniCPM/OXR 只给块级框，拿它们做 IoU 聚类会把整页公式吸进一簇，
 *    产出「四家都是 I=q/t、V3 是 1/R总=…」这种假分歧（第一版就栽在这）。
 * ② 锚自己读错时，**读对的源会被算成"未命中"**——`P出=I²R=E²/((R−r)²/R+4r)` 那条，
 *    V3 丢了嵌套、MinerU/VL/MiniCPM/OXR 都读对，若拿 V3 的串当靶，四家全成"漏"。
 *    ⇒ 改成**变体聚类**：同位各家给的串先归堆，人多的一堆是多数，人少的才是离群。
 */

/** 三字符 Dice。只用于"这条是不是在说同一个式子"，不用于判对错。 */
export function dice(a: string, b: string, n = 3): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (x: string): string[] => (x.length < n ? [x] : Array.from({ length: x.length - n + 1 }, (_, i) => x.slice(i, i + n)));
  const A = new Set(grams(a)); const B = new Set(grams(b));
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

export interface Cell {
  latex: string;
  canon: string;
  score: number | null;
  /** 可核验性三档：`hard`=该家自己有逐条框（MinerU/V3）；`block`=串来自**包含锚点的那个块**
   *  （位置可核验到块一级）；`page`=整页文本里挑最像的（**位置不可核验，不计入错误率分母**）。 */
  via: "hard" | "block" | "page";
}

export interface Variant { canon: string; latex: string; srcs: Source[] }

export interface Row {
  id: number;
  page: number;
  /** 逐条框（归一化）——只有它才允许参与位置判据。 */
  norm: [number, number, number, number] | null;
  tags: string[];
  inTable: boolean;
  cells: Record<Source, Cell | null>;
  variants: Variant[];
  /** 基准写法（由**逐条框**的家定；pool 家不参与投票）。 */
  majority: string | null;
  /** 与基准不同串的家：`hard` 之间互斥，或 `pool` 归到别的串 ⇒ 都要回页图。 */
  outliers: Source[];
  /** 两个逐条框的家在同一位置互斥 ⇒ 最可信的一类待核信号（位置可比，不靠页级归队）。 */
  hardConflict: boolean;
  /** 各家切分粒度不同（一方包含另一方），已合并成一派 ⇒ 不算分歧。 */
  granularity: boolean;
}

const POOL_SOURCES: Source[] = ["mineru", "vl", "minicpm", "oxr"];

/** 一方是另一方的**连续片段**（切分边界不同）⇒ 不算识别分歧：页级串常比逐条锚宽。 */
export function spans(bigger: string, smaller: string): boolean {
  return smaller.length >= 3 && bigger.length > smaller.length && bigger.includes(smaller);
}

/** 逗号切分后的子集关系 ⇒ 同一条式子被切成几段（粒度差），不是识别分歧。 */
export function mergeable(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.split(",").filter(Boolean); const pb = b.split(",").filter(Boolean);
  const sub = (x: string[], y: string[]): boolean => x.length > 0 && x.every((p) => y.includes(p));
  return sub(pa, pb) || sub(pb, pa);
}

function boxCenterInside(n: [number, number, number, number], t: [number, number, number, number]): boolean {
  const cx = (n[0] + n[2]) / 2; const cy = (n[1] + n[3]) / 2;
  return t[0] <= cx && cx <= t[2] && t[1] <= cy && cy <= t[3];
}

/** 位置锚 + 页级归队 ⇒ 每个槽位一行，含变体聚类结果。 */
export function anchorRows(all: FormulaItem[], iouMin = 0.25, diceMin = 0.5): Row[] {
  const exact = all.filter((i) => i.boxKind === "exact" && i.norm);
  interface Cluster { page: number; norm: [number, number, number, number]; items: FormulaItem[] }
  const clusters: Cluster[] = [];
  for (const it of exact) {
    let hit: Cluster | null = null;
    for (const c of clusters) {
      if (c.page !== it.page || !it.norm) continue;
      if (overlap(c.norm, it.norm) >= iouMin) { hit = c; break; }
    }
    if (hit) hit.items.push(it);
    else clusters.push({ page: it.page, norm: it.norm!, items: [it] });
  }
  clusters.sort((x, y) => x.page - y.page || x.norm[1] - y.norm[1] || x.norm[0] - y.norm[0]);

  // 页级池：非逐条框的条目（含 MinerU 的表内 <eq>）
  const pool = new Map<string, FormulaItem[]>();
  for (const it of all) {
    if (it.boxKind === "exact") continue;
    const k = `${it.src}:${it.page}`;
    pool.set(k, [...(pool.get(k) ?? []), it]);
  }
  const tableBoxes = new Map<number, [number, number, number, number][]>();
  for (const it of all) {
    if (it.inTable && it.norm) {
      tableBoxes.set(it.page, [...(tableBoxes.get(it.page) ?? []), it.norm]);
    }
  }

  const rows: Row[] = [];
  clusters.forEach((c, i) => {
    const cells = {} as Record<Source, Cell | null>;
    for (const s of SOURCES) cells[s] = null;
    for (const s of ["mineru", "v3"] as const) {
      const its = c.items.filter((x) => x.src === s);
      if (!its.length) continue;
      const longest = its.reduce((x, y) => (y.latex.length > x.latex.length ? y : x));
      cells[s] = { latex: its.map((x) => x.latex).join(" "), canon: canonLatex(longest.latex), score: its.map((x) => x.score).find((v): v is number => v !== null) ?? null, via: "hard" };
    }
    const seeds = [cells.mineru?.canon, cells.v3?.canon].filter(Boolean) as string[];
    if (!seeds.length) return;
    for (const s of POOL_SOURCES) {
      if (cells[s]) continue;
      const cand = pool.get(`${s}:${c.page}`) ?? [];
      const cx = (c.norm[0] + c.norm[2]) / 2; const cy = (c.norm[1] + c.norm[3]) / 2;
      // 块包含锚点 ⇒ 位置可核验到块一级；否则只能算页级猜（via=page）
      const contains = (it: FormulaItem): boolean =>
        !!it.norm && it.norm[0] <= cx && cx <= it.norm[2] && it.norm[1] <= cy && cy <= it.norm[3];
      let best: FormulaItem | null = null; let bestD = 0; let bestBlock = false;
      for (const it of cand) {
        const cn = canonLatex(it.latex);
        if (!cn) continue;
        // 包含关系要有长度门槛：单字符 canon 会"包含"在任何长串里 ⇒ 假命中
        const match = (sd: string): number => {
          const short = Math.min(sd.length, cn.length); const long = Math.max(sd.length, cn.length);
                const contained = mergeable(sd, cn) || spans(sd, cn) || (short >= 4 && short >= 0.35 * long && (sd.includes(cn) || cn.includes(sd)));
          return contained ? 1 : dice(cn, sd);
        };
        const d = Math.max(...seeds.map(match));
        // 同分时"块包含锚点"优先（先按包含关系再按相似度换掉当前最优）
        const itBlock = contains(it);
        if (d > bestD || (d === bestD && itBlock && !bestBlock)) { bestD = Math.max(d, bestD); best = it; bestBlock = itBlock; }
      }
      if (best && bestD >= diceMin) {
        cells[s] = { latex: best.latex, canon: canonLatex(best.latex), score: null, via: bestBlock ? "block" : "page" };
      }
    }
    // 变体归堆。**只有逐条框（hard）的家能定多数派**：页级归队可能把邻格公式挂进来
    // （实测 `910 Ω` 那格：MinerU/MiniCPM 给 910 却被判离群，VL/OXR 给 900 反成多数）
    // ⇒ hard 定基准，pool 只标 hit / span（切分宽窄）/ diff（异文，需页图）/ absent。
    // 归堆成"阵营"：同一式子被切宽切窄（mergeable / spans）算同一阵营，不算分歧。
    // **只有逐条框（hard）的家能开新阵营**；页级家若匹配不上任何阵营，单独记 `poolOnly`
    // （可能是它读错，也可能是归队挂错格 —— 两种都要回页图，工具不选边）。
    const hardSrc = (["mineru", "v3"] as Source[]).filter((x) => cells[x]?.via === "hard");
    const camps: Variant[] = [];
    const join = (cell: { latex: string; canon: string }, src: Source): boolean => {
      const g = camps.find((x) => x.canon === cell.canon);
      if (g) { if (!g.srcs.includes(src)) g.srcs.push(src); return true; }
      const m = camps.find((x) => mergeable(x.canon, cell.canon) || spans(x.canon, cell.canon) || spans(cell.canon, x.canon));
      if (m) {
        if (cell.canon.length > m.canon.length) { m.canon = cell.canon; m.latex = cell.latex; }
        if (!m.srcs.includes(src)) m.srcs.push(src);
        return true;
      }
      return false;
    };
    for (const src of hardSrc) {
      const cell = cells[src]!;
      if (!join(cell, src)) camps.push({ canon: cell.canon, latex: cell.latex, srcs: [src] });
    }
    let merged = camps.length > 1 ? false : hardSrc.length > 1;
    for (const src of SOURCES) {
      const cell = cells[src];
      if (!cell || cell.via === "hard") continue;
      const before = camps.length;
      if (!join(cell, src)) {
        // 0.9：再低就会把「嵌套分式 vs 读扁」这种真结构差并成一堆（实测 dice=0.80）
        const near = camps.find((x) => dice(x.canon, cell.canon) >= 0.9);
        if (near) { if (!near.srcs.includes(src)) near.srcs.push(src); merged = true; }
        else camps.push({ canon: cell.canon, latex: cell.latex, srcs: [src] });
      } else if (camps.length === before && cell.canon !== camps[0]?.canon) merged = true;
    }
    camps.sort((x, y) => y.srcs.length - x.srcs.length || y.canon.length - x.canon.length);
    const hardConflict = !!cells.mineru && !!cells.v3 && camps.some((g) => g.srcs.includes("mineru"))
      && camps.some((g) => g.srcs.includes("v3"))
      && camps.some((g) => g.srcs.includes("mineru") && g.srcs.includes("v3")) === false;
    const campsN = camps.length;
    const majority = campsN > 1 ? null : (camps[0]?.canon ?? null);
    const outliers: Source[] = campsN > 1 ? SOURCES.filter((x) => cells[x]) : [];
    const granularity = merged || (campsN === 1 && hardSrc.length === 2);
    const inTable = c.items.some((x) => x.inTable) || (tableBoxes.get(c.page) ?? []).some((t) => boxCenterInside(c.norm, t));
    const assignedLatex = SOURCES.map((s) => cells[s]?.latex ?? "").filter(Boolean).join(" ");
    const tags = classify(assignedLatex, camps[0]?.canon ?? "", inTable);
    rows.push({ id: i + 1, page: c.page, norm: c.norm, tags, inTable, cells, variants: camps, majority, outliers, hardConflict, granularity });
  });
  return rows;
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */

export interface ClassStat {
  cls: string; total: number;
  per: Record<Source, {
    hit: number; garbled: number; minority: number; scoreSum: number; scoreN: number;
    /** 该家自己给得出逐条公式框的格数 —— **唯一能做位置级判据的一档**。 */
    hardN: number;
    /** 串来自包含锚点的块（位置只能核到块一级）。 */
    blockN: number;
    /** 只有页级匹配的格数 —— **不进错误率分母**（匹配器会偏向挑到对的那个）。 */
    pageOnly: number;
  }>;
}

export function summarize(rows: Row[]): ClassStat[] {
  const classes = ["ALL", "cjk", "nested", "frac", "table", "unit", "garbled", "tiny"];
  return classes.map((cls) => {
    const set = cls === "ALL" ? rows : rows.filter((r) => r.tags.includes(cls));
    const per = {} as ClassStat["per"];
    for (const s of SOURCES) {
      let hit = 0; let garbled = 0; let minority = 0; let scoreSum = 0; let scoreN = 0; let hardN = 0; let blockN = 0; let pageOnly = 0;
      for (const r of set) {
        const c = r.cells[s];
        if (!c) continue;
        hit += 1;
        if (c.via === "page") pageOnly += 1; else if (c.via === "hard") hardN += 1; else blockN += 1;
        if (GARBLED.test(c.latex)) garbled += 1;
        if (c.score !== null) { scoreSum += c.score; scoreN += 1; }
        if (r.outliers.includes(s)) minority += 1;
      }
      per[s] = { hit, garbled, minority, scoreSum, scoreN, hardN, blockN, pageOnly };
    }
    return { cls, total: set.length, per };
  });
}

const SRC_CN: Record<Source, string> = {
  mineru: "MinerU", vl: "PaddleOCR-VL", v3: "StructureV3", minicpm: "MiniCPM", oxr: "OXR",
};

function clip(s: string, n: number): string {
  return s.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, n);
}

export function report(doc: string, rows: Row[], stats: ClassStat[], missing: string[]): string {
  const L: string[] = [];
  const conflicts = rows.filter((r) => r.outliers.length > 0);
  L.push(`# 五方公式对照：${doc}`, "");
  L.push(`> 由 \`scripts/formula-five-audit.ts\` 生成。**只报警、不改数据、不打接口**（输入全是 \`data/\` 下已落盘快照）。`);
  L.push(`>`);
  L.push(`> **位置锚**只有 MinerU span 与 StructureV3 逐条公式框；VL / MiniCPM / OXR 给不出逐条框，`);
  L.push(`> 按「同页 Dice≥0.6」归队到槽位（\`via=pool\`，**不参与位置判据**）。`);
  L.push(`> **本表不判谁对**：同位出现 ≥2 种写法就整行标待核，并列出各写法由谁持有。`);
  L.push(`> \`⚡\` = 两个**逐条框**的家（MinerU / StructureV3）在同一位置互斥 ⇒ 位置可比、最该先看；`);
  L.push(`> 只有一个逐条框家时，页级家（VL/MiniCPM/OXR）的异文**不能**判成它读错——归队本身可能挂错格。`);
  L.push(`> 一致判定走 \`canonLatex\`：抹平 \`\\\\,\` / \`\\\\ \` / \`\\\\text{}\` / 上标字符等格式差，只留结构差。`, "");
  if (missing.length) L.push(`**缺源**（未参与对照，不用别本补）：${missing.join("、")}`, "");

  L.push(`## 1. 分类矩阵`, "");
  L.push(`> 格 = \`命中/该类条数\`；\`✗n\` = 其中含可疑乱码符号；\`⚠n\` = 该家出现在待核行里。`);
  L.push(``, `| 类别 | 条数 | ${SOURCES.map((s) => SRC_CN[s]).join(" | ")} |`);
  L.push(`|---|---:|${SOURCES.map(() => "---:").join("|")}|`);
  for (const st of stats) {
    const cells = SOURCES.map((s) => {
      const p = st.per[s]!;
      const extra = [p.garbled ? `✗${p.garbled}` : "", p.minority ? `⚠${p.minority}` : ""].filter(Boolean).join(" ");
      return `${p.hit}/${st.total}${extra ? ` (${extra})` : ""}`;
    });
    L.push(`| ${st.cls} | ${st.total} | ${cells.join(" | ")} |`);
  }
  L.push("", `## 1b. 可核验性（**决定错误率能不能算**）`, "");
  L.push(`| 源 | 命中 | ①逐条框 hard | ②块包含锚点 block | ③只有页级 page（**不进分母**） |`, `|---|---:|---:|---:|---:|`);
  for (const s of SOURCES) {
    const st = stats[0]!.per[s]!;
    L.push(`| ${SRC_CN[s]} | ${st.hit} | ${st.hardN} | ${st.blockN} | ${st.pageOnly} |`);
  }
  L.push("", "> **① 才是真分母**：只有 MinerU 与 StructureV3 自带逐条公式框。",
    "> ② 只能核到「这个式子确实出现在包含该位置的那个块里」，块内第几条判不了。",
    "> ③ 是「整页里挑最像的串」，**匹配器天然偏向挑到对的那个** ⇒ 用它算错误率会系统性偏松，",
    "> 所以 VL / MiniCPM / OXR 的公式错误率**不能由本工具给**，只能由页图人工判定给（证据文档 §3）。", "");
  L.push("", `## 2. 分歧计数`, "");
  L.push(`- 位置锚槽位 **${rows.length}**；出现 ≥2 种写法（待核）：**${conflicts.length}** 条；`);
  L.push(`  其中 **两个逐条框家互斥（⚡）**：${rows.filter((r) => r.hardConflict).length} 条 —— 位置可比，优先看这些。`);
  L.push(`- 其中属**粒度差**（一方包含另一方，已合并）：**${rows.filter((r) => r.granularity).length}** 条 ⇒ 不当分歧。`);
  L.push(`- 五家同位全一致：**${rows.filter((r) => r.variants.length === 1 && r.outliers.length === 0).length}** 条。`, "");
  L.push(`### 各家出现在待核行的次数（**不是错误数**，错误数见页图核验表）`, "");
  L.push(`| 源 | 离群 | 缺该槽位 | 乱码 | 平均 score（只有 MinerU 带） |`, `|---|---|---|---|---|`);
  for (const s of SOURCES) {
    const st = stats[0]!.per[s]!;
    const miss = rows.length - st.hit;
    const avg = st.scoreN ? (st.scoreSum / st.scoreN).toFixed(3) : "—";
    L.push(`| ${SRC_CN[s]} | ${conflicts.filter((r) => r.outliers.includes(s)).length} | ${miss} | ${st.garbled} | ${avg} |`);
  }
  L.push("", `## 3. 待原图核验清单（前 30 条分歧；判定必须回页图，本表不判对错）`, "");
  L.push(`| # | 页 | 框(归一化) | 类别 | 多数派 | 离群家 | ${SOURCES.map((s) => SRC_CN[s]).join(" | ")} |`);
  L.push(`|---|---|---|---|---|---|${SOURCES.map(() => "---").join("|")}|`);
  for (const r of conflicts.slice(0, 30)) {
    const box = r.norm ? r.norm.map((n) => n.toFixed(3)).join(",") : "—";
    const per = SOURCES.map((s) => {
      const c = r.cells[s];
      if (!c) return "·";
      const mark = r.outliers.includes(s) ? "⚠" : "";
      return `${mark}${clip(c.latex, 26)}${c.via === "page" ? "〔位置不可核验〕" : ""}`;
    });
    L.push(`| ${r.id} | p${r.page + 1} | ${box} | ${r.tags.join(",") || "—"} | ${r.variants.length}派${r.hardConflict ? " ⚡" : ""} | ${r.outliers.map((o) => SRC_CN[o]).join(",")} | ${per.join(" | ")} |`);
  }
  L.push("", "> 裁图参数见 \`formula-five-review.json\`（\`page\` 0 基；\`norm\` 归一化；PDF 点 = norm × page_size_pt）。");
  return L.join("\n");
}

function csv(rows: Row[]): string {
  const head = ["id", "page", "x0", "y0", "x1", "y1", "tags", "inTable", "variants", "majority", "outliers",
    ...SOURCES.map((s) => `${s}_latex`), ...SOURCES.map((s) => `${s}_via`), ...SOURCES.map((s) => `${s}_score`)];
  const esc = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, r.page, ...(r.norm ?? ["", "", "", ""]), r.tags.join("|"), r.inTable, r.variants.length, r.variants[0]?.canon ?? "", r.outliers.join("|"),
      ...SOURCES.map((s) => r.cells[s]?.latex ?? ""),
      ...SOURCES.map((s) => r.cells[s]?.via ?? ""),
      ...SOURCES.map((s) => r.cells[s]?.score ?? ""),
    ].map(esc).join(","));
  }
  return lines.join("\n");
}

/* ── 输入解析 ─────────────────────────────────────────────────────────── */

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function findPaddleJsonl(dirs: string[], model: string): string | null {
  for (const d of dirs) {
    const jobDir = join(d, "ocr-jobs");
    if (!existsSync(jobDir)) continue;
    const hit = readdirSync(jobDir).filter((n) => n.startsWith(`${model}-`) && n.endsWith(".jsonl")).sort().pop();
    if (hit) return join(jobDir, hit);
  }
  return null;
}

function findMinicpm(docHint: string): string | null {
  const root = join(ROOT, "data", "archive");
  if (!existsSync(root)) return null;
  for (const day of readdirSync(root).sort().reverse()) {
    const dir = join(root, day, "minicpm-probe");
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((n) => /^async-.*\.json$/.test(n) && !n.includes("submit"));
    if (hit) return join(dir, hit);
  }
  void docHint;
  return null;
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main(argv: string[]): Promise<void> {
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const doc = flag("doc") ?? "物理_教材基础练 电路";
  const dirs = [join(OUT_ROOT, doc), join(OUT_ROOT, `${doc}-MinerU`)];
  const items: FormulaItem[] = [];
  const missing: string[] = [];
  const loaded: string[] = [];

  const mineruPath = [join(dirs[1]!, "layout.json"), join(dirs[0]!, "layout.json")].find((p) => existsSync(p));
  if (mineruPath) { items.push(...extractMineru(readJson(mineruPath))); loaded.push(`MinerU ← ${mineruPath}`); } else missing.push("MinerU");

  const oxrPath = [join(dirs[0]!, "oxr-response.json"), join(dirs[1]!, "oxr-response.json")].find((p) => existsSync(p));
  if (oxrPath) { items.push(...extractOxr(readJson(oxrPath))); loaded.push(`OXR ← ${oxrPath}`); } else missing.push("OXR");

  const mcPath = flag("minicpm") ?? findMinicpm(doc);
  if (mcPath && existsSync(mcPath)) { items.push(...extractMinicpm(readJson(mcPath))); loaded.push(`MiniCPM ← ${mcPath}`); } else missing.push("MiniCPM");

  for (const [src, model] of [["v3", "PP-StructureV3"], ["vl", "PaddleOCR-VL-1.6"]] as const) {
    const f = findPaddleJsonl(dirs.filter((d): d is string => !!d), model);
    if (f) {
      items.push(...extractPaddle(parseDocParsingJsonl(readFileSync(f, "utf8")), src));
      loaded.push(`${src} ← ${f}`);
    } else missing.push(src);
  }

  const rows = anchorRows(items);
  const stats = summarize(rows);
  const outDir = dirs[0]!;
  const nReview = Number(flag("review") ?? 30);
  writeFileSync(join(outDir, "formula-five.csv"), csv(rows), "utf8");
  writeFileSync(join(outDir, "formula-five.md"), report(doc, rows, stats, missing), "utf8");
  // 待核清单：同位冲突优先，其次"只有近似串"的行；每条带页(0 基)与归一化框，裁图脚本直接吃
  const review = rows.filter((r) => r.outliers.length > 0).slice(0, nReview)
    .map((r) => ({
      id: r.id, page: r.page, norm: r.norm, tags: r.tags, inTable: r.inTable,
      majority: r.variants[0]?.canon ?? null, outliers: r.outliers,
      variants: r.variants.map((v) => ({ canon: v.canon, latex: v.latex, srcs: v.srcs })),
      cells: Object.fromEntries(SOURCES.map((s) => [s, r.cells[s] ?? null])),
    }));
  writeFileSync(join(outDir, "formula-five-review.json"), JSON.stringify(review, null, 1), "utf8");

  console.log(`五方公式对照：${doc}`);
  for (const l of loaded) console.log(`  ${l}`);
  if (missing.length) console.log(`  缺源：${missing.join("、")}（不参与对照，不用别本补）`);
  console.log(`  位置锚槽位 ${rows.length}；有分歧(≥2 变体) ${rows.filter((r) => r.outliers.length > 0).length}；粒度差 ${rows.filter((r) => r.granularity).length}；待核清单 ${review.length}`);
  for (const st of stats.filter((s) => ["ALL", "cjk", "nested", "table", "unit"].includes(s.cls))) {
    console.log(`    ${st.cls.padEnd(7)} n=${String(st.total).padEnd(4)} ${SOURCES.map((s) => `${SRC_CN[s]}:${st.per[s]!.hit}${st.per[s]!.garbled ? `✗${st.per[s]!.garbled}` : ""}${st.per[s]!.minority ? `⚠${st.per[s]!.minority}` : ""}`).join("  ")}`);
  }
  console.log(`  落盘：${join(outDir, "formula-five.md")}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
