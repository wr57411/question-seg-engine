# SPEC — 专题知识库：从批量识别到平板选题（v0.1 草案）

- 日期：2026-10-30 · 深度：标准（bgx 产品规划，用户「通过 Loop 完成」= 直接实施授权 MVP）
- 状态：需求目标已确认（用户原话，见 §1）；技术约定 D02–D04 为**暂定假设**，标注待确认
- 本轮实施：S01（MVP）由 `docs/plans/2026-10-30-topic-mvp-workflow.md` 的 HOTL loop 执行

## 1. 目标（用户原话 + 复述）

> 「我的目标就是能够先批量地识别这些题目，题目跟答案能够良好匹配，方便我在平板上选中题目，
> 后续整理形成自己的知识库，比如说，我可以选中这些题目作为我要讲的专题的基础题或者培优题，
> 然后通过语音或手写的方式，把知识点的图文匹配上。」

**复述（推断部分标 ⚠️）**：用户是物理教师，iPad 是主设备；把已有教辅批量扫进题库，
备专题课时在平板上挑题、标「基础/培优」并归入专题；授课/整理时在题目上挂语音或手写的
知识点讲解（图文对应）；最终沉淀成个人可复用的知识库。⚠️ 「图文匹配」指讲解内容与题目
图片/知识点的对应关系，具体形态未定（S04 探针）。请用户纠正。

**明确不做（v1）**：语音/手写标注（S04 先做 iOS 能力探针）、自动推荐选题、组卷重排
（纸面重建只此一处的红线不动）、公网部署（写通道红线 §6-10）。

## 2. 场景 → 指标 → 验证

| # | 场景 | 可验收指标（现状实测 → 目标） | 验证命令 |
|---|---|---|---|
| S01 | 批量入库：新书 PDF 投 inbox → batch 全链 → 题库 | M01 入库规模：去重 **15 卷 / 1,341 题** → 书架 30 本；M03 待复核率 **15.9%** → ≤8% | batch 台账/日报；meta 体检汇总 |
| S02 | 题目—答案匹配 | M02 配对：**420 条**、唯一键 0 重复、内容尺子全达标；覆盖率 **31%**（420/1341）→ ≥60%（光学/磁场/电路等 7 册显式绑定后） | `npm run bank:all` + `audit:pair` |
| S03 | **平板选题**：成品页点号牌打标 `专题名#层级` → 一条命令导出专题 | M04 专题完整性：专题内每题 **题干/选项/答案/图片齐全率 = 100%**（缺即红）；needs_review 题带标记可见 | `npm run topic:export` + `npm run audit:topic` |
| S04 | 专题页备课/授课：按层级（基础/培优）浏览，逐题看答案与图 | M05 展示验收：iPad 视口（820pt）逐屏截图审板通过，首项=内容齐全性，正文字号 ≥12px | 截图 `tmp/review-topic/` |
| S05 | 知识点图文标注（语音/手写）→ 知识库沉淀/导出 | v2：先立 **iOS 能力探针**（Safari 录音权限、Pencil → 图片导出），不写未验证承诺 | 探针报告 |

## 3. 风险边界（红线映射）

- **R01 不动引擎**：本 loop 零 `src/` 切题路径改动；任何引擎改动必须另走 audit:ab 全量指纹 + check。
- **R02 展示层解耦**：topic 页只消费快照 JSON（`/data/out/` 只读前缀）与 `topics/index.json`，
  **不 import `src/`、不使用 `renderPaper`**（不重建纸面 —— 「纸面重建只此一处」红线不碰）。
- **R03 写通道**：`topic:export` 是构建期脚本写 `data/out/topics/`（与 `stages:export` 同性质）；
  `POST /api/tags` 既有守卫不变；公网前必须鉴权（§6-10）不变。
- **R04 合并边界**：本 loop 只**新增文件** + `view-server.ts` 静态白名单加一行 `/topic`；
  不碰 feature/oxr 正在动的文件（viewer 渲染、bank-bindings、DECISIONS §79、HANDOFF 正文）。
- **R05 上游质量传导**：待复核（needs_review，现 15.9%）的题**可以**进专题，但导出与页面
  **必须带标记**，不允许静默当干净题 —— 否则错题混入知识库且不可见。
- **R06 多会话并行**：main 侧写 `data/out/topics/`、tags 演示种子；feature/oxr 正在做 B 全量重导。
  data/ 已拆克隆（lessons L4），两边互不影响；**重导会冲掉 tags 吗 ⇒ 不会**（tags 独立落
  `data/out/tags/`，不写快照），但 topic 演示种子绑定的题目若题号序列变了会失配 ⇒ audit 必红，可发现。

## 4. 数据合同（v1）

- **标签约定（D02 暂定）**：`tagIds` 中含 `#` 的即专题标签，格式 `专题名#基础` / `专题名#培优`；
  其余短码不受影响。iPad 上点号牌 → 面板输入即可打标（既有通道）。
- **手工通道（D03 暂定）**：`data/out/topics/<slug>.topic.json`，手写题单 `{name, items:[{doc, number, level}]}`。
- **导出产物**：`data/out/topics/index.json` —— 展示层唯一消费源。
  `{version, generatedAt, topics:[{slug, name, items:[{doc, number, questionId, level, stem, options[], images[], answerKey, answerText, answerImages[], status, reviewFlags[]}]}], stats}`。
  图片路径相对 `data/out/<doc>/`（与快照一致），导出时逐条验证文件存在。
- **审计**：`audit:topic` 独立复核 index.json 与源（questions/bank/图片文件）的一致性；
  缺题/缺答案/缺图 ⇒ 退出码非 0。暂不接入 `check`（D04，接入时须反向验证）。

## 5. 阶段规划（S01 已授权，S02+ 待排）

- **S01 MVP（本轮 loop）**：标签约定 + `topic:export` + `audit:topic` + `topic/` 页面 + 演示种子 + iPad 视口审板。
- **S02 配对覆盖 ≥60%**：7 册缺章显式绑定（feature/oxr 的 C 方案 + 扩展；等合并后收口到主线）。
- **S03 待复核率 ≤8%**：金标准扩样 + 逐题选源复核（feature/oxr 既有 batch/score 链路）。
- **S04 标注 v2**：语音/手写探针 → 数据模型（annotations store，走 tags 同款守卫）→ 面板。
- **S05 交付**：专题导出（打印/PDF/Markdown/Anki），知识库归档。
