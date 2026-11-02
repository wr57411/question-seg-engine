// scripts/cleanup-topic-tags.ts
/**
 * 一次性清理：把「专题名#层级」形状的标签从**业务标签库**里摘掉，并归档旧专题索引。
 *
 * ## 为什么是「清理」而不是「迁移」
 * `data/out/tags/library.json` 里混了两类东西：
 * 1. **业务标签**（好题/待改/已校对/留着组卷/偏题难题）—— 描述录入/校对流程，**本脚本一个都不动**；
 * 2. **`专题名#基础` 形状的标签** —— S01 专题页当年的**演示种子**（`fixtures/topic-seed/`），
 *    不是业务标签，按 ADR-0001 业务标签面板不该承载专题。
 * 实测（2026-10-31）：这 3 条与 `data/out/teach` 里已有的 3 条归属**完全重合**
 * （同题、同锚点、同专题/类别）⇒ 摘掉它们**不产生任何信息损失**，所以不需要"搬家"。
 *
 * ## 做什么
 * - 从 `tags/library.json` 删除名字含 `#` 的标签；
 * - 从 `tags/<doc>.json` 的 `bindings`/`stale` 里摘掉这些 tagId（摘空的整条删掉）；
 * - `--clear-teach`：把 `teach/bindings/*.json` 的 `bindings`/`stale` 清空（从一张白纸开始自己标）；
 * - 归档 `data/out/topics/{index,export-status}.json` 后**删除**它们 —— 否则下次 `topic:export`
 *   会因为「专题消失」报红（`disappearedCheck` 对下架/清空不豁免，这是故意的）。
 *
 * ## 安全
 * - **默认 dry-run，只打印不写盘**；`--apply` 才写。
 * - 写前把 `data/out/tags`、`teach/bindings`、`topics` 备份到 `data/archive/<日期>-topic-tag-cleanup/`。
 * - 只改必要字段（`tagIds`/`bindings`/`stale`/`updatedAt`），其余字段原样保留。
 *
 * 用法：
 *   npm run cleanup:topic-tags                    # 预演
 *   npm run cleanup:topic-tags -- --apply         # 真跑（不清 teach）
 *   npm run cleanup:topic-tags -- --apply --clear-teach
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 原子写：先写 .tmp 再 rename，中断不会留下半截 JSON。 */
function writeJsonAtomic(file: string, json: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 1)}\n`, "utf8");
  renameSync(tmp, file);
}

/** 名字含 `#` 即视为「专题形状」的标签（历史约定：`专题名#层级`）。 */
export const isTopicShapedName = (name: string): boolean => name.includes("#");

export interface TagFilePlan {
  doc: string;
  file: string;
  /** 要删掉的 tagId（去重） */
  removedTagIds: string[];
  /** 因 tagIds 摘空而整条删掉的题目数 */
  droppedBindings: number;
  droppedStale: number;
  /** 保留下来的业务标签引用条数 */
  keptRefs: number;
  payload: Record<string, unknown>;
}

export interface CleanupPlan {
  /** 要删除的标签条目 */
  removedTags: { id: string; name: string }[];
  /** 保留下来的标签（业务标签，一字不动） */
  keptTags: { id: string; name: string; refs: number }[];
  libraryPayload: Record<string, unknown> | null;
  tagFiles: TagFilePlan[];
  /** `--clear-teach` 时要清空的 teach 绑定文件 */
  teachFiles: { doc: string; file: string; bindings: number; stale: number; payload: Record<string, unknown> }[];
  /** 会被归档并删除的索引文件 */
  archiveFiles: string[];
  errors: string[];
}

/**
 * 算出「要写成什么样」。不碰磁盘写（只读），便于 dry-run 与单测。
 */
