# BGX 开发治理资料索引

- 更新时间：2026-10-31T08:50:00+08:00
- 技能版本：bgx 2.2.0
- 项目：question-seg-engine（主入口仍是 [`docs/HANDOFF.md`](../../HANDOFF.md)，本索引只是 bgx 产物的从属导航）

## 本次主题：交接文档漂移与工作线分叉（2026-10-30）

- 状态：**A+B+C+D 全部完成**（T01–T06 已实施并验证；详见下方台账）。
- [REPORT-20261030-01 交接文档漂移与工作线分叉体检](20261030T224104+0800-REPORT-交接文档漂移与工作线分叉体检.md)
  —— G01 主入口指向非当前工作线 / G02「main 已快进」与事实相反 / G03 三条线均未推送 /
  G04 AGENTS 计数过期 / G05 快照与当前值无出口。
- [PLAN-20261030-01 交接文档治理与 Step 8 推进](20261030T224104+0800-PLAN-交接文档治理与Step8.md)
  —— T01–T06；推荐 A（+B）→ D，C 单独授权。

## 合并预演（2026-10-31，只读）

三条线拓扑、9 个冲突文件与逐文件处置原则、3 个必须人判的语义点（`check` 超集 / `READ_ONLY` 覆盖 teach 写入口 /
渲染路径叠加）、推荐用独立 worktree 合并 —— 全部写在
[`docs/plans/2026-10-30-pick-classify-workflow.md`](../../plans/2026-10-30-pick-classify-workflow.md)
「交接 3 补记 4」。本索引不复制正文。

## 与项目既有计划的关系

- 功能线真相仍是 [`docs/plans/2026-10-30-pick-classify-workflow.md`](../../plans/2026-10-30-pick-classify-workflow.md)
  （含「交接 2」）。本索引的 T06 = 该计划「交接 2」第 4 条，**不另立第二份实施真相**。
- 基线记录：「交接 2」第 1–3 条已完成，提交 `5c6b32e`，`npm run check` EXIT=0 / 340 例（2026-10-30 实跑）。

## 下一步

本主题已收口。功能线下一步（Step 9 阅读回显起）见
  [`docs/plans/2026-10-30-pick-classify-workflow.md`](../../plans/2026-10-30-pick-classify-workflow.md)「交接 3」。
