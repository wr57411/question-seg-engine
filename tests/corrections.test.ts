// corrections.test.ts —— 修正清单的结构/计数/命中校验，以及 `verified:false` 的显式计数。
//
// 背景（DECISIONS §48）：清单里允许存在未逐条回原卷核对的正文补行（verified:false），
// 它们仍会被应用，但必须记入 ApplyReport.unverified，不能当成“已核对”。
// 本测试同时锁住：8 卷清单的 docId/counts/字段结构；有 data 时干跑 0 未命中。
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyCorrections, type CorrectionFile } from "../src/corrections.js";
import { normalizeLayout } from "../src/normalize.js";
import type { ParsedDocument } from "../src/types.js";

function makeDoc(): ParsedDocument {
  return {
    docId: "t",
    pages: [
      {
        index: 0,
        width: 600,
        height: 800,
        blocks: [
          { kind: "text", bbox: [10, 10, 200, 25], text: "对0点受力分析", firstLine: "对0点受力分析", lineCount: 1, maxFontSize: 0 },
          { kind: "image", bbox: [10, 300, 100, 400], path: "img.png" },
        ],
      },
    ],
  };
}

const replace = (verified: boolean): CorrectionFile => ({
  docId: "t",
  items: [{ page: 1, kind: "replace", blockText: "对0点受力分析", verified }],
});

test("applyCorrections：replace 命中后 verified:true 不进 unverified", () => {
  const doc = makeDoc();
  const rep = applyCorrections(doc, replace(true));
  assert.equal(rep.replace, 1);
  assert.deepEqual(rep.missed, []);
  assert.deepEqual(rep.unverified, []);
  const b = doc.pages[0]!.blocks[0]!;
  assert.equal(b.kind, "text");
  if (b.kind === "text") assert.equal(b.text, "对O点受力分析");
});

test("applyCorrections：verified:false 仍应用，但必须计入 unverified", () => {
  const doc = makeDoc();
  const rep = applyCorrections(doc, replace(false));
  assert.equal(rep.replace, 1);
  assert.deepEqual(rep.unverified, [0]);
});

test("applyCorrections：replace_text 精确替换半行为完整行", () => {
  const half = "1 \\mathrm { \\ m } / \\mathrm { \\ s } ^ { 2 } \\quad ( 2 ) 5 \\mathrm { \\ m } \\quad ( 3 )";
  const full = "3. (1) 1 \\mathrm { \\ m } / \\mathrm { \\ s } ^ { 2 } \\quad ( 2 ) 5 \\mathrm { \\ m } \\quad ( 3 ) 不能相撞 2.4 \\mathrm { \\ m }";
  const doc: ParsedDocument = {
    docId: "t",
    pages: [{ index: 0, width: 600, height: 800, blocks: [{ kind: "text", bbox: [10, 10, 300, 25], text: half, firstLine: half, lineCount: 1, maxFontSize: 0 }] }],
  };
  const rep = applyCorrections(doc, {
    docId: "t",
    items: [{ page: 1, kind: "replace_text", blockText: half, to: full, verified: true }],
  });
  assert.equal(rep.replaceText, 1);
  assert.equal(rep.replace, 0);
  assert.deepEqual(rep.missed, []);
  assert.deepEqual(rep.unverified, []);
  const b = doc.pages[0]!.blocks[0]!;
  assert.equal(b.kind, "text");
  if (b.kind === "text") {
    assert.equal(b.text, full);
    assert.ok(b.firstLine.startsWith("3. (1)"));
  }
});

