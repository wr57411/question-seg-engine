// tests/normalize-cross-page-leak.test.ts —— B-47 跨页泄漏文本判据（TDD 红→绿）。
//
// 背景：MinerU `para_blocks` 偶发把**属于下一页**的行并进上一页段落（行坐标是下一页页顶的，
// 物理上压在上一页页眉/正文上 ⇒ 成品页叠印）。形状判据 `isCrossPageLeakShape` 依赖段框几何，
// 对「list 段框在右栏、泄漏行在左栏顶」的形态失手（答案册 p121 实证）。
// 本测试锁**文本判据**：本页 preproc 无 + 下一页 preproc 有 + 全书 para 页频 <3 + 归一长度 ≥4，
// 命中即从本页滤除并**迁回真页**（内容不丢，G1），逐条落可核对记录。
//
// 四条回归（任务 T1 验收）：
// ① 泄漏行被滤 + 记录；② 本页真行保留；③ 跨页重复页眉（频 ≥3）保留；④ OXR 形态逐字节不变。
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";
import type { ParsedDocument } from "../src/types.js";

interface Rec {
  fromPageIndex: number;
  toPageIndex: number;
  bbox: number[];
  text: string;
  action: string;
  criteria: { normLen: number; inCurrentPreproc: boolean; inNextPreproc: boolean; bookParaFreq: number };
}
/** 记录字段是后加的；用宽松读取让「旧实现无记录」也能编译，便于红→绿对比。 */
function recordsOf(doc: ParsedDocument): Rec[] {
  return (doc as unknown as { crossPageLeaks?: Rec[] }).crossPageLeaks ?? [];
}
function textLines(blocks: { kind?: string; bbox: number[]; text?: string }[]): string[] {
  return blocks.map((b) => b.text ?? "");
}

const line = (content: string, y: number) => ({
  bbox: [20, y, 400, y + 20],
  spans: [{ type: "text", content }],
});
const para = (lines: { bbox: number[]; spans: { type?: string; content: string }[] }[]) => ({
  type: "text",
  bbox: [20, 10, 400, 180],
  lines,
});

/** MinerU 形态夹具：preproc_blocks 存在（OXR 没有，见文件末逐字节锁）。 */
function mineruDoc(): unknown {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 852],
        preproc_blocks: [para([line("本页真行内容", 100)])],
        para_blocks: [
          para([
            line("本页真行内容", 100),
            line("下一页内容行", 10), // 泄漏行：本页 preproc 无、下页 preproc 有
            line("通用短句", 140), // 频 ≥3 的通用串：不滤
          ]),
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 852],
        preproc_blocks: [para([line("下一页内容行", 10), line("通用短句", 140)])],
        // 真实形态：para 漏了「下一页内容行」（只在 preproc）⇒ 迁回才不丢内容
        para_blocks: [para([line("通用短句", 140)])],
      },
      {
        page_idx: 2,
        page_size: [596, 852],
        preproc_blocks: [para([line("通用短句", 140)])],
        para_blocks: [para([line("通用短句", 140)])],
      },
    ],
  };
}

test("B-47：跨页泄漏行被滤除并迁回真页，且落可核对记录", () => {
  const doc = normalizeLayout(mineruDoc(), "b47-test");
  const p0 = textLines(doc.pages[0]!.blocks as never);
  const p1 = textLines(doc.pages[1]!.blocks as never);
  assert.ok(!p0.includes("下一页内容行"), "泄漏行应离开第 1 页（不再叠印）");
  assert.ok(p1.includes("下一页内容行"), "泄漏行应迁回第 2 页（内容不丢，G1）");
  const recs = recordsOf(doc);
  assert.equal(recs.length, 1, "应恰有 1 条泄漏记录");
  const r = recs[0]!;
  assert.equal(r.action, "moved");
  assert.equal(r.fromPageIndex, 0);
  assert.equal(r.toPageIndex, 1);
  assert.equal(r.text, "下一页内容行");
  assert.deepEqual(r.bbox, [20, 10, 400, 30], "bbox 应原样保留（真页坐标）");
  assert.equal(r.criteria.inCurrentPreproc, false);
  assert.equal(r.criteria.inNextPreproc, true);
  assert.equal(r.criteria.bookParaFreq, 1);
  assert.ok(r.criteria.normLen >= 4);
});

test("B-47：本页真行保留（不误伤同页内容）", () => {
  const doc = normalizeLayout(mineruDoc(), "b47-keep");
  const p0 = textLines(doc.pages[0]!.blocks as never);
  assert.ok(p0.includes("本页真行内容"), "本页真行必须保留");
});

