// 夸克 DOC 流水线 v1 (切片 = 物理_教材基础练 电路)
// 用法：把本文件正文作为 workflow_start 的 script 参数提交（行内提交，不支持 import）。
// 说明：MCP 进程重启会丢内存态，journal 留 ~/.workflow-tool/journal/<runId>.jsonl；
//      恢复方式 = 重新 start 同一脚本，再把已完成的批次结果交回。

interface NewBookAudit {
  /** 电路章覆盖的印刷页数 */
  pages: number;
  /** 页重建依据的页码标记样例，最多 5 条 */
  pageMarkers: string[];
  /** 电路章在 DOCX 中的段落区间（以文本为准，注明编号口径） */
  chapterRange: string;
  /** 噪声形态发现，逐条 */
  noiseFindings: string[];
  /** 一句话结论 */
  verdict: string;
}

interface AnchorAudit {
  /** 是否在解析册中找到电路章 */
  found: boolean;
  /** 电路章的段落区间 */
  chapterRange: string;
  /** 栏目/题号锚点样例，最多 8 条 */
  samples: string[];
  /** 一句话结论 */
  verdict: string;
}

interface FormulaRestore {
  /** 抽样条数 */
  sampled: number;
  /** 静默错误条数（错却没被标记） */
  silentErrors: number;
  /** 已标记 needs_review 的条数 */
  flagged: number;
  /** 一句话结论 */
  verdict: string;
}

interface SliceReport {
  /** 切出的题数 */
  questions: number;
  /** 独立正则数出的题号数 */
  expected: number;
  /** 每题一行「页码|题号|首12字」 */
  items: string[];
  /** 一句话结论 */
  verdict: string;
}

interface MatchReport {
  /** 配对成功数 */
  matched: number;
  /** 题目总数 */
  total: number;
  /** 歧义条目 */
  ambiguous: string[];
  /** 未配对条目 */
  unmatched: string[];
  /** 一句话结论 */
  verdict: string;
}

interface Deliverable {
  /** 产出文件绝对路径 */
  files: string[];
  /** 自检结论逐条 */
  checks: string[];
  /** 是否可宣告完成 */
  done: boolean;
  /** 一句话结论 */
  verdict: string;
}

const DOCB = "/Users/john/.zcode/workspace/default/question-seg-engine/books/物理_教材基础练.docx";
const DOCANS = "/Users/john/.zcode/workspace/default/question-seg-engine/books/物理_6维解析册.docx";
const OLDOUT = "/Users/john/WorkBuddy/Worktrees/question-seg-engine/feature-oxr-6b3489a1/data/out/物理_教材基础练 电路/";
const PAGES = OLDOUT + "pages/";
const SPEC = "/Users/john/WorkBuddy/Worktrees/feature-oxr-6b3489a1/feature-oxr-478100c4/docs/specs/2026-11-16-quark-doc-pipeline-design.md";

phase("M0' 新切片对账：页重建 / 噪声 / 答案册锚点");

const [bookAudit, anchorAudit] = await Promise.all([
  agent("new-book-auditor").ask<NewBookAudit>(
    "只读审计，禁止改任何仓库文件（产物写 tmp/）。目标 DOCX：" + DOCB + " 。要在《电路》章上复核 M0 结论能否外推——**不能直接外推**，这本有 352 个 sectPr、229 个纯数字段落、1444 个 w:pict。做法：1) 以正文里的「教材知识N …电路」锚点定位电路章（历史参考区间约段 3668–4116，段号随解析脚本偏移，以文本为准），报出你自己口径下的段区间；2) 找出页码标记实际在哪（header/footer/正文），给出 5 条样例，说明能否按「页码标记 + 单调守卫」重建页，并给出电路章覆盖的印刷页数；3) 复核噪声形态：mc:AlternateContent Choice/Fallback 双写、页眉窄模板、页签双写（同章名连写≥2 次）、单写假阳性、页眉切断题干；4) 特别检查 w:pict / w:drawing 是不是插图而不是公式（已知公式是 OMML）。原卷页图在 " + PAGES + " （page-NN.png），需要时裁图。按 schema 返回。",
  ),
  agent("answer-anchor-locator").ask<AnchorAudit>(
    "只读审计，产物写 tmp/。目标答案册 DOCX：" + DOCANS + " 。任务：为《电路》章的答案匹配建立锚点。1) 定位电路章的段落区间（以文本标题为准，报出你的段号口径）；2) 找出栏目/题组锚点（例如「刷基础」「刷易错」「教材实验N」「教材知识N」之类）与题号起点形态，给出至少 8 条样例，每条格式「段号|文本前 40 字」；3) 判断题号是否每节重置，以及正册（" + DOCB + "）与答案册的栏目命名是否一一对应（已知另一本书里存在「刷提分」vs「提分」这种写法差异）；4) 明确列出无法建立对应的栏目，不许静默跳过。按 schema 返回。",
  ),
]);

