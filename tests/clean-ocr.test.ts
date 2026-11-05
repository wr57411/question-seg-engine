// tests/clean-ocr.test.ts —— B-33：OCR 清洗不得误删正文（不等式 `<` 曾被当 HTML 标签起点）
// 事故与量化证据：docs/BACKLOG.md B-33、docs/evidence/2026-11-04-识别链路与OCR工具盘点.md §8.1
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOcr, cleanOcrLines, HTML_TAG_RE, KNOWN_HTML_TAGS, readToken } from "../scripts/ocr-lib.js";
import { stripMarkup } from "../scripts/paddle-line-align.js";

// ── B-33 当初要修的案例（2026-11-04 A3′ 探针实测 240 字符 / 16 处中文误删） ──

test("cleanOcr：不等式 `<` 不再被当标签起点，正文一字不丢", () => {
  const s = "当 $ r<R $ 时电源输出功率最大，且 $ x>0 $";
  const out = cleanOcr(s);
  assert.ok(out.includes("时电源输出功率最大"), `正文被误删: ${out}`);
  assert.ok(out.includes("$ x>0 $"), `右侧不等式被误删: ${out}`);
  assert.ok(out.includes("$ r<R $"), `左侧不等式被改写: ${out}`);
});

test("cleanOcrLines：双不等式夹正文（真实事故形态）不丢字", () => {
  const s = "闭合开关后，将滑动变阻器 $ R_P<\\cdots $ 移到最左端，下列说法正确的是 $ (x>0) $ 结束";
  const out = cleanOcrLines(s);
  for (const frag of ["闭合开关后，将滑动变阻器", "移到最左端，下列说法正确的是", "结束"]) {
    assert.ok(out.includes(frag), `「${frag}」被误删，输出: ${out}`);
  }
});

test("cleanOcr：不等式 + 同段真表格（mcp-vl.md 实测事故形态）正文找回", () => {
  // 真实事故样本的最小复现：`$ r<R $` 之后跟着 <table>
  const s = "如图 $ r<R $ 所示 <table><tr><td>1</td></tr></table> 求电流";
  const out = cleanOcr(s);
  assert.ok(out.includes("所示"), `「所示」被误删: ${out}`);
  assert.ok(out.includes("求电流"), `「求电流」被误删: ${out}`);
  assert.ok(!/<table>/i.test(out), "表格标签应被剥掉");
});

// ── 老案例回归（L2：它当初要修的案例仍成立） ──

test("老案例仍成立：HTML 标签照常剥离、内容保留", () => {
  const s = "<p>欧姆定律</p> <table><tr><td rowspan=\"2\">1</td><td>2</td></tr></table> 完";
  const out = cleanOcr(s);
  assert.ok(out.includes("欧姆定律"), `标签内容被误删: ${out}`);
  assert.ok(out.includes("1") && out.includes("2"), "表格单元格内容保留");
  assert.ok(!/<(?:p|table|tr|td)\b/i.test(out), "标签应被剥掉");
});

test("老案例仍成立：div 整块仍被删（原判据语义保留）", () => {
  const s = "前文 <div class=\"x\">整个 div 块</div> 后文";
  const out = cleanOcr(s);
  assert.ok(!out.includes("整个 div 块"), "div 块应整删");
  assert.ok(out.includes("前文") && out.includes("后文"));
});

test("老案例仍成立：图片占位符仍被剥", () => {
  const s = "题干 ![图](img_1.jpg) 续行";
  const out = cleanOcr(s);
  assert.ok(out.includes("题干") && out.includes("续行"));
  assert.ok(!out.includes("img_1"), "占位符应被剥掉");
});

test("cleanOcrLines 保留换行（整页切段依赖它）", () => {
  const s = "第一行\n第二行\n\n第三行";
  assert.equal(cleanOcrLines(s), "第一行\n第二行\n第三行");
});

// ── 设计意图锁：白名单外「疑似标签」宁可残留，不误删 ──

test("白名单外的疑似标签保留原文（宁残留不误删）", () => {
  const s = "当 $ r<R $ 或 $ P_{出}>P_{内} $ 时……";
  const out = cleanOcr(s);
  assert.ok(out.includes("时……"), "正文不丢");
  // `<R` 不是已知标签名 ⇒ 不得被吃
  assert.ok(out.includes("$ r<R $"), "不等式原样保留");
});

test("KNOWN_HTML_TAGS / HTML_TAG_RE 自检：正则不含通配 <[^>]", () => {
  assert.ok(!HTML_TAG_RE.source.includes("[^>]") || HTML_TAG_RE.source.includes("\\b[^>]*>"), 
    "正则必须是白名单形（含 \\b 词边界），不能是任意通配");
  assert.ok(KNOWN_HTML_TAGS.includes("table"), "核心标签必须在白名单");
});

// ── stripMarkup（paddle-line-align.ts）同源修复 ──

test("stripMarkup：不等式不丢、老案例（表格标签剥）仍成立", () => {
  assert.ok(stripMarkup("$ r<R $ 时").includes("R"), "B-33 修复案例");
  const html = "<table><tr><td>欧姆定律</td><td>1</td></tr></table>";
  assert.equal(stripMarkup(html).replace(/\s+/g, ""), "欧姆定律1", "老案例：标签剥、内容留");
});