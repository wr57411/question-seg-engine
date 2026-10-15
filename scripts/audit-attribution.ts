/**
 * audit-attribution.ts —— OCR 内容**归属**审计（需求文档 docs/specs/2026-10-15-ocr-attribution-audit.md）
 *
 * 被测对象只有 OCR 链路（`page.ocrFill` 的 accepted 候选 + `fromOcr`/`ocr` 注入块）。
 * MinerU 引擎块的唯一归属是状态机构造保证的（一块只进一个 `current`），判它是死门，不判。
 *
 * 三型判据（理由与"为什么不用成品逐行比对"见需求文档 §3）：
 *   A 重复认领 —— 一块 OCR 墨迹被 ≥2 个条目区域命中 ⇒ 同一行字在界面上出现两遍。
 *   B 无主     —— accepted 的候选不属于任何条目区域 ⇒ 纸面画得出、面板裁不到。
 *   C 张冠李戴 —— OCR 文字在**全卷成品里唯一命中**某条目（≥8 字），却没被几何判给它。
 *   P 规模提示 —— 条目区域单矩形高 > 半页 ⇒ A 型的成因信号。**只提示不判红**：
 *                 修好区域口径之前它必然一直响，判红只会逼人关掉门。
 *
 * 用法：npm run audit:attribution        （人读）
 *      npm run audit:attribution -- --md docs/...  （落清单）
 * ⚠️ 故意**不**挂在 `npm run check` 上：当前基线 A=18，挂上去等于带病开发。
 *    修完 §5 第 2 步后 A→0，那时再进门并做反向验证。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { collectEntryItems } from "../final/entry-paper.js";
import { mergeContext } from "../stages/reconstruct.js";

const DOCS: Array<[string, "quiz" | "ans"]> = [
  ["23必刷题 2相互作用", "quiz"],
  ["第二章相互作用-答案与解析", "ans"],
];
/** 归属判据只看"是不是一个主人"，与显示层的字号/合并无关，
 *  但必须用**同一个**区域口径 ⇒ 直接复用 `collectEntryItems` 返回的 `boxes`（按栏分段的多矩形）。 */
const norm = (s: unknown) => String(s ?? "").replace(/[^\p{L}\p{N}]/gu, "");
const MIN_C = 8; // C 型最短可比长度（低于此的通用语如"下列说法正确的是"没有证据力）

type Bank = { quizId?: string; answerId?: string; stem?: string; answerText?: string; options?: { key: string; text: string }[] };

/** 全卷成品文本（C 型判据的独立来源；A/B 型不依赖它） */
function buildCorpus(bank: Bank[]) {
  const out: { id: string; text: string }[] = [];
  for (const e of bank) {
    const quiz = norm([String(e.stem), ...(e.options ?? []).map((o) => String(o.key) + String(o.text))].join(""));
    const ans = norm(String(e.answerText));
    if (e.quizId) out.push({ id: e.quizId, text: quiz });
    if (e.answerId) out.push({ id: e.answerId, text: ans });
  }
  return out;
}

interface Finding {
  kind: "A" | "B" | "C";
  doc: string;
  page: number;
  src: string;
  text: string;
  owners: string[];
  note: string;
}

