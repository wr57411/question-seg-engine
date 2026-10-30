# question-seg-engine

试题结构化切分引擎骨架 —— MinerU 解析结果（layout.json 优先，content_list.json 为退化路径）的后处理层。
「垂直演进模型」的起点：功能链路纵向打通、横向只覆盖高中试卷的典型版面，
但代码姿态是生产级的（正式 schema、正式接口），后续直接演进为正式模块。

> **交接入口（跨 Agent 必读）**：接手指南与当前状态已收敛到
> **[docs/HANDOFF.md](docs/HANDOFF.md)**（含红线、未闭合风险、文档地图）；
> 根目录 `AGENTS.md` 是各平台编程 Agent 的通用入口。改口径/阈值前先查
> `docs/DECISIONS.md`（92 条决策，按时间序）。
> 当前真实数据：题册 15 页 / 83 题，答案册 23 页 / 167 题（详见 HANDOFF §2）。

## 架构

```
layout.json / content_list.json（MinerU 返回；layout 优先）
      │ normalize.ts   ← 与上游唯一的耦合点（换解析供应商只改这里）
      ▼
 ParsedDocument
      │ layout.ts      ← 版面层：分栏检测 + 阅读顺序恢复（只认坐标，不认语义）
      ▼
 阅读顺序的块序列
      │ patterns.ts    ← 语言层：题号/选项/大题/答案区 模式库（只认文本形状）
      │ rule-engine.ts ← 组合决策：有限状态机切题/收选项/答案对号 + 置信度
      ▼
 SegmentationResult { questions, reviews, stats }
```

## 快速开始

```bash
npm install
npm run demo    # 三份夹具跑全流程
npm test        # 核心机制验收
npm run check   # typecheck + test + 基线渲染/题号/题库审计
```

## 核心机制（对应架构决策）

1. **双层规则，先版面后语言**：分栏检测用 x0 桶直方图聚类（双栏 = 两个稠密簇且簇中心距 > 25% 页宽；
   对居中标题横跨栏间隙免疫），阅读顺序恢复只用 bbox 坐标（`layout.ts`）；
   题号/选项匹配只作用于「块首行」（`patterns.ts` 的 `matchFirstLine`），
   两个纯层都不做切割决策，切割由 `rule-engine.ts` 状态机裁决。
2. **不静默失败**：所有低置信度题目标记 `needs_review` 并产出 `ReviewNote`
   （可诊断的失败模式：空题干 -0.6 / 选项证据丢失 -0.4 / 选项数量异常 -0.1 /
   重复题号 -0.3）。低于阈值 0.75 即人工校对，质检入口见 `src/index.ts#summarize`。
3. **答案区独立**：命中「参考答案」区后切换模式，答案条目按题号对号入座
   （含 `（2）` 与 `2` 的归一化匹配），答案解析续行累积进 answer 字段。
4. **回拼校验层（所有策略强制出口）**：`src/validation.ts` 对结构化输出做
   归一化包含校验——题干每行与选项文本必须能在原文块中找回（删空白/`$` 后子串查找，
   不做字面 diff：题号前缀/公式内联/空白差异必然存在）。失败扣 0.3 置信度，
   必然落入 needs_review。**规则版与未来 LLM 版同等生效**（防 LLM 幻觉丢选项/凭空补内容）。
5. **公式指标**：stats 区分 `formulaBlocks`（独立公式块）与 `inlineFormulas`（行内 `$...$` 对数），
   作为公式召回率的分母；验收用「公式语义正确率」（渲染对照原图人工抽检），
   不用可编译率——可编译 ≠ 语义正确，静默错转（上下标互换/根式错位）才是常见失败。
6. **扩展点**：`SegmentationStrategy` 接口 + `registerStrategy` 注册表
   （`src/strategy.ts`）—— 将来规则 + LLM 混合切分注册新策略即可，上层零改动；
   新策略必须在校验层后面接线。

