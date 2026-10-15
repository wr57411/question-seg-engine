# 展示层独立模块：题库查看器实施计划

> 📍 交接导航：本文件是**当时的实施计划（历史记录）**，不代表当前状态。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../../AGENTS.md)**。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为切片增加一个**独立可解耦的题库展示层**——浏览器中查看结构化分类后的试题（试题区/答题区/答案区、答案开关、按题型的答题留白、公式渲染），作为切分质量的可视化验收面；展示层不 import 引擎任何代码，只消费固定数据契约，后期换 React/Vue/原生实现时引擎零改动。

**Architecture:** 独立目录 `viewer/`（纯静态 HTML/CSS/JS + 内联 SVG 图标，零构建链），数据契约 = 引擎既有的 `SegmentResult.questions` JSON（正式 schema 的序列化形态）+ 同目录 `images/`。解耦三层边界：(1) 引擎产出 `data/out/<docId>/questions.json`（已存在，Task 3 真实产物）；(2) 契约文档 `viewer/docs/CONTRACT.md` 声明 ViewerQuestion 字段表与路径/答案拆分适配规则（viewer 内独立声明类型，不 import `src/types.ts`）；(3) `scripts/view-server.ts` 零依赖静态服务器（Node 22 `node:http`）提供浏览入口，`npm run view <docId>` 一键打开。页面以「编辑部印刷物」美学呈现：米纸底、墨黑正文、朱砂红答案、宋体排印、左侧目录栏 + 右侧 A4 纸张流。

**Tech Stack:** 纯 HTML/CSS/vanilla JS（ES modules）；KaTeX（CDN，渲染 `$...$`/`$$...$$` 公式）；Node 22 `node:http` 静态服务器（零新 npm 依赖）；设计规格遵从 cloudbase ui-design skill（设计规格已定，见下）。

## DESIGN SPECIFICATION（ui-design 强制项，先于代码）

```
1. Purpose Statement: 让切片产生的高中试题（题干/选项/附图/答案/题型）以可读、可审、可互动的形式呈现：
   ——它是切分质量的视觉验收面（一眼看出 97.6% 的题是否真的可用），也是未来宿主应用题库前端的独立雏形。
2. Aesthetic Direction: Editorial / 编辑部印刷物（education → Editorial 推荐方向）。
   试卷是纸面产品，用「纸张、排版、印章」语言：米纸底、宋体正文、朱砂红对钩式答案揭晓、页眉细线大标题。
3. Color Palette:
   - 纸白  #F6F1E7（主背景，米纸）
   - 墨黑  #24272B（正文，印刷墨色）
   - 朱砂  #B03A2E（答案/强调/状态点，禁止色之外的正红）
   - 灰蓝  #44627A（次要信息/页眉/元数据）
   - 米灰  #CFC5B2（分隔线/虚线留白）
4. Typography: 正文 'Source Han Serif SC','Noto Serif SC','Songti SC',serif（宋体排印）；
   数据标签 'IBM Plex Mono',ui-monospace,monospace（题号/元数据）；标题同正文族加粗 + 字距拉开。
   （禁止 Inter/Roboto/system-ui 等泛用字体）
5. Layout Strategy: 非对称分栏——左侧 240px 深墨色目录栏（按大题 section 分组、题号与状态色点、点击锚点滚动），
   右侧流动区顶部为页眉大标题（细线下划线），正文为 A4 纸张卡片流（纸张模型：宽 794px 高随内容/答题区按比例）；
   答题区以米灰虚线下划线铺底（按题型留白，见 Task 2 常量）；答案揭晓使用朱砂红印章式小块的偏移叠放，打破常规卡片感。
Icons: 内联 SVG（微软/书签/眼睛/对钩四枚，无 emoji；不引外部图标库，保持零依赖）。
```

## Global Constraints

