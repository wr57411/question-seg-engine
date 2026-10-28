// decoupling.test.ts —— 展示层解耦红线：viewer/stages/final 不得 import 引擎 src/。
//
// 红线见 AGENTS.md / HANDOFF §5-4：展示层只消费快照 JSON，换展示层/换引擎互不影响。
// 本门只做结构扫描（import/require 语句），不替代快照契约测试；反向验证锁扫描器本身。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["viewer", "stages", "final"];
/** 命中 `from "../src/..."` / `import("../src/...")` / `require("../src/...")`，含 ../src 目录本身。 */
const BAD = /(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*\/src(?:\/|["'])/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(?:js|mjs|d\.ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("展示层不得 import 引擎 src/（解耦红线）", () => {
  const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
  assert.ok(files.length > 0, "没扫到展示层文件，门是死的");
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const m = BAD.exec(src);
    if (m) bad.push(`${f.replace(ROOT, "")}: ${m[0]}`);
  }
  assert.deepEqual(bad, [], `展示层 import 了引擎 src/：\n${bad.join("\n")}`);
});

test("解耦扫描器能识别违规 import（反向验证，防死门）", () => {
  assert.match('import { x } from "../src/x.js";', BAD);
  assert.match('const m = await import("../src/x.js");', BAD);
  assert.match('const x = require("../src/x.js");', BAD);
  assert.doesNotMatch('import { renderPaper } from "../stages/reconstruct.js";', BAD);
});