架构与验收的完整决策（schema 分层冻结、手写答案默认人工录入、数据合规分级、
云/自部署双写后置等）见 **[docs/DECISIONS.md](docs/DECISIONS.md)** —— 切片的第二交付物。

## 已知简化（演进点，勿当成最终实现）

- 分栏恢复为「左列整列在前」；三栏/栏内多层级需按水平带交替归并。
- 填空题与主观题暂以「无完整选项」推断，未做题型细分。
- 解析与答案未拆分为两个字段（schema 已预留 `solution`）。
- 置信度阈值 0.75 与扣分项为校准点（2026-10-07 选项算法修复后：85 题 83 ok，
  2 needs_review 全部为上游公式选项漏检的真问题，见 DECISIONS §14）。

## 真实 MinerU API

真实云 API 的接入脚本（走真实网络，需 `mineru_API_KEY`，产物不入库）：

```bash
# 冒烟（开发期确认字段结构，产物入 data/smoke/）
node --import tsx scripts/api-smoke.ts "sample/23必刷题 2相互作用.pdf"

# 端到端管线（样卷目录 → data/out/<文件名>/）
node --import tsx scripts/real-pipeline.ts sample
```

- `real-pipeline.ts` 按位置参数取 `<文件或目录> [outRoot]`（`outRoot` 默认 `data/out`）；
  目录会遍历其中的 PDF/图片，逐文件跑全链路。
- 切分默认走 layout.json 分支（行级几何，选项结构化可用；`scripts/real-pipeline.ts` 优先用 layout，
  zip 无 layout 时退化为 content_list）。
- API Key 从 `process.env.mineru_API_KEY` 读取，仅服务端使用，不出现在产物与日志。
- 真实网络调用不纳入 `npm test`；离线测试见 `tests/mineru-client.test.ts`、`tests/mineru-unpack.test.ts`。
- 字段事实以 `docs/real-api-notes.md` 为准。

## 阶段样品展示（自反馈环）

七个视图的网页动线——**原卷 → 原料 → 阅读顺序 → 切题 → 质检 → 成品 → 对比**，
每步用白话说明「电脑此刻做到了什么、你该看什么」，非技术背景也能直接审阅：

```bash
npm run stages               # 导出快照 + 启动服务，然后访问 /stages/
# 或分步：npm run stages:export && npm run view
```

- **阶段 0 原卷对照**：本机有 `pdftoppm`（poppler）时自动渲染原卷逐页 PNG
  （`data/out/<docId>/pages/`），任何浏览器可靠显示；无工具则降级为 PDF 内嵌。
  每个阶段的工具条都有「对照原卷本页 ↗」链接。
- **快照即契约**：`stages/` 只消费 `data/out/<docId>/stages.json`（由
  `scripts/export-stages.ts` 生成，是唯一可 import 引擎代码的展示层上游），
  不 import 引擎代码——与 viewer/ 同一条解耦红线。
- **两条数据口径**（单测锁定）：`Question.source.blockIndexes` 是跨页全局序号，
  快照层映射回页内序号；跨页题按「块的落页」分组，在每一部分都展示。
- **自反馈环**：主模型 Read 原卷页图 ↔ Read 阶段截图 → 对照发现项 → 修复 → 复拍。
  首轮发现项与处置记录见 [docs/design/stages-review.md](docs/design/stages-review.md)，
  截图证据在 [docs/design/stages-cap/](docs/design/stages-cap/)。
- **成品 = 按原坐标重建的纸面**（阶段 5）：与「对比」右侧**同一段代码**画的
  （`stages/reconstruct.js` 的 `renderPaper`，只此一处实现）——「成品跟对比那个一样」
  是**结构保证**，不是两处各写一遍碰巧长得像。整册浏览版见下面「成品页」。
- **对比模式**（最后一视图）：左原卷页图、右同一套重建纸面，
  同宽并排、翻页同步——排版保真度检查入口（审计标记全开）。
  viewer 为阅读版重排版，定位见「展示层」一节。
