// scripts/hole-read-judge.ts
/**
 * 轮 6「直接读洞」判据评估器：笔记本 PP-OCRv5_server_rec 洞条文本 → judgeHole 判据（复用，
 * scripts/ocr-page-fill-jobs.ts:209，不重写语义）。cropText 传 ""（本路径 rec 即裁图识别，
 * 无第二独立路径，agree 判据按 judgeHole 口径跳过）；pageText=页面 MinerU 块文本（dup 防护）；
 * inkW=洞内墨迹宽（inkExtent，§110 第九轮同口径）。
 * 用法：npx tsx scripts/hole-read-judge.ts --rec rec14.json [--cmp] [--out hole-read-readings.json]
 *   --cmp：并列输出本地配对栈（ocr-page-fill-jobs.ocr-jobs-cache-localv3.json，11/14）
 *          与云端栈（ocr-page-fill-jobs.json，8/14）的逐洞 accepted 对比。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeHole, dupRatio } from "./ocr-page-fill-jobs.js";

const DIR = join(process.cwd(), "data/out", "答案册-合订本");
const argv = process.argv.slice(2);
const arg = (k: string): string | null => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const recPath = arg("rec") ?? "rec14.json";
const outName = arg("out") ?? recPath.replace("rec", "readings");
const rec = JSON.parse(readFileSync(join(DIR, "hole-read", recPath), "utf8")) as {
  id: string; page: number; holeIdx: number; bbox: number[]; medH: number; inkW: number | null;
  recText: string | null; recScore: number | null; err?: string;
}[];
const stages = JSON.parse(readFileSync(join(DIR, "stages.json"), "utf8")) as {
  pages: { index: number; blocks?: { text?: unknown; ocr?: unknown }[] }[];
};
interface Row {
  id: string; page: number; holeIdx: number; recText: string | null; recScore: number | null;
  expected: number; ratio: number; balanced: boolean; dup: number;
  accepted: boolean; reason?: string;
  local: boolean; cloud: boolean; localText: string; cloudText: string;
}

const cmpOf = (f: string): Map<string, { a: boolean; t: string }> => {
  const j = JSON.parse(readFileSync(join(DIR, f), "utf8")) as { pages: { page: number; items: { bbox: number[]; accepted: boolean; text: string }[] }[] };
  const m = new Map<string, { a: boolean; t: string }>();
  for (const p of j.pages ?? []) {
    for (const it of p.items ?? []) {
      const key = `${p.page}:${it.bbox.map((v) => Math.round(v * 10) / 10).join("_")}`;
      m.set(key, { a: it.accepted, t: it.text });
    }
  }
  return m;
};
const localCmp = cmpOf("ocr-page-fill-jobs.ocr-jobs-cache-localv3.json");
const cloudCmp = cmpOf("ocr-page-fill-jobs.json");

const rows: Row[] = [];
for (const h of rec) {
  const page = stages.pages[h.page]!;
  const pageText = (page.blocks ?? []).filter((b) => b.text && !b.ocr).map((b) => String(b.text)).join("\n");
  const bb = h.bbox as [number, number, number, number];
  const text = h.recText ?? "";
  const j = judgeHole(bb[2] - bb[0], h.medH, text, "", pageText, h.inkW ?? undefined);
  const key = `${h.page}:${bb.map((v) => Math.round(v * 10) / 10).join("_")}`;
  const loc = localCmp.get(key);
  const cld = cloudCmp.get(key);
  rows.push({ id: h.id, page: h.page, holeIdx: h.holeIdx, recText: h.recText, recScore: h.recScore,
    expected: j.expected, ratio: j.ratio, balanced: j.balanced, dup: pageText ? dupRatio(text, pageText) : 0,
    accepted: j.ok, reason: j.reason, local: loc?.a ?? false, cloud: cld?.a ?? false,
    localText: loc?.t ?? "", cloudText: cld?.t ?? "" });
}
const acc = rows.filter((r) => r.accepted).length;
const recOk = rows.filter((r) => r.recText).length;
const summary = {
  rec: recPath,
  holes: rows.length,
  recProduced: recOk,
  accepted: acc,
  localAccepted: rows.filter((r) => r.local).length,
  cloudAccepted: rows.filter((r) => r.cloud).length,
};
console.log(JSON.stringify(summary, null, 1));
for (const r of rows) {
  console.log(`${r.id} rec="${(r.recText ?? "").slice(0, 30)}" acc=${r.accepted}${r.reason ? " (" + r.reason + ")" : ""} | local=${r.local} cloud=${r.cloud}`);
}
writeFileSync(join(DIR, "hole-read", outName), JSON.stringify({ summary, rows }, null, 1));
console.log(`→ hole-read/` + outName);
