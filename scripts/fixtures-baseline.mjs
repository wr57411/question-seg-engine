#!/usr/bin/env node
/**
 * 补齐 `npm run check` 所需的基线夹具（data/out 是 gitignore 快照，不进 git）。
 *
 * 为什么需要：新 worktree 的 data/out 是空的，`audit:render:baseline` 会报「缺卷」并 exit 2，
 * `bank:all` 会报「绑定了不存在的册」。这些不是代码错，是快照没跟过来。
 *
 * 源从哪来：**不硬编码绝对路径**。`git worktree list --porcelain` 列出所有 worktree，
 * 排除当前目录，找第一个含完整基线快照的作为源。换机器、换仓库位置都能用。
 *
 * 复制范围（实测 check 只用到这三个文件，其余 images/layout.json 等 2.2GB 数据不需要）：
 *   - stages.json  —— audit:render:baseline / viewer 契约
 *   - questions.json —— bank:all / viewer 契约
 *   - meta.json     —— /api/docs 的 kind/examined 判定
 *
 * 幂等：目标已存在同名字节数相同的文件则跳过；不覆盖用户已有数据。
 * 用法：pnpm run fixtures:baseline [-- --force]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FORCE = process.argv.includes("--force");

/** 从 audit-render-all.mjs 里读 BASELINE_DOCS，避免两处硬编码漂移。 */
function baselineDocs() {
  const src = readFileSync(join(ROOT, "scripts", "audit-render-all.mjs"), "utf8");
  const m = src.match(/const BASELINE_DOCS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("无法从 scripts/audit-render-all.mjs 提取 BASELINE_DOCS");
  const docs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (!docs.length) throw new Error("BASELINE_DOCS 提取结果为空");
  return docs;
}

/** 银行绑定表引用的册（bank:all 也要用，可能不在 7 卷基线里，如「答案册-合订本」）。 */
function boundDocs() {
  const p = join(ROOT, "bank-bindings.json");
  if (!existsSync(p)) return [];
  const out = [];
  const j = JSON.parse(readFileSync(p, "utf8"));
  for (const b of j.bindings ?? []) {
    for (const k of ["quiz", "answer"]) if (b[k] && !out.includes(b[k])) out.push(b[k]);
  }
  return out;
}

/** 从 git worktree 列表里找一个有完整夹具的源目录。 */
function findSource(docs) {
  let list;
  try {
    list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    throw new Error("无法读取 git worktree 列表：" + e.message);
  }
  // macOS 上 /tmp 是 /private/tmp 的软链；必须 realpath 后再比较，否则当前目录
  // 会以两个不同字符串出现，过滤失效（实测在临时 worktree 里克隆时踩到）。
  const self = realpathSync(ROOT);
  const paths = list.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const candidates = paths.map((p) => { try { return realpathSync(p); } catch { return resolve(p); } })
    .filter((p) => p !== self);

  // 环境变量显式指定时**单独使用**：它可能在 git worktree 列表之外（如临时克隆目录），
  // 混进 candidates 会被 c !== ROOT 的判断误过滤（实测：临时目录里 FIXTURE_SOURCE 失效）。
  const env = process.env.FIXTURE_SOURCE;
  const tryFirst = env ? [resolve(env)] : candidates;
  if (!tryFirst.length) return null;

  const need = ["stages.json", "questions.json", "meta.json"];
  for (const c of tryFirst) {
    if (!existsSync(c)) continue;
    const ok = docs.every((d) => need.every((f) => existsSync(join(c, "data", "out", d, f))));
    if (ok) return c;
  }
  return null;
}

function sameFile(a, b) {
  return existsSync(a) && existsSync(b) && statSync(a).size === statSync(b).size;
}

function main() {
  const docs = [...new Set([...baselineDocs(), ...boundDocs()])];
  const src = findSource(docs);
  if (!src) {
    console.error("❌ 找不到含完整基线夹具的 worktree。");
    console.error("   已尝试：git worktree list 中除当前目录外的所有 worktree。");
    console.error("   可显式指定源：FIXTURE_SOURCE=/path/to/repo pnpm run fixtures:baseline");
    console.error("   所需文件：data/out/<卷>/{stages.json,questions.json,meta.json}，共 " + docs.length + " 卷。");
    process.exit(2);
  }
  console.log("夹具源：" + src);
  const files = ["stages.json", "questions.json", "meta.json"];
  let copied = 0, skipped = 0;
  for (const d of docs) {
    const dstDir = join(ROOT, "data", "out", d);
    mkdirSync(dstDir, { recursive: true });
    for (const f of files) {
      const s = join(src, "data", "out", d, f);
      const t = join(dstDir, f);
      if (!existsSync(s)) { console.warn("  ⚠ 源缺 " + d + "/" + f); continue; }
      if (!FORCE && sameFile(s, t)) { skipped++; continue; }
      copyFileSync(s, t);
      copied++;
    }
  }
  console.log(`完成：复制 ${copied} 个文件，跳过 ${skipped} 个（已存在且大小一致）。`);
  console.log("验证：pnpm run check");
}

main();
