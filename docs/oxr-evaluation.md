# OXR 模型评估 — 可交付目标清单与实验记录

> **目的**：学习 SoMark 开源的 OXR 文档解析模型，用官方免费 API 实际调用线上模型，
> 验证它能否让本项目（MinerU 解析结果的后处理层）做得更好。
> 清单随执行更新，状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成 / `[-]` 调整取消。
> 建立日期：2026-10-27。分支：`feature/oxr`。

---

## 0. 学习摘要（G1 产物）

### OXR 模型是什么

- SoMark 团队开源的**文档解析模型**，参数量仅 **1.3B**，国产（基于 GLM 架构）。
- **三榜第一**：OmniDocBench **97.18**、olmOCR-Bench **87.84**、DocParsingBench **87.76**
  （截至 2026-10 公开榜单），超过 Gemma-3-12B、Qwen3-VL-8B 等更大模型。
- 训练范式叫 **RSI（Recursive Self-Improvement，递归自提升）**：模型自己生成数据 →
  自我评估 → 迭代训练，官方称 10 轮内平均精度提升 12.3%。
- **两阶段架构**：独立的轻量布局分析模型（切版面区域）→ OXR 主模型（识别 + 阅读顺序）。
- 能力范围：文本、表格、公式（LaTeX）、化学结构式（SMILES）、图形/插图、阅读顺序；
  输入支持 PDF 与常见图片（png/jpg/jpeg/bmp/tiff/webp）。
- 微信文章演示过**数学试卷**逐题解析（题干/公式/图形还原），与本项目场景（试卷结构化）直接相关。

### 免费 API（免注册、免鉴权）

| 项 | 事实 |
|---|---|
| Base URL | `https://free-oxr.somark.cn/api/v1` |
| 鉴权 | `api_key` 字段**必须存在但不校验**，填 `dummy` 即可 |
| 端点 | `POST /parse/sync`（同步）；`POST /parse/async` + `/parse/async_check`（异步） |
| 限制 | 单文件 **≤10MB**、**≤20 页**；免费档排队处理 |
| 请求 | `multipart/form-data`：`api_key`、`file`、`formats[]`（json/markdown，无 zip）、`keep_header_footer`、`extra`（JSON 串：temperature/top_p/repetition_penalty） |
| 响应 | `{ code, message, warnings[], data }`；`data.result.outputs.json.pages[].blocks[]`，每块含 `idx/type/bbox/content/format/captions/img_url`，页含 `page_num/page_size{w,h}` |
| 错误码 | 1133 参数错误 / 1137 解析失败 |

### 与本项目的关系

本管线唯一上游耦合点是 `src/normalize.ts`（红线：换解析供应商只改这里）。
MinerU `layout.json` 与 OXR `json.pages[].blocks[]` 同构（页 → 块 → type/bbox/content），
OXR 有潜力成为：① **替代上游**（省 MinerU 额度）；② **第二解析源**（交叉核对，补 MinerU 漏识别）。

本项目已知的上游短板（HANDOFF §6，正是 OXR 可能补的）：
1. **整行漏识别**（第 1 题题号行曾整行丢失，靠 OCR 补回）；
2. **字母 O 系统性读成数字 0**（15 行，未修）;
3. **墨迹洞 45 处**（原卷有墨迹但解析+OCR 都没读出，含图注「甲/乙/丙」）。

---

## 1. 可交付目标清单（随执行更新）

- [x] **G1 学习 OXR 模型与免费 API** — 摘要见上 §0（来源：docs.somark.cn 全部 OXR/SoMark 接口页 + 量子位文章）。
- [x] **G2 生成可交付目标清单并落成文档** — 本文件。
- [x] **G3 免费冒烟**：单页 PNG 调 `free-oxr /parse/sync` — 响应结构与 bbox 坐标系见 §2.1。
- [x] **G4 全卷实验**：题册 15 页过 OXR 免费 API（8.8M，HTTP 200，约 2 分钟）；
  答案册 23 页超免费档限制，经正式版 API（用户提供 key，日免费 500 页）补跑 — 见 §2.2。
- [x] **G5 逐项对比 OXR vs MinerU**（用既有真值锚点）— 见 §2.3：
  - 题号行：OXR markdown 直接读出 **83 个带来源标签的题号形态、缺号 0**
    （MinerU 曾整行漏掉第 1 题题号行，需 OCR 补回才有 83）；
  - 字母 O→0：MinerU 题册「O点」8 次 +「0点」8 次（8 行错读）；OXR「O点」**16 次、「0点」0 次**
    —— 16 = 8 对 + 8 错，**全部读对，零错**（HANDOFF §6-13 的系统性错读，OXR 侧不存在）；
  - 图注：OXR 以 `Caption` 类型直接读出 甲/乙（p3/p4/p13/p14）与 曲辕犁/直辕犁
    —— 正是 MinerU+OCR 双漏的 HANDOFF §6-14 未闭合风险；
  - 墨迹洞：130 个未覆盖墨迹区域中 OXR 在 32 处有文本块相交（口径注：uncovered 含大量
    线条/家具噪声，≠ 45 个内容洞，此数仅作参考不作结论）；
  - 公式：OXR 507 对 `$...$` vs MinerU 102 行内（stats 口径）—— 召回更高，
    但存在**正文误包进 `$...$`** 的噪声（抽样 8 个中 3 个），与本项目 formula.ts
    六类噪声分桶的检测对象吻合（检测不改写红线正好适用）。
