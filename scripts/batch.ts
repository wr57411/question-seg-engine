// scripts/batch.ts —— 批量导入 MVP：inbox → 逐本 daily → 台账/日报。
//
// 用法：
//   npm run batch -- --inbox inbox
//   npm run batch -- --inbox inbox --no-ocr --limit 20
//   npm run batch -- --inbox inbox --retry 1
//   npm run batch:report
//
// 设计（spec 2026-10-28-batch-book-ingestion-spec.md B03/B04）：
// - **哈希去重**：同文件哈希已完成 → 跳过；同 docId 不同哈希 → collision，不覆盖。
// - **断点**：每次运行前写 `running`；崩溃后重跑视为中断，可重试。
// - **失败隔离**：单本 daily 失败只记 failed，不阻塞其它书。
// - **台账**：`<state>/ledger.jsonl` 逐行追加；报告取每个哈希的最后一条。
// - **不改 daily 语义**：每本仍调用 `scripts/daily.ts`；批量只是外层编排。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

type Status = "running" | "done" | "failed" | "skipped" | "collision" | "existing";

interface Entry {
  hash: string;
  docId: string;
  input: string;
  status: Status;
  at: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  questions?: number;
  pages?: number;
  needsReview?: number;
}

interface Options {
  inbox: string;
  state: string;
  limit: number;
  retry: number;
  noOcr: boolean;
  parser: string | null;
  report: boolean;
}

function parseArgs(argv: string[]): Options {
  const opt: Options = {
    inbox: "inbox",
    state: join("data", "batch"),
    limit: Infinity,
    retry: 1,
    noOcr: false,
    parser: null,
    report: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--report") opt.report = true;
    else if (a === "--no-ocr") opt.noOcr = true;
    else if (a === "--inbox") opt.inbox = argv[++i] ?? opt.inbox;
    else if (a === "--state") opt.state = argv[++i] ?? opt.state;
    else if (a === "--limit") opt.limit = Number(argv[++i] ?? opt.limit);
    else if (a === "--retry") opt.retry = Number(argv[++i] ?? opt.retry);
    else if (a === "--parser") opt.parser = argv[++i] ?? null;
    else throw new Error(`未知参数：${a}`);
  }
  return opt;
}

function readLedger(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      /* 坏行跳过；不静默删文件 */
    }
  }
  return out;
}

function appendLedger(path: string, e: Entry): void {
  appendFileSync(path, `${JSON.stringify(e)}\n`);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeId(s: string): string {
  return s.replace(/[\\/\0]/g, "-").trim() || "book";
}

function collectInputs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() || e.isSymbolicLink()) {
        // 支持「新书用符号链接投递」：readdir 的 Dirent 对 symlink 不报 isFile，
        // 但 statSync 会跟随链接；不跟随会把整个 inbox 当成空的（2026-10-28 实测）。
        let isFile = false;
        try {
          isFile = statSync(p).isFile();
        } catch {
          continue;
        }
        if (isFile && (extname(e.name).toLowerCase() === ".pdf" || e.name === "layout.json")) out.push(p);
      }
    }
  };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b, "zh"));
}

function docIdFor(file: string, hash: string, inbox: string): string {
  if (basename(file) === "layout.json") {
    const parent = basename(dirname(file));
    if (resolve(dirname(file)) === resolve(inbox) || parent === "inbox") return `layout-${hash.slice(0, 8)}`;
    return safeId(parent);
  }
  return safeId(basename(file, extname(file)));
}

function readMeta(docId: string): { questions?: number; pages?: number; needsReview?: number } {
  try {
    const meta = JSON.parse(readFileSync(join(ROOT, "data", "out", docId, "meta.json"), "utf8")) as {
      stats?: { questions?: number; pages?: number; needsReview?: number };
    };
    return {
      questions: meta.stats?.questions,
      pages: meta.stats?.pages,
      needsReview: meta.stats?.needsReview,
    };
  } catch {
    return {};
  }
}

function runDaily(input: string, docId: string, opt: Options): { ok: boolean; out: string } {
  const args = ["--import", "tsx", join(ROOT, "scripts", "daily.ts"), input, "--id", docId];
  if (opt.noOcr) args.push("--no-ocr");
  if (opt.parser) args.push("--parser", opt.parser);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, out };
}

