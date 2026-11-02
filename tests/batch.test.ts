// batch.test.ts —— 批量导入 MVP 的集成测试：成功 / 失败隔离 / 重复投递不重复跑。
// 用 layout 夹具，不调 MinerU/OCR（--no-ocr），不依赖网络。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "tests", "fixtures", "layout.sample.json");

function runBatch(inbox: string, state: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/batch.ts", "--inbox", inbox, "--state", state, "--no-ocr", "--retry", "1"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
  );
}

function readLedger(state: string): { hash: string; docId: string; status: string; error?: string }[] {
  const p = join(state, "ledger.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { hash: string; docId: string; status: string; error?: string });
}

test("batch：正常两本 + 单本失败隔离 + 重复投递不重复跑", () => {
  const base = mkdtempSync(join(tmpdir(), "bgx-batch-"));
  const inbox = join(base, "inbox");
  const state = join(base, "state");
  const a = join(inbox, "bgx-batch-a");
  const b = join(inbox, "bgx-batch-b");
  const bad = join(inbox, "bgx-batch-bad");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  mkdirSync(bad, { recursive: true });
  copyFileSync(FIXTURE, join(a, "layout.json"));
  symlinkSync(FIXTURE, join(b, "layout.json")); // inbox 用符号链接投递也要能识别
  writeFileSync(join(bad, "layout.json"), "{ not json");

  try {
    const r1 = runBatch(inbox, state);
    assert.equal(r1.status, 1, "有失败书时批量应退出 1");
    const ledger = readLedger(state);
    const done = ledger.filter((e) => e.status === "done").map((e) => e.docId).sort();
    assert.deepEqual(done, ["bgx-batch-a", "bgx-batch-b"]);
    assert.ok(ledger.some((e) => e.status === "failed" && e.docId === "bgx-batch-bad"), "坏 layout 应记为 failed");
    assert.ok(existsSync(join(ROOT, "data", "out", "bgx-batch-a", "meta.json")), "成功的书应有 meta.json");
    assert.ok(existsSync(join(state, "report.md")), "应生成日报");

    const r2 = runBatch(inbox, state);
    assert.equal(r2.status, 0, "已完成/已失败均不再重跑，第二次应退出 0");
    const doneA = readLedger(state).filter((e) => e.docId === "bgx-batch-a" && e.status === "done");
    assert.equal(doneA.length, 1, "同哈希不应产生第二条 done");
  } finally {
    for (const id of ["bgx-batch-a", "bgx-batch-b", "bgx-batch-bad"]) {
      rmSync(join(ROOT, "data", "out", id), { recursive: true, force: true });
    }
    rmSync(base, { recursive: true, force: true });
  }
});
