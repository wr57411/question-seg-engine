// corrections-split.test.ts —— 修正层 `split`（拆块）的行为回归（`§101`）。
//
// 为什么需要这个类型：上游把「上一题的知识点末段」与「下一题的题号」粘在**同一行**，
// 切题只看块首行 ⇒ 题号在行中等于不存在，整题不入库（《电路》p5#1 红线级）。
// `replace_text` 只能改文本，改了题号仍在行中；必须真把块拆成两个。
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCorrections, type CorrectionFile } from "../src/corrections.js";
import { normalizeLayout } from "../src/normalize.js";

const GLUED =
  "②当$P_{出}<P_{max}$时，每个输出功率对应的外电阻阻值有两个取值$R_{1}$和$R_{2}$，且$R_{1}R_{2}=r^{2}$" +
  "1[多选][鲁科版必修三P133第10题模型变式]如图,三个电阻的阻值均为R,电源的内阻r<R";

function docWith(texts: string[]) {
  return normalizeLayout(
    {
      pdf_info: [
        {
          page_idx: 0,
          page_size: [596, 852],
          para_blocks: texts.map((t, i) => ({
            type: "text",
            bbox: [20, 100 + i * 40, 500, 120 + i * 40],
            lines: [{ bbox: [20, 100 + i * 40, 500, 120 + i * 40], spans: [{ content: t }] }],
          })),
        },
      ],
    },
    "t",
  );
}

const file = (items: unknown[]): CorrectionFile =>
  ({ docId: "t", items } as unknown as CorrectionFile);

const texts = (doc: ReturnType<typeof docWith>) =>
  doc.pages[0]!.blocks.map((b) => ("text" in b ? b.text : ""));

test("split：把粘在同一行的题号拆成独立块，题号落到第二块块首", () => {
  const doc = docWith([GLUED, "下一段文字"]);
  const rep = applyCorrections(
    doc,
    file([{ page: 1, kind: "split", blockText: GLUED, splitAt: "1[多选][鲁科版必修三P133第10题模型变式]" }]),
  );
  assert.equal(rep.split, 1);
  assert.deepEqual(rep.missed, []);
  const t = texts(doc);
  assert.equal(t.length, 3, "应拆成 3 块");
  assert.equal(t[0]!.endsWith("$R_{1}R_{2}=r^{2}$"), true, t[0] ?? "");
  assert.equal(t[1]!.startsWith("1[多选][鲁科版"), true, t[1] ?? "");
  assert.equal(t[2], "下一段文字", "原有后续块不得被打乱");
});

test("split：标记在开头（等于没切）⇒ 记 missed，不产生空块", () => {
  const doc = docWith([GLUED]);
  const rep = applyCorrections(
    doc,
    file([{ page: 1, kind: "split", blockText: GLUED, splitAt: "②当$P_{出}" }]),
  );
  assert.equal(rep.split, 0);
  assert.deepEqual(rep.missed, [0]);
  assert.equal(texts(doc).length, 1);
});

test("split：blockText 不匹配（清单过期）⇒ missed，不静默", () => {
  const doc = docWith([GLUED]);
  const rep = applyCorrections(
    doc,
    file([{ page: 1, kind: "split", blockText: "不存在的块文本", splitAt: "1[多选]" }]),
  );
  assert.equal(rep.split, 0);
  assert.deepEqual(rep.missed, [0]);
});

test("split：缺 splitAt ⇒ missed", () => {
  const doc = docWith([GLUED]);
  const rep = applyCorrections(doc, file([{ page: 1, kind: "split", blockText: GLUED }]));
  assert.deepEqual(rep.missed, [0]);
  assert.equal(texts(doc).length, 1);
});

test("split：verify=false 计 unverified（未回原卷核对必须可见）", () => {
  const doc = docWith([GLUED]);
  const rep = applyCorrections(
    doc,
    file([{ page: 1, kind: "split", blockText: GLUED, splitAt: "1[多选]" }]),
  );
  assert.equal(rep.split, 1);
  assert.deepEqual(rep.unverified, [0]);
});
