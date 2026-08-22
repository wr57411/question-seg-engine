/**
 * 展示层独立类型声明 —— 数据契约的 TypeScript 形态。
 * 权威：viewer/docs/CONTRACT.md；引擎变更必须同步此处与 CONTRACT.md。
 * 红线：本文件不得 import src/ 下的任何内容。
 */
export interface ViewerQuestion {
  id: string;
  number: string;
  type: "choice" | "subjective";
  section: string;
  stem: string;
  options: { key: string; text: string }[];
  answer?: string;
  images: { path: string }[];
  confidence: number;
  status: "ok" | "needs_review";
}
