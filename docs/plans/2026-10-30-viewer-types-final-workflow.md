---
intent: 把展示层剩下的 4 个 UI 文件（entry-paper / viewer / stages / final）全部清零隐式 any 并纳入 `tsconfig.viewer.json`，让 §6-11 收口到 11/11；全程不改运行时行为。
success_criteria: `tsconfig.viewer.json` 的 include 覆盖 11 个展示层文件且 `npm run typecheck:viewer` 0 错；`npm run check` 全绿（357+ 测试、渲染审计 7/7、配对 420、可疑行 0）；成品页 / 标签面板 / stages 对比 / viewer 阅读版四个界面在浏览器实测 DOM 计数与截图与改前一致；文档同步（HANDOFF §6-11 收口、§6-29 保持登记、INDEX 与接管报告更新）。
risk_level: medium
auto_approve: true
branch: feature/oxr
worktree: false
---

## 共同约束（每一步都适用）

- **只加类型，不改行为**：允许的变化仅限 JSDoc 注释、`@ts-check`、`/** @type {X} */` 断言、
  以及**等价**的空值守卫（`x.y` → `x?.y ?? 默认值` 必须与原语义一致，且默认值要说得出理由）。
- 任何"为了让检查变绿"而放宽判据、删断言、改门禁配置的行为一律禁止（AGENTS 红线）。
- `.d.ts` 遮蔽问题（`HANDOFF §6-29` / `DECISIONS §94`）**不在本工作流内解决**：
  消费者侧仍看到宽松签名，所以调用处要显式收窄，不许靠 `any` 蒙过去。
- 每一步完成后：`npm run typecheck:viewer` 必须 0 错；随后做一次 `git commit`（本地），
  提交信息带 `§6-11 N/11`。

## Steps

- [ ] **Step 1: entry-paper 清零并纳管**
action: `final/entry-paper.js` 文件头加 `// @ts-check`，为 49 处隐式 any 参数补 JSDoc（题目/页/块/矩形沿用 `reconstruct.js` 里已定义的 `Block`/`Page`/`Rect` 形状；若因 `.d.ts` 遮蔽拿不到，就在本文件内声明**最小形状**并注明原因，不许写 `any`）。把该文件加入 `tsconfig.viewer.json` 的 `include`。
loop: false
verify: npm run typecheck:viewer

- [ ] **Step 2: viewer 清零并纳管**
action: `viewer/viewer.js` 同上（40 处）。注意该文件有 `document.querySelector` 结果当 `Document` 用、`window.renderMathInElement`（第三方全局）等真实类型问题：第三方全局用 `/** @type {any} */` 之外的办法——在文件里声明 `@type {{renderMathInElement?: (el: HTMLElement, opts: unknown) => void}}` 形式的 window 扩展并注释来源；不得用 `// @ts-ignore` 整行闭嘴。
loop: false
verify: npm run typecheck:viewer

- [ ] **Step 3: stages 清零并纳管**
action: `stages/stages.js` 同上（144 处）。这个文件是各阶段视图的装配层，重点是把"阶段配置表"（`do`/`look` 那种按阶段名索引的对象）声明成 `Record<string, {do: string, look: string}>` 之类的显式形状，避免索引签名报错。
loop: false
verify: npm run typecheck:viewer

- [ ] **Step 4: final 清零并纳管**
action: `final/final.js` 同上（192 处，最大的一块）。`state` 对象、`tagApp` 句柄、面板数据结构沿用/对齐 `tag-panel.js` 已定义的 `TagApp`/`TagState` 形状；`renderPaper` 的 opts 与 `reconstruct.js` 的 `RenderOpts` 对齐。若发现 `.d.ts` 遮蔽导致 `renderPaper` 返回 `any`，在调用处显式收窄并注释指向 §6-29。
loop: false
verify: npm run typecheck:viewer

- [ ] **Step 5: 四个界面浏览器实测回归**
action: 起预览服务，用无头浏览器对**改动前已存的基线**逐项核对：① 成品页 `final/?doc=物理_教材基础练 电路` p1 的块计数（应为 text 752 / image 67 / table 3）与截图；② 点题号牌 → 详情面板 → 标签区 5 行、库面板 5×3 输入、新建表单可见（**不点保存**，不写标签数据）；③ `stages/?doc=…&stage=6` 对比页正常；④ `viewer/?doc=23必刷题 2相互作用` 卡片数 > 0 且统计正常。截图与 DOM 计数存 `tmp/review-types/`（≥4 张）。审板清单第一项永远是**内容齐全性**（`tasks/lessons.md` L1）。
loop: false
verify: test -d tmp/review-types && test $(ls tmp/review-types/*.png 2>/dev/null | wc -l) -ge 4

- [ ] **Step 6: 全量质量门与文档收口（关键门）**
action: 跑 `npm run check`（含 `audit:suspicious`）；任何红一律修因，不调阈值。文档：`HANDOFF §6-11` 收口为 11/11（或如实记录剩余）、`§6-29` 保持登记、`docs/dev/bgx/INDEX.md` 与接管报告登记本批结果（含每一步的错误数清零数字与回归证据）。
loop: false
max_iterations: 2
verify: npm run check
gate: human

- [ ] **Step 7: 推送**
action: 确认本地提交齐全后 `git push origin feature/oxr`（不 force、不动 `main`），并核对远端与本地同 hash。
loop: false
verify: bash -c 'test "$(git rev-parse HEAD)" = "$(git rev-parse origin/feature/oxr)"'
gate: human
