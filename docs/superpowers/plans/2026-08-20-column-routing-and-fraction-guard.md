# 栏目归属修正 + 小数题号守卫 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除真实样本剩余 review 中「跨栏错置」（栏界带行被固定中线错路由）与「0.x 幽灵题号」（小数误判为新题）两类根因，review 35 → 预期大幅下降，并通过读序实验为「整栏拼读」是否需水平带归并产出数据决策。

**Architecture:** 两个修改面独立、可同时解决（本计划 3 个任务）：(1) `layout.ts` 栏目归属从「固定中线 mid=页宽/2」改为「最近簇中心」——`detectColumns` 的桶聚类已算出簇，抽出 `detectColumnCenters()` 供 `restoreReadingOrder` 复用（实测拦界带行 x0=293-297 距右簇中心 ≈310 仅 13-17 点、距左簇中心 ≈60 达 230+，归属修复精确）；(2) `patterns.ts` 的 ARABIC_QUESTION 拆两分支，半角点分支加 `(?!\d)` 负前瞻排除小数（实测 4 个幽灵题号全部是 `0.x` 形态）。第三任务做真实回归 + 「水平带归并 vs 栏序」对照实验，仅当数据证明带归并更优且夹具无回归才落地，否则记录决策。

**Tech Stack:** 既有 TypeScript + node:test；零新依赖；真实数据 `data/smoke/unpacked/layout.json`（15 页双栏）。

## Global Constraints

- `npm test` 全程离线；零新依赖；既有 31 个测试必须全绿（detect-columns 6 个新用例含参数注入语义等）
- 基线（2026-08-19 分栏聚类后）：89 题 / 71 选项组 / review 35（选项乱序 25 = 跨栏错置 15 + 语言层误判 7（幽灵题号 4 + 选项模式 3）+ OCR 局限 3）/ ok 86 (96.6%) / imagesAttached 97
- `detectColumns`/`restoreReadingOrder`/`layoutPage` 签名兼容原则：`layoutPage` 是唯一调用方，内部自由改；`detectColumns(entries, pageWidth, params?)` 对外签名不得破坏（第三参可选）；`restoreReadingOrder` 若加参数必须可选、默认行为不变
- 验收基准（实测侦察）：17 个栏界带行 x0∈[285,305]（其中 4 个 x0=293-297 < mid=298 被错路由到左栏：p4 x0=297、p6 x0=293/294、p8 x0=295/296）；4 个幽灵题号行全部为 `0.x` 半角点形态（p1 `0.2,`、p5 `0.8,`、p6 `0.5,`、p11 `0.4kg`）
- 「A、B、C…题干续行被 OPTION_LINE 当选项」属选项模式误判（语言层 7 条中的 3 条）——**不在本计划范围**，保持 DECISIONS ② 待办
- 计划产出物：代码 + 测试 + 真实回归数字 + 读序实验决策记录（DECISIONS 10.3 更新）+ real-api-notes 追加观测

---

### Task 1: 栏目归属改簇中心（layout.ts）

**Files:**
- Modify: `src/layout.ts`（`detectColumns` 内部抽出簇计算，新增 `detectColumnCenters`；`restoreReadingOrder` 支持按簇中心归属；`layoutPage` 接线）
- Create: `tests/column-routing.test.ts`

**Interfaces:**
- Consumes: 既有 `IndexedBlock`/`ColumnDetectorParams`/`DEFAULT_COLUMN_PARAMS`（Task 前置已存在）
- Produces:
  - `export function detectColumnCenters(entries: IndexedBlock[], pageWidth: number, params?: ColumnDetectorParams): number[]`——有效簇中心升序数组（无有效簇返回 `[]`）
  - `detectColumns` 内部改为调用 `detectColumnCenters`：`centers.length >= 2 && centers[1] - centers[0] > width * params.minGapRatio` → 2，否则 1（行为与现实现等价）
  - `layoutPage`：先取 `centers = detectColumnCenters(...)`，`columns = centers 判定`，`restoreReadingOrder(entries, columns, width, centers)`
  - `restoreReadingOrder(entries, columns, pageWidth, centers: number[] = [])`：`columns <= 1` 或 `centers.length < 2` 走原逻辑（全 y 排序）；两栏时每块的栏归属 = 「x0 距哪个簇中心最近」（不再用 mid=pageWidth/2），左列按 y 排序在前、右列在后（保持栏序语义）
