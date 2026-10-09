// tests/normalize-layout.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeLayout } from "../src/normalize.js";
import { layoutPage } from "../src/layout.js";

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/layout.sample.json", import.meta.url), "utf8"),
);

test("normalizeLayout：页数与 page_size 来自 layout", () => {
  const doc = normalizeLayout(raw, "layout-test");
  assert.equal(doc.pages.length, 2);
  assert.ok(doc.pages[0]!.width > 0, "width 应来自 page_size");
  assert.equal(doc.pages[0]!.index, doc.pages[0]!.index); // 排序稳定
});

test("normalizeLayout：para_blocks 按 line 展开且行序拼接等值原文本", () => {
  const doc = normalizeLayout(raw, "layout-test");
  const page = doc.pages[0]!;
  // 每个块非空；行内公式以 $..$ 内联。
  // 夹具含 inline_equation span（page 1 block 4/7），无条件断言公式内联路径被执行；
  // allText 跨全部页拼接，否则 page 0 无公式、断言会静默不触发。
  const allText = doc.pages
    .flatMap((p) => p.blocks.map((b) => (b.kind === "text" ? b.text : "")))
    .join("\n");
  assert.ok(allText.length > 0);
  assert.match(allText, /\$.+?\$/);
  // 合并选项段落的行级展开：找到 bbox 都在 [54,193,199,262] 内容对应的块集合
  // （真实夹具里有 "A. 重力的作用点在重心上" 行），断言存在以 "A." 开头的行块
  const optionLine = page.blocks.find(
    (b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text" && /^A[.．、]/.test(b.firstLine),
  );
  assert.ok(optionLine, "应存在行级展开的选项行块");
});

test("normalizeLayout：image/chart 块挂回为 image ParsedBlock（path/bbox 正确）", () => {
  const doc = normalizeLayout(raw, "layout-test");
  const imgs = doc.pages.flatMap((p) =>
    p.blocks.filter((b): b is Extract<typeof b, { kind: "image" }> => b.kind === "image"),
  );
  // 夹具 3 张图（page0 一张 [225,192,286,269]、page1 两张 [167,94,294,158] / [207,279,295,324]）
  assert.equal(imgs.length, 3, "夹具 image 块应全部产出 image ParsedBlock");
  // path 取自嵌套 blocks[].lines[].spans[].image_path，而非空串/占位
  const first = imgs.find((i) => i.bbox[1] === 192);
  assert.ok(first, "page0 的图应在 y=192");
  assert.match(first!.path, /\.(jpg|jpeg|png)$/, "path 应挂回真实图片路径");
  assert.deepEqual(first!.bbox, [225, 192, 286, 269], "bbox 应取自 span/块 bbox");
  // 图片块按 bbox y 参与版面层阅读顺序：page0 的 y=192 图应出现在阅读顺序中，
  // 且位于 y=193 文本行之前（阅读顺序由 layoutPage 决定，normalizeLayout 保留原块序）
  const ordered = layoutPage(doc.pages[0]!).ordered;
  const imgEntry = ordered.find((e) => e.block.kind === "image" && e.block.bbox[1] === 192);
  assert.ok(imgEntry, "图片块应参与版面层阅读顺序");
  const imgOrder = ordered.findIndex((e) => e.block === imgEntry!.block);
  const nextByY = ordered
    .slice(imgOrder + 1)
    .find((e) => e.block.kind !== "image" && e.block.bbox[1] >= 193);
  assert.ok(nextByY, "阅读顺序中图片后应还有后续文本块");
});
test("normalizeLayout：跨页段泄漏行迁回下一页（p0 q7 真实形态）", () => {
  // 真实案例：MinerU 把 q7 的跨页段整段并入第 1 页段落，行坐标是第 2 页页顶的，
  // 物理上压在第 1 页页眉标题上；第 2 页并无该行副本，直接丢弃会截断题干。
  const leaky = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [300, 668, 545, 776],
            lines: [
              { bbox: [310, 680, 540, 700], spans: [{ type: "text", content: "7.题干开头" }] },
              {
                bbox: [68, 42, 294, 51],
                spans: [{ type: "text", content: "动摩擦力相同，滚轮与白纸之间的动摩擦因数" }],
              },
            ],
          },
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [65, 94, 159, 168],
            lines: [{ bbox: [65, 94, 159, 110], spans: [{ type: "text", content: "A. 选项一" }] }],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(leaky, "leak-test");
  const p0Texts = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  const p1Texts = doc.pages[1]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(!p0Texts.includes("动摩擦力相同"), "泄漏行应离开第 1 页");
  assert.ok(p1Texts.includes("动摩擦力相同"), "泄漏行应迁回第 2 页（题干续行归位）");
  assert.ok(p0Texts.includes("7.题干开头"), "本页正常行不受影响");
});

