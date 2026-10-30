// tests/topic-export.test.ts
/**
 * 专题导出（scripts/topic-export.ts）的最小夹具单测。
 *
 * 反向验证（「必红」不是口头承诺，逐条实测）：
 * - 缺题：标签指向快照里不存在的 questionId ⇒ errors 含「缺题」；
 * - 缺答案：bank.json 没有该题 ⇒ errors 含「缺答案」；
 * - 缺图：题图/答案图文件不存在 ⇒ errors 含「缺图」；
 * - 数量歧义：手工题单只给 number 且重号 ⇒ errors 含「题号歧义」（不猜）；
 * - 层级冲突：同一题在同一专题里既标基础又标培优 ⇒ errors 含「层级冲突」；
 * - CLI 退出码：上述任一问题都必须让 `topic:export` 以 1 退出（不落半成品 index）。
 *
 * 正向不变量：
 * - 非专题标签（无 `#`）完全不影响结果；
 * - 标签 + 手工题单指向同一题 ⇒ 同一专题里恰好一条（来源合并为 tag/manual）；
 * - needs_review 照收，reviewFlags 带原因（stages.json 无原因时退回通用说明）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTopicIndex, disappearedWarnings, parseTopicTag, writeTopicIndex } from "../scripts/topic-export.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface Fixture {
  root: string;
  /** 直接改夹具里的 JSON（写回磁盘） */
  patch(rel: string, mutate: (json: any) => void): void;
  write(rel: string, json: unknown): void;
}

