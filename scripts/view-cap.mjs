// ============================================================
// scripts/view-cap.mjs — 截图采集器（IAB 浏览器）
// 运行：node scripts/view-cap.mjs [--states=complete|truncated|filter|answer|needs|empty]
// 说明：由 controller（主代理）用 IAB 浏览器逐状态截图，落盘
//       docs/design/viewer-cap/<name>.png，再 Read 逐屏审视版面。
// 交互状态（filter/answer/needs）用 tab.playwright.evaluate 触发 DOM click，
// 等效真实点击（会触发 viewer 的 addEventListener handler），且不依赖选择器细节。
//
// 解耦红线：本文件不 import ../src/；仅复用 viewer/doc-utils.js（纯函数，无 DOM）。
// ============================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOC } from "../viewer/doc-utils.js";

const PORT = Number(process.env.PORT ?? 4173);
const OUT_DIR = "docs/design/viewer-cap";
const BASE = `http://localhost:${PORT}/viewer/`;
const DOC = encodeURIComponent(DEFAULT_DOC);

/** 各状态的打开方式：url 打开后，再执行可选的 interact() 交互（await tab.playwright） */
const states = {
  // 完整默认 doc，无交互
  complete: {
    url: `${BASE}?doc=${DOC}`,
  },
  // 截断 doc：数据不存在 → 回退默认卷 + 页面提示（预期行为，审视回退提示）
  truncated: {
    url: `${BASE}?doc=${encodeURIComponent("23必刷题")}`,
  },
  // 筛选「主观」：点击筛选按钮
  filter: {
    url: `${BASE}?doc=${DOC}`,
    interact: async (pw) => {
      await pw.evaluate(() =>
        document.querySelector('[data-filter="subjective"]')?.click()
      );
    },
  },
  // 答案揭晓：点全局「Toggle All Answers」
  answer: {
    url: `${BASE}?doc=${DOC}`,
    interact: async (pw) => {
      await pw.evaluate(() => document.querySelector("#toggle-answers")?.click());
    },
  },
  // 质检队列视图：点击 masthead 的 Review 按钮（P3 入口）
  needs: {
    url: `${BASE}?doc=${DOC}`,
    interact: async (pw) => {
      await pw.evaluate(() => document.querySelector("#review-btn")?.click());
    },
  },
  // 空态：不存在的 doc → 回退默认并给出提示（截图审视回退/空态表现）
  empty: {
    url: `${BASE}?doc=${encodeURIComponent("不存在卷")}`,
  },
};

async function main() {
  const arg = process.argv[2] ?? "";
  const sel = arg.replace(/^--states=/, "").split(",").filter(Boolean);
  const keys = sel.length ? sel : Object.keys(states);

  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await agent.browsers.get("iab");
  for (const key of keys) {
    const st = states[key];
    if (!st) {
      console.error(`skip unknown state: ${key}`);
      continue;
    }
    const tab = await browser.tabs.new();
    try {
      await tab.goto(st.url);
      await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
      // 等 KaTeX / 图片初渲（离线时 KaTeX 降级为 $..$ 原文，无碍截图审视）
      await tab.playwright.waitForTimeout(1200);
      if (st.interact) await st.interact(tab.playwright);
      await tab.playwright.waitForTimeout(500); // 交互后留渲染余量
      const shot = await tab.screenshot();
      const p = join(OUT_DIR, `${key}.png`);
      writeFileSync(p, Buffer.from(shot));
      console.log(`captured ${key} -> ${p}`);
    } finally {
      await tab.close().catch(() => {});
    }
  }
  console.log("done");
}

main().catch((e) => {
  console.error("CAP ERROR:", e.message);
  process.exit(1);
});
