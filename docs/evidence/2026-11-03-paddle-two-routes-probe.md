# PaddleOCR 两条产线的实际能力 vs 本项目用上的部分（2026-11-03 探针）

> 一句话：**现在这条 OCR 校验线只用了 PaddleOCR-VL 输出的一小截（纯文本），而它和 PP-StructureV3
> 都能给到块级/行级/单元格级坐标 —— 坐标是走 MCP 通道时被结构性丢掉的，不是模型不给。**
> 全部数字来自今日实测（同一本《电路》），原始返回见 `data/_probe/2026-11-03-paddle/`（git 忽略）。

---

## 1. 测量对象与路线

| 项 | 值 |
|---|---|
| 被试文档 | `data/out/物理_教材基础练 电路-MinerU/origin.pdf`（13 页，7.5 MB）与其中的 `pages/page-01.png`（1000×1431，1.3 MB） |
| 产线 A | `PaddleOCR-VL-1.6`（0.9B VLM，生成式） |
| 产线 B | `PP-StructureV3`（多模块 pipeline） |
| 通道 1 | 现有：`paddleocr_mcp` 0.8.5（stdio）→ AI Studio |
| 通道 2 | AI Studio 异步作业接口 `POST /api/v2/ocr/jobs`（文档 `docs/api/PP-StructureV3 api` 那条） |
| 通道 3 | AI Studio **同步** `POST …/layout-parsing`（用户口述：可用但计划下线） |
| 基线 | MinerU 快照 `content_list.json` / `layout.json`（同本同页） |

