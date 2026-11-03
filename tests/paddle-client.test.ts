// paddle-client.test.ts —— 锁住「从 HTTP 作业接口拿结构」这条新链路的纯逻辑。
//
// 为什么要有（2026-11-03）：`scripts/paddle-client.ts` 是替代 MCP 通道的新路径，
// MCP 把 `prunedResult` 整层丢了（实测 `output_mode:"detailed"` 也不含 bbox）。
// 这里**不打网络**：用与真实响应同构的样例（字段名取自 `data/_probe/2026-11-03-paddle/`
// 实测原样返回）验解析、归一化、计数、几何判据和凭据握手的状态映射。
// 真实服务端形状若变了，这个测试**不会**替我们发现 —— 所以另有
// `npm run audit:paddle` 的实测报告作为第二层（见 docs/evidence/2026-11-03-*.md）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JOB_URL,
  normalizePageItem,
  overlapArea,
  parseDocParsingJsonl,
  verifyToken,
} from "../scripts/paddle-client.js";
import { countMineruItems, countPaddleBlocks, diffCounts } from "../scripts/paddle-structure-audit.js";
import {
  COVER_MIN,
  charNgrams,
  colOf,
  containMatches,
  coverage,
  detectPageBasis,
  dice,
  dilate,
  COVER_MARGIN,
  hardChars,
  iou,
  judgeItem,
  pageIndex,
} from "../scripts/paddle-pos-diff.js";

/** 五点四边形（含一个多余的闭合点），验 `rec_polys` 的多边形 ⇒ 外接矩形 逻辑。 */
const POLY_5PT = [
  [50, 100],
  [150, 100],
  [150, 150],
  [50, 150],
  [50, 100],
];

/** V3 单页原样的最小同构样例：块 + 版面框 + 行级 OCR + 表格单元格 + 公式。 */
const V3_LINE = JSON.stringify({
  errorCode: 0,
  result: {
    layoutParsingResults: [
      {
        markdown: { text: "# 标题\n正文", images: {} },
        prunedResult: {
          width: 1000,
          height: 2000,
          parsing_res_list: [
            { block_label: "text", block_content: "第一行文字", block_bbox: [100, 200, 300, 400], block_order: 1 },
            { block_label: "table", block_content: "<table></table>", block_bbox: [0, 500, 1000, 1500], block_order: null },
          ],
          layout_det_res: {
            boxes: [
              { label: "text", score: 0.91, coordinate: [100, 200, 300, 400] },
              { label: "inline_formula", score: 0.45, coordinate: [10, 10, 20, 20] },
            ],
          },
          overall_ocr_res: {
            rec_texts: ["第一行文字", "第二行"],
            rec_polys: [[[100, 200], [300, 200], [300, 260], [100, 260]], POLY_5PT],
            rec_scores: [0.998, 0.5],
          },
          table_res_list: [{ pred_html: "<table><tr><td>A</td></tr></table>", cell_box_list: [[1, 2, 3, 4], [5, 6, 7, 8]] }],
          formula_res_list: [{ rec_formula: "\\frac{1}{R}", dt_polys: [3060, 3005, 3750, 3186] }],
        },
      },
    ],
  },
});

test("parseDocParsingJsonl：V3 形状 ⇒ 块/行/表/公式全部拿到，坐标按 width/height 归一化", () => {
  const pages = parseDocParsingJsonl(V3_LINE);
  assert.equal(pages.length, 1);
  const p = pages[0]!;
  assert.equal(p.width, 1000);
  assert.equal(p.height, 2000);
  assert.equal(p.counters.blocks, 2);
  assert.deepEqual(p.blocks[0]!.bbox, [100, 200, 300, 400]);
  // 归一化是硬要求：图片域(1000px) 与 PDF 域(4186px) 不统一，只有 0..1 可比
  assert.deepEqual(p.blocks[0]!.norm, [0.1, 0.1, 300 / 1000, 0.2]);
  assert.equal(p.blocks[1]!.order, null); // header/table 类块没有 order（实测）
  assert.equal(p.counters.lines, 2);
  assert.equal(p.counters.cells, 2);
  assert.equal(p.counters.tables, 1);
  assert.equal(p.counters.formulas, 1);
  assert.equal(p.counters.detBoxes, 2);
  assert.equal(p.lines[0]!.score, 0.998);
  assert.deepEqual(p.lines[0]!.bbox, [100, 200, 300, 260]); // 四点多边形 ⇒ 外接矩形
  assert.deepEqual(p.lines[1]!.bbox, [50, 100, 150, 150]); // 五点闭合多边形 ⇒ 同一外接矩形
  assert.deepEqual(p.formulas[0]!.bbox, [3060, 3005, 3750, 3186]); // 数组式 dt_polys
  assert.equal(p.counters.byLabel.text, 1);
});

