# 可验收目标：1:1 渲染内核接入 `final/`

> 建立于 2026-11-16 21:26。依据已定决策：**替代 `final/` 成为正式展示层、只换渲染内核、验收线题级**。

---

## 0. 背景与硬约束（决定了目标能不能设成理想形态）

| 项 | 事实 | 影响 |
|---|---|---|
| `final/` 数据契约 | `/api/docs` 扫 `data/out/<docId>/`，读 `stages.json`，块带 `bbox` | 我们的数据没有 bbox |
| **bbox 单位（P1 更正）** | **bbox 本来就是 pt**（页 595×841 = A4 pt），`renderPaper` 全用百分比定位 | **不存在 px↔pt 转换层**，原 G2-3 作废 |
| 我们的数据 | `data/out-doc/教材基础练-电路/lines.json`，pt 坐标，107 页 27/27 行有 (H,V) | 坐标系不同（pt vs px） |
| 本工作区 `data/out` | **空** | 现有 `final/` 在本工作区无数据可显示 |
| 主仓库快照 | `data/out/23必刷题 1 直线运动/stages.json` 等 | 只能只读引用 |
| 项目红线 | 展示层只消费快照、不 import `src/`；`renderPaper` 是唯一纸面重建实现 | 新增内核必须与其并列、不改其行为 |

**由此，目标不能设成「重写 final 渲染」，只能设成「并列新增 + 自动选择」。**

---

## G1 渲染内核并列（最高优先，其余依赖它）

| 编号 | 判据 | 验证方式 | 通过标准 |
|---|---|---|---|
| G1-1 | 新增 1:1 渲染内核，与 `renderPaper` **并列存在** | 代码结构 + 导出符号 | 两个函数都能被调用，互不替换 |
| G1-2 | 原 `renderPaper` 路径**行为不变** | 与改动前截图比对（同一 doc 同一页） | 像素差异 ≤ 1%，或人工确认无变化 |
| G1-3 | 不改 `src/`、不改 `scripts/` 的既有行为 | `git diff --stat` | `src/` 零改动 |
| G1-4 | `npm run check` 全绿 | 命令 | exit 0 |

## G2 数据适配（让 `final/` 能读 DOCX 复刻数据）

| 编号 | 判据 | 验证方式 | 通过标准 |
|---|---|---|---|
| G2-1 | 新增 doc 来源可被 `/api/docs` 列出 | 启动服务 + 请求 `/api/docs` | 返回中包含该 doc |
| G2-2 | 107 页走绝对定位、108/109 页走固定行高 | 截图 | 107 页行位置与独立版 `1对1复刻.html` 一致（同尺寸偏移 ≤ 3pt） |
| ~~G2-3~~ | ~~坐标换算正确（pt → px）~~ **作废（P1 更正）** | — | `renderPaper` 是比例定位，无转换层 |
| G2-3′ | 数据单位与页宽高**同单位**（都用 pt） | 代码审查 + 渲染 | `p.width/height` 与 `bbox` 同为 pt 即可对齐 |
| G2-4 | 不出现整体缩放错位 | 截图 | 页面无横纵拉伸、无内容溢出容器 |
| **G2-5** | **公式通道打通**（P1 新增） | 截图 C/D 选项 | MathML 必须直通 `html` 或转 LaTeX；**不得被 `prettifyLatex` 转义成字面标签** |
| **G2-6** | **两处硬编码扩展**（P1 新增） | 实测 404/403 | `final.js:2106` 加载分支 + `tag-write-guards.ts:29` 白名单，缺一则 faithful 数据 404、标签写 403 |
| **G2-7** | 字号用**字号盒 19pt**，不得用行距 43.75 | 截图字号比对 | 用行距当高度会得到 2.3 倍字号（P1 实测） |

## G3 标签闭环（这是「替代 final」的实质门槛）

| 编号 | 判据 | 验证方式 | 通过标准 |
|---|---|---|---|
| G3-1 | 题可点选并调 `toggleTag(questionId, tagId, anchor)` | 代码 + 交互 | 点击后状态变化 |
| G3-2 | 刷新后标签仍在（来自 `/api/tags`） | 打标签 → 刷新 → 截图 | 标签仍显示 |
| G3-3 | **禁止 localStorage 兜底**（`tag-store` 注释的明确要求） | 代码审查 | 无 localStorage 写入路径 |
| G3-4 | 服务端不可用时显式报错 | 关服务后操作 | 出现明确错误提示，不静默 |
| G3-5 | 打标签前/后各一张截图 | 截图 | 两张图可见差异 |

## G4 回归与交付

| 编号 | 判据 | 验证方式 | 通过标准 |
|---|---|---|---|
| G4-1 | 三个原有页面（`final/`、`viewer/`、`stages/`）打开不报错 | 控制台 + 截图 | 0 条 uncaught error |
| G4-2 | `1对1复刻.html` 仍可用 | 打开 | 正常渲染 |
| G4-3 | 结论诚实：未做到项标 `false` 并说明 | 交付说明 | 不得用「看着对」代替 |

