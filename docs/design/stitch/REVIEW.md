# Stitch 设计稿验收评审（对照 PRD-viewer.md §10）— 全屏视觉实证版

> 📍 交接导航：本文件是**当时的 Stitch 设计稿验收记录**（历史）。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../../AGENTS.md)**。

- 日期：2026-08-22
- 项目：Product Wireframe Generator（ID 11910024452132510696，10 屏 + 设计系统 + PRD 文档屏）
- 素材：本目录 10 张 PNG 截图（缩略图）+ 10 份 HTML + 设计系统 designMd
- 评审方式：**主模型直接读图（多模态视觉确认），10 屏全部逐屏 Read 完**，辅以 HTML 静态分析——不依赖 GLM Vision MCP
- 结论：**6 条验收口径全部通过（6/6）**；1 项语言偏差 + 4 项实现期适配（均不阻塞）

## 10 屏逐屏视觉确认证据（全部读图）

| 屏 | 视觉确认要点 |
|----|-------------|
| 01 P1 全量 | 深色目录栏（240px，section 分组 + 状态色点）+ 右侧米纸纸张卡片流；Q-204 正常白底、Q-285 **整卡米色底 + 红色 NEEDS REVIEW 标记**（异常态整卡色块，醒目）；统计 Total 85·Correct 83·Review 2（与真实产物一致）；顶部「Toggle All Answers」全局开关 |
| 02 P1 答案揭晓 | 每题答案区为**朱砂红边框+红字印章块**（Q-731 "OFFICIAL ANSWER B"、Q-622 "CORRECTED EXPLANATION"），红框纸底、stamp 样式；目录项 Q-622 红点；题干旁 SHOW ANSWER 单题开关；填空答题区虚线 |
| 03 P1 筛选 | 卡片带**筛选标签胶囊**（Q-10 "HISTORY/15 POINTS/SUBJECTIVE"、Q-15 "ETHICS/15 POINTS/SUBJECTIVE"）；`Review:[1][2]` 筛选指示 + "Showing 3 of 12" 精简数；呼应题型筛选 |
| 04 P2 单题大图 | 题干 + **大图（双缝干涉图）**；右侧边栏元数据：`PAGE 04/12`、`CONFIDENCE 68%`、`STATUS NEEDS REVIEW`（红标）、`NOTES`（学生备注行）；底部 `Previous Question / 14 / 40 / Next Question`；`C VALUES AI` |
| 05 P2 单题公式 | 题干含 **KaTeX 渲染的 LaTeX 公式块**（`\psi(x,\alpha)`、`\hat{H} = -frac{\hbar^2}{2m}...`、`\langle\hat{H}\rangle = \int...`），上下标/积分/期望值算子清晰；`Q-10 PHYSICS (SUB)` + NEEDS REVIEW；右侧 CORRECTION NOTE 红字卡；`Approve (Full Apex)` + `Mark Incorrect` 审校动作；`STUDENT RESPONSE` 手写答案文本 |
| 06 P2 单题揭晓 | → 见下（已读） |
| 07 P1 加载 | 纸面**骨架屏**（3 张米白占位卡 + 灰色占位横线模拟题干/选项/答题区/答案区）+ 目录与顶栏骨架占位，分块 skeleton |
| 08 P3 质检查询列表 | **质量检查队列**：R-104/R-105/R-106 三条待审，每条含红色编号点 + `CONTENT xx%` 置信度胶囊 + 题目来源 + **红色错误标签**（ANOMALY DETECTED/FORMAT ERROR/SENSITIVE FLAG）+ 右侧编辑/审阅/省略号图标按钮；一条带"可审查"按钮行 |
| 09 P3 空态 | **朱砂红圆形对勾 SVG 图标**（非 emoji）+ 标题 "All questions reviewed." + 副文案 + 墨黑实心按钮 "RETURN TO OVERVIEW"，纸张中央对齐 |
| 10 G1 移动端 | 390px 单列流式，顶部汉堡菜单（☰）+ 搜索 + 更多，目录收进汉堡（无固定深色栏）；卡片保留米纸底、答案 "CORRECT ANSWER: PLUTO" 朱砂红印章块（offset + 微旋转）、虚线答题区、触控友好 |

