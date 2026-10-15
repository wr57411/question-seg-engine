# MinerU 真实 API 接入实施计划

> 📍 交接导航：本文件是**当时的实施计划（历史记录）**，不代表当前状态。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../../AGENTS.md)**。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 question-seg-engine 通过真实 MinerU API（`mineru_API_KEY`）把本地样卷解析为 content_list.json，并接入现有切分管线，跑通端到端。

**Architecture:** 新增 `src/mineru/` 客户端层（上游适配的落地实现）：申请上传链接 → PUT 上传 → 异步轮询 → 下载结果 Zip → 解包提取 content_list。既有 `normalize.ts` → 切分管线不动，管线只新增一个真实数据入口。所有网络调用与测试隔离：单元测试注入 transport / 使用本地 zip，真实调用只出现在开发冒烟脚本与端到端脚本里。

**Tech Stack:** Node 22 内置 fetch、TypeScript strict、tsx 运行、adm-zip（唯一新依赖，解包结果 Zip）。

## Global Constraints

- Node >= 22；TypeScript strict；代码风格与现有骨架一致（中文注释、`type` 导入、`.js` 后缀）。
- API Key 只从 `process.env.mineru_API_KEY` 读取，**不得**出现在日志、输出、提交文件中。
- `npm test` 必须全程离线（注入 transport / 本地 zip 夹具）；真实网络只出现在 `scripts/api-smoke.ts` 与 `scripts/real-pipeline.ts`。
- API 字段结构以官方文档 + 实测为准：`docs/real-api-notes.md` 是唯一字段事实来源，客户端解析字段一律引用它。
- 新依赖仅 `adm-zip`（+ `@types/adm-zip`）；禁止其他新增依赖。
- 样卷文件放 `sample/`（已 gitignore）；若无现成 PDF，用 macOS 自带 `cupsfilter` 将文本转 PDF 生成冒烟样张（见 Task 2）。
- 计划产出物：可运行代码 + `docs/real-api-notes.md`（真实结构记录）+ DECISIONS.md 追加。

---

### Task 1: 项目基建（git 初始化 + 目录约定 + adm-zip）

**Files:**
- Create: `.gitignore`
- Modify: `package.json`（devDependencies）

**Interfaces:**
- Consumes: 无
- Produces: git 仓库（后续任务每步 commit）；`data/`（冒烟产物，不入库）、`sample/`（用户样卷，不入库）、`docs/`（决策记录）

- [ ] **Step 1: git init 并写 .gitignore**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
git init
```

```gitignore
node_modules/
data/
sample/
*.local
.DS_Store
```

- [ ] **Step 2: 安装解包依赖**

```bash
npm install -D adm-zip @types/adm-zip
```

- [ ] **Step 3: 验证基线**

Run: `npm run check`
Expected: 9/9 测试通过、typecheck 无错误（Task 1 不改代码，只验证基线）。

- [ ] **Step 4: 首次提交**

```bash
git add -A
git commit -m "chore: init repo layout (gitignore, adm-zip) with engine baseline"
```

---

### Task 2: API 冒烟——真实凭据的最小闭环（开发步骤，非自动化测试）

**目的：** 在写客户端代码之前，用真实 API 走通「申请上传链接 → PUT → 轮询 → 下载 Zip」，把真实响应 JSON 与 Zip 结构落盘，产出 `docs/real-api-notes.md` 字段事实表。这是 Task 3 客户端实现的唯一字段来源。

**Files:**
- Create: `scripts/api-smoke.ts`
- Create: `docs/real-api-notes.md`
- Create: `sample/README.md`（说明放样卷）

**Interfaces:**
- Consumes: 环境变量 `mineru_API_KEY`；`sample/` 下至少一个 PDF/图片，或将文本经 `cupsfilter` 转 PDF
- Produces: `data/smoke/`（raw 响应 JSON、result.zip）；`docs/real-api-notes.md`（字段表）；`data/smoke/content_list.json`（真实 sample，供 Task 4 回归）

- [ ] **Step 1: 准备冒烟样张**

若 `sample/` 无文件，用系统命令生成含题号/选项结构的文本 PDF：

```bash
mkdir -p /Users/john/.zcode/workspace/default/question-seg-engine/sample
cat > /tmp/smoke.txt <<'EOF'
2026 年数学冒烟样卷

