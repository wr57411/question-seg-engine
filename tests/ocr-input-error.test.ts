// ocr-input-error.test.ts —— OCR 输入“存在但读不动”时必须可见，不能静默跳过。
//
// 背景（2026-10-28）：题号补行依赖 `ocr-fill.json` / `ocr-page-fill.json`。
// 文件缺失 = 未跑 OCR（合法，静默）；文件存在但解析失败 = 异常（会让补行静默失效、题数变少）。
// 本测试锁住 readOcrJsonFile 的区分，以及两个补行函数把错误带回调用方。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { injectOcrFullTextLines, injectOcrQuestionLines, readOcrJsonFile } from "../scripts/export-stages.js";
import type { ParsedDocument } from "../src/types.js";

function makeDoc(): ParsedDocument {
  return { docId: "t", pages: [{ index: 1, width: 596, height: 842, blocks: [] }] };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bgx-ocr-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readOcrJsonFile：文件缺失返回空且无错误", () => {
  withTempDir((dir) => {
    const r = readOcrJsonFile(join(dir, "missing.json"));
    assert.equal(r.json, null);
    assert.equal(r.error, null);
  });
});

test("readOcrJsonFile：损坏 JSON 返回错误而不是静默 null", () => {
  withTempDir((dir) => {
    const p = join(dir, "ocr-page-fill.json");
    writeFileSync(p, "{ not json", "utf8");
    const r = readOcrJsonFile(p);
    assert.equal(r.json, null);
    assert.match(r.error ?? "", /读取\/解析失败/);
    assert.match(r.error ?? "", /ocr-page-fill\.json/);
  });
});

test("injectOcrQuestionLines：损坏的 ocr-fill.json 错误带回调用方", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "ocr-fill.json"), "{bad", "utf8");
    const r = injectOcrQuestionLines(makeDoc(), dir);
    assert.equal(r.injected, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /ocr-fill\.json/);
  });
});

test("injectOcrFullTextLines：损坏的 ocr-page-fill.json 错误带回调用方", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "ocr-page-fill.json"), "{bad", "utf8");
    const r = injectOcrFullTextLines(makeDoc(), dir);
    assert.equal(r.injected, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /ocr-page-fill\.json/);
  });
});

test("injectOcrFullTextLines：结构异常（pages 不是数组）也要报错", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "ocr-page-fill.json"), JSON.stringify({ pages: {} }), "utf8");
    const r = injectOcrFullTextLines(makeDoc(), dir);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /pages 不是数组/);
  });
});

test("injectOcrFullTextLines：文件缺失不报错（未跑 OCR 是合法状态）", () => {
  withTempDir((dir) => {
    const r = injectOcrFullTextLines(makeDoc(), dir);
    assert.equal(r.injected, 0);
    assert.deepEqual(r.errors, []);
  });
});
