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
  kind: "question_no" | "sub_question" | "option" | "section" | "chapter" | "answer_zone";
  /** 题号原文（如 "1"），用于答案对号和去噪 */
  captured: string;
  /** 大题标题纯编号（如 "一"），section 用 */
  indexNumeral?: string;
  /** 章/节标题正文（如 "相互作用" / "牛顿第三定律"） */
  title?: string;
  /** 选项键，如 "A" */
  optionKey?: string;
}

export type LineMatch = TextMatch | { ok: false; kind: "other" };

/**
 * 阿拉伯数字题号：1. / 1． / 1、 / 1) 等（半角全角分隔符容忍）。
 *
 * **域约束：首位数字必须是 1-9** —— 题号从 1 开始，`0` 永远不是题号。
 * 这条不是风格偏好，是**实测踩过的坑**（2026-10-12）：答案册第 19 页第 6 题解答里
 * 一行原文是 `0.5~1.5 s内 mg sinθ−μmg cosθ=ma₂`，MinerU 把 `0.5` 的 `5` 数学化成 `$5`，
 * 该行变成 `0.$5 \sim 1 . 5 …`。下面「半角点后接数字才算小数」的守卫拦的是 `0.5`，
 * 而 `0.$` 后面是 `$` 不是数字 ⇒ **守卫被绕过，凭空切出一道「第 0 题」**，
 * 且它在页面上表现为「6 后面跟一个 0」——不合逻辑到人一眼可见，机器却放过了。
 * ⇒ 与其枚举「点号后可能是哪些非数字字符」，不如直接锁死值域：**0 出域即非题号**。
 *
 * 其它守卫：
 * - 半角点后接数字视为小数（`0.5`、`0.4kg`），不是题号——题干续行常以「0.8,不计…」开头。
 * - 分支 1 保留 `\s*` 容忍（"1 . 设" 可判题号），负前瞻允许跳过空白后断言非数字
 *   （"0 . 2," 空格后仍接数字 → 仍拒）。
 */
const ARABIC_QUESTION = /^([1-9]\d{0,2})\s*\.(?!\s*\d)|^([1-9]\d{0,2})[．、)）]/;

/**
 * 徽标题号：题号印在彩色方块/圆形图标里，OCR 只拿到数字，没有点号。
 *
 * 实测（2026-10-28《教材基础练 磁场》）：行首形如 `1 2024年1月浙江卷 [鲁科版…]`、
 * `2[鲁科版必修三 P146…]`、`3[多选][人教版…]`、`4 [人教版…]`。8 卷基线扫描 **0 命中**，
 * 新书 OXR **35 命中 / MinerU 25 命中**。
 *
 * 守卫（AND）：数字后必须是 `[`/`【`，或**四位年份**（后不接数字）—— 不接普通中文/字母，
 * 避免把「10 m 的…」「2 个…」这类正文数字当成题号。年份后可能没有「年」字
 * （实测 `4 2024 广西卷`；MinerU 还会粘成 `42024广西卷`），故不要求「年」。
 */