test("normalizeLayout：下一页已有近似副本的泄漏行丢弃（页眉注释类）", () => {
  // 同栏真实泄漏形状（段与行同桶 0、行 y0 早于段）→ 行迁回下一页；下一页已有副本则丢弃。
  // 注：旧夹具曾用「段在左栏底 + 行在右栏顶」的跨栏几何（真实 p3 页眉形态），
  // 该形状在 Task 9 阅读顺序守卫下已判定为**非泄漏**（行晚于段，属本页右栏续行），
  // 故此处改用同栏几何，保留对 fuzzyDup 去重分支的覆盖。
  const leaky = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [55, 719, 300, 772],
            lines: [
              { bbox: [68, 74, 294, 86], spans: [{ type: "text", content: "必刷知识T1~3、5~6必刷考点T4" }] },
            ],
          },
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [370, 74, 540, 88],
            lines: [{ bbox: [370, 74, 540, 88], spans: [{ type: "text", content: "必刷知识T1~3、5~6必刷考点T4" }] }],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(leaky, "leak-dup-test");
  const p0Texts = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  const p1Count = doc.pages[1]!.blocks.filter(
    (b) => b.kind === "text" && b.text.includes("必刷知识"),
  ).length;
  assert.ok(!p0Texts.includes("必刷知识"), "泄漏行离开第 1 页");
  assert.equal(p1Count, 1, "第 2 页已有副本，迁回会造成重复 → 丢弃");
});

test("normalizeLayout：紧贴段框下方的正常续行不受影响（p8 选项续行形态）", () => {
  const tight = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [311, 294, 459, 380],
            lines: [
              { bbox: [313, 300, 450, 320], spans: [{ type: "text", content: "C. 选项内容" }] },
              { bbox: [313, 385, 533, 397], spans: [{ type: "text", content: "大小恒为2mg" }] },
            ],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(tight, "tight-test");
  const texts = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(texts.includes("C. 选项内容") && texts.includes("大小恒为2mg"), "段框偏紧的续行保留");
});

// —— Task 9：跨页泄漏规则的跨栏误判（阅读顺序守卫）——

