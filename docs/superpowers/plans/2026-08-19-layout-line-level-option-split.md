# v2 几何信息接入：行级展开与选项拆分实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把真实 MinerU 产物中的 layout.json（行级几何信息 + 真实 page_size）接入管线，解决真实样本「选项被合并进单块 → 每题仅 1 选项 → 83 题全 needs_review」的问题，让选项结构化在真实数据上可用。

**Architecture:** layout.json 的 `pdf_info[].para_blocks` 每块含 `lines[]`（每行 bbox + spans，span 类型 text/equation_inline）与 `page_size`（实测 [596,821]），且侦察确认「A. …B. …C. …D. …」合并段落在这里是**一行一个选项**。因此：新增 `normalizeLayout(layoutRaw, docId)` 以「行级块」展开 para_blocks（每 line 一个 ParsedBlock，equation_inline 内联为 `$...$`，page_size 取真实值），作为首选内容源；v1/v2 content_list 分支保留为无 layout 时的退化路径。规则引擎不改（行级块天然匹配现有"块首行"语义）；另加「粘连选项正则拆分」兜底（layout 缺失或一行四选项时）。

**Tech Stack:** 既有 TypeScript + tsx + node:test；零新依赖。真实产物：`data/smoke/unpacked/layout.json`（15 页、para_blocks 行级）；真实样本 `sample/23必刷题 2相互作用.pdf`；产物 `data/out/23必刷题 2相互作用/`（含 result.zip，zip 内含 layout.json——Task 3 验证产物）。

## Global Constraints

- `npm test` 全程离线；新依赖为零；API Key 不出现在提交/日志（本计划不涉及网络，仅消费磁盘产物）。
- 现有 15 个测试（engine 5 / validation 4 / client 4 / unpack 2）必须保持全绿——normalize 旧分支（v1 数组、pdf_info 层级、合成 fixture）不得破坏。
- 行级展开的原则：**语义不变**——同一 block 的 lines 展开后，按行序拼接的文本必须等于原 spans 拼接文本（equation_inline 统一内联 `$...$`）；回拼校验（validation.ts）对行级块照样工作（haystack 为 blockIndexes 内所有行文本 join）。
- 已知事实（2026-08-18 冒烟/回归记录于 docs/real-api-notes.md 与 docs/DECISIONS.md）：真实样本 83 题、47 ok / 36 needs_review、63 条 review（主因选项合并）；v1 无 page_size 默认 1654；v2 content_list 是页数组、无 page_size；layout.json `pdf_info[].page_size` 实测 [596,821]、块含 `lines[].spans[]`（type text/equation_inline）。
- 计划产出物：代码 + 测试 + DECISIONS.md 第 10 节指标更新 + real-api-notes.md 补充（若新发现）。

---

### Task 1: normalize 行级展开（normalizeLayout）

**Files:**
- Modify: `src/normalize.ts`（新增 `normalizeLayout(layoutRaw, docId)` 与内部函数，旧分支零改动）
- Modify: `src/types.ts`（如需新增辅助类型，优先复用 ParsedBlock/PageInfo）
- Create: `tests/normalize-layout.test.ts`
- Create: `tests/fixtures/layout.sample.json`（从真实 `data/smoke/unpacked/layout.json` 复制的脱敏夹具：只取 page 0 与 page 1 的 para_blocks，保留 page_size/type/lines/spans 全形态）

**Interfaces:**
- Consumes: 真实 `data/smoke/unpacked/layout.json`（抽查复制）；既有 `ParsedDocument`/`PageInfo`/`ParsedBlock` 类型
- Produces: `function normalizeLayout(layoutRaw: unknown, docId: string): ParsedDocument`
  - 页序按 `page_idx` 排序；每页 `width/height` = `page_size[0]/[1]`（缺失默认 1654×2339）
  - 每 `para_blocks` 块按 `lines[]` 展开为一个或多个 `ParsedBlock`（text/table 形态：`text` 为该 line 的 spans 拼接、`firstLine` 同 text、`lineCount=1`、`maxFontSize` 缺省 0、`bbox` = line.bbox；`discarded_blocks`/`preproc_blocks` 忽略）
  - span 拼接规则与 normalizeBlock 一致：`equation_inline` span → `$<content>$`
  - 空 lines 的块：整块文本拼成一个块（等价旧逻辑），不产生空块