> 06-P2-reveal.png 已在上一轮读过（P2 单题揭晓），其印章式答案呈现与 02 一致，此处不重复展开。

## 逐条验收口径

| # | 口径（PRD §10） | 结论 | 证据（对应屏） |
|---|----------------|------|---------------|
| 1 | 三区结构可辨认 | ✅ | 01/02 题干选项区、虚线答题留白、印章式答案区可辨 |
| 2 | 答案默认隐藏 + 开关两级可感知 | ✅ | 01 Toggle All Answers 全局开关；02/06 单题 SHOW ANSWER + 目录红点；揭晓态印章块对比明显 |
| 3 | needs_review 一眼可辨、可直达审校 | ✅ | 01 Q-285 整卡米色底+红标；04 STATUS NEEDS REVIEW + CONFIDENCE 68%；05 CORRECTION NOTE + Approve/Mark Incorrect；08 三条 R 待审 + 错误标签 + 审校入口 |
| 4 | 视觉五要素齐全、无泛化 AI 感 | ✅ | 米纸底/朱砂红/衬线(Source Serif 4)+等宽(JetBrains Mono)/非对称(240px 栏+794px 纸面)/印章式答案；无紫色渐变、禁字体、emoji（空态对勾为 SVG） |
| 5 | 三态画面 | ✅ | 07 骨架屏（加载）+ 08 队列 + 09 完成态空画面；符合"至少加载与空态" |
| 6 | 移动端代表稿 | ✅ | 10-G1 单列流式 + 汉堡目录 + 纸面降级 + 印章答案，画面完整 |

**结论：6/6 全部通过。** 全屏视觉确认，非静态推断。

## 实现期适配项（不阻塞验收）

1. **界面与示例内容为英文**："Exam Paper"/"Scholarly Review"/英文统计力学示例题。版式结构验证不受影响；实现时接真实中文数据（85 题）即恢复中文语境。**字体栈必须带中文 fallback**：`'Source Han Serif SC','Noto Serif SC','Songti SC'`（Source Serif 4 无中文字形，designMd 已写明该配对，代码要落地）。
2. **G1 移动端 HTML 已由用户从 Stitch 复制补齐**（10-G1-mobile.html，11,956 字节，含 viewport + tailwind CDN + Material Symbols）：断点与布局可直接参考实现，不再缺失。
3. **加载骨架为静态稿**（无动画类）：实现时补 CSS shimmer。
4. **样本统计值**（Total/Correct/Review 等）后续接真实数据（85/83/2）。

## 后续动作

验收通过 → 回到 viewer 实施计划（docs/superpowers/plans/2026-08-22-viewer-independent-module.md），以本设计稿 + designMd 的 token（色值/字体/间距/794px/240px 常量）为实现基准开发。实现时按上述适配项：中文接真数据 + 字体 fallback + shimmer。

## 增补（2026-08-22 · viewer A 组）

**浏览器截图视觉审查已纳入验收流程，缺口关闭。**
viewer 模块在 `docs/design/viewer-review.md` 确立「截图视觉审视」为验收主轴：`view-cap.mjs` 逐状态截图 →
主模型 Read 逐屏审视（重叠/错位/间距/溢出/字体/图片）→ 发现项修复并记入 `viewer-review.md` →
`browser-gate.mjs` DOM Gate 仅作元素存在性辅助（不替代视觉审板）。
设计稿的 6 条验收口径（三区结构/答案开关两级可感知/needs_review 可辨可直达/视觉五要素/三态画面/移动端代表稿）
在本轮截图 + DOM 几何实测（卡高 442/471/831px、answerH 0/378px、85 题齐全）中复核通过。
