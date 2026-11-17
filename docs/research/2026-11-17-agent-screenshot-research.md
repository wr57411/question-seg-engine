# Agent 截图能力调研（2026-11-17）

背景：用户对当前截图验收仍不满意，要求调研社区成熟方案。
本机已有 skill：`screenshot-evidence`（裁图纪律 R1-R5），缺「确定性截图管线」与「自动验证闭环」。

## 一、社区成熟项目（按可用性排序）

### 1. petrkindlmann/qa-skills → visual-testing（★275，1526 装机）
- 核心：Playwright `toHaveScreenshot` 视觉回归 + **确定性截图四件套**：
  - `page.clock.setFixedTime` 冻结时间、`page.route` 打桩 API
  - `maxDiffPixelRatio` 全局阈值 0.005，logo/图标区 `maxDiffPixels: 0`
  - mask 动态内容（时间戳/头像/广告）
  - 基线图按平台打标，生成环境与 CI 用同一 Docker 镜像
- 对我们的启示：**截图前先消灭不确定性来源**（字体加载、动画、时间、异步内容）。

### 2. Yeachan-Heo/oh-my-claudecode → visual-verdict（★40.8k，975 装机）
- 核心：VLM 对「生成截图 vs 参考图」打分，输出**严格 JSON 判决**（score/verdict/differences/suggestions），
  阈值 90 分；**像素 diff 只做热点定位辅助，不做裁决**。
- 关键设计：`differences[]` 必须是具体可视差异、`suggestions[]` 必须绑定下一步修改——
  防止"看起来差不多"式的模糊通过。
- 对我们的启示：**裁决与定位分层**——人看/VLM 判合格，像素 diff 负责指出哪里不同。

### 3. Devin-AXIS/iPolloWork → agent-first-screenshots
- 核心：**三通道验证闭环**，每帧必须全过才算成品：
  1. DOM 预检（截图前）：滚动区高度>100（未塌陷）、目标文字在视口 rect 内、无意外浮层；
  2. 像素后检（截图后）：解 PNG 采样 DOM 推导的 rect——**方差是可靠信号**（内容区方差>200），
     背景占比不可靠（85-92% 白底是正常的）；
  3. 视觉终检：VLM 看成图。
- 金律：每张截图从干净 reload 开始；只隐藏叶子干扰物、绝不注入/改结构 CSS；
  改 viewport 后等 ~1s 再验（会触发重排）。
- 对我们的启示：**`innerText 存在 ≠ 可见；DOM rect 健康 ≠ 渲染成功`**——
  这正是我们踩过的"占位文字 vs 真图"坑。

### 4. joel611/skills → visual-evidence
- 核心纪律：等待用选择器不用固定 sleep；**每张截图必须亲眼看一遍**（非空文件≠有效）；
  视频用 ffmpeg tile 抽帧拼图检查；before/after 必须同 viewport 同数据同步骤。
- 产物进 temp 目录、绝不进仓库。

### 5. liaohch3/claude-tap → screenshot-validation
- 核心：**截图质量门**（提交前自动跑）：尺寸下限、空白图检测（>90% 白/透明=fail）、
  viewer HTML 用 headless Chromium 实测渲染（JS 错误=fail）。

### 6. 官方工具链对比
| 工具 | 形态 | 适用 |
|---|---|---|
| Playwright MCP | MCP | 跨浏览器、结构化快照驱动交互 |
| **Playwright CLI + skills**（`playwright-cli install --skills`） | CLI+SKILL.md | **编码 agent 首选**——微软自己说 MCP 工具 schema 和快照费上下文，CLI 省 token |
| Chrome DevTools MCP | MCP | 性能 trace/Lighthouse/console，live Chrome |
| agent-browser | CLI+skill | 证据包工作流（每验收标准一张图、CI 门禁） |

## 二、我们工作流的改进点（对照差距）

| # | 现状 | 社区做法 | 改进 |
|---|---|---|---|
| 1 | CDP 手搓截图，`sleep` 固定等待 | 等选择器/等状态，不等固定时间 | 截图前等 `#main .canvas` 内 img 全 complete |
| 2 | 字体加载无确认 | 冻结不确定源 | `document.fonts.ready` 后再截 |
| 3 | 每次会话渲染状态漂移（昨天裁图对不上 DOM rect 就是一例） | 一次会话内完成「量 rect→立刻截」 | 截图与测量同会话原子化，禁止跨会话拼证据 |
| 4 | 空白/占位图靠肉眼 | 像素方差门（内容区方差>200） | `check_screenshots` 式空白检测进 accept.mjs |
| 5 | 裁图纪律有（R1-R5），验证闭环没有 | DOM 预检→像素后检→视觉终检 | 三通道写进 skill |
| 6 | 基准来源混乱（PDF 页图冒充 DOC 渲染） | 基线必须与被测物**同源同生成器** | DOC 基准=LibreOffice 渲染 DOCX→PDF→页图（已装） |

## 三、裁决原则（visual-verdict 的启发）

1. **结构对账（文本/公式/图 rid/答案）是裁决**——机器对机器，0 容差；
2. **像素 diff 是定位**——指出哪里不同、差多少，不直接判合格/不合格；
3. **VLM/人看终检**——对热点区做中性描述式核对（不用预设问句，遵守 R4）。

## 四、本项目的落地方案

1. `tmp/doc-diff/`：DOCX →（LibreOffice headless）→ PDF → 页图 → 与成品页对齐 diff。
   注意 LibreOffice ≠ Word 渲染（字体/公式可能有差异），作为基准要先声明这一点。
2. 升级 `screenshot-evidence` skill：补 R6（确定性截图：等选择器+fonts.ready+同会话原子操作）
   与 R7（三通道验证：DOM 预检/像素后检/视觉终检）。
3. accept.mjs 加空白检测与方差门。
