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
    // "/" 或任意目录路径（以 / 结尾）一律落到该目录的 index.html
    if (path === "/") path = "/viewer/index.html";
    else if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, path);
    // 路径安全：只允许 /viewer /stages 与 /data/out 前缀，且归一化后必须仍落在 ROOT 内
    if (!file.startsWith(ROOT) || !/^\/?(viewer|stages|data\/out)/.test(path)) {
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
  const enc = encodeURIComponent(docId);
  console.log(`viewer:   http://localhost:${PORT}/viewer/?doc=${enc}`);
  console.log(`stages:   http://localhost:${PORT}/stages/?doc=${enc}`);
  console.log(`  stages = 五阶段样品展示（原料→阅读顺序→切题→质检→成品）`);
  console.log(`  stages 无快照时先运行 npm run stages 生成`);
  console.log(`  完整地址（含 doc 参数，可直接复制使用）`);
  console.log(`  默认卷：${docId}`);
  console.log(`  换卷：npm run view <docId> 或用 ?doc=<docId> 查询参数`);
  console.log(`  提示：doc 参数需完整（含空格用 %20），截断会导致数据加载失败`);
});