export function planCleanup(root: string, opts: { clearTeach: boolean; now: string }): CleanupPlan {
  const outRoot = join(root, "data", "out");
  const errors: string[] = [];
  const removedTags: { id: string; name: string }[] = [];
  const keptTags: { id: string; name: string; refs: number }[] = [];
  let libraryPayload: Record<string, unknown> | null = null;

  /* ── 1. 标签库：删掉 # 形状，其余原样 ── */
  const libraryFile = join(outRoot, "tags", "library.json");
  const libraryRefs = new Map<string, number>();
  for (const name of existsSync(join(outRoot, "tags")) ? readdirSync(join(outRoot, "tags")) : []) {
    if (!name.endsWith(".json") || name === "library.json") continue;
    const json = readJson(join(outRoot, "tags", name));
    if (!isRec(json)) continue;
    for (const key of ["bindings", "stale"] as const) {
      for (const b of Array.isArray(json[key]) ? (json[key] as unknown[]) : []) {
        if (!isRec(b) || !Array.isArray(b.tagIds)) continue;
        for (const id of b.tagIds) if (typeof id === "string") libraryRefs.set(id, (libraryRefs.get(id) ?? 0) + 1);
      }
    }
  }
  if (!existsSync(libraryFile)) {
    errors.push("找不到 data/out/tags/library.json（没有业务标签库，无需清理）");
  } else {
    const json = readJson(libraryFile);
    if (!isRec(json) || !Array.isArray(json.tags)) {
      errors.push("data/out/tags/library.json 形状不对：需要 {version, tags:[{id,name}]}");
    } else {
      const kept: unknown[] = [];
      for (const t of json.tags) {
        if (!isRec(t)) {
          kept.push(t);
          continue;
        }
        const id = asStr(t.id);
        const name = asStr(t.name);
        if (isTopicShapedName(name)) removedTags.push({ id, name });
        else {
          kept.push(t);
          keptTags.push({ id, name, refs: libraryRefs.get(id) ?? 0 });
        }
      }
      libraryPayload = { ...json, version: 1, updatedAt: opts.now, tags: kept };
    }
  }

  /* ── 2. 各卷标签绑定：摘掉这些 tagId，摘空的整条删 ── */
  const removedIds = new Set(removedTags.map((t) => t.id));
  const tagFiles: TagFilePlan[] = [];
  for (const name of existsSync(join(outRoot, "tags")) ? readdirSync(join(outRoot, "tags")).sort() : []) {
    if (!name.endsWith(".json") || name === "library.json") continue;
    const file = join(outRoot, "tags", name);
    const json = readJson(file);
    if (!isRec(json)) {
      errors.push(`data/out/tags/${name} 形状不对（不是对象）`);
      continue;
    }
    const seen = new Set<string>();
    let droppedBindings = 0;
    let droppedStale = 0;
    let keptRefs = 0;
    const payload: Record<string, unknown> = { ...json };
    for (const key of ["bindings", "stale"] as const) {
      const arr = Array.isArray(json[key]) ? (json[key] as unknown[]) : [];
      const next: unknown[] = [];
      for (const b of arr) {
        if (!isRec(b)) {
          next.push(b);
          continue;
        }
        const tagIds = Array.isArray(b.tagIds) ? b.tagIds : [];
        const keptIds: string[] = [];
        for (const id of tagIds) {
          if (typeof id !== "string") continue;
          if (removedIds.has(id)) seen.add(id);
          else keptIds.push(id);
        }
        if (keptIds.length === 0 && tagIds.length > 0) {
          if (key === "bindings") droppedBindings += 1;
          else droppedStale += 1;
          continue; // 空归属不留记录（与标签面板 toggle 的语义一致）
        }
        keptRefs += keptIds.length;
        next.push(keptIds.length === tagIds.length ? b : { ...b, tagIds: keptIds });
      }
      payload[key] = next;
    }
    if (seen.size === 0) continue; // 这份文件没引用要删的标签，一个字节都不写
    payload.updatedAt = opts.now;
    tagFiles.push({
      doc: name.slice(0, -".json".length),
      file,
      removedTagIds: [...seen].sort(),
      droppedBindings,
      droppedStale,
      keptRefs,
      payload,
    });
  }

  /* ── 3. teach 绑定（可选清空） ── */
  const teachFiles: CleanupPlan["teachFiles"] = [];
  if (opts.clearTeach) {
    const dir = join(outRoot, "teach", "bindings");
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      const json = readJson(file);
      if (!isRec(json)) {
        errors.push(`data/out/teach/bindings/${name} 形状不对`);
        continue;
      }
      const bindings = Array.isArray(json.bindings) ? json.bindings.length : 0;
      const stale = Array.isArray(json.stale) ? json.stale.length : 0;
      if (!bindings && !stale) continue;
      teachFiles.push({
        doc: name.slice(0, -".json".length),
        file,
        bindings,
        stale,
        payload: { ...json, version: 1, updatedAt: opts.now, bindings: [], stale: [] },
      });
    }
  }

  /* ── 4. 旧索引：必须归档并删除，否则下次导出会报「专题消失」 ── */
  const archiveFiles = [
    join(outRoot, "topics", "index.json"),
    join(outRoot, "topics", "export-status.json"),
  ].filter((f) => existsSync(f));

  return { removedTags, keptTags, libraryPayload, tagFiles, teachFiles, archiveFiles, errors };
}

/** 备份目录名（按日期；同一天重复跑会加序号，不覆盖上一次的备份）。 */
function archiveDir(root: string, day: string): string {
  const base = join(root, "data", "archive");
  let dir = join(base, `${day}-topic-tag-cleanup`);
  let i = 1;
  while (existsSync(dir)) dir = join(base, `${day}-topic-tag-cleanup-${++i}`);
  return dir;
}

