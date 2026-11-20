// scripts/defect-rules.ts —— 缺陷裁定规则库（《换源缺陷补偿手册》§1 的可执行化）
//
// 定位：**线上规则**（online）。audit-defects 扫描时用 `matchDefectRule` 给每条命中
// 填 verdict + ruleRef；audit-feedback 归纳出的候选**不自动进这里**，须人工批准
// 并 bump `RULES_VERSION` 后才生效（防退化：回放不一致的候选标「冲突待裁」）。
//
// 判据全部来自手册 §1 七类（A 几何 / B 文本残留 / C 题号结构 / D 跨页泄漏 /
// E 标题缺失 / F 修正层过期 / G 口径漂移）与 audit-defects 现有归因逻辑，
// 本文件**不自写几何/文本判据**，只把「什么形态判什么」编码。
//
// verdict 允许 "待判"：表示该形态**规则认定必须人工回原卷**（如 B-stray}），
// 不得自动裁定——这是红色纪律（拿不准就待判），不是缺省值。

/** 裁定结论。"待判" = 需 AI/人回原卷或核对产物后才能定。 */
export type Verdict = "真丢" | "伪影" | "口径" | "误报" | "待判";

/** 规则的输入：扫描器一条命中（class + 形态 kind + 文本 + 读数）。 */
export interface RuleEntry {
  class: string;
  /** 扫描器给的形态标签（如 `B-stray}`、`C1-无题号真题块`），聚类键之一。 */
  kind?: string;
  detail?: string;
  ledger?: Record<string, unknown>;
}

export interface DefectRule {
  ruleId: string;
  /** 适用类别（手册 §1 的 A–G）。 */
  class: string;
  /**
   * 形态限定：命中 `kind.includes(form)` 才适用；缺省 = 该类整类适用。
   * 同时用于候选去重（同 class+form+verdict 的候选视为已被覆盖）。
   */
  form?: string;
  verdict: Verdict;
  /** 判据（纯函数，可单测）。 */
  when: (entry: RuleEntry) => boolean;
  /** 裁定依据（手册出处 + 理由），落进 judgements.basis。 */
  basis: string;
  source: string;
  /** 生效时的规则库版本（候选上线时 bump RULES_VERSION 并填这里）。 */
  version: number;
}

/** 规则库版本：每次人工批准候选上线时 +1（只增不改旧规则语义）。 */
export const RULES_VERSION = 1;

const has = (entry: RuleEntry, form: string): boolean => (entry.kind ?? "").includes(form);

export const DEFECT_RULES: DefectRule[] = [
  {
    ruleId: "R-A-001",
    class: "A",
    verdict: "口径",
    when: (e) => e.class === "A",
    basis: "手册 §1-A：OXR 合成行框与墨迹系统性错位 10–20pt，数字暴涨先怀疑尺子；不改分类判据/合成框，按 DECISIONS §115 重锁基线。",
    source: "手册 §1-A；DECISIONS §115",
    version: 1,
  },
  {
    ruleId: "R-B-001",
    class: "B",
    form: "smiles",
    verdict: "伪影",
    when: (e) => e.class === "B" && has(e, "smiles"),
    basis: "手册 §1-B：`\\smiles{…}$` 是 OXR 伪包装宏，转换层 stripSmilesWrapper 已剥壳留痕（原卷无此形态）。",
    source: "手册 §1-B",
    version: 1,
  },
  {
    ruleId: "R-B-002",
    class: "B",
    form: "blankNoise",
    verdict: "伪影",
    when: (e) => e.class === "B" && has(e, "blankNoise"),
    basis: "手册 §1-B：横线/下划线被误判 blank 噪声，isBlankNoise 已在转换层丢弃并留痕 json。",
    source: "手册 §1-B",
    version: 1,
  },
  {
    ruleId: "R-B-003",
    class: "B",
    form: "stray}",
    verdict: "待判",
    when: (e) => e.class === "B" && has(e, "stray}"),
    basis: "手册 §1-B：折行切裂括号须逐条回原卷——原卷有⇒真缺陷，原卷无⇒旧源泄漏；形态本身不足以裁定，保持待判。",
    source: "手册 §1-B",
    version: 1,
  },
  {
    ruleId: "R-C-001",
    class: "C",
    verdict: "真丢",
    when: (e) => e.class === "C",
    basis: "手册 §1-C：OXR 偶发丢行首题号/标签折行残片；引擎已按强信号反推恢复（B-56/B-50），成品是否无损需核对产物。",
    source: "手册 §1-C；commits db4e0b9/fbefe8d",
    version: 1,
  },
  {
    ruleId: "R-D-001",
    class: "D",
    verdict: "伪影",
    when: (e) => e.class === "D",
    basis: "手册 §1-D：MinerU 残余跨页泄漏（para 含 N+1 页行）；OXR 无 preproc_blocks 时判据整体跳过，生产 OXR 册恒 0。",
    source: "手册 §1-D；commit 642072e",
    version: 1,
  },
  {
    ruleId: "R-E-001",
    class: "E",
    verdict: "真丢",
    when: (e) => e.class === "E",
    basis: "手册 §1-E：V3 交叉识别标题守卫命中（score≥0.98）/ curated 补识；逐页回原卷确认「卷面有、产物无」。",
    source: "手册 §1-E；M7-A",
    version: 1,
  },
  {
    ruleId: "R-F-001",
    class: "F",
    verdict: "口径",
    when: (e) => e.class === "F",
    basis: "手册 §1-F：修正清单干跑 missed>0 ⇒ 清单与新源骨架不匹配，退休（留 retiredAt+reason）或更新形态。",
    source: "手册 §1-F；commit 4e6b53c",
    version: 1,
  },
  {
    ruleId: "R-G-001",
    class: "G",
    verdict: "口径",
    when: (e) => e.class === "G",
    basis: "手册 §1-G：meta 数字与登记基线的差，只报数；先证非真缺陷（对照独立源/逐字节复现）再带证据重锁。",
    source: "手册 §1-G；§115",
    version: 1,
  },
];

/** 第一条命中的线上规则；未命中返回 undefined（调用方落「待判」）。 */
export function matchDefectRule(
  entry: RuleEntry,
  rules: DefectRule[] = DEFECT_RULES,
): DefectRule | undefined {
  return rules.find((r) => r.when(entry));
}