test("B-47：跨页重复页眉（全书 para 页频 ≥3）保留不滤", () => {
  const doc = normalizeLayout(mineruDoc(), "b47-freq");
  const p0 = textLines(doc.pages[0]!.blocks as never);
  assert.ok(p0.includes("通用短句"), "频 ≥3 的通用串不得被滤（C 守卫）");
  const recs = recordsOf(doc);
  assert.ok(!recs.some((r) => r.text === "通用短句"), "通用短句不应进记录");
});

test("B-47：真页已有近似副本 ⇒ 丢弃并记 action=dropped（不制造重复）", () => {
  // 页 1（真页）para 含「下一页内容行」⇒ 命中判据但已有副本 ⇒ 丢弃，不重复迁回。
  const raw = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 852],
        preproc_blocks: [para([line("本页真行内容", 100)])],
        para_blocks: [para([line("本页真行内容", 100), line("下一页内容行", 10)])],
      },
      {
        page_idx: 1,
        page_size: [596, 852],
        preproc_blocks: [para([line("下一页内容行", 10)])],
        para_blocks: [para([line("下一页内容行", 10), line("其它内容", 140)])],
      },
      {
        page_idx: 2,
        page_size: [596, 852],
        preproc_blocks: [para([line("下一页内容行", 10)])],
        para_blocks: [para([line("其它内容", 140)])],
      },
    ],
  };
  const d2 = normalizeLayout(raw, "b47-dup2");
  const recs = recordsOf(d2);
  const r = recs.find((x) => x.text === "下一页内容行");
  assert.ok(r, "应命中泄漏判据");
  assert.equal(r!.action, "dropped", "真页已有近似副本 ⇒ 丢弃（内容已在，不重复）");
  assert.equal(r!.criteria.bookParaFreq, 2);
});

test("B-47：形状判据同页守卫——本页 preproc 有的行不被误迁（p125 左栏叠印根因）", () => {
  // p125 实证：p126 的 list 段框跨整页（段框在页顶，行在页底），对称形态误判 ⇒
  // 真页内行被迁到上一页互叠。有 preproc 时以 preproc 为准：本页 preproc 有 ⇒ 不迁。
  const paraBlock = { type: "list", bbox: [34, 81, 178, 170], lines: [{ bbox: [36, 682, 261, 693], spans: [{ type: "text", content: "真页内行" }] }] };
  const raw = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 852],
        preproc_blocks: [para([line("真页内行", 682)])],
        para_blocks: [paraBlock],
      },
      { page_idx: 1, page_size: [596, 852], preproc_blocks: [], para_blocks: [] },
    ],
  };
  const doc = normalizeLayout(raw, "b47-shape-guard");
  const p0 = textLines(doc.pages[0]!.blocks as never);
  assert.ok(p0.includes("真页内行"), "本页 preproc 有的行不得被形状判据迁走（同页守卫）");
  assert.equal(recordsOf(doc).length, 0, "真页内行不是跨页泄漏，不应进记录");
});

test("B-47：OXR 形态（无 preproc_blocks）整体跳过 ⇒ 逐字节不变、无记录", () => {
  // OXR layout 无 preproc_blocks；判据前提不成立 ⇒ 一个块都不动。
  const oxr = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 852],
        para_blocks: [{
          type: "text",
          bbox: [20, 10, 400, 60],
          lines: [{ bbox: [20, 10, 400, 30], spans: [{ type: "text", content: "下一页内容行" }] }],
        }],
      },
      {
        page_idx: 1,
        page_size: [596, 852],
        para_blocks: [{
          type: "text",
          bbox: [20, 10, 400, 60],
          lines: [{ bbox: [20, 10, 400, 30], spans: [{ type: "text", content: "本页内容" }] }],
        }],
      },
    ],
  };
  const doc = normalizeLayout(oxr, "oxr-b47");
  // 逐字节：块文本/bbox 与输入一致，且无跨页泄漏记录
  assert.deepEqual(
    doc.pages.map((p) => p.blocks),
    [
      [{ kind: "text", bbox: [20, 10, 400, 30], text: "下一页内容行", firstLine: "下一页内容行", lineCount: 1, maxFontSize: 0 }],
      [{ kind: "text", bbox: [20, 10, 400, 30], text: "本页内容", firstLine: "本页内容", lineCount: 1, maxFontSize: 0 }],
    ] as never,
    "OXR 无 preproc_blocks ⇒ 输出逐字节不变",
  );
  assert.equal(doc.crossPageLeaks, undefined, "OXR 不应产生泄漏记录");
});