一、选择题

1．设集合 A = {x | x² = 1}，则 A 的元素个数为（　　）
A．0    B．1    C．2    D．3

2．已知函数 f(x) = 2x - 4，则 f(2) =（　　）
A．0    B．1    C．2    D．3

二、参考答案

1．B
2．A
EOF
cupsfilter /tmp/smoke.txt > sample/smoke.pdf 2>/dev/null
ls -la sample/smoke.pdf
```

Expected: 生成 `sample/smoke.pdf`（非 0 字节）。

- [ ] **Step 2: 写冒烟脚本（防御式字段查找，原始响应全程落盘）**

```typescript
// scripts/api-smoke.ts
/**
 * 真实 MinerU API 冒烟：<file> → 申请上传链接 → PUT → 轮询 → 下载 Zip。
 * 运行：node --import tsx scripts/api-smoke.ts <样卷路径>
 * 产物：data/smoke/raw/*.json（原始响应）、data/smoke/result.zip
 * 本脚本用于开发期确认字段结构，结果记录进 docs/real-api-notes.md。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const BASE = "https://mineru.net/api/v4";
const KEY = process.env.mineru_API_KEY;
if (!KEY) {
  console.error("缺少 mineru_API_KEY 环境变量");
  process.exit(2);
}
const filePath = process.argv[2];
if (!filePath) {
  console.error("用法: node --import tsx scripts/api-smoke.ts <file>");
  process.exit(2);
}

mkdirSync("data/smoke/raw", { recursive: true });
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const find = (o: any, keys: string[]): any => {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  for (const v of Object.values(o)) {
    const r = find(v, keys);
    if (r !== undefined) return r;
  }
  return undefined;
};

async function main() {
  const data = readFileSync(filePath);

  // 1) 申请上传链接（file-urls/batch）
  const uploadRes = await fetch(`${BASE}/file-urls/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ files: [{ fileName: basename(filePath), fileSize: data.length }] }),
  });
  const uploadJson = await uploadRes.json();
  writeFileSync("data/smoke/raw/upload-response.json", JSON.stringify(uploadJson, null, 2));
  const batchId = find(uploadJson, ["batch_id", "batchId"]) as string | undefined;
  const putUrl = find(uploadJson, ["file_url", "url", "uploadUrl"]) as string | undefined;
  if (!batchId || !putUrl) {
    console.error("未能解析 batch_id / 上传链接，详见 data/smoke/raw/upload-response.json");
    process.exit(3);
  }
  console.log("batch_id:", batchId);

  // 2) PUT 上传（Content-Type 按文件类型）
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": filePath.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream" },
    body: data,
  });
  writeFileSync("data/smoke/raw/put-status.txt", `status=${putRes.status} ${await putRes.text()}`);
  if (putRes.status >= 400) {
    console.error("PUT 上传失败，见 data/smoke/raw/put-status.txt");
    process.exit(4);
  }

  // 3) 轮询（最多 10 分钟，每 5s 一次）
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/extract-results/batch/${batchId}`, { headers });
    const j = await r.json();
    const state = String(find(j, ["state", "status"]) ?? "unknown");
    if (i % 10 === 0) console.log(`poll[${i}] state=${state}`);
    if (state === "done" || state === "finished") {
      writeFileSync("data/smoke/raw/poll-final.json", JSON.stringify(j, null, 2));
      const zipUrl = find(j, ["file_url", "url"]) as string | undefined;
      if (!zipUrl) {
        console.error("任务完成但未找到 zip 下载地址，见 data/smoke/raw/poll-final.json");
        process.exit(5);
      }
      const zip = Buffer.from(await (await fetch(zipUrl, { headers })).arrayBuffer());
      writeFileSync("data/smoke/result.zip", zip);
      console.log(`zip 已保存: data/smoke/result.zip (${zip.byteLength} bytes)`);
      return;
    }
    if (state === "failed") {
      console.error("任务失败:", JSON.stringify(j).slice(0, 500));
      process.exit(6);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.error("轮询超时（10 分钟）");
  process.exit(7);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: 运行冒烟并记录字段事实**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx scripts/api-smoke.ts sample/smoke.pdf
```

Expected: 打印 `batch_id` → `poll[...]` → `zip 已保存`。若失败，按 `data/smoke/raw/` 中落盘的原始响应排查（可能需调整请求体字段名，如 `files` 内字段）。成功后：

```bash
mkdir -p data/smoke/unpacked
cd data/smoke/unpacked && unzip -o ../result.zip && ls -R . | head -40
cd /Users/john/.zcode/workspace/default/question-seg-engine
```

Expected: 看到 `*_content_list.json`、`full.md`、`images/` 等条目。

- [ ] **Step 4: 写 docs/real-api-notes.md（字段事实表，Task 3/4 的唯一依据）**

```markdown
# 真实 MinerU API 观测记录（2026-08-18 冒烟）

> 本文件是客户端解析代码的唯一字段事实来源。任何字段名以实测为准，官方文档与实测冲突时以实测为准并记录差异。

## 1. POST /api/v4/file-urls/batch（申请上传链接）

请求体（实测前假设，记录实际使用值）: `{"files": [{"fileName": "...", "fileSize": n}]}`

响应字段（从 data/smoke/raw/upload-response.json 抄录）:
- batch_id: <实际字段名与示例值>
- 上传链接字段: <file_url / url / ...>

## 2. PUT 上传

- 状态码与响应: <从 put-status.txt 抄录>

## 3. GET /api/v4/extract-results/batch/{batch_id}（轮询）

状态字段: <state / status 的实际取值序列>
完成态取值: <done / finished 等>
zip 下载字段: <file_url / url>

## 4. 结果 Zip 结构（data/smoke/unpacked/）

- content_list 文件名: <如 xxx_content_list.json>
- 图片目录: images/
- 其他条目: <列举>

## 5. 与官方文档的差异

- <如有>
```

- [ ] **Step 5: 抽取真实 content_list 供回归**

```bash
cp "$(ls data/smoke/unpacked/*content_list.json | head -1)" data/smoke/content_list.json
```

Expected: `data/smoke/content_list.json` 存在（Task 4 的回归样本）。

- [ ] **Step 6: 提交（不含 data/ 与 sample/，两者已 gitignore）**

```bash
git add scripts/api-smoke.ts docs/real-api-notes.md sample/README.md
git commit -m "feat: real API smoke script + observed field notes"
```

---

### Task 3: MinerU 客户端封装（src/mineru/client.ts，离线测试）

**Files:**
- Create: `src/mineru/client.ts`
- Create: `tests/mineru-client.test.ts`
- Create: `tests/fixtures/upload-response.sample.json`（Task 2 真实响应的脱敏副本，字段名保留）

**Interfaces:**
- Consumes: `docs/real-api-notes.md` 字段表；Task 2 的 `data/smoke/raw/upload-response.json`（脱敏复制）
- Produces:
  - `interface MineruConfig { baseUrl: string; apiKey: string }`
  - `interface PendingUpload { fileName: string; size: number }`
  - `interface UploadBatch { batchId: string; putUrl: string }`
  - `class MineruClient { createUpload(f: PendingUpload): Promise<UploadBatch>; uploadFile(putUrl: string, data: Buffer, contentType: string): Promise<{ status: number }>; pollResult(batchId: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<{ zipUrl: string }>; downloadZip(zipUrl: string): Promise<Buffer> }`
  - 构造注入 transport：`new MineruClient(cfg, transport?)`，transport 类型 `typeof fetch`

- [ ] **Step 1: 脱敏复制真实响应为测试夹具**

```bash
mkdir -p tests/fixtures
cp data/smoke/raw/upload-response.json tests/fixtures/upload-response.sample.json
git add tests/fixtures/upload-response.sample.json docs/real-api-notes.md
git commit -m "test: capture real upload-response as fixture"
```

（如响应含疑似敏感字段，手工编辑该文件再提交；字段名保留，值是真实形态。）

- [ ] **Step 2: 写失败测试（Transport 注入 + 字段解析）**

```typescript
// tests/mineru-client.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MineruClient } from "../src/mineru/client.js";

const sampleRes = JSON.parse(
  readFileSync(new URL("./fixtures/upload-response.sample.json", import.meta.url), "utf8"),
);

test("createUpload：解析真实字段并返回 batchId / putUrl", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(sampleRes), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "test-key" }, transport);
  const batch = await client.createUpload({ fileName: "a.pdf", size: 123 });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/file-urls\/batch$/);
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.ok(batch.batchId.length > 0);
  assert.match(batch.putUrl, /^https?:\/\//);
});

test("pollResult：按 notes 状态轮询至完成并返回 zipUrl；失败态抛错", async () => {
  const states = ["pending", "running", "done"];
  const transport = (async (_url: string, _init?: RequestInit) => {
    const state = states.shift() ?? "done";
    const body: Record<string, unknown> = { state };
    if (state === "done") body.file_url = "https://mineru.net/zip/abc.zip";
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: "k" }, transport);
  const r = await client.pollResult("b1", { intervalMs: 1, timeoutMs: 5000 });
  assert.equal(r.zipUrl, "https://mineru.net/zip/abc.zip");
});
```

（注：`client.ts` 的解析字段须对照 `docs/real-api-notes.md` 抄录的真实字段名——若 notes 中实际字段与上面示例不同，以 notes 为准修测试夹具字段；`sampleRes` 按真实响应形态调整键名。）

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test "tests/mineru-client.test.ts"`
Expected: FAIL（`Cannot find module '../src/mineru/client.js'`）

- [ ] **Step 4: 实现客户端**

```typescript
// src/mineru/client.ts
/**
 * MinerU 云 API 客户端（上游适配实现）。
 * 字段解析以 docs/real-api-notes.md 的实测记录为准；transport 注入是为了离线测试。
 * API Key 仅来自构造参数（调用方从 process.env.mineru_API_KEY 读取），本文件不触碰环境变量。
 */
