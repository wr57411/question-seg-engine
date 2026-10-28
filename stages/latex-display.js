/**
 * latex-display.js —— 展示层专用 LaTeX 渲染（纯函数，无 DOM）。
 *
 * 定位：引擎结构化文本保留上游 LaTeX 原样（红线：不静默改写数据）；
 * 但展示时 "$\theta \left( \theta < 9 0 ^ { \circ } \right)$" 这类源码不可读。
 * 本模块做**只影响显示**的转换：按字符递归解析 LaTeX 子集
 * （\frac/\sqrt 嵌套参数、^/_ 嵌套上下标、{ } 分组、希腊字母/关系符表、
 * \left\right 与字体包装剥除、空白噪声折叠），语义改写（清洗数据本身）
 * 是引擎侧独立任务，不在此处。
 *
 * 输出是 **HTML 片段**（不是纯文本）：\frac 渲染成竖排分式、\sqrt 渲染成带上划线的
 * 根号、上下标用 <sup>/<sub>。原卷是二维排版，一维字符流表达不了它
 * （2026-10-08 用户指出"怎么都是一排的"）。⇒ 调用方必须用 **innerHTML** 挂载，
 * 不能用 textContent；所有字面文本都经 escapeHtml，避免 < > & 破坏结构。
 *
 * 供 stages.js 使用；tests/latex-display.test.ts 回归锁定
 * （测试用例全部取自真实样张噪声公式）。
 */

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ",
  epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ",
  iota: "ι", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ",
  nu: "ν", xi: "ξ", pi: "π", Pi: "Π", rho: "ρ", sigma: "σ",
  Sigma: "Σ", tau: "τ", phi: "φ", Phi: "Φ", varphi: "φ",
  chi: "χ", psi: "ψ", omega: "ω", Omega: "Ω",
  Gamma: "Γ", vartheta: "ϑ", varepsilon: "ε", varsigma: "ς", varkappa: "ϰ", varrho: "ϱ",
  Xi: "Ξ", Upsilon: "Υ", upsilon: "υ",
  varGamma: "Γ", varDelta: "Δ", varTheta: "Θ", varLambda: "Λ",
  varXi: "Ξ", varPi: "Π", varSigma: "Σ", varUpsilon: "Υ",
  varPhi: "Φ", varPsi: "Ψ", varOmega: "Ω",
};

const SYMBOL = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
  approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", propto: "∝",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒",
  infty: "∞", prime: "′", degree: "°", angle: "∠",
  perp: "⊥", parallel: "∥", setminus: "∖", ldots: "…", dots: "…",
  vdots: "⋮", ddots: "⋱", cdots: "⋯", colon: ":", therefore: "∴", because: "∵",
  partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫",
  cup: "∪", cap: "∩", subset: "⊂", in: "∈", notin: "∉",
  ast: "∗", star: "⋆", bullet: "•", longrightarrow: "⟶", ll: "≪", gg: "≫",
  oplus: "⊕", ominus: "⊖", otimes: "⊗", top: "⊤", bot: "⊥",
  sin: "sin", cos: "cos", tan: "tan", cot: "cot", log: "log", ln: "ln",
  max: "max", min: "min", circ: "°", square: "□", triangle: "△",
  ell: "ℓ", mid: "|", AA: "Å", lrcorner: "⌟", surd: "√", arcsin: "arcsin",
  land: "∧", exists: "∃", emptyset: "∅", not: "¬",
  sharp: "♯", flat: "♭", natural: "♮", ddagger: "‡", ngeq: "≱", gtrless: "≷",
  vert: "|", boxtimes: "⊠", pounds: "£", rfloor: "⌋", backslash: "∖",
  jmath: "ȷ", arctan: "arctan",
};

