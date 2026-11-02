// =============================================================
// scripts/topic-shots.mjs — 专题页 iPad 视口截图 + 页面级量数
//
// 为什么不用 scrollIntoView + 普通截图：HANDOFF 红线 §5-10 要求
// 「用户看得见」按默认滚动位置判；同时需要精确裁切与多状态对照。
// 这里用 CDP（Node 内置 fetch/WebSocket，零依赖）：
//   01 默认（首屏）
//   02 层级筛选「培优」
//   03 答案展开
//   04 needs_review 徽标 + 原因
//   05 整页
// 并输出：可点元素高度（≥44px）、正文字号（≥13px）、控制台异常。
//
// 用法：node scripts/topic-shots.mjs [url] [outDir]
//   默认 url = http://localhost:4174/topic/
// =============================================================
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const url = process.argv[2] ?? "http://localhost:4174/topic/";
const outDir = process.argv[3] ?? "tmp/review-topic";
const VIEW = { width: 820, height: 1100 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(outDir, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    `--user-data-dir=/tmp/chrome-topic-cdp`,
    `--remote-debugging-port=${PORT}`,
    `--window-size=${VIEW.width},${VIEW.height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitEndpoint() {
  for (let i = 0; i < 80; i++) {
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
const consoleIssues = [];

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
  if (r.exceptionDetails) throw new Error(`evaluate 失败：${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result?.value;
}

async function shot(name) {
  const png = await send("Page.captureScreenshot", { format: "png" });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(`  ${name} → ${file}`);
  return file;
}

async function shotClip(name, rect, scale = 1) {
  const png = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...rect, scale },
  });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(`  ${name} → ${file} (${Math.round(rect.width)}×${Math.round(rect.height)} @${scale}x)`);
}

async function fullShot(name) {
  const metrics = await send("Page.getLayoutMetrics");
  const size = metrics.cssContentSize ?? metrics.contentSize;
  const png = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
  });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(png.data, "base64"));
  console.log(`  ${name} → ${file} (${Math.round(size.width)}×${Math.round(size.height)})`);
}

async function waitCards() {
  for (let i = 0; i < 100; i++) {
    const n = await evaluate(`document.querySelectorAll('#cards .card').length`);
    if (n > 0) return n;
    await sleep(200);
  }
  return 0;
}

