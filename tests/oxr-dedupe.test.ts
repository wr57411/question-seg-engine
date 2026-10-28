// tests/oxr-dedupe.test.ts —— OXR 重叠重复块合并（2026-10-28《教材基础练 磁场》实测）
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertOxrResponse, type OxrResponse } from "../scripts/oxr-convert.js";

test("convertOxrResponse：重叠重复段合并，短块徽标题号补回保留块", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "oxr-dedupe-"));
  const raw: OxrResponse = {
    pages: [
      {
        page_num: 0,
        page_size: { w: 596, h: 842 },
        blocks: [
          {
            type: "Text",
            bbox: [10, 10, 300, 80],
            content: "1 2024年1月浙江卷 [鲁科版选修二P8第3题设问变式]磁电式电表原理示意图如图所示，两磁极装有极靴",
          },
          {
            type: "Text",
            bbox: [10, 12, 300, 160],
            content:
              "2024年1月浙江卷 [看科版选修二P8第3题设问变式]磁电式电表原理示意图如图所示，两磁极装有极靴，极靴中间还有一个用软铁制成的圆柱",
          },
          { type: "Text", bbox: [320, 10, 580, 40], content: "A. 另一道独立选项行" },
        ],
      },
    ],
  };
  const { layout, stats } = await convertOxrResponse(raw, { docId: "t", outDir, noImages: true });
  assert.equal(stats.dedupeDropped, 1);
  assert.equal(stats.dedupeMergedBadge, 1);
  const blocks = (layout.pdf_info[0] as { para_blocks: { lines?: { spans?: { content?: string }[] }[] }[] }).para_blocks;
  const texts = blocks.flatMap((b) => (b.lines ?? []).flatMap((l) => (l.spans ?? []).map((s) => s.content ?? "")));
  const joined = texts.join("");
  assert.ok(joined.startsWith("1 ") || joined.startsWith("1"), `合并后应补回徽标题号，实际 ${JSON.stringify(joined.slice(0, 40))}`);
  assert.ok(joined.includes("极靴中间还有一个用软铁制成的圆柱"), "应保留更完整的长段");
  assert.ok(joined.includes("另一道独立选项行"), "不重叠的块必须保留");
  const artifact = JSON.parse(readFileSync(join(outDir, "oxr-dedupe.json"), "utf8")) as { dropped: unknown[] };
  assert.equal(artifact.dropped.length, 1, "去重明细必须落盘（不静默）");
});


test("convertOxrResponse：table HTML 扁平化为可读文本", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "oxr-table-"));
  const raw: OxrResponse = {
    pages: [
      {
        page_num: 0,
        page_size: { w: 596, h: 842 },
        blocks: [
          {
            type: "Table",
            bbox: [10, 10, 580, 120],
            content: "<table><tr><td>研究对象</td><td>磁感应强度 B</td></tr><tr><td>意义</td><td>描述磁场</td></tr></table>",
          },
        ],
      },
    ],
  };
  const { layout } = await convertOxrResponse(raw, { docId: "t", outDir, noImages: true });
  const blocks = (layout.pdf_info[0] as { para_blocks: { lines?: { spans?: { content?: string }[] }[] }[] }).para_blocks;
  const text = blocks.flatMap((b) => (b.lines ?? []).flatMap((l) => (l.spans ?? []).map((s) => s.content ?? ""))).join("");
  assert.ok(!text.includes("<table>"), "不得把 HTML 标签留给渲染器");
  assert.ok(text.includes("研究对象") && text.includes("磁感应强度") && text.includes("描述磁场"));
});
