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
