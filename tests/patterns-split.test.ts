// tests/patterns-split.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitConjoinedOptions } from "../src/patterns.js";

test("粘连选项拆分：一行四选项", () => {
  const opts = splitConjoinedOptions("A.3:4 B.3:5 C.4:5 D.2:3");
  assert.deepEqual(opts.map((o) => o.key), ["A", "B", "C", "D"]);
  assert.deepEqual(opts.map((o) => o.text), ["3:4", "3:5", "4:5", "2:3"]);
});

test("粘连选项拆分：无空格粘连（A.xxxB.yyy）", () => {
  const opts = splitConjoinedOptions("A.重力的作用点在重心上B.重力的大小与质量成正比C.重力的方向总是竖直向下");
  assert.equal(opts.length, 3);
  assert.equal(opts[0]!.key, "A");
  assert.match(opts[0]!.text, /重力的作用点/);
});

test("粘连选项拆分：普通文本（题干）不拆分", () => {
  assert.equal(splitConjoinedOptions("2. [山东潍坊中学2022摸底]关于相互作用").length, 0);
});