# AGENTS.md — 给所有编程 Agent 的入口

本仓库是 **question-seg-engine**：MinerU 解析结果的后处理层（试卷 → 结构化题目 JSON），
TypeScript ESM + node:test，零运行时依赖。

## 必读顺序（按序读，不要跳）

1. `docs/HANDOFF.md` —— 当前状态、未闭合风险、红线、前 30 分钟指引。**这是主入口。**
2. `README.md` —— 架构总览与核心机制。
3. `tasks/lessons.md` —— 3 条工程纪律（各有真实事故佐证）。
4. 需要口径/阈值依据时再查 `docs/DECISIONS.md` 对应章节（顶部有索引，共 93 条）。

## 不可违反的红线（完整版见 HANDOFF.md §5）

- **不静默失败、不丢内容**：丢弃/搬迁/改写任何内容前，先回原卷页图核对；拿不准就标 `needs_review`。
- **检测不改写**：统计工具不改数据；数据清洗须显式独立决策。
- **解耦**：`viewer/`、`stages/`、`final/` 只消费快照 JSON，不 import 引擎 `src/`。
- **纸面重建只此一处实现**：`stages/reconstruct.js` 的 `renderPaper` —— 成品页（`final/`）
  与 stages 的「成品/对比」共用它。「成品跟对比那个一样」是**结构保证**，不是两处各写一遍。
- **判据与实现不同源**；覆盖率的分母必须来自被检验对象之外的独立来源（原卷/OCR）。
- **`0` 永远不是题号**；启发式「搬迁/丢弃」规则判据取最严（AND）+ 同页守卫 + 可核对记录。
- **展示层是浏览器直接加载的 `.js`（无构建步骤）**：新增**纯逻辑**模块一律文件头 `// @ts-check`
  + JSDoc 自带类型，**不要再手写 `.d.ts`**（`.d.ts` 会遮蔽实现、tsc 从不校验一致性，已实测说谎过）。
  仍以手写 `.d.ts` 存在的模块由 `tests/dts-drift.test.ts` 锁名字集合（见 DECISIONS §31）。
- **判遮挡用墨迹口径**：DOM 矩形高 ≈1.4em 是字体盒不是墨迹，先收到 `font-size` 再判（见 HANDOFF §5-9）。

## 动手前的硬性条件

```bash
npm install && npm run check   # 必须全绿；不绿先修门，勿带病开发
```

- 声称「完成」的条件：`npm run check` 全绿 +（显示层改动）全量逐页截图审板过。
  「后台数字达标」≠「页面上看得见」≠「没被 overflow:hidden 裁掉」。
- 产物目录：`data/` 为运行时产物、git 忽略；`docs/` 是文档家；历史决策只增不改写
  （新决策追加新 §，不删旧记录）。
