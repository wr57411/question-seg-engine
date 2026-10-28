// =============================================================
// scripts/oxr-shots.mjs —— 成品页逐页截图（CDP 精确坐标，不依赖滚动）
//
// 为什么需要它：`#pg-N` + `scrollIntoView` 在 headless 下不稳定（实测 #pg-2 截出空白页），
// 而显示层验收的红线要求「全量逐页截图审板」。CDP 的 Page.captureScreenshot 带
// captureBeyondViewport，可以按元素真实坐标直接裁切，完全不需要滚动。
//
// 用法：node scripts/oxr-shots.mjs "<url>" [输出前缀]
//   例：node scripts/oxr-shots.mjs "http://localhost:4173/final/?doc=xxx" tmp/shots-oxr/p
//
// 零依赖：只用 Node 内置 fetch / WebSocket（Node ≥22）。不 import ../src/（解耦红线）。
// =============================================================
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const url = process.argv[2];
const prefix = process.argv[3] ?? "tmp/shots-oxr/p";
if (!url) {
  console.error("用法：node scripts/oxr-shots.mjs \"<url>\" [输出前缀]");
  process.exit(2);
}

const VIEW = { width: 800, height: 1100 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    `--user-data-dir=/tmp/chrome-oxr-cdp`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${VIEW.width},${VIEW.height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

/** 等 CDP 端口就绪 */
async function waitEndpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error("CDP 端口未就绪");
}

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 30000);
  });
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate 失败：${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result?.value;
}

try {
  await waitEndpoint();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("找不到 page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error).slice(0, 200)));
      else p.resolve(m.result);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: VIEW.width,
    height: VIEW.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });

  // 等 DOM 就绪
  for (let i = 0; i < 100; i++) {
    if ((await evaluate("document.readyState")) === "complete") break;
    await sleep(200);
  }
  // 等图片真正加载完（懒加载 + 图片决定页高，不等会把每页截成空白/半截）
  await evaluate(
    `Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => document.images.length)`,
    true,
  );
  await sleep(600);

  // 取每一页的真实几何（pg-N 是 1-based，见 final.js `sec.id = pg-${i+1}`）
  const rects = await evaluate(`
    (() => {
      const out = [];
      for (const el of document.querySelectorAll('[id^="pg-"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) continue;
        out.push({ id: el.id, x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height });
      }
      return out.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
    })()
  `);

  if (!rects || rects.length === 0) throw new Error("页面上找不到 [id^=pg-] 的有效页面元素");
  console.log(`发现 ${rects.length} 页，开始逐页截图…`);
  mkdirSync(dirname(`${prefix}01.png`), { recursive: true });

  for (const [i, r] of rects.entries()) {
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 },
    });
    const name = `${prefix}${String(i + 1).padStart(2, "0")}.png`;
    writeFileSync(name, Buffer.from(shot.data, "base64"));
    console.log(`  ${r.id} → ${name}  (${Math.round(r.w)}×${Math.round(r.h)})`);
  }
  console.log("✓ 全部完成");
} catch (e) {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill("SIGKILL");
}