/** 命令后紧跟的花括号参数按内容展开、本身不显示（字体包装/上划线等） */
const UNWRAP = new Set([
  "mathrm", "boldsymbol", "mathbf", "text", "it", "mathit", "mathcal",
  "overline", "bar", "underline", "vec", "hat", "widetilde", "widehat",
  "overrightarrow", "overleftarrow", "operatorname", "textrm", "textbf",
  "textit", "mathsf", "texttt", "mbox", "textnormal",
  "mathscr", "mathfrak", "mathtt", "bf", "sf", "cal", "tiny", "scriptscriptstyle", "boxed",
  "smash", "tilde", "dot", "ddot",
]);

/** 无参数、直接丢弃的命令（纯排版指令，非内容） */
const DROP_CMD = new Set([
  "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits",
  "quad", "qquad", "thinspace", "enspace", "mathstrut", "strut",
  "left", "right", "big", "Big", "bigg", "Bigg",
  "mathbin", "nonumber", "notag",
]);

/** 参数非内容、需连参数一并丢弃的命令（否则 "red" 之类会裸奔） */
const DROP_WITH_ARG = new Set([
  "color", "textcolor", "hspace", "vspace", "kern", "mkern", "label", "tag",
  "phantom", "hphantom", "vphantom",
]);

/** 需要专门分支的命令（环境/黑板粗体）：不在 UNWRAP 里按普通单参数处理。 */
const CUSTOM = new Set(["begin", "end", "mathbb", "underset", "overset", "stackrel"]);
/** 黑板粗体常用数集；其余字母退化为普通字母（只影响显示，不改数据）。 */
const MATHBB = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ" };

/**
 * 渲染器已知命令集。两个用途：
 * ① parseCommand 用它做「最长已知前缀」回退（MinerU 常把 "\theta B" 写成 "\thetaB"）；
 * ② 导出给 scripts/audit-render.mjs 做输入端覆盖率检测——输出端查不到未知命令，
 *    因为它们已被丢弃、不留痕迹，所以必须在输入端查。
 */
export const KNOWN_COMMANDS = new Set([
  ...Object.keys(GREEK), ...Object.keys(SYMBOL), ...UNWRAP, ...DROP_CMD, ...DROP_WITH_ARG, ...CUSTOM,
  "frac", "dfrac", "tfrac", "sqrt",
]);

/**
 * 纯排版指令（不产生可见内容，位置受 LaTeX 语法约束）。
 * 它们的「字面歧义」无害：如 \left 虽可切成 \le + "ft"，但 \left 本身不显示任何符号，
 * 后面必然跟定界符——切错也看不出来，故歧义检测豁免这一类。
 */
export const STRUCTURAL_COMMANDS = new Set([...DROP_CMD, ...DROP_WITH_ARG]);