- `viewer/` 目录对外零依赖：除页面内 KaTeX CDN 外不引入构建链/框架/图标库；`scripts/view-server.ts` 只用 Node 内置模块（`node:http`/`node:fs`/`node:path`），package.json 零新增依赖
- **解耦红线**：`viewer/` 内任何文件不得 `import` 引擎代码（`src/`）；viewer 独立声明 `ViewerQuestion` 类型，以 `docs/CONTRACT.md` 为唯一契约（字段权威 = 引擎 `src/types.ts` 的 Question，契约文档注明「引擎变更需同步 CONTRACT」）
- 数据输入：真实产物 `data/out/23必刷题 2相互作用/questions.json`（85 题、含 images[].path 裸文件名）与 `data/out/…/images/`（97 张图）；`npm test` 全程离线；既有 39 个测试保持全绿
- 已知适配：答案字段 answer 为「B\n解析：…」形态（解析与答案未拆分）→ viewer 按「\n解析：」拆分渲染「答案 + 解析」两行（契约文档注明）；`$..$` 行内公式与 `$$..$$` 独立公式用 KaTeX 渲染；图片路径拼接 `images/${path}`
- 答题留白（A4 纸模型）：纸张高度按 A4 比例（宽 794 / 高 1123px，96dpi），留白按题型——选择 0px / 填空 151px（4cm）/ 主观题 378px（10cm）；全局开关（工具条）+ 单题开关
- 计划产出物：viewer 模块 + CONTRACT.md + view-server + README/DECISIONS 更新 + 浏览器冒烟记录

---

### Task 1: 数据契约 + 预览服务器骨架

**Files:**
- Create: `viewer/docs/CONTRACT.md`
- Create: `viewer/viewer-types.d.ts`（独立类型声明，不 import src）
- Create: `scripts/view-server.ts`
- Modify: `package.json`（scripts 加 `view`、`view:server`）
- Modify: `src/index.ts`（无需——引擎不动；仅确认 questions.json 序列化形态满足契约）

**Interfaces:**
- Consumes: `data/out/<docId>/questions.json`（引擎 SegmentResult.questions 序列化）；`images/` 目录
- Produces:
  - `ViewerQuestion`（契约类型：id/number/type/section/stem/options/answer/images(仅 path)/confidence/status——与引擎 Question 字段对齐但独立声明）
  - `CONTRACT.md`（数据源路径约定、字段表、两条适配规则：答案 `\n解析：` 拆分、图片路径 `images/` 前缀拼接、公式 `$..$` 渲染）
  - `npm run view [docId]` → 起本地静态服务器（默认端口 4173，docId 缺省 `23必刷题 2相互作用`），打印访问 URL；`npm run view:server` 同命令别名
- 供 Task 2（viewer 页面消费契约）与 Task 3（冒烟）

- [ ] **Step 1: 写失败测试（契约类型可被消费 + 服务器可响应）**

`tests/viewer-contract.test.ts`（node:test，离线）：

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("契约：真实 questions.json 可被 ViewerQuestion 消费（每字段形状校验）", () => {
  const qs = JSON.parse(
    readFileSync("data/out/23必刷题 2相互作用/questions.json", "utf8"),
  ) as unknown[];
  assert.ok(qs.length >= 80, "真实产物至少 80 题");
  for (const q of qs as Record<string, unknown>[]) {
    assert.equal(typeof q.id, "string");
    assert.equal(typeof q.number, "string");
    assert.ok(["choice", "subjective"].includes(q.type as string));
    assert.equal(typeof q.stem, "string");
    assert.ok(Array.isArray(q.options));
    assert.ok(Array.isArray(q.images));
    assert.ok(["ok", "needs_review"].includes(q.status as string));
    assert.equal(typeof q.confidence, "number");
  }
});

test("契约：图片路径是裸文件名（viewer 拼接 images/ 前缀的前提）", () => {
  const qs = JSON.parse(
    readFileSync("data/out/23必刷题 2相互作用/questions.json", "utf8"),
  ) as { images: { path: string }[] }[];
  for (const q of qs) {
    for (const img of q.images) {
      assert.ok(!img.path.includes("/"), `图片路径应为裸文件名: ${img.path}`);
    }
  }
  const imgs = new Set(
    qs.flatMap((q) => q.images.map((i) => i.path)),
  );
  assert.ok(imgs.size >= 90, "真实产物图片数 ≥ 90（v1 观测 97 张）");
});
```

（若 `data/out/23必刷题 2相互作用/` 在另一次计划后被清理，测试改用 `data/smoke/` 或按实际存在的产物路径调整；以磁盘实际产物为准，但断言「≥80 题 / ≥90 图」不变。）

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test "tests/viewer-contract.test.ts"`
Expected: 若正常 FAIL 或 PASS 取决于产物存在——本测试是「契约校验」而非 TDD 红绿（产物是既成事实）。若产物不存在 → 测试失败提示路径，先执行 `node --import tsx scripts/real-pipeline.ts sample`（真实 API，约 20 秒）或从 `data/smoke/` 复制最近的 ones 作为测试夹具路径——**优先：若磁盘已有产物直接用；没有则先跑 pipeline 生成**。此步以「测试通过」为验收，不追求先红。

