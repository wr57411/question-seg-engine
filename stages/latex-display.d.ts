/**
 * latex-display.d.ts —— 展示层 LaTeX→Unicode 美化（纯显示用途，不改引擎数据）。
 * 实现见同目录 latex-display.js；红线：本目录不 import 引擎代码。
 */
export function prettifyLatex(text: string): string;
