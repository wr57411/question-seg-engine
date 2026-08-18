# 真实 MinerU API 观测记录（2026-08-18 冒烟）

> 本文件是客户端解析代码的唯一字段事实来源。任何字段名以实测为准，官方文档与实测冲突时以实测为准并记录差异。
>
> 冒烟样张：`sample/23必刷题 2相互作用.pdf`（9,182,291 字节，扫描版教辅，15 页）。脚本：`scripts/api-smoke.ts`。
> 原始响应落盘：`data/smoke/raw/*.json`、`data/smoke/raw/poll-states.log`、`data/smoke/raw/put-status.txt`（data/ 不入库）。

## 0. 通用响应包裹格式（所有端点一致）

```json
{ "code": 0, "msg": "ok", "trace_id": "<32位hex>", "data": { ... } }
```

- 业务错误不返回 HTTP 错误码，而是 `code != 0` + `msg`（HTTP 恒为 200）。示例：
  - `{"code":-10002,"msg":"field \"files[0].name\" is not set"}`（字段名错误）
  - `{"code":-10002,"msg":"file list is empty"}`（files 空数组）
  - `{"code":-60002,"msg":"unsupported file type:probe.bin","err_params":["probe.bin"]}`（文件扩展名不在白名单；实测接受 `probe.pdf`，拒绝 `probe.bin`——客户端必须校验扩展名）

## 1. POST /api/v4/file-urls/batch（申请上传链接）

**请求体（实测有效结构，Authorization: Bearer <key> + Content-Type: application/json）：**

```json
{ "files": [ { "name": "23必刷题 2相互作用.pdf", "fileSize": 9182291 } ] }
```

- 数组元素键名必须是 `name`（不是 fileName / filename，首探即 `code:-10002`）。
- `fileSize` 为字节数；只传 `name` 也可成功（探测过 `{"name":"probe.pdf"}` 同样返回 200）。

**响应（data 内字段，verbatim 摘录）：**

```json
{
  "code": 0, "msg": "ok",
  "trace_id": "d0c3372da638bbbb580a760728099bce",
  "data": {
    "batch_id": "45506cd0-429a-4e5b-9d10-9b27a07828ec",
    "file_urls": [
      "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/extract/2026-08-18/45506cd0-429a-4e5b-9d10-9b27a07828ec/ca8fac20-ddda-4fc0-bd3f-552a54b4e048.pdf"
    ]
  }
}
```

**字段表：**

| 字段路径 | 类型 | 示例 | 说明 |
| --- | --- | --- | --- |
| `code` | number | `0` | 0=成功；负数为业务错误 |
| `msg` | string | `"ok"` | 错误时为人话描述 |
| `trace_id` | string | `"d0c3372da638bbbb580a760728099bce"` | 排查用，客户端可忽略/保留 |
| `data.batch_id` | string (uuid) | `"45506cd0-429a-4e5b-9d10-9b27a07828ec"` | 后续所有接口的批次标识 |
| `data.file_urls` | string[] | 见上 | **字符串数组（不是对象数组）**。`file_urls[0]` 即该文件的预签名 PUT 地址（阿里云 OSS，含 `Expires/OSSAccessKeyId/Signature` 查询参数） |

## 2. PUT 上传（预签名 URL）

- **必须不带 `Content-Type` 头**。实测矩阵（同一批次的预签名 URL）：
  - 无 Content-Type 头 → **HTTP 200**
  - `Content-Type: application/pdf` → 403 `SignatureDoesNotMatch`
  - `Content-Type: application/octet-stream` → 403 `SignatureDoesNotMatch`
- 原因：服务端签署预签名 URL 时未纳入 Content-Type；OSS 会把请求里实际出现的 Content-Type 计入 StringToSign 比对（错误响应里 `StringToSign` 可见 `application/pdf` 占据了第二行）。
- node fetch 对 Buffer body 默认不自动带头，直接 `fetch(url, { method: "PUT", body })` 即可。
- 成功响应体为空：`status=200`（`data/smoke/raw/put-status.txt`）。
- 上传后立即就能轮询（下一轮状态已非 waiting-file）。

## 3. GET /api/v4/extract-results/batch/{batch_id}（轮询）

**响应结构（verbatim）：**

```json
{
  "code": 0, "msg": "ok",
  "trace_id": "3df0dd187f00115ca0be162a1694ee17",
  "data": {
    "batch_id": "45506cd0-429a-4e5b-9d10-9b27a07828ec",
    "extract_result": [
      {
        "file_name": "23必刷题 2相互作用.pdf",
        "state": "done",
        "err_msg": "",
        "full_zip_url": "https://cdn-mineru.openxlab.org.cn/pdf/2026-08-18/f36878e9-9a52-4ad5-b52b-f0a15135417a.zip"
      }
    ]
  }
}
```

