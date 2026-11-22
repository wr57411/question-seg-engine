// tests/bare-paren-fragment.test.ts
//
// 「纯小问标记碎块守卫」（B-63 题册侧根因）：OXR 把原卷小问标记 `(2)` 读丢开括号
// 成独立碎块「2)」→ 切出假题号 2（2026 新高考版 p249 实测，与真题 2 力敏电阻撞
// bank 唯一键 17|66|2 + 答案位倒挂）。原卷 page-249.png 裁定：该处是真题 6
// 小问 (2) 的标记，无题号。判据：整行只剩「N)」→ 不是题号。
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";

test("纯小问标记碎块：「2)」整行（无正文）不是题号", () => {
  const r = matchFirstLine("2)");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "other");
});

test("守卫不误伤：真题「N)」带同行正文仍是题号", () => {
  const r = matchFirstLine("2)将单刀双掷开关接通线路2，此时电压表$V_{2}$的示");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "question_no");
  assert.equal(r.captured, "2");
});
