// scripts/view-server.ts
/**
 * 零依赖静态文件服务器：viewer 预览入口。
 * 运行：npm run view [docId]（默认 23必刷题 2相互作用）
 * 只用 node:http / node:fs / node:path，无任何外部依赖。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 4173);
const docId = process.argv[2] ?? "23必刷题 2相互作用";

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
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    let path = normalize(decodeURIComponent(url.pathname));
    if (path === "/") path = "/viewer/index.html";
    const file = join(ROOT, path);
    // 路径安全：只允许 /viewer 与 /data/out 前缀，且归一化后必须仍落在 ROOT 内
    if (!file.startsWith(ROOT) || !/^\/?(viewer|data\/out)/.test(path)) {
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

server.listen(PORT, () => {
  console.log(`viewer: http://localhost:${PORT}/`);
  console.log(`docId: ${docId}（questions.json 不存在? 先跑 npm run pipeline）`);
});