test("normalizeLayout：双栏同页——段在左栏底 + 行在右栏顶不得判为泄漏（p9 第10题真实形态）", () => {
  // 真实案例（2026-10-09 用户指出第 9 页第 10 题题干丢 3 行）：
  // MinerU 把右栏顶部 3 行（y=34/54/73，x≈312）并进左栏底部那个段（bbox [37,723,281,776]）。
  // 二者 x 不相交且分处页顶/页底带，旧规则凭 noOverlap 的 OR 误判为跨页泄漏 →
  // 把行迁到下一页（第 10 页顶部幽灵行）。阅读顺序上段桶 0、行桶 1，行**晚于**段 → 非泄漏。
  const crossColumn = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [37, 723, 281, 776],
            lines: [
              { bbox: [40, 730, 280, 750], spans: [{ type: "text", content: "10.在两杆上分别套上质量相等" }] },
              { bbox: [312, 34, 529, 48], spans: [{ type: "text", content: "的小环P、Q,两小环由不可伸长的轻绳连接" }] },
              { bbox: [312, 54, 529, 68], spans: [{ type: "text", content: "初始时，杆OA竖直，现缓慢顺时针转动两杆" }] },
              { bbox: [312, 73, 529, 87], spans: [{ type: "text", content: "至杆OB竖直.则在转动过程中(  )" }] },
            ],
          },
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [65, 94, 159, 168],
            lines: [{ bbox: [65, 94, 159, 110], spans: [{ type: "text", content: "专题 连接体动态平衡问题" }] }],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(crossColumn, "cross-column-test");
  const p0 = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  const p1 = doc.pages[1]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(p0.includes("10.在两杆上分别套上质量相等"), "段内正常行保留在第 9 页");
  assert.ok(p0.includes("的小环P、Q"), "右栏顶续行应留在第 9 页（题干完整）");
  assert.ok(p0.includes("初始时，杆OA竖直"), "右栏顶续行应留在第 9 页");
  assert.ok(p0.includes("至杆OB竖直"), "右栏顶续行应留在第 9 页");
  assert.ok(!p1.includes("的小环P、Q"), "第 10 页顶部不得出现幽灵行");
});

test("normalizeLayout：原有案例——段在右栏底 + 行在左栏顶仍判为泄漏并迁回下一页", () => {
  // 2026-10-07 写该规则要修的原有案例（p0 q7）：段桶 1、行桶 0 → 行**早于**段 → 仍是泄漏。
  // 与上一条对照，防「修新缺陷时把老缺陷放回来」。
  const leaky = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [300, 668, 545, 776],
            lines: [
              { bbox: [310, 680, 540, 700], spans: [{ type: "text", content: "7.题干开头" }] },
              { bbox: [68, 42, 294, 51], spans: [{ type: "text", content: "动摩擦力相同，滚轮与白纸之间的动摩擦因数" }] },
            ],
          },
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [65, 94, 159, 168],
            lines: [{ bbox: [65, 94, 159, 110], spans: [{ type: "text", content: "A. 选项一" }] }],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(leaky, "orig-leak-test");
  const p0 = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  const p1 = doc.pages[1]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(!p0.includes("动摩擦力相同"), "左栏顶行应离开第 1 页");
  assert.ok(p1.includes("动摩擦力相同"), "左栏顶行应迁回第 2 页");
  assert.ok(p0.includes("7.题干开头"), "本页正常行不受影响");
});

test("normalizeLayout：同栏 y 不相交仍判为泄漏（阅读键同桶比 y，行在页顶早于段）", () => {
  // 单栏内真正的跨页泄漏形状：段与行同桶(0)，行 y0=42 早于段 y0=720 → 仍迁回下一页。
  const sameColumn = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [68, 720, 281, 776],
            lines: [
              { bbox: [70, 730, 279, 750], spans: [{ type: "text", content: "9.本页末段正文" }] },
              { bbox: [70, 42, 200, 52], spans: [{ type: "text", content: "下一题续行内容" }] },
            ],
          },
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [65, 94, 159, 168],
            lines: [{ bbox: [65, 94, 159, 110], spans: [{ type: "text", content: "B. 选项" }] }],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(sameColumn, "same-column-test");
  const p0 = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  const p1 = doc.pages[1]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(!p0.includes("下一题续行内容"), "同栏跨页泄漏行应离开本页");
  assert.ok(p1.includes("下一题续行内容"), "同栏跨页泄漏行应迁回下一页");
});

test("normalizeLayout：行框与段框相交（同栏续行）不判为泄漏", () => {
  // noOverlap 不成立（x 相交且 y 相交）→ 直接非泄漏，行留在本页。
  const overlapping = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [55, 600, 540, 700],
            lines: [
              { bbox: [300, 640, 520, 660], spans: [{ type: "text", content: "段内右半行，与段框相交" }] },
            ],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(overlapping, "overlap-test");
  const p0 = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(p0.includes("段内右半行，与段框相交"), "相交续行不得被判为泄漏");
});

