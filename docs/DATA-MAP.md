# DATA-MAP — 这个仓库里什么能信，什么只是快照

> **任何 Agent 开工前必读**（与 `docs/HANDOFF.md`、`tasks/lessons.md` 并列）。
> 存在理由：2026-11-02，我拿 `data/out/*/questions.json` 当"当前代码行为"，做了三轮根因推理，
> 打点一跑**全部证伪** —— 那些产物是三个月前的快照。见 `tasks/lessons.md` **L7**。
>
> **一句话：`data/` 下的一切都不是事实，是某次运行的快照。事实在 `src/` + `git log`。**

---

## 一、权威性分级

| 级别 | 含义 | 目录/文件 | 能不能拿它下结论 |
|---|---|---|---|
| **A · 源头** | 不会说谎的输入 | `books/*.pdf`、`sample/*.pdf`、`fixtures/*.json`、`gold/*.json` | 能（gold 是人工标准） |
| **B · 代码** | 当前行为的唯一权威 | `src/**`、`scripts/**`、`tests/**` | 能（且**必须用它重跑**再说行为） |
| **C · 契约** | 口径、决策、红线 | `docs/DECISIONS.md`、`docs/ATTRIBUTION.md`、`tasks/lessons.md` | 能（改判据前必查） |
| **D · 快照** | 某次运行的产物，**随时可能过期** | `data/out/**`、`data/smoke/**`、`data/batch/**`、`data/fuse/**`、`data/oxr/**` | **不能**。引用必须注明"哪次运行" |
| **E · 临时** | 可随时删，不进仓库 | `tmp/**` | 不能 |

---

## 二、`data/` 逐目录说明

| 路径 | 是什么 | 谁生成 | 权威 | 过期如何发现 |
|---|---|---|---|---|
| `data/out/<册>/layout.json` | MinerU 版面 JSON | `npm run daily` / `real-pipeline.ts` | D | 看 `_backend` 字段：**有 = 原始解析；无 = 被 dedup/fuse 改过** |
| `data/out/<册>/content_list.json` | MinerU 扁平块 | 同上 | D | 同上 |
| `data/out/<册>/pages/*.png` | 原卷页图（1 起始序号） | 同上 | **A（可视作原卷）** | 与 `layout.json` 的 `page_idx` 差 1（`page-011.png` = `page_idx 10`） |
| `data/out/<册>/questions.json` | 切题结果 | `daily` / `segmentFromLayout` | **D** | 与引擎 mtime 比：`npm run preflight` |
| `data/out/<册>/stages.json` | 展示快照 | `npm run stages:export` | D | 同上 |
| `data/out/<册>/meta.json` | 体检摘要 | `daily` | D | 含 `importedAt`（**不是**引擎版本） |
| `data/out/<册>-OXR/` | 第二解析源（OXR）产物 | `--parser oxr` | D | 与 MinerU 侧同样处理 |
| `data/out/bank/` `tags/` `topics/` `teach/` | 题库/标签/专题/教学层 | 各自的 `npm run bank` 等 | D | 依赖上游产物，上游过期它也就过期 |
| `data/smoke/` | 首次 API 冒烟原始响应 | `scripts/api-smoke.ts` | D（但**字段事实以它为准**） | 一次性的，不再变 |
| `data/batch/` `fuse/` `oxr/` | 批处理/融合/第二源中间态 | 对应脚本 | D | — |
| `data/archive/` | 历史调试产物（**只移不删**） | 人工归档 | D | 不要引用 |
| `data/score/` `ans-probe/` `_diag-parse/` `batch-inbox/` | 评估/探测/诊断 | 对应脚本 | E | 可删 |

---

## 三、五条硬规则

1. **说"代码现在的行为"之前，必须用 `src/` 重跑一遍**，不许引用 `questions.json`。
   只读排查请直接 `segmentFromLayout(layout, docId)` 当场算。
2. **引用任何 `data/` 数字，必须带来源**：哪次运行 / 哪个提交 / 哪条命令。否则不可复现 = 不是证据。
3. **`layout.json` 不是天然原样**：没有 `_backend` 的，说明被我们自己的 dedup/fuse 处理过，
   此时"上游给了什么"已经不可追。
4. **`BACKLOG` 里说"已重生成"不代表 `data/out/` 里是新的** —— 产物 git 忽略，换机器/换分支就没了。
   两者矛盾时，以 `npm run preflight` 为准。
5. **页图是唯一可信的"原卷"**（级别 A）。凡涉及页面事实（文字在哪、有没有被搬动、版面对不对），
   一律裁原图核对：走技能 `screenshot-evidence`（`~/.workbuddy/skills/screenshot-evidence/`）。

---

## 四、开工三步

```bash
npm run preflight          # ① 看产物新不新、layout 是不是原样
npm run check              # ② 门必须全绿（见 AGENTS.md）
# ③ 再开始分析；分析过程中随时回看本文件第 3 节
```

`preflight` 输出里出现 `⚠ 过期` 的含义：**这份产物不能代表当前代码**。
要下行为结论 → 先 `npm run daily -- <pdf>` 重跑；只做只读排查 → 用 `segmentFromLayout` 现场算。

---

## 五、维护

- 新增任何 `data/` 子目录，**当场补进第二节表格**，写清「谁生成 / 权威级 / 过期如何发现」。
- 本文件只讲**数据血缘**，不讲架构（架构看 `README.md`）、不讲状态（看 `HANDOFF.md`）、
  不讲决策（看 `DECISIONS.md`）。
