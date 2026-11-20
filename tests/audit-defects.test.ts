// tests/audit-defects.test.ts —— L1 聚合缺陷扫描器（只检测不改写）
//
// 命题：把《换源缺陷补偿手册》§1 的七类缺陷（A 几何 / B 文本残留 / C 题号结构 /
// D 跨页泄漏 / E 标题缺失 / F 修正层过期 / G 口径漂移）聚合到一条命令，逐类给
// {class, hits, samples, suggestedAttribution, evidencePath}。
//
// 夹具全部合成：造含 stray `}` / 无题号块的 layout ⇒ 命中；干净夹具 ⇒ 0。
// 红线：扫描器只读，不改写任何产物（检测不改写）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildJudgements,
  detectBaselineDrift,
  detectCorrectionMissed,
  detectCrossPageLeaks,
  detectGeometry,
  detectStructureHits,
  detectTextResidue,
  detectTitleGapHits,
  listProductionDocs,
  scanAll,
  type Baselines,
} from "../scripts/audit-defects.js";

/** 单页单行 layout（para_blocks → lines → spans）。 */
function onePageLayout(text: string): unknown {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 890],
        para_blocks: [
          {
            type: "text",
            bbox: [0, 0, 596, 20],
            lines: [{ bbox: [0, 0, 596, 20], spans: [{ content: text }] }],
          },
        ],
      },
    ],
  };
}

/** 跨页泄漏夹具：p0 preproc 无「泄漏行文本ABC」但 para 有；p1 preproc/para 都有。 */
function leakLayout(): unknown {
  const pb = (content: string) => ({
    type: "text",
    bbox: [0, 0, 200, 12],
    lines: [{ bbox: [0, 0, 200, 12], spans: [{ content }] }],
  });
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 890],
        preproc_blocks: [pb("本页内容XYZ")],
        para_blocks: [pb("泄漏行文本ABC")],
      },
      {
        page_idx: 1,
        page_size: [596, 890],
        preproc_blocks: [pb("泄漏行文本ABC")],
        para_blocks: [pb("泄漏行文本ABC")],
      },
    ],
  };
}

test("C：行首出处标注的无题号真题块命中；干净夹具 0", () => {
  const dirty = onePageLayout("2023 北京卷 [人教版必修二 P74 图 8.1-1 拓展变式] 一物体在力 F 作用下");
  const hits = detectStructureHits(dirty, "fixture");
  assert.equal(hits.length, 1, "应命中 1 处无题号真题块");
  assert.match(hits[0]!.kind, /C1/);
  assert.equal(hits[0]!.page, 1);

  const clean = onePageLayout("1. 下列说法正确的是（ ）");
  assert.equal(detectStructureHits(clean, "fixture").length, 0, "有题号块不得命中");
});

test("C：标签折行残片命中（prevLine 非题号时）", () => {
  const frag = onePageLayout("第4题情境变式]交警使用的酒精测试仪");
  const hits = detectStructureHits(frag, "fixture");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.kind, /C2/);
});

test("B：stray `}` 与 \\smiles 残留命中；干净夹具 0", () => {
  const dirty = onePageLayout("}.重力加速度为g,不考虑空气阻力的影响");
  const hits = detectTextResidue(dirty, "fixture");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.kind, /stray\}/);

  const smiles = onePageLayout(String.raw`$\smiles{\sqrt{2}}\text{rad/s}}$`);
  const hits2 = detectTextResidue(smiles, "fixture");
  assert.equal(hits2.length, 1);
  assert.match(hits2[0]!.kind, /smiles/);

  const clean = onePageLayout("1. 下列说法正确的是（ ）");
  assert.equal(detectTextResidue(clean, "fixture").length, 0);
});

test("D：跨页泄漏文本判据命中并留记录；干净夹具 0", () => {
  const hits = detectCrossPageLeaks(leakLayout(), "fixture");
  assert.equal(hits.length, 1, "应产出 1 条跨页泄漏记录");
  assert.match(hits[0]!.kind, /D-/);
  assert.match(hits[0]!.detail, /泄漏行文本ABC/);

  const clean = onePageLayout("1. 下列说法正确的是（ ）");
  assert.equal(detectCrossPageLeaks(clean, "fixture").length, 0);
});

