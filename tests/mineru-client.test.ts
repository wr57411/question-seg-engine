/**
 * mineru-client.test.ts —— MinerU 客户端离线用例
 *
 * 全部通过注入的 transport 伪造 fetch，不触碰网络；字段名/响应形态
 * 以 docs/real-api-notes.md 的实测记录为准：
 *   - 请求体 files[].name（实测：不是 fileName）
 *   - 轮询 zip 下载字段 data.extract_result[].full_zip_url（实测：不是 file_url）
 *   - 业务错误 HTTP 恒 200 + code != 0（客户端不能只看 HTTP 状态码）
 * 运行：node --import tsx --test "tests/mineru-client.test.ts"
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MineruClient } from "../src/mineru/client.js";

const sampleRes = JSON.parse(
  readFileSync(new URL("./fixtures/upload-response.sample.json", import.meta.url), "utf8"),
);

test("createUpload：解析真实字段并返回 batchId / putUrl；请求体用 files[].name", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(sampleRes), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "test-key" }, transport);
  const batch = await client.createUpload({ fileName: "a.pdf", size: 123 });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/file-urls\/batch$/);
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "Bearer test-key");
  // 实测键名必须是 name（首探 fileName 得 code:-10002），且 fileSize 为字节数
  const body = JSON.parse(String(calls[0]!.init!.body)) as { files: Array<{ name: string; fileSize: number }> };
  assert.deepEqual(body.files, [{ name: "a.pdf", fileSize: 123 }]);
  assert.equal(batch.batchId, "45506cd0-429a-4e5b-9d10-9b27a07828ec");
  assert.match(batch.putUrl, /^https?:\/\//);
});

test("pollResult：按 notes 状态轮询至完成并返回 zipUrl（full_zip_url）", async () => {
  const states = ["waiting-file", "pending", "running", "done"];
  const transport = (async (_url: string, _init?: RequestInit) => {
    const state = states.shift() ?? "done";
    const body: Record<string, unknown> = {
      code: 0,
      msg: "ok",
      data: {
        batch_id: "45506cd0-429a-4e5b-9d10-9b27a07828ec",
        extract_result: state === "done"
          ? [{ file_name: "a.pdf", state, err_msg: "", full_zip_url: "https://mineru.net/zip/abc.zip" }]
          : [{ file_name: "a.pdf", state, err_msg: "" }],
      },
    };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "k" }, transport);
  const r = await client.pollResult("b1", { intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.zipUrl, "https://mineru.net/zip/abc.zip");

  // 永不完成的 pending 态 → 触发轮询超时
  const pendingTransport = (async () => new Response(
    JSON.stringify({ code: 0, msg: "ok", data: { batch_id: "b2", extract_result: [{ state: "pending" }] } }),
    { status: 200 },
  )) as unknown as typeof fetch;
  const client2 = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "k" }, pendingTransport);
  await assert.rejects(() => client2.pollResult("b2", { intervalMs: 1, timeoutMs: 50 }), /轮询超时/);
});

test("业务错误：HTTP 200 但 code != 0 时抛错（createUpload 与 pollResult 均适用）", async () => {
  const errBody = { code: -10002, msg: "field \"files[0].name\" is not set", trace_id: "x".repeat(32) };
  const transport = (async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(errBody), { status: 200 })) as unknown as typeof fetch;

  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "k" }, transport);
  await assert.rejects(() => client.createUpload({ fileName: "a.pdf", size: 1 }), /code=-10002/);
  await assert.rejects(() => client.pollResult("b1", { intervalMs: 1, timeoutMs: 500 }), /code=-10002/);
});

test("pollResult：failed 态抛错，完成态缺 full_zip_url 抛错", async () => {
  const body = {
    code: 0,
    msg: "ok",
    data: { batch_id: "b1", extract_result: [{ file_name: "a.pdf", state: "failed", err_msg: "boom" }] },
  };
  const transport = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "k" }, transport);
  await assert.rejects(() => client.pollResult("b1", { intervalMs: 1, timeoutMs: 500 }), /解析任务失败/);

  const body2 = {
    code: 0,
    msg: "ok",
    data: { batch_id: "b1", extract_result: [{ file_name: "a.pdf", state: "done", err_msg: "" }] },
  };
  const transport2 = (async () => new Response(JSON.stringify(body2), { status: 200 })) as unknown as typeof fetch;
  const client2 = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "k" }, transport2);
  await assert.rejects(() => client2.pollResult("b1", { intervalMs: 1, timeoutMs: 500 }), /未找到 zip 下载地址/);
});