const BARE_BADGE_QUESTION = /^([1-9]\d{0,2})\s*(?=[\[【「]|\d{4}(?!\d))|^([1-9]\d{0,2})\s+(?!个|种|条|根|块|只|次|段|米|秒|名|位|张|台|辆|本|页|道|项)[\u4e00-\u9fa5]/;

/**
 * 括号小题号：（1） / (2) / （3），常见于解答题大题内。
 *
 * ⚠️ **不是题号**（2026-10-12 定案）：实测把它当题号切题，会让「小问」变成独立题目，
 * 题号变成 `（2）` —— 答案册里这样切出 21 个假题，题册里 2 个，直接破坏「题号唯一且连续」。
 * ⇒ 现在返回 `kind: "sub_question"`，由决策层**并入当前题的题干**并记录小问标记，
 * 绝不新开一道题。
 */
const PAREN_QUESTION = /^[（(]\s*(\d{1,2})\s*[)）]/;

/** 汉字/阿拉伯数字 → 阿拉伯数字（章、节号归一化用） */
const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 章/节标题里的编号归一化为阿拉伯数字字符串（"二"→"2"；"十一"→"11"）。 */
export function numeralToArabic(s: string): string {
  const t = s.replace(/[零〇\s]/g, "");
  if (/^\d+$/.test(t)) return String(Number(t));
  if (t === "十") return "10";
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(t);
  if (m) return String((m[1] ? CN_DIGIT[m[1]]! : 1) * 10 + (m[2] ? CN_DIGIT[m[2]]! : 0));
  return CN_DIGIT[t] !== undefined ? String(CN_DIGIT[t]) : t;
}

/**
 * 章标题：`第二章 相互作用` / `第2章 …`（数字可用阿拉伯或汉字，容忍空格）。
 *
 * ⚠️ 原实现只有汉字大题型 `一、`，**`第N章/第N节` 一律识别不到** ⇒ 答案册 165 道题的
 * `section` 全为空，题号在节内重启后无法区分（`#1` 出现 22 次）—— 题库要按
 * 「章 + 节 + 题号」做唯一键，缺了节就没法一一对应（2026-10-12）。
 */
const CHAPTER_HEAD = /^第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*章[　\s]*(.*)$/;

/** 节标题：`第2节 牛顿第三定律` / `第2 节 …` / `第二节 …`（容忍数字与「节」之间的空格）。 */
const SECTION_HEAD = /^第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*节[　\s]*(.*)$/;

/**
 * 必刷题系列**非「第N节」形态**的节标题（2026-10-12 实测补）：
 * `专题 连接体动态平衡问题` / `全章综合测试` / `真题自测 考点复盘`。
 * 漏掉它们的后果与漏掉 `第N节` 一样：节内的题号重启（1..N 再来一遍）被并进上一节
 * → 同一节里出现多个 `1`，唯一键失效（题册节5 曾并进 4 组、答案册节5 并进 3 组）。
 */
const SECTION_HEAD_ALT = /^(专题[　\s]*(.{0,26})|全章综合测试\s*(.{0,26})|真题自测[　\s]*(.{0,26}))$/;

/**
 * 教材类教辅的栏目标题（不是题，也不是正文）：
 * `教材知识萃取 回归教材，萃精华` / `教材素材变式 多维变式，夯基础`；
 * 以及 `变式1 磁现象和磁场` 这类小节标题（题号在变式内从 1 重启）。
 * 实测（2026-10-28《教材基础练 磁场/电路》）：漏掉它们时，栏目标题会被并进上一题
 * 的题干/选项（电路 p1 选项 D 里混进「教材知识萃取…答案 P046」）。
 */
const BAND_HEAD = /^[☑□▶■●◆◇○•·\-—]?\s*(教材知识萃取|教材素材变式|教材知识\s*\d+|教材模型\s*\d+|教材模型攻略)/;
const VARIANT_HEAD = /^[☑□▶■●◆◇○•·\-—]?\s*变式\s*(\d{1,2})[　\s]+(.{1,30})$/;

/**
 * 必刷题页顶的**分组行**：`必刷知识T1~2、4~5、7~8、10、12`
 * （可含 必刷方法/必刷考点，段间用 `&`/空格连接，也会拆成两个块）。
 * 它只在**节起点**出现，且列出该节的题号集合 ⇒ 既当节边界信号，又当**独立校验源**。
 */
const T_LINE = /必刷(?:知识|方法|考点|题型)\s*T/;

/** 该块是不是 T 分组行 */
export function isTLine(text: string): boolean {
  return T_LINE.test(text);
}

/**
 * 解析 T 分组行里的题号集合：`T1~2、4~5、7~8、10、12` → [1,2,4,5,7,8,10,12]。
 * 支持 `~`/`～`/`-` 区间、`、`/`,`/`&` 分隔；不是 T 行返回 null。
 * 用途：确定性校验「该节的题号集合是否恰好是 T 行列出的那批」。
 */
export function parseTLine(text: string): number[] | null {
  if (!T_LINE.test(text)) return null;
  const out = new Set<number>();
  for (const m of text.matchAll(/T\s*([\d、~～\-&\s]+)/g)) {
    for (const part of (m[1] ?? "").split(/[、&,，\s]+/)) {
      const range = /^(\d{1,3})\s*[~～\-]\s*(\d{1,3})$/.exec(part);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        for (let i = a; i <= b && i - a < 200; i++) out.add(i);
        continue;
      }
      const one = /^(\d{1,3})$/.exec(part);
      if (one) out.add(Number(one[1]));
    }
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

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
 * **方框内编号列表的锚点**：行首实心三角 + 编号（`▶1.` / `▶2、`）。
 *
 * 为什么单独认它：教辅用「方法技巧 / 易错警示」这类**方框**放辅助说明，
 * 方框内的条目会自带编号（`▶1. …` `2. …` `3. …`），**它们不是题目**。
 * 而 `ARABIC_QUESTION` 只看行首形状 ⇒ `2.` `3.` 会被当成题号，切出**假题**。
 *
 * 实测（2026-10-12 用户指出，2026-10-14 定位）：答案册 p15 的
 * `方法技巧·等时圆模型` 方框里是三条图示说明（图甲/乙/丙）：
 * ```
 * ▶1. 质点从竖直圆环上沿不同的光滑弦上端由静止开始滑到环的最低点所用时间相等，如图甲所示.
 * 2. 质点从竖直圆环上最高点沿不同的光滑弦由静止开始滑到下端所用时间相等，如图乙所示.
 * 3. 两个竖直圆环相切且两圆环的竖直直径均过切点，…如图丙所示.
 * ```
 * 其中 `2.` `3.` 被切成两道假题，插在真题号 1 与 2 之间 ⇒ 组内序列变成
 * `1,2,3,2,3,4…`（看起来「从 3 回退到 2」，实为两道假题）。`▶1.` 因行首 `▶` 侥幸躲过。
 *
 * 为什么用 `▶N.` 当锚点而不是「方框头关键词」：锚点**自带编号**，才能确定方框里是
 * 「编号列表」；实测 25 处方框里只有 1 处带编号列表，其余都是无编号的 `▶` 段落
 * ⇒ 用锚点触发，爆炸半径最小（无编号方框完全不受影响）。
 */
const BOX_LIST_BULLET = /^▶\s*([1-9]\d{0,2})\s*[.．、)）]/;

/** 行首若是方框编号列表锚点（`▶N.`），返回其编号；否则 null。 */
export function matchBoxListItem(line: string): number | null {
  const m = BOX_LIST_BULLET.exec(line.trimStart());
  return m ? Number(m[1]) : null;
}

/**
 * 该行是否**长得像答案条目**：`N.` 之后紧跟 答案字母 / 小问括号 / 数学源码 / 【解析】 / 必刷标签。
 *
 * 用途：**方框守卫的收窄条件** —— 方框内编号列表只吞**不像答案条目**的行。
 * 为什么需要这道 AND 条件（对抗性审查发现的静默误吞路径）：
 * 设想某方框有 k 条编号条目，紧跟其后的**真题号恰好是 k+1**（例如方框 2 条、下一条真题是 3）
 * —— 只按「序号恰好 +1」判，那道**真题会被静默吞进方框**，而 N4 因为「有抑制记录」也不会变红。
 * 加这道条件后：真答案条目（`2.B必刷模型…` / `9.$(1)…$` / `6. (1)…`）带答案形态 ⇒ 不吞。
 *
 * 实测支撑（答案册 165 条真题首行）：**164 条**符合此形态，唯一例外是 p10 的 `10.`（答案在下一行）。
 * ⇒ 判据取最严（AND），宁可漏（漏了会被 audit 的 N7 组内回退抓住），不可错。
 */
const ANSWER_SHAPE = /^[1-9]\d{0,2}\s*[.．、)）]\s*(?:[A-H]{1,4}(?![A-Za-z])|[（(]|\$|【|必刷)/;

export function looksLikeAnswerEntry(line: string): boolean {
  return ANSWER_SHAPE.test(line.trimStart());
}

/**
 * 页面家具行：教辅每页页眉的固定装饰行（"刷基础 计划用时【】分钟·答案D11"、
 * "必刷知识T1~2、必刷考点T6"），以及艺术字 logo 块（单字"刷"）。
 * MinerU 对它们的去留不稳定（有的页丢进 discarded_blocks，有的页留在正文），
 * 留在正文时会被上一页跨页未关的题吞进题干/选项（2026-10-07 p4 假第5题实证）。
 * 判定只用于「页顶带的跳过」，不影响正常题目内容。
 */
const FURNITURE_LINE = /计划用时|必刷(?:知识|方法|考点|题型)|答案\s*[A-Z]?\d+|高考基础练|对应练见/;

export function isPageFurniture(text: string): boolean {
  const s = text.trim();
  return s === "刷" || FURNITURE_LINE.test(s);
}

/**
 * 首行是否以**题号**开头（含小问形态）。
 *
 * 用途：**页眉家具守卫必须让位于题号**。
 * 实测（2026-10-12）：答案册的题号行天然带「必刷知识/方法/考点」标签 ——
 * MinerU 把标签行并进了题号行，块文本形如 `7. CD 必刷知识·摩擦力`。
 * 它同时命中「页顶带」与 `FURNITURE_LINE` 的 `必刷(知识|方法|考点)` ⇒ 整块被当页眉丢弃，
 * **连题号一起扔掉**（答案册 162 个题号里漏了 16 个，全是这个原因）。
 * 题号是显式结构信号，优先级高于模糊的家具关键词。
 */
export function startsWithQuestionNumber(line: string): boolean {
  const s = line.trimStart();
  return ARABIC_QUESTION.test(s) || BARE_BADGE_QUESTION.test(s) || PAREN_QUESTION.test(s);
}

/**
 * 物体列举守卫：「字母+顿号+字母」是物理题干高频的对象列举
 * （"A、B用两根轻绳连""A、B、C均处于平衡"），不是选项行。
 * 误判后果严重：伪选项 A 占住 expectOptionKey，后续真选项全部
 * 被「键不连续」裁决挤成乱序、整组丢失（2026-10-07 真实 15 页回归，
 * 4 道题因它丢选项）。真实选项「A、xxx」正文紧跟字母的情形极罕见，可牺牲。
 */
function isObjectEnumeration(marker: string, rest: string): boolean {
  return marker.endsWith("、") && /^[A-Ha-h]/.test(rest);
}

/**
 * 答案区条目：题号开头（答案区内的 "1．B"），复用题号模式两分支结构。
 * 与 ARABIC_QUESTION 同款守卫：半角点后接数字（0.5…/0 . 5…）不当作题号前缀；
 * 分支 1 同款 \s* 容忍（"1 . B" 可解析），负前瞻跳过空白后断言非数字。
 * 域约束同 ARABIC_QUESTION：首位数字 1-9（`0` 不是题号，见其注释）。
 */
const ANSWER_ENTRY = /^([1-9]\d{0,2})\s*\.(?!\s*\d)\s*(\S.*)$|^([1-9]\d{0,2})\s*[．、)）]\s*(\S.*)$/;

