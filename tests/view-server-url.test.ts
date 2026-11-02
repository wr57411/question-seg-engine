import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 项目根：从本测试文件位置向上推导，保证 server 的 process.cwd() 为项目根
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// 用独立端口，避免与正在跑的 `npm run view`（4173）冲突导致 EADDRINUSE
const PORT = String(4200 + Math.floor(Math.random() * 600)); // 4200-4799

test("view-server 启动日志打印带完整 doc 参数的可点击 URL", () => {
  // 起 server 抓 stdout——用 node:child_process 短时运行（timeout 后 kill）
  let out = "";
  try {
    out = execFileSync(
      "node",
      ["--import", "tsx", "scripts/view-server.ts"],
      {
        cwd: ROOT,
        env: { ...process.env, PORT },
        timeout: 8000,
        encoding: "utf8",
      },
    );
  } catch (e) {
    // server 阻塞到 timeout 被 kill，execFileSync 抛错，stdout/stderr 在 err 上
    const err = e as { stdout?: string; stderr?: string };
    out = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert.match(out, /viewer:\s+http:\/\/localhost:\d+\/viewer\/\?doc=/);
  assert.match(out, /stages:\s+http:\/\/localhost:\d+\/stages\/\?doc=/);
  // 成品页（2026-10-14 新增：成品 = 按原坐标重建的纸面，整册滚动翻）
  assert.match(out, /成品页：\s+http:\/\/localhost:\d+\/final\/\?doc=/);
  assert.match(out, /23%E5%BF%85%E5%88%B7%E9%A2%98/); // encodeURIComponent("23必刷题") 前缀
  assert.match(out, /%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8/); // " 2相互作用"
});

test("TAGS_WRITE=0：POST /api/tags 返回 403（只读预览）", async () => {
  const { spawn } = await import("node:child_process");
  const port = 4200 + Math.floor(Math.random() * 600);
  const child = spawn("node", ["--import", "tsx", "scripts/view-server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TAGS_WRITE: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/docs`);
        if (r.ok) break;
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/tags?doc=x`, { method: "POST", body: "{}" });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /TAGS_WRITE=0|只读/);
  } finally {
    child.kill("SIGKILL");
  }
});
