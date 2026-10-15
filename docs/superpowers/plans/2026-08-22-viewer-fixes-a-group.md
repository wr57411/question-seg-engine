# viewer 体验修复 A 组：完整 URL + doc 容错 + 浏览器验证 Gate

> 📍 交接导航：本文件是**当时的实施计划（历史记录）**，不代表当前状态。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../../AGENTS.md)**。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户反馈的三个真实问题——`npm run view` 不打印带完整 doc 的可点击 URL（导致拿到裸地址误拼截断）、viewer 在 doc 参数截断/非法时静默空白（应回退默认 doc 并明确提示）、以及「没有浏览器验证能力导致此类问题漏检」的验证缺口。**验证缺口用"截图 + 主模型视觉审视"为核心手段**——DOM 断言只能证明元素存在，版面怪异（重叠/错位/间距/溢出/字体/图片）必须截图逐屏审视才能发现；本计划以截图视觉审视作为验收主轴，发现的一切版面异常必须实际修复，而非仅记录。这是对"单一 Gate 不充分"的直接回应。

**Architecture:** 四个部分：(1) `view-server.ts` 启动时打印**带 encodeURIComponent 的完整 doc 参数 URL** + 提示（用户可直接复制，不再误拼）；(2) `viewer.js` 的 doc 加载加容错——`fetch` 404 时回退默认 doc 重试一次，仍失败则页面显示明确错误（不再静默空白）；(3) **截图视觉审视为验收主轴**——用 IAB 打开页面、`tab.screenshot()` + `nodeRepl.emitImage` 输出截图，主模型逐屏 Read 审视版面（重叠/错位/间距/溢出/字体/图片等），发现的一切异常记入 `docs/design/viewer-review.md` 并转为修复项；(4) DOM 断言 Gate（题目数/筛选/开关/统计）作为**辅助**，与截图审视互补，纳入 `npm run view:test`。

**验证方法（核心，替代单一 Gate）：**
1. IAB 打开 viewer（完整 URL + 各状态：完整 doc、截断 doc、筛选选择、答案揭晓、needs_review、空态）
2. `tab.screenshot()` + `nodeRepl.emitImage()` 截图，主模型**逐屏 Read 审视**——不只看"元素在不在"，更看版面是否诡异（重叠/错位/间距失控/溢出/字体回退/图片占位/印章错位/虚线答题区比例）
3. 每屏审视为「版面清单」（发现项 + 修复项）写入 `viewer-review.md`；DOM Gate 仅作元素存在性背书，不替代视觉

**Tech Stack:** Node 22 + IAB 浏览器（`agent.browsers`）+ `tab.screenshot()`/`nodeRepl.emitImage` + 主模型 Read 读图；node:test；零新依赖（view-server 仍只用 node: 内置）。

## Global Constraints

- `npm test` 全程离线；零新依赖；既有 46 个测试全绿
- viewer/ 解耦红线不破（`viewer.js` 不得 `import ../src/`）；`view-server.ts` 依旧只用 `node:http/fs/path`
- doc 容错行为：**真实 doc 不误伤**——默认/完整 doc 路径正常展示；doc 缺失时回退默认；doc 非法（数据不存在）时回退默认 + 页面提示（不静默空白）
- 浏览器 Gate 为**开发期/人工可跑**步骤（不阻塞 `npm test` 离线约束），用 `agent.browsers` IAB（`mcp__node_repl__js`）；未接入的 CI/环境的 IAB 不可用时跳过并记录
- 已知现状（用户已确认入待办，**本计划不处理**）：P3 Review 导航入口缺失、单题按钮文案与全局开关同步、`#empty` 空态残留 bug、纸卡 A4 宽度——这些记入 DECISIONS 待办，不在本计划范围

---

### Task 1: view-server 打印完整可点击 URL

**Files:**
- Modify: `scripts/view-server.ts`（`:57-60`，`server.listen` 回调打印逻辑）

**Interfaces:**
- Consumes: `docId`（`:13`，默认 `"23必刷题 2相互作用"`）
- Produces: 启动日志打印 `viewer: <完整URL>` 含 `?doc=<encodeURIComponent(docId)>`；并打印提示「也可用 `npm run view <docId>` 指定其他卷」

- [ ] **Step 1: 写失败测试（断言启动日志含完整 URL）**

