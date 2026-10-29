---
intent: 让教辅栏目（教材实验 N / 教材知识萃取 / 教材素材变式）里的内容有独立的结构归属，不再完全依赖题号；同时收掉板内另外两类编号误判（粘连正文、折行碎片）。
success_criteria: 电路册 p6–p11、曲线 p14/p15、运动力 p7 的内容在快照里都有归属（题目或板块条目）；板内假题归零；全量 15 册 A/B 差异逐条可解释；npm run check 全绿（342+ 测试、渲染审计 8/8 新增 0、配对 420 不变）；成品页与原卷逐页对照审板通过。
risk_level: medium
auto_approve: true
branch: feature/oxr
worktree: false
---

## Steps

- [ ] **Step 1: 板块条目类型**
action: `src/types.ts` 新增 `export interface Band { id: string; bandKey: string; title: string; pageIndex: number; blockIndexes: number[]; text: string; status: "needs_review" }`，并给 `SegmentationResult` 加 `bands: Band[]`。字段 JSDoc 写清两件事：① bands 是**结构容器**，不参与题号域（N1/N6 不可豁免，题号必须 1–99 纯数字）；② 一个板块跨页时按页拆成多条，共享 `bandKey`。
loop: false
verify: npm run typecheck

- [ ] **Step 2: 引擎产出板块条目**
action: `src/rule-engine.ts`：加 `private bands: Band[]` 与 `private currentBand: { bandKey: string; title: string } | null`；`section` 分支命中 `m.band` 时开新 band（bandKey = `<docId>:band<自增>`），`chapter` 与非 band 的 `section` 关闭 band；`process()` 里对每个进入正文的文件块，若 `currentBand` 非空则把该块按页记入对应 band（同页复用一条，跨页新建一条共享 bandKey）。**只增信息，不改任何切题判定**（被题目认领的块同时属于 band）。`segment()` 返回结果带上 `bands`。
loop: false
verify: npx tsx -e "import('./src/index.js').then(async m=>{const {readFileSync}=await import('node:fs');const r=m.segmentFromLayout(JSON.parse(readFileSync('data/out/物理_教材基础练 电路/layout.json','utf8')),'x');const t=r.bands.map(b=>b.title.slice(0,12));if(r.bands.length<5)process.exit(1);const pages=new Set(r.bands.map(b=>b.pageIndex));if(pages.size<5)process.exit(1);console.log('bands',r.bands.length,'pages',pages.size,t.join('|'))})"

- [ ] **Step 3: 快照与文件落 plate**
action: `scripts/export-stages.ts`：把 `result.bands` 写入快照（`snapshot.bands`，按页分组可选）并另写一份 `data/out/<docId>/bands.json`（纯数组，供 viewer 直接 fetch，避免拖 700KB 的 stages.json）。字段与 Step 1 完全一致，不额外加工。
loop: false
verify: npm run typecheck

- [ ] **Step 4: viewer 渲染板块条目**
action: `viewer/viewer.js`：并行 fetch `bands.json`（缺文件时静默为空，不报错），在按 section 分组的题目流中，把同一 `bandKey` 的板块条目渲染成一张**不带题号**的卡片（header 显示 `板块` 标签 + 标题原文，正文显示该页文本摘要），并计入目录。样式加在 `viewer.css`，复用现有 card 视觉，不新造一套。板块卡不参与「Total / ok / review」题目计数。
loop: false
verify: npm run typecheck

- [ ] **Step 5: 粘连形态接入板块守卫**
action: `src/rule-engine.ts` 的「题号黏正文」（`m.kind === "other"` + `matchGluedQuestionNumber`）分支：在返回切题前加板块守卫——`bandTitle` 非空 且 `isBandSubheading(block.text)` 为真时不切。逐条核对：机械能守恒 p13 的真题 `1小天同学用如图1所示的实验装置进行实验。` 含句号 ⇒ `isBandSubheading` 为 false ⇒ 仍然切题（这是 §77 的收益，不能被本步打掉）。
loop: false
verify: npx tsx tmp/probe/band-check.ts "物理_教材基础练机械能守恒定律"

- [ ] **Step 6: 折行碎片不认题号**
action: 处置 `1)条刻线的总长度相等。常见的几种卡尺分类` 这类**公式折行残片**：在 `src/patterns.ts` 的 `ARABIC_QUESTION` 第 2 分支（`N)` 形态）前加守卫——`N)` 后紧跟汉字且整块含句号时不算题号（真题号后不会紧跟汉字再接句号）。判据写进注释并补测试。若该守卫在 A/B 里影响到别的册，回退本步并在报告中登记（折行残片根治在上游，不在切题层硬猜）。
loop: false
verify: npx tsx --test tests/badge-label-guard.test.ts

- [ ] **Step 7: 全量 A/B 与质量门（关键门）**
action: 跑 `npm run audit:ab` 与改动前基线 diff，逐条解释每一处变化；跑 `npm run check`。任何未解释的差异或任何门红 ⇒ 停止，不调阈值。
loop: false
max_iterations: 2
verify: npm run check
gate: human

- [ ] **Step 8: 重导受影响册**
action: 备份 `data/out/<docId>/{questions,stages}.json` 到 `data/archive/2026-10-29-pre-band/`，然后逐册重导：`物理_教材基础练 电路`、`物理_教材基础练万有引力`。用 `scripts/export-stages.ts <docId> data/out/<docId>/layout.json`（同 docId，不换 ID，避免 corrections 与 OCR 输入错位）。
loop: false
verify: npx tsx tmp/probe/band-check.ts "物理_教材基础练 电路"

- [ ] **Step 9: 成品页与原卷逐页审板**
action: 起预览服务（4173），对电路册 13 页逐页截图「对比」阶段（`stages/?doc=…&stage=6&page=N`），逐页核对：内容齐全性（首项）、板块内容是否完整可见、题号牌是否覆盖到正确位置。截图存 `tmp/review-band/`。审板清单第一项必须是**内容齐全性**（tasks/lessons.md L1）。
loop: false
verify: test -d tmp/review-band && test $(ls tmp/review-band/*.png 2>/dev/null | wc -l) -ge 13
