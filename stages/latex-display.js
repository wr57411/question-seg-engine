/**
 * latex-display.js —— 展示层专用 LaTeX→Unicode 轻量美化（纯函数，无 DOM）。
 *
 * 定位：引擎结构化文本保留上游 LaTeX 原样（红线：不静默改写数据）；
 * 但展示时 "$\theta \left( \theta < 9 0 ^ { \circ } \right)$" 这类源码不可读。
 * 本模块做**只影响显示**的轻量转换：希腊字母、度符号、\frac、上下标、
 * \left/\right 与字体包装剥除、空白噪声折叠。语义改写（清洗数据本身）
 * 是引擎侧独立任务，不在此处。
 * 供 stages.js 使用；tests/latex-display.test.ts 回归锁定。
 */

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ",
  theta: "θ", mu: "μ", rho: "ρ", pi: "π", sigma: "σ",
  lambda: "λ", omega: "ω", phi: "φ", eta: "η", tau: "τ",
};

const SUP = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "n": "ⁿ", "i": "ⁱ",
};

const SUB = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "a": "ₐ", "e": "ₑ", "o": "ₒ",
  "x": "ₓ",
};

const allMapped = (str, table) => [...str].every((ch) => ch in table);
const mapAll = (str, table) => [...str].map((ch) => table[ch] ?? ch).join("");

function prettifyOne(lx) {
  let s = lx;
  // 定界符与手工间距（真实数据里 "\ :" 常带空格，一并吃掉）
  s = s.replace(/\\(?:left|right)\b/g, " ");
  s = s.replace(/\\(?:quad|qquad)\b/g, " ");
  s = s.replace(/\\\s*[,;:!]/g, " ");
  // 字体/加粗包装：\mathrm { X } → X（可嵌一层）
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\(?:mathrm|boldsymbol|mathbf|text|it)\s*\{([^{}]*)\}/g, "$1");
  }
  // \frac { A } { B } → (A/B)
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1/$2)");
  }
  // ^ { \circ } / \circ → °
  s = s.replace(/\^\s*\{\s*\\circ\s*\}/g, "°");
  s = s.replace(/\\circ\b/g, "°");
  // ^{X} / _{X} → 上下标（可映射时），否则保留 ^X / _X
  s = s.replace(/\^\s*\{([^{}]*)\}/g, (_, inner) => {
    const t = String(inner).trim();
    return allMapped(t, SUP) ? mapAll(t, SUP) : `^(${t})`;
  });
  s = s.replace(/_\s*\{([^{}]*)\}/g, (_, inner) => {
    const t = String(inner).trim();
    return allMapped(t, SUB) ? mapAll(t, SUB) : `_${t}`;
  });
  // 剩余希腊字母与函数名
  s = s.replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ?? name);
  // 空白噪声：LaTeX 内空格无语义，数学展示直接全部去掉（"1 0 m / s" → "10m/s"）
  s = s.replace(/\s+/g, "");
  return s;
}

/** 展示用美化：仅转换 $...$ 段内内容，段外文本原样返回 */
export function prettifyLatex(text) {
  if (!text || !text.includes("$")) return text;
  return text
    .split(/(\$[^$]*\$)/)
    .map((seg) => (seg.startsWith("$") && seg.endsWith("$") && seg.length >= 2
      ? prettifyOne(seg.slice(1, -1))
      : seg))
    .join("");
}
