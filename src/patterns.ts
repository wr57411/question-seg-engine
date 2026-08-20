/**
 * patterns.ts —— 语言层：题号/选项/大题/答案区的正则模式库（正式件）
 *
 * 定位：只回答「某块首行是不是某类语言模式」，不回答「要不要切题」——
 * 切割决策由组合规则层（rule-engine）结合版面信息裁决，避免纯正则误切。
 * 因此这里不限制行长：题号判定只看「块首」形状，正文数字误配产生的
 * 误切由组合层的置信度/review 机制兜底（宁错审，不错放）。
 * 每个模式独立命名 + 注释用途，便于单测和逐条调优。
 */

export interface TextMatch {
  ok: true;
  kind: "question_no" | "option" | "section" | "answer_zone";
  /** 题号原文（如 "1" / "（2）"），用于答案对号和去噪 */
  captured: string;
  /** 大题标题纯编号（如 "一"），section 用 */
  indexNumeral?: string;
  /** 选项键，如 "A" */
  optionKey?: string;
}

export type LineMatch = TextMatch | { ok: false; kind: "other" };

/**
 * 阿拉伯数字题号：1. / 1． / 1、 / 1) 等（半角全角分隔符容忍）。
 * 守卫：半角点后接数字视为小数（0.5、0.4kg），不是题号——
 * 真实教辅常见题干续行以「0.8,不计…」开头，误判会产生幽灵题号 0。
 * 分支 1 恢复旧版 \s* 容忍（"1 . 设" 可判题号），负前瞻允许跳过空白后
 * 断言非数字（"0 . 2," 空格后仍接数字 → 仍拒）。
 */
const ARABIC_QUESTION = /^(\d{1,3})\s*\.(?!\s*\d)|^(\d{1,3})[．、)）]/;

/** 括号小题号：（1） / (2) / （3），常见于解答题大题内 */
const PAREN_QUESTION = /^[（(]\s*(\d{1,2})\s*[)）]/;

/** 行内次要括号编号（用于识别 "（1）…；（2）…" 小题列表行） */
const SECOND_PAREN_TAG = /[（(]\s*\d{1,2}\s*[)）]/;

/** 汉字大题编号：一、 / 二、 / 三四、 （顶多两位，避免误吃正文） */
const CHINESE_SECTION = /^([一二三四五六七八九十]{1,2})[、．.]\s*/;

/** 参考答案区标识：容忍「二、参考答案」「参考答案及解析」「解析」等前缀变体。
 * 注意交替分支顺序：带后缀的形态在前，裸「参考答案/解析」兜底在后（正则无回溯分支合并）。 */
function isAnswerZone(s: string): boolean {
  const body = s.replace(/^[一二三四五六七八九十]{1,2}[、．.]\s*/, "");
  return /^(参考答案?(及|与|附)?解析?|答案与解析|试题答案|答案解析?|参考答案?|解析)([:：]|$)/.test(
    body,
  );
}
const ANSWER_ZONE_GUARD = isAnswerZone;

/** 选项行：行首单字母 + 分隔符，如 A． / B. / C) / D、 */
const OPTION_LINE = /^([A-Ha-h])\s*[.．、)）:：]/;

/**
 * 答案区条目：题号开头（答案区内的 "1．B"），复用题号模式两分支结构。
 * 与 ARABIC_QUESTION 同款守卫：半角点后紧跟数字（0.5…）不当作题号前缀。
 */
const ANSWER_ENTRY = /^(\d{1,3})\.(?!\d)\s*(\S.*)$|^(\d{1,3})\s*[．、)）]\s*(\S.*)$/;

function matchKind(ok: boolean, kind: TextMatch["kind"]): LineMatch {
  return ok ? ({ ok: true, kind, captured: "" } as TextMatch) : { ok: false, kind: "other" };
}