test("applyCorrections：replace_text 未命中进 missed，verified:false 计入 unverified", () => {
  const doc: ParsedDocument = {
    docId: "t",
    pages: [{ index: 0, width: 600, height: 800, blocks: [{ kind: "text", bbox: [10, 10, 300, 25], text: "半行", firstLine: "半行", lineCount: 1, maxFontSize: 0 }] }],
  };
  const miss = applyCorrections(doc, {
    docId: "t",
    items: [{ page: 1, kind: "replace_text", blockText: "不存在", to: "完整行", verified: false }],
  });
  assert.deepEqual(miss.missed, [0]);
  assert.equal(miss.replaceText, 0);
  assert.deepEqual(miss.unverified, []);
  const hit = applyCorrections(doc, {
    docId: "t",
    items: [{ page: 1, kind: "replace_text", blockText: "半行", to: "完整行", verified: false }],
  });
  assert.equal(hit.replaceText, 1);
  assert.deepEqual(hit.unverified, [0]);
});

test("applyCorrections：disabled 条目不应用、不计 missed/unverified", () => {
  const doc = makeDoc();
  const rep = applyCorrections(doc, {
    docId: "t",
    items: [{ page: 1, kind: "insert", text: "禁用的图注", bbox: [10, 100, 200, 115], source: "body-hole", verified: false, disabled: true, disabledReason: "逐页核对为重复" }],
  });
  assert.equal(rep.insert, 0);
  assert.deepEqual(rep.missed, []);
  assert.deepEqual(rep.unverified, []);
  assert.deepEqual(rep.disabled, [0]);
  assert.equal(doc.pages[0]!.blocks.length, 2);
});

test("applyCorrections：未命中的 replace 进 missed，不误报 unverified", () => {
  const rep = applyCorrections(makeDoc(), {
    docId: "t",
    items: [{ page: 1, kind: "replace", blockText: "不存在的原文", verified: false }],
  });
  assert.equal(rep.replace, 0);
  assert.deepEqual(rep.missed, [0]);
  assert.deepEqual(rep.unverified, []);
});

test("applyCorrections：body-hole insert 按 y 插入，verified:false 计入 unverified", () => {
  const doc = makeDoc();
  const rep = applyCorrections(doc, {
    docId: "t",
    items: [{ page: 1, kind: "insert", text: "补回正文行", bbox: [10, 100, 200, 115], source: "body-hole", verified: false }],
  });
  assert.equal(rep.insert, 1);
  assert.deepEqual(rep.missed, []);
  assert.deepEqual(rep.unverified, [0]);
  assert.equal(doc.pages[0]!.blocks.length, 3);
  assert.equal(doc.pages[0]!.blocks[1]!.kind, "text"); // 插在图片之前（阅读顺序）
});

test("applyCorrections：caption insert 跟在图片后，verified:true 不进 unverified", () => {
  const doc = makeDoc();
  const rep = applyCorrections(doc, {
    docId: "t",
    items: [{ page: 1, kind: "insert", text: "甲", bbox: [10, 410, 50, 425], source: "caption", verified: true }],
  });
  assert.equal(rep.insert, 1);
  assert.deepEqual(rep.unverified, []);
  assert.equal(doc.pages[0]!.blocks.at(-1)!.kind, "text");
});

interface Counts {
  replace?: number;
  replaceText?: number;
  insert?: number;
  bodyHole?: number;
  disabled?: number;
  total?: number;
}

