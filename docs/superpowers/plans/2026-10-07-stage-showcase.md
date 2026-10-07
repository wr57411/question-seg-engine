# 阶段样品展示（stage showcase）设计 —— 2026-10-07

## 背景与目标

用户（非技术背景）无法从 schema/置信度等专业维度审阅切分引擎，
但能从**可视化成果**一眼看出问题。要求：**每个处理阶段都有可通过网页访问的样品展示**。

目标：一条「白话叙事 + 每阶段可视化」的网页动线，让用户逐阶段看到
「电脑此刻把试卷理解成了什么样」，并配有该阶段**该看什么**的引导。

> 实现过程中需求演进为**自反馈环**：不仅用户能看，主模型自己也要能拿
> **原卷页图 ↔ 阶段输出**对照，自监督地发现问题并修复。
> 因此增加「阶段 0 · 原卷对照」（pdftoppm 逐页 PNG，无工具时降级 PDF 内嵌），
> 自反馈首轮发现项见 [docs/design/stages-review.md](../design/stages-review.md)。

## 阶段叙事（6 步，每步回答一个问题）

| # | 标签 | 回答的问题 | 可视化 | 用户该看什么 |
|---|------|-----------|--------|-------------|
| 0 | 原卷 | 原文长什么样？ | 原卷逐页 PNG（pdftoppm；缺工具降级 PDF 内嵌） | 先记住原页样子，作为后续对照基准 |
| 1 | 原料 | 机器读到了什么？ | MinerU 解析出的段级块按类型着色（标题/正文/图片/表格/公式） | 有没有整段文字丢失、图片框位置是否对 |
| 2 | 阅读顺序 | 电脑按什么顺序读？ | 归一化后的行级块 + 栏判定着色 + 阅读顺序编号徽章 | 编号 1→2→3… 是否符合人眼阅读顺序；单/双栏判定对不对 |
| 3 | 切题 | 题目切对了吗？ | 每题**逐块描边**（按题型着色，needs_review 红色）+ 首块挂牌 | 框是否完整套住一道题；跨栏/跨页题在每部分都挂牌 |
| 4 | 质检 | 电脑哪里没把握？ | 「需人工校对」与「诊断记录（含已兜底）」分离的白话报告 | 被标记「可疑」的题是否真有问题 |
| 5 | 成品 | 最终长什么样？ | 内嵌 /viewer/ 的 iframe | 整体是否可用 |
| 6 | 对比 | 跟原卷像不像？ | 左原卷页图 \| 右结构化数据按原坐标重建的纸面，同宽并排翻页同步 | 逐块对得上吗：文字少了没、图片在不在原位 |

## 架构（沿用 viewer 的解耦模式）

```
data/smoke/unpacked/layout.json（真实 MinerU 产物）+ _origin.pdf（原卷）
      │ scripts/export-stages.ts   ← 唯一可 import 引擎 src/ 的地方（构建期脚本）
      │   normalizeLayout → layoutPage → segmentFromLayout
      │   （可选）pdftoppm 渲染原卷逐页 PNG
      ▼
 data/out/<docId>/stages.json      ← 阶段快照（运行时产物，git 忽略）
 data/out/<docId>/origin.pdf|pages/ ← 原卷对照
      │
      ▼
 stages/ 前端模块（零依赖静态页）    ← 只消费上述快照/页图 + /viewer/ iframe
      │                               不 import 引擎代码（红线同 viewer/docs/CONTRACT.md）
      ▼
 scripts/view-server.ts            ← 增加放行 /stages 前缀，打印展示地址
```

- **快照即契约**：stages.json 是 stages/ 唯一数据源；引擎字段变更只影响 export 脚本，
  前端不感知。快照文本字段截断（块文本 ≤120 字符），只服务视觉审阅。
- **两条关键口径**（自反馈 F2/F3 的教训，tests/stages-export.test.ts 锁定）：
  1. `Question.source.blockIndexes` 是**跨页全局序号**（segmentWithRules 重写
     IndexedBlock.index），快照重建「全局序号 → 页内块序号」映射；
  2. 题目可能**跨页**：按「块的落页」分组，一道题在其块所在的每一页各出一条。
- **纯函数拆分**：`buildStageSnapshot(doc, result, rawPages)` 在 export 脚本内导出，
  用合成夹具离线断言。
- `npm run stages` = 导出快照 + 启动 view-server（打印 /stages/ 完整地址）。

## stages.json schema（v1）

```jsonc
{
  "version": 1,
  "docId": "23必刷题 2相互作用",
  "generatedAt": "ISO 时间",
  "stats": { /* SegmentationStats 原样 */ },
  "answerEntriesTotal": 0,          // 0 = 本卷无答案区，展示层换文案
  "originPages": 15,                // 原卷页图数量；0 = 未渲染，前端降级 PDF 内嵌
  "pages": [{
    "index": 0, "width": 596, "height": 821,
    "columns": 2, "centers": [178, 418],
    "raw":     [{ "i": 0, "type": "title", "bbox": [..], "text": "≤80字" }],
    "blocks":  [{ "i": 0, "kind": "text", "bbox": [..], "text": "≤120字", "img": "hash.jpg?" }],
    "order":   [7, 0, 1, ...],              // 阅读顺序的块 i 序列（下标即序号）
    "questions": [{ "id": "...", "number": "6", "section": "一、选择题",
                    "type": "choice", "blocks": [0,1,2], "confidence": 0.6,
                    "status": "needs_review", "reasons": ["重复题号"] }]
  }],
  "reviews": [{ "questionId": "...", "reason": "...", "snippet": "...",
                "pageIndex": 6, "blockIndex": 12 }]
}
```

- `raw` 来自 layout.json 原始 `para_blocks`（段级、带 MinerU type），服务阶段 1；
- `blocks` 是 normalize 后的行级块，服务阶段 2/3（引擎实际处理的粒度）；
- `questions[].blocks` 已是**页内序号**（引擎给的全局序号在快照层完成映射）；
- 同一题 id 可出现在多个页（跨页题），展示层按 id 去重统计、按页描边；
- `reasons` 为 rule-engine ReviewNote 的 reason 原文（中文短语，保持原样展示）。

## 前端形态（stages/）

- 单页 `stages/index.html`：顶部 5 步 stepper（当前阶段高亮）+ 页码导航（15 页）+
  主体「纸张画布」：按页面真实宽高比渲染，块用百分比坐标绝对定位，
  行块字号随 bbox 高度缩放（视觉近似原版面，非像素级还原）。
- 每个阶段主体上方固定一段白话说明条（做什么/看什么），不依赖用户读代码或术语。
- 阶段 4 支持点击条目 → 跳到对应页并高亮该题；阶段 5 内嵌 viewer iframe。
- `?doc=` 参数与 viewer 相同的宽容策略：缺失/非法时回退默认卷并在提示条说明。
- 数据缺失（未导出 stages.json）时显示引导：「运行 npm run stages 生成快照」。

## 明确不做（YAGNI）

- 不做像素级 PDF 渲染叠加（行块文本即视觉载体，离线可用，无需渲染 PDF）；
- 不做多卷切换 UI（?doc= 参数已支持，UI 后置）；
- 不改 viewer/ 任何文件（解耦红线，跨模块导航用 URL）。

## 验收

1. `npm run check` 全绿（含新增 stages-export 测试）；
2. 浏览器逐阶段截图 → 主模型视觉审板（A 组确立的验收主轴），
   发现项记入 `docs/design/stages-review.md` 并修复后复拍；
3. 15 页、85 题、2 条 needs_review 的口径与 viewer 终审记录一致（同一数据源）。
