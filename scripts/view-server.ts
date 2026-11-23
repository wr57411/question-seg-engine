// scripts/view-server.ts
/**
 * 零依赖静态文件服务器 + 标签写通道：展示层预览入口。
 * 运行：npm run view [docId]（默认 23必刷题 2相互作用）
 * 只用 node:http / node:fs / node:path / node:os，无任何外部依赖。
 *
 * ⚠️ 本文件承载**本项目第一条写路径** `POST /api/tags`（需求规格 U19~U23 与 §6 安全口径）：
 * 标签是人工劳动成果，必须落盘成文件才谈得上「刷新不丢 / 换设备也在」。
 * 写路径的约束（勿在其它分支扩面）：
 *   1. 只认 `data/out/<doc>/stages.json` 里真实存在过的 doc —— 目录名即白名单，不接受客户端传路径；
 *   2. 落盘位置由服务端拼接 `data/out/tags/…`，`resolve()` 后断言仍在该前缀内；
 *   3. 先算完整内容 → 写临时文件 → `rename()` 原子替换（中断不留半截 JSON）；
 *   4. 静态读白名单不变，不把 `/data/out` 整体变成可写区。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { isKnownDoc, MAX_BODY, tagFilePath, tagsWriteEnabled, validatePayload } from "./tag-write-guards.js";
import {
  isKnownDoc as isKnownTeachDoc,
  isTeachScope,
  teachFilePath,
  validateTeachPayload,
} from "./teach-write-guards.js";
import { countTeachUsage, planTeachManage, validateManageRequest } from "./teach-manage.js";
import {
  FEEDBACK_MAX_BODY,
  feedbackWriteEnabled,
  parseAction,
  parseShotDataUrl,
  shotFileName,
  validateCreatePayload,
  validateMutationPayload,
  validateStoreShape,
  validateAskPayload,
  validateAnswerPayload,
  FEEDBACK_KINDS,
  type FeedbackKind,
} from "./feedback-write-guards.js";
import { classifyDoc, readLayoutBackend, TEST_DOC_NAMES } from "./doc-lineage.js";
import type { Artifact, Lineage } from "./doc-lineage.js";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 4173);
/** 默认只监听本机；手机/平板用 `npm run view:lan`（HOST=0.0.0.0）显式开 LAN。 */
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const READ_ONLY = !tagsWriteEnabled();
const docId = process.argv[2] ?? "23必刷题 2相互作用";

const TAG_DIR = join(ROOT, "data", "out", "tags");
const FEEDBACK_DIR = join(ROOT, "data", "out", "feedback");
const FEEDBACK_FILE = join(FEEDBACK_DIR, "feedbacks.json");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  // 原卷 PDF：缺这条会被当成 application/octet-stream → 浏览器下载/空白页，
  // 而不是内嵌显示（「对照原卷本页」链接因此点了等于没点）。
  ".pdf": "application/pdf",
};