function auditDoc(doc: string, side: "quiz" | "ans", corpus: { id: string; text: string }[]): { findings: Finding[]; big: number; segs: number; items: number } {
  const snap = JSON.parse(readFileSync(`data/out/${doc}/stages.json`, "utf8")) as any;
  const findings: Finding[] = [];
  let big = 0, segs = 0, items = 0;
  for (const p of snap.pages) {
    const mc = mergeContext(p);
    const entries2 = p.questions.map((q: any) => {
      const own = q.blocks.map((i: number) => p.blocks[i]).filter(Boolean).filter((b: any) => !mc.drop.has(b.i));
      if (!own.length) return null;
      segs++;
      return { id: q.id, num: String(q.number), own };
    }).filter(Boolean) as { id: string; num: string; own: any[] }[];

    /* 认领关系**直接读面板的实现**（collectEntryItems 的 items），审计不再自己算几何 ——
       否则测的是"我写的第二套判据"，不是"面板真正会画什么"。 */
    const claims = new Map<string, string[]>(); // 内容键 -> 认领它的条目号
    const keyOf = (it: any) => (it.ocr ? `C:${it.ocr.text}:${Math.round(it.bbox[1])}` : `B:${it.blk.i}`);
    for (const e of entries2) {
      const { items: got, boxes } = collectEntryItems(p, e.own, mc);
      if (boxes.some((r: number[]) => (r[3] ?? 0) - (r[1] ?? 0) > p.height * 0.5)) big++;
      for (const k of new Set(got.map(keyOf))) {
        if (!claims.has(k)) claims.set(k, []);
        claims.get(k)!.push(e.num);
      }
    }
    const claimed = (key: string) => claims.get(key) ?? [];
    const numOf = new Map(entries2.map((e) => [e.id, e.num]));

    const ocrItems: { text: string; rect: number[]; src: string; key: string }[] = [];
    for (const o of p.ocrFill ?? []) {
      // 键必须与面板一致：它认领用的是 `win ?? bbox`（外扩 3pt 的窗口），不是原始 bbox
      const rect = o.win ?? o.bbox;
      if (o.accepted) ocrItems.push({ text: String(o.text), rect, src: "候选", key: `C:${o.text}:${Math.round(rect[1])}` });
    }
    for (const b of p.blocks) {
      if (b.fromOcr || b.ocr) ocrItems.push({ text: String(b.text ?? ""), rect: b.bbox, src: "注入", key: `B:${b.i}` });
    }

    for (const it of ocrItems) {
      items++;
      const t = norm(it.text);
      const owners = claimed(it.key);
      const names = owners.map((n) => `#${n}`);
      if (owners.length > 1) {
        findings.push({ kind: "A", doc, page: p.index + 1, src: it.src, text: it.text, owners: names, note: `被 ${owners.length} 个条目同时认领 ⇒ 同一行字在面板里出现两遍` });
      }
      if (!owners.length) {
        findings.push({ kind: "B", doc, page: p.index + 1, src: it.src, text: it.text, owners: [], note: "纸面画得出，面板裁不到" });
      }
      if (t.length >= MIN_C) {
        const holders = corpus.filter((c) => c.text.includes(t));
        const only = holders.length === 1 ? holders[0] : undefined;
        const bare = only ? only.id.replace(/^[QA]:/, "") : "";
        if (only && numOf.has(bare) && !owners.includes(numOf.get(bare)!)) {
          findings.push({ kind: "C", doc, page: p.index + 1, src: it.src, text: it.text, owners: names, note: `全卷唯一命中成品 ${only.id}，却判给 ${names.join("/") || "无"}` });
        }
      }
    }
  }
  return { findings, big, segs, items };
}

function main() {
  const bank = JSON.parse(readFileSync("data/out/bank/bank.json", "utf8")) as Bank[];
  const corpus = buildCorpus(bank);
  const mdPath = process.argv.indexOf("--md");
  const all: Finding[] = [];
  const lines: string[] = ["# OCR 归属审计", ""];
  for (const [doc, side] of DOCS) {
    const r = auditDoc(doc, side, corpus);
    all.push(...r.findings);
    lines.push(
      `## ${doc}`,
      `页段 ${r.segs} · 区域高过半页的 ${r.big} 个（提示项，不判红）· OCR 内容 ${r.items} 条`,
      "",
    );
    for (const f of r.findings) lines.push(`- **${f.kind}** p${f.page} [${f.src}]「${f.text.slice(0, 24)}」→ ${f.owners.join("+") || "无"} ｜ ${f.note}`);
    if (!r.findings.length) lines.push("- （无 A/B/C 型问题）");
    lines.push("");
  }
  const n = (k: Finding["kind"]) => all.filter((f) => f.kind === k).length;
  lines.push(`## 合计`, `A 重复认领 **${n("A")}** · B 无主 **${n("B")}** · C 张冠李戴 **${n("C")}**`);
  console.log(lines.join("\n"));
  const out = mdPath >= 0 ? process.argv[mdPath + 1] : undefined;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, lines.join("\n") + "\n");
    console.log(`\n清单已落 ${out}`);
  }
}
main();
