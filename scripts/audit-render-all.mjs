#!/usr/bin/env node
// 全卷渲染审计：自动发现 data/out/*/stages.json，逐卷调用 audit-render.mjs。
//
// 为什么单独一个命令：`audit-render` 的墨迹/重复折叠基线是**单卷标定**的（默认卷），
// 直接拿它去判其它卷会误报。本命令用于「全卷覆盖审计」诊断：逐卷跑、汇总通过/失败，
// 失败时打印该卷审计输出的末尾；不替代 `npm run check`（后者仍只审基线卷）。
//
// 用法：node scripts/audit-render-all.mjs [--baseline] [--include-oxr]
//   --baseline 只审 7 卷基线（npm run check 用；新入批的书另由批次验收审）
// 退出码：0 = 全部通过；1 = 有卷失败；2 = 没有可审计的快照。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BASELINE_MODE = process.argv.includes("--baseline");
/**
 * 代码变更的稳定门：这 **7 卷**是融合/切题/渲染改动前就存在的基线卷。
 * 2026-10-30 移除「23必刷题 光学」—— 该册是 8 页手工节选，用户已删书，
 * 目录不存在会让 `--baseline` 直接报「缺卷」并 exit 2，把 `npm run check` 卡死。
 */
const BASELINE_DOCS = [
  "23必刷题 1 直线运动",
  "23必刷题 2相互作用",
  "23必刷题 3 运动和力的关系",
  "23必刷题 4 曲线运动",
  "动量守恒定律23必刷题",
  "机械能23必刷题",
  "第二章相互作用-答案与解析",
];
const INCLUDE_OXR = process.argv.includes("--include-oxr");
const INCLUDE_COMBINED = process.argv.includes("--include-combined");
const outRoot = join(ROOT, "data", "out");
const docs = readdirSync(outRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => existsSync(join(outRoot, name, "stages.json")))
  .filter((name) => INCLUDE_OXR || !name.endsWith("-OXR"))
  .filter((name) => INCLUDE_COMBINED || name !== "答案册-合订本")
  .filter((name) => !BASELINE_MODE || BASELINE_DOCS.includes(name))
  .sort((a, b) => a.localeCompare(b, "zh"));

if (BASELINE_MODE) {
  const missing = BASELINE_DOCS.filter((name) => !docs.includes(name));
  if (missing.length) {
    console.error(`基线渲染审计：缺卷 ${missing.join("、")}（先 npm run stages:export）`);
    process.exit(2);
  }
}

if (docs.length === 0) {
  console.error("全卷渲染审计：没有找到任何 stages.json（先 npm run stages:export）");
  process.exit(2);
}

let ok = 0;
const failed = [];
for (const doc of docs) {
  process.stdout.write(`· ${doc} … `);
  try {
    execFileSync(process.execPath, ["scripts/audit-render.mjs", doc], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    console.log("通过");
    ok++;
  } catch (e) {
    console.log(`失败（exit ${e.status ?? "?"}）`);
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (out) console.log(out.split("\n").slice(-60).join("\n"));
    failed.push(doc);
  }
}

console.log(
  `\n全卷渲染审计：${docs.length} 卷，通过 ${ok}，失败 ${failed.length}` +
    (failed.length ? `（${failed.join("、")}）` : ""),
);
process.exit(failed.length ? 1 : 0);
