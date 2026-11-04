// scripts/ocr-fill-jobs.ts
/**
 * 作业版补字「只读对照」：用 VL 字 + V3 行框，给每个洞算它该填什么字，
 * 再和**现状产线**（`ocr-page-fill.json`）在同一批洞上给过的候选逐条比。
 *
 * 目的只有一个：改产线前先回答两件事 ——
 * ① 新的对齐能不能覆盖更多洞（旧的靠"按宽度摊"，很多洞没补）；
 * ② 新旧两边都补了的洞，字是否一致（不一致的要能回页图看）。
 *
 * **不写任何产线文件**：输出 `data/out/<doc>/ocr-fill-jobs.json` + 控制台摘要。
 * 用法：npx tsx scripts/ocr-fill-jobs.ts --doc "物理_教材基础练 电路" [--v3-doc "..."]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaddlePage } from "./paddle-client.js";
import { alignBlockLines, matchChars } from "./paddle-line-align.js";

const ROOT = join(import.meta.dirname, "..");
type Box = [number, number, number, number];

const center = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const overlap = (a: Box, b: Box) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
};
const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

function loadPages(doc: string): PaddlePage[] {
  const dir = join(ROOT, "data", "out", doc, "ocr-jobs");
  const f = readdirSync(dir).find((n) => n.endsWith(".pages.json"));
  if (!f) throw new Error(`${dir} 没有 *.pages.json`);
  return JSON.parse(readFileSync(join(dir, f), "utf8")) as PaddlePage[];
}

interface Hole { page: number; bbox: Box; text?: string; accepted?: boolean }

export interface Cand {
  holeKey: string;
  lineKey: string;
  cov: number;
  text: string;
  kind: string;
}

/**
 * 洞 ↔ 行 的真实结构（2026-11-03 实测《电路》273 洞）：
 * **每个洞最多只对应 1 行**（217 个洞命中 1 行、56 个没命中、0 个跨行），
 * 但**一行常被 2–8 个洞碎片共用**（117 行里 47 行如此）。
 * ⇒ 正确的规则不是"1:1"（那会把碎片行的字丢掉），而是：
 * **洞只认一行；一行的字按它名下各洞的宽度切开分给碎片**（floor + 余数给宽者）。
 */
