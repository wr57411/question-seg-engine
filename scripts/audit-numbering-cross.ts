// scripts/audit-numbering-cross.ts
/**
 * 题号行交叉核对（**只报警、不改数据**）—— `BACKLOG L-06` / `DECISIONS §99`。
 *
 * 背景（2026-10-31 实测）：MinerU 会把一整段题号连出处标注**认成残片** ——
 * 《机械能守恒》p7 原卷 `2 [人教版必修二 P94 第5题模型变式] 易错`，
 * `layout.json` 里只剩 `式易镜` 三个字；而项目自己的整页 OCR
 * (`ocr-page/p07.txt`) 该行**完整存在**。后果是该题整题丢失，还连带把后一题
 * （靠「= 上一题 + 1」认的黏连题号）一起挡掉。
 *
 * 现有的「OCR 补行」只补**墨迹未覆盖的洞**；此处墨迹已被残片占住 ⇒ 补行不介入。
 * 所以需要这条**独立核对通道**：逐页比对「整页 OCR 的题号行」与「layout 里的文字」。
 *
 * 判据（**与引擎不同源**：本脚本不 import `src/`）：
 * - **X1**：OCR 某页有题号行（`N[` / `N 年份 卷`），但 layout 同页找不到该行正文
 *   ⇒ 上游把这块认坏了（题号段整体或部分丢失）。
 * - 只报 X1。反向（layout 有、OCR 无）不报：OCR 自身也会漏，报了只会是噪声。
 *
 * 命中 ⇒ 打印清单；默认 **exit 0**（先观察量级，不卡门）。
 * 加 `--strict` ⇒ **exit 1**（供将来接入 `npm run check`）。
 *
 * 用法：
 *   npm run audit:numbering:cross
 *   npm run audit:numbering:cross -- --strict
 *   npm run audit:numbering:cross -- --root tmp/fixture    # 自检
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_ROOT = join("data", "out");
/** 同书的另一种解析副本 + 非文档目录：不重复报。 */
const SKIP_EXACT = new Set(["bank", "tags", "_tablecheck"]);
const SKIP_SUFFIX = /-(?:OXR|MinerU)$/;
/** 题号行：`1[人教版…]` / `2 2024 江西卷 [多选]…`；首数字 1–99，不认 `0`。 */
const Q_LINE = /^([1-9]\d{0,1})\s*(?:[\[［]|(?:19|20)\d{2}\s+\S{2,8}卷)/;
/**
 * 去掉行首的「题号 + 年份卷 + 任意多个方括号标签」，留下正文。
 * ⚠️ 必须用 lookahead 之外的独立剥离：早期版本把 `Q_LINE` 直接 replace 掉，
 * 连 `[` 一起吃掉，导致后续 `LABEL` 剥不掉标签，比对串变成
 * `粤教版必修一P121图4…`（实测误报《运动和力》p6 #3）—— 见本节注释下方 `bodyOf`。
 */
const PREFIX =
  /^\s*(?:[1-9]\d{0,1})?\s*(?:(?:19|20)\d{2}\s+\S{2,8}卷)?\s*(?:[\[［][^\]］]*[\]］]\s*)*/;

interface Hit {
  doc: string;
  page: number;
  number: string;
  ocrLine: string;
}

function parseArgs(argv: string[]): { root: string; strict: boolean } {
  let root = DEFAULT_ROOT;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
    if (argv[i] === "--strict") strict = true;
  }
  return { root, strict };
}

