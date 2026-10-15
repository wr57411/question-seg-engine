# 分栏检测升级：x0 桶聚类替代单一阈值实施计划

> 📍 交接导航：本文件是**当时的实施计划（历史记录）**，不代表当前状态。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../../AGENTS.md)**。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 x0 桶直方图聚类替代现有「最大间隙 > 页宽 28%」的分栏判定，让真实 15 页（实际全部为双栏）分栏正确，消除 103 条「选项乱序」review 噪音。

**Architecture:** 侦察确认（2026-08-19，data/smoke/unpacked/layout.json 行级数据）：每页都有两个大簇——左簇 x0≈25-99（n=18-38）、右簇 x0≈273-348（n=18-38），居中标题块 1-2 个横跨栏间隙（如 x0=221 把 71→302 的间隙切成 150/81 两段），导致现有 maxGap=150 < 596×0.28=167 误判单栏。新算法：页宽等分桶统计块数 → 稠密桶（≥ max(5, 10%×总块数)）相邻合并成簇 → 有效簇 ≥2 且簇中心距 > 25% 页宽 → 两栏。小簇（标题/页边注 n≤2）自然被过滤。参数可注入，供真实数据校准。

**Tech Stack:** 既有 TypeScript + node:test；零新依赖；`detectColumns(entries, pageWidth, params?)` 签名兼容（第三参数可选、默认常量导出）。

## Global Constraints

- `npm test` 全程离线；零新依赖；既有 25 个测试必须全绿（engine/validation/client/unpack/normalize-layout/real-layout 全部）
- `detectColumns` 现签名 `(entries: IndexedBlock[], pageWidth: number): number` 必须保持调用兼容（layoutPage 唯一调用方）；新增可选第三参数 `params?: ColumnDetectorParams`，默认值导出为 `DEFAULT_COLUMN_PARAMS`，供 Task 2 校准复用
- 验收基准（真实数据，人工标注）：layout.json 15 页**全部为双栏**（p0~p14 每页左簇 x0≈25-99、右簇 x0≈273-348，n=18-38；p0/p4/p5/p11 各含 1-2 个居中/边注小簇 n≤2，必须被过滤）；现有夹具 math-two-column 必须仍判 2 栏、math-single-choice 与 math-noise 必须仍判 1 栏
- 已知事实：真实回归基线（行级展开+选项拆分+图片挂回后）89 题 / 51 选项组 / 128 review（103 条为选项乱序，根因本计划的分栏漏检）/ imagesAttached 97
- 计划产出物：代码 + 测试 + DECISIONS.md 10.3 后续动作①关闭 + real-api-notes.md §5.2 分栏观测补充

---

### Task 1: detectColumns 桶聚类实现 + 单元测试

**Files:**
- Modify: `src/layout.ts`（重写 `detectColumns`，新增 `ColumnDetectorParams`/`DEFAULT_COLUMN_PARAMS` 导出；`layoutPage`/`restoreReadingOrder` 不动）
- Create: `tests/detect-columns.test.ts`

**Interfaces:**
- Consumes: 既有 `IndexedBlock`（`block.bbox[0]` 与 `block.kind`）
- Produces:
  - `interface ColumnDetectorParams { bucketCount: number; minClusterBlocks: number; minClusterRatio: number; minGapRatio: number }`
  - `export const DEFAULT_COLUMN_PARAMS: ColumnDetectorParams`（`{ bucketCount: 24, minClusterBlocks: 5, minClusterRatio: 0.1, minGapRatio: 0.25 }`）
  - `detectColumns(entries, pageWidth, params = DEFAULT_COLUMN_PARAMS): number`——返回 1 或 2
- 供 Task 2 校准（改参数重跑）与 Task 3 文档引用

- [ ] **Step 1: 写失败测试**