function readBody(req: IncomingMessage, cap = MAX_BODY): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        rej(new Error(`请求体超过 ${cap} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

/** 原子写：完整内容先算好 → 写 .tmp → rename 替换（中断不会留下半截文件）。 */
async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function handleTagsWrite(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (READ_ONLY) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "标签写通道已关闭（TAGS_WRITE=0）" }));
    return;
  }
  const scope = url.searchParams.get("scope") ?? "";
  const doc = url.searchParams.get("doc") ?? "";
  if (scope !== "library" && !(await isKnownDoc(ROOT, doc))) {
    // doc 不在白名单：不写、不建目录，只回错误（目录名即白名单，见 tag-write-guards.ts）
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `doc 不在白名单内：${JSON.stringify(doc).slice(0, 130)}` }));
    return;
  }
  const target = tagFilePath(TAG_DIR, scope, doc);
  if (!target) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "落盘路径越界" }));
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `JSON 解析失败：${String(e).slice(0, 200)}` }));
    return;
  }
  const invalid = validatePayload(scope, payload);
  if (invalid) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: invalid }));
    return;
  }
  try {
    const text = `${JSON.stringify(payload, null, 1)}\n`;
    await atomicWrite(target, text);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(text), at: new Date().toISOString() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `写入失败：${String(e).slice(0, 200)}` }));
  }
}

/**
 * 教学归类写通道（第二条写路径）。与 `/api/tags` 同样的约束：
 * scope 白名单、doc 白名单、路径断言、形状校验、原子替换；失败不落半截。
 */
async function handleTeachWrite(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const scope = url.searchParams.get("scope") ?? "";
  const doc = url.searchParams.get("doc") ?? "";
  if (!isTeachScope(scope)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `非法 scope：${JSON.stringify(scope).slice(0, 80)}` }));
    return;
  }
  if (scope === "bindings" && !(await isKnownTeachDoc(ROOT, doc))) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `doc 不在白名单内：${JSON.stringify(doc).slice(0, 130)}` }));
    return;
  }
  const target = teachFilePath(ROOT, scope, doc);
  if (!target) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "落盘路径越界" }));
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `JSON 解析失败：${String(e).slice(0, 200)}` }));
    return;
  }
  const invalid = validateTeachPayload(scope, payload);
  if (invalid) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: invalid }));
    return;
  }
  try {
    const text = `${JSON.stringify(payload, null, 1)}\n`;
    await atomicWrite(target, text);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(text), at: new Date().toISOString() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `写入失败：${String(e).slice(0, 200)}` }));
  }
}

/* ── 教学归类管理（改名 / 删除）：一次请求跨所有卷级联，任一步失败整体回滚 ── */

const TEACH_DIR = join(ROOT, "data", "out", "teach");

interface ReadJson {
  text: string;
  data: unknown;
}

/** 读一份 JSON：文件不存在返回 null；解析失败返回 {text, parseError}。 */
async function readJsonFile(file: string): Promise<ReadJson | { parseError: string } | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return { text, data: JSON.parse(text) };
  } catch (e) {
    return { parseError: String(e).slice(0, 160) };
  }
}

/** bindings 目录里的每一卷（文件名即 doc；不接受客户端传路径）。 */
async function listBindingFiles(): Promise<{ doc: string; file: string }[]> {
  const dir = join(TEACH_DIR, "bindings");
  const names = await readdir(dir).catch(() => [] as string[]);
  const base = resolve(TEACH_DIR);
  const out: { doc: string; file: string }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = resolve(join(dir, name));
    if (!file.startsWith(base + sep)) continue;
    out.push({ doc: name.slice(0, -".json".length), file });
  }
  return out;
}

function jsonOut(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

/** 某个专题/类别在**所有卷**上被多少题在用（管理面板要先把这个数摆出来再让人删）。 */
async function handleTeachUsage(res: ServerResponse): Promise<void> {
  const files = await listBindingFiles();
  const bindings: { doc: string; raw: unknown }[] = [];
  const broken: string[] = [];
  for (const f of files) {
    const r = await readJsonFile(f.file);
    if (!r || "parseError" in r) {
      if (r) broken.push(f.doc);
      continue;
    }
    bindings.push({ doc: f.doc, raw: r.data });
  }
  jsonOut(res, 200, { ok: true, usage: countTeachUsage({ bindings }), docs: bindings.length, broken });
}

async function handleTeachManage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: `JSON 解析失败：${String(e).slice(0, 160)}` });
    return;
  }
  const invalid = validateManageRequest(body);
  if (invalid) {
    jsonOut(res, 403, { ok: false, error: invalid });
    return;
  }
  const req2 = body as { action: "rename" | "delete"; kind: "topics" | "categories"; id: string; name?: string };
  const listFile = teachFilePath(ROOT, req2.kind, "");
  const combosFile = teachFilePath(ROOT, "combos", "");
  if (!listFile || !combosFile) {
    jsonOut(res, 403, { ok: false, error: "落盘路径越界" });
    return;
  }
  const listRaw = await readJsonFile(listFile);
  if (listRaw && "parseError" in listRaw) {
    jsonOut(res, 500, { ok: false, error: `${req2.kind}.json 解析失败（${listRaw.parseError}），先修数据再管理` });
    return;
  }
  const combosRaw = await readJsonFile(combosFile);
  if (combosRaw && "parseError" in combosRaw) {
    jsonOut(res, 500, { ok: false, error: `combos.json 解析失败（${combosRaw.parseError}），先修数据再管理` });
    return;
  }
  const originals = new Map<string, string | null>();
  const bindings: { doc: string; raw: unknown }[] = [];
  for (const f of await listBindingFiles()) {
    const r = await readJsonFile(f.file);
    if (r && "parseError" in r) {
      jsonOut(res, 500, { ok: false, error: `bindings/${f.doc}.json 解析失败（${r.parseError}），先修数据再管理` });
      return;
    }
    originals.set(f.file, r ? r.text : null);
    if (r && !("parseError" in r)) bindings.push({ doc: f.doc, raw: r.data });
  }

  const plan = planTeachManage({
    ...req2,
    list: listRaw && !("parseError" in listRaw) ? listRaw.data : null,
    combos: combosRaw && !("parseError" in combosRaw) ? combosRaw.data : null,
    bindings,
    now: new Date().toISOString(),
  });
  if (!plan.ok) {
    jsonOut(res, 400, { ok: false, error: plan.error });
    return;
  }
  // 落盘前逐个校验新载荷：任何一个不合法就一个都不写
  const badList = validateTeachPayload(req2.kind, plan.listPayload);
  if (badList) {
    jsonOut(res, 500, { ok: false, error: `新清单不合法：${badList}` });
    return;
  }
  if (plan.combosPayload) {
    const bad = validateTeachPayload("combos", plan.combosPayload);
    if (bad) {
      jsonOut(res, 500, { ok: false, error: `新组合清单不合法：${bad}` });
      return;
    }
  }
  for (const bf of plan.bindingsFiles) {
    const bad = validateTeachPayload("bindings", bf.payload);
    if (bad) {
      jsonOut(res, 500, { ok: false, error: `${bf.doc} 的新归属不合法：${bad}` });
      return;
    }
  }

  const written: { file: string; before: string | null }[] = [];
  const put = async (file: string, payload: unknown) => {
    await atomicWrite(file, `${JSON.stringify(payload, null, 1)}\n`);
    written.push({ file, before: originals.get(file) ?? null });
  };
  try {
    originals.set(listFile, listRaw ? listRaw.text : null);
    originals.set(combosFile, combosRaw ? combosRaw.text : null);
    await put(listFile, plan.listPayload);
    if (plan.combosPayload) await put(combosFile, plan.combosPayload);
    for (const bf of plan.bindingsFiles) {
      const file = teachFilePath(ROOT, "bindings", bf.doc);
      if (!file) throw new Error(`bindings 路径越界：${JSON.stringify(bf.doc).slice(0, 80)}`);
      await put(file, bf.payload);
    }
  } catch (e) {
    for (const w of written.reverse()) {
      if (w.before !== null) await atomicWrite(w.file, w.before).catch(() => undefined);
    }
    jsonOut(res, 500, { ok: false, error: `写入失败，已回滚 ${written.length} 个文件：${String(e).slice(0, 160)}` });
    return;
  }
  jsonOut(res, 200, {
    ok: true,
    action: req2.action,
    kind: req2.kind,
    item: plan.itemName,
    affected: plan.affected,
    staleAffected: plan.staleAffected,
    combosChanged: plan.combosChanged,
    combosDropped: plan.combosDropped,
    list: req2.kind === "topics" ? plan.listPayload.topics : plan.listPayload.categories,
    combos: plan.combosPayload ? plan.combosPayload.combos : undefined,
    bindings: Object.fromEntries(plan.bindingsFiles.map((b) => [b.doc, b.payload])),
  });
}

/* ── 文档清单（成品页据此发现文档，取代前端硬编码 DOCS） ── */

interface DocListItem {
  id: string;
  label: string;
  kind: "quiz" | "answer";
  /** 有 meta.json = 跑过 `npm run daily` 的体检；false 时前端显示「未体检」，不假装健康 */
  examined: boolean;
  stats: Record<string, unknown> | null;
  health: { level: string; issues: string[] } | null;
  /**
   * T6：血缘（oxr / mineru / mixed）与产物角色（prod / parse / backup / test）。
   * 判据见 `scripts/doc-lineage.ts`（目录名后缀 + layout.json 的 `_backend`），
   * 让成品页能把「M5 切 OXR 的阶段性产物」与旧产物分开。
   */
  lineage: Lineage;
  artifact: Artifact;
}

/**
 * 扫 `data/out/<docId>/`：
 * - **只列有 stages.json 的目录**（没有快照 = 成品页打不开，列出来只会点出 404）；
 * - 有 meta.json 就带上体检摘要，没有就 `examined: false`（不猜）；
 * - **旧测试目录（`_tablecheck`，B-52）不进列表** —— 它不是可阅读的卷；
 * - 每册带 lineage/artifact（判据见 doc-lineage.ts，可核对）。
 */
async function listDocs(): Promise<DocListItem[]> {
  const outRoot = join(ROOT, "data", "out");
  const entries = await readdir(outRoot, { withFileTypes: true }).catch(() => []);
  const items: DocListItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if ((TEST_DOC_NAMES as readonly string[]).includes(e.name)) continue;
    const dir = join(outRoot, e.name);
    if (!existsSync(join(dir, "stages.json"))) continue;
    const backend = await readLayoutBackend(join(dir, "layout.json"));
    const { lineage, artifact } = classifyDoc(e.name, backend);
    let meta: {
      label?: string;
      kind?: "quiz" | "answer";
      stats?: Record<string, unknown>;
      health?: { level: string; issues: string[] };
    } | null = null;
    try {
      meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    } catch {
      meta = null;
    }
    items.push({
      id: e.name,
      label: meta?.label ?? e.name,
      kind: meta?.kind ?? (/答案|解析/.test(e.name) ? "answer" : "quiz"),
      examined: Boolean(meta),
      stats: meta?.stats ?? null,
      health: meta?.health ?? null,
      lineage,
      artifact,
    });
  }
  // 生产册在前、解析件/历史在后；同类里题册在前、答案册在后，再按名字（与翻书顺序一致）
  const rank = (d: DocListItem) => (d.artifact === "prod" ? 0 : 2) + (d.kind === "quiz" ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, "zh"));
  return items;
}

/* ── 反馈写通道（第三条写路径，2026-11-22）── */

/** 读 feedbacks.json：不存在 → 空库（首次写入才建目录）。 */
async function readFeedbackStore(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(FEEDBACK_FILE, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { version: 1, items: [] };
  }
}

/** 反馈条目列表（按 doc 过滤，倒序=新的在前）。LAN 可读（验收场景需要）。 */
async function handleFeedbackList(res: ServerResponse, url: URL): Promise<void> {
  const doc = url.searchParams.get("doc") ?? "";
  const store = await readFeedbackStore();
  const invalid = validateStoreShape(store);
  if (invalid) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `反馈库形状非法：${invalid}` }));
    return;
  }
  const items = (store["items"] as Record<string, unknown>[]).filter(
    (it) => !doc || it["docId"] === doc,
  );
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: true, items }));
}

/**
 * 反馈写入：create（含截图 dataURL→文件）/ supplement / update。
 * 开关 FEEDBACK_WRITE=0 时 403（默认开——iPad 真机验收是本功能主场景）。
 * doc 白名单语义与 tags 相同（目录名即白名单）。
 */
/**
 * 把「新反馈」作为事件送进 agent-autoloop 中台（2026-11-23 用户需求）。
 * 中台是**被动 HTTP 协议**（它不主动连任何东西）⇒ 由本服务主动 POST。
 * 配置：AGENT_AUTOLOOP_URL（默认 http://127.0.0.1:17171）+ AGENT_AUTOLOOP_KEY。
 * 未配置 / 发送失败 ⇒ 只打一行日志（反馈本身已落盘，用户可随时用 npm run feedback:collect 拉）。
 */
async function notifyAutoloop(ev: {
  id: string;
  kind: string;
  docId: unknown;
  comment: unknown;
}): Promise<void> {
  const url = process.env["AGENT_AUTOLOOP_URL"];
  const key = process.env["AGENT_AUTOLOOP_KEY"];
  if (!url || !key) return;
  try {
    // 协议（docs/protocol.md）：id + type 必填；subject=标识符（进提示词）。
    // summary/detail 只作记录不进提示词 ⇒ 反馈正文放 summary 会被 Agent 看到，需脱敏：正文放 detail。
    const body = JSON.stringify({
      id: ev.id,
      type: "feedback.created",
      subject: ev.id,
      summary: `新反馈（${ev.kind}）：${String(ev.docId || "全站")}`,
      detail: String(ev.comment ?? "").slice(0, 2000),
    });
    const r = await fetch(`${url.replace(/\/$/, "")}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) console.warn(`[feedback] 中台事件发送失败 HTTP ${r.status}`);
  } catch (e) {
    console.warn(`[feedback] 中台不可达（忽略）：${String(e).slice(0, 120)}`);
  }
}

