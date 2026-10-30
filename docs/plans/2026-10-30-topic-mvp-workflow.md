---
intent: 专题知识库 MVP（SPEC S01）：iPad 上用 `专题名#基础/培优` 打标（既有标签通道）→ `topic:export` 导出专题（题干/选项/答案/图齐全性逐条校验）→ `audit:topic` 量化门 → `topic/` 专题页（iPad 优先，只消费快照，不用 renderPaper）→ 演示种子 + iPad 视口截图审板。
success_criteria: 规格落盘；打标→导出→页面→审计端到端通；audit:topic 对缺题/缺答案/缺图必红（反向验证记录）；iPad 视口截图审板通过（首项=内容齐全性）；main 上 npm run check 保持全绿；改动全部提交在 main 本地；零 src/ 切题路径改动。
risk_level: medium
auto_approve: true
branch: main
worktree: false
---

## Steps

- [x] **Step 1: 规格落盘**
action: `docs/specs/2026-10-30-topic-knowledge-base-spec.md`（场景/指标/风险边界/数据合同/阶段规划，标准深度，暂定假设显式标注）。
loop: false
verify: test -f docs/specs/2026-10-30-topic-knowledge-base-spec.md

- [x] **Step 2: topic-export 脚本**
action: 新增 `scripts/topic-export.ts`（`npm run topic:export`）。输入两路合并：① `data/out/tags/*.json` 的绑定 —— 先按 `data/out/tags/library.json` 把 `tagIds` 解析回名字，再识别 `专题名#基础|培优`（UI 新建标签只存 id；库缺 id / 库丢 / id 重复 / 专题标签在 stale 均红）；anchor 与当前题比对（页码/题号/长首行不符即红；首行 <6 个有效字符只告警，不阻断）；② `data/out/topics/*.topic.json` 手工题单。逐题 join `data/out/<doc>/questions.json`（stem/options/images/status）与 `data/out/bank/bank.json`（**按 `quizId` == 题目 id** 取 answerKey/answerText/answerDoc/answerImages）；图片文件逐条验证存在（题图相对 `data/out/<doc>/images/`，答案图相对 `data/out/<answerDoc>/images/`）。输出 `data/out/topics/index.json` + `export-status.json`（成功/失败都写）；needs_review 题照收但带 `reviewFlags`（R05 不静默）。缺题/缺题干/缺答案/缺图/标签漂移 ⇒ 退出码 1 并逐条列出。
loop: false
verify: npm run typecheck

- [x] **Step 3: 单测 + 反向验证**
action: 新增 `tests/topic-export.test.ts`（最小 fixture 目录）：约定解析（`#` 分隔、非专题标签不受影响）、**标签库 id→name 解析**、**anchor 漂移/标签在 stale/库丢失/id 重复必红、首行过短告警**、题单合并去重、**缺题/缺题干/缺答案/缺图/选项形状坏各自必红**（反向验证写在测试注释）、needs_review 带 flags、导出守恒（每 questionId 每专题恰好一条）、失败写 export-status（ok:false）。另加 `tests/audit-topic.test.ts`：审计独立性（手写 index 也能过）+ 索引/源/统计/状态被改必红。
loop: false
verify: node --import tsx --test tests/topic-export.test.ts

- [x] **Step 4: audit:topic 量化门**
action: 新增 `scripts/audit-topic.ts`（`npm run audit:topic`）：独立复核 index.json 与源的一致性（不同源原则：重新读 questions/bank/文件系统，不信 index 自带 stats），缺失即非 0。暂不接入 check（SPEC D04）。
loop: false
verify: npm run audit:topic

- [x] **Step 5: 专题页**
action: `scripts/view-server.ts` 静态白名单加 `/topic`（唯一共享文件改动，一行）；新增 `topic/index.html` + `topic/topic.js`（文件头 `// @ts-check` + JSDoc）+ `topic/topic.css`。页面 fetch `/data/out/topics/index.json` 渲染：专题选择、层级筛选（全部/基础/培优）、题卡（题干保留换行、选项、答案开关、图片、来源 `doc p页 · needs_review` 徽标）。**只消费快照 JSON，不 import src/，不用 renderPaper**；iPad 优先（基础字号 ≥13px、触控目标 ≥44px），needs_review 题卡带可见标记（R05）。
loop: false
verify: npm run typecheck

- [x] **Step 6: 演示种子 + 导出**
action: 演示种子改用 **`23必刷题 4 曲线运动`**（与答案册同系列；教材基础练与合订本不同书，见 SPEC R07）：在 `data/out/tags/library.json` 建 3 个专题标签（`平抛运动#基础` / `圆周运动#培优` / `圆周运动#基础`），绑定 q16 / q31 / q58（含 1 道 needs_review），种子另存 `fixtures/topic-seed/`；跑 `npm run topic:export` 与 `npm run audit:topic`。
loop: false
verify: npx tsx -e "import('./scripts/topic-export.js').catch(()=>process.exit(1))" 2>/dev/null; npm run audit:topic

- [x] **Step 7: iPad 视口截图审板**
action: 起 main 的 view-server（PORT=4174，避开 worktree 的 4173），用 CDP 截图（820×1100）专题页整页 + 层级筛选切换 + 答案展开 + needs_review 徽标各一张，存 `tmp/review-topic/`。审板清单首项=内容齐全性（lessons L1）：题干/选项/答案/图与快照逐项对。
loop: false
verify: test $(ls tmp/review-topic/*.png 2>/dev/null | wc -l) -ge 4

- [ ] **Step 8: 文档登记 + 提交**
action: HANDOFF §3 命令表加 `topic:export` / `audit:topic` / `topic/` 页 URL，§4 文档地图登记 SPEC；npm run check 全绿确认；全部改动提交到 main 本地（不推送）。
loop: false
verify: npm run check

## 交接要点（2026-10-30，token 预算中断，从 Step 2 续做）

- **已完成**：Step 1（SPEC 落盘）。Loop run-id `topic-mvp-20261030T005252Z-32f845251d67`
  （`.hotl/state/`，owner 租约将自然过期，续做者直接重新 `owner claim`）。
- **Step 2 前置数据事实（已实测核实，不必重查）**：
  - 图片目录：`data/out/<doc>/images/<path>`（questions.images[].path 相对它）；
  - **`bank.json` 的 `quizId` == questions.json 的题目 `id`**（`"<doc>:p<页0基>:q<序>"`）⇒ 直接按 id join；
  - `bank.answerImages` 元素 = `{path, bbox}`，path 相对**答案册** `data/out/<answerDoc>/images/`（续做时实测确认）；
  - `status` 取值实测 {`ok`, `needs_review`}；tags binding 形状见 `data/out/tags/23必刷题 2相互作用.json`
    （questionId/tagIds/anchor{number,page,section,firstText}，page 为 1 基）；
  - 演示种子候选：曲线运动 `p?:q?` 教材实验 5/6 两题（题号 5/6，§79 栏目题）。
- **续做第一件事**：`npm run check` 全绿 → `hotl-rt owner claim --owner <你> --run-id <run-id>` → `step 2 start`。
