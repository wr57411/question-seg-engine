#!/usr/bin/env node
/**
 * audit-render.mjs —— 展示层渲染的「全量审计」，替代人工抽查截图。
 *
 * 为什么需要它：2026-10-08 用户对比模式截图报出 A.Fsin^(:)θ（上标噪声）与
 * A.0.20B.0.30（选项粘连）。此前渲染器的验收判据是「语法零残留」——
 * 即输出里没有反斜杠/花括号。但 \varepsilon 会被渲染成裸名字 "varepsilon"、
 * ^{:} 会被渲染成 "(:)"：语法干净、语义是错的，判据漏掉了一整类缺陷。
 *
 * 本工具把判据升级为**语义级**，并在**输入端**补两道检测：
 *   1. 输出端可疑模式：^(标点)、_(标点)、残留 \ 与 {}、行尾裸上下标
 *   2. 输入端覆盖率：输入文本里的 \命令 是否都在渲染器已知集内
 *   3. 选项粘连：同一文本 ≥2 个选项标记却仍无分隔
 *   4. 命令切分歧义（提示级）：整串是命令、其前缀也是命令——两种切法都合法，
 *      原意只能从原卷图像得知（如 \top 可能是 ⊤，也可能是 \to + "p"）。
 *      这一节**不计入退出码**：它报的是"机器无法判断、需人扫一眼"的信息，
 *      不是确定的错误。报出来只产生"待确认项"，猜错才产生"无人察觉的错误"。
 *
 * 用法：node scripts/audit-render.mjs [docId]
 * 退出码：0 = 判定项全部归零；1 = 判定项有发现（可接入 CI / npm run check）
 */
import { readFileSync } from "node:fs";
import { prettifyLatex, KNOWN_COMMANDS, findCommandAmbiguities } from "../stages/latex-display.js";

const docId = process.argv[2] ?? "23必刷题 2相互作用";
const SNAP = new URL(`../data/out/${docId}/stages.json`, import.meta.url);

let snap;
try {
  snap = JSON.parse(readFileSync(SNAP, "utf8"));
} catch {
  // 快照是运行时产物（data/ 不入库）：新克隆环境没有它，跳过而非报错，
  // 这样本脚本可以安全接入 npm run check。
  console.log(`渲染审计：跳过（未找到快照 ${docId}，先运行 npm run stages:export）`);
  process.exit(0);
}

/** 输出端可疑模式（语法干净但语义可疑） */
const OUT_PATTERNS = [
  ["上标括号内标点", /\^\([^A-Za-z0-9)]{1,3}\)/],
  ["下标括号内标点", /_\([^A-Za-z0-9)]{1,3}\)/],
  ["残留反斜杠", /\\/],
  ["残留花括号", /[{}]/],
  ["行尾裸上标", /\^\s*$/],
  ["行尾裸下标", /_\s*$/],
];

const outHits = Object.fromEntries(OUT_PATTERNS.map(([n]) => [n, []]));
const unknownCmds = new Map(); // 命令名 → 出现次数
const ambiguityMap = new Map(); // "命令 → 另一种切法" → { n, sample }
const stuckOptions = [];
let total = 0;

for (const p of snap.pages) {
  for (const src of ["blocks", "raw", "discarded"]) {
    for (const b of p[src] ?? []) {
      const raw = b.text ?? "";
      if (!raw) continue;
      total++;
      const shown = prettifyLatex(raw);
      for (const [name, re] of OUT_PATTERNS) {
        if (re.test(shown)) outHits[name].push({ p: p.index, src, i: b.i, shown: shown.slice(0, 80) });
      }
      // 输入端：未覆盖命令。快照文本截断（≤120 字符）会把 "\circ" 切成 "\ci"，
      // 落在文本末尾的命令视为截断伪影，不计入。
      for (const m of raw.matchAll(/\\([A-Za-z]+)/g)) {
        const name = m[1];
        if (m.index + m[0].length >= raw.length - 1) continue;
        if (KNOWN_COMMANDS.has(name)) continue;
        // 渲染器同款「最长已知前缀」回退：\thetaB 会按 \theta + "B" 处理，不算未覆盖
        let covered = false;
        for (let k = name.length - 1; k >= 1; k--) {
          if (KNOWN_COMMANDS.has(name.slice(0, k))) { covered = true; break; }
        }
        if (!covered) unknownCmds.set(name, (unknownCmds.get(name) ?? 0) + 1);
      }
      // 命令切分歧义（提示级，见文件头说明）
      for (const a of findCommandAmbiguities(raw)) {
        const key = `\\${a.command} 也可能切成 \\${a.alternative}`;
        if (!ambiguityMap.has(key)) {
          ambiguityMap.set(key, { n: 0, sample: raw.slice(Math.max(0, a.index - 18), a.index + a.command.length + 12) });
        }
        ambiguityMap.get(key).n++;
      }
      // 选项粘连：≥2 标记但标记间无空白
      const marks = shown.match(/[A-D][.．]/g);
      if (marks && marks.length >= 2 && /[^\s][A-D][.．]/.test(shown)) {
        stuckOptions.push({ p: p.index, src, i: b.i, shown: shown.slice(0, 80) });
      }
    }
  }
}

// 每节带 fatal 标志：false = 提示级，只展示不计入退出码
const sections = [];
for (const [name] of OUT_PATTERNS) {
  sections.push([name, outHits[name], true]);
}
sections.push(["选项粘连未分隔", stuckOptions, true]);
sections.push(["未覆盖的 LaTeX 命令", [...unknownCmds.entries()].map(([c, n]) => ({ shown: `\\${c} ×${n}` })), true]);
sections.push([
  "命令切分歧义（提示·需人工扫一眼）",
  [...ambiguityMap.entries()].map(([k, v]) => ({ shown: `${k}  ×${v.n}`, sample: v.sample })),
  false,
]);

console.log(`渲染审计 · ${docId}`);
console.log(`扫描文本块 ${total} 个\n`);
let bad = 0;
let hints = 0;
for (const [name, list, fatal] of sections) {
  const flag = list.length === 0 ? "✅" : fatal ? "❌" : "⚠️";
  console.log(`${flag} ${name}：${list.length}`);
  if (list.length > 0) fatal ? (bad += list.length) : (hints += list.length);
  for (const x of list.slice(0, 6)) {
    const loc = x.p === undefined ? "" : `p${x.p} ${x.src}[${x.i}] `;
    console.log(`     ${loc}${JSON.stringify(x.shown)}`);
    if (x.sample) console.log(`        …${JSON.stringify(x.sample)}`);
  }
  if (list.length > 6) console.log(`     …另有 ${list.length - 6} 条`);
}
if (bad === 0) {
  console.log(hints > 0 ? `\n判定项全部归零 ✅（另有 ${hints} 条提示，不影响退出码）` : "\n全部归零 ✅");
} else {
  console.log(`\n合计 ${bad} 条待处理 ❌`);
}
process.exit(bad === 0 ? 0 : 1);
