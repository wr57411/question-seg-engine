// audit-render-missing.test.ts —— 缺快照时 audit:render 不得假绿。
//
// 背景：旧实现缺快照打印“跳过”并 exit 0，npm run check 会在渲染审计从未运行时全绿。
// 现在默认 exit 2；--allow-missing 显式跳过并打印「未审计」。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const RUN = (args: string[]) =>
  spawnSync(process.execPath, ["scripts/audit-render.mjs", ...args], {
    encoding: "utf8",
  });

test("audit:render：缺快照退出码非 0（不假绿）", () => {
  const r = RUN(["__bgx_missing_doc__"]);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /未运行|不能当通过/);
});

test("audit:render：--allow-missing 显式跳过并标明未审计", () => {
  const r = RUN(["__bgx_missing_doc__", "--allow-missing"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /未审计|allow-missing/);
});