export interface MineruConfig {
  baseUrl: string;
  apiKey: string;
}

export interface PendingUpload {
  fileName: string;
  size: number;
}

export interface UploadBatch {
  batchId: string;
  putUrl: string;
}

export interface PollResult {
  zipUrl: string;
}

const find = (o: unknown, keys: string[]): unknown => {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) if (rec[k] !== undefined) return rec[k];
  for (const v of Object.values(rec)) {
    const r = find(v, keys);
    if (r !== undefined) return r;
  }
  return undefined;
};

export class MineruClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly transport: typeof fetch;

  constructor(cfg: MineruConfig, transport: typeof fetch = fetch) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.headers = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
    this.transport = transport;
  }

  async createUpload(f: PendingUpload): Promise<UploadBatch> {
    const res = await this.transport(`${this.baseUrl}/file-urls/batch`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ files: [{ fileName: f.fileName, fileSize: f.size }] }),
    });
    if (!res.ok) throw new Error(`file-urls/batch 失败: HTTP ${res.status} ${await res.text()}`);
    const json: unknown = await res.json();
    const batchId = find(json, ["batch_id", "batchId"]);
    const putUrl = find(json, ["file_url", "url", "uploadUrl"]);
    if (typeof batchId !== "string" || !batchId) throw new Error("响应中未找到 batch_id，见 docs/real-api-notes.md");
    if (typeof putUrl !== "string" || !putUrl) throw new Error("响应中未找到上传链接，见 docs/real-api-notes.md");
    return { batchId, putUrl };
  }

  async uploadFile(putUrl: string, data: Buffer, contentType: string): Promise<{ status: number }> {
    const res = await this.transport(putUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: data,
    });
    if (res.status >= 400) throw new Error(`PUT 上传失败: HTTP ${res.status} ${await res.text()}`);
    return { status: res.status };
  }

  async pollResult(
    batchId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PollResult> {
    const intervalMs = opts.intervalMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`轮询超时（${timeoutMs}ms）`);
      const res = await this.transport(`${this.baseUrl}/extract-results/batch/${batchId}`, {
        headers: this.headers,
      });
      if (!res.ok) throw new Error(`轮询失败: HTTP ${res.status}`);
      const json: unknown = await res.json();
      const state = String(find(json, ["state", "status"]) ?? "unknown");
      if (state === "failed") throw new Error(`解析任务失败: ${JSON.stringify(json).slice(0, 300)}`);
      if (state === "done" || state === "finished") {
        const zipUrl = find(json, ["file_url", "url"]);
        if (typeof zipUrl !== "string" || !zipUrl) throw new Error("完成态未找到 zip 下载地址");
        return { zipUrl };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async downloadZip(zipUrl: string): Promise<Buffer> {
    const res = await this.transport(zipUrl, { headers: this.headers });
    if (!res.ok) throw new Error(`zip 下载失败: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
```

（字段名与真实响应的偏差以 `docs/real-api-notes.md` 为准同步调整；`find()` 保持防御式递归查找，字段事实表更新时无需改代码。）

- [ ] **Step 5: 运行确认通过**

Run: `node --import tsx --test "tests/mineru-client.test.ts"`
Expected: PASS（2 个用例）

- [ ] **Step 6: 提交**

```bash
git add src/mineru/client.ts tests/mineru-client.test.ts tests/fixtures/upload-response.sample.json
git commit -m "feat: MinerU API client (injectable transport, offline-tested)"
```

---

### Task 4: 结果解包与真实数据回归（src/mineru/unpack.ts）

**Files:**
- Create: `src/mineru/unpack.ts`
- Create: `tests/mineru-unpack.test.ts`
- Copy: `data/smoke/content_list.json` → `tests/fixtures/real-content-list.sample.json`（回归样本）

**Interfaces:**
- Consumes: `MineruClient.downloadZip` 的 `Buffer`；Task 2 的真实 content_list
- Produces:
  - `interface UnpackedResult { contentList: unknown; markdown: string; images: { path: string; data: Buffer }[] }`
  - `function unpackResult(zipBuffer: Buffer): UnpackedResult`
  - `function segmentRealContentList(unknownContentList: unknown, docId: string)`（在 index.ts 导出，见 Task 5）

- [ ] **Step 1: 复制真实 content_list 为回归夹具**

```bash
cp data/smoke/content_list.json tests/fixtures/real-content-list.sample.json
```

（体积大于 1MB 时先裁剪为前 2 页的块再提交，保留字段形态即可。）

- [ ] **Step 2: 写失败测试**

```typescript
// tests/mineru-unpack.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { unpackResult } from "../src/mineru/unpack.js";

test("unpackResult：提取 content_list / markdown / 图片", () => {
  const zip = new AdmZip();
  zip.addFile("doc/content_list.json", Buffer.from(`{"pdf_info":[],"images":[]}`));
  zip.addFile("doc/full.md", Buffer.from("# demo"));
  zip.addFile("doc/images/img1.png", Buffer.from("fake-png"));
  const out = unpackResult(zip.toBuffer());
  assert.deepEqual((out.contentList as { images: unknown[] }).images, []);
  assert.equal(out.markdown, "# demo");
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0]!.path, "doc/images/img1.png");
});

test("unpackResult：真实 content_list 样本可被切分管线消费（无异常）", () => {
  const { segmentRealContentList } = await import("../src/index.js");
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/real-content-list.sample.json", import.meta.url), "utf8"),
  );
  const r = segmentRealContentList(raw, "real-sample");
  assert.ok(Array.isArray(r.questions));
  assert.ok("stats" in r);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test "tests/mineru-unpack.test.ts"`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现解包 + index 出口**

```typescript
// src/mineru/unpack.ts
/**
 * 结果 Zip 解包：提取 *_content_list.json / full.md / images/。
 * 文件名匹配容错（前缀随文档名变化），只认后缀。
 */
import AdmZip from "adm-zip";
import type { ParsedBlock, ParsedDocument } from "../types.js";

export interface UnpackedResult {
  contentList: unknown;
  markdown: string;
  images: { path: string; data: Buffer }[];
}

export function unpackResult(zipBuffer: Buffer): UnpackedResult {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const name = (e: (typeof entries)[number]) => e.entryName;

  const contentEntry = entries.find((e) => name(e).endsWith("content_list.json"));
  if (!contentEntry) throw new Error("Zip 中未找到 *_content_list.json");
  const contentList = JSON.parse(contentEntry.getData().toString("utf8"));

  const mdEntry = entries.find((e) => name(e).toLowerCase().endsWith("full.md") || name(e).endsWith(".md"));
  const markdown = mdEntry ? mdEntry.getData().toString("utf8") : "";

  const images = entries
    .filter((e) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name(e)))
    .map((e) => ({ path: name(e), data: e.getData() }));

  return { contentList, markdown, images };
}

/** 供 index.ts 出口复用：content_list → 切分管线 */
export type { ParsedBlock, ParsedDocument };
```

`src/index.ts` 追加：

```typescript
import { unpackResult } from "./mineru/unpack.js";

/** 真实 content_list JSON → 结构化题目（接入层入口，replace 现有 segmentFromContentList 的同名语义） */
export function segmentRealContentList(raw: unknown, docId: string) {
  const doc = normalizeContentList(raw, docId);
  return ruleStrategy.segment(doc);
}
```

（若 `normalizeContentList` 对真实结构存在字段偏差——如块类型名、bbox 形态——在 Task 4 修复 `normalize.ts`，并把差异记录进 `docs/real-api-notes.md` 第 5 节。）

- [ ] **Step 5: 运行确认通过**

Run: `node --import tsx --test "tests/mineru-unpack.test.ts"`
Expected: PASS（2 个用例）；真实样本切分无异常、`r.stats.totalBlocks > 0`

- [ ] **Step 6: 提交**

```bash
git add src/mineru/unpack.ts tests/mineru-unpack.test.ts tests/fixtures/real-content-list.sample.json src/index.ts
git commit -m "feat: unpack result zip + real content_list regression"
```

---

### Task 5: 端到端管线脚本（scripts/real-pipeline.ts）

**Files:**
- Create: `scripts/real-pipeline.ts`

**Interfaces:**
- Consumes: `MineruClient`（Task 3）、`unpackResult`（Task 4）、`segmentFromContentList` + `summarize`（既有 index.ts）
- Produces: `data/out/<docId>/` 目录：`result.zip`、`content_list.json`、`full.md`、`images/`、`questions.json`（结构化结果）、`summary.txt`；命令行成功码

- [ ] **Step 1: 写脚本**

```typescript
// scripts/real-pipeline.ts
/**
 * 端到端：本地样卷 → MinerU 云解析 → 解包 → 结构化切分 → 产物落盘。
 * 运行：node --import tsx scripts/real-pipeline.ts <文件或目录> [--out data/out] [--strategy rule-engine-v1]
 * API Key 从 process.env.mineru_API_KEY 读取，不打印。
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { MineruClient } from "../src/mineru/client.js";
import { unpackResult } from "../src/mineru/unpack.js";
import { segmentFromContentList, summarize } from "../src/index.js";

const KEY = process.env.mineru_API_KEY;
if (!KEY) {
  console.error("缺少 mineru_API_KEY 环境变量");
  process.exit(2);
}

const input = process.argv[2];
const outRoot = process.argv[3] ?? "data/out";
if (!input) {
  console.error("用法: node --import tsx scripts/real-pipeline.ts <file|dir> [outRoot]");
  process.exit(2);
}

const files = statSync(input).isDirectory()
  ? readdirSync(input)
      .filter((f) => /\.(pdf|png|jpe?g|webp|bmp)$/i.test(f))
      .map((f) => join(input, f))
  : [input];
if (files.length === 0) {
  console.error("输入目录中没有可解析的 PDF/图片");
  process.exit(2);
}

async function main() {
  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: KEY });
  for (const file of files) {
    const docId = basename(file).replace(/\.[^.]+$/, "");
    console.log(`[1/5] 上传 ${basename(file)}`);
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(file);
    const batch = await client.createUpload({ fileName: basename(file), size: data.length });
    await client.uploadFile(batch.putUrl, data, file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");

    console.log("[2/5] 轮询解析结果…");
    const { zipUrl } = await client.pollResult(batch.batchId);

    console.log("[3/5] 下载结果 Zip");
    const zip = await client.downloadZip(zipUrl);
    const out = join(outRoot, docId);
    mkdirSync(join(out, "images"), { recursive: true });
    writeFileSync(join(out, "result.zip"), zip);

    console.log("[4/5] 解包 + 结构化切分");
    const { contentList, markdown, images } = unpackResult(zip);
    writeFileSync(join(out, "content_list.json"), JSON.stringify(contentList, null, 2));
    writeFileSync(join(out, "full.md"), markdown);
    for (const img of images) writeFileSync(join(out, "images", basename(img.path)), img.data);

    const result = segmentFromContentList(contentList, docId);
    writeFileSync(join(out, "questions.json"), JSON.stringify(result.questions, null, 2));
    const summary = summarize(result);
    writeFileSync(join(out, "summary.txt"), summary);

    console.log(`[5/5] 完成 ${docId}: ${result.questions.length} 道题，${result.stats.reviewCount} 处待校对`);
    console.log(summary.split("\n").slice(0, 4).join("\n"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: 验收（需要 sample/ 样卷）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx scripts/real-pipeline.ts sample
```

Expected: 每个样卷文件在 `data/out/<docId>/` 产出 6 类产物；summary 显示题目数 > 0；reviewCount 有值（可为 0）。

- [ ] **Step 3: 人工检查 questions.json 与真实卷面的一致性**

打开 `data/out/smoke/questions.json`，对照 `sample/smoke.pdf`：题数一致、题干无前缀、选项 4 个、答案对号。发现问题 → 记录到 `docs/real-api-notes.md` 第 5 节 + 修复 normalize/patterns。

- [ ] **Step 4: 提交**

```bash
git add scripts/real-pipeline.ts
git commit -m "feat: end-to-end real API pipeline script"
```

---

### Task 6: 决策记录追加与 README 说明

**Files:**
- Modify: `docs/DECISIONS.md`（追加章节）
- Modify: `README.md`（真实 API 使用段）

**Interfaces:**
- Consumes: Task 2~5 的观测与产物
- Produces: 切片的决策记录补全（真实差异表、schema 缺口、指标基线）

- [ ] **Step 1: DECISIONS.md 追加「真实 API 接入观测」章节**

```markdown
## 10. 真实 API 接入观测（2026-08-18 ~ 切片完成日）

- 真实结构差异（与官方文档/预期不同处，指向 docs/real-api-notes.md）
- schema 缺口清单（真实样卷暴露、需要增量追加字段的形态，如 <fixture 未覆盖的排版>）
- 指标基线（第一次真实跑：题目切分准确率 / 公式语义抽检 / 图片归属 / review 占比）
- 冒烟结论（手写答案样卷结果：可行 / 不可行 / 需兜底）
```

按实际观测填完每一条（每条 = 结论 + 依据 + 后续动作）。

- [ ] **Step 2: README.md 补「真实 API 使用」段落**

````markdown
## 真实 MinerU API

```bash
# 冒烟（开发期确认字段结构，产物入 data/smoke/）
node --import tsx scripts/api-smoke.ts sample/smoke.pdf

# 端到端管线（样卷目录 → data/out/）
node --import tsx scripts/real-pipeline.ts sample
```

- API Key 从 `process.env.mineru_API_KEY` 读取，仅服务端使用，不出现在产物与日志。
- 真实网络调用不纳入 `npm test`；离线测试见 `tests/mineru-client.test.ts`、`tests/mineru-unpack.test.ts`。
- 字段事实以 `docs/real-api-notes.md` 为准。
````

- [ ] **Step 3: 全量验证**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过（含新增 client/unpack 用例）。

- [ ] **Step 4: 提交**

```bash
git add docs/DECISIONS.md README.md
git commit -m "docs: record real API observations and usage"
```

---

## Self-Review 检查

- **覆盖度**：申请上传→上传→轮询→下载→解包→切分→落盘全链路均有任务；字段事实以实测为准（Task 2 前置）；离线测试约束在 Global Constraints 与各 Task 落实。
- **占位扫描**：Task 2/3 中「以 notes 为准」是有明确产物的依赖（Task 2 Step 4 定义了字段表文件结构），非 TODO；Task 6 的「按实际观测填完」待真实跑完后的既有产物（Task 2 Step 4 的 notes + Task 5 产物），非悬空。
- **类型一致性**：`MineruClient.createUpload → UploadBatch{batchId,putUrl}`、`pollResult → {zipUrl}`、`unpackResult → UnpackedResult`、`segmentFromContentList`（既有）在 Task 3/4/5 之间签名一致；index.ts 新增 `segmentRealContentList` 在 Task 4 定义、Task 4 测试引用。