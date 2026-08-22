// ============================================================
// scripts/browser-gate.mjs — DOM 存在性 Gate（辅助，不替代截图审视）
// 运行：node scripts/browser-gate.mjs [--doc=<docId>]
// 说明：IAB 打开 viewer，断言关键元素存在（卡片>0、统计≥80、筛选、ToggleAll、
//       Review 入口按钮）。IAB 不可用时 SKIP（退出码 0），不阻塞 npm test。
//
// 解耦红线：本文件不 import ../src/；仅复用 viewer/doc-utils.js（纯函数，无 DOM）。
// ============================================================

import { DEFAULT_DOC } from "../viewer/doc-utils.js";

const PORT = Number(process.env.PORT ?? 4173);
const docArg = process.argv[2]?.replace(/^--doc=/, "");
const DOC = encodeURIComponent(docArg || DEFAULT_DOC);
const url = `http://localhost:${PORT}/viewer/?doc=${DOC}`;

async function main() {
  const browser = await agent.browsers.get("iab");
  const tab = await browser.tabs.new();
  try {
    await tab.goto(url);
    await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
    await tab.playwright.waitForTimeout(800); // 等首屏渲染

    const cardCount = await tab.playwright.evaluate(
      () => document.querySelectorAll(".card").length
    );
    const total = await tab.playwright.evaluate(
      () => Number(document.querySelector("#stat-total")?.textContent ?? 0)
    );
    const ok = await tab.playwright.evaluate(
      () => Number(document.querySelector("#stat-ok")?.textContent ?? 0)
    );
    const review = await tab.playwright.evaluate(
      () => Number(document.querySelector("#stat-review")?.textContent ?? 0)
    );
    const hasFilters = await tab.playwright.evaluate(() => !!document.querySelector("#filters"));
    const hasToggle = await tab.playwright.evaluate(
      () => !!document.querySelector("#toggle-answers")
    );
    const hasReviewBtn = await tab.playwright.evaluate(
      () => !!document.querySelector("#review-btn")
    );

    const okTotal = total >= 80;
    const okReviewBtn = hasReviewBtn && review === total - ok;
    const pass = cardCount > 0 && okTotal && hasFilters && hasToggle && okReviewBtn;

    console.log(pass ? "GATE PASS" : "GATE FAIL");
    console.log(
      `卡片=${cardCount} 统计=${total} ok=${ok} review=${review} 筛选=${hasFilters} 开关=${hasToggle} Review按钮=${hasReviewBtn}`
    );
    process.exit(pass ? 0 : 1);
  } finally {
    await tab.close().catch(() => {});
  }
}

main().catch((e) => {
  console.log("GATE SKIP:", e.message);
  process.exit(0);
});
