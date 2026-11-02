// anchor-reconcile.test.ts —— `§102` 锚点对账（Word 段落区间 ↔ PDF 页区间）的判据回归。
//
// 这段逻辑来自用户提出的「目录页码」思路，落地时踩过一个**会把结论放大一个数量级**的坑：
// 每册最后一个锚点的 Word 区间如果落到「全书末尾」，会把后面所有册的内容都算进来
// （实测 运动和力 教材知识16 显示 +469，其实只有 12 题）。
// 下面最后一条专门守这个边界。
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join("scripts", "audit-anchor-reconcile.ts");
const HAS_DOCX = existsSync(join("books", "物理_教材基础练.docx"));

/** 脚本不接受 --root，用真实产物跑；只在有数据时执行。 */
const run = (args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8" });

test("锚点对账：能读出 Word 正文并输出逐段统计（不空跑）", { skip: !HAS_DOCX }, () => {
  const out = run(["--report"]);
  assert.match(out, /教材知识锚点对账：6 册/);
  assert.match(out, /合计 Word \d+ 题 · 引擎 \d+ 题/);
  // 下限守卫：Word 侧题数不可能小于 150（6 册合计，实测 219）
  const m = /合计 Word (\d+) 题/.exec(out);
  assert.ok(Number(m?.[1] ?? 0) > 150, `Word 题数异常：${m?.[1]}`);
});

test("锚点对账：末段边界不得落到全书末尾（曾经的 +469 假异常）", { skip: !HAS_DOCX }, () => {
  const out = run(["--report"]);
  // 单段差值的绝对值上限：锚点法最大合理偏差是个位数量级；
  // 一旦出现三位数，必是「区间跨到了别的册」这类边界 bug。
  const diffs = [...out.matchAll(/⇒ ([+-]\d+)/g)].map((m) => Math.abs(Number(m[1])));
  assert.ok(diffs.length > 0, "没有任何异常段，判据可能失效");
  assert.ok(
    Math.max(...diffs) < 50,
    `出现三位数差值（${Math.max(...diffs)}），末段边界多半又落到了全书末尾`,
  );
});

test("锚点对账：闸门模式在登记表齐全时不红", { skip: !HAS_DOCX }, () => {
  const r = execFileSync(process.execPath, ["--import", "tsx", SCRIPT], { encoding: "utf8" });
  assert.match(r, /新增 0/);
});

test("锚点对账：登记表结构合法（doc/anchor/diff 齐全，且不重复）", { skip: !HAS_DOCX }, () => {
  const path = join("scripts", "anchor-reconcile-baseline.json");
  const entries = JSON.parse(readFileSync(path, "utf8")) as {
    doc?: string;
    anchor?: number;
    diff?: number;
  }[];
  assert.ok(Array.isArray(entries), "登记表必须是数组");
  const seen = new Set<string>();
  for (const [i, e] of entries.entries()) {
    assert.equal(typeof e.doc, "string", `entries[${i}] 缺 doc`);
    assert.equal(Number.isInteger(e.anchor), true, `entries[${i}] 缺 anchor`);
    assert.equal(Number.isInteger(e.diff), true, `entries[${i}] 缺 diff`);
    const k = `${e.doc}|${e.anchor}`;
    assert.equal(seen.has(k), false, `entries[${i}] 与前面的条目重复（${k}）`);
    seen.add(k);
  }
});