复现：`data/_probe/2026-11-03-paddle/{probe,timing,cold,sync,mcptime,knobs}.py`，
token 一律走环境变量 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`，**不落文件**。

---

## 2. 时延实测（同一文档、同一天）

| 路线 | 输入 | 墙钟 | 每页 | 备注 |
|---|---|---|---|---|
| 通道1 MCP + VL（**现状**） | 19.6 MB 新单页 | 45.8 s（call 42.3 + init 3.4） | 42.3 s | 只回文本 |
| 通道1 MCP + VL | 同一页第二次 | 2.5 s | — | **命中服务端缓存**，见 §6-4 |
| 通道1 MCP + V3（detailed） | page-01.png | 42.3 s | — | `output_mode:"detailed"` 里 **没有任何 bbox**（实测 `has_bbox=False`） |
| 通道2 异步 + VL | 19.6 MB 新单页 | 20.5 s | 20.5 s | 全量 JSON |
| 通道2 异步 + VL | page-01.png（服务端已见过） | 1.7 s | — | 同上，缓存 |
| 通道2 异步 + VL | **整本 PDF 13 页** | **218.7 s** | **16.8 s** | 一次提交；结果按 4 页一批返回 4 条 jsonl |
| 通道2 异步 + V3 | 19.6 MB 新单页 | 31.7 s | 31.7 s | |
| 通道2 异步 + V3 | page-01.png | 12.9 s | — | |
| 通道2 异步 + V3 | **整本 PDF 13 页** | **71 s** | **5.5 s** | 服务端并行；13 条 jsonl |
| 通道3 同步 | 4.8 MB 单页 | 24.9 s | — | 一次 HTTP 直接回全量 JSON |
| 通道3 同步 | 13 MB 单页 | 41.2 s | — | |
| 通道3 同步 | 整本 PDF | 227.6 s | 17.5 s | 比异步慢 3.2×，且计划下线 |

**读法**：把「逐页 MCP 调用」换成「整本一次异步作业」，VL 从台账口径的 75–90 s/页降到 16.8 s/页，
V3 到 5.5 s/页。台账里的 75–90 s/页 与本表 42 s 之差 **不能只归因给模型**（MCP 传输、当时的服务负载、
重试换字节都可能掺在里面），要定论得做一次「同字节、两通道」的受控 A/B —— 见 §7-3。

---

## 3. 返回里到底有什么（字段级，实测）

两个模型的异步返回结构相同：`result.layoutParsingResults[i] = {markdown, outputImages, prunedResult, inputImage}`。
**`prunedResult` 就是坐标，而它正是被 MCP 丢弃的那一层**（`paddleocr_mcp/inference/types.py` 的
`DocParsingResult` 只有 `markdown/pages/images_mapping` 三个字段；`tasks/doc_parsing.py` 的
`detailed` 分支只多追加一行 `Pages: N`。`paddleocr` SDK 自带的 `api` 子命令同样只导出 markdown，
`_doc_parsing_result_to_dict` 里没有 prunedResult ⇒ **命令行也拿不到坐标**）。

| 能力 | 现状（MCP simple） | PaddleOCR-VL-1.6 prunedResult | PP-StructureV3 prunedResult |
|---|---|---|---|
| Markdown 全文 | ✅ | ✅ | ✅ |
| **块级坐标 + 标签 + 阅读顺序** | ❌ | ✅ `parsing_res_list[].{block_bbox, block_label, block_order, block_id, group_id, block_polygon_points}` | ✅ 同名字段 |
| **版面框 + 置信度** | ❌ | ✅ `layout_det_res.boxes[].{label, score, coordinate, polygon_points}` | ✅ 同 |
| **行级文本框 + 逐行置信** | ❌ | ❌（VL 无 `overall_ocr_res`） | ✅ `overall_ocr_res.{rec_polys, rec_boxes, rec_texts, rec_scores, textline_orientation_angles, return_word_box}` |
| **表格：单元格框 + HTML** | ❌ | ❌（表格只作为 markdown 文本） | ✅ `table_res_list[].{cell_box_list, pred_html, table_ocr_pred.{rec_texts,rec_polys,rec_scores}}` |
| **公式：LaTeX + 区域框** | ❌ | ⚠️ 文本里有 `$…$`；`layout_det` 有 `inline_formula` 框（192 个），但无独立 `formula_res_list` | ✅ `formula_res_list[].{rec_formula, dt_polys}`（234 条） |
| 证据可视化图 | ❌（`return_images:false`） | ✅ `outputImages.layout_det_res` | ✅ 5 张：`layout_det_res / layout_order_res / overall_ocr_res / region_det_res / table_cell_img` |
| 跨页结构标记 | ❌ | — | ✅ `markdown.isStart / isEnd`（跨页块续接标记） |

整本 13 页汇总（实测）：

| | VL-1.6 | StructureV3 | MinerU 基线 |
|---|---|---|---|
| 块 `parsing_res_list` | 346 | 376 | — |
| 行级文本框 | 无 | **1760** | 无 |
| 版面框 / 中位置信 | 549 / 0.783 | 656 / 0.782 | — |
| 表格 | **9** | **9** | **9** |
| 单元格框 | 无 | **146** | 无 |
| chart | **8** | **8** | **8** |
| 公式条目 | 192（`inline_formula` 框） | 234（`formula_res_list`） | 324（`inline_equation` span） |
| markdown 字符 | 44 644 | 29 166 | 48 444（full.md） |

**可直接当独立分母用的一条**：表 9 / 图 8 在三个引擎上完全一致；但页级归属有分歧
（V3 把 p3 的 1 个 chart 记到 p4、p6 与 MinerU 互换 1 个表/图）。⇒ 计数级可当判据，
位置级分歧应进 `needs_review`，不得自动改数据。

---

## 4. 结论：现在的 OCR 被浪费在三处

1. **传输层丢坐标**（结构性，非配置问题）：MCP 的文档解析任务只回 markdown 文本，`detailed` 也不给 bbox（§3 有实测）。
   ⇒ 想拿坐标只有两条路：直接打 `/api/v2/ocr/jobs` 自己解析 jsonl，或自建 serving。换 `output_mode` 没用。
2. **参数层一个没传**：`scripts/ocr-page-fill.ts:238`、`scripts/ocr-fill.ts:203` 调用不带 `runtime_params`
   ⇒ 全用服务端默认。VL 的 SDK 侧共 31 个可调项，MCP 白名单只放行 22 个，被挡掉的 9 个里
   `prettifyMarkdown / showFormulaNumber / restructurePages / mergeTables / relevelTitles / outputFormats / returnMarkdownImages`
   都只能在 HTTP 通道用。**今日实测**：`restructurePages+mergeTables+relevelTitles+showFormulaNumber+prettifyMarkdown:false`
   服务端 **接受**（VL md 从 2397 字符变 1643，公式编号开始出现在正文）；
   `markdownIgnoreLabels:["header","footer"]` 服务端 **接受**；`outputFormats:["docx","html","md"]` **422 拒绝**。
3. **粒度层逼出启发式**：因为拿不到位置，`scripts/ocr-page-fill.ts:468-489` 只能把 OCR 文本**按洞的宽度等比例摊回字符**
   （再配 §99 的列中分栏 `:300-310`、行分组 `:289-331`）。VL 自己就给 `block_bbox + block_order`，
   V3 还给行框和逐行 `rec_scores` —— 摊字符这一步在原理上是不必要的。

---

## 5. 对 `docs/paddleocr.md` 那份对比报告的核对

| 报告说法 | 实测判定 |
|---|---|
| 「VL 以语义内容为主，**坐标粒度粗**」 | **偏保守**。VL 给块级 bbox + 标签 + 顺序 + 版面框置信，只是不给行/单元格级。项目要用的「这段文字在哪个洞、第几行」块级已够 |
| 「VL 参数少，主要靠整模型替换」 | **不准确**。SDK 层 31 个 options，且 5 个关键行为开关实测生效（`prettifyMarkdown` 直接改写输出密度） |
| 「谁更快说法不一致，别只看跑分」 | **方向正确**，且本次给出数据点：整本 PDF 异步 V3 5.5 s/页 vs VL 16.8 s/页（同机同日） |
| 「V3 唯一无法替代的地方是坐标」 | **成立**，但要加限定：块级坐标 VL 也有；V3 独占的是**行级框 + 单元格框 + 独立公式条目** |
| 「两条线常组合：V3 出版面与坐标，难区域交给 VL 精修」 | **成立且成本极低**：同一 endpoint 换 `model` 字符串即可，参数命名不同（V3 用 `useTableRecognition/useFormulaRecognition`，VL 用 `useChartRecognition/useSealRecognition`） |
| 「VL 精度依赖完整管线，单调 0.9B VLM 会幻觉」 | **成立**，与本次一致（API 走完整管线时才会附 `parsing_res_list`） |
| 「OmniDocBench 96.33%」「超越 Gemini-3-Pro、GPT-5.2」 | **未独立验证**，属厂商宣传（引用链是新闻稿与博客）。按本项目纪律：只能当选型线索，不能当判据 |

---

## 6. 运维与安全发现（本轮顺带踩到）

1. **配置里的 token 已失效**：`~/.workbuddy-ai/mcp.json` 的 `PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN`
   打 `/api/v2/ocr/jobs` 返回 **401 Unauthorized**；本轮全部实测用的是 `docs/api/PP-StructureV3 api` 里那个。
   这与 MiniCPM 评估记录里「PaddleOCR-VL 本会话不可用」是同一现象。
2. **`daily.ts` 的凭据门只判存在不判有效**（`scripts/daily.ts:130-137`）⇒ token 死了它会**静默跳过 OCR 补行**，
   不报错。这是「不静默失败」红线的反面案例。
3. **`mcp.json` 里该 server 是 `disabled: true`**，脚本仍靠 `uvx` 自己拉起，配置与实际不一致。
4. **服务端疑似按「文件字节 + payload」去重**：同一 PNG 第二次提交 1.7 s 返回、响应逐字节相同（sha256 前缀 `05f85b18`）；
   换 payload（加开关）后重新计时 17.6 s。⇒ 任何时延基准**必须换新字节**，否则会把缓存当性能；
   这也解释了 `scripts/ocr-fill.ts:158-160` 那条「重试要换不同字节」的老坑。
5. **坐标空间不统一**：图片输入按图片像素（1000 宽页 → bbox ≤1000），PDF 输入按渲染尺度（4186×5988）。
   混用时**必须按 `prunedResult.width/height` 归一化**，否则 §3 的框会对不上页图。
6. **明文 token 出现在 `docs/api/PP-StructureV3 api`**：该文件与 `docs/paddleocr.md` 目前都是 git 未跟踪（`??`）。
   **别按现状提交**；建议把 token 换成占位符，真值只走环境变量。

---

## 7. 尚未验证（别当已知）

1. **精度**：本轮只验「字段是否存在」，没有对 VL/V3/MinerU 的**文本正确率**做逐字对照；块/行计数与一致率不等于准。
2. **高分辨率是否更好**：`min_pixels/max_pixels`、72 dpi vs 173 dpi 输入未做对照（`return_word_box=False`，字级框未开）。
3. **75–90 s/页 vs 42 s 之差的归因**：需要「同字节、同模型、两通道」受控 A/B。
4. **配额与限流**：并发 3 作业成功、未见 429；每日额度、QPS 上限、单作业页数上限都未测。
5. **`mergeTables/relevelTitles` 的实际效果**：服务端接受参数，但产出是否真做了跨页表合并/标题分级，未逐页核。
6. **公式**：V3 表格内公式实测**碎片化**（`pred_html` 里出现 `<td>（） （） （ $(2)I=\frac` 这类乱序），
   与 DECISIONS §106「三台机器源在公式上集体失明」一致 —— **本轮不构成公式可认证的任何新证据**，
   B-25（公式 OCR 专项）仍是 `DROPPED`，不要自动捡起。
