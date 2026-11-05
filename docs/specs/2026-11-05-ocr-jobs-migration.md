# SPEC：整页补行引擎迁移（MCP → 直连作业接口，B-28 批次 1）

> 日期：2026-11-05。状态：**批次 1 实施**（对照引擎，不接 daily）。
> 背景与证据：`docs/BACKLOG.md` B-28、`docs/evidence/2026-11-04-识别链路与OCR工具盘点.md` §4.2/§8、`docs/evidence/2026-11-03-paddle-two-routes-probe.md`。

## 1. 目标与边界

- **目标**：整页 OCR 补行从 MCP 通道（只回 markdown 文本）迁到**直连作业接口**（回 `prunedResult`：块级 `block_bbox`/行级框 `rec_polys`+`rec_texts`+`rec_scores`），用**行框直接落位**替掉「按宽摊字符」。
- **边界**：本批次只做**整页路径**（摊字符之痛所在）；区域裁图路径（`ocr-fill.ts`）后续批次。迁移期**双引擎并存**：MCP 路径一行不改，jobs 引擎以**独立脚本 + 独立产物文件**接入，A/B 后才谈翻默认接线。

## 2. 架构决策

| 决策 | 内容 | 理由 |
|---|---|---|
| 独立脚本 | `scripts/ocr-page-fill-jobs.ts`（对照引擎，手动跑） | 不动现有链路，回滚 = 删文件 |
| 独立产物 | `data/out/<doc>/ocr-page-fill-jobs.json`（不覆盖 `ocr-page-fill.json`） | 下游 `export-stages` 消费不变 ⇒ 默认行为零变化 |
| 不接 daily | 手动 `node --import tsx scripts/ocr-page-fill-jobs.ts <docId> [--pages ...]` | A/B 结论出来前不进产线 |
| 坐标口径 | Paddle 行框 `norm`(0..1) × stages 页宽高 → pt | 与洞（stages pt 域）同域可比 |
| 行框直接落位 | 行框∩洞（重叠/行框面积 ≥ `LINE_HOLE_OVERLAP_MIN`）且列一致 ⇒ 候选 | 替掉摊字符；一行多洞/一洞多行按先到先得+冲突报警（B-32 1:1 教训） |

## 引擎参数面基线（V3，全部有实测依据，见盘点 §4.2 分档表）

| 参数 | 值 | 依据 |
|---|---|直连可选，MCP 传不到 |
| `useChartRecognition: false` | 补行只需文本；图表 HTML 是候选噪声（A3′③：MCP 默认 true 直连 false，显式关） | 直连可选，MCP 传不到 |
| `prettifyMarkdown: false` | 少一层服务端改写；改写权留本地（红线对称性） | 支线实测改输出密度 |
| `showFormulaNumber: false` | 公式串纯净（编号只在 B-31 公式审计抽样时开） | 支线实测有效 |
| 页眉页脚 | 基线**不传** `markdownIgnoreLabels`（本地 `isPageFurniture` 判据保留为唯一防线） | 三方案对照是批次 2 实验 |
| 分辨率 | 沿用 1300px 目标宽（与 MCP 路径同口径，梯度探针是批次 2） | A/B 同输入对齐 |
| 温度等生成参数 | 不传（A3′① 实测默认可复现） | 少变量 |

## 4. 匹配与判据（L2 最严 AND）

- 洞发现：与 MCP 路径同源（`uncovered` content + 宽/高 ≥ 1.5）。
- 行→洞：`重叠面积/行框面积 ≥ 0.6` **且** 列一致（洞与行 x0 同侧）**且** 行文本 ≥2 硬字符。
  - ⚠️ 注记（2026-11-05）：上式分母实测不可达——V3 行框是整视觉行、MinerU 洞是行内碎片（行框比洞高 1.4–1.7 倍），真配对上限 0.33–0.59，字面跑 4 页 14 洞 0 命中；**经用户批准改分母=洞面积**（行框盖住洞 ≥0.6），依据与实测见 `scripts/ocr-page-fill-jobs.ts` 头注。
- 一行多洞：行文本按洞宽比例切分（复用 `splitTextAmongHoles`？——**不**。行框直接对多洞时只取重叠最大的洞，其余报警 `lineMultiHole`）——**先到先得 + 冲突记录**，不猜。
- 一洞多行：按 y 序全收、拼进同一候选（洞是“横向碎片”宽高比≥1.5 ⇒ 以单行为主，多行=跨行洞，拼行是正确语义）。
- 判据：`$` 成对 + 宽度比 ∈ [0.45, 1.9]（洞宽/(em×字号)）+ 期望字数 ≥1.6（全部与 MCP 路径同阈值，A/B 可比）。
- `rec_scores` 进候选元数据（`score` 字段），**不用 score 丢内容**（检测不改写：score 只记录不过滤）。

## 5. 验收口径

| 项 | 口径 |
|---|---|
| A/B | 答案册-合订本抽 3 页（含页眉页脚页），MCP vs jobs：候选数、accepted 数、`$` 成对率、score 分布 |
| 老行为 | MCP 路径零改动 ⇒ ocr-page-fill.json 逐字节不变 |
| check | 全绿（jobs 脚本不入 check；B-33 测试已锁清洗层） |
| 接线条件 | A/B 达标（jobs 候选数 ≥ MCP 且零串位样本）才翻默认 + 接 daily（批次 2） |

## 6. 回滚

独立脚本+独立产物+不接 daily ⇒ 默认行为零变化；回滚 = 删脚本与产物文件，仓库零痕迹。