function writeReport(stateDir: string, entries: Entry[]): string {
  const last = new Map<string, Entry>();
  for (const e of entries) last.set(e.hash, e);
  const rows = [...last.values()].sort((a, b) => a.at.localeCompare(b.at));
  const count = (s: Status) => rows.filter((e) => e.status === s).length;
  const lines = [
    "# 批量导入报告",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    `总数 ${rows.length}：done ${count("done")} · failed ${count("failed")} · skipped ${count("skipped")} · collision ${count("collision")} · existing ${count("existing")} · running ${count("running")}`,
    "",
    "| 文档 | 状态 | 题数 | 页数 | 待复核 | 耗时 | 输入 | 错误 |",
    "|---|---|---:|---:|---:|---|---|---|",
    ...rows.map((e) => {
      const start = e.startedAt ? Date.parse(e.startedAt) : NaN;
      const end = e.finishedAt ? Date.parse(e.finishedAt) : NaN;
      const dur = Number.isFinite(start) && Number.isFinite(end) ? `${Math.round((end - start) / 1000)}s` : "—";
      return `| ${e.docId} | ${e.status} | ${e.questions ?? "—"} | ${e.pages ?? "—"} | ${e.needsReview ?? "—"} | ${dur} | \`${e.input}\` | ${e.error ? e.error.replace(/\|/g, "\\|").slice(0, 120) : ""} |`;
    }),
    "",
    "> 每个哈希只显示最后一条。failed 的书重跑同一条命令即可重试；collision 表示同 docId 换了文件，需人工改名。",
  ];
  const path = join(stateDir, "report.md");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, lines.join("\n"));
  console.log(lines.slice(0, 5).join("\n"));
  console.log(`\n报告：${path}`);
  return path;
}

function main(): void {
  let opt: Options;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e));
    process.exit(2);
  }
  const stateDir = resolve(ROOT, opt.state);
  const ledgerPath = join(stateDir, "ledger.jsonl");
  mkdirSync(join(stateDir, "logs"), { recursive: true });

  if (opt.report) {
    const entries = readLedger(ledgerPath);
    if (entries.length === 0) {
      console.error(`没有台账：${ledgerPath}`);
      process.exit(2);
    }
    writeReport(stateDir, entries);
    return;
  }

  const inbox = resolve(ROOT, opt.inbox);
  const inputs = collectInputs(inbox);
  if (inputs.length === 0) {
    console.error(`inbox 里没有 PDF 或 layout.json：${inbox}`);
    process.exit(2);
  }

  const entries = readLedger(ledgerPath);
  const lastByHash = new Map<string, Entry>();
  const lastByDoc = new Map<string, Entry>();
  for (const e of entries) {
    lastByHash.set(e.hash, e);
    lastByDoc.set(e.docId, e);
  }

  let ran = 0;
  let newFailures = 0;
  for (const input of inputs) {
    if (ran >= opt.limit) break;
    const hash = hashFile(input);
    const docId = docIdFor(input, hash, inbox);
    const rel = relative(ROOT, input) || input;
    const last = lastByHash.get(hash);

    if (last?.status === "done") {
      console.log(`· ${docId}：同哈希已完成，跳过`);
      continue;
    }
    if (last?.status === "running") {
      console.log(`· ${docId}：上次中断（running），重试`);
    }
    if (last?.status === "failed") {
      const failedCount = entries.filter((e) => e.hash === hash && e.status === "failed").length;
      if (failedCount >= opt.retry) {
        console.log(`· ${docId}：已失败 ${failedCount} 次（--retry ${opt.retry}），跳过`);
        continue;
      }
      console.log(`· ${docId}：重试（第 ${failedCount + 1} 次）`);
    }
    const docLast = lastByDoc.get(docId);
    if (docLast && docLast.hash !== hash) {
      console.log(`· ${docId}：同 docId 已有不同文件哈希，collision，跳过（不覆盖）`);
      appendLedger(ledgerPath, {
        hash, docId, input: rel, status: "collision", at: new Date().toISOString(),
        error: "同 docId 已有不同文件哈希；请改名后重投",
      });
      continue;
    }
    if (!last && existsSync(join(ROOT, "data", "out", docId, "stages.json"))) {
      console.log(`· ${docId}：已有产物但台账无记录，existing，跳过（保护已有数据）`);
      appendLedger(ledgerPath, {
        hash, docId, input: rel, status: "existing", at: new Date().toISOString(),
        error: "已有 data/out 产物；如确认重跑请先改名或手动处理",
      });
      continue;
    }

    ran++;
    const startedAt = new Date().toISOString();
    appendLedger(ledgerPath, { hash, docId, input: rel, status: "running", at: startedAt, startedAt });
    console.log(`\n[${ran}] ${docId}：${rel}`);
    const { ok, out } = runDaily(input, docId, opt);
    const log = join(stateDir, "logs", `${safeId(docId)}.log`);
    writeFileSync(log, out);
    const finishedAt = new Date().toISOString();
    if (ok) {
      const meta = readMeta(docId);
      appendLedger(ledgerPath, {
        hash, docId, input: rel, status: "done", at: finishedAt, startedAt, finishedAt,
        questions: meta.questions, pages: meta.pages, needsReview: meta.needsReview,
      });
      console.log(`  ✅ done：${meta.questions ?? "?"} 题 / ${meta.pages ?? "?"} 页（日志 ${log}）`);
    } else {
      newFailures++;
      const error = out.split("\n").slice(-8).join("\n").slice(-800);
      appendLedger(ledgerPath, {
        hash, docId, input: rel, status: "failed", at: finishedAt, startedAt, finishedAt, error,
      });
      console.log(`  ❌ failed（日志 ${log}）`);
    }
  }

  writeReport(stateDir, readLedger(ledgerPath));
  if (newFailures > 0) process.exit(1);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