- [ ] **Step 3: 写 CONTRACT.md 与 viewer-types.d.ts**

`viewer/docs/CONTRACT.md`（要点结构）：

```markdown
# 展示层数据契约（CONTRACT v1）

引擎与展示层的唯一边界。引擎（src/）产出的 questions.json 序列化形态；展示层（viewer/）只消费本文件描述的数据。

## 数据源

- 题目: `data/out/<docId>/questions.json` —— SegmentationResult.questions 的 JSON 序列化（引擎 src/types.ts 的 Question 为字段权威）
- 图片: `data/out/<docId>/images/<裸文件名>` —— questions[].images[].path 为裸文件名（不含路径），展示层拼接 `images/` 前缀
- 入口: `npm run view [docId]`（默认 docId=23必刷题 2相互作用）

## 字段表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 全局唯一 docId:p<page>:q<seq> |
| number | string | 题号原文 |
| type | "choice" \| "subjective" | 题型（choice=有完整选项组） |
| section | string | 大题标题 |
| stem | string | 题干（含 $..$ 行内公式与 $$..$$ 独立公式，KaTeX 渲染） |
| options | {key,text}[] | 选项组 |
| answer? | string | 答案（含解析续行，见适配①） |
| images | {path}[] | 图片（path 裸文件名） |
| confidence | number | 置信度 0-1 |
| status | "ok" \| "needs_review" | needs_review 需人工校对 |

## 展示层适配规则

1. 答案拆分：answer 若含「\n解析：」，拆为「答案值 + 解析」两段渲染（引擎暂未拆 solution 字段）
2. 图片路径：拼接 `images/${path}`
3. 公式：`$..$` 行内、`$$..$$` 独立块，用 KaTeX auto-render
4. 留白：按 type —— choice 0px / subjective 378px（A4 纸张中 10cm）+ 未来 blank 151px（4cm）

## 变更流程

- 引擎 Question 字段变更 → 同步本文件与 viewer/viewer-types.d.ts → 跑 tests/viewer-contract.test.ts
```

`viewer/viewer-types.d.ts`（独立声明，禁止 import src）：

```typescript
/**
 * 展示层独立类型声明 —— 数据契约的 TypeScript 形态。
 * 权威：viewer/docs/CONTRACT.md；引擎变更必须同步此处与 CONTRACT.md。
 * 红线：本文件不得 import src/ 下的任何内容。
 */
export interface ViewerQuestion {
  id: string;
  number: string;
  type: "choice" | "subjective";
  section: string;
  stem: string;
  options: { key: string; text: string }[];
  answer?: string;
  images: { path: string }[];
  confidence: number;
  status: "ok" | "needs_review";
}
```

- [ ] **Step 4: 实现 view-server.ts**

```typescript
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
```

（注：docId 在服务器内仅用于提示，页面自行 fetch 相对路径 `../data/out/<docId>/questions.json`——由 `viewer/index.html` 的 JS 按 URL 参数 `?doc=` 读取，Task 2 定义。若此设计有冲突，以 Task 2 的页面实现为准并同步 CONTRACT。）