async function handleFeedbackWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!feedbackWriteEnabled()) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "反馈写通道已关闭（FEEDBACK_WRITE=0）" }));
    return;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse((await readBody(req, FEEDBACK_MAX_BODY)).toString("utf8")) as Record<string, unknown>;
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `载荷读取/解析失败：${String(e).slice(0, 200)}` }));
    return;
  }
  const action = parseAction(payload);
  if (!action) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "action 必须是 create|supplement|update" }));
    return;
  }
  const store = await readFeedbackStore();
  const invalid = validateStoreShape(store);
  if (invalid) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `反馈库形状非法：${invalid}` }));
    return;
  }
  const items = store["items"] as Record<string, unknown>[];

  if (action === "create") {
    const item = payload["item"];
    const invalidItem = validateCreatePayload(item);
    if (invalidItem) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: invalidItem }));
      return;
    }
    const it = item as Record<string, unknown>;
    const isPageIssue = (it["kind"] ?? "page-issue") === "page-issue";
    if (isPageIssue && !(await isKnownDoc(ROOT, it["docId"]))) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "页面问题必须指向真实册（doc 不在白名单内）" }));
      return;
    }
    const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    const rnd = Math.random().toString(36).slice(2, 6);
    const id = `fb-${now}-${rnd}`;
    // doc 白名单：**只有页面问题**必须指向真实册；需求/想法/缺陷类可为空
    const kind = typeof it["kind"] === "string" ? it["kind"] : "page-issue";
    const record: Record<string, unknown> = {
      id,
      kind,
      docId: typeof it["docId"] === "string" ? it["docId"] : "",
      page: Number.isFinite(it["page"] as number) ? Math.max(0, Math.floor(it["page"] as number)) : null,
      questionNumber: typeof it["questionNumber"] === "string" ? it["questionNumber"] : "",
      comment: (it["comment"] as string).trim(),
      shot: null,
      supplements: [],
      questions: [],
      status: "open",
      reply: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const shot = parseShotDataUrl(it["shotDataUrl"]);
    if (typeof shot === "string") {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: shot }));
      return;
    }
    if (shot) {
      const rel = shotFileName(id, shot.ext);
      await mkdir(join(FEEDBACK_DIR, "shots"), { recursive: true });
      await writeFile(join(FEEDBACK_DIR, rel), shot.bytes);
      record["shot"] = rel;
    }
    items.push(record);
    const text = `${JSON.stringify(store, null, 1)}\n`;
    await mkdir(FEEDBACK_DIR, { recursive: true });
    await atomicWrite(FEEDBACK_FILE, text);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, id }));
    // 通知中台（autoagentloop）：失败只记日志，绝不影响用户提交成功
    void notifyAutoloop({ id, kind, docId: record["docId"], comment: record["comment"] });
    return;
  }

  // ask / answer：追问清单的写入与回答（2026-11-23 双向对话）
  if (action === "ask") {
    const askErr = validateAskPayload(payload);
    if (askErr) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: askErr }));
      return;
    }
    const target = items.find((it) => it["id"] === payload["id"]);
    if (!target) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `反馈不存在：${String(payload["id"]).slice(0, 80)}` }));
      return;
    }
    // 保留已有答案（幂等重写：追问文本可改，答案不丢）
    const prev = Array.isArray(target["questions"]) ? (target["questions"] as Record<string, unknown>[]) : [];
    const kept = new Map<string, unknown>(prev.map((q) => [String(q["id"]), q["answer"] ?? null]));
    target["questions"] = (payload["questions"] as Record<string, unknown>[]).map((q, i) => ({
      id: String(q["id"] ?? `q${i + 1}`),
      text: String(q["text"]).trim(),
      answer: kept.get(String(q["id"])) ?? null,
      answeredAt: null,
    }));
    target["status"] = "need-info";
    target["updatedAt"] = new Date().toISOString();
    await mkdir(FEEDBACK_DIR, { recursive: true });
    await atomicWrite(FEEDBACK_FILE, `${JSON.stringify(store, null, 1)}\n`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, id: payload["id"], questions: target["questions"] }));
    return;
  }
  if (action === "answer") {
    const ansErr = validateAnswerPayload(payload);
    if (ansErr) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: ansErr }));
      return;
    }
    const target = items.find((it) => it["id"] === payload["id"]);
    if (!target) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `反馈不存在：${String(payload["id"]).slice(0, 80)}` }));
      return;
    }
    const qs = (target["questions"] as Record<string, unknown>[]) ?? [];
    const q = qs.find((x) => String(x["id"]) === String(payload["questionId"]));
    if (!q) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "该追问不存在" }));
      return;
    }
    const nowIso = new Date().toISOString();
    q["answer"] = String(payload["answer"]).trim();
    q["answeredAt"] = nowIso;
    // 全部答完 ⇒ 回到处理队列；未答完 ⇒ 保持 need-info
    target["status"] = qs.every((x) => x["answer"]) ? "working" : "need-info";
    target["updatedAt"] = nowIso;
    await mkdir(FEEDBACK_DIR, { recursive: true });
    await atomicWrite(FEEDBACK_FILE, `${JSON.stringify(store, null, 1)}\n`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, id: payload["id"], status: target["status"] }));
    return;
  }

  // supplement / update：按 id 定位
  const mutErr = validateMutationPayload(action, payload);
  if (mutErr) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: mutErr }));
    return;
  }
  const target = items.find((it) => it["id"] === payload["id"]);
  if (!target) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: `反馈不存在：${String(payload["id"]).slice(0, 80)}` }));
    return;
  }
  const now = new Date().toISOString();
  if (action === "supplement") {
    const sup = target["supplements"] as unknown[];
    sup.push({ at: now, text: String(payload["text"]).trim() });
  } else {
    // update：仅 open 状态允许改正文（Agent 开始处理后只许补充，防覆盖已读上下文）
    if (target["status"] !== "open") {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "该反馈已在处理中，只能追加补充，不能再改正文" }));
      return;
    }
    target["comment"] = String(payload["comment"]).trim();
  }
  target["updatedAt"] = now;
  const text = `${JSON.stringify(store, null, 1)}\n`;
  await mkdir(FEEDBACK_DIR, { recursive: true });
  await atomicWrite(FEEDBACK_FILE, text);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: true, id: payload["id"] }));
}