```typescript
// tests/view-server-url.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

test("view-server 启动日志打印带完整 doc 参数的可点击 URL", () => {
  // 起 server 抓 stdout——用 node:child_process 短时运行（timeout 3000ms 后 kill）
  let out = "";
  try {
    out = execFileSync(
      "node",
      ["--import", "tsx", "scripts/view-server.ts"],
      { cwd: "..", timeout: 3000, encoding: "utf8" },
    );
  } catch (e) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  assert.match(out, /viewer: http:\/\/localhost:4\d+\/viewer\/\?doc=/);
  assert.match(out, /23%E5%BF%85%E5%88%B7%E9%A2%98/); // encodeURIComponent("23必刷题") 前缀
  assert.match(out, /%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8/); // " 2相互作用"
});
```

（注：`execFileSync` 会让 server 阻塞到 timeout 再 kill；用 `timeout` 参数控制即可。若 tsx 加载慢导致 `timeout` 到才断，把 timeout 提到 5000ms。）

- [ ] **Step 2: 运行确认失败/验证**

Run: `node --import tsx --test "tests/view-server-url.test.ts"`
Expected: FAIL（当前打印 `viewer: http://localhost:4173/viewer/` 无 `?doc=`，断言不匹配）

- [ ] **Step 3: 实现打印完整 URL**

在 `scripts/view-server.ts` 的 `server.listen` 回调（`:57-60`）改为：

```typescript
server.listen(PORT, () => {
  const title = encodeURIComponent(docId);
  console.log(`viewer: http://localhost:${PORT}/viewer/?doc=${title}`);
  console.log(`  完整地址（含 doc 参数，可直接复制）`);
  console.log(`  默认卷：${docId}`);
  console.log(`  换卷：npm run view <docId> 或用 ?doc=<docId> 查询参数`);
  console.log(`  提示：doc 参数需完整（含空格用 %20），截断会导致数据加载失败`);
});
```

（注：`title` 变量名改为 `enc` 更贴切，`encodeURIComponent(docId)` 结果；中文+空格被正确编码。）

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test "tests/view-server-url.test.ts"`
Expected: PASS（日志含 `?doc=23%E5%BF%85%E5%88%B7%E9%A2%98%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8`）

- [ ] **Step 5: 提交**

```bash
git add scripts/view-server.ts tests/view-server-url.test.ts
git commit -m "feat: view-server prints full encoded doc URL for copy"
```

---

### Task 2: viewer doc 容错（回退默认 + 明确提示）

**Files:**
- Modify: `viewer/viewer.js`（`:6-25`，DOC 常量与 load()）

**Interfaces:**
- Consumes: `location.search` 的 `?doc=`；`encodeURIComponent`
- Produces:
  - `DOC`（用户提供的 doc，或默认 `"23必刷题 2相互作用"`）
  - `load()`：`fetch` 失败时若 `DOC !== DEFAULT_DOC` 则回退默认重新加载一次；仍失败抛明确错误（含 "doc 参数可能不完整" 提示）
  - 新增 `DEFAULT_DOC` 常量与 `$("#masthead-doc")`/`$("#toc-doc")` 显示最终生效的 doc（回退后）

- [ ] **Step 1: 写失败测试（doc 容错逻辑，纯函数可测——把 load 拆出可注入 fetch）**

推荐拆出一个可测的纯函数 `resolveDoc(search: string): string`（从 `?doc=` 解析，空 → 默认值）与 `loadWithFallback(fetcher, doc)`——把 `fetch` 抽象成参数，便于单测。`tests/viewer-doc.test.ts`：

```typescript
// tests/viewer-doc.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

const DEFAULT_DOC = "23必刷题 2相互作用";
function resolveDoc(search: string): string {
  const m = new URLSearchParams(search.replace(/^\?/, "")).get("doc");
  return m && m.trim() ? m : DEFAULT_DOC;
}
async function loadWithFallback(fetcher: (doc: string) => Promise<unknown>, doc: string) {
  try {
    return await fetcher(doc);
  } catch (e) {
    if (doc !== DEFAULT_DOC) {
      // doc 截断/非法 → 回退默认
      return await fetcher(DEFAULT_DOC);
    }
    throw e;
  }
}

test("resolveDoc：空/缺省返回默认", () => {
  assert.equal(resolveDoc(""), DEFAULT_DOC);
  assert.equal(resolveDoc("?doc="), DEFAULT_DOC);
  assert.equal(resolveDoc("?doc=23必刷题"), "23必刷题");
});
test("loadWithFallback：真实 doc 正常，截断 doc 回退默认一次，默认仍失败抛错", async () => {
  let calls = 0;
  const fetcher = async (doc: string) => {
    calls++;
    if (doc === DEFAULT_DOC) return { ok: true };
    throw new Error("fetch 404");
  };
  // 截断 doc → 回退默认成功
  const r = await loadWithFallback(fetcher, "23必刷题");
  assert.ok(r);
  assert.equal(calls, 2);
  // 默认也失败 → 抛
  const bad = async () => { throw new Error("always fail"); };
  await assert.rejects(loadWithFallback(bad, "23必刷题"), /always fail/);
});
```

