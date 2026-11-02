---
intent: 用「逻辑块真实错误」+「表格/公式金标准」完成 MiniCPM/Jev 的第三轮验收；只有 P0/P1 两道人工门都通过，才写 P2 只读适配器。
success_criteria: P0-3 至少 120 个逻辑块真实错误全部评分并产出分类阈值/margin 曲线；P1-3 30 页题号覆盖 ≥98%、表格单元格一致 ≥90%、公式逐条一致 ≥85%、0 个未解释逆序；两道 human gate 通过后才写 P2-2 只读适配器；npm run check 全绿；证据落 docs/evidence/2026-11-02-minicpm-round3-*；每步绿后本地提交（不 push）。
risk_level: high
auto_approve: true
branch: feature/oxr
worktree: false
dirty_worktree: allow
---

# MiniCPM-OCR 第三轮验收 — 合并任务计划

> **一句话**：先把“整道题”这把尺子修准，再用 30 页表格/公式金标准量一遍，
> 最后才决定接不接生产线。
>
> **当前基线**：第一轮 P0/P1 提交 `9a23201`；第二轮 P0-2/P1-2/P2 提交 `fe7555d`。
> 真实 block 级（insert+replace，n=123）Jev best@correct **94.3%**；
> 22 页题号覆盖 **106/106**、0 额外、0 真逆序；表格在机械能 p1/p3 单元格 18/18、20/20 完全一致。
> 详细报告：[`docs/evidence/2026-11-02-minicpm-p0p1.md`](../evidence/2026-11-02-minicpm-p0p1.md)。
>
> **不做什么**：不改生产线、不静默替换、不用合成错题当验收、不把 chart 文本当内容、
> 不在 P0/P1 门通过前写适配器。
>
> **执行记录（2026-11-02）**：Step 1–3 已执行；**P0-G 未通过（整题级）**——
> 整题级 54 条 AUC 0.582 / best 68.5%，行级 131 条仍 91.6–94.3%。
> 详见 [`docs/evidence/2026-11-02-minicpm-round3.md`](../evidence/2026-11-02-minicpm-round3.md)。
> 按计划停在这里；P1-3/P2 未开始。

---

## 0. 目标与非目标

### 0.1 目标

1. **P0-3**：把第一轮/第二轮的行级裁图升级为**逻辑块裁图**（题号 + 出处 + 题干 + 选项），
   用 **≥120 个真实 OCR 错误**复测 Jev，产出按错误类型/书/长度的阈值与 margin 曲线。
2. **P1-3**：把 MiniCPM 第三解析源扩到 **30 页**，用独立来源做分母，
   表格**逐单元格**、公式**逐条 LaTeX** 对照，形成 go/no-go 依据。
3. **P2-2**：只有 P0/P1 两道门都通过，才写 **只读**适配器原型
   （`ocr.blocks[]` → 现有 layout 同构），跑 3 页对照；生产接入另行决策。

### 0.2 非目标

- 不做整本书/全库金标准；本轮是**验收采样**，不是全量认证。
- 不替换 MinerU 主解析，不改 `src/` 生产代码。
- 不覆盖 100 本/日吞吐；按 spec v0.3 的 1 本/日口径，本轮不测吞吐。
- 不把 Jev 分数当 CER/WER 或逐字符置信度。
- 不把图表（`label=chart`）的 content 当文本；图只走 bbox 裁图。

---

## 1. 共用数据契约（先定死，避免三件事各做一套）

### 1.1 逻辑块定义

一个**逻辑块** = 同一道题的 `题号 + 出处/来源标注 + 题干 + 选项`（如有），
按阅读顺序合并 bbox，不跨题、不跨栏混入邻题；表格/图单独成块。

- 来源：`questions.json` 的 `source.pageIndex + source.blockIndexes`；
  用 `normalizeLayout` 取页内行级块，再按题合并；
- bbox：所有块 union；裁图外扩 4px；若包含图/表，图/表区域单独标记；
- 文本：题干 + 选项按阅读顺序拼接；缺失前缀（`replace_text`）用修正后的 `to`；
- 每块必须记录：`block_id/book/page/bbox/anchor_text/correct_text/wrong_text/error_type/crop_path`。

### 1.2 错误类型（P0-3 必须分层）

| error_type | 含义 | 例子 |
|---|---|---|
| `o_to_zero` | 字母 O 认成数字 0 | `O点` → `0点` |
| `char` | 其他单字/单位错误 | `V` ↔ `A`、`增大` ↔ `减小` |
| `insert_line` | 整行/整段漏读 | 题号行、选项行、图注 |
| `prefix_missing` | 逻辑行缺前缀/半行 | `1 [人教版…]` 丢了前缀 |
| `formula_fragment` | 公式片段/公式被截断 | `距离为 $5s_1$` vs `s_1,` |
| `previous_line` | 上一视觉行续行被拆开 | 前缀在上一行 |
| `table_cell` | 表格单元格缺失/错位 | 单元格数字/公式错 |
| `other` | 无法归类 | 需写原因 |