/** 结构校验；反向验证见下一个 test（它必须能对坏数据抛错，否则这门是死门）。 */
function assertCorrectionFile(name: string, file: CorrectionFile & { counts?: Counts }) {
  assert.equal(file.docId, name.replace(/\.json$/, ""), `${name}: docId 与文件名不一致`);
  assert.ok(Array.isArray(file.items), `${name}: items 不是数组`);
  let replaceN = 0;
  let replaceTextN = 0;
  let insertN = 0;
  let bodyHoleN = 0;
  let unverifiedN = 0;
  let disabledN = 0;
  file.items.forEach((it, idx) => {
    const at = `${name} items[${idx}]`;
    assert.ok(Number.isInteger(it.page) && it.page >= 1, `${at}: page 非法`);
    assert.ok(
      it.kind === "replace" || it.kind === "replace_text" || it.kind === "insert",
      `${at}: kind 非法`,
    );
    assert.ok(it.verified === undefined || typeof it.verified === "boolean", `${at}: verified 必须是布尔或缺省`);
    assert.ok(it.disabled === undefined || typeof it.disabled === "boolean", `${at}: disabled 必须是布尔或缺省`);
    if (it.disabled === true) {
      disabledN++;
      assert.ok((it.disabledReason ?? "").length > 0, `${at}: disabled 缺 disabledReason`);
    } else if (it.verified !== true) {
      unverifiedN++;
    }
    if (it.kind === "replace") {
      replaceN++;
      assert.ok((it.blockText ?? "").length > 0, `${at}: replace 缺 blockText`);
      return;
    }
    if (it.kind === "replace_text") {
      replaceTextN++;
      assert.ok((it.blockText ?? "").length > 0, `${at}: replace_text 缺 blockText`);
      assert.ok((it.to ?? "").length > 0, `${at}: replace_text 缺 to`);
      return;
    }
    insertN++;
    if (it.source === "body-hole") bodyHoleN++;
    assert.ok(
      Array.isArray(it.bbox) && it.bbox.length >= 4 && it.bbox.every((n) => typeof n === "number" && Number.isFinite(n)),
      `${at}: insert 缺 4 元数值 bbox`,
    );
  });
  if (file.counts) {
    assert.equal(file.counts.total, file.items.length, `${name}: counts.total 与 items 数不一致`);
    assert.equal(file.counts.replace, replaceN, `${name}: counts.replace 不一致`);
    assert.equal(file.counts.replaceText ?? 0, replaceTextN, `${name}: counts.replaceText 不一致`);
    assert.equal(file.counts.insert, insertN, `${name}: counts.insert 不一致`);
    assert.equal(file.counts.disabled ?? 0, disabledN, `${name}: counts.disabled 不一致`);
    if (file.counts.bodyHole !== undefined) {
      assert.equal(file.counts.bodyHole, bodyHoleN, `${name}: counts.bodyHole 不一致`);
    }
  }
  return { replaceN, replaceTextN, insertN, bodyHoleN, unverifiedN, disabledN };
}

test("corrections/*.json：docId/counts/字段结构一致；有 data 时干跑 0 未命中", () => {
  const files = readdirSync("corrections").filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length > 0, "corrections/ 下没有清单");
  let total = 0;
  let unverified = 0;
  const missingLayout: string[] = [];
  for (const f of files) {
    const file = JSON.parse(readFileSync(join("corrections", f), "utf8")) as CorrectionFile & { counts?: Counts };
    const stats = assertCorrectionFile(f, file);
    total += file.items.length;
    unverified += stats.unverifiedN;

    const layoutPath = join("data", "out", file.docId, "layout.json");
    if (!existsSync(layoutPath)) {
      missingLayout.push(file.docId);
      continue;
    }
    const raw = JSON.parse(readFileSync(layoutPath, "utf8")) as unknown;
    const doc = normalizeLayout(raw, file.docId);
    const rep = applyCorrections(doc, file);
    assert.deepEqual(rep.missed, [], `${file.docId}: 有 ${rep.missed.length} 条修正未命中（清单可能过期）`);
  }
  console.log(
    `[corrections] ${files.length} 卷 / ${total} 条；未逐条核对 ${unverified} 条` +
      (missingLayout.length ? `；无 layout.json 跳过干跑：${missingLayout.join(", ")}` : ""),
  );
});

test("清单校验能识别坏数据（反向验证，防死门）", () => {
  const badInsert = { docId: "bad", items: [{ page: 1, kind: "insert", text: "x" }] } as unknown as CorrectionFile;
  assert.throws(() => assertCorrectionFile("bad.json", badInsert), /bbox/);
  const badReplace = { docId: "bad", items: [{ page: 1, kind: "replace" }] } as unknown as CorrectionFile;
  assert.throws(() => assertCorrectionFile("bad.json", badReplace), /blockText/);
});
