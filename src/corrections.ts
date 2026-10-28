/**
 * corrections.ts —— 应用「人工已核对的上游识别错误修正」清单
 *
 * 定位：本模块做的是**显式的数据清洗**，不是启发式猜测。
 * 清单（`corrections/<docId>.json`）里的每一条都必须满足：
 *   ① 来自两源交叉核对（scripts/oxr-crosscheck.ts 的判据）；
 *   ② 已**逐条回原卷页图核对**（docs/oxr-evaluation.md §4.9）。
 * 未经核对的候选不得进入清单 —— 宁缺勿滥（红线：不静默改写内容）。
 *
 * 两类修正：
 * - `replace`：MinerU 把字母 O 读成数字 0。按**整块原文**精确匹配后替换，
 *   不做模糊匹配，避免改到真的数字 0。
 * - `insert`：MinerU 完全漏读的图注（甲/乙/曲辕犁…），按核对过的 bbox 插回块序列，
 *   插在该页最近的图片块之后（图注跟着图）。补入的块带 `fromCorrection` 标记，
 *   展示层可据此区分「引擎原文」与「人工修正」。
 *
 * 注意：引擎默认**不**应用修正 —— 只有 `scripts/export-stages.ts` 在导出快照时显式调用。
 * 这样 `segmentFromLayout` 等纯引擎接口的行为保持不变，修正可整体撤销（删清单即可）。
 */
import type { BBox, ParsedBlock, ParsedDocument } from "./types.js";

export interface CorrectionItem {
  /** 1-based 页号（与 JSON 清单一致） */
  page: number;
  kind: "replace" | "insert";
  /** replace：整块原文（精确匹配用） */
  blockText?: string;
  /** insert：图注文本与 pt 坐标（bbox 已在生成阶段换算为 pt） */
  text?: string;
  bbox?: number[];
  verified?: boolean;
  /**
   * 插入来源，决定**插到哪**：
   * - `caption`（默认）：图注 → 插在该页最近的**图片块之后**（图注跟着图）
   * - `body-hole`：MinerU 整块漏读的**正文行** → 按 bbox 的 y 位置插入，
   *   否则会跑到某张图后面、与阅读顺序错位
   */
  source?: "caption" | "body-hole";
}

export interface CorrectionFile {
  docId: string;
  items: CorrectionItem[];
}

export interface ApplyReport {
  /** 实际替换的块数 */
  replace: number;
  /** 实际插入的块数 */
  insert: number;
  /** 清单里没能命中的条目下标（不静默：调用方应打印出来） */
  missed: number[];
}

/** O/0 修正：只替换**紧跟「点/角」**的那个 0，避免改到真正的数字 0 */
const O2ZERO = /[0０](?=[点角])/g;

function centerY(b: ParsedBlock): number {
  return (b.bbox[1] + b.bbox[3]) / 2;
}

function center(b: ParsedBlock): [number, number] {
  return [(b.bbox[0] + b.bbox[2]) / 2, centerY(b)];
}

/** 在页面块序列里找离给定 bbox 最近的图片块下标（没有则 -1） */
function nearestImageIndex(blocks: ParsedBlock[], bbox: BBox): number {
  const [tx, ty] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  let best = -1;
  let bestD = Infinity;
  blocks.forEach((b, i) => {
    if (b.kind !== "image") return;
    const [bx, by] = center(b);
    const d = Math.hypot(tx - bx, ty - by);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * 应用修正（**原地修改** doc，返回统计）。调用方负责决定是否应用。
 * replace 按「整块原文」精确匹配：同一段原文在同一卷里重复出现时，
 * 会**全部**替换（图注/公式同文重复的情况在正文里罕见，且语义一致）。
 */
export function applyCorrections(doc: ParsedDocument, file: CorrectionFile): ApplyReport {
  const report: ApplyReport = { replace: 0, insert: 0, missed: [] };

  file.items.forEach((item, idx) => {
    const page = doc.pages[item.page - 1];
    if (!page) {
      report.missed.push(idx);
      return;
    }

    if (item.kind === "replace") {
      const target = item.blockText ?? "";
      if (target.length === 0) {
        report.missed.push(idx);
        return;
      }
      let hit = 0;
      for (const b of page.blocks) {
        if (b.kind !== "text" || b.text !== target) continue;
        const fixed = b.text.replace(O2ZERO, "O");
        if (fixed === b.text) continue;
        b.text = fixed;
        // firstLine 用于题号/选项判定，必须同步，否则修正只在正文生效、判定仍看旧值
        b.firstLine = b.firstLine.replace(O2ZERO, "O");
        b.fromCorrection = true;
        hit++;
      }
      if (hit === 0) report.missed.push(idx);
      else report.replace += hit;
      return;
    }

    // insert
    const text = (item.text ?? "").trim();
    const bb = item.bbox;
    if (text.length === 0 || !bb || bb.length < 4) {
      report.missed.push(idx);
      return;
    }
    const bbox: BBox = [bb[0] ?? 0, bb[1] ?? 0, bb[2] ?? 0, bb[3] ?? 0];
    const block: ParsedBlock = {
      kind: "text",
      bbox,
      text,
      firstLine: text,
      lineCount: 1,
      // 图注是小字：用 bbox 高作字号上界，避免被当成大题标题
      maxFontSize: Math.max(1, bbox[3] - bbox[1]),
      fromCorrection: true,
    };
    const imgIdx = nearestImageIndex(page.blocks, bbox);
    if (item.source === "body-hole") {
      // 正文漏读行：**按阅读顺序（y 中心）插入**。
      // 用「图片块之后」会错位 —— 图注跟着图是对的，正文行必须落在它原来的位置。
      const cy = (bbox[1] + bbox[3]) / 2;
      let at = page.blocks.findIndex((b) => {
        const by = (b.bbox[1] + b.bbox[3]) / 2;
        return by > cy;
      });
      if (at < 0) at = page.blocks.length;
      page.blocks.splice(at, 0, block);
    } else if (imgIdx >= 0) {
      page.blocks.splice(imgIdx + 1, 0, block);
    } else {
      page.blocks.push(block);
    }
    report.insert++;
  });

  return report;
}