### 1.3 指标与独立来源

- `best@correct`：`score_best` 选中正确候选的比例；
- `AUC`：正确 vs 错误候选的排序能力；
- **review budget 曲线**：在 5% / 10% / 20% 人工复核预算下，
  低分队列的错误捕获率 / 误复核率；
- `margin = score_correct - score_wrong`（单候选时用 `best_score - threshold`）；
- `precheck_reject` 单独计数，**不能当低分**；
- 独立分母：原卷页图、答案册、Word、tesseract、MinerU/Paddle；**被测对象不能当自己的分母**；
- chart 文本排除率、未解释逆序数、`failed` 块数。

### 1.4 成本上限

- 本轮 API 总预算 **≤500k tokens**（P0-3 约 120 块 + P1-3 30 页 + Jev 复核）；
- 超过预算先停、报告实际用量，不静默继续；
- 每批调用记录 `usage`，汇总到 evidence。

---

## 2. 文件与产物

| 路径 | 用途 |
|---|---|
| `tmp/minicpm-round3/` | 探针脚本、裁图、中间 JSON（临时） |
| `tmp/minicpm-round3/build-logical-blocks.ts` | 逻辑块裁图器（复用 `normalizeLayout`） |
| `tmp/minicpm-round3/build-real-cases.py` | P0-3 真实错误集构建 + OCR 对齐 |
| `tmp/minicpm-round3/run-jev.py` | Jev `score_best_batch`（断点续跑） |
| `tmp/minicpm-round3/analyze.py` | 阈值/margin/AUC/复核预算曲线 |
| `tmp/minicpm-round3/p1-parse.py` | 30 页 MiniCPM 解析 |
| `tmp/minicpm-round3/p1-gold.py` | 表格逐单元格 + 公式逐条对照 |
| `tmp/minicpm-round3/p2-adapter.ts` | **只读** adapter 原型（仅 gate 通过后） |
| `docs/evidence/2026-11-02-minicpm-round3-*.json` | 汇总/原始结果 |
| `docs/evidence/2026-11-02-minicpm-round3.md` | 本轮报告（追加新章节） |

> 本轮不改 `src/`；P2 adapter 只放 `tmp/`，跑通也只作为证据，不接生产。

---

## 3. Steps

- [ ] **Step 1：固化逻辑块裁图器（本地，无 API）**

**action**：
- 新建 `tmp/minicpm-round3/build-logical-blocks.ts`，复用 `src/normalize.ts` 的 `normalizeLayout`；
- 按 `questions.json` 的 `source.blockIndexes` 合并同题块，输出 bbox/文本/裁剪图；
- 对含图/表的题，单独输出 `image`/`table` 子块标记，不把图内文字拼进题干；
- 对 `replace_text` 的 `to` 文本，按修正后的完整逻辑行拼接；
- 生成 `tmp/minicpm-round3/logical-blocks.json`。

**verify**：
```bash
node --import tsx tmp/minicpm-round3/build-logical-blocks.ts
python3 - <<'PY'
import json
d=json.load(open("tmp/minicpm-round3/logical-blocks.json"))
print("blocks",len(d["blocks"]))
print("missing_bbox",sum(not b.get("bbox") for b in d["blocks"]))
print("missing_crop",sum(not b.get("cropPath") for b in d["blocks"]))
PY
```
人工抽 10 张裁图（3 文本 / 3 公式 / 2 表格 / 2 续行），确认 bbox 与文本一致；
不一致的块记录到 `logical-blocks-rejects.json`，不得带入下一步。

**loop**: until verify passes
**max_iterations**: 3

---

- [ ] **Step 2：构建 P0-3 真实错误集（≥120）**

**action**：
- 来源：`corrections/*.json` 的 `verified:true`（138 条）+ 答案册/Word 已核对修正；
- 每个逻辑块构造：
  - `correct_text` = 修正后/人工核对文本；
  - `wrong_text` = 修正前真实 OCR 文本（**不是合成篡改**）；
  - `error_type` 按 §1.2 分层；每类 ≥15，总 ≥120；
- 用 tesseract 两轮回读（2× 放大 + psm 6/7/11）校验裁图与 `correct_text`；
  对齐率 <0.2 的块剔除并记录原因；
- 输出 `tmp/minicpm-round3/p0-cases.json` 和 `p0-rejects.json`。

