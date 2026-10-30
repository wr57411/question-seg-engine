// tests/audit-topic.test.ts
/**
 * `audit:topic` 的反向验证：干净夹具必须通过；**索引被改、源被删、图片丢失、stats 说谎
 * 都必须变红**（每一类都单独实测，不是靠「审计脚本能跑通」说明它有效）。
 *
 * 夹具索引由 `topic:export` 生成（测试只负责造源数据），审计脚本自身不 import 导出实现。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { auditTopicIndex } from "../scripts/audit-topic.js";
import { buildTopicIndex, writeTopicIndex, writeTopicExportStatus } from "../scripts/topic-export.js";

function writeJson(file: string, json: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`, "utf8");
}

function makeRoot(opts: { writeIndex?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "audit-topic-"));
  const out = join(root, "data", "out");
  writeJson(join(out, "quizA", "questions.json"), [
    {
      id: "quizA:p0:q0",
      number: "1",
      stem: "题干一 这是题干",
      options: [{ key: "A", text: "选项 A" }],
      images: [{ path: "a.png", bbox: [1, 2, 3, 4] }],
      status: "ok",
      confidence: 1,
      source: { pageIndex: 0 },
    },
  ]);
  mkdirSync(join(out, "quizA", "images"), { recursive: true });
  writeFileSync(join(out, "quizA", "images", "a.png"), "png");
  writeJson(join(out, "bank", "bank.json"), [
    {
      quizId: "quizA:p0:q0",
      answerDoc: "answerA",
      answerKey: "A",
      answerText: "解析一",
      answerImages: [{ path: "ans.png", bbox: [5, 6, 7, 8] }],
    },
  ]);
  mkdirSync(join(out, "answerA", "images"), { recursive: true });
  writeFileSync(join(out, "answerA", "images", "ans.png"), "png");
  writeJson(join(out, "tags", "library.json"), {
    version: 1,
    tags: [{ id: "t-ping", name: "平抛运动#基础", short: "平基", color: "#2F6B4F" }],
  });
  writeJson(join(out, "tags", "quizA.json"), {
    version: 1,
    bindings: [
      { questionId: "quizA:p0:q0", tagIds: ["t-ping"], anchor: { number: "1", page: 1, firstText: "题干一这是题干" } },
    ],
    stale: [],
  });

  if (opts.writeIndex === false) return root;
  const { index, errors } = buildTopicIndex(root);
  assert.deepEqual(errors, []);
  assert.ok(index);
  writeTopicIndex(root, index);
  writeTopicExportStatus(root, {
    ok: true,
    at: new Date().toISOString(),
    errors: [],
    warnings: [],
    indexGeneratedAt: index.generatedAt,
  });
  return root;
}

const indexFile = (root: string): string => join(root, "data", "out", "topics", "index.json");
const patchIndex = (root: string, mutate: (json: any) => void): void => {
  const json = JSON.parse(readFileSync(indexFile(root), "utf8"));
  mutate(json);
  writeFileSync(indexFile(root), JSON.stringify(json, null, 1), "utf8");
};

test("干净夹具：审计通过，并给出独立重算的摘要", () => {
  const root = makeRoot();
  const { errors, summary } = auditTopicIndex(root);
  assert.deepEqual(errors, []);
  assert.ok(summary);
  assert.equal(summary.items, 1);
  assert.equal(summary.needsReview, 0);
  assert.deepEqual(summary.topics, [{ name: "平抛运动", items: 1, byLevel: { 基础: 1, 培优: 0 } }]);
});

test("反向：索引少一条 ⇒ 红（不是只看 stats）", () => {
  const root = makeRoot();
  patchIndex(root, (json) => {
    json.topics[0].items = [];
  });
  const { errors } = auditTopicIndex(root);
  assert.ok(errors.some((e) => e.includes("索引缺少条目")), errors.join("\n"));
});

test("反向：索引题干被改 ⇒ 红（逐条回源比对）", () => {
  const root = makeRoot();
  patchIndex(root, (json) => {
    json.topics[0].items[0].stem = "被改过的题干";
  });
  const { errors } = auditTopicIndex(root);
  assert.ok(errors.some((e) => e.startsWith("题干不一致")), errors.join("\n"));
});

test("反向：题图文件被删 ⇒ 红", () => {
  const root = makeRoot();
  rmSync(join(root, "data", "out", "quizA", "images", "a.png"));
  const { errors } = auditTopicIndex(root);
  assert.ok(errors.some((e) => e.startsWith("缺图：")), errors.join("\n"));
});

test("反向：答案被删 ⇒ 红", () => {
  const root = makeRoot();
  writeJson(join(root, "data", "out", "bank", "bank.json"), []);
  const { errors } = auditTopicIndex(root);
  assert.ok(errors.some((e) => e.startsWith("缺答案：")), errors.join("\n"));
});

test("反向：stats 说谎 ⇒ 红", () => {
  const root = makeRoot();
  patchIndex(root, (json) => {
    json.stats.items = 99;
  });
  const { errors } = auditTopicIndex(root);
  assert.ok(errors.some((e) => e.includes("stats.items 说谎")), errors.join("\n"));
});

test("反向：索引缺文件 ⇒ 红并指路", () => {
  const root = makeRoot();
  rmSync(indexFile(root));
  const { errors, summary } = auditTopicIndex(root);
  assert.equal(summary, null);
  assert.match(errors[0] ?? "", /topic:export/);
});

test("审计独立性：手工写出的合格 index 也能通过（不是拿导出再跑一遍）", () => {
  const root = makeRoot({ writeIndex: false });
  const generatedAt = "2026-10-30T00:00:00.000Z";
  writeJson(indexFile(root), {
    version: 1,
    generatedAt,
    topics: [
      {
        slug: "平抛运动",
        name: "平抛运动",
        items: [
          {
            doc: "quizA",
            number: "1",
            page: 1,
            questionId: "quizA:p0:q0",
            level: "基础",
            stem: "题干一 这是题干",
            options: [{ key: "A", text: "选项 A" }],
            images: [{ path: "a.png", bbox: [1, 2, 3, 4] }],
            answerKey: "A",
            answerText: "解析一",
            answerDoc: "answerA",
            answerImages: [{ doc: "answerA", path: "ans.png", bbox: [5, 6, 7, 8] }],
            status: "ok",
            confidence: 1,
            reviewFlags: [],
            sources: ["tag"],
          },
        ],
      },
    ],
    stats: { topics: 1, items: 1, needsReview: 0, byLevel: { 基础: 1, 培优: 0 } },
  });
  writeJson(join(root, "data", "out", "topics", "export-status.json"), {
    ok: true,
    at: generatedAt,
    errors: [],
    warnings: [],
    indexGeneratedAt: generatedAt,
  });
  const { errors } = auditTopicIndex(root);
  assert.deepEqual(errors, []);
});

test("反向：上次导出失败 / 缺导出状态 ⇒ 红（旧数据不能冒充本次结果）", () => {
  const root = makeRoot();
  writeJson(join(root, "data", "out", "topics", "export-status.json"), {
    ok: false,
    at: new Date().toISOString(),
    errors: ["缺图：模拟"],
    indexGeneratedAt: JSON.parse(readFileSync(indexFile(root), "utf8")).generatedAt,
  });
  assert.ok(auditTopicIndex(root).errors.some((e) => e.includes("上次导出失败")), "ok:false 必须红");

  const root2 = makeRoot();
  rmSync(join(root2, "data", "out", "topics", "export-status.json"));
  assert.ok(auditTopicIndex(root2).errors.some((e) => e.includes("export-status.json")), "缺状态必须红");
});

test("反向：答案来源册 / 答案图 doc 被改 ⇒ 红", () => {
  const root = makeRoot();
  patchIndex(root, (json) => {
    json.topics[0].items[0].answerDoc = "另一本答案册";
  });
  assert.ok(auditTopicIndex(root).errors.some((e) => e.includes("答案来源册不一致")), "answerDoc 必须核对");

  const root2 = makeRoot();
  patchIndex(root2, (json) => {
    json.topics[0].items[0].answerImages[0].doc = "quizA";
  });
  assert.ok(auditTopicIndex(root2).errors.some((e) => e.includes("答案图字段不一致")), "答案图 doc 必须核对");
});

test("反向：sources / confidence 被改 ⇒ 红", () => {
  const root = makeRoot();
  patchIndex(root, (json) => {
    json.topics[0].items[0].sources = ["manual"];
  });
  assert.ok(auditTopicIndex(root).errors.some((e) => e.includes("来源不一致")), "sources 必须核对");

  const root2 = makeRoot();
  patchIndex(root2, (json) => {
    json.topics[0].items[0].confidence = 0.5;
  });
  assert.ok(auditTopicIndex(root2).errors.some((e) => e.includes("置信度不一致")), "confidence 必须核对");
});

test("反向：源标签 anchor 漂移 ⇒ 红（不把标签挂到别的题上）", () => {
  const root = makeRoot();
  const tagsFile = join(root, "data", "out", "tags", "quizA.json");
  const tags = JSON.parse(readFileSync(tagsFile, "utf8"));
  tags.bindings[0].anchor.page = 9;
  writeFileSync(tagsFile, JSON.stringify(tags, null, 1), "utf8");
  assert.ok(auditTopicIndex(root).errors.some((e) => e.startsWith("标签漂移：")), "漂移必须红");
});

test("反向：源题干为空 ⇒ 红（即使 index 也跟着为空）", () => {
  const root = makeRoot();
  const qFile = join(root, "data", "out", "quizA", "questions.json");
  const questions = JSON.parse(readFileSync(qFile, "utf8"));
  questions[0].stem = " ";
  writeFileSync(qFile, JSON.stringify(questions, null, 1), "utf8");
  assert.ok(auditTopicIndex(root).errors.some((e) => e.startsWith("缺题干：")), "空题干必须红");
});

test("反向：源选项文本为空 ⇒ 红（审计要能发现导出前的空选项）", () => {
  const root = makeRoot();
  const qFile = join(root, "data", "out", "quizA", "questions.json");
  const questions = JSON.parse(readFileSync(qFile, "utf8"));
  questions[0].options = [{ key: "A", text: "  " }];
  writeFileSync(qFile, JSON.stringify(questions, null, 1), "utf8");
  assert.ok(auditTopicIndex(root).errors.some((e) => e.includes("选项文本为空")), "空选项必须红");
});

test("反向：专题标签在 stale / 标签库丢失 ⇒ 红", () => {
  const root = makeRoot();
  const tagsFile = join(root, "data", "out", "tags", "quizA.json");
  const tags = JSON.parse(readFileSync(tagsFile, "utf8"));
  tags.stale.push(tags.bindings.shift());
  writeFileSync(tagsFile, JSON.stringify(tags, null, 1), "utf8");
  assert.ok(auditTopicIndex(root).errors.some((e) => e.startsWith("标签失效（stale）：")), "stale 必须红");

  const root2 = makeRoot();
  rmSync(join(root2, "data", "out", "tags", "library.json"));
  assert.ok(auditTopicIndex(root2).errors.some((e) => e.startsWith("标签库缺失：")), "库丢失必须红");
});

test("anchor 首行太短 ⇒ 审计告警（不阻断，但必须让人看见）", () => {
  const root = makeRoot();
  const tagsFile = join(root, "data", "out", "tags", "quizA.json");
  const tags = JSON.parse(readFileSync(tagsFile, "utf8"));
  tags.bindings[0].anchor.firstText = "题";
  writeFileSync(tagsFile, JSON.stringify(tags, null, 1), "utf8");
  const r = auditTopicIndex(root);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("有效字符不足 6 个")), r.warnings.join("\n"));
});