- [x] **G6 适配性实验**：OXR JSON → layout.json 同构转换（`data/oxr/oxr-as-layout.json`，
  转换规则与踩坑见 §2.4）→ **现有引擎一行不改跑 `segmentFromLayout`：
  83/83 题切出，ok 82 + 待校对 1**；与 MinerU 同口径对照表见 §2.4。
- [x] **G7 实验报告 + 结论** — 见 §3；可视化审板页 `data/oxr/report.html`
  （原卷页图 + OXR bbox 框叠加 + 逐块文本，浏览器直开）。

### 执行中的调整记录（追加，不删）

- 2026-10-27 初版：G1–G7 七项。
- 2026-10-27：G4 扩容——用户中途提供 SoMark 正式版 key（`sk-vmS***`，只进环境变量不落盘），
  答案册 23 页超免费档 20 页限制，改用正式版 API 补跑；发现**正式版与免费版输出 schema 不同**
  （小写类型、粒度更细：footer/figure_caption/equation/blank/choice），适配层须按服务分支（§2.2）。
- 2026-10-27：G6 从「纸面评估」升级为「实跑验证」——写了转换器 + `scripts/oxr-eval.ts`
  （评估专用，不接入 `npm run check`），证据硬度高于原计划。

---

## 2. 实验记录

### 2.1 G3 冒烟（题册 p1 PNG，2026-10-27）

- `POST https://free-oxr.somark.cn/api/v1/parse/sync`，`api_key=dummy`（免注册），
  单页 PNG 22.6s 返回，`code:0`、无 warnings。
- 响应：`data.result.outputs.{json, markdown}`；`json.pages[].blocks[]` 每块
  `idx / type / bbox / content / format / captions / img_url`，页含 `page_size{w,h}`。
- **坐标系**：PNG 输入时 page_size = 995×1369 = 图片像素；PDF 输入时 page_size = 1243×1712
  ≈ 150dpi 光栅（596pt × 2.085）⇒ **bbox 恒为光栅像素口径**，换算 pt 用 page_size 比例。
- 块类型（免费版）：PascalCase `Title / Text / Picture / Caption`；图片块 content 是
  指向 free-oxr 服务器的 markdown 图片 URL（会过期，正式接入需下载落盘）。
- 冒烟页即「MinerU 曾整行漏识别第 1 题题号行」的那页：OXR markdown 开头直接是
  `1. [广东广州 2022 月考] 如图, 建筑工人为检查墙砌得…` —— 整行完好。

### 2.2 G4 全卷（题册免费版 + 答案册正式版）

| 项 | 题册（OXR 免费版） | 答案册（SoMark 正式版） |
|---|---|---|
| 输入 | 8.8M / 15 页 PDF | 5.1M / 23 页 PDF |
| 耗时 | 约 2 分钟（同步等待） | 约 1 分钟 |
| 块数 | 308（Title 9 / Text 195 / Picture 90 / Caption 14） | 731（text 411 / title 179 / footer 46 / figure 54 / figure_caption 23 / blank 4 / choice 1 / equation 13） |
| 类型命名 | PascalCase | **小写**，粒度更细（footer 单分、figure_caption、equation、blank、choice） |
| page_size | 1243×1712 | 1155×1697 |

⚠️ **两版 schema 不同**：适配层必须按 base URL（free-oxr / somark.cn）分支，或做类型归一表。
正式版 key 的额度：每日免费 500 页 / 每月 2000 页（`POST /usage` 可查）。

### 2.3 G5 逐项对比（判据锚点全部来自被检验对象之外的既有真值）

| 锚点（独立真值来源） | MinerU | OXR |
|---|---|---|
| 题号形态清点（OXR markdown `^\d+\.\s*[［\[]`） | 引擎切出 83 题（其中第 1 题题号行靠 OCR 补回） | **83 个，缺号 0** |
| 「O点」错读（HANDOFF §6-13，独立 OCR 交叉核对在案） | O点 8 + **0点 8（8 行错读）** | O点 16 + **0点 0（零错）** |
| 图注 甲/乙（HANDOFF §6-14：MinerU+OCR 双漏，45 洞的一部分） | 读出空文本（洞） | **Caption 类型直接读出**（p3/p4/p13/p14 甲乙 + 曲辕犁/直辕犁） |
| OCR 补回行 126 条（stages.json ocrFill/ocrFullText） | 须两条 OCR 链路补 | 直接命中 99，复核口径后 ≈104+（余为单字噪声/页眉家具，双方一致不读或 OXR 按 keep_header_footer=false 丢弃） |
| 行内公式对数 | 102（stats 口径） | 507（含「正文误包 `$...$`」噪声，抽样 8 中 3） |

