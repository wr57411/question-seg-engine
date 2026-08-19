// tests/real-layout-regression.test.ts
/**
 * 行级展开端到端回归：用 Task 1 的 layout.sample.json 夹具（前 2 页，8 块已裁剪，
 * 含一行一选项的 "A. 重力的作用点…" 四行）跑 segmentFromLayout 全链路。
 *
 * 目的：pin 住「layout.json 行级几何信息 → 选项结构化可用」这条链路的验收契约。
 * 真实全量回归（15 页 layout.json，不入库）走 Step 3 脚本，见 task-3-report.md。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { segmentFromLayout } from "../src/index.js";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/layout.sample.json", import.meta.url), "utf8"),
);

test("行级展开：真实 layout 夹具切分非空且选项成组", () => {
  const r = segmentFromLayout(raw, "layout-reg");
  assert.ok(r.questions.length >= 1, "夹具应切出至少 1 道题");
  // 行级展开后应能出现选项组（夹具 page0 含 A.重力的作用点... 四行）
  assert.ok(r.stats.optionGroups >= 1, "行级展开应产出至少 1 个选项组");
  // 图片归属：夹具含 3 张图（page0/1），normalizeLayout 挂回后必须能附加到题
  // （回归：旧实现把 image 块整块跳过 → imagesAttached=0）
  assert.ok(r.stats.imagesAttached >= 1, "layout 夹具图片应挂回并归属到题");
});

test("行级展开：夹具四选项组完整成组且无 review", () => {
  const r = segmentFromLayout(raw, "layout-reg");
  assert.equal(r.stats.reviewCount, 0, "选项成组后此夹具不应有 review");
  const q = r.questions.find((x) => x.options.length === 4);
  assert.ok(q, "应存在 4 选项成组的题目");
  assert.deepEqual(
    q!.options.map((o) => o.key),
    ["A", "B", "C", "D"],
  );
  assert.equal(q!.type, "choice");
});

test("行级展开：行内公式以内联 $..$ 进入题干", () => {
  const r = segmentFromLayout(raw, "layout-reg");
  const allStem = r.questions.map((q) => q.stem).join("\n");
  assert.match(allStem, /\$.+?\$/, "夹具 inline_equation span 应内联为 $..$");
});
