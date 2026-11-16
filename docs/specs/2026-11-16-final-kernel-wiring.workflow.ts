/**
 * 1:1 渲染内核接入 final/ —— 可验收目标驱动的工作流
 * 目标文档：docs/specs/2026-11-16-final-kernel-wiring-goals.md
 *
 * 设计原则：
 *  · 每个 agent 任务都带「判据编号」，返回必须逐条给通过/不通过，不许「看着对」；
 *  · 发现目标不合理时，agent 要在 verdict 里写明「调整了哪条、为什么」，
 *    编排层据此更新目标文档（动态调整条款）。
 */

interface ProbeResult {
  /** final 读什么数据、走什么函数：契约要点 */
  contract: string[];
  /** renderPaper 的签名与它需要哪些字段 */
  kernelApi: string[];
  /** 标签接线点：函数名 + 参数 */
  tagHooks: string[];
  /** 本环境能不能跑起来（服务、数据） */
  runnable: boolean;
  /** 发现的阻碍 */
  blockers: string[];
  verdict: string;
}

interface KernelResult {
  /** G1/G2 逐条判据结果，形如 "G1-1|pass|证据" */
  checks: string[];
  /** 新增/改动的文件 */
  files: string[];
  /** 是否可宣布 G1/G2 通过 */
  passed: boolean;
  verdict: string;
}

interface TagResult {
  /** G3 逐条判据结果 */
  checks: string[];
  /** 截图路径 */
  shots: string[];
  passed: boolean;
  verdict: string;
}

interface RegressResult {
  /** G4 逐条判据结果 */
  checks: string[];
  checkGreen: boolean;
  passed: boolean;
  verdict: string;
}

const ROOT = "/Users/john/WorkBuddy/Worktrees/feature-oxr-6b3489a1/feature-oxr-478100c4";
const GOALS = ROOT + "/docs/specs/2026-11-16-final-kernel-wiring-goals.md";
const MAIN = "/Users/john/WorkBuddy/Worktrees/question-seg-engine/feature-oxr-6b3489a1";

phase("P1 探查：final 契约 / 内核接口 / 标签接线点 / 可运行性");

const probe = await agent("probe").ask<ProbeResult>(
  "只读探查，**不要改任何文件**。目标：把「1:1 渲染内核接入 final/」的接入点摸清。工作区 " + ROOT +
  "，主仓库快照 " + MAIN + "（只读）。必须实测回答：\n" +
  "1) final/ 的数据契约：`final/final.js` 从哪些接口取数（/api/docs、/api/tags 等），" +
  "`stages.json` 里 pages/blocks 的字段形状（特别是 bbox 的坐标系是 px 还是 pt、页面 canvas 宽如何确定）；\n" +
  "2) `stages/reconstruct.js` 的 `renderPaper` 签名与它对 block 的字段依赖；" +
  "`final/` 在哪里调用它、手机端 `flowPaper` 如何分流；\n" +
  "3) 标签接线点：`final/tag-store.js` 的 `toggleTag` 签名、`anchorOf` 需要什么、`/api/tags` 的读写方式；" +
  "题目 id 在 final 里怎么表示（questionId 从哪来）；\n" +
  "4) 可运行性：scripts/view-server.ts 的启动方式与端口、本工作区 `data/out` 为空时 `/api/docs` 返回什么、" +
  "能否只读引用主仓库的某个 doc（如 `23必刷题 1 直线运动`）做验证；\n" +
  "5) **评估**：把 pt 坐标（页 1107×1584pt、项 588×842pt）接入现有 bbox 体系是否可行，" +
  "若不可行，是新增 `faithful.json` 快照更稳，还是改造 bbox 转换更稳。给出你的判断与理由。\n" +
  "参考目标文档 " + GOALS + "。按 schema 返回；`runnable` 必须是实测结论，不是推测。"
);

log("P1 完成；可运行性=" + (probe.runnable ? "是" : "否") + "，阻碍 " + probe.blockers.length + " 项");

phase("P2 内核接入：新增 1:1 内核并与 renderPaper 并列（G1 + G2）");

const kernel = await agent("kernel").ask<KernelResult>(
  "实现任务。依据 P1 结论：\n" + probe.contract.join("\n") + "\n内核接口：" + probe.kernelApi.join("；") +
  "\n阻碍：" + (probe.blockers.join("；") || "无") + "\n\n" +
  "要做的（严格按目标文档 " + GOALS + " 的 G1、G2）：\n" +
  "1) 新增 1:1 渲染内核，**与 renderPaper 并列**，不得替换或改写 renderPaper 的行为；\n" +
  "2) 由「该页有无行级坐标」自动选择内核：有坐标→绝对定位，无坐标→固定行高；\n" +
  "3) 数据源：`data/out-doc/教材基础练-电路/lines.json`（含 pos/blanks/imgDims），" +
  "坐标单位是 pt，页面 588.4×842pt，SCALE=842/1584=0.5316；\n" +
  "4) 必须保持：不修改 `src/`、不删 final 任何既有按钮/功能；\n" +
  "5) 逐条给 G1-1..G1-4、G2-1..G2-4 的通过与否 + 证据（命令输出或截图路径）。\n" +
  "凡是做不到的判据，标 false 并写清缺什么，**不许用「看着对」代替**。按 schema 返回。"
);

phase("P3 标签闭环：点题打标签 → 刷新仍在（G3）");

const tags = await agent("tags").ask<TagResult>(
  "依据 P1 的标签接线点结论：" + probe.tagHooks.join("；") + "\n" +
  "在 1:1 页面上打通标签闭环，逐条满足 " + GOALS + " 的 G3-1..G3-5：\n" +
  "1) 题可点选并调用 toggleTag；2) 刷新后标签仍在（必须走 /api/tags，**禁止 localStorage 兜底**）；" +
  "3) 服务端不可用时显式报错，不静默降级；4) 打标签前/后各一张截图（Chrome headless）。\n" +
  "若本环境起不了服务，明确标 G3-2 为 false 并说明缺什么，不得假装验证过。按 schema 返回。"
);

phase("P4 回归与交付（G4）");

const regress = await agent("regress").ask<RegressResult>(
  "回归验收，按 " + GOALS + " 的 G4：\n" +
  "1) `npm run check` 必须全绿（typecheck/lint/test/build），贴出结论；\n" +
  "2) final/viewer/stages 三个页面打开无 uncaught error（可用 Chrome headless + --dump-dom 或控制台日志）；\n" +
  "3) `data/out-doc/教材基础练-电路/1对1复刻.html` 仍可正常打开；\n" +
  "4) 汇总 G1..G4 的总体结论：能否宣布「只换渲染内核」完成；任何一项没做到，passed 必须为 false。\n" +
  "按 schema 返回。"
);

return { probe, kernel, tags, regress };