function matchKind(ok: boolean, kind: TextMatch["kind"]): LineMatch {
  return ok ? ({ ok: true, kind, captured: "" } as TextMatch) : { ok: false, kind: "other" };
}

/** 尝试对某块首行做全部语言模式判定（按优先级：区间 > 大题 > 括号 > 题号 > 选项） */
export function matchFirstLine(line: string): LineMatch {
  const s = line.trimStart();

  if (ANSWER_ZONE_GUARD(s)) {
    return matchKind(true, "answer_zone");
  }

  // 章 / 节标题先于题号判定：它是「题号在节内重启」的**唯一上下文来源**，
  // 缺了它就没法把「题号」变成唯一键（见 CHAPTER_HEAD 注释）。
  // 长度守卫：题干里出现「第2节」字样通常不在行首，且在行首时整行不会很短。
  if (s.length <= 40) {
    const ch = CHAPTER_HEAD.exec(s);
    if (ch) {
      return { ok: true, kind: "chapter", captured: numeralToArabic(ch[1] ?? ""), title: (ch[2] ?? "").trim() };
    }
    const sec = SECTION_HEAD.exec(s);
    if (sec) {
      return { ok: true, kind: "section", captured: numeralToArabic(sec[1] ?? ""), title: (sec[2] ?? "").trim() };
    }
    const alt = SECTION_HEAD_ALT.exec(s);
    if (alt) {
      const title = (alt[2] ?? alt[3] ?? alt[4] ?? "").trim();
      return { ok: true, kind: "section", captured: "", title: title || s };
    }
    const band = BAND_HEAD.exec(s);
    if (band) {
      return { ok: true, kind: "section", captured: "", title: s };
    }
    const variant = VARIANT_HEAD.exec(s);
    if (variant) {
      return {
        ok: true,
        kind: "section",
        captured: "",
        indexNumeral: variant[1] ?? "",
        title: s.slice((variant[0] ?? "").length).trim(),
      };
    }
    const section = CHINESE_SECTION.exec(s);
    if (section) {
      return {
        ok: true,
        kind: "section",
        captured: "",
        indexNumeral: section[1] ?? "",
        title: s.slice((section[0] ?? "").length).trim(),
      };
    }
  }

  const paren = PAREN_QUESTION.exec(s);
  if (paren) {
    // 一行（1）…（2）… 并列的「小题列表行」最常见形态是题干续行/解答题述要，
    // 行内出现第二个括号编号 → 不是独立题切口，按普通文本处理
    const rest = s.slice((paren[0] ?? "").length);
    if (SECOND_PAREN_TAG.test(rest)) {
      return { ok: false, kind: "other" };
    }
    // **小问**，不是题号：由决策层并入当前题（见 PAREN_QUESTION 注释）
    return { ok: true, kind: "sub_question", captured: paren[1] ?? "" };
  }

  const arabic = ARABIC_QUESTION.exec(s);
  if (arabic) {
    return { ok: true, kind: "question_no", captured: arabic[1] ?? arabic[2] ?? "" };
  }

  const badge = BARE_BADGE_QUESTION.exec(s);
  if (badge) {
    return { ok: true, kind: "question_no", captured: badge[1] ?? badge[2] ?? "" };
  }

  const opt = OPTION_LINE.exec(s);
  if (opt) {
    const rest = s.slice(opt[0].length);
    if (!isObjectEnumeration(opt[0], rest)) {
      const key = (opt[1] ?? "").toUpperCase();
      return { ok: true, kind: "option", captured: "", optionKey: key };
    }
  }

  return { ok: false, kind: "other" };
}