- **公式噪声检测（检测不改写）**：`src/formula.ts` 扫描全部 $...$ 公式按六类噪声分桶
  （数字间空格/字体包装/\left\right/度符号拼写/花括号失衡/超长），报告进质检页作为
  清洗迭代的追踪基线；展示层另有 `stages/latex-display.js` 轻量美化（θ/°/上下标），
  只影响显示、不改数据。discarded_blocks（页眉/页脚/页码）在重建中以虚线灰块呈现。
- 命令：`npm run stages:export` 仅重导快照；截图审板的发现项写入 stages-review.md。

## 每天怎么用（日常动线）

```bash
npm run daily -- ~/Downloads/新试卷.pdf     # ① 导入：一条命令，不用改代码
npm run view                                # ② 打开：http://localhost:4173/final/（仅本机）
npm run view:lan                            # 手机/平板：同 WiFi；TAGS_WRITE=0 只读
```

批量导入：
```bash
mkdir -p inbox && cp ~/Downloads/*.pdf inbox/   # PDF/layout.json 都可以
npm run batch -- --inbox inbox --delay 3000     # 逐本 daily；同哈希跳过；失败隔离；本间等待
# daily 成功后自动「逐题选源」（双源齐备才跑，DECISIONS §75）；关掉加 --no-select
npm run batch:report                            # 日报：data/batch/report.md
# 429 限流会立即停批；配额恢复后用 --retry 2 --delay 3000 接着跑
# 代码修复后重生成旧书：npm run daily -- <pdf> --id <docId> --reuse-oxr --no-ocr
```

两源融合（原型，未接 daily/batch）：
```bash
npm run fuse:eval -- --all   # 8 对 MinerU/OXR：字符级对齐，MinerU 几何 + OXR 文本
                             # 报告 data/fuse/report.md
npm run fuse:doc -- "教材基础练 磁场"   # 把融合结果写进正式产物（需 <docId>-MinerU/layout.json）
```

**① 导入**（`npm run daily`）跑完整条链：MinerU 解析 → 解包 → 导出快照（页图 + 墨迹覆盖率）
→ 整页 OCR 补行 → 再导出 → 写 `data/out/<docId>/meta.json` 体检摘要。

- 已有解析结果时**不会重复调 MinerU**（幂等，不烧额度）；要强制重解析加 `--force-parse`。
- 想跳过 OCR（更快）：`--no-ocr`。只刷新体检：`--meta-only`。
- 失败一律说清「为什么 + 下一步」，不静默少做一步。

**② 阅读**（成品页）：下拉里自动出现新卷（服务端扫 `data/out/`，**无需改前端**）；
顶部那枚胶囊是本册体检（题数 / 页数 / 补回行数 / 待校对题数，点「详情」看原因）。

- **记住读到哪**：每册独立，重开自动回到上次那页。
- **跳转**：顶部输入框 `12` → 第 12 题、`p7` → 第 7 页。
- **搜索**：输入文字（如 `摩擦力`）→ 列出命中片段，点一条跳过去。

**③ 自查**：顶部「审计标记」打开后，洋红框 = 原卷有墨迹但没读出来，灰虚线 = 被丢弃的块
（页眉页脚等）。这些标记原版书上没有，所以默认关。

**目录约定**：`data/out/` 只放文档目录 + `bank/` + `tags/`；历史调试产物在
`data/archive/`（移动不删除）；测量证据文档在 `docs/evidence/`（跟 git 走，换机器不丢）。

## 成品页（像原版书的那一份）

用户 2026-10-14 定的调子：**成品 = 「对比」右侧那张重建纸面**，整册滚动翻，用起来像翻原版书。

```bash
npm run view            # 本机起服务：http://localhost:4173/final/?doc=<docId>
npm run view:lan        # 手机/平板：同 WiFi（共享网络加 TAGS_WRITE=0 只读）
```

- **不做重排**：每一页都交给 `stages/reconstruct.js` 的 `renderPaper` 按原坐标重建；
  左侧/右侧留白里的数字是**题号标注**（点一下看该题的结构化详情，含配对答案）。
