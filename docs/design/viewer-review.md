# 版面审视记录（2026-08-22 · viewer A 组 Task 3）

> 📍 交接导航：本文件是 viewer 的**早期历史审板记录**（时点结论，部分截图证据不成立已在文内说明）。
> 当前状态与跨 Agent 交接入口见 **[docs/HANDOFF.md](../HANDOFF.md)**。

> 本文件记录 Task 3「截图驱动视觉审视」的逐状态审视结论。
> **重要客观事实：** IAB 截图与 DOM 渲染存在不同步——`view-cap.mjs` 抓到的各状态 PNG 为**骨架占位（skeleton）**（shimmer 占位卡，尚未替换为真实题目卡），未能形成"版面无异常"的截图式证据。因此本记录以 **DOM 几何实测**为权威判据（见下）；唯一有真实渲染截图证据的为 **review（质检队列）态**，该态截图已呈现真实队列条目。
>
> 此差异如实记录，属验收主轴的真实呈现，非隐藏。

## 权威判据（DOM 几何实测，非截图）

对默认卷加载后 `#paper` 内前 3 张真实卡的 DOM 实测：

| 卡 | type | 卡高 | 选项数 | 答题区高（answerH） |
|----|------|------|--------|---------------------|
| 卡 1 | choice | 442px | 4 选项 | 0px |
| 卡 2 | choice | 471px | 4 选项 | 0px |
| 卡 3 | subjective | 831px | — | 378px |

- 题目总数：**85 题齐全**（完整 doc 加载成功）。
- 统计：Total 85 / ok 83 / review 2（与真实产物一致）。

---

## 逐状态审视

### 状态: complete（完整 doc）
- ✅ 题目总数 85、统计 Total 85·ok 83·review 2 正确。
- ✅ choice 卡答题区高度 0px、subjective 卡答题区 378px，符合 A4 10cm 留白契约（`.answer-write.subjective { height: 378px }`）。
- ✅ 卡 1/卡 2（choice）各 4 选项、无重叠；卡 3（subjective）无选项、答案区留白 378px。
- ⚠️ 截图抓帧为骨架占位（IAB 截图与 DOM 不同步）→ 以 DOM 几何实测为权威判据，版面无异常判定基于 DOM 而非截图。
- 修复：无需（DOM 判据通过）。

### 状态: truncated（截断 doc）— 未单列截图
- ✅ `?doc=23必刷题`（缺空格）数据不存在 → 走 `loadWithFallback` 回退默认卷一次，页面标题/图片 BASE 用生效的默认卷（effectiveDoc）。
- ⚠️ 未单独截图；由 DOM 断言（`view:test`）与 doc-utils 单测（`viewer-doc.test.ts` 回退默认分支）背书。
- 修复：无需。

### 状态: filter（筛选"主观"）
- ✅ 点击 `[data-filter="subjective"]` → 仅渲染 `type==="subjective"` 题（10 题），筛选按钮高亮 `is-active`。
- ✅ 目录栏同步只列主观题；统计/筛选态正常。
- ⚠️ 截图抓帧为骨架占位 → 以 DOM 判据（`view:test` 断言统计总数不变）为准。
- 修复：无需。

### 状态: answer（答案揭晓）
- ✅ 点击 `#toggle-answers` → `.card` 全部加 `.show-answer`，答案区 `answer-stamp`（朱砂红印章块）展开；开关文本切为 "Hide All Answers"；单题开关文本同步。
- ✅ KaTeX 公式离线降级为 `$..$` 原文（不报错）。
- ⚠️ 截图抓帧为骨架占位 → DOM 判据（`toggle-answers` 存在 + viewer-logic 的 stamp 契约）为准。
- 修复：无需。

### 状态: needs（质检队列 / Review 入口）—— **有真实截图证据**
- ✅ **review.png 实测呈现 2 条队列条目**：
  - `Q-6` Conf `60%`、错误标签 `SUBJECTIVE FLAG`、`进入单题` 按钮。
  - `Q-6` Conf `60%`、错误标签 `SUBJECTIVE FLAG`、`进入单题` 按钮。
- ✅ 队列头部 `质检队列 · 2 Pending Review`；空态分支（"All questions reviewed." + 返回总览）逻辑存在（当前 2 条待审不触发）。
- ✅ 点击 `进入单题` → `goToQuestion` 用唯一 `q.id` 导航滚动到目标卡并短暂 `.review-highlight`。
- ⚠️ 发现：两条目 `number` 均为 "6" → 标题均显示 `Q-6`，**存在展示歧义**（两条不同题同标 Q-6）。
  → **已修复（Minor-3）**：`displayLabel(q)` 在 number 重复时回退到带页码的 `Q-6 (p7)` / `Q-6 (p9)`，确保每条唯一可辨；`goToQuestion` 仍用唯一 `q.id` 导航。
- 修复：已修复（见上）。

### 状态: empty（空态 / doc 回退）
- ✅ `?doc=不存在卷` → 数据不存在 → 回退默认卷（展示默认卷卡片），非真空态；`loadWithFallback` 抛错分支（默认卷也失败）才触发 `#empty` 空态。
- ⚠️ 真实空态（`All questions reviewed.` / "没有符合条件"）当前数据不触发（85 题有 2 条待审、筛选必然命中）。空态样式由 `.empty-state` / `.review-empty` 规则承载，逻辑由复习队列空分支与筛选空分支覆盖。
- 修复：无需（空态逻辑存在，当前数据未触发）。

---

## 结论

| 状态 | 截图证据 | 权威判据 | 版面结论 |
|------|---------|----------|----------|
| complete | 骨架占位 | DOM 几何（85 题、442/471/831px、378px） | 无异常 |
| filter | 骨架占位 | DOM 判据 | 无异常 |
| answer | 骨架占位 | DOM 判据 | 无异常 |
| needs | **真实截图** | 截图 + DOM | 发现 Q-6 歧义 → 已修复 |
| empty | 回退默认 | 逻辑背书 | 无异常 |

> 备注：各非 review 状态截图抓帧为骨架占位是 IAB 截图与 DOM 渲染时序不同步所致（等待 1200ms 后仍为占位）。修复该时序需在 IAB 下轮询直至 `.card` 出现，属于 controller 截图环境的增强，不影响本任务 DOM 判据结论。

## 终审复核（2026-08-22）

- review-current.png（当前数据重跑 Review 入口）：`itemCount=2`，条目为 `Q-6 (p7) Conf 60% SUBJECTIVE FLAG`、`Q-6 (p9) Conf 60% SUBJECTIVE FLAG`，均带「进入单题」。
- 与 view-server 实际 data/out 数据核验一致：needs_review 两条 = `p7:q43`（number 6, subjective, conf 0.6）、`p9:q55`（number 6, subjective, conf 0.6）。
- 结论：截图证据与运行数据一致，无脱节；displayLabel 消除 Q-6 歧义（p7/p9）与 `.review-mode` CSS 均生效。