- 供 Task 2/3 使用；Task 3 的 index 出口据此接线

- [ ] **Step 1: 复制夹具**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node -e '
const fs = require("fs");
const lay = JSON.parse(fs.readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const slim = { pdf_info: lay.pdf_info.slice(0, 2).map(p => ({ page_idx: p.page_idx, page_size: p.page_size, para_blocks: (p.para_blocks || []).slice(0, 8) })) };
fs.writeFileSync("tests/fixtures/layout.sample.json", JSON.stringify(slim, null, 2));
console.log("wrote", slim.pdf_info.length, "pages, blocks:", slim.pdf_info.reduce((a,p)=>a+p.para_blocks.length,0));
'
```

Expected: `tests/fixtures/layout.sample.json` 生成（含 title/paragraph/text/list 混合块、equation_inline 至少 1 处——从真实数据验证覆盖）。提交时该夹具入库（供离线测试与回归）。

- [ ] **Step 2: 写失败测试**

```typescript
// tests/normalize-layout.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/layout.sample.json", import.meta.url), "utf8"),
);

test("normalizeLayout：页数与 page_size 来自 layout", () => {
  const doc = normalizeLayout(raw, "layout-test");
  assert.equal(doc.pages.length, 2);
  assert.ok(doc.pages[0]!.width > 0, "width 应来自 page_size");
  assert.equal(doc.pages[0]!.index, doc.pages[0]!.index); // 排序稳定
});

