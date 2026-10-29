---
design_type: feature
created_at: 2026-10-29
---

# 表格结构进数据 + 成品页画网格

## Intent Contract

intent: 让 MinerU 已读出、但被 normalize 整块丢弃的表格（含 rowspan/colspan 网格）进入产品数据，
        并在成品页按原坐标画成真网格；同时保持切题结果逐字节不变。
constraints:
- 切题结果零变化：全量 29 册题数、题号序列必须与改动前完全一致（表格块不参与题号/选项判定）。
- 不改写已有文本：表格块是**新增**内容，绝不修改 OXR 已提供的压平文字。
- 不猜：表格结构只来自上游 `spans[].html`；解析不出网格时退回文本渲染，不推断列宽。
- 展示层解耦：`stages/`、`final/` 只消费快照 JSON，不 import `src/`。
- 纸面重建只此一处：网格渲染必须走 `stages/reconstruct.js`，`final/` 自动同源。
success_criteria:
- 全量 29 册 A/B：题数、每册题号序列 100% 一致。
- 含表格的册（电路/磁场/机械能守恒/运动和力/答案册-合订本）快照出现 kind=table 块，带 html。
- 成品页该位置显示真网格（有框线、合并单元格正确），且不再叠加压平文字。
- `npm run check` 全绿（测试数增加、渲染审计 8/8、配对 420 不变）。
risk_level: medium

## Verification Contract

verify_steps:
- run tests: npm run check
- check: 全量 A/B 脚本对比改动前后每册题数与题号序列（必须逐册相等）
- check: 快照断言 —— 含表格册的 stages.json 中 kind=table 块数 > 0 且带 html
- check: 渲染审计 8 卷 8/8 通过（不引入新的 LaTeX 残留/溢出）
- confirm: 成品页截图（电路 p0、机械能守恒 p13）可见带框线网格，无文字叠加
confirm: 配对仍 420 条、内容尺子全达标

## Governance Contract

approval_gates:
- 设计文档（本文件）确认后才写实现代码
- 全量 A/B 出现任何题数差异 → 停止并回报，不自行调阈值
- 显示层改动完成后必须逐页截图审板（红线：后台数字达标 ≠ 页面上看得见）
rollback:
- 代码：git revert 对应提交；本特性全部为新增字段/新增分支，无数据迁移
- 数据：重跑 `npm run daily -- <layout.json> --id <docId> --no-ocr` 即回退到无 table 块的产物
ownership: 本轮由当前 Agent 执行；跨会话接手先读本文件 + docs/HANDOFF.md §6-25

## Scope

| 范围内 | 范围外（明确不做） |
|---|---|
| `normalize` 新增 `type:"table"` 分支（从嵌套 `blocks[].lines[].spans[].html` 取网格） | 实验题**黏连题号**识别（`2为了减少阻力…`）—— 动切题判据，单独立项 |
| `Question.tables[]` 增量字段（表格归属当前题，**不改 stem**） | 把表格拆成题干分段引用（题干 schema 重构） |
| `fuse-doc` 写回保留表格块 | 表格语义理解（哪列是自变量/因变量） |
| `export-stages` 快照带表格块 | 表格题自动判分 |
| `reconstruct.js` 画网格 + 隐藏被覆盖的行块 | 从空白/文字推断列宽（红线：不猜） |

## Decisions

| # | 决策 | 选择 | 否决的替代方案 |
|---|---|---|---|
| D1 | 表格块是否参与切题 | **不参与**：`process()` 显式跳过 `kind==="table"` | 按 text 处理（会把表格文字混进题干，改变切题结果） |
| D2 | 表格归属哪里 | **`Question.tables[]` 增量字段**，stem 不动 | 并入 stem（改题干）；不归属（数据里成孤儿块） |
| D3 | 与 OXR 压平文字的关系 | 两者都保留；显示层用 `bbox` 包含关系**隐藏**压平行块，数据层两份都在 | 删除压平文字（改写已有内容，违反红线） |
| D4 | `htmlBBox` 是否还需要 | **不需要**：`kind==="table"` 时 `bbox` 就是表格整块框 | 复用 `htmlBBox`（多一层字段，语义重复） |
| D5 | 渲染失败（解析不出行）怎么办 | 退回文本渲染（用块的 `text`），不丢内容 | 留空白（丢内容） |
| D6 | 网格样式放哪 | **内联样式**（`stages/` 与 `final/` 各有 CSS，共用渲染器） | 两处各写一份 CSS（必然漂移，违反「只此一处实现」） |

## Surface

**`src/types.ts`** — `ParsedBlock` 的 `kind: "text" | "table"` 分支已存在，新增可选 `html?: string`；`Question` 新增可选 `tables?: { html: string; bbox: BBox; pageIndex: number }[]`。均为增量字段，核心骨架不变（DECISIONS 分层冻结约定）。

**`src/normalize.ts`** — layout 路径新增 `type==="table"` 分支：遍历嵌套 `blocks[].lines[].spans[].html` 取第一个含 `<table` 的串，产出一个 `kind:"table"` 块，`text` 取单元格文本按行拼接，`bbox` 用 para_block 的框。

**`src/rule-engine.ts`** — `process()` 顶部对 `kind==="table"` 走独立分支：不参与题号/选项判定，归属当前题（`current.tables.push(...)`），无当前题时记 ReviewNote（不静默）。

**`scripts/fuse-doc.ts`** — 写回时对 table 块输出 `type:"table"` + 嵌套结构，保留 html。

**`scripts/export-stages.ts`** — 快照块带 `html`（仅 table 块）；题目带 `tables`。

**`stages/table-html.js`**（新增，`@ts-check` + JSDoc）— 纯函数：表格 HTML → 行/单元格（保留 rowspan/colspan，`<eq>`→`$…$`）。

**`stages/reconstruct.js`** — `appendBlockNodes` 对 table 块调 `tableNode` 画网格；被表格 `bbox` 完整覆盖的其它行块跳过（几何包含，确定性）。

## Risks & Open Questions

| 风险 | 影响 | 缓解 |
|---|---|---|
| 表格块进入块流后，阅读顺序/跨页逻辑受影响 | 切题结果变 | A/B 全量题数断言；`process()` 显式跳过 |
| 电路这类「OXR 已压平 + MinerU 有网格」的册出现双份内容 | 显示层文字叠加 | 显示层按 bbox 包含关系隐藏压平行块（D3） |
| 机械能守恒/运动和力这类「表格页 0 题」的册，表格块无题可归属 | 数据里仍是孤儿块 | 记 ReviewNote 显式可见；归属问题由「黏连题号」立项解决（范围外） |
| 网格在密集页挤压/溢出 | 页面难看 | 渲染审计 + 逐页截图审板；`table-layout:fixed` + `word-break` |

**开放问题（本轮不解决，登记）**：实验题黏连题号导致 62% 实验页 0 题——这是表格「有块无主」的根因，单独立项（HANDOFF §6-26 待登记）。
