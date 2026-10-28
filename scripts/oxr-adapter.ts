/**
 * oxr-adapter.ts —— CLI 薄壳：OXR 响应 JSON → MinerU 同构 layout.json
 *
 * 转换逻辑全在 `oxr-convert.ts`（`npm run daily -- <pdf> --parser oxr` 复用同一套，
 * 避免「CLI 一份、daily 一份」两处漂移）。这里只负责读 argv、落盘、打印统计。
 *
 * 用法：tsx scripts/oxr-adapter.ts <response.json> <docId> [--out <layout.json>] [--no-images]
 *   例：tsx scripts/oxr-adapter.ts data/oxr/book-response.json "23必刷题 2相互作用-OXR"
 *   输出 layout 默认 data/oxr/<docId>-as-layout.json；图片落到 data/out/<docId>/images/
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { convertOxrResponse, type OxrResponse } from "./oxr-convert.js";

const args = process.argv.slice(2);
const responsePath = args[0] ?? "";
const docId = args[1] ?? "";
const noImages = args.includes("--no-images");
const outIdx = args.indexOf("--out");
const outPath = (outIdx >= 0 ? args[outIdx + 1] : undefined) ?? `data/oxr/${docId}-as-layout.json`;

if (!responsePath || !docId) {
  console.error("用法：tsx scripts/oxr-adapter.ts <response.json> <docId> [--out <layout.json>] [--no-images]");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(responsePath, "utf8")) as OxrResponse;
const { layout, stats } = await convertOxrResponse(raw, {
  docId,
  outDir: join("data", "out", docId),
  noImages,
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(layout, null, 1));

console.log(`✓ ${outPath}`);
console.log(`  页 ${stats.pages} · 块 ${stats.blocks}（图片 ${stats.imageBlocks}）· 行 ${stats.lines}`);
if (!noImages) {
  console.log(`  图片落盘 data/out/${docId}/images：成功 ${stats.imageOk} / 失败 ${stats.imageFail}`);
  if (stats.imageFail > 0) {
    console.log(`  ⚠️ ${stats.imageFail} 张下载失败 ⇒ 页面显示为破图（不静默：不是空白）`);
  }
}
console.log(`  字号反推 p10/p50/p90 = ${stats.fontSize.p10} / ${stats.fontSize.p50} / ${stats.fontSize.p90} pt`);
