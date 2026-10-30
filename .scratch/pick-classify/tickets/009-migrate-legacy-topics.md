# 009 旧数据迁移：专题名#层级 / .topic.json → 三套清单

**Blocked by**: 007

## 目标
把历史 `专题名#层级` 标签与 `*.topic.json` 手工题单迁移为「专题清单 + 类别清单 + 归属」；
默认 dry-run，写盘前备份，重复执行幂等。迁移后业务标签库不再含专题字符串，
专题页仍能显示原演示题。

## 涉及层
- [ ] 数据层：读取 `data/out/tags/*`、`data/out/topics/*.topic.json`；
  写 `data/out/teach/*`；备份到 `data/archive/<date>-teach-migration/`
- [ ] 逻辑层：`scripts/migrate-teach.ts`：解析 `专题名#类别`、建/复用清单、生成归属
  （带 anchor）、从业务标签库摘除已迁移项、报告每条去向
- [ ] UI层：不新增；迁移后专题页/角标应显示迁移结果
- [ ] 测试：dry-run 不写盘、幂等、备份存在、迁移后 `topic:export` + `audit:topic` 绿；
  旧 `23必刷题 4 曲线运动` 种子（平抛运动/圆周运动 + 基础/培优）正确拆分

## 验收标准
- `node --import tsx scripts/migrate-teach.ts --dry-run`：只打印计划（会建哪些专题/类别、
  影响哪些题），不写任何文件
- 正式执行：备份存在；生成 topics/categories/bindings；旧 `专题名#层级` 标签从
  `data/out/tags/library.json` 与绑定中移除；业务标签（好题/待改/已校对）保留
- 迁移后：q16 属于「平抛运动 + 基础」，q31「圆周运动 + 培优」，q58「圆周运动 + 基础」；
  专题页与角标正确；`npm run topic:export` + `npm run audit:topic` 绿
- 再执行一次：报告「已迁移，无变化」，不产生重复清单/重复归属
- `npm run check` 全绿