/** HTML 转义：输出片段由调用方 innerHTML 挂载，字面文本必须转义。 */
const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/** 跳过空白，返回新下标 */
function skipSpaces(s, i) {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

/** 解析一个花括号组（含嵌套），s[start] 必须是 "{"；返回 { content, end } 或 null。
 * 括号失衡时把余下全部当组内容（展示兜底：宁输出内容，不漏出源码）。 */
function parseGroup(s, start) {
  if (s[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { content: s.slice(start + 1, i), end: i + 1 };
    }
  }
  return { content: s.slice(start + 1), end: s.length };
}

/** 解析命令/上下标的一个参数：{组}、单个命令、或单字符 */
function parseArg(s, i) {
  i = skipSpaces(s, i);
  const ch = s[i];
  if (ch === undefined) return null;
  if (ch === "{") {
    const g = parseGroup(s, i);
    return g ? { text: g.content, end: g.end } : null;
  }
  if (ch === "\\") return { text: parseCommand(s, i).raw, end: parseCommand(s, i).end };
  return { text: ch, end: i + 1 };
}

/** 从 s[i]（应为 "\\"）解析一个完整命令（名字 + 可选参数），返回原始切片与终点 */
function parseCommand(s, i) {
  const start = i;
  i++;
  if (isSpace(s[i])) {
    // "\ " 空格命令
    return { raw: s.slice(start, i + 1), end: i + 1, name: " " };
  }
  while (i < s.length && /[A-Za-z]/.test(s[i])) i++;
  if (i === start + 1) {
    // "\," "\:" "\!" 等标点短命令
    if (i < s.length && /[,;:!]/.test(s[i])) return { raw: s.slice(start, i + 1), end: i + 1, name: s[i] };
    return { raw: s[start] ?? "\\", end: start + 1, name: "" };
  }
  const full = s.slice(start + 1, i);
  if (KNOWN_COMMANDS.has(full)) return { raw: s.slice(start, i), end: i, name: full };
  // MinerU 常把 "\theta B" 写成 "\thetaB"（无空格）。若贪婪读到的名字未知，
  // 回退到「最长已知前缀」，余下字母留给正文——否则 "\thetaB" 会被整体当未知命令丢弃，
  // 连真实存在的字符 "B"（选项标记）也一起消失。
  for (let k = full.length - 1; k >= 1; k--) {
    const cand = full.slice(0, k);
    if (KNOWN_COMMANDS.has(cand)) {
      const end = start + 1 + k;
      return { raw: s.slice(start, end), end, name: cand };
    }
  }
  return { raw: s.slice(start, i), end: i, name: full };
}

/**
 * 递归渲染成 HTML 片段。
 * - { } 分组不显示；\frac → 竖排分式；\sqrt → 带上划线的根号；^/_ → <sup>/<sub>
 * - 空白在公式内无语义，**一律跳过**（在 HTML 阶段折叠会破坏标签属性里的空格）
 * - 字面字符逐个 escapeHtml
 */
function desugar(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isSpace(ch)) { i++; continue; } // 公式内空白无语义
    if (ch === "\\") {
      const cmd = parseCommand(s, i);
      const { name } = cmd;
      if (name === " ") {
        i = cmd.end;
        // 真实数据常见 "\ :" —— 空格命令后吞掉多余空格与标点短命令
        while (i < s.length && isSpace(s[i])) i++;
        if ([",", ";", ":", "!"].includes(s[i] ?? "")) i++;
        continue;
      }
      if ([",", ";", ":", "!"].includes(name)) { i = cmd.end; continue; }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const a = parseArg(s, cmd.end);
        const b = a ? parseArg(s, a.end) : null;
        if (a && b) {
          out += `<span class="frac"><span class="fn">${desugar(a.text)}</span><span class="fd">${desugar(b.text)}</span></span>`;
          i = b.end;
          continue;
        }
        // 截断/失衡导致参数不全：渲染已有部分，绝不能漏出 "frac" 命令名
        if (a) { out += desugar(a.text); i = a.end; continue; }
        i = cmd.end;
        continue;
      }
      if (name === "sqrt") {
        const a = parseArg(s, cmd.end);
        if (a) { out += `<span class="sqrt">√<span class="rad">${desugar(a.text)}</span></span>`; i = a.end; continue; }
      }
      if (name === "begin" || name === "end") {
        // 环境：吃掉 \begin{env} / \end{env}；array/tabular 再吃掉列格式 {cc}
        const env = parseArg(s, cmd.end);
        let j = env ? env.end : cmd.end;
        if (name === "begin" && env) {
          const envName = env.text.trim();
          if (envName === "array" || envName === "tabular") {
            const spec = parseArg(s, j);
            if (spec) j = spec.end;
          }
        }
        i = j;
        continue;
      }
      if (name === "mathbb") {
        const a = parseArg(s, cmd.end);
        if (a) {
          const key = a.text.trim();
          out += MATHBB[key] ?? desugar(a.text);
          i = a.end;
          continue;
        }
      }
      if (name === "underset" || name === "overset" || name === "stackrel") {
        // 两参数装饰：渲染基座（第二个参数）；上方/下方的小字只作可读性退化，不丢基座。
        const a = parseArg(s, cmd.end);
        const b = a ? parseArg(s, a.end) : null;
        if (a && b) { out += desugar(b.text); i = b.end; continue; }
        if (a) { out += desugar(a.text); i = a.end; continue; }
      }
      if (UNWRAP.has(name)) {
        const a = parseArg(s, cmd.end);
        if (a) { out += desugar(a.text); i = a.end; continue; }
      }
      if (GREEK[name]) { out += GREEK[name]; i = cmd.end; continue; }
      if (SYMBOL[name]) { out += SYMBOL[name]; i = cmd.end; continue; }
      if (DROP_CMD.has(name)) { i = cmd.end; continue; }
      if (DROP_WITH_ARG.has(name)) {
        let end = skipSpaces(s, cmd.end);
        if (s[end] === "{") { const g = parseGroup(s, end); if (g) end = g.end; }
        i = end;
        continue;
      }
      // 未知命令：丢弃命令名本身，保留其参数内容——宁可少显示一处排版命令，
      // 也绝不让 "\varepsilon" 这类命令名裸奔给用户看。
      i = cmd.end;
      continue;
    }
    if (ch === "^" || ch === "_") {
      const a = parseArg(s, i + 1);
      if (a) {
        const inner = desugar(a.text).trim();
        // ^ { \circ } → 度数符号直出（原卷就是 °，不是上标圆圈）
        if (ch === "^" && inner === "°") { out += "°"; i = a.end; continue; }
        // MinerU 把上标数字 2 误认成正体冒号：原卷第 4 页第 1 题实为 Fsin²θ，
        // 数据里却是 F \mathrm { s i n } ^ { \mathrm { : } } \theta → 还原为 2。
        // ⚠️ 曾把这类「纯标点上标」整体丢弃，导致平方消失（静默内容丢失）。
        // 纠正原则：宁可还原一个高概率候选，也不静默丢掉信息。
        if (ch === "^" && inner === ":") { out += "<sup>2</sup>"; i = a.end; continue; }
        const tag = ch === "^" ? "sup" : "sub";
        if (inner) out += `<${tag}>${inner}</${tag}>`;
        i = a.end;
        continue;
      }
      out += escapeHtml(ch);
      i++;
      continue;
    }
    if (ch === "{" || ch === "}") { i++; continue; } // 分组括号本身不显示
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/**
 * 无 $ 定界但明显是公式的整块文本——如 MinerU 的裸 interline 公式块。
 * 判据要宽：含任意 \命令，或「字母数字 + 上下标」（F _ { 1 }、x^2、m_a）。
 * 旧判据是枚举命令名的窄表，导致含 \angle/\prime/\colon 或无命令的 F_{1}
 * 这类文本原样输出、LaTeX 源码漏给用户（阶段 1 raw 层曾命中 12+ 处）。
 */
