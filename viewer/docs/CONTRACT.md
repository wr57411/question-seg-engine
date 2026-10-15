# 展示层数据契约（CONTRACT v1）

> 📍 交接导航：本文件是引擎↔展示层的**技术契约**（持续有效，改 viewer/ 前必读）。
> 项目当前状态与跨 Agent 交接入口见 **[../../docs/HANDOFF.md](../../docs/HANDOFF.md)**。

引擎与展示层的唯一边界。引擎（src/）产出的 questions.json 序列化形态；展示层（viewer/）只消费本文件描述的数据。

## 数据源

- 题目: `data/out/<docId>/questions.json` —— SegmentationResult.questions 的 JSON 序列化（引擎 src/types.ts 的 Question 为字段权威）
- 图片: `data/out/<docId>/images/<裸文件名>` —— questions[].images[].path 为裸文件名（不含路径），展示层拼接 `images/` 前缀
- 入口: `npm run view [docId]`（默认 docId=23必刷题 2相互作用）

## 字段表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 全局唯一 docId:p<page>:q<seq> |
| number | string | 题号原文 |
| type | "choice" \| "subjective" | 题型（choice=有完整选项组） |
| section | string | 大题标题 |
| stem | string | 题干（含 $..$ 行内公式与 $$..$$ 独立公式，KaTeX 渲染） |
| options | {key,text}[] | 选项组 |
| answer? | string | 答案（含解析续行，见适配①） |
| images | {path}[] | 图片（path 裸文件名） |
| confidence | number | 置信度 0-1 |
| status | "ok" \| "needs_review" | needs_review 需人工校对 |

## 展示层适配规则

1. 答案拆分：answer 若含「\n解析：」，拆为「答案值 + 解析」两段渲染（引擎暂未拆 solution 字段）
2. 图片路径：拼接 `images/${path}`
3. 公式：`$..$` 行内、`$$..$$` 独立块，用 KaTeX auto-render
4. 留白：按 type —— choice 0px / subjective 378px（A4 纸张中 10cm）+ 未来 blank 151px（4cm）

## 变更流程

- 引擎 Question 字段变更 → 同步本文件与 viewer/viewer-types.d.ts → 跑 tests/viewer-contract.test.ts

---

## TypeScript 形态

本文件对应的 TS 类型声明在 `viewer/viewer-types.d.ts`（`ViewerQuestion`）。展示层应 import 该类型而非直接 import 引擎 `src/`，以维持解耦红线：viewer/ 目录内任何文件不得 import 引擎 src/ 的代码。
