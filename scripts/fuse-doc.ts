// scripts/fuse-doc.ts —— 两源融合落盘（MinerU 几何 + OXR 文本）。
//
// 用法：
//   tsx scripts/fuse-doc.ts <docId> [--mineru <dir>] [--oxr <dir>] [--no-export] [--no-meta]
// 默认：OXR 目录 data/out/<docId>，MinerU 目录 data/out/<docId>-MinerU。
//
// 行为：
// 1. 读两源 layout.json → fuseDocuments；
// 2. 备份 OXR layout 为 layout.oxr.json（只备份一次），写回融合后的 layout.json；
//    把 MinerU images 复制进 OXR 目录（融合块的图片路径来自 MinerU）；
// 3. 写 fuse.json（统计/来源/时间，可审计）；
// 4. 默认重导快照 + 刷新 meta（parser=fuse）。
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fuseDocuments } from "../src/fuse.js";
import { normalizeLayout } from "../src/normalize.js";
import type { ParsedBlock, ParsedDocument } from "../src/types.js";

const args = process.argv.slice(2);
const docId = args[0] ?? "";
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!docId) {
  console.error("用法：tsx scripts/fuse-doc.ts <docId> [--mineru <dir>] [--oxr <dir>] [--no-export] [--no-meta]");
  process.exit(2);
}
const oxrDir = resolve(flag("--oxr") ?? join("data", "out", docId));
const mineruDir = resolve(flag("--mineru") ?? join("data", "out", `${docId}-MinerU`));
const backup = join(oxrDir, "layout.oxr.json");
const oxrLayout = existsSync(backup) ? backup : join(oxrDir, "layout.json");
const mineruLayout = join(mineruDir, "layout.json");
if (!existsSync(oxrLayout) || !existsSync(mineruLayout)) {
  console.error(`缺 layout：\n  OXR ${oxrLayout}\n  MinerU ${mineruLayout}`);
  process.exit(2);
}

const oxr = normalizeLayout(JSON.parse(readFileSync(oxrLayout, "utf8")), docId);
const mineru = normalizeLayout(JSON.parse(readFileSync(mineruLayout, "utf8")), `${docId}-MinerU`);
const fused = fuseDocuments(mineru, oxr);

function rawBlock(b: ParsedBlock): Record<string, unknown> {
  if (b.kind === "image") {
    return { type: "image", bbox: b.bbox, blocks: [{ lines: [{ spans: [{ image_path: b.path }] }] }] };
  }
  const fontSize = b.kind === "text" ? b.maxFontSize || 10 : 10;
  const content = b.kind === "formula" ? `$${b.latex}$` : b.text;
  return {
    type: b.kind === "table" ? "table" : "text",
    bbox: b.bbox,
    lines: [{ bbox: b.bbox, font_size: fontSize, spans: [{ content, font_size: fontSize }] }],
  };
}

const raw = {
  pdf_info: fused.doc.pages.map((p) => ({
    page_idx: p.index,
    page_size: [p.width, p.height],
    para_blocks: p.blocks.map(rawBlock),
  })),
};

if (!existsSync(backup)) copyFileSync(oxrLayout, backup);
writeFileSync(oxrLayout, JSON.stringify(raw, null, 1));

if (existsSync(join(mineruDir, "images"))) {
  mkdirSync(join(oxrDir, "images"), { recursive: true });
  cpSync(join(mineruDir, "images"), join(oxrDir, "images"), { recursive: true });
}

writeFileSync(
  join(oxrDir, "fuse.json"),
  JSON.stringify(
    {
      docId,
      generatedAt: new Date().toISOString(),
      mineruLayout,
      oxrLayout: backup,
      stats: fused.stats,
    },
    null,
    2,
  ),
);
console.log(
  `✓ 融合 ${docId}：页 ${fused.stats.pages} · 对齐 ${fused.stats.matched} · 改文 ${fused.stats.textChanged}` +
    ` · OXR独有 ${fused.stats.oxrOnly} · MinerU独有 ${fused.stats.mineruOnly} · 低覆盖 ${fused.stats.lowCoverage}`,
);

if (!args.includes("--no-export")) {
  execFileSync(process.execPath, ["--import", "tsx", join("scripts", "export-stages.ts"), docId, oxrLayout], {
    stdio: "inherit",
  });
}
if (!args.includes("--no-meta")) {
  const origin = [join(oxrDir, `${docId}_origin.pdf`), join(oxrDir, "origin.pdf")].find((p) => existsSync(p));
  if (origin) {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join("scripts", "daily.ts"), origin, "--id", docId, "--meta-only"],
      { stdio: "inherit" },
    );
  } else {
    console.warn("⚠️ 没找到 origin.pdf；跳过 meta 刷新");
  }
}
