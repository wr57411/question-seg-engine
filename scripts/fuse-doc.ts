// scripts/fuse-doc.ts —— 两源融合落盘（MinerU 几何 + OXR 文本）。
//
// 用法（OXR 主产物）：
//   tsx scripts/fuse-doc.ts <docId> [--mineru <dir>] [--oxr <dir>] [--out <dir>] [--no-export] [--no-meta]
//   npm run fuse:doc -- "教材基础练 磁场"
//
// 用法（MinerU 主产物 + OXR 第二源）：
//   npm run fuse:doc -- "<docId>" --mineru "data/out/<docId>" --oxr "data/out/<docId>-OXR" --out "data/out/<docId>"
//
// 行为：
// 1. 读两源 layout.json → fuseDocuments；
// 2. 备份输出目录原主产物（OXR 主 → layout.oxr.json；MinerU 主 → layout.mineru.json，只备份一次）；
//    写融合后的 layout.json；把 MinerU images 复制到输出目录（融合块图片来自 MinerU）；
// 3. 写 fuse.json（统计/来源/时间，可审计）；
// 4. 默认重导快照 + 刷新 meta（parser=fuse）。
import { basename, join, resolve } from "node:path";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fuseDocuments } from "../src/fuse.js";
import { normalizeLayout } from "../src/normalize.js";
import type { ParsedBlock } from "../src/types.js";

const args = process.argv.slice(2);
const docId = args[0] ?? "";
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!docId) {
  console.error(
    "用法：tsx scripts/fuse-doc.ts <docId> [--mineru <dir>] [--oxr <dir>] [--out <dir>] [--no-export] [--no-meta]",
  );
  process.exit(2);
}

const oxrDir = resolve(flag("--oxr") ?? join("data", "out", docId));
const mineruDir = resolve(flag("--mineru") ?? join("data", "out", `${docId}-MinerU`));
const outDir = resolve(flag("--out") ?? oxrDir);
const outId = flag("--id") ?? basename(outDir);
const oxrPrimary = outDir === oxrDir;
const mineruPrimary = outDir === mineruDir;

const oxrBackup = join(oxrDir, "layout.oxr.json");
const oxrSource = existsSync(oxrBackup) ? oxrBackup : join(oxrDir, "layout.json");
const mineruSource = join(mineruDir, "layout.json");
if (!existsSync(oxrSource) || !existsSync(mineruSource)) {
  console.error(`缺 layout：\n  OXR ${oxrSource}\n  MinerU ${mineruSource}`);
  process.exit(2);
}

const oxr = normalizeLayout(JSON.parse(readFileSync(oxrSource, "utf8")), docId);
const mineru = normalizeLayout(JSON.parse(readFileSync(mineruSource, "utf8")), `${docId}-MinerU`);
const fused = fuseDocuments(mineru, oxr);

function rawBlock(b: ParsedBlock): Record<string, unknown> {
  if (b.kind === "image") {
    return { type: "image", bbox: b.bbox, blocks: [{ lines: [{ spans: [{ image_path: b.path }] }] }] };
  }
  // 表格块（DECISIONS §76）：按上游原结构写回 —— `type:"table"` + **嵌套** blocks[].lines[]，
  // 网格放 `spans[].html`。不写成这样，`normalize` 的 table 分支就取不到 html（上一轮实测踩过）。
  if (b.kind === "table" && b.html) {
    const fontSize = b.maxFontSize || 10;
    return {
      type: "table",
      bbox: b.bbox,
      blocks: [
        { lines: [{ bbox: b.bbox, font_size: fontSize, spans: [{ content: b.text, font_size: fontSize, html: b.html }] }] },
      ],
    };
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

const backupName = oxrPrimary ? "layout.oxr.json" : mineruPrimary ? "layout.mineru.json" : "layout.source.json";
const backup = join(outDir, backupName);
if (!existsSync(backup)) {
  const original = oxrPrimary ? oxrSource : mineruPrimary ? mineruSource : join(outDir, "layout.json");
  if (!existsSync(original)) {
    console.error(`缺输出目录原主产物：${original}`);
    process.exit(2);
  }
  copyFileSync(original, backup);
}
writeFileSync(join(outDir, "layout.json"), JSON.stringify(raw, null, 1));

if (outDir !== mineruDir && existsSync(join(mineruDir, "images"))) {
  mkdirSync(join(outDir, "images"), { recursive: true });
  cpSync(join(mineruDir, "images"), join(outDir, "images"), { recursive: true });
}

writeFileSync(
  join(outDir, "fuse.json"),
  JSON.stringify(
    {
      docId: outId,
      generatedAt: new Date().toISOString(),
      mineruLayout: mineruSource,
      oxrLayout: oxrSource,
      outLayout: join(outDir, "layout.json"),
      backup,
      stats: fused.stats,
    },
    null,
    2,
  ),
);
console.log(
  `✓ 融合 ${outId}：页 ${fused.stats.pages} · 对齐 ${fused.stats.matched} · 改文 ${fused.stats.textChanged}` +
    ` · OXR独有 ${fused.stats.oxrOnly} · MinerU独有 ${fused.stats.mineruOnly} · 低覆盖 ${fused.stats.lowCoverage}` +
    ` · 去重 ${fused.stats.deduped}`,
);

if (!args.includes("--no-export")) {
  execFileSync(process.execPath, ["--import", "tsx", join("scripts", "export-stages.ts"), outId, join(outDir, "layout.json")], {
    stdio: "inherit",
  });
}
if (!args.includes("--no-meta")) {
  const origin = [join(outDir, `${outId}_origin.pdf`), join(outDir, "origin.pdf")].find((p) => existsSync(p));
  if (origin) {
    execFileSync(
      process.execPath,
      ["--import", "tsx", join("scripts", "daily.ts"), origin, "--id", outId, "--meta-only"],
      { stdio: "inherit" },
    );
  } else {
    console.warn("⚠️ 没找到 origin.pdf；跳过 meta 刷新");
  }
}
