# question-seg-engine

试题结构化切分引擎骨架 —— MinerU 解析结果（layout.json 优先，content_list.json 为退化路径）的后处理层。
「垂直演进模型」的起点：功能链路纵向打通、横向只覆盖高中试卷的典型版面，
但代码姿态是生产级的（正式 schema、正式接口），后续直接演进为正式模块。

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
npm run check   # typecheck + test
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
- 置信度阈值 0.75 与扣分项为校准点（真实 15 页回归后保持 0.75 未调整，ok 96.6%，见 DECISIONS §10.3）。

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
tests/           node:test 用例（31 个）
scripts/demo.ts  演示
docs/DECISIONS.md  切片决策记录（第二交付物）
```