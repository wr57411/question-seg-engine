---
intent: 在成品页实现 iPad 挑题与归类（专题 / 类别 / 业务标签三套独立清单），完成导出 v2、旧数据迁移与 iPad 验收。
success_criteria: 000-011 工单全部完成（011 = 自定义常用组合）；npm run check 全绿；topic:export/audit:topic v2 绿；迁移 dry-run/备份/幂等通过且 0 条归属丢失；纸面几何不变量全绿；iPad 820×1100 截图审板 ≥8 张且内容齐全；真机 Safari 人工验收记录在案；每步绿后在 feat/pick-classify 有检查点提交；全部完成后合回 main（不推送）。
risk_level: high
auto_approve: true
branch: feat/pick-classify
worktree: false
dirty_worktree: allow
---

## Steps

- [x] **Step 1: 教学写通道（ticket 000）**
action: 新增 `scripts/teach-write-guards.ts`（scope=topics|categories|bindings、doc 白名单、路径断言、形状校验、2MB 上限）；在 `scripts/view-server.ts` 增加 `POST /api/teach`，原子写 `data/out/teach/{topics.json,categories.json,bindings/<doc>.json}`；新增 `tests/teach-write-guards.test.ts` 覆盖非法 scope/doc/路径/形状/超限；现有 `/api/tags` 行为不变。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/teach-write-guards.test.ts tests/tag-write-guards.test.ts

- [x] **Step 2: 挑题模式 + 整题命中 + 高亮（ticket 001）**
action: 新增 `final/pick-hit.js` 纯函数 `pickQuestionAt`；`final/final.js` 增加顶部「挑题」开关、pointer 移动 >10px 判滚动、点块/6pt 容差选中、`.blk[data-bi]` 高亮；`final/final.css` 加托盘空壳；选中态只加 outline/box-shadow，不改 bbox/页高/字号/留白；新增 `tests/pick-hit.test.ts`，扩展 `tests/layout-invariant.test.ts`。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/pick-hit.test.ts tests/layout-invariant.test.ts

- [x] **Step 3: 核心归类：两行 + 立即写 + N·M 角标（ticket 002）**
action: 新增 `final/teach-store.js`（normalize/toggleTopic/toggleCategory/assignmentFor/badgeCounts/recentOrder）与 `fixtures/teach-seed/` 开发种子，并复制到 `data/out/teach/`（不覆盖已有文件）；`final.js` 托盘专题/类别两行、点 chip 立即 `POST /api/teach?scope=bindings`、串行写与失败回滚；`stages/reconstruct.js` 增加 `assignmentBadge`/`dimBadges` 选项，只在 q-chip 内加角标；新增 `tests/teach-store.test.ts`，扩展 layout invariant。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/teach-store.test.ts tests/teach-write-guards.test.ts tests/layout-invariant.test.ts

- [x] **Step 4: 内联新建专题/类别（ticket 003）**
action: `teach-store` 增加 `createTopic`/`createCategory`（服务端生成 id、name 去空格后唯一、重名复用）；`final.js` 两行行尾「＋」、单字段输入、`建好并打上`、创建后滚动到新 chip 并高亮；用 `visualViewport`/CSS 变量抬升托盘避开 iPad 键盘；补 `tests/teach-store.test.ts`。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/teach-store.test.ts

- [x] **Step 5: 同上题 + 撤销 + 写失败回滚（ticket 004）**
> 2026-10-30 追加（用户）：自定义常用组合（ticket 011）已实现——托盘标题栏「组合」浮层、
  用户命名、套用替换当前题归属、复用撤销；测试在 `tmp/pick-test-app` 独立数据副本上跑。
action: `teach-store` 增加 `sameAsPrevious`（替换语义）、动作快照与 `undoLast`；`final.js` 增加「同上题」按钮（无上一题/当前就是上一题时禁用）、5 秒撤销条、错误提示条；写入失败时 chip 与角标恢复写前状态；补 `tests/teach-store.test.ts` 与失败注入。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/teach-store.test.ts

- [ ] **Step 6: 托盘搜索（ticket 005）**
action: `teach-store` 增加 `filterTeach` 纯函数（忽略大小写/首尾空格）；`final.js` 托盘搜索框同时过滤专题/类别，无结果时显示「新建专题/类别『关键词』」，点结果直接归给当前题；补 `tests/teach-store.test.ts`。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/teach-store.test.ts

- [ ] **Step 7: 管理改名 / 删除（ticket 006）**
action: `teach-store` 增加 `renameTopic`/`renameCategory`（名称唯一）、`affectedCount`、`deleteTopic`/`deleteCategory`（级联 bindings + stale）；`final.js` 管理面板两栏列表、使用题数、改名输入、删除两步确认；补 `tests/teach-store.test.ts`。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/teach-store.test.ts

