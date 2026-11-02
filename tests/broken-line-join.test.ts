// tests/broken-line-join.test.ts
/**
 * **跨行折断回接**（`DECISIONS §85`）。
 *
 * 现象（2026-10-30 实测）：电路册 p6 的原文
 *   `是游标尺上的n条刻线的总长度与主尺上(n-1)条刻线的总长度相等。`
 * 被版面折成两行，第二行开头是 `1)条刻线…`。切题层看到 `1)` 就当题号
 * （`§78` 的兜底靠「量词黑名单」挡住了，但那是猜，不是根治）。
 *
 * 根治点在上游：`normalizeLayout` 把每个 MinerU 行展开成一个 block，
 * **行与行的连续性在块序列里丢了**。这里按两条硬证据把它接回去：
 *   ① 上一行有**未闭合左括号**（`(`/`（` 多于 `)`/`）`）—— 反证它一定在下面闭合；
 *   ② 本行以 `数字)` / `数字）` 开头；
 *   ③ 两行在版面上**紧邻且同栏**（几何守卫，见下）。
 *
 * 为什么三条都要：只有 ① 时全项目命中 168 处，绝大多数是括号内正文正常折行
 * （`(不计空气阻` + `力,g取10…`），那些**不能合并**，否则整页段落结构被打乱。
 * ①+② 只剩 2 处，且都是真折断。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";

type LineSpec = { text: string; bbox: [number, number, number, number] };

/** 每个 line 独立成一个 para_block —— 复刻 `电路` layout 的实际形态（每行一块）。 */
function mkLayout(lines: LineSpec[]) {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [1654, 2339],
        para_blocks: lines.map((l) => ({
          type: "text",
          bbox: l.bbox,
          lines: [{ bbox: l.bbox, spans: [{ type: "text", content: l.text }] }],
        })),
      },
    ],
  };
}

function texts(doc: ReturnType<typeof normalizeLayout>): string[] {
  const out: string[] = [];
  for (const b of doc.pages[0]!.blocks) if (b.kind === "text") out.push(b.text);
  return out;
}

test("折断回接：行尾未闭合 ( + 下一行 `1)条刻线…` → 合成一块、文本完整", () => {
  const doc = normalizeLayout(
    mkLayout([
      { text: "是游标尺上的n条刻线的总长度与主尺上(n-", bbox: [171, 721, 1055, 758] },
      { text: "1)条刻线的总长度相等。常见的几种卡尺分类", bbox: [169, 796, 1062, 834] },
    ]),
    "broken-join",
  );
  const t = texts(doc);
  assert.equal(t.length, 1, "两行应合成为一块");
  assert.match(t[0]!, /主尺上\(n-1\)条刻线/, "折断处应接回 (n-1)");
  assert.equal(t[0]!.includes("\n"), false, "同一行折断，不该在中间带换行");
});

test("折断回接后 firstLine 是合并后的首行（切题层看不到 `1)` 开头）", () => {
  const doc = normalizeLayout(
    mkLayout([
      { text: "是游标尺上的n条刻线的总长度与主尺上(n-", bbox: [171, 721, 1055, 758] },
      { text: "1)条刻线的总长度相等。常见的几种卡尺分类", bbox: [169, 796, 1062, 834] },
    ]),
    "broken-join",
  );
  const b = doc.pages[0]!.blocks[0]!;
  if (b.kind !== "text") throw new Error(`期望 text 块，实际 ${b.kind}`);
  assert.doesNotMatch(b.firstLine, /^1\)/, "firstLine 不应以 `1)` 开头");
});

test("不做过度合并：括号内正文正常折行（下一行不以数字) 开头）保持原样", () => {
  const doc = normalizeLayout(
    mkLayout([
      { text: "0.4 s 时物体的速度大小变为4 m/s(不计空气阻", bbox: [171, 500, 1055, 538] },
      { text: "力,g取10 m/s²,则物体在这段时间内", bbox: [171, 575, 1055, 613] },
    ]),
    "no-join",
  );
  assert.equal(texts(doc).length, 2, "普通跨行括号不合并（否则整页段落会被并掉）");
});

test("几何守卫：同栏但相隔很远（换栏/隔段）不合并", () => {
  const doc = normalizeLayout(
    mkLayout([
      { text: "本栏段落结束处写着(n-", bbox: [171, 500, 800, 538] },
      { text: "1)另一栏另一个段落的开头", bbox: [900, 900, 1500, 938] },
    ]),
    "far-apart",
  );
  assert.equal(texts(doc).length, 2, "不相邻的两行不能合并");
});

test("同段落内的折断同样接回（行级展开后仍是相邻两块）", () => {
  // 复刻 `_tablecheck` 形态：整个段落是一个 para_block（多行），最后一行以 `(n-` 收尾。
  // normalizeLayout 会把 para_block 内的每行展开成独立块，所以这里落成「行1 | 行2 | 行3」，
  // 需要把行2/行3 接回去。
  const raw = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [1654, 2339],
        para_blocks: [
          {
            type: "text",
            bbox: [171, 490, 1062, 834],
            lines: [
              { bbox: [171, 496, 1062, 532], spans: [{ type: "text", content: "游标卡尺种类很多," }] },
              { bbox: [171, 721, 1055, 758], spans: [{ type: "text", content: "与主尺上(n-" }] },
            ],
          },
          {
            type: "text",
            bbox: [169, 796, 1062, 834],
            lines: [
              { bbox: [169, 796, 1062, 834], spans: [{ type: "text", content: "1)条刻线的总长度相等。" }] },
            ],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(raw, "multi-line");
  const blocks = doc.pages[0]!.blocks;
  // 行1 独立；行2 + 行3 接回一块
  assert.equal(blocks.length, 2, "折断的行 2/行 3 应合成一块，行 1 不受影响");
  const b = blocks[1]!;
  if (b.kind !== "text") throw new Error(`期望 text 块，实际 ${b.kind}`);
  assert.match(b.text, /与主尺上\(n-1\)条刻线的总长度相等/);
  assert.equal(b.lineCount, 1, "拼接后文本无换行 ⇒ 块内 1 行");
});
