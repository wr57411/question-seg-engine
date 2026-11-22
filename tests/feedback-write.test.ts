// tests/feedback-write.test.ts
//
// 反馈写通道守卫的单测（scripts/feedback-write-guards.ts）。
// 与 tag-write-guards 同哲学：守卫拆出来就是为了能被单测打到；
// 「人记得 curl」从来不是回归防护。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEEDBACK_MAX_BODY,
  SHOT_MAX_BYTES,
  feedbackWriteEnabled,
  isKnownDoc,
  parseAction,
  parseShotDataUrl,
  shotFileName,
  validateCreatePayload,
  validateItemShape,
  validateMutationPayload,
  validateStoreShape,
} from "../scripts/feedback-write-guards.js";

const PNG_DATAURL =
  "data:image/png;base64," +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

test("通道开关：默认开；FEEDBACK_WRITE=0 关闭", () => {
  assert.equal(feedbackWriteEnabled({}), true);
  assert.equal(feedbackWriteEnabled({ FEEDBACK_WRITE: "0" }), false);
});

test("parseAction：只认 create/supplement/update，未知动作拒绝", () => {
  assert.equal(parseAction({ action: "create" }), "create");
  assert.equal(parseAction({ action: "supplement" }), "supplement");
  assert.equal(parseAction({ action: "update" }), "update");
  assert.equal(parseAction({ action: "delete" }), null);
  assert.equal(parseAction({}), null);
  assert.equal(parseAction(null), null);
});

test("doc 白名单：空/超长/路径字符拒绝（镜像 tag-write-guards 口径）", () => {
  assert.equal(isKnownDoc("/root", ""), false);
  assert.equal(isKnownDoc("/root", "a/b"), false);
  assert.equal(isKnownDoc("/root", ".."), false);
  assert.equal(isKnownDoc("/root", 123), false);
  assert.equal(isKnownDoc("/root", "x".repeat(121)), false);
});

test("截图 dataURL：png/jpeg 收，其它/空字节/超 8MB 拒", () => {
  const ok = parseShotDataUrl(PNG_DATAURL);
  assert.ok(ok && typeof ok === "object", "png dataURL 应通过并返回对象");
  if (ok && typeof ok === "object") assert.equal(ok.ext, "png");
  assert.equal(parseShotDataUrl("data:text/html;base64,AAAA"), "截图只支持 data:image/png 或 data:image/jpeg");
  const big = parseShotDataUrl("data:image/png;base64," + Buffer.alloc(9 * 1024 * 1024).toString("base64"));
  assert.equal(typeof big, "string");
  if (typeof big === "string") assert.ok(big.includes("上限"));
  assert.equal(parseShotDataUrl("data:image/png;base64,"), "截图内容为空");
  assert.equal(parseShotDataUrl(null), null); // 无截图=合法
});

test("create 载荷：comment 必填有上限，page/questionNumber 形状校验", () => {
  assert.equal(validateCreatePayload({ comment: "选项 B 文本显示异常" }), null);
  assert.equal(validateCreatePayload({ comment: "" }), "comment 不能为空");
  assert.equal(validateCreatePayload({ comment: "x".repeat(4001) }), "comment 超长");
  assert.equal(validateCreatePayload({ comment: "x", page: 6 }), null);
  assert.equal(validateCreatePayload({ comment: "x", page: "6" }), "page 必须是数字");
  assert.equal(validateCreatePayload({ comment: "x", questionNumber: 4 }), "questionNumber 必须是字符串");
  assert.equal(validateCreatePayload({}), "comment 不能为空");
  assert.equal(validateCreatePayload(null), "item 必须是对象");
});

test("mutation 载荷：supplement 用 text，update 用 comment，id 必填", () => {
  assert.equal(validateMutationPayload("supplement", { id: "fb-1", text: "补充一句" }), null);
  assert.equal(validateMutationPayload("supplement", { id: "fb-1", comment: "补充一句" }), "text 不能为空");
  assert.equal(validateMutationPayload("update", { id: "fb-1", comment: "改后的话" }), null);
  assert.equal(validateMutationPayload("update", { id: "", comment: "x" }), "id 必须是非空字符串");
});

test("item/store 形状：status 域受限，shot 类型校验", () => {
  const good = {
    id: "fb-20261122-1", docId: "册", comment: "c", status: "open",
    createdAt: "t", updatedAt: "t", supplements: [],
  };
  assert.equal(validateItemShape(good), null);
  const badStatus = { ...good, status: "archived" };
  assert.equal(validateItemShape(badStatus)?.includes("status"), true);
  assert.equal(validateItemShape({ ...good, id: "fb/../../etc" })?.includes("id"), true);
  assert.equal(validateItemShape({ ...good, supplements: "[]" })?.includes("supplements"), true);
  assert.equal(validateStoreShape({ version: 1, items: [good] }), null);
  assert.equal(validateStoreShape({ version: 2, items: [] }), "version 必须为 1");
});

test("文件名：id 已过字符校验后拼相对路径", () => {
  assert.equal(shotFileName("fb-20261122-abc", "png"), "shots/fb-20261122-abc.png");
});

test("上限常量：body 12MB / 截图 8MB（防无界输入）", () => {
  assert.equal(FEEDBACK_MAX_BODY, 12 * 1024 * 1024);
  assert.equal(SHOT_MAX_BYTES, 8 * 1024 * 1024);
});