/** 归一化：只留汉字/字母/数字，去掉空白与标点 —— layout 与 OCR 的空白/标点必然不同。 */
function norm(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface LayoutPage {
  para_blocks?: { lines?: { spans?: { content?: string }[] }[] }[];
}
interface LayoutFile {
  pdf_info?: LayoutPage[];
}

function layoutPageText(lay: LayoutFile, pageIdx: number): string {
  const p = lay.pdf_info?.[pageIdx];
  if (!p) return "";
  const out: string[] = [];
  for (const b of p.para_blocks ?? []) {
    for (const l of b.lines ?? []) {
      for (const s of l.spans ?? []) out.push(s.content ?? "");
    }
  }
  return norm(out.join(""));
}

function layoutDocText(lay: LayoutFile): string {
  const out: string[] = [];
  for (const p of lay.pdf_info ?? []) {
    for (const b of p.para_blocks ?? []) {
      for (const l of b.lines ?? []) {
        for (const sp of l.spans ?? []) out.push(sp.content ?? "");
      }
    }
  }
  return norm(out.join(""));
}

function main(): void {
  const { root, strict } = parseArgs(process.argv.slice(2));
  if (!existsSync(root)) {
    console.error(`目录不存在：${root}`);
    process.exit(1);
  }

  const hits: Hit[] = [];
  let docs = 0;
  for (const name of readdirSync(root).sort()) {
    if (SKIP_EXACT.has(name) || SKIP_SUFFIX.test(name)) continue;
    const dir = join(root, name);
    const ocrDir = join(dir, "ocr-page");
    const lay = readJson<LayoutFile>(join(dir, "layout.json"));
    if (!lay || !existsSync(ocrDir)) continue;
    let reported = false;
    const docNorm = layoutDocText(lay);
    for (const f of readdirSync(ocrDir).sort()) {
      const m = /^p(\d+)\.txt$/.exec(f);
      if (!m) continue;
      const pageIdx = Number(m[1]) - 1;
      const text = readFileSync(join(ocrDir, f), "utf8");
      const pageNorm = layoutPageText(lay, pageIdx);
      const lines = text.split(/\r?\n/);
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!.trim();
        const q = Q_LINE.exec(line);
        if (!q) continue;
        // 比对正文：一次性剥掉题号 + 年份卷 + 全部前置标签，取前 12 字
        // （太短会假阳、太长会因折行假阴；12 字在实测中既能抓到"整段丢失"又不误报）。
        // ⚠️ 有些 OCR 行只有「题号 + 出处标签」，正文在**下一行**（实测《机械能守恒》p7 #2）
        // —— 那时 body 只剩「易错」两字，会被长度守卫跳过 ⇒ 必须拼下一行再判。
        let body = norm(line.replace(PREFIX, ""));
        if (body.length < 6) {
          // 拼**下一个非空行**（OCR 里题号行与正文之间常隔一个空行）
          let j = li + 1;
          while (j < lines.length && !lines[j]!.trim()) j++;
          body = norm(line.replace(PREFIX, "") + (lines[j] ?? "").trim());
        }
        body = body.slice(0, 12);
        if (body.length < 6) continue; // 正文太短无法判断，跳过（宁漏不误）
        // 先看本页；本页没有再看**整册**——跨页/折行会让正文落到别页，
        // 只比本页会把"跨页题"误报成"整段丢失"（实测 4/10 假阳即此因）。
        if (!pageNorm.includes(body) && !docNorm.includes(body)) {
          hits.push({ doc: name, page: pageIdx + 1, number: q[1] ?? "?", ocrLine: line.slice(0, 46) });
          reported = true;
        }
      }
    }
    if (reported) docs++;
  }

  console.log(`题号行交叉核对：扫描 ${root}`);
  console.log(`命中 X1（OCR 有题号行、layout 该页找不到正文）：**${hits.length}** 处，涉及 ${docs} 册\n`);
  for (const h of hits) {
    console.log(`  ${h.doc} · p${h.page} · #${h.number} | ${h.ocrLine}`);
  }
  if (hits.length === 0) console.log("  （无）");
  console.log(
    `\n说明：X1 = 上游把「题号 + 出处 + 正文」认坏了，该题可能整题丢失。` +
      `\n处置：回原卷页图核对（红线：检测不改写），确认后再决定是否补切。`,
  );
  if (strict && hits.length > 0) process.exit(1);
}

main();