export interface ApplyResult {
  archive: string;
  written: string[];
  deleted: string[];
}

/** 落盘：先备份，再写，再删旧索引。任何一步失败都不吞异常。 */
export function applyCleanup(root: string, plan: CleanupPlan, day: string): ApplyResult {
  if (plan.errors.length) throw new Error(`计划有 ${plan.errors.length} 处问题，拒绝写盘：${plan.errors.join("；")}`);
  const outRoot = join(root, "data", "out");
  const dir = archiveDir(root, day);
  mkdirSync(dir, { recursive: true });
  // 备份：整份 tags + teach/bindings + topics 索引（不含页图，体积可控）
  if (existsSync(join(outRoot, "tags"))) cpSync(join(outRoot, "tags"), join(dir, "tags"), { recursive: true });
  if (existsSync(join(outRoot, "teach", "bindings"))) {
    cpSync(join(outRoot, "teach", "bindings"), join(dir, "teach-bindings"), { recursive: true });
  }
  for (const f of plan.archiveFiles) cpSync(f, join(dir, f.slice(f.lastIndexOf("/") + 1)));

  const written: string[] = [];
  const deleted: string[] = [];
  if (plan.libraryPayload) {
    writeJsonAtomic(join(outRoot, "tags", "library.json"), plan.libraryPayload);
    written.push("data/out/tags/library.json");
  }
  for (const f of plan.tagFiles) {
    writeJsonAtomic(f.file, f.payload);
    written.push(`data/out/tags/${f.doc}.json`);
  }
  for (const f of plan.teachFiles) {
    writeJsonAtomic(f.file, f.payload);
    written.push(`data/out/teach/bindings/${f.doc}.json`);
  }
  for (const f of plan.archiveFiles) {
    rmSync(f);
    deleted.push(f.slice(root.length + 1));
  }
  return { archive: dir.slice(root.length + 1), written, deleted };
}

/** 人话报告（dry-run 与真跑都打印，便于逐条核对）。 */
export function formatPlan(plan: CleanupPlan, opts: { clearTeach: boolean }): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));
  lines.push(`将删除的专题形状标签（${plan.removedTags.length}）：`);
  for (const t of plan.removedTags) lines.push(`  - ${pad(t.id, 20)} ${t.name}`);
  lines.push(`将保留的业务标签（${plan.keptTags.length}，一个都不动）：`);
  for (const t of plan.keptTags) lines.push(`  · ${pad(t.id, 20)} ${pad(t.name, 8)} 被引用 ${t.refs} 次`);
  lines.push(`标签绑定文件改动（${plan.tagFiles.length}）：`);
  for (const f of plan.tagFiles) {
    lines.push(
      `  - ${f.doc}：摘掉 ${f.removedTagIds.join("、")}；删空条目 ${f.droppedBindings} 条` +
        `${f.droppedStale ? `（另 stale ${f.droppedStale} 条）` : ""}；保留业务标签引用 ${f.keptRefs} 条`,
    );
  }
  if (opts.clearTeach) {
    lines.push(`teach 演示归属（--clear-teach）：将清空 ${plan.teachFiles.length} 个文件`);
    for (const f of plan.teachFiles) lines.push(`  - ${f.doc}：bindings ${f.bindings} 条 / stale ${f.stale} 条 → 0`);
  } else {
    lines.push("teach 归属：保留（未加 --clear-teach）");
  }
  lines.push(`旧专题索引将归档并删除（${plan.archiveFiles.length}）：`);
  for (const f of plan.archiveFiles) lines.push(`  - ${f.slice(f.indexOf("data/out"))}`);
  if (plan.errors.length) {
    lines.push(`✗ 计划有 ${plan.errors.length} 处问题：`);
    for (const e of plan.errors) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv;
  const i = argv.indexOf("--root");
  const root = resolve(i >= 0 ? (argv[i + 1] ?? process.cwd()) : process.cwd());
  const apply = argv.includes("--apply");
  const clearTeach = argv.includes("--clear-teach");
  const now = new Date().toISOString();
  // 本地日期（toISOString 是 UTC，晚上跑会差一天）
  const day = new Date(now).toLocaleDateString("sv-SE");

  const plan = planCleanup(root, { clearTeach, now });
  console.log(formatPlan(plan, { clearTeach }));
  if (plan.errors.length) process.exit(1);
  if (!apply) {
    console.log("\n（预演：未写盘。确认无误后加 --apply 执行）");
    return;
  }
  const res = applyCleanup(root, plan, day);
  console.log(`\n✅ 已备份到 ${res.archive}`);
  console.log(`   写入 ${res.written.length} 个文件；删除 ${res.deleted.length} 个旧索引文件`);
  for (const f of res.deleted) console.log(`   - ${f}`);
  console.log("\n下一步：npm run topic:export && npm run audit:topic");
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