/** 答案区条目：题号 + 答案文本。只在答案区内调用 */
export function matchAnswerEntry(line: string): { number: string; text: string } | null {
  const m = ANSWER_ENTRY.exec(line.trimStart());
  if (!m) return null;
  return { number: m[1] ?? m[3] ?? "", text: (m[2] ?? m[4] ?? "").trim() };
}

/** 剥离块首的题号前缀，返回纯题干（如 "1．设集合 A=..." → "设集合 A=..."）。
 * 分支 1 与 ARABIC_QUESTION 同款：数字与半角点间空格容忍、负前瞻跳空白后断言非数字、
 * 首位数字 1-9，保证「判定层接受的题号形态，剥离层一定剥得掉」（"1 . 设" 剥为 "设"），
 * 也保证「判定层拒的（`0.$5…`），剥离层一个字都不动」（题干原文必须原样保留）。 */
export function stripQuestionPrefix(line: string): string {
  return line
    .trimStart()
    .replace(/^[1-9]\d{0,2}\s*\.(?!\s*\d)|^[1-9]\d{0,2}\s*[．、)）]/, "")
    .replace(/^[1-9]\d{0,2}\s*(?=[\[【「]|\d{4}(?!\d))|^[1-9]\d{0,2}\s+(?=(?!个|种|条|根|块|只|次|段|米|秒|名|位|张|台|辆|本|页|道|项)[\u4e00-\u9fa5])/, "")
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
 * 注意三点：
 * 1) 不校验后继字符——原 lookahead 方案（(?=[A-H][.．、)）:：]|$)）在 "B.3:5" / "B.重…"
 *    （标记后直接是选项正文）时拆不动，与测试契约矛盾；是否「整块为选项连排」交给
 *    splitConjoinedOptions 的块首标记守卫 + 调用方的门控裁决。
 * 2) 不带 /g 标志——非全局 exec 无 lastIndex 状态污染，每次都在「截到上一标记之后」的
 *    rest 上从头找首个标记（即下一个选项起点），语义恰好正确。
 * 3) 顿号带守卫：[、](?![A-Ha-h])——「设A、B接触」里的 "A、" 是物体列举不是选项
 *    边界（见 isObjectEnumeration），拆分时必须跳过，否则题干被拆出伪选项段。
 * 4) 不含右括号 )/）——物理公式 "(F+G)/2"（G=重力）里的 "G)" 是括号配对不是选项
 *    标记（2026-10-07 实证）；行首 "A) 选项" 形式由 OPTION_LINE 保留。
 */
