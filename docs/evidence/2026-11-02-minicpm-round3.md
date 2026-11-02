# MiniCPM-OCR 第三轮 P0-3 — 逻辑块真实错误复测（P0-G）

> **状态**：P0-G **未通过（整题级）**；行级真实错误仍强。按计划停在这里，
> P1-3/P2 未开始。
>
> **日期**：2026-11-02。分支：`feature/oxr`。
>
> **计划**：[`docs/plans/2026-11-02-minicpm-ocr-round3-workflow.md`](../plans/2026-11-02-minicpm-ocr-round3-workflow.md)。
>
> **证据**：`docs/evidence/2026-11-02-minicpm-round3-p0-*` + `...-round3-scripts/`。

---

## 0. 结论

| 评测单元 | n | AUC | best@correct | 结论 |
|---|---:|---:|---:|---|
| **整题级逻辑块**（correct/wrong 都是整题文本） | 54 | **0.582** | **68.5%** | **不可用** |
| 行级真实错误（第二轮复用） | 131 | 0.919 | **91.6%** | 仍强 |
| 行级 insert+replace（第二轮复用） | 123 | 0.942 | **94.3%** | 仍强 |

**一句话**：Jev 的评分单位是**短块/行**，不是“整道题”。把整题（题干+选项+公式）
当一条文本喂给它，正确项均值只有 0.0129，AUC 0.582，best 68.5%——
这不是“Jev 没用”，是**评测单元选错了**。

> 行级结果复用第二轮已经跑过的 131 条真实错误（同一模型/接口版本），不重复烧 token。

---

## 1. 方法

### 1.1 逻辑块

- 用 `questions.json` 的 `source.blockIndexes`（**全书全局序号**）映射到
  `normalizeLayout` 的全局块表；这是本轮修正的关键（之前按页内序号只命中少数题）。
- 输出 1805 个逻辑块（题号+出处+题干+选项），带 bbox/裁剪图；
- 对含图/表的题，图/表单独标记，不把图内文字拼进题干；
- 生成器：`docs/evidence/2026-11-02-minicpm-round3-scripts/build-logical-blocks.ts`。

### 1.2 真实错误案例

- 来源：`corrections/*.json` 的 `verified:true`（本批脚本遍历到 **136 条**）；
- 每条修正单独构造一个案例：`correct` = 修正后的整题文本，`wrong` = 把这条真实错误
  重新放回去的整题文本；
- 76 条能构造（**39 个唯一逻辑块**）；tesseract 两轮/放大回读后保留 **54 条**
  （**28 个唯一块**，8 本书）；
- **没有用合成错题凑数**；无法达到计划里的“120 个唯一逻辑块”，原因见 §3。

### 1.3 评分

- Jev `score_best`，每案例一张逻辑块裁图，候选 = [correct, wrong]；
- 54 条全部 `scored`，无内容策略拦截；
- 指标：AUC、best@correct、correct/wrong 分布、阈值曲线。

---

## 2. 结果

### 2.1 整题级

| 指标 | 值 |
|---|---:|
| n | 54 |
| AUC | 0.582 |
| correct 均值 / 中位 | 0.0129 / 0.0026 |
| wrong 均值 | 0.0066 |
| best@correct | 68.5% |

按错误类型：

| error_type | n | AUC | best@correct |
|---|---:|---:|---:|
| insert_line | 39 | 0.600 | 79.5% |
| o_to_zero | 14 | 0.500 | 42.9% |
| prefix_missing | 1 | 0.000 | 0% |

阈值（整题级）：

| 阈值 | 正确放行 | 错误放行 | 误复核 |
|---:|---:|---:|---:|
| 0.005 | 38.89% | 20.37% | 61.11% |
| 0.01 | 24.07% | 12.96% | 75.93% |
| 0.02 | 11.11% | 11.11% | 88.89% |

**没有可用的工作点**：正确放行和错误放行一起塌，说明不是“阈值没调好”，是单元不匹配。

### 2.2 行级（第二轮复用）

| 组 | n | AUC | best@correct |
|---|---:|---:|---:|
| insert+replace | 123 | 0.942 | 94.3% |
| 全部行级（含 replace_text 可评测） | 131 | 0.919 | 91.6% |

