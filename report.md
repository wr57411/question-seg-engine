# 对比视图「解析遗漏」标记开关 —— 交付报告

日期：2026-11-20 · 分支：`feature/tool-no-mineru` · 改动仅限展示层（不碰数据/判据）

## 1. 做了什么

在 stages 的**对比视图**（第 7 步「对比」，左原卷 / 右按原坐标重建成品）里，给
「解析遗漏」标记（内容级洋红框 + 可见标签 / 家具级灰虚线 / 底部图例）加了一个开关。

- **默认关闭**：无 URL 参数、无 localStorage 记忆时，不画内容级/家具级标记，也不画底部图例，页面更干净。
- 需要核查漏识别时，勾顶部工具栏「解析遗漏标记」或加 `?uncovered=1` 打开。

### 开关三处一致（照 final 页 `?audit=1` 的现有风格）

| 处 | 实现 |
|---|---|
| ① URL 参数 | `?uncovered=1` 开、`?uncovered=0` 关；优先级最高（可分享/收藏） |
| ② 可见控件 | 工具栏复选框 `#uncovered-check`（在 `<label id="uncovered-toggle" class="tb-toggle">` 内），**仅「对比」阶段可见**；实测触屏目标 131×44px（≥44px 下限） |
| ③ localStorage | 键 `stages.uncovered`，值 `"1"/"0"`；换视图（切步骤/翻页）与重载都保持 |

解析顺序：URL 参数 → localStorage → 默认关。localStorage 不可用（隐私模式等）时按默认关，不猜。

## 2. 改动点

- `stages/reconstruct.js`
  - `renderPaper` 新增选项 `uncovered`（默认 `true`，仅当 `diagnostics` 为真时生效）；
    `diagnostics && uncovered` 才调用 `uncoveredInto`（原 993 行）。
  - 默认值取 `true` 是为了**不改变既有调用方行为**：成品页 `diagnostics:false` 本就不画；
    对比页不传时维持原状。`RenderOpts` typedef 同步加字段。
- `stages/reconstruct.d.ts`：`PaperOptions` 加 `uncovered?: boolean`（手写 d.ts 集合不变）。
- `stages/stages.js`
  - 新增 `UNCOVERED_KEY` 与 `resolveUncovered()`（URL → localStorage → 默认关）；
    `state.uncovered`。
  - `initCompareToggle()`：绑定复选框，勾选变化 → 更新 `state` + 写 localStorage + 重渲染。
  - `renderCompare()`：给 `renderPaper` 传 `uncovered: state.uncovered`；底部图例改为
    `state.uncovered` 时才 append。
  - `render()`：`#uncovered-toggle` 仅在 `stage === 6`（对比）可见。
  - 「对比」步骤的「你该看」文案补一句：这些标记默认不显示，勾顶部开关可开。
  - 阶段 1（原料）/阶段 3（切题）的 `uncoveredInto` **保持原样**（Task 16 行为不动）。
- `stages/index.html`：工具栏加复选框标签（默认 `hidden`，由 JS 控制）。
- `stages/stages.css`：新增 `.tb-toggle`（照 final `.fb-toggle` 风格，`min-height:44px`）。
- `tests/layout-invariant.test.ts`：新增 `④b` 开关行为断言（复用该文件最小 DOM 桩）。

## 3. 约束遵守

- **解耦**：展示层未 import 引擎 `src/`（`tests/decoupling.test.ts` 全绿）。
- **DOM 文件不写 `// @ts-check`**：`stages.js` / `reconstruct.js` 头部保持原说明；
  类型由 `tsconfig.viewer.json` 校验。
- **不改任何数据/判据**：只加展示开关，`uncoveredInto` 的判据、`p.uncovered` 数据一字未动；
  丢弃块（`diagnostics` 控制的 `.blk-discarded`）不受本开关影响。
- **检测不改写**：无数据清洗。

## 4. 验证

### 4.1 自动化

- `npm run check` **全绿**（typecheck + typecheck:viewer + 760 测试 + 各审计 + bank:all），
  质量门凭证 `tmp/.check-stamp` = `18ab95f55e33bb0e`（2026-11-20 22:14 写入）。
- 新增单测 `④b 解析遗漏标记开关`：`diagnostics:true, uncovered:false` → 0 个 `.uncovered-mark`；
  `diagnostics:true`（不传 uncovered）→ 2 个（内容级+家具级，维持原行为）；
  `diagnostics:false` → 0 个；且两态正文块/号牌几何逐字节相同。
- `npm run view:test`（DOM gate）走 IAB，本机不可用会 SKIP，故另做真实 headless Chrome 截图。

### 4.2 三态截图（独立 headless Chrome，端口 9229，profile `tmp/stages-toggle/chrome`）

截图脚本：`tmp/stages-toggle/cdp-shot.mjs`；产物目录 `tmp/stages-toggle/shots/`。
页面：`/stages/?doc=23必刷题 2相互作用&stage=6&page=0`（第 1 页实测含 4 内容级 / 20 家具级未覆盖）。

| 态 | 截图 | DOM 实测 |
|---|---|---|
| 默认（无参数、无存储） | `01-default-off.png` / `01-default-off-crop.png` | `uncovered-mark=0, legend=0, checked=false, storage=null` |
| URL 开 `?uncovered=1` | `02-url-on.png` / `02-url-on-crop.png` | `uncovered-mark=24(4 内容+20 家具), tag=1, legend=1, checked=true` |
| 勾选开 → 重载保持 | `03a-toggle-on.png` → `03b-reload-persist.png` / `03b-reload-persist-crop.png` | 点击后 `storage="1"`、`checked=true`；**重载（无参数）后仍 24 标记 + 图例 + 勾选** |

- 裁图（ffmpeg）：`*-crop.png`（1000×820，含工具栏开关+双栏+图例）、`02-right-pane.png`（520×680，右栏标记特写）、`02-legend.png`（820×100，图例文案）。
- 已逐张目视：默认态无洋红/无图例/复选框空；开态洋红框+「解析遗漏」标签+灰虚线+底部两行图例、复选框勾选；重载态与开态一致。
- 触屏目标实测：`#uncovered-toggle` 131×44px。

## 5. 已知边界

- 开关只作用于 stages 的**对比**视图；阶段 1/3 的解析遗漏标记仍常显（未在需求范围内）。
- final 成品页的「审计标记」开关（`?audit=1`）是另一套（同时管丢弃块），未改动。
- 截图产物在 `tmp/`（git 忽略），仅本地留证；代码与报告入库。
