# 000 预重构：教学写通道（/api/teach + 守卫）

**Blocked by**: 无

## 目标
先把「专题 / 类别 / 归属」的安全写盘通道做好：浏览器能通过 `POST /api/teach` 写入
`data/out/teach/`，非法 scope / doc / 路径 / 形状被拒绝；现有 `/api/tags` 行为不变。
做完可以用 curl 演示，不需要 UI。

## 涉及层
- [ ] 数据层：`data/out/teach/{topics.json,categories.json,bindings/<doc>.json}`，临时文件 + rename 原子写
- [ ] 逻辑层：`scripts/teach-write-guards.ts`（scope / doc 白名单 / 路径断言 / 形状校验 / 2MB 上限）
- [ ] UI层：不涉及（`/api/tags` 不动）
- [ ] 测试：`tests/teach-write-guards.test.ts` + view-server 路由测试

## 验收标准
- `POST /api/teach?scope=topics|categories` 接受合法载荷并原子落盘；
  `scope=bindings` 必须带 `doc`，且 doc 在 `data/out/<doc>/stages.json` 白名单内
- 路径穿越、非法 scope、缺 doc、非 JSON、超 2MB、形状不对 ⇒ 4xx，**不写任何文件**
- 现有 `/api/tags` 的测试全绿，行为与提交前一致
- `npm run check` 全绿
