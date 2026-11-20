// no-mineru-copy.test.ts —— M5-B（no-MinerU 生产化）：展示层「当前来源」文案锁。
// 命题：stages 阶段说明的 raw（原料）步文案如实描述多源管线
//   （OXR 读字 + 本地 PP-StructureV3 行框/表格 + 墨迹带坐标校准 + 原卷裁图兜底），
//   不再把 MinerU 说成当前解析来源（历史机制注释不在本锁范围，只锁用户可见文案）。
// 跑法：源码扫描（与 decoupling.test.ts 同模式）——stages.js 是 DOM 展示层文件，
//   不在 node:test 里 import 执行（主 tsconfig 无 DOM lib），只读文本断言文案。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("M5-B：stages.js raw 步文案 = 无-MinerU 如实多源口径", () => {
  const src = readFileSync(join(ROOT, "stages", "stages.js"), "utf8");
  assert.ok(!src.includes("解析程序（MinerU）"), "raw 步文案不应再把 MinerU 说成当前解析程序");
  const m = src.match(/raw:\s*\{\s*do:\s*"([^"]+)"/);
  assert.ok(m, "应能取到 EXPLAIN.raw.do 文案");
  const doText = m[1] ?? "";
  for (const want of ["OXR", "PP-StructureV3", "墨迹", "裁图"]) {
    assert.ok(doText.includes(want), `raw 步文案应如实提到多源之一「${want}」：${doText}`);
  }
  assert.ok(!doText.includes("MinerU"), `raw 步文案不应提 MinerU 为当前来源：${doText}`);
});