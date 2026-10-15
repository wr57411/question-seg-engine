/**
 * reconstruct.d.ts —— 纸面重建共享渲染器的类型声明（实现见同目录 .js）。
 *
 * 为什么要有：`renderPaper` 是成品页与 stages「成品/对比」的**唯一**纸面实现（红线），
 * 「标签层不得改变版式」这类不变量必须在它这一层被锁住，所以它要能被 TS 测试 import。
 * 类型刻意宽松（快照结构由 `viewer/docs/CONTRACT.md` 约定），本文件只描述测试用到的形状。
 */

export interface PaperTag {
  short: string;
  name: string;
  color: string;
}

export interface PaperOptions {
  doc?: string;
  paneW: number;
  diagnostics?: boolean;
  candidateStyle?: boolean;
  onChipClick?: ((q: any, p: any) => void) | null;
  /** 标签解析器：返回该题的标签（纸面**只读渲染**，不做增删）。 */
  resolveTags?: ((q: any, p: any) => PaperTag[] | null) | null;
}

export const CANVAS_W: number;
export const GUTTER: number;

export function el(tag: string, cls: string, text?: string): any;
export function enc(s: string): string;
export function paperCanvas(p: any): any;
export function posStyle(node: any, bbox: number[], w: number, h: number): any;
export function blockNode(b: any, p: any, canvasW?: number, baseFont?: number | null, mergeCtx?: any, doc?: string): any;
export function mergeContext(p: any): any;
export function appendBlockNodes(
  c: any,
  p: any,
  canvasW: number,
  baseFont: number | null,
  mergeCtx: any,
  doc?: string,
  candidateStyle?: boolean,
): any[];
/** 单条 OCR 候选 → 节点（纸面与面板裁切共用这一份实现）。 */
export function ocrFillNode(it: any, p: any, canvasW: number, baseFont: number, candidateStyle?: boolean): any;
/** 候选行的落点矩形（窗口优先）。 */
export function ocrRect(it: any): number[];
/** 两个 PDF 点矩形是否相交。 */
export function rectHits(a: number[] | null | undefined, b: number[] | null | undefined): boolean;
export function ocrFillInto(c: any, p: any, canvasW?: number, candidateStyle?: boolean, region?: number[] | null): void;
/** **没被补上的**内容级未覆盖洞（纯函数；纸面标记与面板标记共用同一判据）。 */
export function unfilledContentHoles(p: any): Array<{ bbox: number[]; area: number }>;
export function uncoveredInto(c: any, p: any, canvasW?: number): void;
export function renderDiscardedInto(c: any, p: any, canvasW?: number): void;
export function legend(items: [string, string][]): any;

/** 整页重建：返回 `{ wrap, canvas, innerW }`。 */
export function renderPaper(p: any, opts: PaperOptions): { wrap: any; canvas: any; innerW: number };