**verify**：
```bash
python3 tmp/minicpm-round3/build-real-cases.py
python3 - <<'PY'
import json
from collections import Counter
d=json.load(open("tmp/minicpm-round3/p0-cases.json"))
c=Counter(x["error_type"] for x in d["cases"])
print("total",len(d["cases"]),dict(c))
print("verified_true",sum(x.get("verified") for x in d["cases"]))
print("synthetic",sum(x.get("synthetic",False) for x in d["cases"]))
assert len(d["cases"])>=120
assert all(v>=15 for v in c.values() if v)
assert sum(x.get("synthetic",False) for x in d["cases"])==0
PY
```
> 如果某类真实样本不足 15，**不拿合成样本凑数**；在报告里登记缺口，并用相近类别补足总数（同类合并需注明）。

**loop**: until verify passes
**max_iterations**: 3

---

- [ ] **Step 3：跑 Jev P0-3 + 阈值报告（P0-G）**

**action**：
- `tmp/minicpm-round3/run-jev.py`：`score_best_batch`，每批 ≤8 块；
  对内容策略 400 单条跳过并记录；断点续跑；
- `analyze.py` 输出：
  - 按 `error_type` / `book` / 长度分层的 `best@correct`、AUC、correct/wrong 均值/中位；
  - 5%/10%/20% 复核预算下的错误捕获率 / 误复核率；
  - 推荐阈值 + margin；单候选高风险规则；
  - `precheck_reject` 率与原因；
- 报告追加到 `docs/evidence/2026-11-02-minicpm-round3.md`。

**verify**：
```bash
python3 tmp/minicpm-round3/run-jev.py
python3 tmp/minicpm-round3/analyze.py
python3 - <<'PY'
import json
d=json.load(open("tmp/minicpm-round3/p0-summary.json"))
print(json.dumps(d["block_level"],ensure_ascii=False,indent=2))
assert d["block_level"]["n"]>=120
assert d["block_level"]["best_at_correct"] is not None
PY
```
**gate: human（P0-G）**：
- 用户看报告，决定 Jev 是否可进入“只读路由”；
- 若 ≥20% 的块仍因裁图/单元问题失败，先回 Step 1/2 修单元，不得直接下“模型不行”的结论；
- 通过后才进 Step 4；不通过则停止 P2。

**loop**: false
**max_iterations**: 1

---

- [ ] **Step 4：P1-3 30 页解析**

**action**：
- 从 22 页扩到 30 页：补侧栏、跨页、答案页、图表页、公式密集页；
- 每页跑 MiniCPM 同步 `document-parse`，保存原始响应；
- 记录耗时、`failed` 块、`skipped_no_vlm`、chart 块与 chart-as-table；
- 题号分母：`questions.json` 基线 + 独立来源（答案册/Word/tesseract）交叉；
- 输出 `tmp/minicpm-round3/p1-pages.json`。

**verify**：
```bash
python3 tmp/minicpm-round3/p1-parse.py
python3 - <<'PY'
import json
d=json.load(open("tmp/minicpm-round3/p1-pages.json"))
print("pages",len(d["pages"]))
print("failed",sum(p["failed"] for p in d["pages"]))
assert len(d["pages"])>=30
PY
```
**loop**: until verify passes
**max_iterations**: 2

---

- [ ] **Step 5：表格逐单元格 + 公式逐条 LaTeX**

**action**：
- **表格**：选 ≥10 张表（优先有完整 MinerU 表的页）；
  - 用 MiniCPM table HTML + MinerU table HTML + 原卷页图三方对照；
  - 逐单元格比较文本/数字/公式；`rowspan/colspan` 先归一化；
  - 输出 cell-level 一致/差异清单；差异必须回原卷页图核对；
- **公式**：选 ≥50 条公式；
  - 比较 MiniCPM LaTeX vs MinerU/答案册 LaTeX，归一化后逐条对照；
  - 不一致的公式回原卷页图/答案册核对，标注“MiniCPM 对 / MinerU 对 / 都不对”；
- 输出 `p1-gold.json` + 报告。

**verify**：
```bash
python3 tmp/minicpm-round3/p1-gold.py
python3 - <<'PY'
import json
d=json.load(open("tmp/minicpm-round3/p1-gold.json"))
print("tables",len(d["tables"]),"formulas",len(d["formulas"]))
print("cell_agreement",d["cell_agreement"])
print("formula_agreement",d["formula_agreement"])
PY
```
**目标（首轮，可调）**：表格单元格一致 ≥90%，公式逐条一致 ≥85%；
低于目标时列出差异原因，不得只报总数。

**loop**: until verify passes
**max_iterations**: 2

---

- [ ] **Step 6：P1-3 决策门（P1-G）**

**action**：
- 汇总 30 页：题号覆盖、未解释逆序、表格/公式一致率、chart 编表率、失败块；
- 写 go/no-go 结论：MiniCPM 能否作为第三解析源（只读对照）；
- 更新报告 §P1-3。