log("M0' 完成；新切片 = 物理_教材基础练 电路；设计文档 " + SPEC);

phase("M1 文本还原：公式 / 噪声 / 切片");

const [formulaRestore, sliceDraft] = await Promise.all([
  agent("formula-restorer").ask<FormulaRestore>(
    "实现 OMML 到 LaTeX 的结构级转换，并在《物理_教材基础练 电路》切片上验证。目标 DOCX：" + DOCB + " 。M0 已知：全部 9 类节点可转、m:d 省略定界符时默认必须是 ()、△(U+25B3)/Δ、∘(U+2218) 度符号、~、%、数学模式中文必须显式映射；另有「公式被当纯文本打进正文」的盲区。要求：1) 只转结构不取 m:t 文字层；2) 不能识别的节点输出显式标记并计入 flagged，绝不静默丢弃；3) 抽 60 个含公式位置对照原卷页图（页图在 " + PAGES + "，裁图用 screenshot-evidence 技能的 crop.sh，不许用 sips 的 crop 偏移）；4) 统计 silentErrors（错了却标成正常的条数），这条必须为 0；5) 单独报出「OMML 之外被当纯文本的公式段落」数。产物写 tmp/docpipe-m1/。按 schema 返回。",
  ),
  agent("slice-drafter").ask<SliceReport>(
    "在《物理_教材基础练 电路》上产出 8–10 题的切片草稿，依据 " + SPEC + " 的 M1/M2 判据。要求：1) 先用页码标记重建页，再剥噪声（丢 mc:Fallback 双写、剥页眉页脚与栏目条、只剥页签双写形态，单写与段首一律保留），最后切题；2) 每题必须带（起段号、止段号、页码）；3) 题数必须与「独立正则数出的题号起点数」对账，两个数都报；4) 不确定标 needs_review 不猜；5) 页眉切断题干处按「上段是否以右括号/句号收尾」判断重连。产物写 tmp/docpipe-m1/。按 schema 返回。",
  ),
]);

log("M1 完成，进入 M2 切分对账");

phase("M2 切分对账：题数 / 编号 / 选项 / 可追溯");

const sliceAudit = await agent("slice-auditor").ask<SliceReport>(
  "对 M1 切片做独立复核，禁止复用切分器的判据实现（判据与实现必须不同源）。输入：tmp/docpipe-m1/ 与 " + SPEC + " 的 A2-1 至 A2-4，原卷页图 " + PAGES + " 。用另一种实现重算四指标：题号起点纯正则计数、选项 A-D 齐备率、每题页段区间单调不重叠、题数对账；并至少抽 3 题裁原卷页图核对题干首句。逐条给通过与否，发现不一致如实报差值，不修产品代码。按 schema 返回。",
);

phase("M3 答案匹配：三级锚点");

const matchReport = await agent("answer-matcher").ask<MatchReport>(
  "把答案册与正册《电路》同章配对。输入：正册切片 tmp/docpipe-m1/、答案册 " + DOCANS + " 、M0' 的锚点结论。要求：1) 按「章 → 知识/栏目 → 序号」三级锚点，禁止全局题号配对；2) 栏目名不全等需归一化，未匹配栏目必须报警不是跳过；3) 报 matched/total/ambiguous/unmatched，ambiguous 必须为 0 才算通过；4) 逐题给出「页码|题号|答案字母|解析前 20 字」。按 schema 返回。",
);

phase("M4 交付与对账");

const deliverable = await agent("delivery").ask<Deliverable>(
  "收尾。1) 切片与配对结果整理成 JSON 与页级导览，落 data/out-doc/教材基础练-电路/（不要写 data/out/）；2) 逐题截图审板，确认 8–10 题在页面上可见且未被裁切；3) 与 MinerU 既有产物（只读 " + OLDOUT + "）做三栏对账：题数差 / 题号差 / 公式缺失数；4) 给一句话结论：能否宣告完成。任何一项没做到，done 必须为 false。按 schema 返回。",
);

return {
  bookAudit,
  anchorAudit,
  formulaRestore,
  sliceDraft,
  sliceAudit,
  matchReport,
  deliverable,
};
