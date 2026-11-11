// hole-read-oxr-filter.test.ts —— 问题⑤回归守卫：洞带墨量归属门。
// 期望：p027_h0 候选不再含 logo 渗入；其余 40 洞候选与 v1 逐字节一致。
// 数据依赖 data/out 产物（L4：缺数据时跳过，不空跑）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join("data/out", "答案册-合订本", "hole-read");
const HAS_DATA =
  existsSync(join(DATA, "oxr-v3-raw-batches/manifest.json")) &&
  existsSync(join(DATA, "oxr-v3-strips/p027_h0.pdf"));
const run = (args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", "scripts/hole-read-oxr-filter.ts", ...args], { encoding: "utf8" });

test("洞带墨量归属门：p027_h0 渗入被切除，其余 40 洞候选不变", { skip: !HAS_DATA }, () => {
  const out = run([]);
  assert.match(out, /候选变化 1\/41/);
  const v2 = JSON.parse(readFileSync(join(DATA, "oxr-v3-filtered-v2.json"), "utf8")) as {
    candidates: Record<string, string>;
  };
  assert.equal(v2.candidates["p027_h0"], "1. AD 必刷模型•传送带模型");
  assert.doesNotMatch(v2.candidates["p027_h0"], /提分/);
});
