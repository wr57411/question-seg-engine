# Task 3 报告：截图采集器 + Review 入口 + 引导版面异常修复

- 日期：2026-08-22
- Task：`2026-08-22-viewer-fixes-a-group` 的 Task 3（计划核心）
- 状态：**A + B 已完成**；C（版面异常修复）待 controller 截图审视清单

---

## A. 脚本

### `scripts/view-cap.mjs`（截图采集器）

按状态循环打开 viewer 并截图落盘 `docs/design/viewer-cap/<name>.png`，逐状态打印捕获路径。

```bash
# 全状态（默认：complete,truncated,filter,answer,needs,empty）
node scripts/view-cap.mjs
# 或指定状态子集
node scripts/view-cap.mjs --states=complete,truncated,filter
# 等价 npm script（需先起 server）
npm run view &
npm run view:cap
# 指定端口（若 4173 被占）
PORT=4174 npm run view:cap
```

各状态的打开策略（交互态用 `tab.playwright.evaluate` 触发 DOM `.click()`，等效真实点击）：

| 状态 | URL / 交互 | 注视点 |
|------|-----------|--------|
| `complete` | 默认卷 `?doc=23必刷题 2相互作用` 无交互 | 卡片流/目录/统计 |
| `truncated` | `?doc=23必刷题`（缺空格→数据不存在→回退默认卷+提示） | 回退提示是否正确 |
| `filter` | 默认卷 + 点击 `[data-filter="subjective"]` | 筛选高亮 + 主观题流 |
| `answer` | 默认卷 + 点击 `#toggle-answers` | 印章式答案块全局展开 |
| `needs` | 默认卷 + 点击 `#review-btn` | **Review 质检队列视图** |
| `empty` | `?doc=不存在卷` → 回退默认卷（非真空态） | 回退与空态提示 |

脚本结尾对每个捕获路径 `console.log('captured <state> -> <path>')`，供 controller 直接 Read。

> 依赖 IAB 浏览器全局 `agent.browsers.get("iab")`；未接入 IAB 的环境会抛 `CAP ERROR` 退出码 1（截图阶段交由 controller 执行）。

### `scripts/browser-gate.mjs`（DOM 存在性 Gate，辅助）

```bash
npm run view:test        # node scripts/browser-gate.mjs
node scripts/browser-gate.mjs --doc=23必刷题
```

断言：卡片 >0、`#stat-total` ≥80、`#filters`、`#toggle-answers`、`#review-btn` 存在且 `review === total - ok`。IAB 不可用时 `GATE SKIP` 退出码 0（不阻塞 `npm test` 离线约束）。

---

## B. Review 入口（用户问题核心）

### `viewer/index.html`

- `masthead-right` 内新增 `.masthead-actions` 容器，含：
  - **`#review-btn`**：`Review (N)` 按钮，带 `i-alert` icon，`aria-pressed` 表达视图态，`#review-btn-label` 承载计数。
  - 原 `#filters` 筛选组（挪入同一 action 容器）。
- `#paper`（卡片流）之前新增 `<section id="review" class="review-queue" hidden>` 质检队列容器。

### `viewer/viewer.js`

- `state.reviewMode`（默认 false）。
- `updateStats()` → `#stat-review` 同步后，把 count 写入 `#review-btn-label`（`Review (N)`），并按 N==0 切换 `is-empty` 类、更新 `aria-pressed`。
- `showReview()`：置 `reviewMode=true`，渲染质检队列，隐藏 `#paper`、显示 `#review`，`body.classList.add("review-mode")`，按钮加 `is-active`。
- `showOverview()`：反向恢复（显示 `#paper`、隐藏 `#review`、移除 `review-mode`）。
- `renderReviewQueue()`：列全部 `status==="needs_review"` 题；每项含题号 `Q-n`、`Conf nn%`、红色错误标签、`进入单题` 按钮；空队列渲染"All questions reviewed." + 返回总览。
- `goToQuestion(q)`：回到总览 → `scrollIntoView` 到目标题卡 → 临时 `.review-highlight` 高亮。
- `reviewError(q)`：泛化错误摘要（`SUBJECTIVE FLAG` / `LOW CONFIDENCE` / `ANOMALY DETECTED`），可用数据里的 `review_note`/`error` 覆盖。
- 事件：`#review-btn` click → `reviewMode ? showOverview() : showReview()`。

### `viewer/viewer.css`

- `.masthead-actions`、`.review-btn`（朱砂实心 / `.is-empty` 灰描边 / `.is-active` 墨黑）、`.review-queue`、`.review-head/.review-title/.review-count/.review-desc`、`.review-item`（`.review-id/.review-conf/.review-err/.review-go/.review-stem`）、`.review-empty`、`.card.review-highlight`。
- 移动端（≤900px）：`.masthead-actions { flex-wrap: wrap; }`；print 隐藏 `.review-btn`。

---

## C. 待处理（等 controller 截图审视清单）

**未做：** 版面异常修复（截图采集器/Review 入口的视觉效果是否合格）。本任务按 brief 约定"实现者先完成 A+B，等 controller 截图审视"，controller 会：
1. 起 server：`npm run view &`
2. `node scripts/view-cap.mjs` 生成 `docs/design/viewer-cap/*.png`
3. 逐屏 Read 审视版面（重叠/错位/间距/溢出/字体/图片/印章/目录）
4. 将发现的异常清单发回 → 我再逐个修复 `viewer.css/js/html`

---

## 验证

- `npm run check`（typecheck + 全量 test）：**50/50 通过**，typecheck 0 错误。
- `node --check` 三份 JS：viewer.js / view-cap.mjs / browser-gate.mjs 均无语法错误。
- `view-server` 冒烟：启动日志打印完整编码 URL；`/viewer/` 含 `#review-btn`；`/data/out/.../questions.json` 返回 85 题正常。

## Commit

见 git log（`feat: viewer P3 review queue + screenshot capture + DOM gate`）。