- [ ] **Step 5: 验证服务器可响应（离线冒烟）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node scripts/view-server.ts & SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/viewer/  # 404（页面未建，Task 2）
curl -s -o /dev/null -w "%{http_code}" "http://localhost:4173/data/out/23%E5%BF%85%E5%88%B7%E9%A2%98%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8/questions.json"  # 200
kill $SERVER_PID
```

Expected: 页面 404（未建，Task 2 补）、questions.json 200（中文路径 URL 编码 OK 即静态服务正确）。

- [ ] **Step 6: 提交**

```bash
git add viewer/docs/CONTRACT.md viewer/viewer-types.d.ts scripts/view-server.ts package.json tests/viewer-contract.test.ts
git commit -m "feat: viewer data contract + zero-dep preview server"
```

---

### Task 2: viewer 页面实现（编辑部印刷物美学）

**Files:**
- Create: `viewer/index.html`
- Create: `viewer/viewer.css`
- Create: `viewer/viewer.js`

**Interfaces:**
- Consumes: CONTRACT v1（Task 1）；`?doc=<docId>` URL 参数（默认 `23必刷题 2相互作用`）；KaTeX CDN（jsdelivr：katex.min.css + katex.min.js + auto-render.min.js）
- Produces: 浏览器可用的完整查看页——目录栏（按 section 分组、题号+状态色点）、A4 纸张卡片流（试题区/答题区/答案区）、答案开关（全局+单题、默认关闭）、按题型留白、公式渲染、图片展示、needs_review 题目标记

- [ ] **Step 1: 页面骨架与数据加载（含契约适配逻辑）**

`viewer/index.html`（结构要点，完整实现按下列规格）：
- `<head>` 引 KaTeX CDN（katex.min.css/js + auto-render），README 注明联网/离线降级（离线时公式以原文 `$..$` 文本显示，不报错）
- 布局：`<aside class="toc">`（目录栏）+ `<main>`（页眉 + 纸张流）；内联 SVG 图标四枚（book/eye/check/alert）以 `<symbol>` 定义复用
- `<script type="module" src="./viewer.js"></script>`

`viewer/viewer.js`（核心逻辑，要点）：

```javascript
// 契约适配（viewer/docs/CONTRACT.md）：
const DOC = new URLSearchParams(location.search).get("doc") ?? "23必刷题 2相互作用";
const BASE = `../data/out/${encodeURIComponent(DOC)}`;
const state = { answersVisible: false, filter: "all" };

async function load() {
  const res = await fetch(`${BASE}/questions.json`);
  if (!res.ok) throw new Error(`questions.json 加载失败（${res.status}）——先运行 npm run view 或检查 doc 参数`);
  return await res.json();
}

function imageSrc(q) { return q.images.map((i) => `${BASE}/images/${encodeURIComponent(i.path)}`); }
function splitAnswer(q) {
  // 适配①：answer 形如 "B\n解析：由…" → { value, solution? }
  if (!q.answer) return { value: "—" };
  const idx = q.answer.indexOf("解析：");
  return idx > 0
    ? { value: q.answer.slice(0, idx).trim(), solution: q.answer.slice(idx) }
    : { value: q.answer };
}

// 渲染：目录（按 section 分组，锚点滚动）+ 纸张卡片
// 卡片：头部（题号 + type 徽标 + status 色点 + section 小字）→ 题干（KaTeX auto-render 后置）+ 附图 → 选项 A-D → 答题区（按 type 确定高度）→ 答案区（默认隐藏，开关切换）
// 全局栏：题型筛选（全部/选择/主观）+ 答案总开关（切换全部卡片）+ 统计（N 题 / ok M / review K）
// 空答题区虚线：height 由 type 决定（choice 0 / subjective 378px；留白常量在 CSS 变量）
```

- [ ] **Step 2: 样式实现（对应 DESIGN SPECIFICATION）**

`viewer/viewer.css` 核心（对齐规格，最终实现按目录结构展开）：
- CSS 变量：`--paper:#F6F1E7; --ink:#24272B; --cinnabar:#B03A2E; --slate:#44627A; --line:#CFC5B2`
- body 排版：`font-family: 'Source Han Serif SC','Noto Serif SC','Songti SC',serif;` 无禁字体；数据标签 mono
- A4 纸卡：宽 794px、背景 `--paper`、细边框 `1px solid var(--line)`、答题区 `border-bottom: 1px dashed var(--line)` 虚线铺底、（CSS 动画：页面加载卡片 stagger reveal——`animation-delay: calc(var(--i) * 40ms)`）
- 答案区默认 `display:none`，`.show-answers` 时淡入（`@keyframes fade-in`）；答案值朱砂红、解析墨黑小字；答案「印章块」样式（红色描边、偏移 4px 叠放，打破对齐）
- 目录栏：深墨色背景（`--ink`）、米色文字、状态色点（ok=灰蓝、needs_review=朱砂）；sticky 定位；section 分组标题 mono 小字
- 非对称性：目录栏 240px 固定 + 主区自适应；卡片流左对齐（不居中）；页眉大标题（section 名聚合）下细线
- 公式区：`.katex-display` 溢出滚动保护