- 供 Task 3（回归对比基线）与后续引用

- [ ] **Step 1: 写失败测试**

```typescript
// tests/column-routing.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectColumnCenters, layoutPage, restoreReadingOrder } from "../src/layout.js";
import type { IndexedBlock } from "../src/types.js";

function blocks(xs: number[]): IndexedBlock[] {
  return xs.map((x, i) => ({
    index: i,
    pageIndex: 0,
    block: { kind: "text", bbox: [x, 100 + i * 10, x + 30, 110 + i * 10], text: `b${i}`, firstLine: `b${i}`, lineCount: 1, maxFontSize: 0 },
  }));
}

test("detectColumnCenters：双栏两簇返回升序中心", () => {
  const left = Array.from({ length: 10 }, (_, i) => 40 + i * 2); // 40~58，中心≈49
  const right = Array.from({ length: 10 }, (_, i) => 300 + i * 2); // 300~318，中心≈309
  const centers = detectColumnCenters(blocks([...left, ...right]), 596);
  assert.equal(centers.length, 2);
  assert.ok(Math.abs(centers[0]! - 49) < 10);
  assert.ok(Math.abs(centers[1]! - 309) < 10);
});

test("restoreReadingOrder：栏界带行（x0 略小于中线）归最近簇（右栏）", () => {
  const left = Array.from({ length: 6 }, (_, i) => 40 + i * 2);
  const right = Array.from({ length: 6 }, (_, i) => 300 + i * 2);
  const boundary = [296, 297, 293]; // x0 < mid=298 且应归右栏（距右簇中心 309 近）
  const entries = blocks([...left, ...boundary, ...right]);
  const centers = detectColumnCenters(entries, 596);
  const ordered = restoreReadingOrder(entries, 2, 596, centers);
  const texts = ordered.map((e) => (e.block as Extract<typeof e.block, { kind: "text" }>).text);
  // 右栏块（含 boundary 行）必须全部出现在左栏块之后；boundary 行在右列内按 y 序
  const leftIdx = Math.max(...texts.map((t, i) => (t.startsWith("b") && !t.startsWith("b1") && texts.indexOf(t) ?
    0 : 0)); // 占位，下面重写为清晰断言
});

test("status quo：单栏/无簇时行为不变", () => {
  const xs = Array.from({ length: 20 }, (_, i) => 50 + i * 2);
  const ordered = layoutPage({ index: 0, width: 596, height: 800, blocks: blocks(xs).map((b) => b.block) });
  assert.equal(ordered.columns, 1);
  assert.equal(ordered.ordered.length, 20);
});
```

（注：第二个用例的断言实现「右列全部在左列之后 + boundary 行归属右列」按如下方式写——`leftKeys` = y<300 且距左中心近的块文本集合；直接断言 `ordered` 序列中每个 boundary 块的位置位于所有左栏块之后，且其相对顺序与 y 一致。若嫌复杂，可用更直接的等价断言：`ordered.filter(...)` 中右列文本（含 `b0..b5` 之外与 boundary 文本）的最后位置 > 左列文本的最后位置。实现者以「断言正确、语义清楚」为准，可在 Step 3 实现后按数据调整断言细节，但必须验证 boundary 行归右列这一核心行为。）

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test "tests/column-routing.test.ts"`
Expected: FAIL（`detectColumnCenters` 不存在；且现有 `restoreReadingOrder` 用 mid=298 会把 boundary 行归左列）

- [ ] **Step 3: 实现**

`src/layout.ts` 改动：

```typescript
// 现有 detectColumns 拆出簇计算：新增导出函数（放在 detectColumns 之前）