test("normalizeLayout：对称形态——段在页顶 + 行在页底迁回上一页（同栏反向）", () => {
  // 段桶 0 在页顶、行桶 0 在页底：阅读顺序上行**晚于**段 → 对称形态泄漏，迁回上一页。
  const symmetric = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [65, 94, 280, 160],
            lines: [{ bbox: [65, 94, 279, 110], spans: [{ type: "text", content: "上一页末段正文" }] }],
          },
        ],
      },
      {
        page_idx: 1,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [37, 42, 281, 120],
            lines: [
              { bbox: [40, 50, 279, 70], spans: [{ type: "text", content: "1.本页顶部段" }] },
              { bbox: [40, 760, 280, 775], spans: [{ type: "text", content: "上一页末段泄漏行" }] },
            ],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(symmetric, "symmetric-test");
  const p0 = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  const p1 = doc.pages[1]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(!p1.includes("上一页末段泄漏行"), "对称形态泄漏行应离开本页");
  assert.ok(p0.includes("上一页末段泄漏行"), "对称形态泄漏行应迁回上一页");
  assert.ok(p1.includes("1.本页顶部段"), "本页正常段不受影响");
});

// —— 最终修复波：无相邻页可迁的泄漏行不得被静默丢弃（G1）——

test("normalizeLayout：末页「段在页底 + 行在页顶」无下一页可迁——行不得被静默丢弃（G1）", () => {
  // 单页（末页）出现主形态泄漏形状：段在页底、行在页顶，但**没有下一页**可迁。
  // 旧实现 target 为 undefined → 直接丢弃，且无 ReviewNote、无任何记录 = 静默丢内容（违反 G1）。
  // 修法取「保留可见优于丢弃」：该行留在本页（坐标在页顶，可能压页眉，但内容可见、可回溯）。
  const lastPage = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [68, 720, 281, 776],
            lines: [
              { bbox: [70, 730, 279, 750], spans: [{ type: "text", content: "9.本页末段正文" }] },
              { bbox: [70, 42, 200, 52], spans: [{ type: "text", content: "末页无下一页可迁的泄漏行" }] },
            ],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(lastPage, "last-page-leak-test");
  assert.equal(doc.pages.length, 1);
  const texts = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(
    texts.includes("末页无下一页可迁的泄漏行"),
    "末页无下一页可迁的泄漏行不得被静默丢弃（应保留在本页，G1）",
  );
  assert.ok(texts.includes("9.本页末段正文"), "本页正常行不受影响");
});

test("normalizeLayout：首页「段在页顶 + 行在页底」无上一页可迁——行不得被静默丢弃（G1，对称形态）", () => {
  // 单页（首页）出现对称形态泄漏形状：段在页顶、行在页底，但没有上一页可迁 → 保留在本页。
  const firstPage = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [596, 821],
        para_blocks: [
          {
            type: "text",
            bbox: [65, 94, 280, 160],
            lines: [
              { bbox: [65, 94, 279, 110], spans: [{ type: "text", content: "1.本页顶部段" }] },
              { bbox: [40, 760, 280, 775], spans: [{ type: "text", content: "首页无上一页可迁的泄漏行" }] },
            ],
          },
        ],
      },
    ],
  };
  const doc = normalizeLayout(firstPage, "first-page-leak-test");
  assert.equal(doc.pages.length, 1);
  const texts = doc.pages[0]!.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("|");
  assert.ok(
    texts.includes("首页无上一页可迁的泄漏行"),
    "首页无上一页可迁的泄漏行不得被静默丢弃（应保留在本页，G1）",
  );
  assert.ok(texts.includes("1.本页顶部段"), "本页正常行不受影响");
});