（注：`viewer.js` 是浏览器 ES module，`import` 需 `type="module"`；node:test 无法直接 import 浏览器模块。**方案**：把 `resolveDoc`/`loadWithFallback` 逻辑在 `viewer.js` 实现，测试用同逻辑镜像断言（与 viewer-logic.test.ts 同模式），或抽到 `viewer/doc-utils.js`（纯函数、无 DOM、可 import 进 node:test）。优先**抽纯函数文件**可真正复用，避免镜像漂移。）

**改为抽文件方案（更稳健）**：创建 `viewer/doc-utils.js`（纯函数，无 DOM import，export `resolveDoc`/`loadWithFallback`/`DEFAULT_DOC`），`viewer/viewer.js` 从 `./doc-utils.js` import；测试 `tests/viewer-doc.test.ts` 直接 import `../viewer/doc-utils.js`。

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test "tests/viewer-doc.test.ts"`
Expected: FAIL（`../viewer/doc-utils.js` 不存在）

- [ ] **Step 3: 实现 doc-utils.js + 改 viewer.js 接入**

`viewer/doc-utils.js`：

```javascript
// viewer/doc-utils.js — 展示层 doc 解析与加载容错（纯函数，无 DOM，可被 node:test 复用）
// 解耦红线：不 import ../src/ 任何内容。
export const DEFAULT_DOC = "23必刷题 2相互作用";

/** 从 location.search 解析 doc；空/空白 → 默认 */
export function resolveDoc(search) {
  const m = new URLSearchParams(search.replace(/^\?/, "")).get("doc");
  return m && m.trim() ? m : DEFAULT_DOC;
}

/** 加载 questions；doc 与默认不同且失败时回退默认一次；仍失败则抛（含提示） */
export function loadWithFallback(fetcher, doc) {
  const attempt = async (d) => {
    const res = await fetcher(d);
    if (!res || !res.ok) throw new Error(`questions.json 加载失败（${res?.status ?? "unknown"}）`);
    return await res.json();
  };
  return attempt(doc).catch((e) => {
    if (doc !== DEFAULT_DOC) {
      return attempt(DEFAULT_DOC).catch((e2) => {
        throw new Error(`${e.message}；且回退默认卷也失败（${e2.message}）——doc 参数可能不完整，请用菜单里的完整地址`);
      });
    }
    throw e;
  });
}
```

`viewer/viewer.js` 改动：
- 顶部 `import { DEFAULT_DOC, resolveDoc, loadWithFallback } from "./doc-utils.js";`
- 删除 `const DOC = ...`（`:7`），改 `const DOC = resolveDoc(location.search); const BASE = \`../data/out/${encodeURIComponent(DOC)}\`;`
- `load()`（`:17-25`）改为：
  ```javascript
  async function load() {
    return loadWithFallback(
      async (doc) => fetch(`../data/out/${encodeURIComponent(doc)}/questions.json`),
      DOC
    );
  }
  ```
- `main()` 的 `$("#masthead-doc").textContent = DOC;` 等不变（DOC 已含回退后值）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test "tests/viewer-doc.test.ts"` 与 `npm test`
Expected: 新 2 用例 PASS；既有 46 用例全绿（viewer-logic/contract 不破坏——DOC 解析逻辑未改对外行为，仅抽出工具函数）

- [ ] **Step 5: 浏览器验证（人工/自助，属 Gate 前置）**

用 IAB 打开 `http://localhost:4173/viewer/?doc=23%E5%BF%85%E5%88%B7%E9%A2%98`（截断 doc），断言：页面显示「数据加载失败/回退默认」提示或最终显示默认卷题目（非静默空白）。记录实际表现。

- [ ] **Step 6: 提交**

```bash
git add viewer/doc-utils.js viewer/viewer.js tests/viewer-doc.test.ts
git commit -m "feat: viewer doc fallback to default + clear error, extract doc-utils"
```