const LOOKS_LATEX = /\\[A-Za-z]+|[A-Za-z0-9]\s*[_^]/;

/**
 * 选项标记分隔：MinerU 丢失列间距后选项粘连成 "A.0.20B.0.30C.0.35D.0.45"。
 * 仅当同一文本出现 ≥2 个选项标记时才在每个标记前补分隔——单个 "A." 多为正文引用，
 * 不动它，降低误伤。
 *
 * 分隔用 EM SPACE（U+2003）而非普通空格：原卷的 A/B 是分列排版、间距约等于选项
 * 文本宽度（第 2 页第 10 题原卷 300dpi 裁剪实测），普通空格视觉上仍"靠得近"；
 * 且 HTML 会把连续普通空格折叠成一个。
 *
 * ⚠️ 必须在**渲染成 HTML 之后**调用：desugar 会吃掉公式内空白（含选项之间的分隔
 * 空格，"方向 D." → "方向D."），若在渲染前做，那些被吃掉的空格会让相邻选项又粘在一起
 * （2026-10-08 实测 p3 raw[10] 回归）。放在最后则天然避开该问题。
 */
export function separateOptionMarks(text) {
  const marks = text.match(/[A-D][.．]/g);
  if (!marks || marks.length < 2) return text;
  return text.replace(/([^\s])(?=[A-D][.．])/g, "$1\u2003");
}