- [ ] **Step 8: 导出 v2 + 专题页类别单选（ticket 007）**
action: 改 `scripts/topic-export.ts` 读 `data/out/teach/*` 输出 v2 index（`categories[]` 取代 `level`）；`scripts/audit-topic.ts` 独立复核清单/归属/类别 stats；`topic/topic-model.js` 与 `topic/topic.js` 改为类别单选筛选与类别 chips；补导出/审计 fixture 与反向验证。
loop: until tests pass
max_iterations: 3
verify: npm run topic:export && npm run audit:topic && node --import tsx --test tests/topic-export.test.ts tests/audit-topic.test.ts

- [ ] **Step 9: 阅读模式回显（ticket 008）**
action: 阅读模式角标透明度约 0.55；`final.js` 详情面板增加只读「教学归类」区（专题 + 类别 chips）与「去挑题修改」按钮（进入挑题并选中该题）；业务标签区保持原样；扩展 `tests/layout-invariant.test.ts` 锁淡显不改几何。
loop: until tests pass
max_iterations: 3
verify: node --import tsx --test tests/layout-invariant.test.ts

- [ ] **Step 10: 旧数据迁移 dry-run（ticket 009a）**
action: 新增 `scripts/migrate-teach.ts`，默认 dry-run：解析 `data/out/tags/*` 的 `专题名#层级` 与 `data/out/topics/*.topic.json`，打印将创建的专题/类别、影响的题、将摘除的标签；不写任何文件；报告 0 条归属丢失；同时在报告里列出备份目标路径。
loop: false
verify: node --import tsx scripts/migrate-teach.ts --dry-run
gate: human

- [ ] **Step 11: 旧数据迁移写盘 + 幂等（ticket 009b）**
action: 执行 `node --import tsx scripts/migrate-teach.ts --write`：先备份 `data/out/tags`、`data/out/topics` 到 `data/archive/<date>-teach-migration/`，再写 `data/out/teach/*`、从业务标签库摘除已迁移项；随后跑 `topic:export` + `audit:topic`；再跑一次 `--dry-run` 必须报“已迁移，无变化”。
loop: false
verify:
  - type: shell
    command: node --import tsx scripts/migrate-teach.ts --write && npm run topic:export && npm run audit:topic && node --import tsx scripts/migrate-teach.ts --dry-run
  - type: artifact
    path: data/out/teach/topics.json
    assert:
      kind: exists
  - type: artifact
    path: data/out/teach/categories.json
    assert:
      kind: exists
  - type: artifact
    path: data/out/teach/bindings
    assert:
      kind: matches-glob
      value: "*.json"

