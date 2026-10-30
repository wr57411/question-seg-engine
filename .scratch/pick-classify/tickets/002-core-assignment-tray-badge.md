# 002 核心归类：专题/类别两行 + 点 chip 立即写 + N·M 角标

**Blocked by**: 000, 001

## 目标
在开发种子下跑通完整一遍：点一道题 → 点专题/类别 chip → 立即保存 → 刷新不丢 →
题号牌显示 `N·M`。托盘两行；最近用过的排最前（本机 localStorage）。这是第一个
真正可用的挑题闭环。

## 涉及层
- [ ] 数据层：`data/out/teach/{topics.json,categories.json,bindings/<doc>.json}`；
  开发种子放 `fixtures/teach-seed/`（复制到 `data/out/teach/`，不覆盖已有文件）
- [ ] 逻辑层：`final/teach-store.js`（`normalizeTeach` / `toggleTopic` / `toggleCategory` /
  `assignmentFor` / `badgeCounts` / `recentOrder`）；优化写入串行队列，失败回滚
- [ ] 纸面：`renderPaper` 新增 `assignmentBadge` 与 `dimBadges` 选项，只在 q-chip 内加角标
- [ ] UI层：托盘两行 chips、当前项高亮、点击即写、错误提示；`N·M` 角标
- [ ] 测试：`tests/teach-store.test.ts`、`tests/teach-write-guards.test.ts` 复用、
  `tests/layout-invariant.test.ts`（角标不改几何）、iPad 截图

## 验收标准
- 种子：题 q16 归入「平抛运动 + 基础」后，刷新页面角标为 `1·1`；再点一次摘掉，角标消失
- 一题可同时 2 个专题 + 2 个类别，角标 `2·2`；两行 chips 的已选项实心高亮
- 快速连点不会乱序：后一次写入不会覆盖前一次（串行化）；写入失败 UI 回到写前状态并显示错误
- 最近归类的专题/类别排到各自行最前（刷新后仍保持；本机 localStorage，不写服务端）
- 角标不改变纸面几何：开/关角标、阅读/挑题模式，页高与留白宽度逐字节相同
- `npm run check` 全绿；iPad 820×1100 截图：两行托盘 + `2·2` 角标
