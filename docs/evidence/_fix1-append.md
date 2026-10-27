
> 📍 交接导航：本文件是**测量证据（历史数据，非当前状态）**——被 `DECISIONS.md` 引用为口径依据。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../AGENTS.md)**。



---

# 修复轮 1 报告（针对评审发现 1、2）

**日期**：2026-10-08
**修复提交**：`fd28853`（在 `17ecd7a` 之上**新建**提交，未 amend）
**范围**：仅 `stages/stages.css`、`stages/stages.js` 两个文件；未动 `src/`、`scripts/`、`tests/font-metrics.test.ts` 断言值，未改 `emWidthOf` 权重表，未派发子代理。

## 发现 1（Important）—— `stages.css` 注释复述被本次工作推翻的旧前提

**怎么改**：改写 `stages/stages.css:154-159` 的注释块。**行为未改**——`stages/stages.css:160`
的 `.blk { ... overflow: visible ... }` 原样保留（未改成 `hidden`）；只把**立论**从
「浏览器字体更宽 → 文字溢出，故不裁切」改为「避免裁切造成静默内容丢失（G1）」，并写明实测依据与来源。

**改后 `stages.css` 注释最终文本（逐字，`:154-159`）**：

```css
/* 高保真复刻：字号按行高推算（font-metrics.js，定案系数 1.03）。
 * 这里让文字**可见**而不裁切，理由是**避免裁切造成静默内容丢失**（G1），
 * 不是「字体更宽所以溢出」——该旧前提已被推翻：实测 CJK 全角在印刷体与 Songti SC 中
 * 都精确 1em（度量误差为 0），且按定案系数渲染宽恒 < bbox 宽，**不会溢出**；
 * 真实缺陷是字号偏小 30%、文字填不满 bbox，宽高可同时对齐（垂直仅差 2.3%）。
 * 依据：data/out/ink-groundtruth.md（F1–F6）。 */
```

与新注释一致的事实要点（源自 `data/out/ink-groundtruth.md` 的 F1–F6）：CJK 全角在印刷体与
Songti SC 中均精确 1em（度量误差为 0）；真实缺陷是字号**偏小 30%**、文字**填不满** bbox；
按定案系数 1.03 渲染宽恒 < bbox 宽（不溢出）；宽高可同时对齐（垂直仅差 2.3%）。

## 发现 2（Minor）—— `baseFontOfPage` 在 `for` 循环体内逐块重算

**怎么改**（只搬移，不改语义）：

- `stages/stages.js:309`（`renderOrder`）：原 `for (const b of p.blocks) c.append(blockNode(b, p, CANVAS_W, baseFontOfPage(p.blocks, p.width, CANVAS_W)));`
  → 在循环前 `const baseFont = baseFontOfPage(p.blocks, p.width, CANVAS_W);`，循环内改为复用 `baseFont`。
- `stages/stages.js:325`（`renderSeg`）：同上处理。

`baseFontOfPage` 是纯函数，对同一 `p.blocks` / `p.width` 结果确定，故每页只算一次与逐块重算**语义等价**；
搬移后与同文件其它 render 函数（`renderRaw` / `renderDiscardedInto` / `renderCompare`）的写法一致。

## 覆盖测试（命令与完整输出）

命令：`npm run check`（`typecheck && test && audit:render`）；退出码 **0**。

```
@@CHECK_FIX1@@
```

**结果摘要**：typecheck 干净；单测 **101/101** 通过（`# fail 0`）；渲染审计 **9 项全部归零**（`全部归零 ✅`）。

### 附带：浏览器冒烟复跑（`stages/*.js` 不在 check 覆盖内）

命令：headless Chrome（`--headless=new --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=5000 --dump-dom`）
加载 `http://localhost:4173/data/out/probe-font-smoke.html`，提取 `PROBE_JSON_*`。

实测（`data/out/_probe-font-smoke-fix1.json`）：`lineCount = 67`、11pt 正文行
`getComputedStyle().fontSize = 8.74463px`、`errors = []` —— 与修复前完全一致，无回归。

## 遗留疑虑

无新增。原报告 §6 的三条遗留疑虑（视觉审板归 Task 3、审计门归 Task 2、`emWidthOf` 对窄非 ASCII 的高估）
状态不变。