---

## 4.1 动态调整记录（P1 探查后，2026-11-16 21:30）

| 调整 | 原因 | 依据 |
|---|---|---|
| 删除「pt → px 坐标换算」判据 | `renderPaper` 用 `bbox/p.width` 百分比定位，无转换层；`CANVAS_W=760` 只是 CSS 画布宽 | `stages/reconstruct.js:88-94`、`final/pick-hit.js:4` |
| 新增 G2-5 公式通道 | `prettifyLatex` 会 `escapeHtml`，MathML 会变成字面标签；`renderPaper` 的 text 通道只吃 LaTeX，仅 `kind==='table'` 走 html | 实测转义输出 + `reconstruct.js:280,335` |
| 新增 G2-6 硬编码扩展 | `final.js:2106` 只读 `stages.json`，标签写白名单只认它；不改则 faithful 404、标签 403 | 实测 `/api/docs` 与 `POST /api/tags` 403 |
| 新增 G2-7 字号取 19pt | 用行距 43.75 当 bbox 高度，字号算成 30.9px（正确 13.4px，差 2.3 倍） | 实测截图比对 |
| 明确数据形态 | 新增 `faithful.json`（schema 对齐 `stages.json`），**不往 stages.json 塞假 bbox**（会被 `stages:export` 覆盖），**不写坐标预处理器**（污染引擎契约） | P1 verdict |

## 4.2 动态调整记录（P2/P4 执行后，2026-11-16 22:10）

| 调整 | 原因 | 处置 |
|---|---|---|
| G2-1 加严：**不得依赖手写 `stages.json` 骨架** | P2 为让 `/api/docs` 列出该 doc，塞了 12 行骨架；P4 实测该骨架（`pages: []`）导致 stages 页 `TypeError: reading 'index'`（`stages.js:297`） | **扩展 `view-server.ts:listDocs`**：`stages.json` 或 `faithful.json` 任一存在即列出，并返回 `hasStages` 字段 |
| 新增 G2-8 | `listDocs` 是第 **3** 处硬编码（前两处：`final.js:2106`、`tag-write-guards.ts:29`） | 判据：无 `stages.json` 时 `/api/docs` 仍列出该 doc，且 `hasStages=false` |
| G4-2 复验口径 | 骨架删除后需重验 | 三页 HTTP 200、`stages/` DOM 正常、控制台无 JS 异常 |

**修复后实测（P4 复验）**：

- 删掉骨架 `stages.json` 后，`GET /api/docs` 仍返回 `{"id":"教材基础练-电路","hasStages":false}`；
- `GET /data/out/教材基础练-电路/faithful.json` → 200；`/final/?doc=…` → 200；
- 成品页正常渲染：文档选择器、`1/3` 页码、题号牌 1/2/3/4、C/D 真分式、知识区虚线占位；
- `stages/`、`viewer/`、`final/` 三页均 200，`stages/` 控制台无 JS 异常（仅 Chrome 自身 CVDisplayLink 噪音）。

## 5. 动态调整条款（用户要求：目标不合理就改）

以下三条是预先允许的调整，触发时必须**记录调整原因**，不许静默降级：

1. **若 `stages.json` 契约无法承载 pt 坐标** ⇒ 允许新增独立快照 `faithful.json`，但 `renderPaper` 原路径必须保持不变（G1-2 不放松）。
2. **若本工作区无 `data/out` 数据导致 G2 无法验证** ⇒ 允许从主仓库**只读**软链或复制单个 doc 目录，并在交付中注明"数据来自主仓库快照"。
3. **若某个判据在本环境不可执行**（如无 `/api/tags` 服务）⇒ 该条标 `false` + 写明缺什么，**不得**用静态检查冒充运行验证。

---

## 6. 非目标（本期不做）

- 不改 `final/` 的工具栏、标签面板、搜索逻辑（决策：只换渲染内核）；
- 不补知识梳理表（已定为虚线占位，见 `2026-11-16-quark-format-todo.md`）；
- 不做手机端文本流（`flowPaper`）与 1:1 内核的适配 —— 留待下一期；
- 不扩量到其他册。

## 4.3 G1-4 补验：pnpm 迁移（2026-11-16 22:25）

**原判据 G1-4 `npm run check` exit=127（无 `node_modules`）→ 现已全绿（exit=0）。**

### 为什么迁 pnpm

| 项 | 实测 |
|---|---|
| 依赖规模 | 6 个 devDependencies，node_modules 47MB |
| worktree 数 | 6 个，其中 2 个装了依赖（94MB） |
| pnpm 安装耗时 | **1.1–1.3 秒**（`CI=true pnpm install`） |
| npm 安装耗时 | 数十秒级 |
| 磁盘 | 可用 35GB / 228GB（83% 已用）⇒ 省空间非伪需求 |

