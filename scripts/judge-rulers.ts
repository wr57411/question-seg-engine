// scripts/judge-rulers.ts
/**
 * M4b 复合正确率裁判口径（纯函数；DECISIONS §112）。
 *
 * 背景：M4 复合裁判 = 文本行 rec 子序列（nows 仅去空白）+ 公式行墨迹几何 REAL（B-41）。
 * 页缘竖条遮罩投产后 qx 92.35% / wy 94.99%，残差逐条拿原卷裁图（export-gold-crops 的
 * ffmpeg 页图裁图，蒙太奇 tmp/m4b/montage/*.png）证实为两类**裁判伪影**：
 *   A 公式碎片被 isFormulaText 漏判成文本行：
 *     A1 LaTeX 间距反斜杠（"H=3.2\ m"，印刷为公式排版行）——基线正则只认 \[a-zA-Z]+；
 *     A2 含 '$' 的公式 delimiter 碎片（"v$"、"$x"，印刷为 v₀/x 数学斜体）；
 *     A3 上下标/图内点标碎片（"F2"、"v0"、"0α"、"IH"，印刷为 F₂/v₀/O+α/尺寸标记）。
 *   B 标点字形族变体：印刷半角 ( ) , : 与 V3 全角（），：、减号 −/-、中点 •/·、
 *     罗马数字连字 Ⅱ/II（wy p008_g17 裁图证实为同一数字的两种字形）。
 *
 * 红线守住：
 *  - 文本行 rec **汉字字形错**（"下课练天星"→"下课认听"）仍判失败，族归一不碰汉字/希腊字母；
 *  - 族归一仅覆盖蒙太奇逐条实证的字形族，未实证的（。/、/；等）一律不归一；
 *  - 墨迹判据仍同源 judgeInkBox（audit-formula-ink.ts），本模块不新造几何阈值；
 *  - audit-formula-ink.ts 的 isFormulaText **不动**：formula-ink.json 是答案册 191 产物
 *    字节守卫锁定的 B-41 基线产物；M4b 扩路由只作用于复合裁判（composite.mjs），
 *    其 rows 含全部 victims 的墨迹判定，扩路由行直接同源消费，无需重渲染。
 */

/** B-41 基线公式路由（与 audit-formula-ink.ts 同口径；此处复制供对照测试锁定）。 */
export const isFormulaTextBase = (s: string): boolean => /\\[a-zA-Z]+|[_^{}]/.test(s);

/** A3 碎片形态：字母+数字/希腊、数字+字母/希腊、双字母点标；罗马数字双字母排除（文本数字）。 */
const FRAGMENT_RE =
  /^[A-Za-zα-ωΑ-Ω][0-9α-ωΑ-Ω]$|^[0-9][A-Za-zα-ωΑ-Ω]$|^(?![IVXLCDM]{2}$)[A-Za-z]{2}$/;

/** M4b 公式路由 = 基线 ∪ A1(任意反斜杠) ∪ A2(含 $) ∪ A3(碎片形态，对去空白后文本判)。 */
export const isFormulaTextM4b = (s: string): boolean =>
  isFormulaTextBase(s) || /\\/.test(s) || s.includes("$") || FRAGMENT_RE.test(s.replace(/\s+/g, ""));

/** 实证字形族归一（含 nows 去空白）。族集合 = 蒙太奇 55 条 B 组裁图逐条证实者，不多不少。 */
export const famNorm = (s: string): string =>
  s
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/，/g, ",")
    .replace(/：/g, ":")
    .replace(/−/g, "-")
    .replace(/•/g, "·")
    .replace(/Ⅱ/g, "II");

/** a 是否为 b 的字符级保序子序列（不要求连续）。 */
export const isSubseq = (a: string, b: string): boolean => {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++;
  return i === a.length;
};

/** M4b 文本行确认：族归一后 V3 文本 ⊂ rec 读数（空 V3 不确认）。 */
export const confirmTextM4b = (v3: string, rec: string): boolean => {
  const a = famNorm(v3);
  return a.length > 0 && isSubseq(a, famNorm(rec));
};