```typescript
// tests/detect-columns.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectColumns, DEFAULT_COLUMN_PARAMS } from "../src/layout.js";
import type { IndexedBlock } from "../src/types.js";

/** 构造 IndexedBlock[]：指定 x0 数组，其余字段占位 */
function blocks(xs: number[]): IndexedBlock[] {
  return xs.map((x, i) => ({
    index: i,
    pageIndex: 0,
    block: { kind: "text", bbox: [x, 10, x + 30, 20], text: `b${i}`, firstLine: `b${i}`, lineCount: 1, maxFontSize: 0 },
  }));
}

test("单栏：块集中在左侧一簇", () => {
  const xs = Array.from({ length: 30 }, (_, i) => 40 + i * 1.5); // 40~83
  assert.equal(detectColumns(blocks(xs), 596), 1);
});

test("双栏：左右两簇，簇距显著", () => {
  const left = Array.from({ length: 15 }, (_, i) => 40 + i * 2); // 40~68
  const right = Array.from({ length: 15 }, (_, i) => 300 + i * 2); // 300~328
  assert.equal(detectColumns(blocks([...left, ...right]), 596), 2);
});

test("带居中标题的双栏：标题块横跨栏间隙不破坏判定（真实数据机制）", () => {
  const left = Array.from({ length: 15 }, (_, i) => 40 + i * 2);
  const right = Array.from({ length: 15 }, (_, i) => 300 + i * 2);
  const titles = [221, 196]; // 居中标题/大题块，n=2 必须被过滤
  assert.equal(detectColumns(blocks([...left, ...titles, ...right]), 596), 2);
});

test("小数据双栏（math-two-column 形态）：左 10 块右 5 块仍判两栏", () => {
  const left = [60, 80, 80, 80, 80, 60, 80, 80, 80, 80];
  const right = [880, 880, 880, 880, 880];
  assert.equal(detectColumns(blocks([...left, ...right]), 1654), 2);
});

test("零散小簇不足阈值：单栏（边注 n=2 不构成第二栏）", () => {
  const main = Array.from({ length: 20 }, (_, i) => 50 + i * 1.5);
  const aside = [300, 305]; // 边注 2 块 < max(5, 10%×22=2.2)→5
  assert.equal(detectColumns(blocks([...main, ...aside]), 596), 1);
});

test("参数可注入：收紧 minClusterBlocks 后小簇可成第二栏簇", () => {
  const main = Array.from({ length: 12 }, (_, i) => 50 + i * 1.5);
  const aside = Array.from({ length: 6 }, (_, i) => 300 + i * 2);
  assert.equal(detectColumns(blocks([...main, ...aside]), 596, { ...DEFAULT_COLUMN_PARAMS, minClusterBlocks: 5 }), 2);
  assert.equal(detectColumns(blocks([...main, ...aside]), 596, { ...DEFAULT_COLUMN_PARAMS, minClusterBlocks: 8 }), 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test "tests/detect-columns.test.ts"`
Expected: FAIL（`ColumnDetectorParams`/`DEFAULT_COLUMN_PARAMS` 不存在或现有阈值实现至少 2 例失败——含"带居中标题的双栏"与"边注"用例）

- [ ] **Step 3: 实现桶聚类**

```typescript
// src/layout.ts：替换 detectColumns 现有实现，layoutPage/restoreReadingOrder 不动

export interface ColumnDetectorParams {
  /** 页宽等分桶数 */
  bucketCount: number;
  /** 有效簇的最小块数（绝对下限） */
  minClusterBlocks: number;
  /** 有效簇的最小块数占比（相对下限，乘以总块数后与绝对下限取 max） */
  minClusterRatio: number;
  /** 两栏判定：列中心最小间距（相对页宽） */
  minGapRatio: number;
}

export const DEFAULT_COLUMN_PARAMS: ColumnDetectorParams = {
  bucketCount: 24,
  minClusterBlocks: 5,
  minClusterRatio: 0.1,
  minGapRatio: 0.25,
};

/**
 * 分栏检测：x0 桶直方图聚类。
 * 机理（2026-08-19 真实数据校准）：双栏页左右各一簇（行级数据每簇 18~38 块），
 * 居中标题/边注 1~2 块横跨栏间隙会破坏「最大间隙」判定，但不会形成稠密桶——
 * 故用「稠密桶聚簇 + 簇中心距」替代单一间隙阈值。
 */
export function detectColumns(
  entries: IndexedBlock[],
  pageWidth: number,
  params: ColumnDetectorParams = DEFAULT_COLUMN_PARAMS,
): number {
  const xs = entries
    .filter((e) => e.block.kind !== "image")
    .map((e) => e.block.bbox[0]);
  if (xs.length < 4) return 1;

  const width = pageWidth > 0 ? pageWidth : 1654;
  const bucketWidth = width / params.bucketCount;
  const hist = new Array<number>(params.bucketCount).fill(0);
  for (const x of xs) {
    const idx = Math.min(params.bucketCount - 1, Math.floor(x / bucketWidth));
    hist[idx] = (hist[idx] ?? 0) + 1;
  }

  const minBlocks = Math.max(params.minClusterBlocks, Math.floor(xs.length * params.minClusterRatio));
  const clusters: { from: number; to: number; count: number }[] = [];
  let cur: { from: number; to: number; count: number } | null = null;
  for (let i = 0; i < params.bucketCount; i++) {
    const v = hist[i] ?? 0;
    if (v >= minBlocks) {
      if (!cur) cur = { from: i, to: i, count: v };
      else {
        cur.to = i;
        cur.count += v;
      }
    } else if (cur) {
      clusters.push(cur);
      cur = null;
    }
  }
  if (cur) clusters.push(cur);

  if (clusters.length >= 2) {
    const centers = clusters
      .map((c) => {
        const lo = c.from * bucketWidth;
        const hi = (c.to + 1) * bucketWidth;
        const inCluster = xs.filter((x) => x >= lo && x < hi);
        return inCluster.reduce((a, b) => a + b, 0) / Math.max(1, inCluster.length);
      })
      .sort((a, b) => a - b);
    if ((centers[1] ?? 0) - (centers[0] ?? 0) > width * params.minGapRatio) return 2;
  }
  return 1;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test "tests/detect-columns.test.ts"` 然后 `npm test`