export function detectColumnCenters(
  entries: IndexedBlock[],
  pageWidth: number,
  params: ColumnDetectorParams = DEFAULT_COLUMN_PARAMS,
): number[] {
  const xs = entries.filter((e) => e.block.kind !== "image").map((e) => e.block.bbox[0]);
  if (xs.length < 4) return [];
  const width = pageWidth > 0 ? pageWidth : 1654;
  const bucketWidth = width / params.bucketCount;
  const hist = new Array<number>(params.bucketCount).fill(0);
  for (const x of xs) hist[Math.min(params.bucketCount - 1, Math.floor(x / bucketWidth))] = (hist[Math.min(params.bucketCount - 1, Math.floor(x / bucketWidth))] ?? 0) + 1;
  const minBlocks = Math.max(params.minClusterBlocks, Math.floor(xs.length * params.minClusterRatio));
  const clusters: { from: number; to: number; count: number }[] = [];
  let cur: { from: number; to: number; count: number } | null = null;
  for (let i = 0; i < params.bucketCount; i++) {
    const v = hist[i] ?? 0;
    if (v >= minBlocks) {
      if (!cur) cur = { from: i, to: i, count: v };
      else { cur.to = i; cur.count += v; }
    } else if (cur) { clusters.push(cur); cur = null; }
  }
  if (cur) clusters.push(cur);
  return clusters
    .map((c) => {
      const lo = c.from * bucketWidth;
      const hi = (c.to + 1) * bucketWidth;
      const inCluster = xs.filter((x) => x >= lo && x < hi);
      return inCluster.reduce((a, b) => a + b, 0) / Math.max(1, inCluster.length);
    })
    .sort((a, b) => a - b);
}

export function detectColumns(
  entries: IndexedBlock[],
  pageWidth: number,
  params: ColumnDetectorParams = DEFAULT_COLUMN_PARAMS,
): number {
  const centers = detectColumnCenters(entries, pageWidth, params);
  const width = pageWidth > 0 ? pageWidth : 1654;
  if (centers.length >= 2 && (centers[1] ?? 0) - (centers[0] ?? 0) > width * params.minGapRatio) return 2;
  return 1;
}
```

`layoutPage` 与 `restoreReadingOrder` 改动：

```typescript
export function layoutPage(page: PageInfo): LayoutInfo {
  const width = page.width > 0 ? page.width : 1654;
  const entries: IndexedBlock[] = page.blocks.map((block, index) => ({ index, pageIndex: page.index, block }));
  const centers = detectColumnCenters(entries, width);
  const columns = detectColumns(entries, width);
  return { columns, ordered: restoreReadingOrder(entries, columns, width, centers) };
}

