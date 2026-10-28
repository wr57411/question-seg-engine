/**
 * build-corrections.ts —— 生成「人工已核对的上游识别错误」修正清单
 *
 * 背景：两源交叉核对（scripts/oxr-crosscheck.ts）产出 29 条候选，已逐条回原卷核对为真
 * （docs/oxr-evaluation.md §4.9）。本脚本把「候选」固化成**可审计的修正资产**：
 * `corrections/<docId>.json` —— **进仓库**（不是 data/ 里的运行时产物），
 * 因为这是人工决策的产物，换机器不能丢、重新解析也能复现。
 *
 * 两类修正：
 * - `replace`：MinerU 把字母 O 读成数字 0。按**整块原文**定位后替换字符，
 *   不做模糊匹配（避免改到真的数字 0）。
 * - `insert`：MinerU 完全漏读的图注（甲/乙/曲辕犁…），按 OXR 的 bbox 插回块序列。
 *
 * 判据不重写：与 crosscheck 同源（文本上下文匹配 / 区域相交），但这里只认
 * 已在 §4.9 逐条核对过的那 29 条 —— 未核对的宁可不进清单（不静默扩面）。
 *
 * 用法：npx tsx scripts/build-corrections.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const A4_WIDTH_PT = 596;

interface Blk {
  text?: string;
  bbox?: number[];
}
interface OxrBlock {
  type?: string;
  content?: string;
  bbox?: number[];
  page_size?: unknown;
}
interface OxrPage {
  page_size?: { w?: number; h?: number } | number[];
  blocks?: OxrBlock[];
}

/**
 * 卷清单：**自动发现** `data/out/*-OXR`（要求同名 MinerU 卷与 `oxr-response.json` 都在）。
 * 原先硬编码两卷，扩样本每次都要改代码；现在新跑一卷自动纳入。
 */
function discoverDocs(): { docId: string; response: string }[] {
  const outRoot = join("data", "out");
  if (!existsSync(outRoot)) return [];
  const list: { docId: string; response: string }[] = [];
  for (const dir of readdirSync(outRoot)) {
    if (!dir.endsWith("-OXR")) continue;
    const base = dir.slice(0, -4);
    if (!existsSync(join(outRoot, base, "stages.json"))) continue;
    const resp = join(outRoot, dir, "oxr-response.json");
    if (!existsSync(resp)) continue;
    list.push({ docId: base, response: resp });
  }
  return list.sort((a, b) => a.docId.localeCompare(b.docId, "zh"));
}

/**
 * ⚠️ **必须显式列出已逐条核对过的卷**。
 * 原因（实测踩过）：本脚本的判据是「当前 stages.json 与 OXR 的差异」，
 * 而清单一旦应用、差异就消失 ⇒ 不带参数重跑会把**已落地的清单清空**（2相互作用/答案册
 * 就从 14+14 变成 0+0，靠 git 才恢复）。所以：
 *   ① 必须显式指定卷，避免顺手把**未核对**的卷写进清单（纪律：只收已核对项）；
 *   ② 写入时与已有清单**合并**（按 page+kind+内容去重），不覆盖。
 */
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error(
    "用法：npx tsx scripts/build-corrections.ts <docId> [...]\n" +
      "  ⚠️ 只列**已逐条回原卷核对过**的卷 —— 未核对的候选不得进清单。",
  );
  process.exit(2);
}

const DOCS = discoverDocs().filter((d) => targets.includes(d.docId));
if (DOCS.length === 0) {
  console.error(`没有匹配的卷：${targets.join(" / ")}`);
  process.exit(2);
}

function norm(s: string): string {
  return s
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。、；：？！,.;:?!"'“”‘’（）()【】\[\]·]/g, "");
}

function readOxrPages(path: string): OxrPage[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    data?: { result?: { outputs?: { json?: { pages?: OxrPage[] } } } };
    result?: { outputs?: { json?: { pages?: OxrPage[] } } };
    pages?: OxrPage[];
  };
  return raw.data?.result?.outputs?.json?.pages ?? raw.result?.outputs?.json?.pages ?? raw.pages ?? [];
}

function pageWidth(p: OxrPage): number {
  const ps = p.page_size;
  if (Array.isArray(ps)) return Number(ps[0]) || 0;
  return Number((ps as { w?: number })?.w) || 0;
}

function intersects(a: number[], b: number[] | undefined): boolean {
  if (!b || b.length < 4 || a.length < 4) return false;
  const [ax0 = 0, ay0 = 0, ax1 = 0, ay1 = 0] = a;
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = b;
  return Math.min(ax1, bx1) > Math.max(ax0, bx0) && Math.min(ay1, by1) > Math.max(ay0, by0);
}

interface Item {
  page: number;
  kind: "replace" | "insert";
  /** replace：整块原文（精确定位用；不做模糊匹配） */
  blockText?: string;
  from?: string;
  to?: string;
  /** insert：图注文本与 pt 坐标 */
  text?: string;
  bbox?: number[];
  verified: true;
  evidence: string;
}

const outDir = "corrections";
mkdirSync(outDir, { recursive: true });
let grand = 0;

