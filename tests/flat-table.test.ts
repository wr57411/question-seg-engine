// tests/flat-table.test.ts
/**
 * **压平表格行 → 表格块**（`DECISIONS §90`）。
 *
 * 上游把知识清单表格压平成 N 行纯文本，单元格用 `|` 隔开，每行一个 para_block。
 * 渲染时每行按自己的 bbox 算字号（行越长被 clamp 得越小）⇒ 字号参差、挤成一团
 * （2026-10-30 用户截图：电路册 p1 出现 `欧姆定律(纯电阻电路` / `-2+` / `dot` 一堆碎字）。
 *
 * 这里锁三件事：
 * 1. 能还原成 3 列表格，续行并进上一行最后一列；
 * 2. **单栏正文行不许被合并**（宽度不够就退出）—— 这是最危险的误伤；
 * 3. 组内行数不足 3 时不动。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";

const PAGE_W = 2093;
const PAGE_H = 2994;

type Line = { text: string; bbox: [number, number, number, number] };

/** 每行一个 para_block —— 复刻 `电路` 这类 layout 的形态（每行一块）。 */
function mkLayout(lines: Line[]) {
  return {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [PAGE_W, PAGE_H],
        para_blocks: lines.map((l) => ({
          type: "text",
          bbox: l.bbox,
          lines: [{ bbox: l.bbox, spans: [{ type: "text", content: l.text }] }],
        })),
      },
    ],
  };
}

/** 表格行：x0=73、宽 1848（整页宽），行高 62、行距 99 —— 实测电路 p1 的真实几何。 */
function tableRow(y: number, text: string): Line {
  return { text, bbox: [73, y, 73 + 1848, y + 62] };
}

function cellsOf(html: string): string[][] {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]!),
  );
}

test("压平表格行 → 3 列表格：3 段直接对齐，续行并入上一行最后一列", () => {
  const doc = normalizeLayout(
    mkLayout([
      tableRow(638, "欧姆定律(纯电阻电路) | 电流的三个表达式 | (1)$I=q/t$(定义式);(2)$I=U/R$"),
      tableRow(737, "(决定式);(3)$I=neSv$(微观决定式)"), // 无 | ⇒ 续行
      tableRow(836, "伏安特性曲线(如图所示) |"), // 末段空 ⇒ 从列1 起
      tableRow(935, "电阻定律 | 表达式 | $R=\\rho l/S$(决定式)"),
      tableRow(1034, "定义式 | $R=U/I$"),
    ]),
    "flat-table",
  );
  const tables = doc.pages[0]!.blocks.filter((b) => b.kind === "table");
  assert.equal(tables.length, 1, "应产出一个表格块");
  const rows = cellsOf((tables[0] as { html: string }).html);
  // 4 个原始块 → **3 个表格行**：第 2 块是无 `|` 的续行，并进第 1 行而非单独成行
  assert.equal(rows.length, 4, "5 个原始块 → 4 行（续行不单独占一行）");
  assert.deepEqual(rows[0]!.slice(0, 2), ["欧姆定律(纯电阻电路)", "电流的三个表达式"]);
  assert.match(rows[0]![2]!, /^\(1\)\$I=q\/t\$\(定义式\)/, "第 3 列以 (1) 开头");
  assert.match(rows[0]![2]!, /微观决定式/, "续行应并入上一行第 3 列");
  assert.deepEqual(rows[1], ["伏安特性曲线(如图所示)", "", ""], "末段为空 ⇒ 归列 1");
  assert.deepEqual(
    rows[2],
    ["电阻定律", "表达式", "$R=\\rho l/S$(决定式)"],
    "三段直接对齐列 1/2/3",
  );
  assert.deepEqual(rows[3], ["", "定义式", "$R=U/I$"], "末段非空 ⇒ 归列 2/列 3");
});

test("压平表格行：还原出的表格块 bbox 覆盖整组", () => {
  const doc = normalizeLayout(
    mkLayout([
      tableRow(638, "A | B | C"),
      tableRow(737, "D | E | F"),
      tableRow(836, "G | H | I"),
    ]),
    "flat-table",
  );
  const t = doc.pages[0]!.blocks.find((b) => b.kind === "table") as
    | { bbox: number[]; text: string }
    | undefined;
  assert.ok(t, "应有表格块");
  assert.deepEqual(t!.bbox.map(Math.round), [73, 638, 73 + 1848, 836 + 62]);
});

// ⚠️ 最危险的误伤：单栏正文行天然「x0 一致 + 宽度一致 + 相邻」，若判据只看相邻，
// 整页正文会被并成一张表（门禁抓不到，但页面全毁）。
test("不动单栏正文：宽度不到页宽 60% 的连续行不合并", () => {
  const doc = normalizeLayout(
    mkLayout([
      { text: "A | B | C", bbox: [72, 638, 72 + 1000, 700] },
      { text: "D | E | F", bbox: [72, 737, 72 + 1000, 799] },
      { text: "G | H | I", bbox: [72, 836, 72 + 1000, 898] },
    ]),
    "narrow",
  );
  assert.equal(doc.pages[0]!.blocks.filter((b) => b.kind === "table").length, 0);
  assert.equal(doc.pages[0]!.blocks.length, 3, "三行应原样保留");
});

test("不动零散行：不足 3 行的组不合并", () => {
  const doc = normalizeLayout(
    mkLayout([tableRow(638, "A | B | C"), tableRow(737, "D | E | F")]),
    "too-short",
  );
  assert.equal(doc.pages[0]!.blocks.filter((b) => b.kind === "table").length, 0);
});

test("不动跨段：行距超过 1.2 倍行高即断组", () => {
  const doc = normalizeLayout(
    mkLayout([
      tableRow(638, "A | B | C"),
      tableRow(737, "D | E | F"),
      tableRow(1200, "G | H | I"), // 与上一行隔了 400pt，不是同一张表
    ]),
    "gap",
  );
  assert.equal(doc.pages[0]!.blocks.filter((b) => b.kind === "table").length, 0);
});
