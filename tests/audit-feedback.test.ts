// tests/audit-feedback.test.ts —— 经验回流闭环（裁定台账 → 规则归纳 → 回放防退化）
//
// 命题：AI/人把裁定落进 judgements.json 后，归纳器①统计「已判/待判」与
// AI 裁定率（=待判数/总命中）；②对 verdict 已定的条目按 class+形态聚类，
// ≥3 条同形态生成规则候选；③回放历史裁定，一致率 100% 才标「可上线」，
// 有冲突标「冲突待裁」。规则候选只出报告，**不自动上线**。
//
// 夹具全部合成，不碰真实产物（L4/L5）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFECT_RULES, RULES_VERSION, matchDefectRule } from "../scripts/defect-rules.js";
import {
  computeStats,
  induceCandidates,
  renderCandidatesMarkdown,
  renderFeedbackReport,
  type JudgementEntry,
} from "../scripts/audit-feedback.js";

function entry(p: Partial<JudgementEntry> & { id: string }): JudgementEntry {
  return {
    class: "B",
    doc: "册A",
    page: 1,
    bbox: null,
    text: "残留文本",
    kind: "B-blankNoise",
    evidence: "data/out/册A/layout.json",
    verdict: "伪影",
    basis: "手册 §1-B",
    ...p,
  };
}

test("初始规则库：手册 §1 七类各有判据；B 按形态细分，stray} 不得自动裁定", () => {
  assert.equal(RULES_VERSION, 1);
  const classes = new Set(DEFECT_RULES.map((r) => r.class));
  for (const c of ["A", "B", "C", "D", "E", "F", "G"]) assert.ok(classes.has(c), `缺 ${c} 类规则`);

  assert.equal(matchDefectRule({ class: "A", kind: "A-内容级未覆盖" })?.verdict, "口径");
  assert.equal(matchDefectRule({ class: "B", kind: "B-smiles" })?.verdict, "伪影");
  assert.equal(matchDefectRule({ class: "B", kind: "B-blankNoise" })?.verdict, "伪影");
  // 折行切裂括号：形态不足以裁定，规则必须要求人工回原卷
  assert.equal(matchDefectRule({ class: "B", kind: "B-stray}" })?.verdict, "待判");
  assert.equal(matchDefectRule({ class: "X" }), undefined, "未知类不得命中");
});

test("computeStats：已判/待判与 AI 裁定率=待判/总命中", () => {
  const entries = [
    entry({ id: "1", verdict: "伪影" }),
    entry({ id: "2", verdict: "真丢" }),
    entry({ id: "3", verdict: "待判" }),
    entry({ id: "4", class: "C", kind: "C1", verdict: "误报" }),
  ];
  const s = computeStats(entries);
  assert.equal(s.total, 4);
  assert.equal(s.decided, 3);
  assert.equal(s.pending, 1);
  assert.equal(s.aiRate, 0.25);
  assert.equal(s.perClass.B?.pending, 1);
  assert.equal(s.perClass.C?.decided, 1);
});

test("归纳：≥3 条同 class+同形态 ⇒ 一条候选，回放 100% 标「可上线」", () => {
  const entries = [
    entry({ id: "a", kind: "B-新形态", verdict: "伪影" }),
    entry({ id: "b", kind: "B-新形态", verdict: "伪影" }),
    entry({ id: "c", kind: "B-新形态", verdict: "伪影" }),
  ];
  const cands = induceCandidates(entries);
  assert.equal(cands.length, 1);
  const c = cands[0]!;
  assert.equal(c.class, "B");
  assert.equal(c.form, "B-新形态");
  assert.equal(c.verdict, "伪影");
  assert.equal(c.supportIds.length, 3);
  assert.equal(c.replayTotal, 3);
  assert.equal(c.replayAgree, 3);
  assert.deepEqual(c.conflicts, []);
  assert.equal(c.status, "可上线");
});

test("防退化：同形态里混一条不同裁定 ⇒ 候选标「冲突待裁」并列出冲突条目", () => {
  const entries = [
    entry({ id: "a", kind: "C-新形态", verdict: "真丢" }),
    entry({ id: "b", kind: "C-新形态", verdict: "真丢" }),
    entry({ id: "c", kind: "C-新形态", verdict: "真丢" }),
    entry({ id: "d", kind: "C-新形态", verdict: "误报" }),
  ];
  const cands = induceCandidates(entries);
  assert.equal(cands.length, 1);
  const c = cands[0]!;
  assert.equal(c.verdict, "真丢", "多数裁定作为候选 verdict");
  assert.equal(c.replayTotal, 4);
  assert.equal(c.replayAgree, 3);
  assert.equal(c.conflicts.length, 1);
  assert.equal(c.conflicts[0]!.id, "d");
  assert.equal(c.status, "冲突待裁");
});

test("归纳门槛：<3 条不生成候选；minSupport 可调", () => {
  const two = [entry({ id: "a", kind: "D-x" }), entry({ id: "b", kind: "D-x" })];
  assert.equal(induceCandidates(two).length, 0);
  const cands = induceCandidates(two, { minSupport: 2 });
  assert.equal(cands.length, 1);
});

test("去重：与线上规则同 class+同形态+同 verdict 的候选标「已有规则覆盖」", () => {
  const entries = [
    entry({ id: "a", kind: "B-blankNoise", verdict: "伪影" }),
    entry({ id: "b", kind: "B-blankNoise", verdict: "伪影" }),
    entry({ id: "c", kind: "B-blankNoise", verdict: "伪影" }),
  ];
  const cands = induceCandidates(entries);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.status, "已有规则覆盖");
  assert.match(cands[0]!.coveredBy ?? "", /^R-B-/);
});

test("渲染：报告含基线公式与候选状态；候选 md 含 support/回放/冲突", () => {
  const entries = [
    entry({ id: "a", kind: "E-title", verdict: "真丢" }),
    entry({ id: "b", kind: "E-title", verdict: "真丢" }),
    entry({ id: "c", kind: "E-title", verdict: "真丢" }),
    entry({ id: "p", verdict: "待判" }),
  ];
  const stats = computeStats(entries);
  const cands = induceCandidates(entries);
  const report = renderFeedbackReport(stats, cands, {
    judgementsPath: "tmp/l1-defects/judgements.json",
    rulesVersion: RULES_VERSION,
  });
  assert.match(report, /AI 裁定率/);
  assert.match(report, /待判数\s*\/\s*总命中/);
  assert.match(report, /25\.00%/);
  const md = renderCandidatesMarkdown(cands);
  assert.match(md, /E-title/);
  assert.match(md, /可上线/);
});

test("CLI：读 judgements.json → 落 rule-candidates.md + feedback-report.md，恒 exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "l1-fb-"));
  try {
    const j = join(dir, "judgements.json");
    writeFileSync(
      j,
      JSON.stringify({
        rulesVersion: 1,
        generatedAt: "2026-11-20T00:00:00.000Z",
        entries: [
          entry({ id: "a", kind: "G-口径", verdict: "口径" }),
          entry({ id: "b", kind: "G-口径", verdict: "口径" }),
          entry({ id: "c", kind: "G-口径", verdict: "口径" }),
        ],
      }),
      "utf8",
    );
    const out = join(dir, "out");
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/audit-feedback.ts", "--judgements", j, "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(existsSync(join(out, "rule-candidates.md")));
    assert.ok(existsSync(join(out, "feedback-report.md")));
    assert.match(r.stdout, /AI 裁定率/);
    const report = readFileSync(join(out, "feedback-report.md"), "utf8");
    assert.match(report, /G-口径/);
    assert.match(report, /可上线/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});