Expected: 新 6 用例 PASS；既有 25 个测试全绿（math-two-column 仍 2 栏、math-single-choice/math-noise 仍 1 栏——engine 既有断言自动覆盖）

- [ ] **Step 5: 提交**

```bash
git add src/layout.ts tests/detect-columns.test.ts
git commit -m "feat: column detection via x0 bucket clustering (replaces fixed gap threshold)"
```

---

### Task 2: 真实数据校准与全量回归

**目的：** 用真实 15 页 layout.json 验证聚类判定（验收基准：15/15 双栏），并按需微调默认参数；随后跑全量回归对比 review 数量（预期 103 条选项乱序消失）。

**Files:**
- Modify: `src/layout.ts`（仅当校准发现默认参数不达标时调整 `DEFAULT_COLUMN_PARAMS` 的数值并在注释记录）
- Modify: `docs/DECISIONS.md`（10.3 后续动作①更新为实测结论）
- Modify: `docs/real-api-notes.md`（§5.2 补分栏观测：15/15 双栏、居中标题横跨间隙机制、簇统计）

**Interfaces:**
- Consumes: `detectColumns` + `DEFAULT_COLUMN_PARAMS`（Task 1）；`data/smoke/unpacked/layout.json`
- Produces: 校准结论（15/15 判定表）；全量回归数字（review 128 → 新值）；DECISIONS/notes 更新

