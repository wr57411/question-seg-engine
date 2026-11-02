# SPEC — 专题知识库：从批量识别到平板选题（v0.1 草案）

- 日期：2026-10-30 · 深度：标准（bgx 产品规划，用户「通过 Loop 完成」= 直接实施授权 MVP）
- 状态：需求目标已确认（用户原话，见 §1）；技术约定 D02–D04 为**暂定假设**，标注待确认
- 本轮实施：S01（MVP）由 `docs/plans/2026-10-30-topic-mvp-workflow.md` 的 HOTL loop 执行
- 实施结果（2026-10-30，main）：S01 完成。演示种子改用 `23必刷题 4 曲线运动`（原因见 §5）；
  答案池跨书错配作为 R07 登记（§3）
- ⚠️ **后续模型变更**：专题/层级字符串模型将由 `2026-10-30-pick-and-classify.md` 的
  「专题 / 类别 / 业务标签」三套清单取代（类别为全局多选、与专题独立）；本文件保留为
  S01 的历史合同与实施记录。

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
- **R07 答案池可能跨书错配**：实测 `bank:all` 把 `物理_教材基础练 曲线运动` 配到
  `答案册-合订本`（不同系列），答案与题干语义不符（见 HANDOFF §6-17）。S01 的校验只保证
  「答案存在且与 bank 结构一致」，**不宣称配对语义正确**；演示种子改用同系列题册（§5）。

## 4. 数据合同（v1）

- **标签约定（D02 暂定）**：标签**名字**形如 `专题名#基础` / `专题名#培优` 的即专题标签；
  绑定只存 tagId，导出按 `data/out/tags/library.json` 的 id→name 解析；历史/种子可直接把
  `专题名#层级` 当 id（按字面值兼容）。其余短码不受影响。iPad 上点号牌 → 面板输入即可打标。
- **漂移/失效判据**：页码/题号必须一致；首行有效字符 ≥6 时还要包含匹配，不符 ⇒ 红。
  首行为空或 <6 个有效字符（题号独占一行、图题等）⇒ **告警**（只能核对页码+题号，页面可见，
  不阻断整本书；重打标仍是同样短首行，不能当阻断理由）。专题标签在 `stale`、库缺 id、
  库文件丢失、库 id 重复、**整个专题消失** ⇒ 导出/审计均红（不允许专题静默少题；
  整专题消失时不覆盖旧 index）。部分条目减少 / 改名后题搬到别的专题 ⇒ 导出告警
  （状态文件 + 页面提示条），不阻断（改名是合法操作）。
- **手工通道（D03 暂定）**：`data/out/topics/<slug>.topic.json`，手写题单 `{name, items:[{doc, number, level}]}`。
- **导出产物**：`data/out/topics/index.json` —— 展示层唯一消费源。
  `{version, generatedAt, topics:[{slug, name, items:[{doc, number, page, questionId, level, stem, options[], images[], answerKey, answerText, answerDoc, answerImages[], status, confidence, reviewFlags[], sources[]}]}], stats}`。
  `page` 为 1 基页码（0 = 未知）；`answerDoc` 是答案来源册；`answerImages` 元素为
  `{doc, path, bbox?}`（path 相对答案册的 `images/`）；`sources` 记录 tag/manual。
  题图路径相对 `data/out/<doc>/images/`（与快照一致），导出时逐条验证文件存在。
- **导出状态**：`data/out/topics/export-status.json` = `{ok, at, errors[], warnings[], indexGeneratedAt}`；
  成功/失败都写。页面据此显示「上次导出失败 / 旧数据 / 索引与状态不一致 / 告警」提示条；
  `audit:topic` 要求该文件存在、`ok:true` 且 `indexGeneratedAt` 与 index 一致。
- **审计**：`audit:topic` 独立复核 index.json 与源（questions/bank/图片文件）的一致性；
  缺题/缺答案/缺图 ⇒ 退出码非 0。暂不接入 `check`（D04，接入时须反向验证）。

## 5. 阶段规划（S01 已授权，S02+ 待排）

- **S01 MVP（已完成 2026-10-30）**：标签约定 + `topic:export` + `audit:topic` + `topic/` 页面 +
  演示种子 + iPad 视口审板。演示种子 3 题在 `23必刷题 4 曲线运动`：`平抛运动#基础`（p4 第1题）、
  `圆周运动#培优`（p7 第3题）、`圆周运动#基础`（p13 第3题，needs_review）。
  ⚠️ 原候选「教材实验 5/6」不在 bank 配对中（无答案），且教材基础练与合订本不同系列 ⇒ 不采用。
  种子文件（标签库 + 绑定，含 anchor）已存 `fixtures/topic-seed/`：演示环境执行
  `cp fixtures/topic-seed/*.json data/out/tags/` 后重跑 `npm run topic:export`
  （会覆盖同名文件 —— 已有用户标签库时先备份 `library.json`）。
- **S02 配对覆盖 ≥60%**：7 册缺章显式绑定（feature/oxr 的 C 方案 + 扩展；等合并后收口到主线）。
- **S03 待复核率 ≤8%**：金标准扩样 + 逐题选源复核（feature/oxr 既有 batch/score 链路）。
- **S04 标注 v2**：语音/手写探针 → 数据模型（annotations store，走 tags 同款守卫）→ 面板。
- **S05 交付**：专题导出（打印/PDF/Markdown/Anki），知识库归档。
