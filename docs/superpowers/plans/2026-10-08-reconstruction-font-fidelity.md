# 计划：重建纸面的字号保真（stage 6 对比模式）

**日期**：2026-10-08
**Spec（权威）**：本计划「已定案事实」一节 —— 全部数字来自对**原卷页图墨迹**的直接测量，
证据文件 `data/out/ink-groundtruth.md`、`data/out/font-calibration.md`、`data/out/fidelity-analysis.md`。
**前置**：工作区已有一份未提交改动（`stages/stages.js` + `stages/stages.css`，字号改为按行高推算 +
文字不裁切）。本计划在其之上继续。

---

## 问题陈述

stage 6「对比模式」并排渲染「原卷页图 | 结构化重建」。重建由解析数据构建：每个行级块是绝对定位
div，位置来自 MinerU bbox，**字号由代码推导**（MinerU 输出无字号字段，已确认）。

实测：**重建文字比原卷小 30%**，右侧大量留白、左右无法逐字对照，对比模式失去作用。

## 已定案事实（本计划的唯一数值权威）

| # | 事实 | 证据 |
|---|------|------|
| F1 | 原卷行 bbox **紧贴墨迹**：横向内边距合计 1.58pt（行宽的 0.7%），纵向 0.22pt（125 行样本，阈值 100/128/160 下稳定） | ink-groundtruth M1 |
| F2 | 原卷正文真实字号 `S_ink = 墨迹宽 / 全角字数`，中位 **11.29pt** | ink-groundtruth M2 |
| F3 | 现行 `fontPx = hPx * 0.72` 等价于 `font_pt = 0.72 × bboxH_pt`；对 11pt 正文行只给出 **7.92pt** → **偏小 30%** | ink-groundtruth M3 |
| F4 | **定案系数 `c = 1.03`**：`fontPx = hPx × 1.03`（`hPx = bboxH_pt / pageWidth_pt × canvasW`）。修正因子 1.43 | ink-groundtruth M3 |
| F5 | 垂直不成问题：按 F4 渲染，浏览器整行墨迹高 0.961em vs 原卷 0.938em，**只高 2.3%** → **宽高可同时对齐，不需要牺牲任何一个** | ink-groundtruth M5 |
| F6 | 按 F4，渲染宽恒 < bbox 宽 → **不新增块间溢出**（此前测得的 32 对溢出源于系数取 1.475，比真值大 3%） | ink-groundtruth (e) |
| F7 | 字号存在离散层级：正文 11.3pt（单峰，125 行仅 1 行 >14pt）、栏头 ~15pt、章/节标题 16.6–21.3pt（1.5–1.9×）。**逐行 bboxH 推导已能自动复现层级，无需层级表** | ink-groundtruth M4 |
| F8 | 对比模式两栏缩放一致：0.7718 px/pt（460px / 596pt）→ 左右对照可信 | fidelity-analysis Q7 |
| F9 | `layout.json` 无任何字号字段；`bbox_fs` 是 span 并集的紧包围盒，不是字号 | 本机字段普查 |
| F10 | 尺度常量有两个口径，勿混用：`CANVAS_W = 760`（阶段 1/2/3/4/5 画布）、`PANE_W = 460`（对比模式单栏） | stages.js |

### 被推翻的旧前提（必须记录）

未提交代码的注释写着「浏览器字体（宋体）比原卷印刷体**宽**，文本会**超出** bbox，故不裁切」。
**实测否定**：CJK 全角在印刷体与 Songti SC 中都精确 1em（度量误差为 0）；真实缺陷是字号**偏小 30%**，
文字**填不满** bbox。方向搞反了。

## Global Constraints（绑定）

- **G1 不静默失败**：低置信度必须标 `needs_review` + 产出 `ReviewNote`；展示层不得悄悄丢内容
  （**裁切文字 = 静默丢内容**）。
- **G2 检测不改写**：`src/formula.ts` 只统计不修改；数据清洗必须是显式独立决策。
- **G3 解耦**：`viewer/` 与 `stages/` 只消费快照，**不得 import 引擎 `src/`**；唯一例外是构建期脚本。
  本计划不动 `src/`。
- **G4 回原卷核对**：任何「美化」必须先对照原卷页图确认，不得凭推断（2026-10-08 曾两次因此翻车）。
- **G5 质量门**：`npm run check`（typecheck + test + audit:render）必须全绿。
- **G6 验收双轨**：文本全量清点 + **逐页截图视觉审板**，两条都要跑全量，只做抽查会漏。
- **G7 基线**：15 页 / 1061 行级块 / 85 题 / 诊断 6 条 / 需人工校对 3 题；测试 **91 例**；渲染审计 9 项归零。
- **G8 判据分级**（沿用 550d99e 约定）：**判定项**（机器能确定的对错）计入退出码；
  **提示项**（机器无法判断、需人看一眼）只展示。