**字段表：**

| 字段路径 | 类型 | 示例 | 说明 |
| --- | --- | --- | --- |
| `data.batch_id` | string | 同上 | 回显 |
| `data.extract_result` | array | — | **每文件一个元素**（多文件批处理时逐文件状态） |
| `data.extract_result[].file_name` | string | `"23必刷题 2相互作用.pdf"` | 回显上传时的 `files[].name` |
| `data.extract_result[].state` | string enum | `done` | 见下状态机 |
| `data.extract_result[].err_msg` | string | `""` | 失败原因，完成时为空串 |
| `data.extract_result[].full_zip_url` | string | `https://cdn-mineru.openxlab.org.cn/pdf/2026-08-18/...zip` | **完成态才出现**（未完成时该键不存在）；zip 下载地址，主机是 CDN 而非 api 域 |

**实测状态序列（两次真实运行）：**
- 运行 A（含上传前首轮）：`waiting-file` → `pending` → `running` → `done`
- 运行 B（上传完成后再轮询）：`waiting-file` →（5s 后）`done`
- 即合法取值至少：`waiting-file` / `pending` / `running` / `done` / `failed`（官方文档另有 `stopped` 等，未实测）。轮询间隔 5s、本样张（9MB 扫描件 15 页）从上传到 done 约 5~20s。
- zip 下载 GET 可直接带 Authorization 头（未尝试不带；若后续 403 再调整为裸 GET）。

## 4. 结果 Zip 结构（data/smoke/unpacked/）

解包 result.zip（9,528,756 字节）后条目（前缀 `91c42a32-79f9-4e33-8d09-db985cdc5d92` 为任务内部 UUID）：

| 条目 | 大小 | 内容说明 |
| --- | --- | --- |
| `<id>_origin.pdf` | 8.8M | 原始 PDF 回传（与上传件基本同大小） |
| `<id>_content_list.json` | 124K | **v1 扁平块列表（355 条）** |
| `<id>_content_list_v2.json` | 292K | **v2 层级块列表（15 页 × 各页块数组）** |
| `<id>_model.json` | 580K | 模型中间结果：15 页 × `{layout_dets, page_info}` |
| `full.md` | 56K | Markdown 渲染全文（OCR + 公式转 LaTeX + `![](images/<sha256>.jpg)` 图片引用） |
| `layout.json` | 2.7M | 版面 JSON：顶层 `pdf_info` + `_backend` + `_version_name` |
| `images/` | 100 个 jpg | 页面插图/图表，文件名为 sha256 hex |

### 4.1 content_list.json（v1，扁平版）

顶层是**数组**（非 `{pdf_info}` 对象），355 条 = 各页块平铺。每条：

```json
{ "type": "text", "text": "第二章 相互作用", "text_level": 1, "bbox": [370, 53, 614, 77], "page_idx": 0 }
```

- 键：`type`（enum：`text` / `image` / `footer` / `aside_text` / `page_number` / `chart` / `header` / `equation`，实测所见全集）、`text`（文本内容，image/chart 等无文本块为缺失键）、`text_level`（number，同页内段落层级，如标题为 1）、`bbox`（`[x0,y0,x1,y1]`，PDF 坐标点）、`page_idx`（number，0 起页号→**每条都带，无独立 page_size**）。
- image/chart 块：无 `text`，需要靠 `layout.json` 的 `pdf_info[page_idx].para_blocks` 里的 bbox/image 字典反查图文件。

### 4.2 content_list_v2.json（v2，层级版）

顶层数组 = 15 页，每页又是一个**块数组**；块带 `content` 分层对象。示例：

```json
{ "type": "title", "content": { "title_content": [ { "type": "text", "content": "第二章 相互作用" } ], "level": 1 }, "bbox": [370, 53, 614, 77] }
{ "type": "paragraph", "content": { "paragraph_content": [ { "type": "text", "content": "第1节 重力 弹力 摩擦力" } ] }, "bbox": [117, 136, 434, 153] }
```

- 块类型除 v1 的 8 种外新增容器型：`title` / `paragraph` 等，其下 `content.<type>_content[]` 内嵌子块（`text` / `image` / `table` / `equation`…），标题块还带 `content.level`。
- **v2 是 Task 4 结构化切分更友好的输入**（层级天然、块边界干净）；v1 扁平版 355 条仍按 `page_idx` 分组可用。

### 4.3 layout.json〔与 normalize.ts 假设直接相关〕

顶层键：`pdf_info` / `_backend`（如 `"magic_pdf"` 类后端标识）/ `_version_name`。
`pdf_info` 为 15 页数组，每页：