async function clickByText(selector, text) {
  return evaluate(
    `(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(x => x.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!b) return false;
      b.click();
      return true;
    })()`,
  );
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
    if (m.method === "Runtime.exceptionThrown") {
      consoleIssues.push(`exception: ${JSON.stringify(m.params.exceptionDetails).slice(0, 300)}`);
    }
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      consoleIssues.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300)}`);
    }
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

  for (let i = 0; i < 100; i++) {
    if ((await evaluate("document.readyState")) === "complete") break;
    await sleep(200);
  }
  const cardCount = await waitCards();
  if (!cardCount) throw new Error("页面上没有题卡（#cards .card）——检查 /data/out/topics/index.json 与前端报错");
  await sleep(600);

  console.log(`发现 ${cardCount} 张题卡，开始截图…`);

  // 01 默认首屏（不滚动 —— 红线 §5-10 的判法）
  await evaluate("window.scrollTo(0, 0)");
  await sleep(200);
  await shot("01-default");

  // 02 层级筛选「培优」：先切到有培优题的专题（层级筛选作用于当前专题）
  const clickedTopic = await clickByText("#topic-chips .chip", "圆周运动");
  if (!clickedTopic) throw new Error("找不到「圆周运动」专题");
  await sleep(300);
  const clickedLevel = await clickByText("#level-filter .seg", "培优");
  if (!clickedLevel) throw new Error("找不到「培优」筛选按钮");
  await sleep(400);
  const peiyouCount = await evaluate(`document.querySelectorAll('#cards .card').length`);
  const peiyouDisabled = await evaluate(`[...document.querySelectorAll('#level-filter .seg')].map(b => ({ text: b.textContent.trim(), disabled: b.disabled }))`);
  console.log(`  培优视图题卡数：${peiyouCount}；层级按钮：${JSON.stringify(peiyouDisabled)}`);
  await evaluate("window.scrollTo(0, 0)");
  await shot("02-level-peiyou");

  // 03 答案展开（切回平抛运动 + 全部，点第一张卡的答案按钮，把按钮滚到视口上方）
  await clickByText("#topic-chips .chip", "平抛运动");
  await sleep(300);
  await clickByText("#level-filter .seg", "全部");
  await sleep(300);
  const opened = await evaluate(`(() => {
    const b = document.querySelector('.card .answer-toggle');
    if (!b) return false;
    b.click();
    b.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  if (!opened) throw new Error("找不到答案开关");
  await sleep(500);
  await shot("03-answer-open");

  // 04 needs_review 徽标 + 原因（默认可见，不藏答案里）——裁 2x 看清楚
  await clickByText("#topic-chips .chip", "圆周运动");
  await sleep(300);
  await clickByText("#level-filter .seg", "全部");
  const reviewRect = await evaluate(`(() => {
    const card = document.querySelector('.card.is-review');
    if (!card) return null;
    card.scrollIntoView({ block: 'start' });
    const r = card.getBoundingClientRect();
    return {
      x: Math.max(0, r.x),
      y: Math.max(0, r.y + window.scrollY),
      width: r.width,
      height: Math.min(520, r.height),
    };
  })()`);
  if (!reviewRect) throw new Error("页面上没有 needs_review 题卡（种子应含 1 道）");
  await sleep(400);
  await shotClip("04-needs-review", reviewRect, 2);

  // 05 整页
  await evaluate("window.scrollTo(0, 0)");
  await sleep(300);
  await fullShot("05-full-page");

  // 06 第一题的答案（含答案图）：答案区的图与文字必须都能看见
  const openedFirst = await evaluate(`(() => {
    const toggle = document.querySelector('.card .answer-toggle');
    if (!toggle) return false;
    toggle.click();
    const answer = toggle.nextElementSibling;
    if (answer) answer.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  if (!openedFirst) throw new Error("第一张卡没有答案开关（种子题应有答案）");
  await sleep(500);
  await shot("06-answer-with-image");

  // 量数（不是靠截图"看着有"）
  const metrics = await evaluate(`(() => {
    const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]);
    const stem = document.querySelector('.card .stem');
    const buttons = [...document.querySelectorAll('button')].map(b => ({
      text: b.textContent.trim().slice(0, 8),
      h: Math.round(b.getBoundingClientRect().height),
    }));
    const cards = [...document.querySelectorAll('#cards .card')].map(c => ({
      id: c.dataset.questionId,
      stemChars: (c.querySelector('.stem')?.textContent ?? '').length,
      options: c.querySelectorAll('.option').length,
      images: c.querySelectorAll('.figures img').length,
      reviewBadge: !!c.querySelector('.badge-review'),
    }));
    const banner = document.getElementById('banner');
    return {
      viewport: [innerWidth, innerHeight],
      stemFont: stem ? px(stem, 'fontSize') : null,
      bodyFont: px(document.body, 'fontSize'),
      minButtonHeight: buttons.length ? Math.min(...buttons.map(b => b.h)) : null,
      buttons,
      cards,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      banner: banner && !banner.hidden ? banner.textContent.trim().slice(0, 200) : null,
      answerSource: document.querySelector('.answer-source')?.textContent ?? null,
    };
  })()`);

  console.log("\n页面量数：");
  console.log(JSON.stringify(metrics, null, 1));
  const problems = [];
  if (consoleIssues.some((c) => c.startsWith("exception:"))) {
    console.log("\n控制台异常：");
    for (const c of consoleIssues) console.log(`  - ${c}`);
    problems.push("页面有未捕获异常");
  } else if (consoleIssues.length) {
    console.log("\n控制台提示（不判红）：");
    for (const c of consoleIssues) console.log(`  - ${c}`);
  } else {
    console.log("\n控制台：无异常");
  }
  const tooShort = (metrics.buttons ?? []).filter((b) => b.h < 44);
  if (tooShort.length) problems.push(`可点元素 <44px：${JSON.stringify(tooShort)}`);
  if (metrics.stemFont !== null && metrics.stemFont < 13) problems.push(`题干字号 <13px：${metrics.stemFont}`);
  if (metrics.horizontalOverflow) problems.push("页面出现横向溢出（820pt 视口）");
  if (metrics.banner) problems.push(`页面显示数据提示条（导出应为绿）：${metrics.banner}`);
  if (!metrics.answerSource) problems.push("答案区没有来源标注");
  if (problems.length) {
    for (const p of problems) console.log(`⚠️ ${p}`);
    process.exitCode = 1;
  }
  console.log("✓ 截图完成");
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
