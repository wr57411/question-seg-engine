---
intent: 让 MinerU 已读出但被 normalize 整块丢弃的表格（含 rowspan/colspan 网格）进入产品数据，并在成品页按原坐标画成真网格，同时保持切题结果逐字节不变
success_criteria: 全量 29 册 A/B 题数与题号序列 100% 一致；含表格册的快照出现 kind=table 块且带 html；成品页该位置显示带框线网格且不叠加压平文字；npm run check 全绿（渲染审计 8/8、配对 420 不变）
risk_level: medium
auto_approve: true
branch: feature/oxr
worktree: false
---

## Steps

- [ ] **Step 1: 表格 HTML 解析器（纯函数）**
action: 新建 `stages/table-html.js`，文件头 `// @ts-check` + JSDoc 类型。导出 `parseTableHtml(html)` → `{ rows: [{cells:[{text,rowspan,colspan}]}], cols }` 与 `cellText(raw)`。要求：`<eq>…</eq>` 转 `$…$`；其余标签剥离；HTML 实体解码（`&nbsp; &lt; &gt; &quot; &#39; &amp;`）；连续空白压成一个空格；`<br>` 转换行；空/非表格输入返回 `{rows:[],cols:0}`。禁止使用 DOM API（要能在 node:test 里跑）。
loop: false
verify: node -e "import('./stages/table-html.js').then(m=>{const t=m.parseTableHtml('<table><tr><td rowspan=2 colspan=1>甲</td><td colspan=2>乙丙</td></tr><tr><td>丁</td><td>戊</td></tr></table>');if(t.rows.length!==2||t.cols!==3||t.rows[0].cells[0].rowspan!==2)process.exit(1);console.log('ok')})"

- [ ] **Step 2: 解析器测试**
action: 新建 `tests/table-html.test.ts`，覆盖 6 例：基本两行三列、rowspan/colspan 保留且 cols 按 colspan 展开、`<eq>` 转 `$…$`、标签剥离+实体解码+空白压缩、空输入返回空、th 与 td 同等对待。
loop: false
verify: npx tsx --test tests/table-html.test.ts

- [ ] **Step 3: schema 增量字段**
action: `src/types.ts` 给 `ParsedBlock` 的 `"text" | "table"` 分支加可选 `html?: string`（JSDoc 说明：仅上游 `spans[].html`，不推断）；给 `Question` 加可选 `tables?: { html: string; bbox: BBox; pageIndex: number }[]`（JSDoc 说明：表格块归属当前题，**不改 stem**）。只加字段，不改既有字段语义。
loop: false
verify: npm run typecheck

- [ ] **Step 4: normalize 新增 table 分支**
action: `src/normalize.ts` 的 layout 路径（`for (const pbRaw of asArray(rec.para_blocks))` 循环内、`const lines = asArray(pb.lines)` 之前）加分支：当 `pb.type === "table"` 时，遍历嵌套 `pb.blocks[].lines[].spans[]` 取第一个含 `<table` 的 `html`；产出**一个** `{ kind:"table", bbox: toBBox(pb.bbox), text: 单元格文本按行拼接, firstLine: 首行, lineCount: 行数, maxFontSize: 0, html }` 块并 `continue`。取不到 html 时退回原行为（走 lines 展开），不新增块。
loop: false
verify: npx tsx -e "import('./src/normalize.js').then(async m=>{const {readFileSync}=await import('node:fs');const d=m.normalizeLayout(JSON.parse(readFileSync('data/out/物理_教材基础练 电路-MinerU/layout.json','utf8')),'x');let n=0;for(const p of d.pages)for(const b of p.blocks)if(b.kind==='table'&&b.html)n++;if(n<9)process.exit(1);console.log('table blocks',n)})"

- [ ] **Step 5: 引擎归属表格块（不参与切题）**
action: `src/rule-engine.ts` 的 `process()` 里，在 `if (this.mode === "answers")` 之后、`block.kind === "text"` 噪声过滤之前，加：`if (block.kind === "table") { 有 current 则 push 到 current.tables；否则 review(blockIndex, "悬空表格：归属不到任何题目", null)；return; }`。Draft 类型同步加 `tables` 字段，`finishQuestion` 里写入 `Question.tables`。**不得**让表格块进入 `matchFirstLine` 或任何题号/选项判定。
loop: false
verify: npm run typecheck

- [ ] **Step 6: 切题零变化断言（关键门）**
action: 写一次性脚本 `npm run audit:ab`：对 `data/out/*/layout.json`（跳过 `-OXR`/`-MinerU` 后缀）逐个 `segmentFromLayout`，输出 `docId<TAB>题数<TAB>题号序列的 sha256`，按 docId 排序写 `tmp/ab-after.txt`；然后 `git stash` 本轮改动重跑写 `tmp/ab-before.txt`，`git stash pop`。用 `diff` 比较两文件，**必须完全一致**。任何一行差异 ⇒ 停止并回报，不调阈值。
loop: false
max_iterations: 3
verify: npx tsx tmp/ab-questions.ts > tmp/ab-after.txt && git stash push -u -- src/ scripts/ stages/ tests/ >/dev/null && npx tsx tmp/ab-questions.ts > tmp/ab-before.txt && git stash pop >/dev/null && diff tmp/ab-before.txt tmp/ab-after.txt && echo "A/B 零差异"
gate: human

