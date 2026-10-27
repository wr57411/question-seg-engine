
> 📍 交接导航：本文件是**测量证据（历史数据，非当前状态）**——被 `DECISIONS.md` 引用为口径依据。
> 当前状态、未闭合风险与红线见 **[docs/HANDOFF.md](../HANDOFF.md)**；通用约定见 **[AGENTS.md](../../AGENTS.md)**。


---

# 修复轮 1（2026-10-08）：R4 排布方向 —— 竖排块加 `writing-mode`

**背景**：Task 4 只把竖排块**字号**按 `bboxW` 修正（119.52 → 17.07px），但文字仍按**水平**排布：
7 个字（17.07px × 7 ≈ 119.5px）从 16.5px 宽的框向右伸出，越过画布右缘。即「框在画布内、
文字在画布外」——R4 症状只消除了一半。本轮补上排布方向。

## 1. 改动清单（文件:行号 + 原因）

| 文件:行 | 改动 | 原因 |
|---------|------|------|
| `stages/stages.js:10` | import 增加 `isVerticalText` | 复用 `font-metrics.js` 的同一判定，字号与排布方向**同一依据**，不重复实现 |
| `stages/stages.js:233`（`blockNode`，文本分支内） | `if (isVerticalText(b.bbox, b.text ?? "")) node.classList.add("blk-vertical")` | 阶段 2–6 的行级/对比块：命中竖排才挂类 |
| `stages/stages.js:294`（`renderDiscardedInto`，`if (shown)` 内） | 同上 | 阶段 1 与对比模式的**丢弃块**（本例侧栏块即走此路径） |
| `stages/stages.css:168–172` | 新增 `.blk-vertical .txt { writing-mode: vertical-rl; }`（含说明注释） | 逐字自上而下竖叠。**类由 JS 按检测结果挂**，非全局选择器 → 不波及普通行级块 |

**未改**：字号公式（仍 `fontFromLineHeight(bboxW 换算)`，实测 17.07 / 10.33px 与上轮完全一致）；
`emWidthOf` 权重表；`.blk { white-space: nowrap; overflow: visible }`。

**关于 `white-space: nowrap`**：`.blk` 上的 `nowrap` 在竖排下阻止的是**换列**（横向 overflow-wrap），
正好让 7 个字保持**单列**竖叠而不折成多列；实测墨迹为 `15 × 72.3px`（宽 ≈ 1 行 × 高 ≈ 7 字），
即「字符自上而下依次排列」，未被压成一行。故未改动 `white-space`。

## 2. 验收实测（headless Chrome，`getComputedStyle` + `getBoundingClientRect`）

**探针**：`data/out/probe-task4fix.html`（同时输出 `.canvas` 矩形、每个 `.blk-vertical` 的
`.txt` 墨迹矩形与 `writing-mode`、`.blk-discarded` 明细、普通行级块 `writing-mode`、raw 最大字号）
**运行器**：`data/out/task4fix-probe.sh <stage> <page> <out.json>`
**页面 URL**：`http://localhost:4173/stages/?doc=23%E5%BF%85%E5%88%B7%E9%A2%98%202%E7%9B%B8%E4%BA%92%E4%BD%9C%E7%94%A8&stage=N&page=0`

### 2.1 验收 ①：竖排块文字矩形落在画布矩形之内（`?stage=6&page=0`）

修复前原始输出（HEAD `963b09b`，`data/out/_task4fix-before-stage6.json`）：

```
"canvas":{"x":757,"y":373,"w":460,"h":633.7},
"vertical":[],
"discarded":[...,{"text":"第二章相互作用","font":10.33,"writingMode":"horizontal-tb",
   "cls":"blk blk-discarded","blk":{"x":1192,"y":509,"w":10,"h":70},
   "ink":{"x":1193,"y":508,"w":72.3,"h":15}}, ...]
```

修复后原始输出（`data/out/_task4fix-stage6.json`）：

```
"canvas":{"x":757,"y":373,"w":460,"h":633.7},
"vertical":[{"text":"第二章相互作用","font":10.33,"writingMode":"vertical-rl",
   "blk":{"x":1192,"y":509,"w":10,"h":70},
   "ink":{"x":1192,"y":510,"w":15,"h":72.3},"inkInCanvas":true}],
"discarded":[...,{"text":"第二章相互作用","font":10.33,"writingMode":"vertical-rl",
   "cls":"blk blk-discarded blk-vertical","blk":{"x":1192,"y":509,"w":10,"h":70},
   "ink":{"x":1192,"y":510,"w":15,"h":72.3}}, ...]
```

画布矩形：`x=757, y=373, w=460, h=633.7` → 右缘 **1217**、下缘 **1006.7**。