export function splitTextAmongHoles(
  text: string,
  holes: { holeKey: string; width: number }[],
): { holeKey: string; text: string }[] {
  if (holes.length === 0) return [];
  if (holes.length === 1) return [{ holeKey: holes[0]!.holeKey, text }];
  const chars = Array.from(text);
  const totalW = holes.reduce((a, h) => a + Math.max(1e-9, h.width), 0);
  const raw = holes.map((h) => (chars.length * Math.max(1e-9, h.width)) / totalW);
  const base = raw.map((n) => Math.floor(n));
  let left = chars.length - base.reduce((a, b) => a + b, 0);
  const order = raw.map((n, i) => ({ i, frac: n - Math.floor(n) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i]!++;
    left--;
  }
  const out: { holeKey: string; text: string }[] = [];
  let at = 0;
  holes.forEach((h, i) => {
    const n = base[i]!;
    out.push({ holeKey: h.holeKey, text: chars.slice(at, at + n).join("") });
    at += n;
  });
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (k: string): string | null => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const doc = flag("doc");
  if (!doc) {
    console.error('用法: ocr-fill-jobs.ts --doc "<docId>" [--v3-doc "<docId>"]');
    process.exit(2);
  }
  const v3Doc = flag("v3-doc") ?? doc;
  const outDir = join(ROOT, "data", "out", doc);
  const stages = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as {
    pages: { index?: number; width: number; height: number; uncovered?: { bbox?: number[]; kind?: string }[] }[];
  };
  const vl = loadPages(doc);
  const v3 = loadPages(v3Doc);
  const old = existsSync(join(outDir, "ocr-page-fill.json"))
    ? (JSON.parse(readFileSync(join(outDir, "ocr-page-fill.json"), "utf8")) as { pages?: { page: number; items?: { bbox: number[]; text?: string; accepted?: boolean }[] }[] })
    : { pages: [] as { page: number; items?: { bbox: number[]; text?: string; accepted?: boolean }[] }[] };

  // 现状产线：按页把 accepted 候选按 bbox 建索引
  const oldByPage = new Map<number, { bbox: Box; text: string }[]>();
  for (const p of old.pages ?? []) {
    oldByPage.set(p.page, (p.items ?? []).filter((i) => i.accepted && i.text).map((i) => ({ bbox: i.bbox as Box, text: i.text! })));
  }

  const rows: { page: number; bbox: Box; text: string; kind: string; oldText?: string; same?: boolean }[] = [];
  let pageCands: { holeKey: string; lineKey: string; cov: number; text: string; kind: string }[] = [];
  let conflictTotal = 0; // 跨行歧义（一个洞命中多行）的洞数
  const holeBox = new Map<string, Box>();
  for (let p = 0; p < Math.min(vl.length, v3.length); p++) {
    pageCands = [];
    const vp = vl[p]!;
    const tp = v3[p]!;
    const stage = stages.pages[p];
    if (!stage) continue;
    // 每块：行框 + 该行最终拿到的字（VL 文本经对齐后）
    const perLine = new Map<string, { text: string; kind: string; box: Box }>();
    for (const b of vp.blocks) {
      if (!b.norm || !b.content) continue;
      const cand = tp.lines
        .filter((l) => l.norm && l.text && overlap(l.norm!, b.norm!) / area(l.norm!) >= 0.5)
        .sort((a, c) => a.norm![1] - c.norm![1] || a.norm![0] - c.norm![0]);
      if (cand.length === 0) continue;
      const texts = alignBlockLines(b.content, cand);
      cand.forEach((l, i) => {
        const owned = texts[i]!;
        if (owned.kind === "blocked") return;
        perLine.set(l.norm!.map((n) => n.toFixed(4)).join(","), { text: owned.text, kind: owned.kind, box: l.norm! });
      });
    }

    // 洞：与产线同一形状守卫（content 且宽高比 ≥1.5）
    const dims = { w: stage.width, h: stage.height };
    for (const u of stage.uncovered ?? []) {
      const bb = u.bbox;
      if (!bb || bb.length < 4 || u.kind !== "content") continue;
      const w = bb[2]! - bb[0]!;
      const h = bb[3]! - bb[1]!;
      if (w <= 0 || h <= 0 || w / h < 1.5) continue;
      const hole: Box = [bb[0]! / dims.w, bb[1]! / dims.h, bb[2]! / dims.w, bb[3]! / dims.h];
      const holeKey = `${p}:${hole.map((n) => n.toFixed(4)).join(",")}`;
      holeBox.set(holeKey, hole);
      for (const [lineKey, v] of perLine) {
        const cov = overlap(hole, v.box) / Math.max(1e-9, area(hole));
        if (cov >= 0.5) pageCands.push({ holeKey, lineKey: `${p}:${lineKey}`, cov, text: v.text, kind: v.kind });
      }
    }

    // 跨行歧义统计：一个洞同时命中 ≥2 行（理论上不该有，实测 0）
    const linesPerHole = new Map<string, Set<string>>();
    for (const c of pageCands) {
      const set = linesPerHole.get(c.holeKey) ?? new Set<string>();
      set.add(c.lineKey);
      linesPerHole.set(c.holeKey, set);
    }
    for (const set of linesPerHole.values()) if (set.size >= 2) conflictTotal++;

    // 按行归洞：一行可以拥有多个洞碎片；每个洞只认一行（跨行则记歧义，不填）
    const byLine = new Map<string, Cand[]>();
    for (const c of pageCands) {
      const arr = byLine.get(c.lineKey) ?? [];
      arr.push(c);
      byLine.set(c.lineKey, arr);
    }
    const assigned: (Cand & { text: string })[] = [];
    for (const [lineKey, cs] of byLine) {
      void lineKey;
      const uniqHoles = new Map<string, Cand>();
      for (const c of cs) if (!uniqHoles.has(c.holeKey) || c.cov > uniqHoles.get(c.holeKey)!.cov) uniqHoles.set(c.holeKey, c);
      const list = [...uniqHoles.values()].sort((a, b) => (holeBox.get(a.holeKey)![0] ?? 0) - (holeBox.get(b.holeKey)![0] ?? 0));
      const text = cs[0]!.text;
      const parts = splitTextAmongHoles(text, list.map((c) => ({ holeKey: c.holeKey, width: holeBox.get(c.holeKey)![2] - holeBox.get(c.holeKey)![0] })));
      list.forEach((c, i) => assigned.push({ ...c, text: parts[i]!.text, kind: c.kind }));
    }
    for (const c of assigned) {
      const hole = holeBox.get(c.holeKey)!;
      const oldHit = (oldByPage.get(p) ?? []).find(
        (o) =>
          overlap(hole, [o.bbox[0]! / dims.w, o.bbox[1]! / dims.h, o.bbox[2]! / dims.w, o.bbox[3]! / dims.h]) /
            Math.max(1e-9, area(hole)) >=
          0.5,
      );
      const same = oldHit ? matchChars(oldHit.text).join("") === c.text : undefined;
      rows.push({ page: p + 1, bbox: hole, text: c.text, kind: c.kind, oldText: oldHit?.text, same });
    }
  }

  const withOld = rows.filter((r) => r.oldText !== undefined);
  const same = withOld.filter((r) => r.same).length;
  const out = {
    doc,
    v3Doc,
    generatedAt: new Date().toISOString(),
    note: "只读对照：新路径（VL 字 + V3 行框）给每个洞算的字 vs 现状产线同一洞给过的字。不写产线文件。",
    holesWithCandidate: rows.length,
    conflicts: conflictTotal,
    alsoFilledByOld: withOld.length,
    sameAsOld: same,
    onlyNew: rows.length - withOld.length,
    rows,
  };
  writeFileSync(join(outDir, "ocr-fill-jobs.json"), JSON.stringify(out, null, 1), "utf8");
  console.log(
    `\n${doc}\n  新路径能给候选的洞：${rows.length}\n  现状产线也填过的：${withOld.length}（其中字一致 ${same}，${((same / Math.max(1, withOld.length)) * 100).toFixed(1)}%）\n` +
      `  只有新路径能填（现状没补）：${rows.length - withOld.length}\n` +
      `  跨行歧义（一个洞命中多行）：${conflictTotal}\n  明细 → data/out/${doc}/ocr-fill-jobs.json`,
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  try {
    main();
  } catch (e: unknown) {
    console.error(`✖ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