行级真实错误在 0.02 阈值下：正确放行 80.49%、错误放行 1.63%、误复核 19.51%
（详见 `docs/evidence/2026-11-02-minicpm-p0p1.md` §7）。

---

## 3. 为什么整题级失败 / 为什么没凑够 120

### 3.1 单元不匹配（主因）

- Jev 的输入形式是“原图 + OCR 文本 + 文本渲染图”；整题文本通常几百字、带多行/多栏/
  公式/选项，渲染图的排版和原图差异大，分数被拉低；
- `correct` 和 `wrong` 只差一行/一个字符，但放在整题长文本里，Jev 更难对齐；
- 行级/短块时，文本和裁图几乎一一对应，分数才稳定（第二轮 94.3%）。

### 3.2 数据限制（不是模型结论）

- 136 条 verified 修正只落在 **39 个唯一逻辑块**（76 条案例）；
- OCR 对齐后 54 条、28 个唯一块；
- 要凑 120 个**唯一逻辑块**，需要更多独立真实错误来源（更多书的 corrections/答案册/
  Word 对账），本轮没有；
- 没有拿合成错题凑数，也没有把同一块重复 120 次冒充 120 个块。

---

## 4. P0-G 决策（需要你选）

| 选项 | 做法 | 代价/影响 |
|---|---|---|
| **A（推荐）** | 接受“Jev 只做行级/短块评分”，不再评整题；用第二轮 131 条行级真实错误作为标定，继续 P1-3 | 放弃“整题一个分数”；但行级 94.3% 的结论保住，P1-3 不被阻塞 |
| **B** | 把逻辑块再拆成“题干段 / 每个选项 / 公式 / 表格行”子块，重做 P0-3 | 更贴近 Jev 能力，但要多一轮裁图/标定；P1-3 暂缓 |
| **C** | 暂停 Jev，先做 P1-3（30 页/表格/公式）；Jev 之后再说 | 不阻塞 MiniCPM 第三源验收；Jev 结论悬空 |

**不推荐**：继续用整题级分数调阈值（数据已证明没有工作点）。

---

## 5. 证据与复现

| 文件 | 内容 |
|---|---|
| [`2026-11-02-minicpm-round3-p0-cases.json`](2026-11-02-minicpm-round3-p0-cases.json) | 76 条逻辑块真实错误案例（correct/wrong/bbox/裁图） |
| [`2026-11-02-minicpm-round3-p0-aligned.json`](2026-11-02-minicpm-round3-p0-aligned.json) | 76 条 + tesseract 对齐分数 |
| [`2026-11-02-minicpm-round3-p0-results.json`](2026-11-02-minicpm-round3-p0-results.json) | 54 条 Jev 评分结果 |
| [`2026-11-02-minicpm-round3-p0-summary.json`](2026-11-02-minicpm-round3-p0-summary.json) | 整题级/行级汇总 |
| [`2026-11-02-minicpm-round3-scripts/`](2026-11-02-minicpm-round3-scripts/) | 逻辑块生成、案例构造、OCR 对齐、Jev、分析脚本 |

复现顺序（仓库根目录）：

```bash
node --import tsx docs/evidence/2026-11-02-minicpm-round3-scripts/build-logical-blocks.ts
python3 docs/evidence/2026-11-02-minicpm-round3-scripts/build-p0-cases.py
python3 docs/evidence/2026-11-02-minicpm-round3-scripts/align-logical.py
python3 docs/evidence/2026-11-02-minicpm-round3-scripts/run-jev-logical.py
python3 docs/evidence/2026-11-02-minicpm-round3-scripts/analyze.py
```

> `build-logical-blocks.ts` 的 import 已按归档目录调整为 `../../../src/normalize.js`；
> 运行前确保 `MiniCPM_API_KEY` 可用。

---

## 6. 未做

- P1-3（30 页/表格逐单元格/公式逐条）：按计划 P0-G 未通过，未开始；
- P2-2（只读适配器）：未开始；
- 生产代码：未改；
- 本轮没有新增 API 成本用于行级复跑（复用第二轮结果）；整题级 54 条只调用一次。
