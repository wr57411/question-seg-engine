# 007 导出 v2 + 专题页类别单选

**Blocked by**: 002

## 目标
打通「挑题归类 → 专题页看见」：`topic:export` 读专题/类别/归属，输出 v2 index；
专题页按类别单选筛选；`audit:topic` 独立复核 v2 数据。做完后 q16 归入「平抛运动 + 基础」，
专题页切到「基础」能看见它。

## 涉及层
- [ ] 数据层：`data/out/teach/{topics,categories,bindings}` 作为输入；输出
  `data/out/topics/index.json` v2（`categories[]` 取代 `level`）
- [ ] 逻辑层：`scripts/topic-export.ts` v2 合并、类别计数、答案/图片/复核标记沿用 S01；
  `scripts/audit-topic.ts` 独立重读并核对清单、归属、类别 stats
- [ ] UI层：`topic/topic-model.js` / `topic/topic.js` 类别单选筛选与类别 chips
- [ ] 测试：导出/审计 fixture + 反向验证（缺专题/缺类别/重复归属/断链/类别计数说谎/
  stale/弱 anchor/整专题消失）；iPad 截图

## 验收标准
- q16 归「平抛运动 + 基础」后 `npm run topic:export`：生成 v2 index，条目含
  `categories:[{id,name:"基础"}]`，不再有 `level`
- 专题页：专题「平抛运动」→ 全部能看到 q16；切「基础」仍能看到；切「培优」看不到
- 一题挂「基础 + 易错」：在两个类别筛选项下都出现；类别计数正确
- `npm run audit:topic` 绿；构造缺类别/重复归属/类别计数说谎/整专题消失 ⇒ 审计或导出必红
- `export-status.json` 成功/失败都写；页面旧数据/告警提示沿用 S01
- `npm run check` 全绿；截图：全部 / 基础 / 待复核