function writeJson(file: string, json: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`, "utf8");
}

/** 基础夹具：两道题（一道 ok 带题图/答案图，一道 needs_review），标签 + 手工题单合并到同一专题。 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "topic-export-"));
  const out = join(root, "data", "out");

  const questions = [
    {
      id: "quizA:p0:q0",
      number: "1",
      stem: "题干一\n第二行保留换行",
      options: [{ key: "A", text: "选项 A" }],
      images: [{ path: "a.png", bbox: [1, 2, 3, 4] }],
      status: "ok",
      confidence: 1,
      source: { pageIndex: 0 },
    },
    {
      id: "quizA:p1:q1",
      number: "2",
      stem: "题干二 这是一道待复核题",
      options: [],
      images: [],
      status: "needs_review",
      confidence: 0.6,
      source: { pageIndex: 1 },
    },
  ];
  writeJson(join(out, "quizA", "questions.json"), questions);
  writeJson(join(out, "quizA", "stages.json"), {
    reviews: [{ questionId: "quizA:p1:q1", reason: "选项组数量异常：0 个选项" }],
  });
  mkdirSync(join(out, "quizA", "images"), { recursive: true });
  writeFileSync(join(out, "quizA", "images", "a.png"), "png-bytes");

  const bank = [
    {
      quizId: "quizA:p0:q0",
      answerDoc: "answerA",
      answerKey: "A",
      answerText: "解析一",
      answerImages: [{ path: "ans.png", bbox: [5, 6, 7, 8] }],
    },
    {
      quizId: "quizA:p1:q1",
      answerDoc: "answerA",
      answerKey: "B",
      answerText: "解析二",
      answerImages: [],
    },
  ];
  writeJson(join(out, "bank", "bank.json"), bank);
  mkdirSync(join(out, "answerA", "images"), { recursive: true });
  writeFileSync(join(out, "answerA", "images", "ans.png"), "png-bytes");

  // 面板新建的标签：库里存 {id,name}，绑定只存 id（专题约定写在 name 上）
  writeJson(join(out, "tags", "library.json"), {
    version: 1,
    tags: [
      { id: "t-ping", name: "平抛运动#基础", short: "平基", color: "#2F6B4F" },
      { id: "t-yuan", name: "圆周运动#培优", short: "圆培", color: "#7a2f86" },
      { id: "t-hao", name: "好题", short: "好", color: "#4d7c2f" },
    ],
  });
  writeJson(join(out, "tags", "quizA.json"), {
    version: 1,
    bindings: [
      {
        questionId: "quizA:p0:q0",
        // 非专题标签必须被忽略；t-hao 不是专题
        tagIds: ["t-ping", "t-hao"],
        anchor: { number: "1", page: 1, firstText: "题干一第二行保留换行" },
      },
      {
        questionId: "quizA:p1:q1",
        tagIds: ["t-yuan"],
        anchor: { number: "2", page: 2, firstText: "题干二这是一道待复核题" },
      },
    ],
    stale: [],
  });
  writeJson(join(out, "topics", "练习.topic.json"), {
    name: "平抛运动",
    items: [{ doc: "quizA", number: "1", level: "基础" }],
  });

  return {
    root,
    write(rel, json) {
      writeJson(join(root, rel), json);
    },
    patch(rel, mutate) {
      const file = join(root, rel);
      const json = JSON.parse(readFileSync(file, "utf8"));
      mutate(json);
      writeJson(file, json);
    },
  };
}

function errorsOf(fx: Fixture): string[] {
  const { index, errors } = buildTopicIndex(fx.root);
  // 有错就不应产出索引（不落半成品）
  assert.equal(index, null, `预期有错误，却得到 index：${JSON.stringify(index?.stats)}`);
  return errors;
}

test("标签库：绑定只存 id，导出按库里的 name 识别专题（UI 真实形状）", () => {
  const fx = makeFixture();
  const { index, errors } = buildTopicIndex(fx.root);
  assert.deepEqual(errors, []);
  const names = index!.topics.map((t) => t.name).sort();
  assert.deepEqual(names, ["圆周运动", "平抛运动"]);
});

test("兼容历史/种子：库里找不到的 tagId 按字面值解析", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].tagIds = ["平抛运动#基础"];
  });
  const { index, errors } = buildTopicIndex(fx.root);
  assert.deepEqual(errors, []);
  assert.ok(index!.topics.some((t) => t.name === "平抛运动"));
});

test("反向：标签漂移（anchor 页码对不上）⇒ 必红", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].anchor.page = 9;
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("标签漂移：")), errors.join("\n"));
});

test("anchor 首行太短 / 为空 ⇒ 告警（不阻断，但必须让人看见）", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].anchor.firstText = "题";
  });
  const r = buildTopicIndex(fx.root);
  assert.deepEqual(r.errors, [], "短 firstText 不阻断整本书导出");
  assert.ok(r.warnings.some((w) => w.includes("有效字符不足 6 个")), r.warnings.join("\n"));

  const fx2 = makeFixture();
  fx2.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].anchor.firstText = "";
  });
  const r2 = buildTopicIndex(fx2.root);
  assert.deepEqual(r2.errors, []);
  assert.ok(r2.warnings.some((w) => w.includes("缺少 firstText")), r2.warnings.join("\n"));
});

test("反向：专题标签被挪进 stale ⇒ 必红（不能在专题里静默消失）", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    const [b] = json.bindings.splice(0, 1);
    json.stale.push(b);
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("标签失效（stale）：")), errors.join("\n"));
});

test("反向：标签库缺 id / 库整个缺失 ⇒ 必红（不能当成非专题标签忽略）", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].tagIds = ["t-ghost"];
  });
  assert.ok(errorsOf(fx).some((e) => e.startsWith("标签库缺 id：")), "库在但 id 不存在必须红");

  const fx2 = makeFixture();
  fx2.patch("data/out/tags/library.json", (json) => {
    json.tags = json.tags.filter((t: any) => t.id !== "t-ping");
  });
  assert.ok(errorsOf(fx2).some((e) => e.startsWith("标签库缺 id：")), "删掉库里条目必须红");

  const fx3 = makeFixture();
  rmSync(join(fx3.root, "data", "out", "tags", "library.json"));
  assert.ok(errorsOf(fx3).some((e) => e.startsWith("标签库缺失：")), "库文件丢失必须红");
});

test("反向：空题干 ⇒ 必红（不允许导出成空气题）", () => {
  const fx = makeFixture();
  fx.patch("data/out/quizA/questions.json", (json) => {
    json[0].stem = "   ";
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("缺题干：")), errors.join("\n"));
});

test("反向：选项字段形状不对 / 选项文本为空 ⇒ 必红", () => {
  const fx = makeFixture();
  fx.patch("data/out/quizA/questions.json", (json) => {
    json[0].options = { key: "A", text: "坏的形状" };
  });
  assert.ok(errorsOf(fx).some((e) => e.includes("选项字段不是数组")), "选项非数组必须报错");

  const fx2 = makeFixture();
  fx2.patch("data/out/quizA/questions.json", (json) => {
    json[0].options = [{ key: "A", text: "  " }];
  });
  assert.ok(errorsOf(fx2).some((e) => e.includes("选项文本为空")), "选项空文本必须报错");
});

test("约定解析：# 分隔、层级白名单、非专题标签不受影响", () => {
  assert.deepEqual(parseTopicTag("平抛运动#基础"), { kind: "ok", name: "平抛运动", level: "基础" });
  assert.deepEqual(parseTopicTag("圆周运动#培优"), { kind: "ok", name: "圆周运动", level: "培优" });
  assert.deepEqual(parseTopicTag("t-hao"), { kind: "not-topic" });
  assert.equal(parseTopicTag("#基础").kind, "invalid");
  assert.equal(parseTopicTag("平抛运动#提高").kind, "invalid");
  assert.equal(parseTopicTag("平抛运动#").kind, "invalid");
});

test("导出守恒：标签 + 手工题单指向同一题 ⇒ 每专题每题恰好一条，来源合并", () => {
  const fx = makeFixture();
  const { index, errors } = buildTopicIndex(fx.root);
  assert.deepEqual(errors, []);
  assert.ok(index);
  assert.equal(index.stats.topics, 2);
  assert.equal(index.stats.items, 2);
  assert.equal(index.stats.needsReview, 1);
  assert.deepEqual(index.stats.byLevel, { 基础: 1, 培优: 1 });

  const flat = index.topics.find((t) => t.name === "平抛运动");
  assert.ok(flat);
  assert.equal(flat.items.length, 1, "同一题不能因为两路输入出现两次");
  const item = flat.items[0]!;
  assert.deepEqual(item.sources, ["manual", "tag"]);
  assert.equal(item.level, "基础");
  assert.equal(item.stem, "题干一\n第二行保留换行");
  assert.equal(item.page, 1, "pageIndex 0 ⇒ 1 基页码 1");
  assert.equal(item.images.length, 1);
  assert.deepEqual(item.answerImages.map((x) => x.doc), ["answerA"]);
  assert.equal(item.answerKey, "A");
  assert.equal(item.answerDoc, "answerA");

  const round = index.topics.find((t) => t.name === "圆周运动");
  assert.ok(round);
  const flagged = round.items[0]!;
  assert.equal(flagged.status, "needs_review");
  assert.deepEqual(flagged.reviewFlags, ["选项组数量异常：0 个选项"]);
  assert.equal(flagged.confidence, 0.6);
});

test("needs_review 无 stages 原因时退回通用说明（不静默）", () => {
  const fx = makeFixture();
  fx.patch("data/out/quizA/stages.json", (json) => {
    json.reviews = [];
  });
  const { index, errors } = buildTopicIndex(fx.root);
  assert.deepEqual(errors, []);
  const flagged = index!.topics.find((t) => t.name === "圆周运动")!.items[0]!;
  assert.deepEqual(flagged.reviewFlags, ["待复核（置信度 0.6）"]);
});

test("反向：标签指向不存在的题 ⇒ 缺题", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings.push({ questionId: "quizA:p9:q9", tagIds: ["平抛运动#基础"], anchor: { number: "9", page: 9 } });
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("缺题：") && e.includes("quizA:p9:q9")), errors.join("\n"));
});

test("反向：bank 里没有该题 ⇒ 缺答案", () => {
  const fx = makeFixture();
  fx.patch("data/out/bank/bank.json", (json) => {
    json.splice(
      json.findIndex((e: any) => e.quizId === "quizA:p0:q0"),
      1,
    );
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("缺答案：") && e.includes("quizA:p0:q0")), errors.join("\n"));
});

test("反向：题图文件不存在 ⇒ 缺图", () => {
  const fx = makeFixture();
  fx.patch("data/out/quizA/questions.json", (json) => {
    json[0].images = [{ path: "not-there.png", bbox: [1, 2, 3, 4] }];
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("缺图：") && e.includes("not-there.png")), errors.join("\n"));
});

test("反向：答案图文件不存在 ⇒ 缺图", () => {
  const fx = makeFixture();
  fx.patch("data/out/bank/bank.json", (json) => {
    json[0].answerImages = [{ path: "ans-missing.png", bbox: [1, 2, 3, 4] }];
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("缺图：") && e.includes("ans-missing.png")), errors.join("\n"));
});

test("反向：手工题单只给重号 ⇒ 题号歧义（不猜）", () => {
  const fx = makeFixture();
  fx.patch("data/out/quizA/questions.json", (json) => {
    json.push({
      id: "quizA:p2:q2",
      number: "1",
      stem: "同号题",
      options: [],
      images: [],
      status: "ok",
      confidence: 1,
      source: { pageIndex: 2 },
    });
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("题号歧义：")), errors.join("\n"));
});

test("反向：同题同专题两个层级 ⇒ 层级冲突", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].tagIds.push("平抛运动#培优");
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.startsWith("层级冲突：")), errors.join("\n"));
});

test("反向：含 # 但不合约定 ⇒ 报错（不静默忽略）", () => {
  const fx = makeFixture();
  fx.patch("data/out/tags/quizA.json", (json) => {
    json.bindings[0].tagIds.push("平抛运动#提高");
  });
  const errors = errorsOf(fx);
  assert.ok(errors.some((e) => e.includes("标签格式不合约定")), errors.join("\n"));
});

test("改名/摘掉 # 导致旧条目消失 ⇒ 告警（不阻断，但不静默）", () => {
  const fx = makeFixture();
  const first = buildTopicIndex(fx.root);
  assert.ok(first.index);
  writeTopicIndex(fx.root, first.index);
  const old = JSON.parse(readFileSync(join(fx.root, "data", "out", "topics", "index.json"), "utf8"));
  old.topics[0].items.push({
    doc: "quizA",
    number: "9",
    page: 1,
    questionId: "quizA:old",
    level: "基础",
    stem: "旧题",
    options: [],
    images: [],
    answerKey: "A",
    answerText: "旧",
    answerDoc: "answerA",
    answerImages: [],
    status: "ok",
    confidence: 1,
    reviewFlags: [],
    sources: ["tag"],
  });
  writeFileSync(join(fx.root, "data", "out", "topics", "index.json"), JSON.stringify(old, null, 1));

  const next = buildTopicIndex(fx.root);
  assert.ok(next.index);
  const warnings = disappearedWarnings(fx.root, next.index);
  assert.ok(warnings.some((w) => w.includes("专题条目消失") && w.includes("quizA:old")), warnings.join("\n"));
});

test("CLI：有缺答案 ⇒ 退出码 1 且不写 index.json", () => {
  const fx = makeFixture();
  fx.patch("data/out/bank/bank.json", (json) => {
    json.splice(
      json.findIndex((e: any) => e.quizId === "quizA:p0:q0"),
      1,
    );
  });
  const res = spawnSync(process.execPath, ["--import", "tsx", "scripts/topic-export.ts", "--root", fx.root], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(res.status, 1, `预期退出码 1，实际 ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /缺答案/);
  assert.equal(existsSync(join(fx.root, "data", "out", "topics", "index.json")), false, "失败时不能留下半成品 index.json");
  const statusFile = join(fx.root, "data", "out", "topics", "export-status.json");
  assert.equal(existsSync(statusFile), true, "失败也必须写导出状态（页面要能识别旧数据）");
  const status = JSON.parse(readFileSync(statusFile, "utf8"));
  assert.equal(status.ok, false);
  assert.ok(status.errors.some((e: string) => e.includes("缺答案")));
});