/**
 * 空括号补间距（Task 13）：选择题末尾的作答括号在原卷是 `（　　）`（两个全角括号之间留出
 * 作答空隙），上游 MinerU 把空隙丢了 —— 快照里只剩半角 `()`，两个括号几乎贴成 `0`。
 * 展示层补回间距（与 `separateOptionMarks` 同类的**显式**展示层变换）。
 *
 * ── G4 原卷实测（600dpi 裁 origin.pdf，墨迹口径：左括号墨迹右缘 → 右括号墨迹左缘）──
 *   p0 blocks[12] `"…下列说法中正确的是()"`：间隙 **27.0pt**
 *   p0 blocks[21] `"弹力的是()"`：间隙 **27.0pt**
 *   p5 blocks[8]  `"()"`（整块就是空括号）：间隙 **27.2pt**
 *   p13 blocks[3] `"()"`：间隙 **27.1pt**
 *   同页正文 CJK 字距（= 1em）实测 **11.52pt** ⇒ 间隙 = 27.0 / 11.52 ≈ **2.34em**
 *   ⇒ 补 **2 个 EM SPACE**（U+2003，1em each）—— 即原卷 `（　　）` 的两个全角空格。
 *   （实测脚本：data/out/_t13-pgm.mjs；裁剪图见 Task 13 报告。）
 *
 * ── 判据（保守，lessons.md L2：改写类变换取最严）──
 * - 只处理「**成对、内部为空或仅空白**（半角空格 / 全角空格 / 制表）」的括号；
 *   半角 `()`、全角 `（）`、混合 `（)` 都算。
 * - **不碰**内部有内容的括号（如 `(多选)`）。
 * - **不跨块**：本函数只作用于单块文本，不做任何跨块匹配。
 * - **幂等**：EM SPACE（U+2003）不在空白字符类 `[ \t\u3000]` 内 ⇒ 已补过间距的括号
 *   不再命中，不会越补越宽。
 *
 * @param {string} text 已渲染成 HTML 片段的文本（括号为字面文本，不受标签影响）
 * @returns {string} 空括号内补 2 个 EM SPACE 后的文本；无命中则原样返回
 */
export function spaceEmptyParens(text) {
  return text.replace(/([（(])[ \t\u3000]*([）)])/g, "$1\u2003\u2003$2");
}

/**
 * 即时精确重复前缀折叠（展示层）：上游 MinerU 偶发把一段文本前缀连续复制两遍
 * （形如 `X + X + 其余`）。本函数仅当 `X` **逐字符相等**且 `X.length >= 6` 时
 * 折叠掉其中一份，恢复原貌。
 *
 * ⚠️ 这是**改写**类变换，必须最保守（lessons.md L2）：
 * - **不模糊匹配**（不做相似度 / 归一化后比较）；
 * - **不跨块匹配**（只在单块文本内折叠）；
 * - **不递归折叠**（折叠一次即返回，不在结果上再折）。
 * 阈值取 6：正常中文叠词「讨论讨论」「研究研究」「收拾收拾」的重复单元是 2 字，
 * 远小于 6，绝不会被误折。曾有一次臆想的「清洗」丢掉真实内容（2026-10-08 平方消失
 * 事故），故每一处折叠都**回原卷核对**过（见 Task 12 报告）。
 *
 * @param {string} text 上游原始文本（可含 LaTeX 源码）
 * @returns {string} 折叠掉一份即时重复前缀后的文本；无命中则原样返回
 */
const MIN_REPEAT = 6;
export function collapseImmediateRepeat(text) {
  if (typeof text !== "string") return text;
  const maxK = Math.floor(text.length / 2);
  for (let k = MIN_REPEAT; k <= maxK; k++) {
    if (text.slice(0, k) === text.slice(k, 2 * k)) {
      return text.slice(0, k) + text.slice(2 * k);
    }
  }
  return text;
}