- [ ] **Step 12: iPad 截图审板（ticket 010a）**
action: 扩展现有截图脚本（或新增 `scripts/pick-shots.mjs`）覆盖：挑题开/关、选中高亮、两行托盘、N·M 角标、新建输入、同上题、撤销条、管理列表、删除确认、阅读模式详情、专题页类别筛选；820×1100，落 `tmp/review-pick/`；量可点元素 ≥44px、题干 ≥13px、无横向溢出、托盘不遮挡选中题、角标不改几何；首项内容齐全性抽 3 题。
loop: false
verify: test $(ls tmp/review-pick/*.png 2>/dev/null | wc -l) -ge 8

- [ ] **Step 13: 真机 iPad Safari 验收（ticket 010b）**
action: 在 iPad Safari 打开局域网地址，逐项检查：点击 vs 滚动、键盘顶托盘、搜索、快速连点、刷新后数据仍在、角标淡显/挑题清晰；记录设备/系统/Safari 版本与发现项。
loop: false
verify:
  type: human-review
  prompt: 在 iPad Safari 上按清单验收挑题托盘（点击/滚动、键盘、搜索、连点、刷新持久化、角标），确认通过或列出问题

- [ ] **Step 14: 全量门 + 改动汇总（提交前）**
action: 跑 `npm run check` 与 `npm run audit:topic`，汇总本次改动文件、截图证据、迁移报告与未闭合项；不提交。
loop: false
verify: npm run check && npm run audit:topic
gate: human

- [ ] **Step 15: 合回 main（不推送）**
action: 确认所有检查点已提交到 `feat/pick-classify`；跑最终门；把 `feat/pick-classify` 合回 `main`（fast-forward 或 `--no-ff` 按实际）；切回 `main`；不 push、不部署。
loop: false
verify: test -z "$(git status --porcelain)" && [ "$(git branch --show-current)" = main ]

## 检查点策略

本 run 最初在 `main` 初始化；确认「长任务每步绿就提交」后，执行 checkout 已切到 `feat/pick-classify`。
- 每个 Step 的 `verify` 通过后立即在 `feat/pick-classify` 做一次检查点提交（commit message 带 step 号），不攒到最后。
- `main` 只在最后 Step 15 合并一次，保持干净；不 push、不部署。
- HOTL state 的 `branch` 字段仍是初始化时的 `main`（不手改状态文件）；以 git 实际分支为准，finish 记 `merged` / target `main`。

## 风险（为什么是 high）

- **R1 旧数据迁移不可逆**：现有 `专题名#层级` 标签与 `.topic.json` 要拆成专题/类别/归属；映射错会丢失或错挂老师的分类。缓解：dry-run、写盘前备份、幂等、100% 归属对账、迁移后 export/audit 双绿。
- **R2 新写通道会改数据**：`/api/teach` 是第二条写路径；路径穿越/形状错误/并发写可能污染清单或归属。缓解：服务端白名单 + 路径断言 + 形状校验 + 原子写 + 串行队列；失败回滚；现有 `/api/tags` 回归。
- **R3 纸面几何红线**：角标/高亮/托盘可能改变页高、字号、留白或号牌位置。缓解：`tests/layout-invariant.test.ts` 锁逐字节几何；只有 outline/box-shadow，不改布局。
- **R4 真机触控不可自动化**：点击 vs 滚动、iPad 键盘、触控热区、Safari 惯性滚动只能在真机验；截图是 headless Chrome。缓解：human-review 门 + 真机清单。
- **R5 范围大**：11 个切片、跨数据/脚本/纸面/UI；中途半成品可能不可用。缓解：每步独立 verify，002 后核心闭环可用，后续并行推进。

## 可验收指标（数字）

- **M01 质量门**：`npm run check` 退出码 0；现有 297 条测试 + 新增专题/挑题测试全部通过，0 fail。
- **M02 纸面几何**：挑题开/关、角标开/关、选中/未选中四种状态，`layout-invariant` 的纸面几何逐字节相同（0 差异）；留白宽度不变。
- **M03 迁移守恒**：`专题名#层级` 与 `.topic.json` 的每条归属都有去向（迁移或显式报告），丢失 **0** 条；迁移后第二次 dry-run 变化 **0** 条；备份目录存在。
- **M04 导出/审计**：`topic:export` + `audit:topic` 退出码 0；类别计数与 index 一致；断链/重复/整专题消失的反向用例全部必红（0 漏报）。
- **M05 交互**：iPad 820×1100 截图 ≥8 张；控制台异常 0；可点元素最小高度 ≥44px；题干字号 ≥13px；横向溢出 0；托盘不遮挡选中题。
- **M06 持久化**：点 chip 后刷新，归属保留率 100%；快速连点后最终状态与最后一次操作一致（0 乱序）。
- **M07 失败不静默**：模拟写失败时 UI 回退并显示错误，0 次“假成功”；非法 scope/doc/路径/形状的写请求 0 次落盘。
- **M08 真机**：iPad Safari 清单逐项通过；发现项全部登记 HANDOFF §6（未闭合不冒充通过）。

## 交接要点（2026-10-30 暂停，模型卡顿，换模型续做）

- **当前分支**：`feat/pick-classify`；`main` 未合并（main 仍为 `68d805c`）。最新检查点 **`0572e6e`**
  （组合常驻条），前序 `985aa70`（组合初版）、`79e92be`（同上题+撤销）、`6e41f70`（顶栏/托盘压缩）、
  `8b5dac9`（内联新建）、`b680f51`（写通道/挑题）、`ecb8d87`（SPEC/工单）。
- **HOTL run**：`pick-classify-20261030T024035Z-9fa769d0a516`；Step 1–5 已 done，**Step 6（托盘搜索）
  尚未开始**；run 状态 running，owner 已 release（接手者重新 `owner claim --run-id ...`）。
  状态文件在 `.hotl/state/`，报告在 `.hotl/reports/`。
- **用户真实数据（不要覆盖）**：`data/out/teach/` 目前有专题 `平抛运动 / 圆周运动 / 曲线运动`；
  bindings 含 q16/q31/q58 + q0/q1（q0/q1 -> 曲线运动 + 基础）；用户自己建了一个组合
  `曲线基础`（`cb-mvujgdzldavzra`）。**绝不能用 `fixtures/teach-seed` 覆盖真实目录**。
- **测试安全**：所有会写 `data/out/teach` 的浏览器测试必须用 `tmp/pick-test-app`（APFS 克隆）
  + 独立端口 4175 + `.test-root` 标记；`tmp/combo-smoke.mjs` 已带 marker 守卫。
  真实服务在 **4174**（当前 nohup 运行）；临时 4175 服务测试完已停。`tasks/lessons.md` L5 记录过
  一次冒烟用种子覆盖用户数据的真实事故。
- **本次组合 UI 已实现**：组合常驻在托盘标题行，一屏 3 槽、12px 小字、超出横滑；点 chip 套用
  （替换当前题归属、复用撤销）；`＋` 起名小浮层；长按 380ms 拖动排序并写 `combos.json`。
  独立副本实测：5 条组合、3 个可见槽、横滑到最后一个、拖动后顺序落盘、套用/撤销/刷新持久化全过；
  `npm run check` 退出码 0。
- **未做**：组合的**改名/删除**（建错只能让它先留着或手工改文件）；Step 6 搜索；Step 7 专题/类别管理；
  Step 8 导出 v2 + 专题页；Step 9 阅读回显；Step 10/11 迁移（human gate）；Step 12 截图审板；
  Step 13 真机（human gate）；Step 14/15 合回 main。
- **接手第一步**：读本文件前文 + `AGENTS.md` + `docs/HANDOFF.md`；`npm run check` 全绿；
  在 `feat/pick-classify` 上 `owner claim` 当前 run；从 Step 6 继续，**不要重跑会写真实 teach 的冒烟**。