test("parseDocParsingJsonl：VL 形状（一行 4 页）⇒ 展平并按顺序编号，且没有行级/表格结构", () => {
  // 实测：VL 整本 13 页返回 4 行（4+4+4+1），每行 result.layoutParsingResults 有 4 项
  const line = JSON.stringify({
    result: {
      layoutParsingResults: [1, 2, 3, 4].map((n) => ({
        markdown: { text: `p${n}` },
        prunedResult: {
          width: 4186,
          height: 5988,
          parsing_res_list: [{ block_label: "text", block_content: "x", block_bbox: [1, 2, 3, 4], block_order: n }],
          layout_det_res: { boxes: [{ label: "image", score: 0.7, coordinate: [0, 0, 10, 10] }] },
        },
      })),
    },
  });
  const pages = parseDocParsingJsonl(`${line}\n`);
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((p) => p.page), [0, 1, 2, 3]);
  assert.equal(pages[3]!.markdown, "p4");
  assert.equal(pages[0]!.counters.lines, 0); // VL 无 overall_ocr_res（实测）
  assert.equal(pages[0]!.counters.tables, 0);
  assert.equal(pages[0]!.counters.blocks, 1);
});

test("parseDocParsingJsonl：空行/坏行不炸，也不产出幽灵页（判据不能靠运气）", () => {
  const pages = parseDocParsingJsonl(`\n{"result":{}}\nnot json\n${V3_LINE}\n`);
  assert.equal(pages.length, 1);
});

test("normalizePageItem：缺 prunedResult 时只剩 markdown，计数为 0（不假装有结构）", () => {
  const p = normalizePageItem({ markdown: { text: "abc" } }, 0);
  assert.equal(p.markdown, "abc");
  assert.equal(p.counters.markdownChars, 3);
  assert.equal(p.counters.blocks, 0);
  assert.equal(p.width, 0);
  assert.equal(p.blocks[0], undefined);
});

test("overlapArea：只算交集，不相交为 0（审计的位置判据用得上）", () => {
  assert.equal(overlapArea([0, 0, 10, 10], [5, 5, 15, 15]), 25);
  assert.equal(overlapArea([0, 0, 10, 10], [20, 20, 30, 30]), 0);
});

test("计数对照：MinerU content_list 与 Paddle 块标签逐类目对齐，差值有正负", () => {
  const per = countMineruItems([
    { type: "text", page_idx: 0 },
    { type: "text", page_idx: 0 },
    { type: "table", page_idx: 1 },
  ]);
  assert.deepEqual(per[0], { text: 2 });
  assert.deepEqual(per[1], { table: 1 });
  const p = parseDocParsingJsonl(V3_LINE)[0]!;
  const pc = countPaddleBlocks(p);
  assert.equal(pc.text, 1);
  const d = diffCounts(pc, per[0]!);
  assert.equal(d.text, -1); // Paddle 少 1 条 text ⇒ 只报警，不代表谁错
  assert.equal(d.table, 1);
});

test("dice/hardChars：LaTeX 记号与空白不参与相似度；短串不退化", () => {
  assert.equal(dice("$\\frac{5}{8}$ 一个数", "frac 5 8 一个数"), 1);
  assert.equal(dice("", "abc"), 0);
  assert.equal(charNgrams(hardChars("abcd")).size, 1); // 长度 ≤ n ⇒ 整串一个 gram
});

