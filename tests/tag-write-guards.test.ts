// tag-write-guards.test.ts —— 本项目**第一条写路径**的守卫。
//
// 为什么必须有测试而不是"人 curl 一下"：守卫的作用是"下一次改动仍然挡住"。
// 判据取最严（lessons.md L2）：任何一条路径校验被放宽，后果是把一个任意文件名
// 拼进 fs.writeFile —— 那不是显示层 bug，是这台机器上的任意写。
// 用例锚定：① doc 必须是真实存在的快照目录名；② 路径分隔/`..`/控制字符/超长一律拒；
// ③ 载荷形状不合不落盘；④ 拼出的目标路径必须仍在 tags 目录内。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isKnownDoc, tagFilePath, tagsWriteEnabled, validatePayload } from "../scripts/tag-write-guards.js";

/** 造一个临时 ROOT，只放一个真卷的 stages.json（不依赖 data/ —— 它是 git 忽略的运行时产物）。 */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "tagguards-"));
  const docDir = join(root, "data", "out", "真卷甲");
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, "stages.json"), "{}");
  return root;
}

test("① 只有真实存在的快照目录名才是合法 doc", async () => {
  const root = fixtureRoot();
  assert.equal(await isKnownDoc(root, "真卷甲"), true);
  assert.equal(await isKnownDoc(root, "不存在的卷"), false);
});

test("② 路径穿越、分隔符、控制字符、空、超长一律拒", async () => {
  const root = fixtureRoot();
  const bad = [
    "",
    "../etc",
    "a/b",
    "a\\b",
    "..",
    "真卷甲/../../x",
    "真卷\u0000甲",
    "x\ny",
    "x\u007f",
    "甲".repeat(130),
    // 非字符串输入也不能放过
    null as unknown as string,
    undefined as unknown as string,
    42 as unknown as string,
  ];
  for (const d of bad) {
    assert.equal(await isKnownDoc(root, d), false, `必须拒绝 ${JSON.stringify(d)}`);
  }
});

test("③ 载荷形状不合即拒绝（version 只认 1，字段类型逐个看）", () => {
  assert.ok(validatePayload("真卷甲", { version: 2, bindings: [], stale: [] }));
  assert.ok(validatePayload("真卷甲", { version: 1, bindings: "x" }));
  assert.ok(validatePayload("真卷甲", { version: 1, bindings: [], stale: null }));
  assert.ok(validatePayload("真卷甲", { version: 1, bindings: [{ questionId: 1, tagIds: [] }], stale: [] }));
  assert.ok(validatePayload("真卷甲", { version: 1, bindings: [{ questionId: "a", tagIds: "t-hao" }], stale: [] }));
  assert.ok(validatePayload("真卷甲", "not an object"));
  assert.equal(validatePayload("真卷甲", { version: 1, bindings: [{ questionId: "a", tagIds: ["t-hao"] }], stale: [] }), null);
  // stale 与 bindings 同标准（它同样会落盘）
  assert.ok(validatePayload("真卷甲", { version: 1, bindings: [], stale: [{ questionId: "a", tagIds: [{}] }] }));
});

test("④ 标签库：字段齐全 + id 唯一才放行", () => {
  const ok = { id: "t-hao", name: "好题", short: "好", color: "#4d7c2f" };
  assert.equal(validatePayload("library", { version: 1, tags: [ok] }), null);
  assert.ok(validatePayload("library", { version: 1, tags: [{ ...ok, color: undefined }] }));
  assert.ok(validatePayload("library", { version: 1, tags: [ok, { ...ok }] }), "id 重复必须拒");
  assert.ok(validatePayload("library", { version: 1, tags: {} }));
});

test("⑤ 落盘目标必须仍在 tags 目录内", () => {
  const tagDir = join("/repo", "data", "out", "tags");
  assert.equal(tagFilePath(tagDir, "library", ""), join(tagDir, "library.json"));
  assert.equal(tagFilePath(tagDir, "", "真卷甲"), join(tagDir, "真卷甲.json"));
  // 万一上游白名单被放宽，这里仍是第二道防线
  assert.equal(tagFilePath(tagDir, "", "../../../etc/passwd"), null);
  assert.equal(tagFilePath(tagDir, "", "a/../../b"), null);
});


test("④ 标签写通道开关：默认开，TAGS_WRITE=0 关", () => {
  assert.equal(tagsWriteEnabled({}), true);
  assert.equal(tagsWriteEnabled({ TAGS_WRITE: "1" }), true);
  assert.equal(tagsWriteEnabled({ TAGS_WRITE: "0" }), false);
});
