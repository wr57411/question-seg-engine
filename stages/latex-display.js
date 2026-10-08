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
  Xi: "Ξ", Upsilon: "Υ",
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
};

/** 命令后紧跟的花括号参数按内容展开、本身不显示（字体包装/上划线等） */
const UNWRAP = new Set([
  "mathrm", "boldsymbol", "mathbf", "text", "it", "mathit", "mathcal",
  "overline", "bar", "underline", "vec", "hat", "widetilde", "widehat",
  "overrightarrow", "overleftarrow", "operatorname", "textrm", "textbf",
  "textit", "mathsf", "texttt", "mbox", "textnormal",
]);

/** 无参数、直接丢弃的命令（纯排版指令，非内容） */
const DROP_CMD = new Set([
  "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits",
  "quad", "qquad", "thinspace", "enspace", "mathstrut", "strut",
  "left", "right", "big", "Big", "bigg", "Bigg",
]);

/** 参数非内容、需连参数一并丢弃的命令（否则 "red" 之类会裸奔） */
const DROP_WITH_ARG = new Set([
  "color", "textcolor", "hspace", "vspace", "kern", "mkern", "label", "tag",
  "phantom", "hphantom", "vphantom",
]);

/**
 * 渲染器已知命令集。两个用途：
 * ① parseCommand 用它做「最长已知前缀」回退（MinerU 常把 "\theta B" 写成 "\thetaB"）；
 * ② 导出给 scripts/audit-render.mjs 做输入端覆盖率检测——输出端查不到未知命令，
 *    因为它们已被丢弃、不留痕迹，所以必须在输入端查。
 */
export const KNOWN_COMMANDS = new Set([
  ...Object.keys(GREEK), ...Object.keys(SYMBOL), ...UNWRAP, ...DROP_CMD, ...DROP_WITH_ARG,
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
 * 展示用美化（返回 HTML 片段）：
 * - 先在纯文本上做选项标记分隔；
 * - $...$ 段内按 LaTeX 子集渲染成 HTML；段外文本原样保留（仅转义）；
 * - 无 $ 但含 LaTeX 的整块（裸公式块）也按公式渲染；
 * - 不成对的 $ 视为噪声字符去掉（避免源码漏出）；
 * - LaTeX 不换行空格 "~" 还原为普通空格（10~kg → 10 kg）。
 *
 * ⚠️ 不要动段外文本的空格：原卷的数学排版本身就有空格（原卷第 4 页第 1 题实测
 * "B. F sin θcos θ" 带空格）。2026-10-08 曾加过「收紧数学符号间空格」，
 * 回原卷核对后发现与原卷不符，已回滚——**没有回原卷核对过的"美化"不要做**。
 */
export function prettifyLatex(text) {
  if (!text) return text;
  let out = "";
  if (!text.includes("$")) {
    out = LOOKS_LATEX.test(text) ? desugar(text) : escapeHtml(text);
  } else {
    let i = 0;
    let inFormula = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "$") { inFormula = !inFormula; i++; continue; }
      let j = text.indexOf("$", i);
      if (j === -1) j = text.length;
      out += inFormula ? desugar(text.slice(i, j)) : escapeHtml(text.slice(i, j));
      i = j;
    }
  }
  return separateOptionMarks(out.replace(/~/g, " "));
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