test("iou/colOf：位置判据的几何底座", () => {
  assert.equal(iou([0, 0, 2, 2], [0, 0, 2, 2]), 1);
  assert.equal(iou([0, 0, 2, 2], [3, 3, 5, 5]), 0);
  assert.equal(colOf([0.1, 0, 0.2, 0.1]), 0);
  assert.equal(colOf([0.6, 0, 0.9, 0.1]), 1);
});

test("judgeItem：碎片被唯一块包含但没盖住洞 ⇒ 串位；四态各自归类（v2 判据）", () => {
  const para = "一个电子 charge 在匀强磁场里做圆周运动的半径公式是";
  const blocks = [
    { content: para, norm: [0.6, 0.6, 0.95, 0.7] as [number, number, number, number], label: "text" },
    { content: "另一段完全无关的文字在这里边", norm: [0.05, 0.05, 0.5, 0.3] as [number, number, number, number], label: "text" },
  ];
  const hole: [number, number, number, number] = [0.1, 0.1, 0.4, 0.2];
  // ① 唯一落位 + 洞不在那块里 ⇒ 串位
  const v = judgeItem(0, hole, "在匀强磁场里做圆周运动", true, blocks);
  assert.equal(v.status, "unique");
  assert.equal(v.cover, 0);
  assert.ok(v.cover < COVER_MIN);
  assert.equal(v.colSame, false);
  assert.deepEqual(v.vlBox, [0.6, 0.6, 0.95, 0.7]);
  // ② 唯一落位 + 洞落在那块里 ⇒ 位置一致
  const inside = judgeItem(0, [0.62, 0.61, 0.88, 0.65], "在匀强磁场里做圆周运动", true, blocks);
  assert.equal(inside.status, "unique");
  assert.equal(inside.cover, 1);
  // ③ 太短 ⇒ 不判定（第一轮就是栽在拿短碎片硬比位置）
  assert.equal(judgeItem(0, hole, "图1", true, blocks).status, "too_short");
  // ④ 该页没有块 ⇒ no_blocks
  assert.equal(judgeItem(0, hole, "在匀强磁场里做圆周运动", true, []).status, "no_blocks");
  // ⑤ VL 里没有这段文字 ⇒ absent（不计为错）
  assert.equal(judgeItem(0, hole, "这段 VL 根本没读出来的文字内容", true, blocks).status, "absent");
  // ⑥ 被多个块包含 ⇒ ambiguous（不计为错，也不能当"摊对了"）
  const dup = [
    { content: para, norm: [0.1, 0.1, 0.9, 0.2] as [number, number, number, number], label: "text" },
    { content: "重复出现：在匀强磁场里做圆周运动 的说明", norm: [0.1, 0.5, 0.9, 0.6] as [number, number, number, number], label: "text" },
  ];
  assert.equal(judgeItem(0, hole, "在匀强磁场里做圆周运动", true, dup).status, "ambiguous");
});

test("containMatches：归一化后再比（LaTeX 记号与空白不参与），并返回全部命中下标", () => {
  const blocks = [
    { content: "I=\\frac{U}{R} 是欧姆定律", norm: [0, 0, 1, 1] as [number, number, number, number], label: "text" },
  ];
  assert.deepEqual(containMatches("I=U/R 是欧姆定律", blocks), []); // 写法不同不硬凑（分式不是 U/R）
  assert.deepEqual(containMatches("是欧姆定律", blocks), [0]);
  assert.deepEqual(containMatches("不存在的话", blocks), []);
});

