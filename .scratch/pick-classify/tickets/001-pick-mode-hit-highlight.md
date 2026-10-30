# 001 挑题模式 + 整题命中 + 选中高亮（只读）

**Blocked by**: 无

## 目标
成品页顶部出现「挑题」开关；打开后点一道题的任意内容块（题号、题干、选项、图）即选中并高亮，
底部出现托盘空壳显示当前题。**这一步不写入任何数据**，先证明模式、命中、布局不被破坏。

## 涉及层
- [ ] 数据层：无写入；只读取当前页快照（stages.json）与 block `data-bi`
- [ ] 逻辑层：`final/pick-hit.js` 纯函数 `pickQuestionAt(page, questions, {xPt,yPt}, tolerancePt)`
- [ ] UI层：`final/final.js` 模式开关 + 点击/滚动判定 + 选中高亮；`final/final.css` 托盘空壳
- [ ] 纸面：选中态只给 `.blk[data-bi]` 加描边/底色类，不改 bbox、页高、字号、留白
- [ ] 测试：`tests/pick-hit.test.ts`；扩展 `tests/layout-invariant.test.ts`

## 验收标准
- 开/关「挑题」：关掉行为与现在完全一致；打开后托盘出现，显示 `p{页} · 第{题}题` 与题干首行
- 点块内 / 距块 6pt 内命中；题与题之间的空白、页边距不选（不猜）；从按下到抬起移动 >10px 视为滚动
- 选中题的全部块出现高亮；点另一题切换；关掉模式清除高亮
- 纸面几何逐字节不变：开/关模式、选中/未选中，页高、字号、留白宽度、号牌位置相同
- iPad 820×1100 截图：模式开 + 选中一题 + 托盘空壳；无横向溢出、按钮 ≥44px
- `node --import tsx --test tests/pick-hit.test.ts tests/layout-invariant.test.ts` 全绿；`npm run check` 全绿