/** 尝试对某块首行做全部语言模式判定（按优先级：区间 > 大题 > 括号 > 题号 > 选项） */
export function matchFirstLine(line: string): LineMatch {
  const s = line.trimStart();

  if (ANSWER_ZONE_GUARD(s)) {
    return matchKind(true, "answer_zone");
  }

  const section = CHINESE_SECTION.exec(s);
  if (section && s.length <= 40) {
    return {
      ok: true,
      kind: "section",
      captured: section[1] ?? "",
      indexNumeral: section[1] ?? "",
    };
  }

  const paren = PAREN_QUESTION.exec(s);
  if (paren) {
    // 一行（1）…（2）… 并列的「小题列表行」最常见形态是题干续行/解答题述要，
    // 行内出现第二个括号编号 → 不是独立题切口，按普通文本处理
    const rest = s.slice((paren[0] ?? "").length);
    if (SECOND_PAREN_TAG.test(rest)) {
      return { ok: false, kind: "other" };
    }
    return { ok: true, kind: "question_no", captured: `（${paren[1] ?? ""}）` };
  }

  const arabic = ARABIC_QUESTION.exec(s);
  if (arabic) {
    return { ok: true, kind: "question_no", captured: arabic[1] ?? arabic[2] ?? "" };
  }

  const opt = OPTION_LINE.exec(s);
  if (opt) {
    const key = (opt[1] ?? "").toUpperCase();
    return { ok: true, kind: "option", captured: "", optionKey: key };
  }

  return { ok: false, kind: "other" };
}

/** 答案区条目：题号 + 答案文本。只在答案区内调用 */
export function matchAnswerEntry(line: string): { number: string; text: string } | null {
  const m = ANSWER_ENTRY.exec(line.trimStart());
  if (!m) return null;
  return { number: m[1] ?? m[3] ?? "", text: (m[2] ?? m[4] ?? "").trim() };
}

/** 剥离块首的题号前缀，返回纯题干（如 "1．设集合 A=..." → "设集合 A=..."） */
export function stripQuestionPrefix(line: string): string {
  return line
    .trimStart()
    .replace(/^\d{1,3}\.(?!\d)|^\d{1,3}\s*[．、)）]/, "")
    .replace(/^[（(]\s*\d{1,2}\s*[)）]/, "")
    .trimStart();
}

/** 剥离块首的选项前缀，返回选项文本 */
export function stripOptionPrefix(line: string): string {
  return line.trimStart().replace(/^[A-Ha-h]\s*[.．、)）:：]/, "").trimStart();
}

/** 选项键的期望后继（A→B…），用于验证选项组连续性 */
export function nextKey(key: string): string {
  return String.fromCharCode(key.charCodeAt(0) + 1);
}

/**
 * 粘连选项的后续标记：块内任意位置的 [A-H]+分隔符（允许与上文无空格粘连，如 "…上B.重力…"）。
 * 注意两点：
 * 1) 不校验后继字符——原 lookahead 方案（(?=[A-H][.．、)）:：]|$)）在 "B.3:5" / "B.重…"
 *    （标记后直接是选项正文）时拆不动，与测试契约矛盾；是否「整块为选项连排」交给
 *    splitConjoinedOptions 的块首标记守卫 + 调用方的 >=2 门控裁决。
 * 2) 不带 /g 标志——非全局 exec 无 lastIndex 状态污染，每次都在「截到上一标记之后」的
 *    rest 上从头找首个标记（即下一个选项起点），语义恰好正确。
 */
const OPTION_SPLIT = /([A-H])\s*[.．、)）:：]/;

/**
 * 粘连选项拆分：块内文本含多个连续选项标记时按标记切分（layout 行级展开缺失时的兜底，
 * 或某行本身含多个选项如 "A.3:4 B.3:5"）。题干文本（无连续 A-D 标记）返回空数组。
 * 注意：
 * - 只处理「块首为选项标记且块内另有 ≥1 个后续标记」形态；混入正文数字/字母、
 *   缺首标记的题干文本返回空（由上层走原路径）。
 * - 本函数不做 key 去重：正文若重现同名标记（如 "A.x B.y A.z"），输出会含两个 A 键——
 *   去重/连续性由 rule-engine 的 expectOptionKey 门控裁决（不连续即 settle+review+文本回退）。
 */
export function splitConjoinedOptions(text: string): { key: string; text: string }[] {
  const trimmed = text.trim();
  const first = /^([A-H])\s*[.．、)）:：]\s*/.exec(trimmed);
  if (!first) return [];
  const out: { key: string; text: string }[] = [];
  let rest = trimmed.slice(first[0].length);
  let key = first[1]!.toUpperCase();
  for (;;) {
    const m = OPTION_SPLIT.exec(rest);
    if (!m) break;
    const seg = rest.slice(0, m.index).trim();
    if (seg) out.push({ key, text: seg });
    key = (m[1] ?? "").toUpperCase();
    rest = rest.slice(m.index + m[0].length); // 直接跳过本标记（如 "B."），继续找下一个
  }
  // 最后一段
  if (rest.trim()) out.push({ key, text: rest.trim() });
  return out;
}