test("页序基：用值集合判（0 基的第 12 页与 1 基的第 13 页在 13 页的本里都是合法值，min 判不出来）", () => {
  assert.equal(detectPageBasis([0, 1, 2, 12], 13), "0"); // 实测 ocr-page-fill.json 就是这种
  assert.equal(detectPageBasis([1, 2, 13], 13), "1"); // 出现 pageCount ⇒ 只能是 1 基
  assert.equal(detectPageBasis([4, 7, 10], 15), "mixed"); // 稀疏页 + 无 0 无 15 ⇒ 真判不出
  assert.equal(detectPageBasis([], 15), "0");
  assert.equal(pageIndex(12, "0"), 12);
  assert.equal(pageIndex(13, "1"), 12);
  assert.equal(pageIndex(1, "mixed"), 1); // mixed 按 0 基走，不假装知道
});

test("coverage：洞被块盖住的比例，粒度不同源时比 IoU 更准", () => {
  assert.equal(coverage([0, 0, 2, 2], [0, 0, 4, 4]), 1);
  assert.equal(coverage([0, 0, 2, 2], [1, 0, 4, 2]), 0.5);
  assert.equal(coverage([0, 0, 2, 2], [3, 3, 4, 4]), 0);
});

test("COVER_MARGIN：只能消贴边假阳性，消不掉「隔了一行以上」的情况 ⇒ 串位样本必须回页图", () => {
  // ① 纯贴边（洞与块边线相接）：不容差 cover=0，外扩后 cover=1 ⇒ 这类是工具伪影
  const touching: [number, number, number, number] = [0.116, 0.346, 0.436, 0.411];
  assert.equal(coverage(touching, [0.116, 0.346, 0.436, 0.411]), 1);
  assert.equal(coverage([0.249, 0.339, 0.274, 0.346], [0.116, 0.346, 0.436, 0.411]), 0);
  assert.equal(coverage([0.249, 0.339, 0.274, 0.346], dilate([0.116, 0.346, 0.436, 0.411], COVER_MARGIN)), 1);
  // ② 实测真实样本（电路 p4 / 2相互作用 p4）：洞 y0.339–0.346、块 y0.355–0.411，
  //    间隔 0.009 ≈ 1.3 倍行高 ⇒ 外扩 0.01 只抬到 0.143，**仍然 cover<0.5**。
  //    这恰恰说明本指标分不清「摊字符摊错了行」与「VL 块框本身内缩不含这一行」，
  //    所以串位样本一律回原卷页图复核，不能拿比率当结论（`BACKLOG B-30`）。
  const realCover = coverage([0.249, 0.339, 0.274, 0.346], dilate([0.116, 0.355, 0.436, 0.411], COVER_MARGIN));
  assert.ok(realCover > 0 && realCover < COVER_MIN, `realCover=${realCover}：抬了但没抬过阈值`);
});

test("verifyToken：401=失效 / 404+11001=有效 / 其它=不可用（零成本握手，不提交作业）", async () => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      if (String(url).includes("/jobs/1")) {
        return {
          status: (globalThis as any).__wantOk ? 404 : 401,
          text: async () => (globalThis as any).__wantOk ? '{"code":11001,"msg":"jobId 不存在"}' : '{"code":401,"msg":"Unauthorized"}',
        } as never;
      }
      return { status: 500, text: async () => "x" } as never;
    }) as never;
    (globalThis as any).__wantOk = false;
    const bad = await verifyToken("fake-token-for-test");
    assert.equal(bad.ok, false);
    assert.equal(bad.state, "unauthorized");
    (globalThis as any).__wantOk = true;
    const good = await verifyToken("fake-token-for-test");
    assert.equal(good.ok, true);
    assert.equal(good.state, "valid");
    assert.deepEqual(calls, [`${JOB_URL}/1`, `${JOB_URL}/1`]); // 握手只 GET 作业状态，绝不 POST 提交
  } finally {
    globalThis.fetch = real;
    delete (globalThis as any).__wantOk;
  }
});

test("verifyToken：网络异常归到 network，不冒充「token 有效」", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as never;
    const r = await verifyToken("fake-token-for-test");
    assert.equal(r.ok, false);
    assert.equal(r.state, "network");
    assert.match(r.detail, /ECONNRESET/);
  } finally {
    globalThis.fetch = real;
  }
});