test("E：标题守卫命中缺失内容标题；已含该标题则 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "l1-title-"));
  try {
    const v3Dir = join(dir, "v3");
    mkdirSync(v3Dir);
    writeFileSync(
      join(v3Dir, "p0.json"),
      JSON.stringify({
        page_px: [1000, 1431],
        lines: [{ text: "第1节 运动的描述", score: 0.99, bbox: [0, 0, 100, 20] }],
      }),
      "utf8",
    );
    const layout = onePageLayout("1. 下列说法正确的是（ ）");
    const hit = detectTitleGapHits(layout, "fixture", { v3Dir });
    assert.equal(hit.hits, 1);
    assert.match(hit.samples[0]!.detail, /第1节/);

    const hasTitle = onePageLayout("第1节 运动的描述\n1. 下列说法正确的是（ ）");
    const clean = detectTitleGapHits(hasTitle, "fixture", { v3Dir });
    assert.equal(clean.hits, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F：修正层干跑 missed 统计；命中则 0", () => {
  const layout = onePageLayout("原始文本ABC");
  const missed = detectCorrectionMissed(
    layout,
    "fixture",
    { docId: "fixture", items: [{ page: 1, kind: "replace", blockText: "不存在的文本", verified: true }] },
  );
  assert.equal(missed.samples.length, 1);
  assert.equal(missed.ledger.missed, 1);

  const ok = detectCorrectionMissed(layout, "fixture", {
    docId: "fixture",
    items: [{ page: 1, kind: "replace_text", blockText: "原始文本ABC", to: "修正文本ABC", verified: true }],
  });
  assert.equal(ok.samples.length, 0);
  assert.equal(ok.ledger.missed, 0);
});

test("A：读 stages.inkCoverage 的 contentCount；缺快照标前置", () => {
  const g = detectGeometry(
    {
      inkCoverage: {
        contentCount: 400,
        furnitureCount: 10,
        ratio: 0.2,
        pages: [{ index: 0, contentCount: 400, furnitureCount: 10, ratio: 0.2 }],
      },
    },
    "fixture",
  );
  assert.equal(g.hits, 400);
  assert.equal(g.ledger.overBaseline, true);

  const miss = detectGeometry({}, "fixture");
  assert.equal(miss.hits, 0);
  assert.match(miss.needsPrerequisite ?? "", /audit-render/);
});

test("G：meta 数字与基线的差只报数（不判）", () => {
  const baselines: Baselines = {
    anchor: [{ doc: "fixture", engineCount: 27 }],
    numberingCross: [],
    suspicious: [],
    numbering: [],
  };
  const g = detectBaselineDrift({ stats: { questions: 30 } }, "fixture", baselines);
  assert.equal(g.hits, 1);
  assert.match(g.samples[0]!.detail, /Δ\+3/);
});

test("listProductionDocs：跳 -OXR/-MinerU 与非文档目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "l1-docs-"));
  try {
    for (const name of ["册A", "册A-OXR", "册A-MinerU", "bank", "tags"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "layout.json"), "{}", "utf8");
    }
    assert.deepEqual(listProductionDocs(dir), ["册A"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("裁定台账：每条命中一行（含 bbox/text/evidence/verdict/basis/ruleRef），stray} 保持待判", () => {
  const root = mkdtempSync(join(tmpdir(), "l1-judgements-"));
  try {
    mkdirSync(join(root, "册A"), { recursive: true });
    writeFileSync(
      join(root, "册A", "layout.json"),
      JSON.stringify(onePageLayout("}.重力加速度为g,不考虑空气阻力的影响")),
      "utf8",
    );
    const { docScans, report } = scanAll(["册A"], root);
    const j = buildJudgements(docScans, report.generatedAt);
    const b = j.entries.find((e) => e.class === "B");
    assert.ok(b, "应有 B 类命中行");
    for (const k of ["class", "id", "doc", "page", "bbox", "text", "kind", "evidence", "verdict", "basis"]) {
      assert.ok(k in b, `缺字段 ${k}`);
    }
    assert.equal(b.verdict, "待判", "折行切裂括号须人工回原卷，规则不得自动裁定");
    assert.equal(b.ruleRef, "R-B-003");
    assert.equal(b.text.slice(0, 1), "}", "text 保留可核对原文");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：默认 exit 0；--fail-on-hit 有命中 exit 1；JSON+Markdown+judgements 落盘", () => {
  const root = mkdtempSync(join(tmpdir(), "l1-cli-"));
  try {
    mkdirSync(join(root, "册A"));
    writeFileSync(
      join(root, "册A", "layout.json"),
      JSON.stringify(onePageLayout("2023 北京卷 [人教版必修二 P74 图 8.1-1 拓展变式] 一物体在力 F 作用下")),
      "utf8",
    );
    const out = join(root, "out");
    const run = (extra: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-defects.ts", "--root", root, "--out", out, ...extra], {
        encoding: "utf8",
      });
    const r1 = run([]);
    assert.equal(r1.status, 0, `${r1.stdout}${r1.stderr}`);
    assert.ok(existsSync(join(out, "result.json")), "result.json 应落盘");
    const judgements = JSON.parse(readFileSync(join(out, "judgements.json"), "utf8")) as {
      entries: { id: string; verdict: string }[];
    };
    assert.ok(judgements.entries.length >= 1, "judgements.json 应含命中行");
    const md = readFileSync(join(out, "report.md"), "utf8");
    assert.match(md, /无题号真题块/);
    assert.match(md, /退出码/);

    const r2 = run(["--fail-on-hit"]);
    assert.equal(r2.status, 1, "有命中时 --fail-on-hit 应 exit 1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