export function restoreReadingOrder(
  entries: IndexedBlock[],
  columns: number,
  pageWidth: number,
  centers: number[] = [],
): IndexedBlock[] {
  const byY = (a: IndexedBlock, b: IndexedBlock) => a.block.bbox[1] - b.block.bbox[1];
  if (columns <= 1 || centers.length < 2) return [...entries].sort(byY);
  const assign = (x: number) => {
    let best = 0;
    let bestDist = Infinity;
    centers.forEach((c, i) => {
      const d = Math.abs(c - x);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  };
  const left = entries.filter((e) => assign(e.block.bbox[0]) === 0).sort(byY);
  const right = entries.filter((e) => assign(e.block.bbox[0]) !== 0).sort(byY);
  return [...left, ...right];
}
```

（注：`assign` 按最近簇中心；簇序为 x 升序，第 0 簇=最左簇。行为等价于旧「左列在前右列在后」但栏界不再依赖固定 mid。）

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test "tests/column-routing.test.ts"` 然后 `npm test`
Expected: 新用例 PASS；既有 31 个全绿（detect-columns 6 个、engine 的 math-two-column 阅读顺序断言等不受影响——其两簇中心 80/880 下归属不变）

- [ ] **Step 5: 提交**

```bash
git add src/layout.ts tests/column-routing.test.ts
git commit -m "feat: route row blocks to nearest column cluster instead of fixed midline"
```

---

### Task 2: 0.x 小数题号守卫（patterns.ts）

**Files:**
- Modify: `src/patterns.ts`（`ARABIC_QUESTION` 拆两分支 + 负前瞻；`matchFirstLine` 捕获组读取适配）
- Modify: `tests/engine.test.ts` 或新建 `tests/patterns-fraction.test.ts`（建议新建，聚焦）

**Interfaces:**
- Consumes: `matchFirstLine` 现有语义（其余模式不动）
- Produces: `ARABIC_QUESTION` 新形态（外部无依赖，私有常量）；`matchFirstLine` 行为变化：`0.2,…`/`0.8,`/`0.5,`/`0.4kg` 不再匹配 question_no，返回 other（流入题干续行）；`1. 设`/`1．设`/`3) 求`/`2.已知` 仍匹配

- [ ] **Step 1: 写失败测试**

```typescript
// tests/patterns-fraction.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFirstLine } from "../src/patterns.js";

test("0.x 小数行不再判为题号（幽灵题号守卫）", () => {
  for (const line of ["0.2,最大静摩擦力与滑动摩擦力大小相等", "0.8,不计滑轮与轻绳间的摩擦", "0.5,最大静摩擦力等于滑动摩擦力", "0.4kg的小球，劲度系数为"]) {
    assert.notEqual(matchFirstLine(line).kind, "question_no", `「${line}」不应是题号`);
    assert.equal(matchFirstLine(line).kind, "other");
  }
});

test("真题号形态不受影响", () => {
  assert.equal(matchFirstLine("1．设集合 A = {x}，则…").kind, "question_no");
  assert.equal(matchFirstLine("1. 设集合 A = {x}，则…").kind, "question_no");
  assert.equal(matchFirstLine("2.已知函数 f(x) = 2x - 4，则…").kind, "question_no");
  assert.equal(matchFirstLine("3) 求 a、b 的值").kind, "question_no");
  assert.equal(matchFirstLine("（2）求 f(x) 的最大值").kind, "question_no");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test "tests/patterns-fraction.test.ts"`
Expected: FAIL（现实现把 `0.2,` 等判为 question_no）

- [ ] **Step 3: 实现**

`src/patterns.ts` 改动：

```typescript
/**
 * 阿拉伯数字题号：1. / 1． / 1、 / 1) 等（半角全角分隔符容忍）。
 * 守卫：半角点后紧跟数字视为小数（0.5、0.4kg），不是题号——
 * 真实教辅常见题干续行以「0.8,不计…」开头，误判会产生幽灵题号 0。
 */
const ARABIC_QUESTION = /^(\d{1,3})\.(?!\d)|^(\d{1,3})[．、)）]/;
```

`matchFirstLine` 中对应段（现为 `const arabic = ARABIC_QUESTION.exec(s); if (arabic) { return { ok: true, kind: "question_no", captured: arabic[1] ?? "" }; }`）改为：

```typescript
const arabic = ARABIC_QUESTION.exec(s);
if (arabic) {
  return { ok: true, kind: "question_no", captured: arabic[1] ?? arabic[2] ?? "" };
}
```

（注：两分支各有独立捕获组；半角点分支命中时组 2 为 undefined，全角/顿号/右括号分支命中时组 1 为 undefined——`??` 链兼容两分支。`stripQuestionPrefix`/`matchAnswerEntry` 的行首剥离正则 `/^\d{1,3}\s*[.．、)）]/` 同样会把 `0.5,` 剥成 `,…`——**一并改为两支**，避免题干前缀剥离留下逗号残渣：`/^\d{1,3}\.(?!\d)|^\d{1,3}\s*[．、)）]/`，否则 Task 3 回归中题干行会带 `,不计…` 前缀。同理检查 `stripOptionPrefix` 是否受影响（选项键 A-H 无数字，不影响）。）

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test "tests/patterns-fraction.test.ts"` 与 `npm test`
Expected: 新 2 用例 PASS；既有 31 全绿（engine 用例无 0.x 形态，不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/patterns.ts tests/patterns-fraction.test.ts
git commit -m "feat: guard decimal-leading lines from question-number misdetection"
```

---

### Task 3: 真实回归 + 读序实验决策 + 文档

**目的：** 验证两修复在真实样本上的联合效果（跨栏错置 15 条与幽灵题号 4 条应大幅消失）；对「整栏拼读」是否需改水平带归并跑对照实验并记录决策；更新 DECISIONS 10.3 与 real-api-notes。

**Files:**
- Modify: `docs/DECISIONS.md`（10.3 后续动作②④更新 + 新回归数字）
- Modify: `docs/real-api-notes.md`（§5.2 追加栏界带归属与 0.x 形态观测）
- 可能 Modify: `src/layout.ts`（仅当实验证明带归并显著更优时，见 Step 3 条件）

**Interfaces:**
- Consumes: Task 1 的 `detectColumnCenters`/`restoreReadingOrder(centers)`；Task 2 的题号守卫；`data/smoke/unpacked/layout.json`
- Produces: 回归对比表（review 35→新值、乱序 25→新值、ok 占比）；读序实验决策记录；DECISIONS/notes 更新

- [ ] **Step 1: 真实全量回归（开发步骤）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx -e '
import { readFileSync } from "node:fs";
import { segmentFromLayout } from "./src/index.js";
const lay = JSON.parse(readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const r = segmentFromLayout(lay, "real-layout-v3");
console.log("题数", r.questions.length, "选项组", r.stats.optionGroups, "review", r.stats.reviewCount);
console.log("ok:", r.questions.filter(q=>q.status==="ok").length, "/", r.questions.length);
const reasons = {};
for (const rv of r.reviews) {
  const k = rv.reason.startsWith("选项乱序") ? "选项乱序" : rv.reason.split("：")[0];
  reasons[k] = (reasons[k] ?? 0) + 1;
}
console.log("review 分类:", JSON.stringify(reasons));
'
```

Expected: 对比基线（review 35 / 乱序 25 / ok 86）——**选项乱序应降到 10 条左右**（15 跨栏错置中 4 个错路由行被修复，连带其选项组错配消失；幽灵题号 4 条转 ok；剩余乱序为带序拼读残留与 OCR 局限）。如实记录实际数字（含每条 review 的 reason 分类计数）。

- [ ] **Step 2: 幽灵题号验证（离线断言）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx -e '
import { readFileSync } from "node:fs";
import { segmentFromLayout } from "./src/index.js";
const lay = JSON.parse(readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const r = segmentFromLayout(lay, "real-layout-v3");
const ghost = r.questions.filter(q => q.number === "0");
console.log("幽灵题号 0 数量:", ghost.length, "(修复前 4)");
console.log("含 0.5/0.8/0.2/0.4 片段的题:", r.questions.filter(q => /0\.[0-9]/.test(q.stem)).length);
'
```

Expected: 幽灵题号 0 从 4 → 0；`0.5,` 等片段出现在题干文本中（作为续行被正确吸收）。

- [ ] **Step 3: 读序对照实验（决策产出，不落地实现）**

用一个临时脚本（写在 `.superpowers/sdd/` 工作区或 `/tmp`，不提交）模拟「水平带归并」读序，对比 review：

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx -e '
import { readFileSync } from "node:fs";
import { normalizeLayout } from "./src/normalize.js";
import { detectColumnCenters, layoutPage } from "./src/layout.js";
import { ruleStrategy } from "./src/strategy.js";
const lay = JSON.parse(readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const doc = normalizeLayout(lay, "exp");
// 模拟带归并：把 restoreReadingOrder 的输出按「两列按 y 归并」重排
// 实现：对每页取 layoutPage().ordered，再分别取左列/右列按 y merge
import type { IndexedBlock, ParsedDocument } from "./src/types.js";
function bandOrder(page: { index: number; width: number; height: number; blocks: any[] }, doc: ParsedDocument) {
  const layout = layoutPage(page as any);
  const centers = detectColumnCenters(layout.ordered, page.width || 1654);
  if (centers.length < 2) return layout.ordered;
  const byY = (a: IndexedBlock, b: IndexedBlock) => a.block.bbox[1] - b.block.bbox[1];
  const left = layout.ordered.filter((e) => Math.abs(centers[0]! - e.block.bbox[0]) <= Math.abs(centers[1]! - e.block.bbox[0])).sort(byY);
  const right = layout.ordered.filter((e) => Math.abs(centers[1]! - e.block.bbox[0]) < Math.abs(centers[0]! - e.block.bbox[0])).sort(byY);
  let i = 0, j = 0;
  const out: IndexedBlock[] = [];
  while (i < left.length && j < right.length) {
    if (left[i]!.block.bbox[1] <= right[j]!.block.bbox[1]) out.push(left[i++]!);
    else out.push(right[j++]!);
  }
  return out.concat(left.slice(i), right.slice(j));
}
// 注入实验读序：复制 rule-engine 的 segmentWithRules 不便注入顺序——
// 更简单的替代：直接统计两种读序下「同一题号行前后 3 块内选项行 A. 的连续性」不需要全链路
// 采取折中：打印两种读序下每页前 20 块的题号序列供人工对比（栏序 vs 带序）
for (const page of doc.pages) {
  const layout = layoutPage(page);
  const band = bandOrder(page, doc);
  const nums = (es: typeof layout.ordered) => es.slice(0, 24).map((e) => {
    const b = e.block as any;
    const m = /^(\d{1,3})[.．、]/.exec(b.firstLine ?? "");
    return m ? m[1] : "·";
  }).join("");
  console.log(`p${page.index} 栏序: ${nums(layout.ordered)}`);
  console.log(`p${page.index} 带序: ${nums(band)}`);
}
'
```

分析规则：**题号序列完整性优先**——若带序下题号序列更连续（如 `5,6,7,8` 而非 `5,·,·,8`），说明跨栏连续题存在、带归并有价值；若栏序下序列已经连续而带序被打散（左右栏各自成题），则**保持栏序**、记录决策「整栏拼读影响 ≤N 条，不引入带归并（避免拆散栏序成题）」。
**落地条件**：仅当带序使 Step 1 的 review 预计下降 >20% 且人工确证样本页「跨栏连续题」≥3 处时，才把带归并实现进 `restoreReadingOrder`（加可选参数 `banded?: boolean`，默认 false）+ 测试 + 全量验证；否则只记录决策与证据（题号序列对比、样本页截图描述），不改代码。

- [ ] **Step 4: 文档更新**

DECISIONS.md 10.3 追加（按实际数字）：

```markdown
（2026-08-20 栏目归属 + 小数守卫后）review <Step 1 实测>（选项乱序 <实测>，其中跨栏错置 <实测>、幽灵题号 0）；ok 占比 <实测>%（<n>/89）。
后续动作②④更新：栏目归属已改簇中心（拦界带行 x0∈[293,297] 归最近簇，4 个错路由行修复）；0.x 小数守卫已落地（幽灵题号 4→0）。
整栏拼读决策：<Step 3 结论 + 证据一句话>。
```

real-api-notes.md §5.2 追加：

```markdown
### 栏目归属与小数形态（2026-08-20 观测）

- 拦界带：右栏题号行 x0 可低至 293-297（距右簇中心 ≈310 仅 13-17 点），固定中线 mid=页宽/2=298 会错路由到左栏——改为最近簇中心归属（左簇 ≈60、右簇 ≈310）。
- 小数行：题干续行常以「0.5,」「0.8,」「0.4kg」开头（半角点），被题号正则误判为第 0 题；守卫：半角点后接数字即非题号。
```

- [ ] **Step 5: 全量验证与提交**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过（31 + Task 1/2 新增 ≈ 41；若 Step 3 落地带归并则 + 其测试）。

```bash
git add docs/DECISIONS.md docs/real-api-notes.md
# 若 Step 3 落地带归并，另行 git add src/layout.ts tests/*
git commit -m "feat: route columns by cluster + fraction guard — real regression + docs"
```

---

## Self-Review 检查

- **覆盖度**：T1（栏归属簇中心）→ T2（0.x 守卫）→ T3（联合回归 + 实验决策 + 文档），用户指名的两个问题都有直接任务；「A、B、C 选项模式误判」明确排除在范围外（DECISIONS ② 待办，避免范围膨胀）。
- **占位扫描**：T1 Step 1 第二个用例的断言实现留有「按数据调整细节」说明，但核心行为（栏界带行归右栏）是硬断言；T3 Step 3 是实验脚本 + 明确的落地条件（双双给出），非悬空；Step 4 数字标记「实测回填」并给出了执行命令与对比基线。
- **类型一致性**：`detectColumnCenters(entries, pageWidth, params?): number[]`（T1 定义，T1/T3 引用）；`restoreReadingOrder` 第四参 `centers: number[] = []` 可选（T1 定义、layoutPage 唯一调用方）；`ARABIC_QUESTION` 两分支捕获组 `arabic[1] ?? arabic[2]`（T2 内一致）；T3 实验脚本中的 `bandOrder` 是实验代码不落库。
- **约束核查**：零新依赖；既有 31 测试不破坏（T1 重构保持 detectColumns 对外签名与行为；T2 仅动题号正则半角点分支）；验收基准来自实测侦察（17 个拦界带行中的 4 个错路由 + 4 个 0.x 行）。