**gate: human（P1-G）**：
- 通过标准（首轮）：题号覆盖 ≥98%、表格 ≥90%、公式 ≥85%、0 个未解释逆序；
- 任一不达标：先定位是模型、裁图、还是独立来源问题；不得直接进 P2。

**loop**: false
**max_iterations**: 1

---

- [ ] **Step 7：P2-2 只读适配器（仅两道门通过后）**

**action**：
- 新建 `tmp/minicpm-round3/p2-adapter.ts`：把 MiniCPM `ocr.blocks[]` 转成
  现有 layout 同构（页 → 块 → type/bbox/content）；**不写 `src/`**；
- 在 3 页上跑 `segmentFromLayout`（现有引擎一行不改），对比题号序列；
- 输出 `p2-adapter.json`：题号序列、差异、块映射数、无法映射的块；
- 只在 `docs/evidence/` 记录，不接生产。

**verify**：
```bash
node --import tsx tmp/minicpm-round3/p2-adapter.ts
node --import tsx -e "const d=require('./tmp/minicpm-round3/p2-adapter.json'); console.log(d.pages.length,d.diffs)"
```
**通过标准**：3 页题号序列与基线逐题一致，或差异逐条解释；
无法映射的块 ≤5% 且不影响题号/选项。

**loop**: until verify passes
**max_iterations**: 2

---

- [ ] **Step 8：收口、证据、提交**

**action**：
- 更新 `docs/evidence/2026-11-02-minicpm-round3.md`（追加，不改旧数字）；
- 更新 `docs/minicpm-ocr-evaluation.md` 的新章节（第三轮结论）；
- 更新 `docs/BACKLOG.md` / `docs/HANDOFF.md` 的相关未闭合项；
- 跑 `npm run check`，全绿后本地提交（不 push）。

**verify**：
```bash
npm run check
git status --short
```
**gate: human**：提交前确认证据链接、数字、结论与报告一致。

**loop**: false
**max_iterations**: 1

---

## 4. 决策门与 no-go

| 门 | 通过 | 不通过 |
|---|---|---|
| P0-G | ≥120 真实逻辑块；分类曲线可读；裁图/单元失败 <20% | 回 Step 1/2 修单元；修不好则停止 P2，报告“当前不可评测” |
| P1-G | 30 页；题号 ≥98%；表格 ≥90%；公式 ≥85%；0 未解释逆序 | 定位模型/裁图/独立来源；不达标不写适配器 |
| P2-G | 3 页题号序列一致或差异逐条解释；无法映射 ≤5% | 不接生产，保留只读原型 |

**总 no-go**：如果 P0-G 或 P1-G 不通过，本轮结论是“暂不接入”，
保留 MinerU/Paddle/Word 多源与 Jev 只读路由；不为了赶进度降低标准。

---

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 逻辑块裁图仍受页图/layout 偏移影响 | 每块 tesseract 回读；对齐率低的书先修坐标或换页图 |
| 真实错误样本不足 120 | 用答案册/Word 已核对修正补；**不用合成错题凑数** |
| 表格单元格金标准成本高 | 优先选有完整 MinerU 表的页；差异回原卷页图核对 |
| 公式 LaTeX 归一化误判 | 归一化规则固定并记录；差异逐条回原卷/答案册 |
| Jev 内容策略 400 | 单条跳过并记录；统计策略拦截率，不静默丢样本 |
| API 成本超预算 | 500k tokens 上限；超限先停并报告 |
| 适配器过早接生产 | P2 只写 `tmp/`，不改 `src/`；生产接入另开决策 |

---

## 6. 验收清单（Definition of Done）

- [ ] P0-3 ≥120 个逻辑块真实错误，0 合成；分类曲线、阈值、margin 报告完成；
- [ ] P1-3 30 页；题号覆盖、表格逐单元格、公式逐条报告完成；
- [ ] P0-G / P1-G 人工门有明确结论（通过/不通过 + 理由）；
- [ ] P2-2 仅在两道门通过后写只读 adapter；未改 `src/`；
- [ ] `docs/evidence/2026-11-02-minicpm-round3.md` 与 JSON 证据齐全；
- [ ] `npm run check` 全绿；本地提交（不 push）；
- [ ] 报告里明确写“未验证/不能下结论”的项。

---

## 7. 一句话交付口径

**大白话**：先拿“整道题”而不是“一行字”去量真实错误；再拿 30 页表格/公式去对独立答案；
两步都过了，才写接线层。任何一步不过，就停，不为了赶进度把没验收的东西接进生产线。

**专业版**：P0-3 逻辑块真实错误标定 → P1-3 30 页表格/公式金标准 → P2-2 只读 adapter；
P0-G/P1-G 双门通过是 P2 的前置条件；全程不改 `src/`、不静默替换、chart 文本黑名单。