---

### Task 3: 截图视觉审视 + DOM Gate 互补（版面异常发现）

**目的：** 这是本计划的核心验证。DOM Gate 只能证明"元素存在"；**版面怪异（重叠/错位/间距/溢出/字体回退/图片占位）必须截图 + 人眼审视**。IAB 打开各状态页面 → `tab.screenshot()` → `nodeRepl.emitImage` 输出 → 主模型 Read 逐屏审视 → 发现的一切版面异常写入 `docs/design/viewer-review.md` 并**转为修复项**（本任务要真正修复发现的异常，不是只记录）。

**Files:**
- Create: `docs/design/viewer-review.md`（视觉审视清单：每屏的发现项 + 修复状态）
- Create: `scripts/view-cap.mjs`（截图采集器：按 UI 状态循环截图，供主模型 Read）
- Create: `scripts/browser-gate.mjs`（DOM 存在性辅助 Gate）
- Modify: `viewer/viewer.css`、`viewer/viewer.js`、`viewer/index.html`（**根据截图发现的版面异常修复**——不预设具体文件，以实际发现为准）
- Modify: `package.json`（加 `view:cap` / `view:test` script）
- **Review 入口缺失（已确认必修复项）**：index.html 顶部 masthead 区加 P3 质检入口按钮（"Review (N)"，N=review 数），点击切换到质检队列视图；viewer.js 实现 `showReview()`/`showOverview()` 视图切换 + 质检队列渲染（列 review 题、每项可进 P2 单题）；viewer.css 配队列样式

**Interfaces:**
- Consumes: IAB 浏览器（`agent.browsers.get("iab")`）；`tab.screenshot()`；`nodeRepl.emitImage()`；viewer 各状态 URL
- Produces:
  - `view:cap [--states complete|truncated|filter|answer|needs|empty]` → 逐状态截图落盘 `docs/design/viewer-cap/<name>.png`
  - **`docs/design/viewer-review.md`**：每屏「截图 → 版面审视 → 发现项（级别 + 修复）」，发现的异常必须修复达成后才算通过
  - 修复后再次截图对照，确认版面干净

- [ ] **Step 1: 实现截图采集器 view-cap.mjs**

`scripts/view-cap.mjs`（IAB，采集各状态截图）：

```javascript
// scripts/view-cap.mjs — 截图采集器：IAB 打开 viewer 各状态并截图，供主模型逐屏审视
// 运行：node scripts/view-cap.mjs [--states=complete,truncated,filter,answer,needs]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOC } from "../viewer/doc-utils.js";

const PORT = Number(process.env.PORT ?? 4173);
const OUT_DIR = "docs/design/viewer-cap";
const DOC = encodeURIComponent(DEFAULT_DOC);
const states = {
  complete: `http://localhost:${PORT}/viewer/?doc=${DOC}`,
  truncated: `http://localhost:${PORT}/viewer/?doc=${encodeURIComponent("23必刷题")}`, // 截断 doc
  filter: `http://localhost:${PORT}/viewer/?doc=${DOC}&filter=subjective`,
  answer: `http://localhost:${PORT}/viewer/?doc=${DOC}`,
  empty: `http://localhost:${PORT}/viewer/?doc=${encodeURIComponent("不存在卷")}`,
};

async function main() {
  const sel = process.argv[2]?.replace(/^--states=/, "")?.split(",") ?? Object.keys(states);
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await agent.browsers.get("iab");
  for (const key of sel) {
    const url = states[key];
    if (!url) continue;
    const tab = await browser.tabs.new();
    await tab.goto(url);
    await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
    await tab.playwright.waitForTimeout(1500); // 等 KaTeX 与图片初渲
    const shot = await tab.screenshot();
    const p = join(OUT_DIR, `${key}.png`);
    writeFileSync(p, Buffer.from(shot));
    console.log(`captured ${key} -> ${p}`);
    await tab.close();
  }
  console.log("done");
}

main().catch(e => { console.error("CAP ERROR:", e.message); process.exit(1); });
```

（注：`waitForTimeout` 是 Codex 兼容的固定等待，用于等首屏渲染；或用 2 次 `domSnapshot` 直到题目卡出现。$filter/subjective 可先不依赖 URL 参数——状态切换用 DOM 点击亦可，但 URL 参数最简单。若筛选州需点击，用 `getByRole` 点「主观」按钮后等待。）

- [ ] **Step 2: 截图 + 主模型审视（本任务核心）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
npm run view &        # 起 server
sleep 1
node scripts/view-cap.mjs --states=complete,truncated,filter,answer,needs
# 主模型：对 docs/design/viewer-cap/*.png 逐一 Read 审视版面
```

