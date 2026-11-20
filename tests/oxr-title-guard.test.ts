// tests/oxr-title-guard.test.ts
//
// M7-A：答案册-合订本 OXR 切换前置 —— 标题级守卫/补识。
//
// 背景（tmp/m5-answer-guard/real-loss.json）：OXR 解析件比旧 MinerU 生产件少 13 页内容，
// 其中 6 处是**内容标题**（第N节 / 专题 / 全章综合测试 / 页首「必刷知识·」），
// 其余是散文行、封面标语与栏目标签。守卫只认内容标题（高精度、零误报，
// 实测全册恰好命中 6 处真丢标题）；散文/标签走逐条回原卷核对的 curated 补识。
//
// 判据取最严 AND：
//   - 标题守卫：V3 行匹配内容标题形态 + score ≥ 0.98 + OXR 页文本归一化后不含该标题；
//   - curated：显式清单（人工回原卷核对）+ 该页 OXR 仍缺该文本才并入；
//   - applyTitleGuard：产物缺失/空 ⇒ doc 逐字节不变；同页已有同文 ⇒ 跳过（幂等）。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTitleGuard,
  detectTitleGaps,
  isContentTitleLine,
  normalizeGuardText,
  v3LineToPt,
  type TitleGuardEntry,
  type V3Page,
} from "../scripts/oxr-title-guard.js";
import { applyTitleGuard } from "../scripts/export-stages.js";
import type { ParsedDocument } from "../src/types.js";

/** 最小 OXR layout 页：一段文本块 */
function oxrPage(text: string, bbox: number[] = [10, 10, 300, 22]): Record<string, unknown> {
  return {
    page_idx: 0,
    page_size: [596, 872.6],
    para_blocks: [{ type: "text", bbox, lines: [{ bbox, spans: [{ content: text }] }] }],
  };
}

function v3Page(lines: { text: string; score?: number; bbox: number[] }[]): V3Page {
  return { page_px: [1000, 1464], lines };
}

test("isContentTitleLine：只认内容标题（节/专题/全章/页首必刷知识），不认栏目标签与散文", () => {
  for (const t of [
    "第3节 机械波的干涉、衍射 多普勒效应",
    "第2节磁场对通电导体的作用",
    "专题 光的折射和全反射规律的应用",
    "全章综合测试",
    "必刷知识·光的折射定律、全反射",
  ]) {
    assert.equal(isContentTitleLine(t), true, `应认内容标题：${t}`);
  }
  for (const t of [
    "刷小题",
    "刷基础",
    "提分",
    "真题",
    "以笔为戈",
    "附",
    "【解析】已知一个分力F1有确定的方向",
    "不断增大，凹槽对小球的支持力N先变小后变大",
    "1. C 必刷知识·通电导线间的安培力",
  ]) {
    assert.equal(isContentTitleLine(t), false, `不应认内容标题：${t}`);
  }
});

test("normalizeGuardText：去空白与间隔号（V3「第3节机械波…」对 OXR「第3节 机械波…」）", () => {
  assert.equal(normalizeGuardText("第3节 机械波的干涉、衍射 多普勒效应"), "第3节机械波的干涉、衍射多普勒效应");
  assert.equal(normalizeGuardText("必刷知识·光的折射定律"), "必刷知识·光的折射定律".replace(/·/g, ""));
  assert.equal(normalizeGuardText("必刷知识·光的折射定律"), normalizeGuardText("必刷知识•光的折射定律"));
});

test("v3LineToPt：按 V3 page_px 与目标页高换算 PDF 点", () => {
  const pt = v3LineToPt({ bbox: [100, 73.2, 500, 146.4] }, [1000, 1464], [596, 872.6]);
  assert.deepEqual(pt, [59.6, 43.6, 298, 87.3]);
});

test("detectTitleGaps：V3 有、OXR 无的内容标题 ⇒ 命中（page 1 基、bbox 换算、score 透传）", () => {
  const layout = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 872.6],
        para_blocks: [{ type: "text", bbox: [10, 10, 300, 22], lines: [{ bbox: [10, 10, 300, 22], spans: [{ content: "1. C 必刷知识·匀变速直线运动规律" }] }] }],
      },
    ],
  };
  const v3 = [
    v3Page([{ text: "第3节 机械波的干涉、衍射 多普勒效应", score: 0.997, bbox: [100, 50, 500, 80] }]),
  ];
  const { entries, stats } = detectTitleGaps(layout, v3);
  assert.equal(stats.candidates, 1);
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.equal(e.page, 1);
  assert.equal(e.text, "第3节 机械波的干涉、衍射 多普勒效应");
  assert.equal(e.origin, "guard");
  assert.equal(e.score, 0.997);
  assert.deepEqual(e.bbox, [59.6, 29.8, 298, 47.7]);
});

