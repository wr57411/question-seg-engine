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
import { extname, join, normalize, resolve } from "node:path";
import { isKnownDoc, MAX_BODY, tagFilePath, tagsWriteEnabled, validatePayload } from "./tag-write-guards.js";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 4173);
/** 默认只监听本机；手机/平板用 `npm run view:lan`（HOST=0.0.0.0）显式开 LAN。 */
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const READ_ONLY = !tagsWriteEnabled();
const docId = process.argv[2] ?? "23必刷题 2相互作用";

const TAG_DIR = join(ROOT, "data", "out", "tags");

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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        rej(new Error(`请求体超过 ${MAX_BODY} 字节上限`));
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

/* ── 文档清单（成品页据此发现文档，取代前端硬编码 DOCS） ── */

interface DocListItem {
  id: string;
  label: string;
  kind: "quiz" | "answer";
  /** 有 meta.json = 跑过 `npm run daily` 的体检；false 时前端显示「未体检」，不假装健康 */
  examined: boolean;
  stats: Record<string, unknown> | null;
  health: { level: string; issues: string[] } | null;
}

/**
 * 扫 `data/out/<docId>/`：
 * - **只列有 stages.json 的目录**（没有快照 = 成品页打不开，列出来只会点出 404）；
 * - 有 meta.json 就带上体检摘要，没有就 `examined: false`（不猜）。
 */
async function listDocs(): Promise<DocListItem[]> {
  const outRoot = join(ROOT, "data", "out");
  const entries = await readdir(outRoot, { withFileTypes: true }).catch(() => []);
  const items: DocListItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(outRoot, e.name);
    if (!existsSync(join(dir, "stages.json"))) continue;
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
    });
  }
  // 题册在前、答案册在后，同类按名字（与用户的翻书顺序一致）
  const rank = (d: DocListItem) => (d.kind === "quiz" ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, "zh"));
  return items;
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
    if (req.method === "POST") {
      if (url.pathname === "/api/tags") await handleTagsWrite(req, res, url);
      else res.writeHead(405).end("method not allowed");
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname));
    // "/" 或任意目录路径（以 / 结尾）一律落到该目录的 index.html
    if (path === "/") path = "/viewer/index.html";
    else if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, path);
    // 路径安全：只允许 /viewer /stages /final 与 /data/out 前缀，且归一化后必须仍落在 ROOT 内
    if (!file.startsWith(ROOT) || !/^\/?(viewer|stages|final|data\/out)/.test(path)) {
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