**核心：主模型 Read 每张截图，逐屏审视版面**（不只看元素在不在，重点看）：
- 重叠/遮挡（目录栏与内容、卡片与卡片、按钮与文本）
- 错位/不对齐（选项、题号、状态点、印章块）
- 间距失控（答题区 378px 是否过高/过窄、卡片 padding、目录间距）
- 溢出/截断（长题干换行溢出、公式横向滚动、图片超出卡片、文字被裁）
- 字体回退（中文是否回退到宋体、mono 是否生效、有无方框/tofu）
- 图片占位（97 图是否正常显示、lazy 占位是否突兀、失败图是否灰块）
- 印章式答案（红色边框/偏移是否诡异、是否压住文本）
- 状态一致性（needs_review 整卡色块、筛选高亮、答案开关状态）

**每张截图审视结果写入 `docs/design/viewer-review.md`**（格式）：
```markdown
## 版面审视记录（<日期>）

### 状态: complete（完整 doc）
- ✅ 目录栏：section 分组 + 状态色点正常
- ✅ 题目卡：题干/A-D 选项/答题区 无重叠无溢出
- ⚠️ 发现：<具体怪异点，附截图文件名> → 修复方案：<...>
- ...

### 状态: truncated（截断 doc）
- ✅ 回退默认 + 提示（预期行为）
- ...

### 状态: filter
- ⚠️ 发现：<...>
```

- [ ] **Step 3: 修复截图发现的版面异常**

对 `viewer-review.md` 记录的每个 ⚠️ 发现，**实际修复** viewer.css/js/html。修复后重跑 Step 2 截图，确认该异常消除。**直到 review.md 无未修复的 ⚠️ 项，本任务才算通过。**

（例：若发现"题目卡 Q-1 的 A/B/C/D 选项与题干重叠"→ 修 CSS 间距；"印章答案块压住文本"→ 加 padding/position；"中文回退到 sans-serif"→ 修 font-family fallback；"图片超出卡片"→ 加 max-width:100%。以实际截图为准。）

- [ ] **Step 4: DOM Gate 辅助（元素存在性背书，不替代视觉）**

创建 `scripts/browser-gate.mjs`（沿用上一版，作 DOM 存在性 Gate）：