- [ ] **Step 7: fuse-doc 写回保留表格块**
action: `scripts/fuse-doc.ts` 的 `rawBlock`：当 `b.kind === "table"` 且 `b.html` 时，输出 `{ type:"table", bbox: b.bbox, blocks:[{ lines:[{ bbox: b.bbox, font_size: fontSize, spans:[{ content: b.text, font_size: fontSize, html: b.html }] }] }] }`（嵌套一层 `blocks`，与上游结构一致）。非表格块保持现有输出不变。
loop: false
verify: npm run typecheck

- [ ] **Step 8: 快照带表格**
action: `scripts/export-stages.ts` 的块映射加 `...(b.kind === "table" && b.html ? { html: b.html } : {})`；题目映射加 `...(q.tables?.length ? { tables: q.tables } : {})`。保持其它字段不变。
loop: false
verify: npm run typecheck

- [ ] **Step 9: 渲染表格网格 + 隐藏被覆盖行块**
action: `stages/reconstruct.js`：import `parseTableHtml`；新增 `export function tableNode(b, p, canvasW, baseFont)`（`posStyle` 定位到 `b.bbox`，内联样式 `<table>`：`width/height:100%`、`border-collapse:collapse`、`table-layout:fixed`、单元格 `border:1px solid rgba(0,0,0,.35)`、`padding:1px 3px`、`vertical-align:top`、`word-break:break-word`，`td.innerHTML = prettifyLatex(cell.text)`）；`appendBlockNodes` 中：对 `kind==="table"` 的块调 `tableNode`（返回 null 则退回 `blockNode` 用文本渲染），并把**被表格 bbox 完整覆盖**的其它块（`x0>=rx0-1 && y0>=ry0-1 && x1<=rx1+1 && y1<=ry1+1`）从渲染列表剔除。
loop: false
verify: npm run typecheck

- [ ] **Step 10: 重生成含表格的册**
action: 逐册重跑 `npm run daily -- "data/out/<docId>/layout.json" --id "<docId>" --no-ocr`，目标 5 册：`物理_教材基础练 电路`、`教材基础练 磁场`、`物理_教材基础练机械能守恒定律`、`物理_教材基础练 运动和力`、`答案册-合订本`。每册跑前先把 `questions.json`/`stages.json`/`layout.json` 备份到 `tmp/bak-<docId>/`。
loop: false
verify: npx tsx -e "import('node:fs').then(fs=>{const docs=['物理_教材基础练 电路','教材基础练 磁场','物理_教材基础练机械能守恒定律','物理_教材基础练 运动和力','答案册-合订本'];let ok=0;for(const d of docs){const s=JSON.parse(fs.readFileSync('data/out/'+d+'/stages.json','utf8'));const n=s.pages.reduce((a,p)=>a+p.blocks.filter(b=>b.kind==='table'&&b.html).length,0);console.log(d,n);if(n>0)ok++;}if(ok<4)process.exit(1)})"

- [ ] **Step 11: 质量门与配对**
action: 跑 `npm run check`，确认：typecheck 通过、测试数 ≥ 323（原 317 + 新增 6）、`audit:render:all` 8/8、`audit:numbering` 新增 0 条、`bank:all` 仍 420 条且内容尺子全达标。
loop: false
max_iterations: 3
verify: npm run check

- [ ] **Step 12: 逐页截图审板（显示层红线）**
action: 起服务 `npm run view`，对 `物理_教材基础练 电路` p1 与 `物理_教材基础练机械能守恒定律` p14（表格所在页）截图，逐项核对：① 表格有框线、合并单元格位置正确；② 网格区域内**没有**叠加压平文字；③ 网格未越出原表格范围、未压相邻正文；④ 字号与原卷可读性相当。发现项写进 `docs/design/handoff-table-review.md` 并修复后重拍。
loop: false
gate: human
verify:
  type: human-review
  check: 截图显示真网格、无文字叠加、未越界；发现项已记录并复拍

- [ ] **Step 13: 文档收口**
action: `docs/DECISIONS.md` 追加 §76（记录 D1–D6 六个决策 + A/B 零差异证据 + 截图证据路径 + 已知边界：实验题黏连题号导致表格可能无题归属）；`docs/HANDOFF.md` §6-25 标记为已修并指向 §76，同时新增 §6-26 登记「实验题黏连题号 ⇒ 62% 实验页 0 题」（单独立项）；同步 DECISIONS 计数（AGENTS/README/头部）。
loop: false
verify: grep -c "## 76\." docs/DECISIONS.md && grep -c "6-26" docs/HANDOFF.md

- [ ] **Step 14: 提交**
action: 分两个提交：① `feat(table): 表格结构进数据 + 成品页画网格`（src/ + stages/ + scripts/ + tests/）；② `docs: DECISIONS §76 / HANDOFF §6-25 关闭 / §6-26 登记`。提交前确认 `npm run check` 仍全绿。
loop: false
verify: git log --oneline -2