## Non-goals（明确不做）

- 不做字号层级聚类（F7：逐行推导已够，加表是过度设计）。
- 不做水平 `scaleX` 拉伸 / 逐块宽度拟合（F5：宽高可同时对齐，无需牺牲字形）。
- 不动引擎 `src/`、不改快照契约（`scripts/export-stages.ts` 的 `StagePage`/`StageBlock` 形状不变）。
- 不重做视觉风格（虚线丢弃块、块描边、题号牌等既有约定不动）。

---

## Task 1：抽出可测的字号模块 + 修正系数

**为什么**：系数是全案唯一的改动点，但它现在藏在无构建的浏览器脚本里、**没有任何测试**。
抽成纯函数模块，才能把它钉死在测试里（沿用 `stages/latex-display.js` + `.d.ts` + 测试的既有范式）。

**产出文件**

1. 新建 `stages/font-metrics.js`（ESM 纯函数，无任何依赖）：
   - `export function fontFromLineHeight(hPx)` → `Math.max(4, hPx * 1.03)`
     （4 是安全下限，非保真夹子；旧代码 8–20px 夹子已在上一轮移除，不要加回来）
   - `export function baseFontOfPage(blocks, pageWidth, canvasW)` → 与现行语义一致：
     取「不含 `\frac`/`\sqrt`/`_`/`^` 的文本块」的 bbox 高中位数，换算后过 `fontFromLineHeight`；
     无可用块时返回 `null`
   - `export function fontForBlock(block, pageWidth, canvasW, baseFont)` → 文本匹配
     `/\\frac|\\sqrt|[_^]/` 时返回 `baseFont`（为 null 时回退行高推算），否则返回
     `fontFromLineHeight((block.bbox[3] - block.bbox[1]) / pageWidth * canvasW)`
   - `export function emWidthOf(text)` → 全角当量宽度和（供 Task 2 的审计用）：
     全角/CJK（含全角标点）= 1.0；ASCII 字母数字 = 0.5；ASCII 空格 = 0.25；
     其余可见 ASCII 标点 = 0.3；`\n`/`\t` = 0
   - **模块头注释必须写入 F1–F6 与「被推翻的旧前提」**，并注明来源
     `data/out/ink-groundtruth.md`、测量方法（原卷页图墨迹二值化 → 墨迹包围盒 → `墨迹宽/全角字数`）
2. 新建 `stages/font-metrics.d.ts`（照 `latex-display.d.ts` 的写法，供 TS 测试 import）
3. 改 `stages/stages.js`：删掉本地的 `fontFromLineHeight` / `baseFontOfPage` / `fontForBlock`，
   改为 `import { baseFontOfPage, fontForBlock } from "./font-metrics.js";`；
   所有调用点的实参顺序保持现状（`CANVAS_W` 或 `PANE_W` 作为 `canvasW` 传入）
4. 新建 `tests/font-metrics.test.ts`，**至少 8 例**，全部用精确值：
   - `fontFromLineHeight(14.032)` ≈ `14.453`（±0.01）—— 11pt 正文行的 `hPx`（`11*760/596`）
   - 正文行回归：`fontFromLineHeight(11*760/596) / (760/596)` ≈ `11.33`（±0.1）——**换算回 pt 的字号**
   - 标题行回归：`fontFromLineHeight(18*760/596) / (760/596)` ≈ `18.54`（±0.1）
   - 下限：`fontFromLineHeight(0) === 4`、`fontFromLineHeight(1) === 4`
   - 对比模式口径：`fontFromLineHeight(11*460/596) / (460/596)` ≈ `11.33`（±0.1）
     （**这条是防「混用 760/460 口径」的锁**）
   - `emWidthOf("重力") === 2`；`emWidthOf("A.0.20") === 2.6`；`emWidthOf("") === 0`
   - `baseFontOfPage`：给一个含 3 个正文块 + 1 个含 `\frac` 块的假页，断言公式块被排除、
     返回值等于正文块行高推出的字号
   - `fontForBlock`：含 `^` 的块返回传入的 `baseFont`；`baseFont` 为 null 时回退行高推算

**验收**
1. `npm run check` 全绿，测试数 91 → ≥99；`git diff` 中 `stages.js` 只剩 import 与删除，
   无残留旧函数定义。
