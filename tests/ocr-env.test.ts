// ocr-env.test.ts —— OCR 运行环境可用 UVX_BIN 覆盖（换机/CI 不改代码）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { uvxBin } from "../scripts/ocr-lib.js";

test("uvxBin：默认本机路径，UVX_BIN 可覆盖并 trim", () => {
  const old = process.env.UVX_BIN;
  try {
    delete process.env.UVX_BIN;
    assert.equal(uvxBin(), "/Users/john/.local/bin/uvx");
    process.env.UVX_BIN = "/tmp/uvx-test";
    assert.equal(uvxBin(), "/tmp/uvx-test");
    process.env.UVX_BIN = "  /tmp/uvx-trim  ";
    assert.equal(uvxBin(), "/tmp/uvx-trim");
  } finally {
    if (old === undefined) delete process.env.UVX_BIN;
    else process.env.UVX_BIN = old;
  }
});