**主收益不是省那 200MB，而是：每个新 worktree 秒级拥有依赖** —— 直接消除「check 跑不起来」这个反复出现的阻塞。

### 处理过程（含一个危险陷阱）

1. `pnpm import` 在本项目无输出、不生成 lockfile；改用 `pnpm install --lockfile-only` 成功（757ms）。
2. **危险**：直接 `pnpm install` 提示要删除并重装 **`/Users/john/node_modules`（599MB，用户主目录）**。
   根因：`/Users/john/pnpm-workspace.yaml`（创建于 2026-11-16 21:37）使主目录成为 workspace 根，
   本项目在其子树下，pnpm 向上继承。该文件当前内容只有 `allowBuilds`（5 个 AI 相关包），无 `packages` 字段。
   **处置**：未执行该提示；用 `--ignore-workspace` 完成安装；随后 pnpm 在本项目自动生成了
   `pnpm-workspace.yaml`，它把项目变成最近的 workspace 根，`pnpm root -w` 已指向项目自身，继承被阻断。
   **主目录文件未做任何修改**（属个人文件，需用户自行决定是否清理）。
3. `allowBuilds` 的占位值 `set this to true or false` 会触发交互确认（沙箱内 SIGTERM）；
   改为 `esbuild: true` + `CI=true` 后无交互，构建脚本正常执行。

### 固化改动

- `package.json` +`packageManager: pnpm@11.1.0`
- `pnpm-lock.yaml`（17.8KB，由 `pnpm install --lockfile-only` 生成）
- `pnpm-workspace.yaml`（`allowBuilds: esbuild: true`，兼作 workspace 隔离）
- 保留 `package-lock.json` 未删（降低回滚成本；两者并存不影响 pnpm）

### 最终验证（实测）

| 步骤 | 结果 |
|---|---|
| `CI=true pnpm install` | exit 0，1.1s，esbuild postinstall 正常 |
| `npm run check` | **exit 0 全绿**；605 例 600 pass / 0 fail / 5 skipped；stamp `30cc8b7992bcd4c7` |
| 主目录 `node_modules` | 时间戳/大小未变（21:37 / 599MB） |
| 原 `renderPaper` 路径 | 与改动前像素差 0.0000%（G1-2 复验有效） |

## 4.4 收尾：主目录 workspace 撤销 + 基线夹具命令（2026-11-16 22:35）

### 主目录 workspace 文件：已撤销（经用户授权「不合适就撤销」）

- 文件：`/Users/john/pnpm-workspace.yaml`，21:37 由用户在终端直接跑 `pnpm install` 时生成，
  内容全是未填写占位符 `set this to true or false`（5 个包），**不是有效配置**。
- 风险确认：它使 `/Users/john` 成为 workspace 根，子树项目 `pnpm install` 会被吸到主目录；
  实测曾提示「删除并重装 /Users/john/node_modules（599MB）」。
- 处置（遵守个人文件安全）：先备份到 `tmp/backup/pnpm-workspace.home.yaml`（SHA-1 校验一致），
  再用 macOS `/usr/bin/trash` 送废纸篓，**未直接删除**。
- 复核：主目录 workspace 已不存在；`node_modules/jsdom`、`@deepseek-ai/dsh` 完好；项目 check 仍 exit 0。

### 基线夹具命令：`pnpm run fixtures:baseline`

- 脚本：`scripts/fixtures-baseline.mjs`；`package.json` 新增 script（紧跟 check）。
- 设计（第一性原理）：`data/out` 是 gitignore 快照，**不能进 git**；新 worktree 必须从已有快照复制。
  源**不硬编码路径** —— 走 `git worktree list --porcelain` 自动发现，也可 `FIXTURE_SOURCE=<path>` 显式指定。
- 范围：从 `scripts/audit-render-all.mjs` 正则提取 `BASELINE_DOCS`（避免两处硬编码漂移），
  再从 `bank-bindings.json` 取 quiz/answer 并集 → 8 卷 × 3 文件（`stages.json`/`questions.json`/`meta.json`），共 12MB。
- 实测：
  - 干净克隆目录（无 `data/out`）首次运行 → 复制 24 个文件、落盘 8 卷 12MB；
  - 再跑一次 → 复制 0、跳过 24（幂等）；
  - 本工作区再跑 → 复制 0、跳过 24（幂等）；
  - 随后 `npm run check` exit 0，605 例 600 pass / 0 fail / 5 skipped。
- 过程中修了 3 个真 bug：`FIXTURE_SOURCE` 被 `candidates.length` 提前返回挡住；
  macOS `/tmp` → `/private/tmp` 软链导致路径比较失效；占位符 `allowBuilds` 触发交互确认（改 `esbuild: true` + `CI=true`）。
