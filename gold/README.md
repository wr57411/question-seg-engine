# 金标准标签（gold/）

用途：给 `npm run score -- --all` 提供**独立于系统产物**的人工标签，算题目召回/精确、
选项完整性、答案配对、图片召回等指标。没有金标准，所有「准确率」都不可验收。

## 文件格式

一个文档一个 JSON：`gold/<docId>.json`。

```json
{
  "docId": "23必刷题 2相互作用",
  "complete": false,
  "source": "人工从原卷页图转写；非系统产物",
  "notes": "试点，只标了 2 题",
  "questions": [
    {
      "page": 4,
      "number": "1",
      "stem": "题干全文",
      "options": [{ "key": "A", "text": "选项全文" }],
      "answer": "A",
      "imageCount": 1
    }
  ]
}
```

- `page`：**0-based** 页号，与 `questions.json` 的 `source.pageIndex` 一致。
- `complete: true`：整本都标了，才计算 precision/误切；`false`：试点/部分，只算 recall 与匹配题上的选项/答案指标。
- `answer`、`imageCount` 可省略；省略的指标显示「—」，不冒充通过。
- 标签必须**回原卷页图**转写，不能从 `data/out/<docId>/questions.json` 复制；否则分母来自系统自身，指标无效。

## 命令

```bash
npm run score -- --all          # 评分并写 data/score/report.md
npm run score -- --all --gate   # 按 Phase 1 阈值判红（没有完整金标准时 exit 2）
npm run check:accuracy          # 同 --gate
```

## 当前

- `23必刷题 2相互作用.pilot.json`：**试点**，只标了 p5 第1题、p7 第5题（A–D 选项），
  用于验证评分器；`complete:false`，不能当整本准确率。
- 完整 30 本（A/B/C 分层）待补；见 `docs/specs/2026-10-28-batch-book-ingestion-spec.md` B01。


## 现有 7 本种子（2026-10-28）

`gold/registry.json` 登记了 `books/` 的 7 本：

| 类 | 书 | 状态 |
|---|---|---|
| A | 1 直线运动 / 3 运动和力的关系 / 4 曲线运动 | **seed-verified**：各标 1 题并回 p1 页图核对 |
| B | 光学 | worksheet：待标 |
| A | 动量守恒 / 机械能 | worksheet：待标 |
| C | 答案册-合订本 | worksheet：待标 |

- **完整标注前，`score --all` 只算这些书里已标部分的 recall/选项指标，不算 precision/整本准确率。**
- `gold/worksheets/*.md` 由 `npm run gold:worksheet -- --all` 生成：每本抽 5 题（首/25%/50%/75%/末），
  含页图路径、系统草稿（仅参考）、金标 JSON 模板。**必须回页图转写**，不能照抄系统草稿。
- 整本标完后把 `complete` 改成 `true`，`check:accuracy` 才会对这本书判门槛。
- `23必刷题 2相互作用.pilot.json` 是额外试点（2 题；不在 7 本 registry 内）。


## 新批试点（2026-10-28）

- `gold/教材基础练 磁场.pilot.json`：4 题（p1 第1-4题），从原卷页图转写；complete:false。
- `gold/物理_教材基础练 电路.pilot.json`：6 题（p1 第1-2题、p2 第3-6题），从原卷页图转写；complete:false。
- 两本已加入 `gold/registry.json`（status=pilot-verified）；融合产出当前对这两份小金标
  **R100/S100/O100**（磁场 4 题 / 电路 6 题），但仍是部分金标，不能当整本准确率。


## MinerU-only 新书试点（2026-10-29）

- `gold/物理_教材基础练 曲线运动.pilot.json`：3 题（p1 第2-4题），页图转写；complete:false。
- `gold/物理_教材基础练万有引力.pilot.json`：3 题（p1 第1题、p2 第2-3题），页图转写；complete:false。
- 用途：在 OXR 429 时先量 MinerU-only 是否可用。结果：两本 recall 均 **2/3**（各漏一道徽标题），
  曲线运动匹配题 strict/选项 **0%**（文本/选项不可用），万有引力匹配题 strict/选项 **100%**。
  ⇒ MinerU-only 不足以验收；OXR 恢复后走 `fuse:doc`。


## 按书选源后的 6 本新书（2026-10-29）

| 书 | 金标题数 | 选中来源 | R/S/O |
|---|---:|---|---|
| 教材基础练 磁场 | 4 | 融合 | 100/100/100 |
| 物理_教材基础练 电路 | 11 | 融合 | 100/100/100 |
| 物理_教材基础练 曲线运动 | 8 | OXR-only | 100/100/100 |
| 物理_教材基础练万有引力 | 3 | OXR + 融合补选项 | 100/100/100 |
| 物理_教材基础练 运动和力 | 7 | MinerU-only | 100/100/100 |
| 物理_教材基础练机械能守恒定律 | 3 | MinerU-only | 100/100/100 |

- 结论：**融合不是每本都更好**，必须按书用金标选源；6 本均只是 3–11 题部分金标，不能当整本准确率。

## 结构金标（`kind:"structure"`，2026-11-05 新增）

`gold/<docId>.structure.json` 是**只标 `(page, number)` 的题目清单**，用来算切题层的 recall / precision，与全文金标分开：

| | 全文金标（`kind` 缺省 / `"full"`） | 结构金标（`kind:"structure"`） |
|---|---|---|
| `questions[]` | `stem` / `options` / `answer` / `imageCount` 全文 | 只有 `page` / `number` / `stem:""` + 独立证据 |
| `complete:true` 的含义 | 整本全文转写完 | **题目清单完整**（不是全文完整） |
| 产出指标 | recall / precision / 严格文本 / 选项 / 答案 / 图片 | **只有 recall / precision** |
| `check:accuracy --gate` | 参与门槛 | **不参与**（不许拿清单冒充内容验收通过） |
| `autoPass` | 可按阈值判 | **恒 false** |

- 生成：`npx tsx scripts/gold-structure.ts`（只读交叉，不写 `data/out/`）。
- 独立证据：整页 OCR 题号行；无证据的题标 `needsReview`，回原卷页图核实后写 `pageImageChecked`。
- ⚠ **已知边界**：清单骨架来自 `gold/worksheets/*-full.md`，其 `(page,number)` 与 `data/out/<doc>/questions.json` 同源 ⇒ `recall/precision` 只作**评分器联调**，**不能读成系统准确率**；完全独立分母（逐页回原卷数题号）另立子目标。
- ⚠ 「两题并一题」仍可能让 precision 虚高：清单未标起止边界。
- 现存一份：`gold/物理_教材基础练 电路.structure.json`（31 题；OCR 证据 28 + 页图核实 3）。证据见 `docs/evidence/2026-11-05-电路独立题号交叉.md` 与 `docs/evidence/2026-11-05-电路独立题号页图/`。