```json
{ "preproc_blocks": [...], "page_idx": 0, "page_size": [596, 821], "discarded_blocks": [...], "para_blocks": [...] }
```

- `page_size` 是 `[宽, 高]`（PDF 点）；`para_blocks` 为该页段落块（含 bbox 与图片引用）。**这是目前唯一带 `page_size` 与「pdf_info」命名的地方。**

## 5. 与官方文档 / 现有 normalize.ts 假设的差异

1. **`pdf_info` 不在 content_list 里**：`src/normalize.ts` 假设 `*_content_list.json` 顶层是 `{ pdf_info: [{page_idx, page_size, blocks}] }`（旧版 MinerU 结构）。实测 v1 是纯数组、无 `page_size`；带 `pdf_info` + `page_size` 的结构在 `layout.json` 里（且块字段名是 `para_blocks`/`preproc_blocks`/`discarded_blocks` 而非 `blocks`）。→ Task 3/4 的 normalize 需要改输入源或做两种形状适配。
2. **文件列表元素键名**：`files[].name`（官方旧文档写 `fileName`）。请求体其余可选参数（`is_ocr`、`enable_formula`、`layout_model` 等）未在本冒烟中使用。
3. **zip 下载字段**：`data.extract_result[].full_zip_url`（非 `file_url`；未完成时该键不存在，须做存在性检查）。
4. **错误即 200**：所有业务错误以 HTTP 200 + `code != 0` 返回，客户端不能只看 HTTP 状态码。
5. **v1/v2 双 content_list**：同一样张同时产出两个版本；项目回归样本 `data/smoke/content_list.json` 取 v1（355 条）。

### 5.1 normalize.ts v1 适配点（Task 4，2026-08-18 实测）

`normalizeContentList` 现在按顶层形态分流：`Array.isArray(raw)` → v1 扁平分支，对象含 `pdf_info` → 旧版层级分支（原逻辑不动，仍可解析）。v1 分支映射：

| v1 元素 type | 归一化为 | 关键字段映射 |
| --- | --- | --- |
| `text` | `kind: text` | 文本直接是元素级 `text` 字段（**非** lines/spans）；`firstLine` 取首个 `\n` 段（样本中 41 条含换行）；无字号信息 → `maxFontSize: 0` |
| `image` / `chart` | `kind: image` | 路径字段是 **`img_path`**（非 `path`）；无 img_path 时兜底 `image-p<page>-i<n>.png`，bbox 始终保留 |
| `equation` | `kind: formula` | LaTeX 在 `text`，以 `$$...$$` 包裹（如 `"$$\n{ \frac { 5 } { 8 } } G\n$$"`），解包为裸 latex |
| `header` / `footer` / `page_number` / `aside_text` | **丢弃** | 版面家具非试题内容：footer 文本可能干扰状态机（样本 footer 为励志语录）、aside_text 位于页边（y 序会插入正文流中间）、page_number 为纯数字。丢弃而非并入 text，保证切分只面对内容块 |

- **page_size 缺失**：v1 每条只有 `page_idx`，无 page_size → `PageInfo.width/height = 0`，layout 层走默认页宽 1654 单栏排序。不尝试从 bbox 反推页宽：真实 bbox 坐标系与 layout.json 的 `page_size`（596×821）比例不一致（bbox x 达 ~980、y 达 ~970），无可靠几何信息。
- **分栏限制（实测）**：本教辅样张真实为双栏（page 0：左栏题 1-4 与右栏题 5-7 同 y 并排），但栏间 x0 间隙仅 ~40-110，而 `detectColumns` 阈值是页宽 28%——默认页宽下全页判定单栏，按 y 排序导致左右栏题目交错（题号序 5,1,2,6,3,4,7）。精确分栏需 v2 content_list 或 layout.json（块字段为 `para_blocks` 系）的几何信息，属 Task 5+ 演进点。
- **选项块粒度**：v1 把 4 个选项常合并进同一个 text 块（如 `"A. …B. …C. …D. …"`），规则引擎只认块首的 `A.` → 每题仅收集 1 个选项、其余选项留在题干文本内（reviews: 选项组中断 37/选项乱序 25）。这是 v1 块粒度的物理限制，非解析缺陷。

**回归结果（Task 4）**：真实样本 355 条 → 归一化 304 个内容块（丢弃 51 条家具）→ 切出 **83 题**（与语言层题号模式独立预测数一致）、图片归属 97、公式块 3、回拼校验零失败（无 pickFail review）。全部 83 题为 needs_review（选项组收集失败 + 双栏交错导致跨页同号「重复题号」），符合 v1 扁平结构的预期下限——题号切口可用、选项/顺序质量留给 v2/LLM 阶段。