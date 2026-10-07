/**
 * latex-display.js —— 展示层专用 LaTeX→Unicode 轻量渲染（纯函数，无 DOM）。
 *
 * 定位：引擎结构化文本保留上游 LaTeX 原样（红线：不静默改写数据）；
 * 但展示时 "$\theta \left( \theta < 9 0 ^ { \circ } \right)$" 这类源码不可读。
 * 本模块做**只影响显示**的转换：按字符递归解析 LaTeX 子集
 * （\frac/\sqrt 嵌套参数、^/_ 嵌套上下标、{ } 分组、希腊字母/关系符表、
 * \left\right 与字体包装剥除、空白噪声折叠），语义改写（清洗数据本身）
 * 是引擎侧独立任务，不在此处。
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
  Gamma: "Γ", vartheta: "ϑ",
};

const SYMBOL = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
  approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", propto: "∝",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒",
  infty: "∞", prime: "′", degree: "°", angle: "∠",
  perp: "⊥", parallel: "∥", setminus: "∖", ldots: "…", dots: "…",
  sin: "sin", cos: "cos", tan: "tan", cot: "cot", log: "log", ln: "ln",
  max: "max", min: "min", circ: "°",
};

/** 命令后紧跟的花括号参数按内容展开、本身不显示（字体包装/上划线等） */
const UNWRAP = new Set([
  "mathrm", "boldsymbol", "mathbf", "text", "it", "mathit", "mathcal",
  "overline", "bar", "underline", "vec", "hat", "widetilde",
]);

const SUP = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "n": "ⁿ", "i": "ⁱ",
};

const SUB = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "a": "ₐ", "e": "ₑ", "o": "ₒ", "x": "ₓ",
};

const allMapped = (str, table) => [...str].every((ch) => ch in table);
const mapAll = (str, table) => [...str].map((ch) => table[ch] ?? ch).join("");

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
  return { raw: s.slice(start, i), end: i, name: s.slice(start + 1, i) };
}

/**
 * 递归渲染：{ } 分组不显示；\frac/\sqrt 嵌套解析；^/_ 上下标
 * （内容可映射时用 Unicode 上下标，否则保留 ^()/_() 形态）。
 * 空白不在此处折叠——由调用方决定（公式内折叠、段外保留）。
 */
function desugar(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const cmd = parseCommand(s, i);
      const { name } = cmd;
      if (name === " ") {
        out += " ";
        i = cmd.end;
        // 真实数据常见 "\ :" —— 空格命令后吞掉多余空格与标点短命令
        while (i < s.length && isSpace(s[i])) i++;
        if ([",", ";", ":", "!"].includes(s[i] ?? "")) i++;
        continue;
      }
      if ([",", ";", ":", "!"].includes(name)) { out += " "; i = cmd.end; continue; }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const a = parseArg(s, cmd.end);
        const b = a ? parseArg(s, a.end) : null;
        if (a && b) {
          out += `(${desugar(a.text)}/${desugar(b.text)})`;
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
        if (a) { out += `√(${desugar(a.text)})`; i = a.end; continue; }
      }
      if (UNWRAP.has(name)) {
        const a = parseArg(s, cmd.end);
        if (a) { out += desugar(a.text); i = a.end; continue; }
      }
      if (GREEK[name]) { out += GREEK[name]; i = cmd.end; continue; }
      if (SYMBOL[name]) { out += SYMBOL[name]; i = cmd.end; continue; }
      if (name === "left" || name === "right") { i = cmd.end; continue; }
      if (name === "circ") { out += "°"; i = cmd.end; continue; }
      out += name; // 未知命令 → 裸名字（\sin 已在 SYMBOL，此处兜底）
      i = cmd.end;
      continue;
    }
    if (ch === "^" || ch === "_") {
      const a = parseArg(s, i + 1);
      if (a) {
        const inner = desugar(a.text).trim();
        if (inner === "°") { out += "°"; i = a.end; continue; } // ^ { \circ } 特例
        const table = ch === "^" ? SUP : SUB;
        if (allMapped(inner, table)) {
          out += mapAll(inner, table);
        } else if (ch === "^") {
          out += `^(${inner})`;
        } else {
          out += `_${inner.replace(/_/g, "")}`; // 嵌套下标（F_{_{Na}}）不再叠出双下划线
        }
        i = a.end;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === "}") { i++; continue; } // 分组括号本身不显示
    out += ch;
    i++;
  }
  return out;
}

/** 无 $ 定界但明显是公式（含 LaTeX 命令）的整块文本——如 MinerU 的裸 interline 公式块 */
const LOOKS_LATEX = /\\(?:frac|sqrt|theta|mu|Delta|left|right|mathrm|boldsymbol|overline|setminus|vartheta|cdot|times|circ|alpha|beta|gamma|sin|cos|tan)\b/;

/**
 * 展示用美化：$...$ 段内按 LaTeX 子集渲染并折叠空白（LaTeX 内空格无语义）；
 * 段外文本原样保留；无 $ 但含 LaTeX 命令的整块（裸公式块）也按公式渲染；
 * 不成对的 $ 视为噪声字符直接去掉（避免源码漏出）。
 */
export function prettifyLatex(text) {
  if (!text) return text;
  if (!text.includes("$")) {
    return LOOKS_LATEX.test(text) ? desugar(text).replace(/\s+/g, "") : text;
  }
  let out = "";
  let i = 0;
  let inFormula = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "$") { inFormula = !inFormula; i++; continue; }
    let j = text.indexOf("$", i);
    if (j === -1) j = text.length;
    if (inFormula) {
      out += desugar(text.slice(i, j)).replace(/\s+/g, "");
    } else {
      out += text.slice(i, j); // 段外原样
    }
    i = j;
  }
  return out;
}
