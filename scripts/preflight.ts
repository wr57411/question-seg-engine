// scripts/preflight.ts
/**
 * 开工自检（`docs/DATA-MAP.md` 的机器端）。
 *
 * 为什么存在（`tasks/lessons.md` **L7**）：`data/out/` 是运行时产物、git 忽略、不跟代码版本。
 * 2026-11-02 我拿三个月前的 `questions.json` 当"现在的行为"，据此做了三轮根因推理，
 * 全部证伪 —— 打点一跑，现场根本不复现。**产物不是事实，产物只是某次运行的快照。**
 *
 * 本脚本只读、不改任何文件。做的事：
 *   1. 报当前分支 / HEAD / 未提交改动数
 *   2. 报引擎最新改动时间（`src/` + `scripts/` 里 .ts 的最大 mtime）
 *   3. 逐册检查 `data/out/<doc>/`：产物是否早于引擎、`layout.json` 是否原样
 *   4. 给出「可以开始分析」还是「先重跑」的结论
 *
 * 用法：
 *   npm run preflight              # 只看，退出码恒 0
 *   npm run preflight -- --strict  # 有过期产物即退出码 1（供 CI / 闸门用）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STRICT = process.argv.includes("--strict");
const OUT = "data/out";

interface Row {
  doc: string;
  questions?: number;
  qTime?: Date;
  layoutBackend?: string;
  stale: boolean;
  note: string;
}

const sh = (args: string[]): string => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const fmt = (d: Date | undefined): string =>
  d ? d.toISOString().slice(0, 16).replace("T", " ") : "—";

/** 递归取某目录下所有 .ts 的最新 mtime（引擎"当前版本"的时间代理） */
function newestTs(dir: string): Date | undefined {
  let newest: Date | undefined;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".ts")) {
        const m = statSync(p).mtime;
        if (!newest || m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

const branch = sh(["rev-parse", "--abbrev-ref", "HEAD"]) || "—";
const head = (sh(["rev-parse", "--short", "HEAD"]) || "—").trim();
const dirty = sh(["status", "--porcelain"]).split("\n").filter(Boolean).length;

const engineTs = [newestTs("src"), newestTs("scripts")].filter(Boolean) as Date[];
const engineTime = engineTs.length ? new Date(Math.max(...engineTs.map((d) => d.getTime()))) : undefined;

const rows: Row[] = [];
if (existsSync(OUT)) {
  for (const doc of readdirSync(OUT)) {
    const dir = join(OUT, doc);
    if (!statSync(dir).isDirectory()) continue;
    const qPath = join(dir, "questions.json");
    const lPath = join(dir, "layout.json");
    if (!existsSync(qPath) && !existsSync(lPath)) continue;

    const row: Row = { doc, stale: false, note: "" };
    if (existsSync(qPath)) {
      row.qTime = statSync(qPath).mtime;
      try {
        const qs = JSON.parse(readFileSync(qPath, "utf8")) as unknown;
        row.questions = Array.isArray(qs) ? qs.length : undefined;
      } catch {
        row.note = "questions.json 读不出";
      }
    }
    if (existsSync(lPath)) {
      try {
        const L = JSON.parse(readFileSync(lPath, "utf8")) as { _backend?: string };
        row.layoutBackend = L._backend;
      } catch {
        row.layoutBackend = "解析失败";
      }
    }
    // 过期判据：产物时间早于引擎最新改动 ⇒ 该产物不能代表当前代码行为
    if (row.qTime && engineTime && row.qTime < engineTime) {
      row.stale = true;
      row.note = row.note || "产物早于引擎改动";
    }
    if (row.layoutBackend === undefined && existsSync(lPath)) {
      row.note = (row.note ? row.note + "；" : "") + "layout 无 _backend（被 dedup/fuse 改过）";
    }
    rows.push(row);
  }
}

rows.sort((a, b) => Number(b.stale) - Number(a.stale) || a.doc.localeCompare(b.doc));
const staleCount = rows.filter((r) => r.stale).length;

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

console.log("─".repeat(78));
console.log("开工自检 · question-seg-engine");
console.log("─".repeat(78));
console.log(`分支      ${branch}  @ ${head}`);
console.log(`未提交    ${dirty} 个文件${dirty ? "（改动前先提交或确认）" : ""}`);
console.log(`引擎最新  ${fmt(engineTime)}（src/ + scripts/ 的 .ts 最大 mtime）`);
console.log(`产物目录  ${rows.length} 册，其中 ${staleCount} 册早于引擎改动`);
console.log("");

if (rows.length) {
  console.log(`${pad("册", 30)} ${pad("题数", 6)} ${pad("产物时间", 17)} layout    判定`);
  for (const r of rows.slice(0, 40)) {
    const backend = r.layoutBackend === undefined ? "被改过" : r.layoutBackend;
    console.log(
      `${pad(r.doc, 30)} ${pad(r.questions === undefined ? "—" : String(r.questions), 6)} ${pad(fmt(r.qTime), 17)} ${pad(backend, 9)} ${r.stale ? "⚠ 过期" : "✓"}`,
    );
  }
  if (rows.length > 40) console.log(`  … 另有 ${rows.length - 40} 册`);
  console.log("");
}

const warns = rows.filter((r) => r.note).length;
if (warns) {
  console.log("提醒：");
  for (const r of rows.filter((x) => x.note).slice(0, 10)) console.log(`  · ${r.doc}：${r.note}`);
  console.log("");
}

console.log("─".repeat(78));
if (staleCount > 0) {
  console.log("结论：有产物早于引擎改动。");
  console.log("      · 要用「当前代码行为」下结论 ⇒ 先重跑：npm run daily -- <pdf>");
  console.log("      · 要引用产物数字 ⇒ 必须写明它是哪次运行的快照（见 tasks/lessons.md L7）");
  console.log("      · 只做只读排查 ⇒ 用 segmentFromLayout 现场重跑，别读 questions.json");
} else {
  console.log("结论：产物时间不早于引擎改动，可以直接分析（仍需注意 layout 是否原样）。");
}
console.log("─".repeat(78));

if (STRICT && staleCount > 0) process.exit(1);