- [ ] **Step 1: 写校准脚本（开发步骤，产出判定表）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx -e '
import { readFileSync } from "node:fs";
import { layoutPage } from "./src/layout.js";
import { normalizeLayout } from "./src/normalize.js";
const lay = JSON.parse(readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const doc = normalizeLayout(lay, "calib");
let wrong = 0;
for (const page of doc.pages) {
  const cols = layoutPage(page).columns;
  const expect = 2; // 人工标注：15/15 双栏
  if (cols !== expect) { wrong++; console.log(`p${page.index}: 判定 ${cols}，期望 2 ✗`); }
}
console.log(`校准结果: ${doc.pages.length - wrong}/${doc.pages.length} 页正确`);
// 输出每页簇分布供核对
for (const page of doc.pages) {
  const xs = page.blocks.filter(b => b.kind !== "image").map(b => b.bbox[0]).sort((a,b)=>a-b);
  const w = page.width || 1654, bw = w / 24, hist = Array(24).fill(0);
  for (const x of xs) hist[Math.min(23, Math.floor(x / bw))]++;
  const dense = hist.map((v,i) => ({ i, v })).filter(o => o.v >= 5).map(o => `${Math.round(o.i*bw)}-${Math.round((o.i+1)*bw)}(n=${o.v})`).join(" ");
  console.log(`p${page.index}: ${dense}`);
}
'
```

Expected: 若全部正确打印 `15/15 页正确`；若有点位失败，进入 Step 2 调整。**预期失败的页**（若有）：簇边界落在桶分割处或右簇块数 < 阈值（真实右簇 n=18~38，应全过；以实际输出为准）。

- [ ] **Step 2: 参数微调（仅在 Step 1 有失败页时执行）**

按失败页的簇分布（Step 1 已打印）调整 `DEFAULT_COLUMN_PARAMS`（例如 `bucketCount` 32 或 `minClusterRatio` 0.08），改完重跑 Step 1 直到 15/15。若调参后 math-two-column/math-single-choice 夹具回归失真，同时检查 engine 测试（阈值在两者之间取平衡）。无失败则跳过本步。

- [ ] **Step 3: 全量真实回归**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx -e '
import { readFileSync } from "node:fs";
import { segmentFromLayout } from "./src/index.js";
const lay = JSON.parse(readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const r = segmentFromLayout(lay, "real-layout-v2");
console.log("题数", r.questions.length, "选项组", r.stats.optionGroups, "review", r.stats.reviewCount);
console.log("ok:", r.questions.filter(q=>q.status==="ok").length, "needs_review:", r.questions.filter(q=>q.status==="needs_review").length);
const reasons = {};
for (const rv of r.reviews) reasons[rv.reason.startsWith("选项乱序") ? "选项乱序" : rv.reason.split("：")[0]] = (reasons[rv.reason.startsWith("选项乱序") ? "选项乱序" : rv.reason.split("：")[0]] ?? 0) + 1;
console.log("review 分类:", JSON.stringify(reasons));
'
```

Expected: 对比基线 89 题 / 51 选项组 / 128 review（103 选项乱序）/ ok 82——选项乱序从 103 大幅下降（预期 ≤5，若全部消失则剩余 review 为数量异常/中断/键不连续等真实信号）；review 总量与 ok 数随之改善。**如实记录实际数字**，即使不达预期也写进报告与 DECISIONS（含原因）。

- [ ] **Step 4: 文档更新**

DECISIONS.md 10.3 后续动作①改为：

```markdown
①（2026-08-19 已落地）分栏聚类（x0 桶直方图）替代 28% 阈值：真实 15/15 页正确判定双栏（此前 13 页漏检）。
回归：review 128 → <Step 3 实测>（选项乱序 103 → <实测>）；ok 占比 <实测>%。默认参数：bucketCount 24 / minClusterBlocks 5 / minClusterRatio 0.1 / minGapRatio 0.25。
```

real-api-notes.md §5.2 追加：

```markdown
### 分栏观测（2026-08-19 校准）

- 行级粒度下真实 15 页全部为双栏：左簇 x0≈25-99（n=18-38）、右簇 x0≈273-348（n=18-38），页宽 596。
- 居中标题/大题块（1-2 个，x0≈196-221）横跨栏间隙，会把「最大间隙」判定切成两段（如 71→302 被 221 切成 150/81 < 28% 阈值）→ 旧判定漏检。
- 桶直方图聚类（桶高 ≥ max(5, 10%) 聚簇 + 簇中心距 > 25% 页宽）对该机制免疫，小簇 n≤2 自然过滤。
```

- [ ] **Step 5: 全量验证与提交**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过（25 + Task 1 的 6 = 31；若 Task 1 已提交则 31 个）。

```bash
git add src/layout.ts docs/DECISIONS.md docs/real-api-notes.md
git commit -m "feat: calibrate column clustering on real 15 pages + regression + docs"
```

---

### Task 3: README 收尾修正 + 全量验证

**目的：** 清理本分支与之前计划留下的过时文档表述，确保 README/代码一致。

**Files:**
- Modify: `README.md`（两处：核心机制①分栏描述更新为聚类；已知简化列表删除「选项同一行四连不支持」（splitConjoinedOptions 已实现），若列表提到分栏 28% 阈值一并更新）

**Interfaces:**
- Consumes: Task 1/2 的最终行为与参数；既有 README 结构
- Produces: 与代码一致的 README

- [ ] **Step 1: README 更新**

README.md 「核心机制」第 1 条（分栏描述）改为：

```markdown
1. **双层规则，先版面后语言**：分栏检测用 x0 桶直方图聚类（双栏 = 两个稠密簇且簇中心距 > 25% 页宽；
   对居中标题横跨栏间隙免疫），阅读顺序恢复只用 bbox 坐标（`layout.ts`）；
   题号/选项匹配只作用于「块首行」（`patterns.ts` 的 `matchFirstLine`），
   两个纯层都不做切割决策，切割由 `rule-engine.ts` 状态机裁决。
```

「已知简化（演进点，勿当成最终实现）」列表：删除「选项同一行四连（A．1 B．2 C．3 D．4）暂不支持，需做行内切分」一条（已由 splitConjoinedOptions 实现）；其余保留并按现状修订（题目默认解析路径为 layout.json，content_list 为退化路径，如有旧表述一并更新）。

- [ ] **Step 2: 全量验证**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: sync README with column clustering and option-split support"
```

---

## Self-Review 检查

- **覆盖度**：核心算法（T1）→ 真实校准与回归（T2）→ 文档收尾（T3），闭环到验收目标（真实 15 页分栏正确、review 中选项乱序噪音消除）。
- **占位扫描**：T2 的期望数字（review 128→新值）标记为"实测回填"并给出执行命令与分类统计（reasons 汇总），非悬空；T2 Step 2 是条件步骤（仅当校准失败才执行），触发条件与回调路径明确。
- **类型一致性**：`ColumnDetectorParams`/`DEFAULT_COLUMN_PARAMS`/`detectColumns(entries, pageWidth, params?)` 在 T1 定义、T1/T2 引用一致；`layoutPage` 签名不变；既有 `IndexedBlock` 未动。
- **约束核查**：零新依赖；既有 25 测试不破坏（detectColumns 第三参数可选）；验收基准（15/15 双栏标注）来自本轮实测侦察；夹具 math-two-column/math-single-choice/math-noise 期望值保持不变。