/**
 * 展示用美化（返回 HTML 片段）：
 * - 先在纯文本上折叠上游「即时精确重复前缀」（collapseImmediateRepeat）；
 * - 再在纯文本上做选项标记分隔；
 * - $...$ 段内按 LaTeX 子集渲染成 HTML；段外文本原样保留（仅转义）；
 * - 无 $ 但含 LaTeX 的整块（裸公式块）也按公式渲染；
 * - 不成对的 $ 视为噪声字符去掉（避免源码漏出）；
 * - LaTeX 段内的不换行空格 "~" 还原为普通空格（`10~\mathrm{kg}` → `10 kg`）；
 *   **段外的 "~" 保留**——那是原卷的区间号（页眉 `T1~2`），换掉会抹掉区间语义；
 * - 空括号补间距（spaceEmptyParens）：恢复原卷 `（　　）` 的作答空隙。
 *
 * ⚠️ 不要动段外文本的空格：原卷的数学排版本身就有空格（原卷第 4 页第 1 题实测
 * "B. F sin θcos θ" 带空格）。2026-10-08 曾加过「收紧数学符号间空格」，
 * 回原卷核对后发现与原卷不符，已回滚——**没有回原卷核对过的"美化"不要做**。
 */
export function prettifyLatex(text) {
  if (!text) return text;
  text = collapseImmediateRepeat(text);
  let out = "";
  if (!text.includes("$")) {
    out = LOOKS_LATEX.test(text) ? desugar(text).replace(/~/g, " ") : escapeHtml(text);
  } else {
    let i = 0;
    let inFormula = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "$") { inFormula = !inFormula; i++; continue; }
      let j = text.indexOf("$", i);
      if (j === -1) j = text.length;
      // ⚠️ `~` 有**两种含义**，必须分开处理（2026-10-10 实测修复）：
      //   - LaTeX 段内：不换行空格（`10~\mathrm{kg}` → `10 kg`）→ 换空格；
      //   - 段外：原卷的**区间号**（页眉 `T1~2、4~5、7~8`）→ **必须保留**。
      // 原先在末尾对整串做全局 `replace(/~/g," ")`，把页眉的区间号也换成了空格
      // （`T1~2` → `T1 2`）→ **区间语义被抹掉**。原卷页眉 400dpi 裁图可见明显的 `~`
      // （data/out/_diff/hdr-p1-01.png），故此处按段区分。
      out += inFormula ? desugar(text.slice(i, j)).replace(/~/g, " ") : escapeHtml(text.slice(i, j));
      i = j;
    }
  }
  return spaceEmptyParens(separateOptionMarks(out));
}

/**
 * 命令切分歧义检测（审计用纯函数）。
 *
 * 背景：MinerU 常把 "\theta B" 写成 "\thetaB"。渲染器用「整串优先，不认识才回退前缀」
 * 处理——但有一类坎是机器跨不过去的：**整串是已知命令、其前缀也是已知命令**时，
 * 两种切法都合法，而原意只能从原卷图像得知。如 "\top" 既可能是 ⊤，也可能是 "\to" + "p"。
 *
 * 这不能靠「猜」解决，只能**报出来**交人确认（报出来只产生"待确认项"，
 * 猜错则产生"无人察觉的错误内容"）。纯排版指令（\left 等）豁免——
 * 它们不产生可见内容，切错也看不出来。
 */
export function findCommandAmbiguities(text) {
  const found = [];
  for (const m of text.matchAll(/\\([A-Za-z]+)/g)) {
    const cmd = m[1];
    if (!KNOWN_COMMANDS.has(cmd) || STRUCTURAL_COMMANDS.has(cmd)) continue;
    for (let k = cmd.length - 1; k >= 1; k--) {
      const prefix = cmd.slice(0, k);
      if (KNOWN_COMMANDS.has(prefix)) {
        found.push({ command: cmd, alternative: `${prefix} + "${cmd.slice(k)}"`, index: m.index });
        break;
      }
    }
  }
  return found;
}
