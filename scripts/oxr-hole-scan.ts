/**
 * oxr-hole-scan.ts —— 「解析遗漏」红框能补多少？纯只读分类扫描（不改任何数据）
 *
 * 背景（2026-10-28）：红框 = 原卷有墨迹但解析结果的块覆盖不到（`uncovered.kind === "content"`）。
 * 此前 `oxr-crosscheck.ts` 只查两类差异（O→0、图注 caption），**没查「整块漏读」**——
 * 于是这类洞一直红着。实测机械能 p11 那道题的 4 个选项（8 行）MinerU 一个块都没有，
 * 而 OXR 正好 8 个行块一一对应 ⇒ 这类**是可以补的**，但先要分清 142 个洞里哪些真能补。
 *
 * 分类（逐个洞看过两侧同位置的块之后）：
 * - `coverable`   MinerU 该区域**零块**、OXR 有行块 ⇒ 可补（最干净的一类）
 * - `partial`     MinerU 该区域**有块**、OXR 也有 ⇒ 可能部分覆盖，需逐行判重后才敢补
 * - `image`       两侧该区域有**图片块** ⇒ 图上印的字，OCR 本就不该读，**不该补**
 * - `no_oxr`      OXR 也没有 ⇒ 两源共同盲区，OXR 这条线解决不了
 * - `ocr_filled`  MinerU 侧该区域已有 OCR 补入块（`ocr: true`）⇒ 已被别处覆盖
 *
 * 用法：npx tsx scripts/oxr-hole-scan.ts
 * 输出：data/oxr/hole-scan.md（人读）+ hole-scan.json（机器用）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Blk {
  kind?: string;
  text?: string;
  bbox?: number[];
  img?: string;
  ocr?: boolean;
  correction?: boolean;
}
interface Snap {
  pages?: { blocks?: Blk[]; uncovered?: { kind?: string; bbox?: number[] }[] }[];
}

type Cat = "coverable" | "partial" | "image" | "no_oxr" | "ocr_filled";

interface Row {
  doc: string;
  page: number;
  y: number;
  cat: Cat;
  mineru: string;
  oxr: string;
}

const OUT_ROOT = join("data", "out");

function intersects(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  const [ax0 = 0, ay0 = 0, ax1 = 0, ay1 = 0] = a;
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = b;
  return Math.min(ax1, bx1) > Math.max(ax0, bx0) && Math.min(ay1, by1) > Math.max(ay0, by0);
}

const docs = existsSync(OUT_ROOT)
  ? readdirSync(OUT_ROOT).filter(
      (d) => !d.endsWith("-OXR") && existsSync(join(OUT_ROOT, d, "stages.json")) && existsSync(join(OUT_ROOT, `${d}-OXR`, "stages.json")),
    )
  : [];

const rows: Row[] = [];
const summary: { doc: string; holes: number; cats: Record<Cat, number> }[] = [];

for (const doc of docs) {
  const m = JSON.parse(readFileSync(join(OUT_ROOT, doc, "stages.json"), "utf8")) as Snap;
  const o = JSON.parse(readFileSync(join(OUT_ROOT, `${doc}-OXR`, "stages.json"), "utf8")) as Snap;
  const cats: Record<Cat, number> = { coverable: 0, partial: 0, image: 0, no_oxr: 0, ocr_filled: 0 };
  let holes = 0;

  for (const [pi, mp] of (m.pages ?? []).entries()) {
    const op = o.pages?.[pi];
    const mBlocks = mp.blocks ?? [];
    const oBlocks = op?.blocks ?? [];
    for (const h of mp.uncovered ?? []) {
      if (h.kind !== "content") continue;
      holes++;
      const box = h.bbox;
      const mHit = mBlocks.filter((b) => intersects(box, b.bbox));
      const oHit = oBlocks.filter((b) => intersects(box, b.bbox));
      const hasImage = mHit.some((b) => b.kind === "image") || oHit.some((b) => b.kind === "image");
      const hasOcr = mHit.some((b) => b.ocr === true);

      let cat: Cat;
      if (hasImage) cat = "image";
      else if (hasOcr) cat = "ocr_filled";
      else if (oHit.length === 0) cat = "no_oxr";
      else if (mHit.length === 0) cat = "coverable";
      else cat = "partial";

      cats[cat]++;
      rows.push({
        doc,
        page: pi + 1,
        y: Math.round(box?.[1] ?? 0),
        cat,
        mineru: mHit.map((b) => String(b.text ?? "")).join(" ").slice(0, 40) || "（无块）",
        oxr: oHit.map((b) => String(b.text ?? "")).join(" ").slice(0, 40) || "（无块）",
      });
    }
  }
  summary.push({ doc, holes, cats });
}

// ---- 输出 ----
const total: Record<Cat, number> = { coverable: 0, partial: 0, image: 0, no_oxr: 0, ocr_filled: 0 };
for (const s of summary) for (const k of Object.keys(total) as Cat[]) total[k] += s.cats[k];

const L: string[] = [];
L.push("# 解析遗漏（红框）能补多少 —— 分类扫描");
L.push("");
L.push(`生成时间：${new Date().toISOString()}`);
L.push("");
L.push("> **纯只读扫描，不改任何数据。** 用于判断「整块漏读」这类值不值得修、能修多少。");
L.push("");
L.push("## 分类口径");
L.push("");
L.push("| 类别 | 含义 | 该不该补 |");
L.push("|---|---|---|");
L.push("| `coverable` | MinerU 该区域**零块**、OXR 有行块 | ✅ 可补（最干净） |");
L.push("| `partial` | MinerU 有块、OXR 也有 | ⚠️ 可能部分覆盖，须逐行判重 |");
L.push("| `image` | 该区域有**图片块** | ❌ 图上印的字，不该补 |");
L.push("| `no_oxr` | OXR 也没有 | ❌ 两源共同盲区 |");
L.push("| `ocr_filled` | 已有 OCR 补入块 | ❌ 已被覆盖 |");
L.push("");
L.push("## 汇总");
L.push("");
L.push("| 卷 | 洞 | coverable | partial | image | no_oxr | ocr_filled |");
L.push("|---|---:|---:|---:|---:|---:|---:|");
for (const s of summary) {
  L.push(
    `| ${s.doc} | ${s.holes} | **${s.cats.coverable}** | ${s.cats.partial} | ${s.cats.image} | ${s.cats.no_oxr} | ${s.cats.ocr_filled} |`,
  );
}
L.push(
  `| **合计** | **${summary.reduce((a, b) => a + b.holes, 0)}** | **${total.coverable}** | ${total.partial} | ${total.image} | ${total.no_oxr} | ${total.ocr_filled} |`,
);
L.push("");
L.push("## 可补样本（coverable，前 40 条）");
L.push("");
const cov = rows.filter((r) => r.cat === "coverable");
if (cov.length === 0) L.push("（无）");
else {
  L.push("| 卷 | 页 | OXR 读到的内容 |");
  L.push("|---|---:|---|");
  for (const r of cov.slice(0, 40)) L.push(`| ${r.doc} | ${r.page} | ${r.oxr.replace(/\|/g, "\\|")} |`);
  if (cov.length > 40) L.push(`| … | | 另有 ${cov.length - 40} 条，见 JSON |`);
}
L.push("");
L.push("## partial 样本（需逐行判重，前 20 条）");
L.push("");
const par = rows.filter((r) => r.cat === "partial");
if (par.length === 0) L.push("（无）");
else {
  L.push("| 卷 | 页 | MinerU 已有 | OXR |");
  L.push("|---|---:|---|---|");
  for (const r of par.slice(0, 20)) {
    L.push(`| ${r.doc} | ${r.page} | ${r.mineru.replace(/\|/g, "\\|")} | ${r.oxr.replace(/\|/g, "\\|")} |`);
  }
}

writeFileSync(join("data", "oxr", "hole-scan.md"), L.join("\n"));
writeFileSync(join("data", "oxr", "hole-scan.json"), JSON.stringify(rows, null, 1));

console.log("分类结果：");
for (const s of summary) {
  console.log(`  ${s.doc}：洞 ${s.holes} → 可补 ${s.cats.coverable} / 部分 ${s.cats.partial} / 图 ${s.cats.image} / 两源皆无 ${s.cats.no_oxr} / OCR已补 ${s.cats.ocr_filled}`);
}
console.log(
  `合计：可补 ${total.coverable} · 部分 ${total.partial} · 图 ${total.image} · 两源皆无 ${total.no_oxr} · OCR已补 ${total.ocr_filled}`,
);
console.log("✓ data/oxr/hole-scan.md（明细）与 hole-scan.json");