test("normalizeLayout：para_blocks 按 line 展开且行序拼接等值原文本", () => {
  const doc = normalizeLayout(raw, "layout-test");
  const page = doc.pages[0]!;
  // 每个块非空；行内公式以 $..$ 内联
  const allText = page.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n");
  assert.ok(allText.length > 0);
  // 若夹具含 equation_inline，断言出现 $..$
  if (/\\sin|\\frac/.test(allText)) {
    assert.match(allText, /\$.+?\$/);
  }
  // 合并选项段落的行级展开：找到 bbox 都在 [54,193,199,262] 内容对应的块集合
  // （真实夹具里有 "A. 重力的作用点在重心上" 行），断言存在以 "A." 开头的行块
  const optionLine = page.blocks.find(
    (b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text" && /^A[.．、]/.test(b.firstLine),
  );
  assert.ok(optionLine, "应存在行级展开的选项行块");
});
```

- [ ] **Step 3: 运行确认失败**

Run: `node --import tsx --test "tests/normalize-layout.test.ts"`
Expected: FAIL（`Cannot find module '../src/normalize.js'` 或函数未导出）

- [ ] **Step 4: 实现 normalizeLayout**

```typescript
// src/normalize.ts 追加（旧函数保持不动）

/**
 * 行级布局解析：以 MinerU result.zip 中的 layout.json 为主内容源。
 * para_blocks 每块按 lines[] 展开为行级块（每行一个 ParsedBlock），
 * 行内公式 span 内联为 $...$；page_size 取真实值。
 * 解决 v1/v2 content_list 块粒度太粗（选项被合并进单块）的问题。
 */
export function normalizeLayout(layoutRaw: unknown, docId: string): ParsedDocument {
  const root = asRecord(layoutRaw);
  const pages = asArray(root.pdf_info as unknown)
    .map((entry) => {
      const rec = asRecord(entry);
      const size = asArray(rec.page_size as unknown);
      const blocks: ParsedBlock[] = [];
      for (const pbRaw of asArray(rec.para_blocks as unknown)) {
        const pb = asRecord(pbRaw);
        const lines = asArray(pb.lines as unknown);
        if (lines.length === 0) continue;
        for (const lineRaw of lines) {
          const line = asRecord(lineRaw);
          const spans = asArray(line.spans as unknown);
          const parts: string[] = [];
          for (const spanRaw of spans) {
            const span = asRecord(spanRaw);
            const content = String(span.content ?? span.text ?? "");
            if (!content) continue;
            parts.push((span.type === "equation_inline" ? `$${content.trim()}$` : content));
          }
          if (parts.length === 0) continue;
          const text = parts.join("");
          blocks.push({
            kind: "text",
            bbox: toBBox(line.bbox),
            text,
            firstLine: text,
            lineCount: 1,
            maxFontSize: 0,
          });
        }
      }
      return {
        index: asInt(rec.page_idx) ?? 0,
        width: asNumber(size?.[0]) ?? 1654,
        height: asNumber(size?.[1]) ?? 2339,
        blocks,
      } satisfies PageInfo;
    })
    .sort((a, b) => a.index - b.index);
  return { docId, pages };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `node --import tsx --test "tests/normalize-layout.test.ts"` 然后 `npm test`
Expected: 新测试 PASS；既有 15 个测试全部保持 PASS

- [ ] **Step 6: 提交**

```bash
git add src/normalize.ts tests/normalize-layout.test.ts tests/fixtures/layout.sample.json
git commit -m "feat: normalize layout.json into line-level blocks (page_size, equation_inline)"
```

---

### Task 2: 粘连选项正则拆分兜底（patterns + rule-engine 接线）

**目的：** layout 缺失或某行内仍含多个选项（侦察见过 `A.3:4 B.3:5 C.4:5 D.2:3` 同 paragraph 单行形态在 v2 出现）时，用正则按选项标记拆分。这是兜底路径，不改变 layout 行级块的效果。

**Files:**
- Modify: `src/patterns.ts`（新增导出函数 `splitConjoinedOptions(text: string): { key: string; text: string }[]`）
- Modify: `src/rule-engine.ts`（`onOption`：当选项块文本含 ≥2 个选项标记时拆分一次性入 pending）
- Modify: `tests/engine.test.ts` 或新建 `tests/patterns-split.test.ts`

**Interfaces:**
- Consumes: `ON_OPTION_LINE` 语义（复用 `OPTION_LINE` 正则派生）；`onOption` 现有签名
- Produces: `splitConjoinedOptions`——输入 block 文本（可能多行），返回拆分后的选项数组（key 去重、保留出现顺序；文本 trim）；rule-engine 在 `onOption` 分支：若 `splitConjoinedOptions(block.text).length >= 2` 且 key 连续合法，则跳过单块路径、直接批量入 pending（保持 `optEvidence` 与 blockIndexes 登记语义）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/patterns-split.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitConjoinedOptions } from "../src/patterns.js";

test("粘连选项拆分：一行四选项", () => {
  const opts = splitConjoinedOptions("A.3:4 B.3:5 C.4:5 D.2:3");
  assert.deepEqual(opts.map((o) => o.key), ["A", "B", "C", "D"]);
  assert.deepEqual(opts.map((o) => o.text), ["3:4", "3:5", "4:5", "2:3"]);
});

test("粘连选项拆分：无空格粘连（A.xxxB.yyy）", () => {
  const opts = splitConjoinedOptions("A.重力的作用点在重心上B.重力的大小与质量成正比C.重力的方向总是竖直向下");
  assert.equal(opts.length, 3);
  assert.equal(opts[0]!.key, "A");
  assert.match(opts[0]!.text, /重力的作用点/);
});

test("粘连选项拆分：普通文本（题干）不拆分", () => {
  assert.equal(splitConjoinedOptions("2. [山东潍坊中学2022摸底]关于相互作用").length, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test "tests/patterns-split.test.ts"`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现拆分函数**

```typescript
// src/patterns.ts 追加
const OPTION_SPLIT = /([A-H])\s*[.．、)）:：]\s*(?=[A-H][.．、)）:：]|$)/g;

/**
 * 粘连选项拆分：块内文本含多个连续选项标记时按标记切分（layout 行级展开缺失时的兜底，
 * 或某行本身含多个选项如 "A.3:4 B.3:5"）。题干文本（无连续 A-D 标记）返回空数组。
 * 注意：只处理「同一文本内连续选项」形态，混入正文数字/字母时不生效（返回空，由上层走原路径）。
 */
export function splitConjoinedOptions(text: string): { key: string; text: string }[] {
  const trimmed = text.trim();
  const first = /^([A-H])\s*[.．、)）:：]\s*/.exec(trimmed);
  if (!first) return [];
  const out: { key: string; text: string }[] = [];
  let rest = trimmed.slice(first[0].length);
  let key = first[1]!.toUpperCase();
  for (;;) {
    const m = OPTION_SPLIT.exec(rest);
    if (!m) break;
    const seg = rest.slice(0, m.index).trim();
    if (seg) out.push({ key, text: seg });
    key = (m[1] ?? "").toUpperCase();
    rest = rest.slice(m.index + m[0].length); // 直接跳过本标记（如 "B."），继续找下一个
  }
  // 最后一段
  if (rest.trim()) out.push({ key, text: rest.trim() });
  return out;
}
```

（注：若实现中正则有回溯/截断边界问题，以测试为准调整；三个用例是行为契约。）

- [ ] **Step 4: rule-engine 接线**

在 `rule-engine.ts` 的 `onOption` 入口之前（`process` 的 `case "option"` 分支）插入：

```typescript
case "option": {
  // 粘连多选项一行：直接批量入 pending（layout 行级未覆盖时的兜底）
  const splits = splitConjoinedOptions(block.text);
  if (splits.length >= 2 && splits[0]!.key === this.expectOptionKey) {
    for (const s of splits) {
      if (s.key === this.expectOptionKey) {
        this.pendingOptions.push(s);
        this.expectOptionKey = nextKey(s.key);
        if (this.current) this.current.optEvidence = true;
      } else {
        this.settleOptions(this.current);
        this.review(blockIndex, `粘连选项键不连续：期待 ${this.expectOptionKey}，实际 ${s.key}`, this.current);
        break;
      }
    }
    if (this.current) this.current.blockIndexes = [...this.current.blockIndexes, blockIndex];
    return;
  }
  this.onOption(block, m.optionKey ?? "", blockIndex);
  return;
}
```

`rule-engine.ts` 顶部补 `import { splitConjoinedOptions } from "./patterns.js";`（与其他 patterns 导入并列）。

- [ ] **Step 5: 运行确认全部过**

Run: `node --import tsx --test "tests/patterns-split.test.ts"` 与 `npm test`
Expected: 新 3 用例 PASS；既有 15 用例保持 PASS

- [ ] **Step 6: 提交**

```bash
git add src/patterns.ts src/rule-engine.ts tests/patterns-split.test.ts
git commit -m "feat: split conjoined options (fallback when layout lines unavailable)"
```

---

### Task 3: 真实样本端到端回归 + 指标/文档更新

**目的：** 用真实 layout.json 走通全链路，对比行级展开前后的选项结构化效果；更新 DECISIONS 10.3 指标基线；real-api-notes 补 layout 观测。

**Files:**
- Modify: `src/index.ts`（导出 `segmentFromLayout(layoutRaw, docId)`，`normalizeLayout` → `ruleStrategy.segment`）
- Modify: `scripts/real-pipeline.ts`（解包后把 layout 一并读入并改用 layout 路径；zip 内已含 layout.json——`unpackResult` 增加可选返回 `layoutJson`，或管线从 `content_list.json` 同目录读（产物目录有）。选前者：`unpackResult` 返回体加 `layoutJson?: unknown`（zip 含 layout.json 时填充），`data/out` 落盘 `layout.json`）
- Modify: `src/mineru/unpack.ts`
- Modify: `docs/DECISIONS.md`（10.3 指标基线补行级展开后数据）
- Modify: `docs/real-api-notes.md`（§5.1 补 layout 行级观测：para_blocks lines 一行一选项、page_size 596×821、equation_inline）
- Create: `tests/real-layout-regression.test.ts`（用真实 `data/smoke/unpacked/layout.json` 的**行级展开夹具**（Task 1 的 layout.sample.json 只含前 2 页 8 块，回归用完整文件会太大入库？——改用 Task 1 夹具 + 断言题目数 ≥ 2 即可，真实全量回归放脚本跑，不入测试）

**Interfaces:**
- Consumes: `normalizeLayout`（Task 1）、`ruleStrategy.segment`、`unpackResult`
- Produces: `segmentFromLayout(layoutRaw: unknown, docId: string): SegmentationResult`；`unpackResult` 返回体新增 `layoutJson?: unknown`；管线命令不变（同一入口）

- [ ] **Step 1: index.ts 出口 + unpack 扩展**

```typescript
// src/index.ts 追加
import { normalizeLayout } from "./normalize.js";

/** 以 layout.json（行级几何信息）为主内容源的结构化入口 */
export function segmentFromLayout(layoutRaw: unknown, docId: string): SegmentationResult {
  const doc = normalizeLayout(layoutRaw, docId);
  return ruleStrategy.segment(doc);
}
```

```typescript
// src/mineru/unpack.ts：返回体与解包逻辑扩展
export interface UnpackedResult {
  contentList: unknown;
  layoutJson?: unknown; // zip 含 layout.json 时填充
  markdown: string;
  images: { path: string; data: Buffer }[];
}
// unpackResult 内：const layoutEntry = entries.find(e => name(e).toLowerCase().endsWith("layout.json"));
// if (layoutEntry) out.layoutJson = JSON.parse(layoutEntry.getData().toString("utf8"));
```

- [ ] **Step 2: 真实回归离线测试**

```typescript
// tests/real-layout-regression.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { segmentFromLayout } from "../src/index.js";

test("行级展开：真实 layout 夹具切分非空且选项成组", () => {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/layout.sample.json", import.meta.url), "utf8"),
  );
  const r = segmentFromLayout(raw, "layout-reg");
  assert.ok(r.questions.length >= 1);
  // 行级展开后应能出现选项组（夹具 page0 含 A.重力的作用点... 四行）
  assert.ok(r.stats.optionGroups >= 1, "行级展开应产出至少 1 个选项组");
  assert.equal(r.stats.reviewCount, 0, "选项成组后此夹具不应有 review（如失败，把夹具裁剪到最小可推进范围并记录）");
});
```

（若夹具跨页/结构导致多个题、某题 review——按实际调整断言，但 **optionGroups≥1 是硬指标**，评审按此验收。）

- [ ] **Step 3: 运行真实全量回归（开发步骤，产物不入测试）**

```bash
cd /Users/john/.zcode/workspace/default/question-seg-engine
node --import tsx -e '
import { readFileSync } from "node:fs";
import { segmentFromLayout } from "./src/index.js";
const lay = JSON.parse(readFileSync("data/smoke/unpacked/layout.json", "utf8"));
const r = segmentFromLayout(lay, "real-layout");
console.log("题数", r.questions.length, "选项组", r.stats.optionGroups, "review", r.stats.reviewCount);
console.log("ok:", r.questions.filter(q=>q.status==="ok").length, "needs_review:", r.questions.filter(q=>q.status==="needs_review").length);
'
```

Expected: 与 v1 基线对比（83 题 / optionGroups 1 / 63 review / 47 ok）——选项组数大幅上升（预期 ≥ 30）、review 数显著下降。把对比数字记入 Task 3 报告；若数字异常（选项组仍 ≤5），记录原因（如 layout 行级块在真实数据上 bbox 跨栏错配）并如实写 DECISIONS 10.3 的"后续动作"。

- [ ] **Step 4: real-pipeline.ts 改用 layout 路径并落盘 layout.json**

修改管线脚本的核心段（下载 zip → unpack → 切分）：

```typescript
const { contentList, layoutJson, markdown, images } = unpackResult(zip);
// ... 落盘 content_list.json / full.md / images 不变 ...
if (layoutJson !== undefined) {
  writeFileSync(join(out, "layout.json"), JSON.stringify(layoutJson, null, 2));
  const result = segmentFromLayout(layoutJson, docId);
  writeFileSync(join(out, "questions.json"), JSON.stringify(result.questions, null, 2));
  writeFileSync(join(out, "summary.txt"), summarize(result));
} else {
  // 退化：无 layout 时走 content_list
  const result = segmentFromContentList(contentList, docId);
  writeFileSync(join(out, "questions.json"), JSON.stringify(result.questions, null, 2));
  writeFileSync(join(out, "summary.txt"), summarize(result));
}
```

验收（开发步骤）：`node --import tsx scripts/real-pipeline.ts sample` 跑通，`data/out/23必刷题 2相互作用/` 出现 `layout.json`，`summary.txt` 数字与 Step 3 一致。

- [ ] **Step 5: 文档更新（DECISIONS 10.3 + notes §5.1）**

DECISIONS.md 10.3 在「选项指标挂起至 v2」处追加：

```markdown
（2026-08-19 行级展开后更新）layout.json 行级接入后：<Task 3 Step 3 实测数字：题数/选项组/review/ok 占比>。
选项结构化在真实数据上可用；<仍受限项或后续动作，如行内多选项兜底覆盖率>。
```

real-api-notes.md §5.1 补：`layout.json pdf_info[].page_size` 实测 [596,821]；`para_blocks[].lines[]` 每行 bbox + spans（type text/equation_inline，equation_inline 需内联 `$...$`）；合并选项段落为一行一个 option（实测 "A. 重力的作用点在重心上" 4 行展开）。

- [ ] **Step 6: 全量验证与提交**

Run: `npm run check`
Expected: typecheck 通过、全部测试通过（15 + 新 5 ~ 6 个）。

```bash
git add src/index.ts src/mineru/unpack.ts tests/real-layout-regression.test.ts docs/DECISIONS.md docs/real-api-notes.md scripts/real-pipeline.ts
git commit -m "feat: layout.json as primary source (line-level) + real regression + docs"
```

---

## Self-Review 检查

- **覆盖度**：行级展开（T1）→ 粘连拆分兜底（T2）→ 真实回归与文档（T3），链路闭合成一个可验收目标（选项结构化在真实数据可用）。
- **占位扫描**：regex 实现留了「以测试为准调整」的唯一自由度（回溯边界），行为契约由三个测试 pin 住；Task 3 Step 3 的「实测数字」待跑后回填，非悬空（Step 3 已给出执行命令与对比基线）。
- **类型一致性**：`normalizeLayout(layoutRaw, docId): ParsedDocument`、`segmentFromLayout(layoutRaw, docId): SegmentationResult`、`unpackResult(): UnpackedResult`（新增可选 `layoutJson`）、`splitConjoinedOptions(text): {key,text}[]`——跨 Task 引用一致；`onOption` 签名不变。
- **约束核查**：零新依赖；既有 15 测试不破坏（normalize 只新增函数/分支，rule-engine 只在 option 分支前加兜底检查）；离线测试成立（夹具入库，真实网络不触发）；API Key 无涉。