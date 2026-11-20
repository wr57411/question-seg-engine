// tests/oxr-text-cleanup.test.ts —— OXR 转换层的文本残留清洗（B-55）
//
// 背景：M5-A 切 OXR 后 `audit:render:baseline` 残红 5 卷，其中两类是转换层引入的：
//  ① `\smiles{...}`：OXR 把公式块误判为「化学结构（Chemical Structure）」，内容被包进
//     `\smiles{}`。原卷该处**没有**任何化学结构符号（逐张回原卷页图核对：曲线 p11、
//     机械能 p4/p14 都是裸根式），`\smiles` 只是伪包装 ⇒ 去掉命令与外层花括号、保留内部公式。
//     （T3 报告曾按「rad/s 语境」猜成 `\omega` 误读，回原卷证伪：原卷无 ω。）
//  ② `blank` 块的 `\_\_\_`：OXR 把公式分数线/横线误判为「作答空白」，产出纯反斜杠+下划线块。
//     原卷对应位置只有横线（分数式），没有可填写的空白 ⇒ 整块丢弃（记入明细，不静默）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertOxrResponse, type OxrResponse } from "../scripts/oxr-convert.js";

function textsOf(layout: { pdf_info: { para_blocks: { lines?: { spans?: { content?: string }[] }[] }[] } }): string[] {
  return layout.pdf_info[0]!.para_blocks.flatMap((b) =>
    (b.lines ?? []).flatMap((l) => (l.spans ?? []).map((s) => s.content ?? "")),
  );
}

test("convertOxrResponse：Chemical Structure 的 \\smiles 包装去掉、保留内部公式", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "oxr-smiles-"));
  const raw: OxrResponse = {
    pages: [
      {
        page_num: 0,
        page_size: { w: 596, h: 842 },
        blocks: [
          {
            type: "Chemical Structure",
            bbox: [10, 10, 200, 60],
            content: String.raw`$\smiles{\sqrt{\frac{10\sqrt{3}}{3}}\text{rad/s}}$`,
          },
          {
            type: "Chemical Structure",
            bbox: [10, 70, 200, 120],
            content: String.raw`$\smiles{x\sqrt{\frac{g}{y_{2}-y_{1}}}}$`,
          },
        ],
      },
    ],
  };
  const { layout, stats } = await convertOxrResponse(raw, { docId: "t", outDir, noImages: true });
  const texts = textsOf(layout);
  assert.ok(texts.some((t) => t.includes(String.raw`\sqrt{\frac{10\sqrt{3}}{3}}`) && !t.includes("smiles")), `smiles 未去除：${texts.join("|")}`);
  assert.ok(texts.some((t) => t.includes(String.raw`x\sqrt{\frac{g}{y_{2}-y_{1}}}`) && !t.includes("smiles")), `嵌套括号去除错：${texts.join("|")}`);
  assert.equal(stats.cleanupSmilesUnwrapped, 2);
  const artifact = JSON.parse(readFileSync(join(outDir, "oxr-text-cleanup.json"), "utf8")) as {
    smilesUnwrapped: { content: string }[];
  };
  assert.equal(artifact.smilesUnwrapped.length, 2, "清洗明细必须落盘（不静默）");
});

test("convertOxrResponse：\\smiles 括号不配对时不猜、原样保留", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "oxr-smiles-bad-"));
  const raw: OxrResponse = {
    pages: [
      {
        page_num: 0,
        page_size: { w: 596, h: 842 },
        blocks: [{ type: "Chemical Structure", bbox: [10, 10, 200, 60], content: String.raw`$\smiles{\frac{1}{2}$` }],
      },
    ],
  };
  const { layout, stats } = await convertOxrResponse(raw, { docId: "t", outDir, noImages: true });
  assert.equal(stats.cleanupSmilesUnwrapped, 0);
  assert.ok(textsOf(layout)[0]!.includes(String.raw`\smiles`), "不配对不得改写");
});

test("convertOxrResponse：blank 块的 \\_ \\_ 噪声整块丢弃（记录明细）", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "oxr-blank-noise-"));
  const raw: OxrResponse = {
    pages: [
      {
        page_num: 0,
        page_size: { w: 596, h: 842 },
        blocks: [
          { type: "blank", bbox: [10, 10, 100, 30], content: String.raw`\_\_\_\_` },
          { type: "blank", bbox: [10, 40, 100, 60], content: String.raw`\_\_\_\_` },
        ],
      },
    ],
  };
  const { layout, stats } = await convertOxrResponse(raw, { docId: "t", outDir, noImages: true });
  assert.deepEqual(textsOf(layout), [], "纯 \\_ 空白噪声不应进入快照");
  assert.equal(stats.cleanupBlankDropped, 2);
  const artifact = JSON.parse(readFileSync(join(outDir, "oxr-text-cleanup.json"), "utf8")) as {
    blankDropped: { content: string }[];
  };
  assert.equal(artifact.blankDropped.length, 2, "丢弃必须留痕（红线 G1）");
});

test("convertOxrResponse：真实作答空白 () / （） 不受影响（回归守卫）", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "oxr-blank-keep-"));
  const raw: OxrResponse = {
    pages: [
      {
        page_num: 0,
        page_size: { w: 596, h: 842 },
        blocks: [
          { type: "blank", bbox: [10, 10, 100, 30], content: "()" },
          { type: "blank", bbox: [10, 40, 100, 60], content: "（）" },
        ],
      },
    ],
  };
  const { layout, stats } = await convertOxrResponse(raw, { docId: "t", outDir, noImages: true });
  assert.equal(stats.cleanupBlankDropped, 0);
  const texts = textsOf(layout);
  assert.ok(texts.some((t) => t.includes("()")));
  assert.ok(texts.some((t) => t.includes("（）")));
});