2. **浏览器冒烟（必须做，不可省）**：`stages/*.js` 是纯 JS，**不在 `tsc --noEmit` 与测试的覆盖范围内** ——
   抽模块若留下悬空引用，typecheck 与单测都不会报，只有浏览器会白屏。故必须用 headless Chrome
   加载 `http://localhost:4173/stages/?doc=23%E5%BF%85%E5%88%B7%E9%A2%98%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8&stage=6&page=0`
   （服务已在 4173 运行；未运行则 `npm run view:server`），断言：
   - 页面里 `.blk-line` 数量 ≥ 50（渲染没崩）
   - 取一个已知的 11pt 正文行块，其 `.txt` 的 `getComputedStyle().fontSize` ≈ **8.74px**
     （对比模式口径：`11 × 460/596 × 1.03`，±0.1）
   - 控制台无 `Uncaught` / `Failed to resolve module` 类错误
   探针与原始输出写到 `data/out/`（git 忽略）。

## Task 2：保真度判据进审计门

**为什么**：本轮事故的根因是**判据太松**——旧审计只看「语法零残留」，看不到「字号错 30%」。
必须把「字号保真」变成可自动判定的项，否则下次还会漏。

**产出文件**

- 改 `scripts/audit-render.mjs`：新增一节「字号保真度」（`import { emWidthOf, fontFromLineHeight } from "../stages/font-metrics.js"`）
- **判据**（对快照 `data/out/<docId>/stages.json` 逐块算）：
  - 取「可判块」：文本**无 ASCII 字母数字、无 `\`、无 `$`**，全角字数 ≥ 6，
    且 `bboxW_pt / 全角字数 ∈ [6, 22]`（排除短行与坏 bbox）
  - `F_render = fontFromLineHeight(bboxH_pt / pageWidth * 760)`（画布 px）
  - `F_width  = (bboxW_pt / pageWidth * 760) / emWidthOf(text)`（宽度隐含字号，画布 px）
  - `ratio = F_width / F_render`
  - **判定项**：可判块 `ratio` 的**中位数**必须落在 **[0.93, 1.07]**，否则非零退出
  - **提示项**：单块 `ratio` 超出 `[0.85, 1.15]` 的块数与清单（只展示，不计退出码）
  - 可判块数为 0 时**判定失败**（防止判据被静默架空）
- **基线对照（实现时必须自己验一遍并写进输出）**：把系数临时改回 `0.72` 时，
  中位 `ratio` 应 ≈ **1.43**（即判据确实能抓到当前这个 bug）；改成 `1.03` 后应 ≈ **1.0**。
  两个数字都要出现在报告的验证记录里。

**验收**：`npm run check` 全绿；审计输出里能看到「字号保真度」一节及其中位 `ratio` 与可判块数；
反向验证（临时改回 0.72）确实让该节报红。

## Task 3：逐页截图视觉审板 + 文档落库

**为什么**：G6 要求视觉审板跑全量；且 F1–F7 的证据链、被推翻的旧前提都必须落库，
否则下一轮又会凭推断动手。

**产出**

1. 重拍 **15 页**对比模式截图 → `docs/design/stages-cap/pages/compare-p0..14.png`
   （用 `?stage=6&page=N` 直达；headless Chrome，一次循环 ≤5 页，分批）
2. 重拍阶段 1/2/3 代表页 → `docs/design/stages-cap/`（沿用既有文件名）
3. **逐页视觉审板**，每页逐项检查并在报告中给出结论：
   - ① 字号是否与原卷肉眼一致（左右并排，同一行文字高度/宽度是否相当）
   - ② 是否出现新的块间碰撞（文字压到相邻块）
   - ③ 垂直基线是否整体偏高/偏低（字形在框内是否上下居中）
   - ④ 选项分隔（EM SPACE）是否仍正常
   - ⑤ 竖排分式（`.frac` / `.sqrt`）是否仍正常
   - ⑥ 是否有文字被裁切（G1）
4. 写 `docs/design/stages-review.md` 新增一节（本轮）：记录 F1–F7、被推翻的旧前提、
   逐页结论表、以及**未能解决的残留问题**
5. 写 `docs/DECISIONS.md` 新增一节：记录「字号保真」决策（定案系数 1.03 及其测量依据、
   被推翻的旧前提、判据分级）
6. **明确给出 `.blk { overflow: visible }` 的去留结论**：按 F6 溢出不再发生，
   故保留 `visible`（避免 G1 的静默裁切）；但若审板发现个别块确实溢出并压到邻块，
   必须如实报告，**不得悄悄改成 `hidden`**（那是静默丢内容）

**验收**：15 页截图齐全且时间戳晚于代码改动；审板报告逐页有结论；残留问题如实列出。

---

## 任务依赖

T1 → T2 → T3（严格串行：T2 依赖 T1 的模块；T3 依赖 T1 的效果与 T2 的绿灯）。
