// export-layout-required.test.ts —— M5-B（no-MinerU 生产化）：导出器不再有 MinerU 默认输入。
// 命题：export-stages 的骨架输入必须显式传参（argv[3]=layoutPath）——
//   缺省不再落 MinerU smoke layout（data/smoke/unpacked/layout.json），而是用法报错退出 2，
//   且**不写任何快照**（不静默失败、不拿别的源冒充本书骨架）。
// 跑法：真 spawn scripts/export-stages.ts（与 oxr-input.test.ts 同模式），测试 docId 隔离输出，
//   finally 清理，绝不碰生产快照。显式传参行为由 tests/oxr-input.test.ts（M1）继续锁。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOC_ID = "bgx-no-default-layout-test";

test("M5-B：只传 docId 缺 layoutPath ⇒ 退出 2 + 显式传参提示，且不写快照", () => {
  const outDir = join(ROOT, "data", "out", DOC_ID);
  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/export-stages.ts", DOC_ID],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
    );
    assert.notEqual(r.status, 0, `缺 layoutPath 不应成功导出（旧行为会落 MinerU smoke 默认）；stderr=${r.stderr}`);
    assert.equal(r.status, 2, "用法错误退出码 2（与 daily.ts 约定一致）");
    assert.match(r.stderr, /layoutPath/, "报错应点名 layoutPath 需显式传参");
    assert.match(r.stderr, /显式/, "报错应提示显式传参（不再有任何默认源）");
    assert.ok(!existsSync(join(outDir, "stages.json")), "缺输入时不得写快照（不静默拿默认源冒充）");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("M5-B：完全无参 ⇒ 同样用法报错（不再回退 MinerU smoke 默认卷）", () => {
  // 无参旧行为 = 默认 docId「23必刷题 2相互作用」+ smoke layout，会**覆写生产快照**；
  // 新行为必须在读任何 layout / 写任何产物之前报错退出。
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/export-stages.ts"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 },
  );
  assert.equal(r.status, 2, `无参应退出 2；status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /layoutPath/, "报错应点名 layoutPath");
});