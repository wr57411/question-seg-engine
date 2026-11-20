import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDoc, readLayoutBackend } from "../scripts/doc-lineage.js";

// T6：成品网页区分「当前工作流（M5 切 OXR）产物」与旧产物。
// 判据（与 scripts/doc-lineage.ts 注释一致，可核对）：
//   - 目录名后缀 -OXR / -MinerU  → 解析件 / 备份
//   - _tablecheck                 → 旧测试目录（B-52，不进列表）
//   - 其余无后缀 = 生产册；lineage 看 layout.json 的 _backend：
//       "pipeline" → mineru；无该字段 → oxr（已被 dedup/fuse/切源处理，lessons L7）
//   - 后缀与 _backend 矛盾 → mixed（不猜）

test("生产册：layout._backend=pipeline → mineru；无字段（已切源）→ oxr", () => {
  assert.deepEqual(classifyDoc("23必刷题 2相互作用", undefined), { artifact: "prod", lineage: "oxr" });
  assert.deepEqual(classifyDoc("答案册-合订本", "pipeline"), { artifact: "prod", lineage: "mineru" });
  // 切源处理后的生产册若带非 pipeline 的 backend，按该字段
  assert.deepEqual(classifyDoc("某册", "oxr"), { artifact: "prod", lineage: "oxr" });
});

test("后缀目录：-OXR → parse/oxr，-MinerU → backup/mineru", () => {
  assert.deepEqual(classifyDoc("23必刷题 2相互作用-OXR", undefined), { artifact: "parse", lineage: "oxr" });
  assert.deepEqual(classifyDoc("教材基础练 磁场-MinerU", "pipeline"), { artifact: "backup", lineage: "mineru" });
});

test("_tablecheck → test（B-52 旧测试目录，不进列表）", () => {
  assert.deepEqual(classifyDoc("_tablecheck", "pipeline"), { artifact: "test", lineage: "mineru" });
});

test("后缀与 layout._backend 矛盾 → mixed（不猜，显式标注）", () => {
  assert.deepEqual(classifyDoc("某册-OXR", "pipeline"), { artifact: "parse", lineage: "mixed" });
  // 只有一方有记录不算矛盾：-MinerU 目录无 _backend 时按后缀定 mineru
  assert.deepEqual(classifyDoc("某册-MinerU", undefined), { artifact: "backup", lineage: "mineru" });
});

test("readLayoutBackend：从文件尾部提取 _backend（不全量 parse 大文件）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t6-lineage-"));
  try {
    const p = join(dir, "layout.json");
    // 模拟真实布局：前面大量内容，_backend 在末尾
    await writeFile(p, `${"x".repeat(9000)}{"a":1},"_backend":"pipeline","_version_name":"3.4.4"}`);
    assert.equal(await readLayoutBackend(p), "pipeline");

    const q = join(dir, "nobackend.json");
    await writeFile(q, `${"y".repeat(9000)}{"a":1}}`);
    assert.equal(await readLayoutBackend(q), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLayoutBackend：文件不存在 → undefined（按「无字段」处理，不抛）", async () => {
  assert.equal(await readLayoutBackend(join(tmpdir(), "t6-never-exists-xyz", "layout.json")), undefined);
});