| 项 | 修复前 | 修复后 |
|----|--------|--------|
| `writing-mode` | `horizontal-tb` | **`vertical-rl`** |
| 文字墨迹 rect（`Range`） | `x=1193, y=508, w=72.3, h=15` | **`x=1192, y=510, w=15, h=72.3`** |
| 墨迹右缘 | 1193+72.3 = **1265.3** → 越出画布右缘 **48.3px** ❌ | 1192+15 = **1207.0** ≤ 1217 ✅ |
| 墨迹下缘 | 508+15 = 523 | 510+72.3 = 582.3 ≤ 1006.7 ✅ |
| `inkInCanvas` | —（越界） | **true** ✅ |

墨迹由「72.3 宽 × 15 高」（横排一行）变为「**15 宽 × 72.3 高**」（竖排一列）——7 个字逐字竖叠，
且整体落在画布内。字号 `10.3346px` 修复前后**完全一致**（未动）。

### 2.2 验收 ②：同页普通行级块 `writing-mode` 仍为默认值

修复后 `?stage=6&page=0` 的 `horizontalSample`（原始输出）：

```
[{"text":"第二章 相互作用","font":15.9,"writingMode":"horizontal-tb"},
 {"text":"第1节 重力 弹力 摩擦力","font":12.72,"writingMode":"horizontal-tb"},
 {"text":"基础计划用时【 】分钟·答案D1","font":15.1,"writingMode":"horizontal-tb"},
 {"text":"1.[广东广州2022月考]如图","font":7.95,"writingMode":"horizontal-tb"},
 {"text":"砌得是否符合要求，通常拿起半块砖","font":7.95,"writingMode":"horizontal-tb"}]
```

同页 67 个 `.blk-line` 中 `writingMode` 全部 `horizontal-tb`；`.blk-vertical` 仅 1 个（那个侧栏块）。
阶段 2（`?stage=2&page=0`）、阶段 3（`?stage=3&page=0`）各 67 个行级块，`.blk-vertical` 数均为 **0** → 无波及 ✅

### 2.3 验收 ③：阶段 1（`?stage=1&page=0`）最大字号仍 ≤ 30px

修复后原始输出（`data/out/_task4fix-stage1.json`）：

```
"canvas":{"x":370,"y":346,"w":760,"h":1046.9},
"vertical":[{"text":"第二章相互作用","font":17.07,"writingMode":"vertical-rl",
   "blk":{"x":1090,"y":571,"w":16.5,"h":115.8},
   "ink":{"x":1089,"y":572,"w":24,"h":119.5},"inkInCanvas":true}],
"rawMaxFont":25.5, "lineCount":0
```

| 项 | 值 | 验收 |
|----|----|------|
| `rawMaxFont` | **25.5px**（居中大标题） | ≤ 30px ✅ |
| 竖排侧栏块字号 | **17.07px**（= `fontFromLineHeight(13/596*760)`） | 与上轮一致 ✅ |
| 竖排侧栏块墨迹 rect | `x=1089, y=572, w=24, h=119.5` → 右缘 1113 ≤ 1130、下缘 691.5 ≤ 1392.9 | 落在画布内 ✅（`inkInCanvas:true`） |

（阶段 1 画布 `x=370, y=346, w=760, h=1046.9` → 右缘 1130、下缘 1392.9。）

### 2.4 验收 ④：`npm run check` 全绿

`tsc --noEmit` 通过；`node --test`：**`# tests 107 / # pass 107 / # fail 0`**；
`audit:render` 全部归零（字号保真度：可判块 198 个 · 中位 ratio 1.0199）。完整输出见 §3。

## 3. `npm run check` 完整输出

完整原始日志（697 行）保存在 `data/out/_task4fix-check.txt`（git 忽略）。下方为本次运行完整输出：

<!--FIX_CHECK_OUTPUT-->

## 4. 遗留疑虑（本轮之后）

1. **竖排墨迹略大于块框**：竖排下 `.txt` 的行盒宽 = `line-height 1.15 × 字号`，比块框宽多出约 3px
   （对比模式块框 10px、墨迹 15px；阶段 1 块框 16.5px、墨迹 24px），故墨迹会比块框向左/向下各
   多出 1–5px。经实测**仍在画布内**（见 §2.1/§2.3），故未处理；若后续要求墨迹严格落在**块框**内，
   需改 `line-height` 或块框尺寸，属新的取舍。
2. **`emWidthOf(text) === 0` 的裁定**（沿用上轮）：段级块公式未覆盖除零，裁定为「无文字可贴合 →
   取下限 8px」，已写成测试（用例 16）。
3. **竖排只覆盖 `isVerticalText` 命中的块**：判定为 `bboxH > 2×bboxW` 且当量宽 ≥ 2（严格 >）。
   更宽的竖排（如 1.5×）或单字竖排不在此列——按简报的判定式执行，未扩大范围。
