/**
 * build-body-corrections.ts —— 把「MinerU 整块漏读、OXR 读到了」的正文行补进修正清单
 *
 * 前置：`scripts/oxr-hole-scan.ts` 已跑过，确认有 `coverable` 类洞（MinerU 该区域**零块**、
 * OXR 有行块）。这一类是本轮之前**完全没覆盖**的第三类差异（前两类是 O→0 与图注）。
 *
 * ⚠️ 与图注补入的区别：
 * - 图注（`source: "caption"`）：插在图片块之后（图注跟着图）。
 * - 正文行（`source: "body-hole"`）：**按 bbox 的 y 位置插入**，否则会跑到某张图后面、错位。
 *
 * ⚠️ 诚实标注：这些条目 `verified: false` —— 它们经过「MinerU 零覆盖 + OXR 有行块」的
 * 双重判据，但**没有逐条回原卷核对**（75 条逐条核成本高）。落地后靠**页面验证**：
 * 红框应消失、文字应正确显示；抽样再回原卷。核对通过后再把 verified 改成 true。
 *
 * 用法：npx tsx scripts/build-body-corrections.ts <docId> [...]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Blk {
  kind?: string;
  text?: string;
  bbox?: number[];
  img?: string;
  ocr?: boolean;
}
interface Snap {
  pages?: { blocks?: Blk[]; uncovered?: { kind?: string; bbox?: number[] }[] }[];
}
interface Item {
  page: number;
  kind: "replace" | "insert";
  blockText?: string;
  text?: string;
  bbox?: number[];
  verified?: boolean;
  source?: "caption" | "body-hole";
  evidence?: string;
}

const OUT_ROOT = join("data", "out");

function intersects(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  const [ax0 = 0, ay0 = 0, ax1 = 0, ay1 = 0] = a;
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = b;
  return Math.min(ax1, bx1) > Math.max(ax0, bx0) && Math.min(ay1, by1) > Math.max(ay0, by0);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("用法：npx tsx scripts/build-body-corrections.ts <docId> [...]");
  process.exit(2);
}

let grand = 0;
for (const doc of targets) {
  const mPath = join(OUT_ROOT, doc, "stages.json");
  const oPath = join(OUT_ROOT, `${doc}-OXR`, "stages.json");
  const cPath = join("corrections", `${doc}.json`);
  if (!existsSync(mPath) || !existsSync(oPath)) {
    console.log(`跳过 ${doc}：缺 stages.json`);
    continue;
  }
  const m = JSON.parse(readFileSync(mPath, "utf8")) as Snap;
  const o = JSON.parse(readFileSync(oPath, "utf8")) as Snap;

  // 收集 coverable 洞对应的 OXR 行块（按 page|text|bbox 去重，避免多个洞命中同一块）
  const picked = new Map<string, Item>();
  for (const [pi, mp] of (m.pages ?? []).entries()) {
    const oBlocks = o.pages?.[pi]?.blocks ?? [];
    const mBlocks = mp.blocks ?? [];
    for (const h of mp.uncovered ?? []) {
      if (h.kind !== "content") continue;
      const box = h.bbox;
      const mHit = mBlocks.filter((b) => intersects(box, b.bbox));
      if (mHit.length > 0) continue; // 部分覆盖/图片/OCR 已补 —— 交给 hole-scan 分类，这里只收 coverable
      const oHit = oBlocks.filter(
        (b) => intersects(box, b.bbox) && b.kind === "text" && String(b.text ?? "").trim().length > 0,
      );
      for (const b of oHit) {
        const key = `${pi + 1}|${b.text}|${(b.bbox ?? []).join(",")}`;
        if (picked.has(key)) continue;
        picked.set(key, {
          page: pi + 1,
          kind: "insert",
          text: String(b.text ?? "").trim(),
          bbox: (b.bbox ?? []).map((v) => Number(v.toFixed(1))),
          verified: false,
          source: "body-hole",
          evidence:
            "MinerU 该区域零块（红框）+ OXR 有行块；未逐条回原卷核对，靠页面验证（红框消失 + 文字正确）",
        });
      }
    }
  }

  const items = [...picked.values()];
  if (items.length === 0) {
    console.log(`${doc}：无 coverable 洞`);
    continue;
  }

  // 合并进已有清单（按 page|kind|text|bbox 去重，不覆盖已核对项）
  const prev: Item[] = existsSync(cPath)
    ? ((JSON.parse(readFileSync(cPath, "utf8")) as { items?: Item[] }).items ?? [])
    : [];
  const keyOf = (x: Item): string => `${x.page}|${x.kind}|${x.text ?? x.blockText ?? ""}|${(x.bbox ?? []).join(",")}`;
  const seen = new Set(prev.map(keyOf));
  const merged = [...prev, ...items.filter((x) => !seen.has(keyOf(x)))];

  const payload = {
    docId: doc,
    generatedAt: new Date().toISOString(),
    basis: "两源交叉核对 + 逐条回原卷核对（caption/O→0）；正文漏读行为 hole-scan 判据（verified=false）",
    counts: {
      replace: merged.filter((i) => i.kind === "replace").length,
      insert: merged.filter((i) => i.kind === "insert").length,
      bodyHole: merged.filter((i) => i.source === "body-hole").length,
      total: merged.length,
    },
    items: merged,
  };
  writeFileSync(cPath, JSON.stringify(payload, null, 2));
  grand += merged.length - prev.length;
  console.log(`✓ ${cPath}  新增正文行 ${merged.length - prev.length}（总计 ${merged.length}，其中正文漏读 ${payload.counts.bodyHole}）`);
}
console.log(`合计新增 ${grand} 条`);
