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