- [ ] **Step 3: 本地自检（静态 + 冒烟）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node scripts/view-server.ts & SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "index:%{http_code} " http://localhost:4173/viewer/
curl -s -o /dev/null -w "js:%{http_code} " http://localhost:4173/viewer/viewer.js
curl -s -o /dev/null -w "css:%{http_code} " http://localhost:4173/viewer/viewer.css
curl -s -o /dev/null -w "data:%{http_code}\n" "http://localhost:4173/data/out/23%E5%BF%85%E5%88%B7%E9%A2%98%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8/questions.json"
kill $SERVER_PID
# 静态审计（ui-design self-audit）
grep -iE "(Inter|Roboto|system-ui|Arial|-apple-system)" viewer/*.css viewer/*.js 2>/dev/null && echo "FONT VIOLATION" || echo "fonts ok"
grep -iE "(violet|purple|indigo|fuchsia)" viewer/*.css 2>/dev/null && echo "COLOR VIOLATION" || echo "colors ok"
grep -nE "(&#x1F|🚀|⭐|❤️|👍|🔥|💡|🎉|✨)" viewer/*.html viewer/*.js 2>/dev/null && echo "EMOJI VIOLATION" || echo "icons ok"
```

Expected: 四资源全 200；三个自检全部 ok（无禁字体/禁色/emoji）。

- [ ] **Step 4: 浏览器级冒烟（可选增强，实施时可执行）**

若环境可用 browser-use（`browser-use:control-browser` skill），用真实产物做一次浏览器验证：打开 `http://localhost:4173/viewer/?doc=23必刷题 2相互作用` → 断言「目录栏出现」「题目卡片 ≥ 80」「全局答案开关切换后答案区可见」「某题选项 4 个」「某题图片 img 存在且可加载」。若 browser-use 不可用，记录为「浏览器验证待人工」，以 Step 3 的 HTTP 冒烟 + Task 3 的 JS 逻辑单测为验收。

- [ ] **Step 5: 提交**

```bash
git add viewer/index.html viewer/viewer.css viewer/viewer.js
git commit -m "feat: viewer pages — editorial paper layout with answer toggle"
```

---

### Task 3: 真实数据端到端冒烟 + 文档收尾

**Files:**
- Modify: `README.md`（「展示层」段：npm run view 使用、契约解耦说明、访问 URL）
- Modify: `docs/DECISIONS.md`（第 11 节追加「展示层独立模块」：契约边界、适配规则、留白配置值）
- Create: `tests/viewer-logic.test.ts`（适配逻辑纯函数单测：splitAnswer / imageSrc 前缀拼接 / 留白常量）

**Interfaces:**
- Consumes: Task 1（契约+服务器）、Task 2（页面）；真实产物 `data/out/23必刷题 2相互作用/`
- Produces: README 使用说明；DECISIONS §11；适配逻辑自动化测试；端到端冒烟记录（HTTP/浏览器）

- [ ] **Step 1: 适配逻辑单测（把契约规则固化为可回归断言）**

`tests/viewer-logic.test.ts`：

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";

// 与 viewer/viewer.js 相同逻辑的纯函数镜像（测试隔离，viewer 是浏览器代码不进 node test runner）
function splitAnswer(answer?: string): { value: string; solution?: string } {
  if (!answer) return { value: "—" };
  const idx = answer.indexOf("解析：");
  return idx > 0
    ? { value: answer.slice(0, idx).trim(), solution: answer.slice(idx) }
    : { value: answer };
}

test("splitAnswer：真实现状（B\\n解析：…）拆为值+解析", () => {
  const r = splitAnswer("B\n解析：由 f(1)=2 得 f(2)=4。");
  assert.equal(r.value, "B");
  assert.equal(r.solution, "解析：由 f(1)=2 得 f(2)=4。");
});
test("splitAnswer：无解析纯答案", () => {
  assert.deepEqual(splitAnswer("AC"), { value: "AC" });
  assert.deepEqual(splitAnswer(undefined), { value: "—" });
});
test("留白常量：choice 0 / subjective 378（A4 10cm）", () => {
  const pad = { choice: 0, subjective: 378 }; // 与 viewer.css --pad-* 同步
  assert.equal(pad.choice, 0);
  assert.equal(pad.subjective, Math.round(1123 * (100 / 297)));
});
```

（留白算式：A4 高 297mm → 1123px @96dpi；10cm=100mm → 1123×100/297≈378px。）

- [ ] **Step 2: 端到端冒烟记录**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node scripts/view-server.ts & SERVER_PID=$!
sleep 1
curl -s "http://localhost:4173/data/out/23%E5%BF%85%E5%88%B7%E9%A2%98%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8/questions.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const qs=JSON.parse(d);console.log("题数",qs.length,"ok",qs.filter(q=>q.status==="ok").length,"review",qs.filter(q=>q.status==="needs_review").length)})'
kill $SERVER_PID
```

Expected: 输出「题数 85 ok 83 review 2」（与切片现状一致）。把该输出 + 若做了浏览器冒烟的截图/断言写入报告。

- [ ] **Step 3: 文档更新**

README.md 追加段：

```markdown
## 展示层（独立模块）

浏览器查看结构化题目（试题区/答题区/答案区、答案开关、按题型留白、公式渲染）：

```bash
npm run view                 # 默认打开 23必刷题 2相互作用
npm run view "23必刷题 2相互作用"
# 然后访问 http://localhost:4173/viewer/
```

- 解耦边界：viewer/ 不依赖引擎代码，只消费 data/out/<docId>/questions.json + images/（契约见 viewer/docs/CONTRACT.md）
- 换展示层：遵守 CONTRACT 即可整体替换 viewer/
- 页面需联网加载 KaTeX CDN（公式渲染）；离线时公式以 $..$ 文本显示
```

DECISIONS.md 追加「## 11. 展示层独立模块（2026-08-22）」：契约边界、`ViewerQuestion` 独立声明、两条适配规则（答案 \n解析： 拆分、图片路径拼接）、留白常量（choice 0 / subjective 378px=A4 10cm、blank 计划 151px=4cm）、美学方向一句话（编辑部印刷物）、浏览器验证状态（若做了记录结论）。

- [ ] **Step 4: 全量验证与提交**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过（39 + viewer-contract 2 + viewer-logic 3 ≈ 44）。

```bash
git add README.md docs/DECISIONS.md tests/viewer-logic.test.ts
git commit -m "docs: viewer usage + decisions; test viewer adapter logic"
```

---

## Self-Review 检查

- **覆盖度**：契约与边界（T1）→ 页面与美学（T2）→ 端到端冒烟与文档（T3），闭环到「可浏览的分类后题目展示 + 可解耦的模块边界」。
- **占位扫描**：T2 Step 1/2 的代码块是「要点清单」而非逐字代码——T2 是创造性 UI 实现（ui-design 要求设计规格先行的实现任务），实现者依据 DESIGN SPECIFICATION + 要点清单自由发挥，验收由 Step 3 的 HTTP 冒烟 / 自检 / Task 3 的浏览器冒烟与单测判据（四资源 200、无禁字体/禁色/emoji、题目数渲染）落地；这是有明确判据的创造性任务，非悬空占位。
- **类型一致性**：ViewerQuestion（T1 定义、T2/T3 引用）；splitAnswer/imageSrc 语义在 T2 实现、T3 以镜像纯函数固化契约；`npm run view` 命令 T1 定义 T3 文档引用；留白常量 378px 算式三处一致（T2 CSS 变量、T3 单测、CONTRACT 表）。
- **约束核查**：零新增依赖（view-server 只用 node: 内置）；viewer 不 import src（红线写入 CONTRACT 与 viewer-types.d.ts 注释）；npm test 离线（浏览器冒烟是开发步骤不进 npm test）；既有 39 测试不碰。