test("detectTitleGaps：OXR 已有该标题 ⇒ 不命中（归一化包含）", () => {
  const layout = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 872.6],
        para_blocks: [
          { type: "text", bbox: [10, 10, 300, 22], lines: [{ bbox: [10, 10, 300, 22], spans: [{ content: "第3节 机械波的干涉、衍射 多普勒效应" }] }] },
        ],
      },
    ],
  };
  const v3 = [v3Page([{ text: "第3节机械波的干涉、衍射多普勒效应", score: 0.99, bbox: [100, 50, 500, 80] }])];
  assert.equal(detectTitleGaps(layout, v3).entries.length, 0);
});

test("detectTitleGaps：非标题行 / 低置信度 ⇒ 不命中（AND 最严）", () => {
  const layout = { pdf_info: [oxrPage("1. C 必刷知识·匀变速直线运动规律")] };
  const v3 = [
    v3Page([
      { text: "不断增大，凹槽对小球的支持力N先变小后变大", score: 0.99, bbox: [100, 50, 500, 80] },
      { text: "第2节 磁场对通电导体的作用", score: 0.9, bbox: [100, 90, 500, 120] },
    ]),
  ];
  assert.equal(detectTitleGaps(layout, v3).entries.length, 0);
});

test("buildTitleGuard：curated 条目在该页 OXR 缺文本时并入；已存在则跳过（不重复）", () => {
  const layout = {
    pdf_info: [
      oxrPage("1. C 必刷知识·匀变速直线运动规律"),
      oxrPage("5. B 必刷知识·平抛运动"),
    ],
  };
  const v3 = [v3Page([]), v3Page([])];
  const curated: TitleGuardEntry[] = [
    { page: 1, bbox: [10, 200, 200, 212], text: "刷小题", origin: "curated", reason: "label", category: "label" },
    { page: 2, bbox: [10, 200, 200, 212], text: "5. B 必刷知识·平抛运动", origin: "curated", reason: "already-present", category: "prose" },
    { page: 9, bbox: [10, 200, 200, 212], text: "全章综合测试", origin: "curated", reason: "page-missing", category: "title" },
  ];
  const { entries, stats } = buildTitleGuard(layout, v3, { curated });
  assert.deepEqual(entries.map((e) => e.text), ["刷小题"]);
  assert.equal(stats.curatedSkipped, 2);
});

test("applyTitleGuard：插入正确页 + 块文本/坐标；空 entries ⇒ doc 逐字节不变", () => {
  const doc: ParsedDocument = {
    docId: "t",
    pages: [
      { index: 0, width: 596, height: 872.6, blocks: [{ kind: "text", bbox: [10, 10, 300, 22], text: "1. C 必刷知识·x", firstLine: "1. C 必刷知识·x", lineCount: 1, maxFontSize: 0 }] },
      { index: 1, width: 596, height: 872.6, blocks: [] },
    ],
  };
  const before = JSON.stringify(doc);
  assert.deepEqual(applyTitleGuard(doc, []), { applied: 0, skipped: 0 });
  assert.equal(JSON.stringify(doc), before, "无产物 ⇒ 一个字节都不改（默认关纪律）");

  const entries: TitleGuardEntry[] = [
    { page: 2, bbox: [20, 30, 200, 42], text: "第2节 磁场对通电导体的作用", origin: "guard", reason: "title-missing", category: "title" },
  ];
  const r = applyTitleGuard(doc, entries);
  assert.deepEqual(r, { applied: 1, skipped: 0 });
  const pg2 = doc.pages[1]!;
  assert.equal(pg2.blocks.length, 1);
  const b = pg2.blocks[0]!;
  assert.equal(b.kind, "text");
  assert.equal(b.kind === "text" && b.text, "第2节 磁场对通电导体的作用");
  assert.equal(b.kind === "text" && b.fromOcr, true, "补识块必须标记来源（OCR/独立源），不静默");
  assert.deepEqual(b.bbox, [20, 30, 200, 42]);
});

test("applyTitleGuard：同页已有同文 ⇒ 跳过（幂等，防重复插入）", () => {
  const doc: ParsedDocument = {
    docId: "t",
    pages: [
      { index: 0, width: 596, height: 872.6, blocks: [{ kind: "text", bbox: [10, 10, 300, 22], text: "第2节 磁场对通电导体的作用", firstLine: "第2节 磁场对通电导体的作用", lineCount: 1, maxFontSize: 0 }] },
    ],
  };
  const before = JSON.stringify(doc);
  const r = applyTitleGuard(doc, [
    { page: 1, bbox: [20, 30, 200, 42], text: "第2节磁场对通电导体的作用", origin: "guard", reason: "title-missing", category: "title" },
  ]);
  assert.deepEqual(r, { applied: 0, skipped: 1 });
  assert.equal(JSON.stringify(doc), before);
});