/* ── 静态读 ── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/docs") {
      const docs = await listDocs();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ docs }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/teach-usage") {
      await handleTeachUsage(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/feedback") {
      await handleFeedbackList(res, url);
      return;
    }
    if (req.method === "POST") {
      // 只读开关（`TAGS_WRITE=0`）必须罩住**所有**写入口，否则「只读」是假承诺：
      // 合并后 teach 的两条写路径（归类 / 跨卷管理）与业务标签同级，一并受控。
      if (READ_ONLY && (url.pathname === "/api/teach" || url.pathname === "/api/teach-manage")) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "教学归类写通道已关闭（TAGS_WRITE=0）" }));
        return;
      }
      if (url.pathname === "/api/tags") await handleTagsWrite(req, res, url);
      else if (url.pathname === "/api/teach") await handleTeachWrite(req, res, url);
      else if (url.pathname === "/api/teach-manage") await handleTeachManage(req, res);
      else if (url.pathname === "/api/feedback") await handleFeedbackWrite(req, res);
      else res.writeHead(405).end("method not allowed");
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname));
    // "/" 或任意目录路径（以 / 结尾）一律落到该目录的 index.html
    if (path === "/") path = "/viewer/index.html";
    else if (path === "/topic") {
      // 少一个斜杠也进得去（用户/文档容易漏）；不把目录本身当 404
      res.writeHead(302, { Location: "/topic/" });
      res.end();
      return;
    } else if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, path);
    // 路径安全：只允许 /viewer /stages /final /topic 与 /data/out 前缀，且归一化后必须仍落在 ROOT 内
    if (!file.startsWith(ROOT) || !/^\/?(viewer|stages|final|topic|data\/out)/.test(path)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

/** 局域网 IPv4 地址（手机/平板要靠它访问；U27）。只报非内部的单播地址。 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const enc = encodeURIComponent(docId);
  const lan = HOST === "0.0.0.0" || HOST === "::";
  console.log(`成品页：  http://localhost:${PORT}/final/?doc=${enc}`);
  console.log(`viewer:   http://localhost:${PORT}/viewer/?doc=${enc}`);
  console.log(`stages:   http://localhost:${PORT}/stages/?doc=${enc}`);
  console.log(`  final  = 成品页：按原坐标重建的纸面，整册滚动翻（与 stages 的「对比」右侧同一实现）`);
  console.log(`  viewer = 阅读版：目录/答案开关/筛选，供检索与答题`);
  console.log(`  stages = 七视图样品展示（原卷→原料→阅读顺序→切题→质检→成品→对比）`);
  console.log(`  无快照时先运行 npm run stages:export 生成`);
  console.log(`  换卷：npm run view <docId> 或用 ?doc=<docId> 查询参数（doc 需完整，空格写 %20）`);
  if (READ_ONLY) console.log(`  标签写通道：只读（TAGS_WRITE=0）`);
  if (lan) {
    // 显式开了 LAN 才报；默认只监听本机，避免同网段默认可写（HANDOFF §6-10）
    const hosts = lanAddresses();
    if (hosts.length > 0) {
      console.log(`\n手机 / 平板请用下面的地址（需与本机同一 WiFi）：`);
      for (const h of hosts) console.log(`  成品页  http://${h}:${PORT}/final/?doc=${enc}`);
      console.log(`  打不开时：系统设置 → 通用 → 关于本机 查 IP；并放行 macOS 防火墙对 node 的入站连接`);
      if (!READ_ONLY) {
        console.log(`  ⚠️ 标签写通道：同网段可写；共享网络请加 TAGS_WRITE=0 只读`);
      }
    } else {
      console.log(`\n⚠️ 未找到局域网 IPv4 地址 —— 手机/平板将无法访问（检查 WiFi 连接或网络权限）`);
    }
  } else {
    console.log(`\n仅本机访问（默认）。手机/平板请运行：npm run view:lan（或 HOST=0.0.0.0 npm run view）`);
    if (!READ_ONLY) console.log(`  标签写通道：仅本机可写；LAN 调试请显式开 view:lan`);
  }
});