const OPTION_SPLIT = /([A-H])\s*(?:[.．:：]|[、](?![A-Ha-h]))/;

/**
 * 粘连选项拆分：块内文本含多个连续选项标记时按标记切分（layout 行级展开缺失时的兜底，
 * 或某行本身含多个选项如 "A.3:4 B.3:5"）。题干文本（无连续 A-D 标记）返回空数组。
 * 注意：
 * - 只处理「块首为选项标记且块内另有 ≥1 个后续标记」形态；混入正文数字/字母、
 *   缺首标记的题干文本返回空（由上层走原路径）。
 * - 连续同键合并取更长文本：上游 MinerU 偶发整行重复
 *   （"C.M所受…大C.M所受…大小一定一直增加"），拆出 C、C 两个同键段会撞上
 *   expectOptionKey 门控误判「键不连续」而丢整组（2026-10-07 真实回归）。
 * - 仍不做非相邻同键去重：正文若重现同名标记（如 "A.x B.y A.z"），
 *   去重/连续性由 rule-engine 的 expectOptionKey 门控裁决（不连续即 settle+review+文本回退）。
 */
export function splitConjoinedOptions(text: string): { key: string; text: string }[] {
  const trimmed = text.trim();
  const first = /^([A-H])\s*(?:[.．)）:：]|[、](?![A-Ha-h]))\s*/.exec(trimmed);
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
  // 连续同键合并（上游整行重复防护）：同名段取更长文本
  const merged: { key: string; text: string }[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && last.key === seg.key) {
      if (seg.text.length > last.text.length) last.text = seg.text;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}