### 2.4 G6 适配实验（OXR 做上游，现有引擎一行不改）

转换规则（`data/oxr/book-response.json` → `data/oxr/oxr-as-layout.json`）：
1. `pages[].blocks[]` → `pdf_info[].para_blocks[]`（⚠️ 引擎 `normalizeLayout` 读的是
   **para_blocks**，写 preproc_blocks 会静默得到 0 块 → 15 页全 1 栏 → 0 题，实测踩中）；
2. 类型映射 `Title→title / Text→text / Caption→text / Picture→image`（小写）；
3. bbox 按 `page_size` 比例从光栅像素缩放回 pt（题册 596/1243、821/1712）；
4. 文本块 `lines[{spans[{content}]}]`（块内 `\n` 保留，`matchFirstLine` 取首行仍有效）；
5. 图片块需**嵌套** `blocks[{lines[{spans[{image_path}]}]}]`（与真实 layout.json 的 image 块同构，
   直接 `lines` 顶层放会「图片归属 0」，实测踩中），`image_path` 从 markdown 语法剥出纯 URL。

同口径对照（同一 `scripts/oxr-eval.ts` 跑两个上游）：

| 指标 | MinerU 上游 | OXR 上游（转换后） |
|---|---|---|
| 切题数 | 83 | 83 |
| ok / 需校对 | 80 / 3 | **82 / 1** |
| review 性质 | 选项缺键（**疑似上游漏检**，热狗题等真实问题）×6 条 | 选项乱序 E↔A（**块粒度问题，非内容缺失**）×16 条 |
| 选项组 | 78 | 64（块更大，选项独立成块少） |
| 图片归属 | 97 | 90（OXR 检出 90 个 Picture 块） |
| 行内公式 | 102 | 319 |
| 分栏 | 15 页全 2 栏 | 6 页判 1 栏（块级几何粗于行级） |

结论：**管线对 OXR 上游可行**——83 题全切出、ok 率更高、review 全是可修的粒度问题；
主要缺口是**块级无行级几何**（影响分栏精度与字号保真的分母）与**多选题选项分块**。

### 2.5 局限（如实登记）

- 免费档 10MB / 20 页限制：23 页的答案册必须走正式版；正式版与免费版 schema 不同。
- bbox 为光栅像素（≈150dpi），缩放回 pt 有约 1px 级标定误差；无行级 bbox、无字号信息
  （字号保真度审计在 OXR 上游下没有分母，需另行标定）。
- 图片托管 URL 会过期（官方有 image-persistence 指南），正式接入必须下载落盘。
- 公式「正文误包 `$...$`」噪声需 `formula.ts` 检测（检测不改写，交人工决策）。
- 块粒度粗 → 分栏 6 页判 1 栏、选项组少 14 个 —— 版面层可能需要为 OXR 上游调阈值
  （触发「单卷过拟合」风险 §6-8 的同类问题，扩数据面前先不动）。

---

## 3. 结论：OXR 能否更好完成这个项目

**能，且在三个既有痛点上是直接解药；但作为唯一上游替换 MinerU 还不是首选，第一落点是「第二解析源/交叉核对」。**

1. **MinerU 的整行漏识别**（本项目两条 OCR 补行链路的存在理由）：OXR 在题册上
   83 个题号形态一次读全、零缺号 —— 该痛点在 OXR 上游下基本消失。
2. **字母 O 系统性读成 0**（HANDOFF §6-13，挂了未修）：OXR 16/16 全部读对、零错。
   该问题的「改写数据须显式决策」现在有了第二来源可对照，修法成本大幅下降。
3. **图注丢失**（HANDOFF §6-14，MinerU+OCR 双漏的洞）：OXR 有专门的 Caption 类型，
   甲/乙/曲辕犁/直辕犁全部读出。
4. 管线兼容性已实证：转换规则 5 条 + 现有引擎 0 改动 = 83/83 切题、ok 率高于 MinerU。
5. **建议的下一步（未实施，待拍板）**：
   - `normalize.ts` 增设 OXR 分支（红线允许：换/加解析供应商只改 normalize），
     `npm run daily` 加 `--parser oxr` 走通完整闭环 + 全量截图审板；
   - 把 OXR 作为交叉核对源接入现有产物：O→0 与图注两处按「两源一致才改写」的
     显式决策流程修复（判据与实现不同源）；
   - 保持 MinerU 为主上游，OXR 做差异报告（多解析源合并，呼应
     `docs/evidence/mineru-reparse-feasibility.md` 的「多切法合并有效」结论）。

### 可视化审板

- `data/oxr/report.html`：浏览器直开（file://）。左原卷页图 + OXR bbox 框叠加
  （橙=标题 蓝=文本 绿=图 粉=图注），右逐块文本，1–15 页翻页。
- 重点看：p1 第 1 题题号行（框内文字完整）、p5/p9/p10 的「O点」、p3/p13 的图注粉框。