- **两个开关**（也可用 URL 参数，便于分享某个视图）：
  - **审计标记**（默认关，`?audit=1` 开）：解析遗漏（洋红框）+ 丢弃块（灰虚线）——
    这些标记原版书上没有，默认画就不像原版书了；
  - **OCR 候选样式**（默认开，`?ocr=0` 关）：上游整行漏读、由 OCR 补回的内容。
    关掉只是**换回普通正文样式**（文本始终在，悬停仍写明来源）——
    红线 G1（候选不得与引擎原文混淆）在**审计视图**（stages 的对比/原料/切题）里始终严格执行。
- 换卷：顶部下拉（题册 / 答案册），或 `?doc=<docId>`。

## 展示层（阅读版）

浏览器查看结构化题目（试题区/答题区/答案区、答案开关、按题型留白、公式渲染）：

```bash
npm run view                 # 本机；默认打开 23必刷题 2相互作用
npm run view:lan             # 手机/平板（同一 WiFi；TAGS_WRITE=0 只读）
npm run view "23必刷题 2相互作用"
# 然后访问 http://localhost:4173/viewer/
```

- 解耦边界：viewer/ 不依赖引擎代码，只消费 data/out/<docId>/questions.json + images/（契约见 viewer/docs/CONTRACT.md）
- 换展示层：遵守 CONTRACT 即可整体替换 viewer/
- 页面需联网加载 KaTeX CDN（公式渲染）；离线时公式以 $..$ 文本显示
- 数据源说明：`data/out/<docId>/questions.json` 是最新算法产物（本仓库由 `segmentFromLayout(data/smoke/unpacked/layout.json)` 本地生成，非联网重新解析；data/ 为运行时产物、git 忽略不入库）

**查看 / 验收命令（A 组修复后）**：

- `npm run view` 会打印**带完整 doc 参数的地址**（含 `%20` 空格，可直接复制），避免 URL 截断导致空白。
- `npm run view:cap -- --states=complete,truncated,filter,answer,needs` 生成各状态截图（落盘 `docs/design/viewer-cap/`）。
- **验收以截图视觉审视为准**：`npm run view:cap` 截图 → 主模型 Read 逐屏审视版面（重叠/错位/间距/溢出/字体/图片）→ 发现项写入 `docs/design/viewer-review.md` 并修复 → 再截图对照。
- `npm run view:test` 为 DOM 存在性 Gate（元素在不在），是截图的**辅助**，不替代视觉审板。
- doc 参数截断/非法时 viewer 自动回退默认卷并提示（不静默空白）。

## 目录

```
src/
  types.ts       正式 schema（分层冻结：核心骨架冻结，扩展字段增量追加，见 DECISIONS.md）
  normalize.ts   上游适配（MinerU layout.json / content_list → ParsedDocument）
  layout.ts      版面层
  patterns.ts    语言层
  rule-engine.ts 组合决策（默认实现）
  validation.ts  回拼校验层（所有策略的强制出口）
  strategy.ts    切分策略接口 + 注册表
  index.ts       对外出口
fixtures/        三份假夹具（单栏 / 双栏 / 干扰项）
tests/           node:test 用例（含 viewer-contract / viewer-logic 适配断言）
scripts/demo.ts  演示
scripts/view-server.ts  演示/预览静态服务器（零依赖，npm run view）
viewer/          阅读版展示模块（viewer.js/css/index.html，解耦红线见 viewer/docs/CONTRACT.md）
final/           成品页（整册保真重建，整册滚动翻；与 stages 共用 reconstruct.js）
stages/          阶段样品展示模块（七视图动线：原卷→原料→阅读顺序→切题→质检→成品→对比）
stages/reconstruct.js  纸面重建的**唯一实现**（renderPaper：按原坐标画页 + 留白题号牌 + 可选审计标记）
scripts/export-stages.ts  阶段快照导出（引擎产物 → stages.json + 原卷页图）
docs/DECISIONS.md  切片决策记录（第二交付物）
```