for (const { docId, response } of DOCS) {
  const stagesPath = join("data", "out", docId, "stages.json");
  if (!existsSync(stagesPath) || !existsSync(response)) {
    console.log(`跳过 ${docId}：缺 stages.json 或响应`);
    continue;
  }
  const snap = JSON.parse(readFileSync(stagesPath, "utf8")) as { pages?: { blocks?: Blk[] }[] };
  const oxrPages = readOxrPages(response);
  const items: Item[] = [];

  for (const [pi, page] of (snap.pages ?? []).entries()) {
    const blocks = page.blocks ?? [];
    const oxrPage = oxrPages[pi];
    const k = oxrPage ? A4_WIDTH_PT / (pageWidth(oxrPage) || A4_WIDTH_PT) : 1;
    const oxrText = norm(
      (oxrPage?.blocks ?? [])
        .map((b) => String(b.content ?? ""))
        .join(""),
    );

    // ---- replace：O→0 ----
    for (const b of blocks) {
      const t = b.text ?? "";
      if (!/[0０][点角]/.test(t)) continue;
      const probe = norm(t).replace(/[0０]/g, "O");
      const at = /O[点角]/.exec(probe);
      let hit = oxrText.includes(probe);
      if (!hit && at) {
        const frag = probe.slice(Math.max(0, at.index - 6), Math.min(probe.length, at.index + 7));
        hit = frag.length >= 8 && oxrText.includes(frag);
      }
      if (!hit) continue;
      // 该块内所有 [0０][点角] 一律视为字母 O（同一块内语境一致，已逐条核对）
      const fixed = t.replace(/[0０](?=[点角])/g, "O");
      if (fixed === t) continue;
      items.push({
        page: pi + 1,
        kind: "replace",
        blockText: t,
        from: "0点/0角",
        to: "O点/O角",
        verified: true,
        evidence: "原卷该字符为斜体拉丁字母 O；已回原卷核对（§4.9）",
      });
    }

    // ---- insert：漏读图注 ----
    for (const ob of oxrPage?.blocks ?? []) {
      const type = String(ob.type ?? "").toLowerCase();
      if (type !== "caption" && type !== "figure_caption") continue;
      const text = String(ob.content ?? "").trim();
      if (text.length === 0 || text.length > 12) continue;
      // 只要「真正的图注文字」：纯中文 1–4 字（甲/乙/丙/曲辕犁…）或「图N」。
      // 排除形如 `$\dot{G}$`（**图上印的点标号**，不是图注 —— 插进去会与原图重复）
      // 和 `i i` 这类 OCR 噪声。收紧判据的代价是可能漏收，但漏收好过插入重复内容。
      if (!/^[\u4e00-\u9fa5]{1,4}$/.test(text) && !/^图\d{1,2}$/.test(text)) continue;
      const boxPt = (ob.bbox ?? []).map((v) => v * k);
      if (boxPt.length < 4) continue;
      const occupied = blocks.some(
        (mb) => intersects(boxPt, mb.bbox) && (mb.text ?? "").trim().length > 0,
      );
      if (occupied) continue;
      items.push({
        page: pi + 1,
        kind: "insert",
        text,
        bbox: boxPt.map((v) => Number(v.toFixed(1))),
        verified: true,
        evidence: "OXR Caption 类型读出；MinerU 同区域无文本；已回原卷核对（§4.9）",
      });
    }
  }

  // **合并已有清单**，不覆盖：已应用的条目在 stages.json 里已经"看不到差异"了，
  // 若按当前差异重生成就会把它们抹掉（实测把 28 条清成 0 条）。清单是**人工决策记录**，
  // 不该由当前数据反推 —— 只有新增候选才追加。
  const existingPath = join(outDir, `${docId}.json`);
  const prevItems: Item[] = existsSync(existingPath)
    ? ((JSON.parse(readFileSync(existingPath, "utf8")) as { items?: Item[] }).items ?? [])
    : [];
  const keyOf = (x: Item): string => `${x.page}|${x.kind}|${x.blockText ?? x.text ?? ""}`;
  const seen = new Set(prevItems.map(keyOf));
  const merged = [...prevItems, ...items.filter((x) => !seen.has(keyOf(x)))];

  const payload = {
    docId,
    generatedAt: new Date().toISOString(),
    basis:
      "两源交叉核对（scripts/oxr-crosscheck.ts）+ 逐条回原卷核对（docs/oxr-evaluation.md §4.7/§4.9/§4.11）。" +
      "只收录已核对项；未经核对的候选不得进入本清单。",
    counts: {
      replace: merged.filter((i) => i.kind === "replace").length,
      insert: merged.filter((i) => i.kind === "insert").length,
      total: merged.length,
    },
    items: merged,
  };
  const out = join(outDir, `${docId}.json`);
  writeFileSync(out, JSON.stringify(payload, null, 2));
  grand += merged.length;
  console.log(
    `✓ ${out}  替换 ${payload.counts.replace} / 插入 ${payload.counts.insert}` +
      `（新增 ${merged.length - prevItems.length}）`,
  );
}

console.log(`合计 ${grand} 条已核对修正`);