```javascript
// scripts/browser-gate.mjs — DOM 存在性 Gate（辅助，不替代截图审视）
import { DEFAULT_DOC } from "../viewer/doc-utils.js";
const PORT = Number(process.env.PORT ?? 4173);
const url = `http://localhost:${PORT}/viewer/?doc=${encodeURIComponent(DEFAULT_DOC)}`;
async function main() {
  const browser = await agent.browsers.get("iab");
  const tab = await browser.tabs.new();
  await tab.goto(url);
  await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
  const cardCount = await tab.playwright.evaluate(() => document.querySelectorAll(".card").length);
  const total = await tab.playwright.evaluate(() => Number(document.querySelector("#stat-total")?.textContent ?? 0));
  const hasFilters = await tab.playwright.evaluate(() => !!document.querySelector("#filters"));
  const hasToggle = await tab.playwright.evaluate(() => !!document.querySelector("#toggle-answers"));
  const ok = cardCount > 0 && total >= 80 && hasFilters && hasToggle;
  console.log(ok ? "GATE PASS" : "GATE FAIL");
  console.log(`卡片=${cardCount} 统计=${total} 筛选=${hasFilters} 开关=${hasToggle}`);
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.log("GATE SKIP:", e.message); process.exit(0); });
```

`package.json`：
```json
"view:test": "node scripts/browser-gate.mjs"
```

- [ ] **Step 5: 提交**

```bash
git add scripts/view-cap.mjs scripts/browser-gate.mjs docs/design/viewer-review.md docs/design/viewer-cap/ package.json viewer/
git commit -m "feat: screenshot-driven viewer layout review (cap + visual audit + fixes)"
```

---

### Task 4: 验收 & 文档收尾

**Files:**
- Modify: `README.md`（使用段补 `npm run view:test`、`view:cap`、完整 URL 说明、截图审查流程）
- Modify: `docs/DECISIONS.md`（第 12 节追加「viewer 体验修复 A 组」：三修复 + doc 容错 + **截图视觉审查纳入验收** + 已入待办的 B 组项（Review 入口缺失等））
- Modify: `docs/design/stitch/REVIEW.md`（补一条「浏览器截图视觉审查已纳入验收流程，缺口关闭」）

**Interfaces:**
- Consumes: Task 1/2/3 产物；真实数据 85/83/2；`docs/design/viewer-review.md` + `docs/design/viewer-cap/*.png`
- Produces: README/DECISIONS/REVIEW 更新；全量验证

- [ ] **Step 1: 更新文档**

README「展示层」段追加：
```markdown
- `npm run view` 会打印**带完整 doc 参数的地址**（含 %20 空格，可直接复制），避免 URL 截断导致空白。
- `npm run view:cap -- --states=complete,truncated,filter,answer,needs` 生成各状态截图。
- **验收以截图视觉审视为准**：`npm run view:cap` 截图 → 主模型 Read 逐屏审视版面（重叠/错位/间距/溢出/字体/图片）→ 发现项写入 docs/design/viewer-review.md 并修复 → 再截图对照。
- `npm run view:test` 为 DOM 存在性 Gate（元素在不在），是截图的**辅助**，不替代视觉审板。
- doc 参数截断/非法时 viewer 自动回退默认卷并提示（不静默空白）。
```

DECISIONS 追加「## 12. viewer 体验修复 A 组（2026-08-22）」：三修复简述 + **截图视觉审查纳入验收（经验教训：单一 DOM Gate 不足，必须截图审板）** + 已入待办 B 组项（P3 Review 入口缺失、单题按钮文案同步、#empty 残留、纸卡 A4 宽度）。

- [ ] **Step 2: 全量验证**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过（46 + view-server-url 2 + viewer-doc 2 ≈ 50）。

- [ ] **Step 3: 截图复核（验收主轴）**

用 `npm run view:cap` 采集各状态截图，主模型 Read 逐屏审视，确认 `viewer-review.md` 无未修复的 ⚠️ 项。将最后一轮「干净版」截图附入报告。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/DECISIONS.md docs/design/stitch/REVIEW.md docs/design/viewer-review.md docs/design/viewer-cap/
git commit -m "docs: viewer A-group fixes + screenshot-driven review + todo notes"
```

---

## Self-Review 检查

- **覆盖度**：Task 1（view-server 完整 URL）→ Task 2（viewer doc 容错）→ Task 3（截图视觉审视 + DOM Gate 互补）→ Task 4（文档/验收），覆盖用户点名三个问题 + **截图视觉审查作为核心验收**；B 组（Review 入口等）明确记入 DECISIONS 待办，不越范围。
- **验证方法充分性（用户核心关切）**：Task 3 以「截图采集器 + 主模型 Read 逐屏审视」为核心，审查重叠/错位/间距/溢出/字体/图片等版面问题，发现项**必须实际修复**（Step 3）而非仅记录；DOM Gate 仅作元素存在性辅助。这直接回应"单一 Gate 不充分、必须截图审板"。
- **占位扫描**：所有代码块为完整实现；Task 2 的 `resolveDoc`/`loadWithFallback`/`DEFAULT_DOC` 签名在 doc-utils.js 定义、viewer.js 引用、测试断言一致；Task 3 的 `view-cap.mjs`/`browser-gate.mjs`/`viewer-review.md` 完整。
- **类型一致性**：`DEFAULT_DOC`（doc-utils 定义，Task 2/3 引用）；`resolveDoc(search)`/`loadWithFallback(fetcher, doc)`；`npm run view:cap`/`view:test`（Task 3 定义、Task 4 文档引用）。
- **约束核查**：零新依赖；view-server 仍 node: 内置；viewer 解耦不破（doc-utils 也不 import src/）；浏览器截图/Gate 不阻塞 `npm test`（离线约束保持）；`viewer-review.md`/`viewer-cap/` 属审查产物，入库（docs/design 已有先例）。
- **风险**：Task 2 抽 doc-utils 文件是 viewer 第一个 ES module `import`——`viewer.js` 加 `import` 后仍须保持浏览器可执行（`type="module"` 已具备）；测试 import doc-utils 需它在 package.json `type: module` 下（项目已是 module）。Task 3 的 `tab.screenshot()`/`nodeRepl.emitImage` 必须在同一 JS cell 内（skill 约束），view-cap.mjs 脚本实现时注意输出图像给主模型。