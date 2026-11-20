// oxr-input.test.ts —— M1（no-MinerU 生产化）：导出器以 OXR layout 为输入的骨架行为锁。
// 命题：export-stages 的骨架完全来自喂入的 layout.json（argv[3]），源无关 ——
//   喂 OXR layout（pdf_info 同 schema、无 MinerU 表块/丢弃块）⇒ 产 OXR 骨架：
//   行级块与 OXR spans 一致、无上游 MinerU 表块（OXR 不给表格 HTML；压平表格行的 §90 重建
//   与 M3 的 V3 插入是另一回事，本夹具不含压平表格行）、
//   markdown 漏泄行原样保留为 text 块（检测不改写，M2 才挂裁图）、
//   快照自带 layoutInput 溯源字段（证明输入是哪份 layout，不靠命令行口说）。
// 跑法：真 spawn scripts/export-stages.ts（与 batch.test.ts 同模式），夹具落临时目录，
//   输出隔离在 data/out/<测试 docId>/，finally 清理，绝不碰生产快照。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOC_ID = "bgx-oxr-input-test";

/** OXR 风格行：para_blocks[].lines[].spans[].content（与真实 OXR layout 同 schema） */
function para(type: string, bbox: [number, number, number, number], lines: string[]) {
  return {
    type,
    bbox,
    lines: lines.map((content, i) => ({
      bbox: [bbox[0], bbox[1] + i * 20, bbox[2], bbox[1] + i * 20 + 16] as [number, number, number, number],
      font_size: 10.5,
      spans: [{ content, font_size: 10.5 }],
    })),
  };
}

// 两页最小 OXR 骨架：无 table 块、无 discarded_blocks（OXR 不产这两类 MinerU 专属结构）。
// 第 0 页含一条 markdown 图片漏泄行（OXR/MinerU 共有的真实病灶，M2 的处理对象）。
const PAGE0_PARAS = [
  para("text", [32, 25, 200, 45], ["第四章 曲线运动"]),
  para("text", [32, 70, 160, 88], ["一、选择题"]),
  para("text", [32, 100, 500, 118], ["1. 关于曲线运动，下列说法正确的是"]),
  para("text", [40, 125, 480, 143], ["A. 速度方向时刻改变"]),
  para("text", [40, 150, 480, 168], ["B. 加速度一定不为零"]),
  para("text", [32, 180, 520, 198], ["![插图](http://cdn.example.com/fig-1.png)"]),
];
const PAGE1_PARAS = [
  para("text", [32, 40, 500, 58], ["2. 质点沿如图所示曲线运动，轨迹方程为 $y=x^2$"]),
  para("text", [40, 70, 480, 88], ["A. 合外力指向轨迹凹侧"]),
  para("text", [40, 95, 480, 113], ["B. 速度方向沿轨迹切线"]),
];
const OXR_LAYOUT = {
  pdf_info: [
    { page_idx: 0, page_size: [596, 852], para_blocks: PAGE0_PARAS },
    { page_idx: 1, page_size: [596, 852], para_blocks: PAGE1_PARAS },
  ],
};

/** 夹具全部 span 文本（块文本必须能溯源到这里 —— 喂 OXR 产 OXR，不掺 MinerU 内容） */
const FIXTURE_TEXTS = OXR_LAYOUT.pdf_info.flatMap((p) =>
  p.para_blocks.flatMap((pb) => pb.lines.flatMap((l) => l.spans.map((s) => s.content))),
);

test("M1：export-stages 喂 OXR layout ⇒ OXR 骨架（溯源=喂入路径、无 MinerU 表块、漏泄行不改写）", () => {
  const base = mkdtempSync(join(tmpdir(), "bgx-oxr-input-"));
  const layoutPath = join(base, "layout.json");
  writeFileSync(layoutPath, JSON.stringify(OXR_LAYOUT));
  const outDir = join(ROOT, "data", "out", DOC_ID);
  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/export-stages.ts", DOC_ID, layoutPath],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
    );
    assert.equal(r.status, 0, `导出应成功退出 0；stderr=${r.stderr}`);

    const snap = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as {
      docId: string;
      layoutInput?: string;
      pages: {
        index: number;
        blocks: { kind: string; text: string }[];
        raw: { type: string; text: string }[];
        order: number[];
      }[];
    };
    assert.equal(snap.docId, DOC_ID);
    assert.equal(snap.pages.length, 2, "两页夹具应产两页快照");

    // ── 溯源：快照必须自报「骨架来自哪份 layout」（M1 子目标2：无 MinerU layout 输入的可核对凭证） ──
    assert.equal(snap.layoutInput, layoutPath, "快照应记录喂入的 OXR layout 路径（layoutInput）");

    // ── 行级块与 OXR layout 一致：每块文本都能溯源到夹具 spans，关键行逐一命中 ──
    const allBlocks = snap.pages.flatMap((p) => p.blocks);
    assert.ok(allBlocks.length >= 9, `行级块数应 ≥ 夹具行数 9，实际 ${allBlocks.length}`);
    for (const b of allBlocks) {
      if (b.kind !== "text") continue;
      assert.ok(
        FIXTURE_TEXTS.some((t) => t.includes(b.text) || b.text.includes(t)),
        `块文本必须溯源到 OXR 夹具（不掺其它源内容）：${b.text}`,
      );
    }
    const p0 = snap.pages[0];
    const p1 = snap.pages[1];
    assert.ok(p0, "快照应有第 0 页");
    assert.ok(p1, "快照应有第 1 页");
    const p0Texts = p0.blocks.map((b) => b.text);
    for (const want of ["第四章 曲线运动", "一、选择题", "1. 关于曲线运动，下列说法正确的是", "A. 速度方向时刻改变"]) {
      assert.ok(p0Texts.includes(want), `第 0 页应含 OXR 行「${want}」`);
    }
    assert.ok(
      p1.blocks.some((b) => b.text.includes("2. 质点沿如图所示曲线运动")),
      "第 1 页应含 OXR 题 2 行",
    );

    // ── 原料层 = OXR para_blocks 原样（type/文本），不是 MinerU 段块 ──
    assert.equal(p0.raw.length, PAGE0_PARAS.length);
    assert.equal(p0.raw[0]?.text, "第四章 曲线运动");

    // ── OXR 无上游表格 HTML ⇒ 本夹具（无压平表格行）骨架无 kind=table 块。
    // 注意：真实 OXR 册的压平表格行可由 DECISIONS §90 重建成 table 块（合成 html），
    // V3 真表 HTML/整表裁图则需要 table-v3.json（M3 插入模式）—— 此处锁的是「不掺 MinerU 表块」。 ──
    assert.equal(allBlocks.filter((b) => b.kind === "table").length, 0, "OXR 骨架不应有 MinerU 表块");

    // ── markdown 漏泄行原样保留为 text 块（检测不改写；M2 才挂裁图，原文必须还在） ──
    assert.ok(
      p0Texts.some((t) => t.startsWith("![") && t.includes("](http")),
      "markdown 漏泄行应原样保留在 text 块（不改写、不静默丢）",
    );

    // ── 阅读顺序覆盖全块、questions.json 同源产出 ──
    for (const p of snap.pages) {
      assert.equal(new Set(p.order).size, p.blocks.length, "order 应覆盖全块且不重");
    }
    const qs = JSON.parse(readFileSync(join(outDir, "questions.json"), "utf8")) as { number: string }[];
    assert.ok(qs.some((q) => q.number === "1") && qs.some((q) => q.number === "2"), "OXR 骨架应切出 1/2 两题");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});