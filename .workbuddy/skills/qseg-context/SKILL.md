---
name: qseg-context
description: question-seg-engine 仓库的"上下文入口"。任何 Agent 在本仓库开工、排查、下结论之前先读它：它规定必读顺序、`data/` 的权威性分级（哪些是事实哪些只是快照）、开工三步自检、以及五条硬规则。涉及"哪几页切错""产物是不是新的""能不能引用 questions.json"时必用。
metadata:
  version: "1.0.0"
---

# qseg-context —— 本仓库的上下文入口

**存在理由（真实事故）**：2026-11-02，我读了 `data/out/*/questions.json`，输出一份「哪几册哪几页切错」
的清单，并据此做了三轮根因推理。打点一跑，**现场根本不复现** —— 那些产物是三个月前的快照。
`data/` 在 git 里被忽略、不跟代码版本走，我却把它当成了"代码现在的行为"。

**这条技能就是为了让下一个 Agent 不再犯同一个错。**

---

## 一、开工三步（不许跳）

```bash
npm run preflight      # ① 产物新不新？layout 是不是原样？
npm run check          # ② 门必须全绿，否则先修门，别带病开发
```

③ 然后读 `docs/DATA-MAP.md` 第三节「五条硬规则」，再开始分析。

`preflight` 出现 `⚠ 过期` ⇒ **这份产物不能代表当前代码**：
- 要下「行为」结论 → 先 `npm run daily -- <pdf>` 重跑
- 只做只读排查 → 用 `segmentFromLayout(layout, docId)` **当场算**，不要读 `questions.json`

---

## 二、权威性分级（背下来）

```
A 源头    books/*.pdf  sample/*.pdf  fixtures/  gold/         ← 不会说谎
B 代码    src/  scripts/  tests/                              ← 当前行为的唯一权威
C 契约    docs/DECISIONS.md  docs/ATTRIBUTION.md  tasks/lessons.md
D 快照    data/out/**  data/smoke/**  data/fuse/**  data/oxr/**  ← 会过期，不是事实
E 临时    tmp/**                                              ← 可随时删
```

**级别 D 的一切都不能直接当结论**，引用时必须写明"哪次运行 / 哪个提交 / 哪条命令"。

一条容易踩的：`layout.json` 有 `_backend` 才是 MinerU 原样输出；
**没有 `_backend` 就是被我们自己的 dedup/fuse 处理过**，"上游给了什么"已不可追。

---

## 三、必读顺序

1. `docs/HANDOFF.md` —— 当前状态、未闭合风险、红线（主入口）
2. **`docs/DATA-MAP.md`** —— 数据血缘：什么能信、什么只是快照
3. `README.md` —— 架构总览
4. `tasks/lessons.md` —— 工程纪律 L1–L7（**L6 归因先验、L7 产物新鲜度**）
5. `docs/BACKLOG.md` —— 待办台账（做什么 / 不做什么及原因）
6. 需要口径时查 `docs/DECISIONS.md`（只增不改，编号现算）

---

## 四、涉及页面事实时

凡要判断「这段字在原卷上是什么样 / 有没有被搬动 / 版面对不对」：

- **必须裁原卷页图**，不许推演、不许让别的模型转述。走技能 `screenshot-evidence`。
- 裁图用 `bash ~/.workbuddy/skills/screenshot-evidence/scripts/crop.sh in.png out.png WxH+X+Y`
  （内部 `ffmpeg crop`）。**不要用 `sips -c --cropOffset`** —— 实测会忽略偏移按居中裁。
- 页图与 `page_idx` 差 1：`pages/page-011.png` = `page_idx 10`。
- 同源数据不能互相当裁判：`content_list.json` 与 `layout.json` 同一次解析，错得一样。
  唯一独立来源是**页图**。

---

## 五、下结论之前的自检清单

- [ ] 我引用的数据是「现场重跑」还是「目录里的快照」？说清了没有？
- [ ] 我用的度量口径，先用另一种方式验证过吗？（本项目三次度量口径错误，全是"先出数后自证"）
- [ ] 涉及页面事实，我看过原图了吗？
- [ ] 我说"原书缺/错"了吗？—— 结构性异常一律先怀疑链路（`lessons.md` L6）。
- [ ] 我要改判据吗？—— 先跑 `npm test`，既有测试锁定的行为不许静默打破。

---

## 六、维护

每踩一个新的上下文类坑（例如新增数据目录、新的产物形态），
当着用户的面补一条进 `docs/DATA-MAP.md` 与本节清单，并升 `metadata.version`。
