// scripts/table-v3-sample.ts
/**
 * S2 放置的 **9 页样本分类产物构建器**（spec docs/plans/2026-11-13-表格与巨带放置实现.md §3/附录 A/B）。
 *
 * 输入：tmp/table-broaden-v3/（V3 表格模块单表试用的 res JSON + 原卷 PGM + 已目视核对的整表裁图）。
 * 输出：data/out/<doc>/table-v3.json（上游显式分类产物）+ data/out/<doc>/table-crops/*.png。
 * 消费方：scripts/export-stages.ts 的 applyTableV3（只增快照新字段）；展示层只消费快照。
 *
 * 分类是**已核对的硬编码结论**（任务 #32/#33 真值裁图目视 + 管家拍板），不是本脚本现算：
 * - text（3 张纯文字表，G3 结构全对 + truth 碎片 0 缺）：qx-p02、da-p175；
 *   qx-p07 原为 text，因 V3 公式 token 挪格末（R3 顺序错、内容不丢）⇒ **保守改判 image**。
 * - image（插图表，G2 红线兜底=截图无损侧）：qx-p03、qx-p05、qx-p10、da-p077、da-p089、qx-p07。
 * - borderless（G1 墨迹守卫 hRunW=0.04<0.3）：da-p186 两栏答案索引。
 *
 * 纪律：
 * - **判据与实现不同源**：G1 守卫值用原卷 PGM（ffmpeg format=gray 产物）现算复核，
 *   与附录 B 实测对不上就**响亮中止**（不静默）；裁图用 ffmpeg（禁 sips），ffprobe 尺寸自检。
 * - **不丢内容**：image 裁图=整表无损截图；text 的 html=V3 pred_html 原样；
 *   borderless 只标 class，行文本照常渲染。
 * - 显式步骤，不进 npm run check（与 ocr-fill 同纪律）；全册分类依赖笔记本 V3 table_res_list（R6），
 *   本脚本只做已验证的 9 页样本。
 *
 * 用法：npx tsx scripts/table-v3-sample.ts
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { G1_LINE_THRESHOLD, isBorderlessByInk, longestHRunRatio, longestVRunRatio, type GuardGray } from "./table-guard.js";

const TMP = join("tmp", "table-broaden-v3");

/** 已核对分类（真值裁图目视 + 管家拍板；expect=附录 B 墨迹探针实测，复核容差 0.05） */
interface Sample {
  key: string;
  cls: "text" | "image" | "borderless";
  expect: { hRunW: number; vRunH: number };
  /** 复用 tmp 已目视核对的整表裁图（附录 A 命令产物）；缺省=从页图 ffmpeg 新裁（bbox+3px） */
  reuse?: string;
  /** 复用裁图的期望尺寸（ffprobe 自检） */
  size?: [number, number];
  note?: string;
}

const SAMPLES: Sample[] = [
  { key: "qx-p02", cls: "text", expect: { hRunW: 1.0, vRunH: 1.0 }, note: "MinerU 无 table 块（三行被 §90 行距判据留为 text 行）⇒ 透传报 unmatched，行文本照常渲染，不丢内容" },
  { key: "qx-p03", cls: "image", expect: { hRunW: 1.0, vRunH: 1.0 }, reuse: "fulltable-qx-p03.png", size: [894, 365], note: "4 列合并格 + 3 图（G2）" },
  { key: "qx-p05", cls: "image", expect: { hRunW: 1.0, vRunH: 0.99 }, reuse: "fulltable-qx-p05.png", size: [892, 343], note: "6 列 5 图（G2）" },
  { key: "qx-p07", cls: "image", expect: { hRunW: 1.0, vRunH: 1.01 }, note: "R3 保守改判：V3 公式 token 挪格末（顺序错）⇒ 截图无损侧；裁图从页图新裁（bbox+3px）" },
  { key: "qx-p10", cls: "image", expect: { hRunW: 0.62, vRunH: 0.92 }, reuse: "fulltable-qx-p10.png", size: [895, 496], note: "5 列 4 图；最浅线真表 hRunW=0.62（G1 阈值 0.3 裕度）" },
  { key: "da-p077", cls: "image", expect: { hRunW: 1.0, vRunH: 1.0 }, reuse: "fulltable-da-p077.png", size: [425, 578], note: "4 波形图含微平移（G2）" },
  { key: "da-p089", cls: "image", expect: { hRunW: 1.0, vRunH: 0.94 }, reuse: "fulltable-da-p089.png", size: [378, 489], note: "G2 反例：V3 双信号报 0 图实有 2 图 ⇒ 真值目视决断 image" },
  { key: "da-p175", cls: "text", expect: { hRunW: 1.0, vRunH: 0.99 }, note: "4 列 3 行纯文字数据表（G3 全对）" },
  { key: "da-p186", cls: "borderless", expect: { hRunW: 0.04, vRunH: 0.14 }, note: "两栏答案索引：G1 hRunW=0.04<0.3 ⇒ 守卫跳过表格渲染，行文本照常" },
];

/** P5 PGM → 灰度图（头可含注释；单空白分隔后为行优先字节） */
function parsePgm(buf: Buffer): GuardGray {
  let pos = 0;
  const token = (): string => {
    while (pos < buf.length) {
      const c = buf[pos]!;
      if (c === 35) {
        while (pos < buf.length && buf[pos] !== 10) pos++;
      } else if (c <= 32) {
        pos++;
      } else break;
    }
    const start = pos;
    while (pos < buf.length && buf[pos]! > 32) pos++;
    return buf.subarray(start, pos).toString("ascii");
  };
  const magic = token();
  if (magic !== "P5") throw new Error(`PGM 魔数不是 P5：${magic}`);
  const width = Number(token());
  const height = Number(token());
  const maxval = Number(token());
  if (!width || !height || maxval !== 255) throw new Error(`PGM 头异常：${width}x${height} maxval=${maxval}`);
  pos++; // 头后单空白
  const data = new Uint8Array(buf.subarray(pos, pos + width * height));
  if (data.length !== width * height) throw new Error(`PGM 像素数不足：${data.length} ≠ ${width * height}`);
  return { width, height, data };
}

function ffprobeSize(path: string): [number, number] {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], { encoding: "utf8" }).trim();
  const [w, h] = out.split(",").map(Number);
  if (!w || !h) throw new Error(`ffprobe 读不到尺寸：${path} → "${out}"`);
  return [w, h];
}

interface ResJson {
  width: number;
  height: number;
  parsing_res_list?: { block_label: string; block_bbox: number[] }[];
  table_res_list?: { pred_html?: string }[];
}

interface TruthSpec {
  [key: string]: { doc: string; index: number };
}

/** da-p186 是 G1 守卫探针页（不在 truth-spec 的结构核对清单里），doc/index 已实测核对 */
const EXTRA_SPEC: TruthSpec = { "da-p186": { doc: "答案册-合订本", index: 185 } };

function main(): void {
  const truth = JSON.parse(readFileSync(join(TMP, "truth-spec.json"), "utf8")) as TruthSpec;
  const dimsCache = new Map<string, { index: number; width: number; height: number }[]>();
  const pageDims = (doc: string, index: number) => {
    let pages = dimsCache.get(doc);
    if (!pages) {
      const stages = JSON.parse(readFileSync(join("data", "out", doc, "stages.json"), "utf8")) as { pages: { index: number; width: number; height: number }[] };
      pages = stages.pages;
      dimsCache.set(doc, pages);
    }
    const p = pages.find((x) => x.index === index);
    if (!p) throw new Error(`${doc} 快照缺页 index=${index}`);
    return p;
  };

  const byDoc = new Map<string, unknown[]>();
  for (const s of SAMPLES) {
    const spec = truth[s.key] ?? EXTRA_SPEC[s.key];
    if (!spec) throw new Error(`truth-spec 缺 ${s.key}`);
    const res = JSON.parse(readFileSync(join(TMP, `${s.key}_res.json`), "utf8")) as ResJson;
    const tb = (res.parsing_res_list ?? []).find((b) => b.block_label === "table");
    if (!tb) throw new Error(`${s.key} res 无 table 块`);
    const bboxPx = tb.block_bbox as [number, number, number, number];

    // ── G1 墨迹守卫复核（原卷 PGM，独立于 V3）：与附录 B 对不上就响亮中止 ──
    const img = parsePgm(readFileSync(join(TMP, `${s.key}.pgm`)));
    if (img.width !== res.width || img.height !== res.height) {
      throw new Error(`${s.key} PGM 尺寸 ${img.width}x${img.height} ≠ res ${res.width}x${res.height}（坐标域不一致，裁切会错）`);
    }
    // 主判据 hRunW 按 spec 口径「区域=table bbox」（原始框）严格复核。
    const hRunW = longestHRunRatio(img, bboxPx, G1_LINE_THRESHOLD);
    const vRunH = longestVRunRatio(img, bboxPx, G1_LINE_THRESHOLD);
    // 佐证 vRunH（非主判据）：附录 B 探针的区域口径混用（da-p186=原始框 0.14，
    // da-p089=裁图框 bbox+3px 0.94——实测原始框 0.756 / +3px 0.928 复现），
    // 故两种区域任一复现附录值即算通过；差异只影响佐证信号，不影响分类。
    const plus3: [number, number, number, number] = [
      Math.max(0, bboxPx[0] - 3),
      Math.max(0, bboxPx[1] - 3),
      Math.min(img.width, bboxPx[2] + 3),
      Math.min(img.height, bboxPx[3] + 3),
    ];
    const vRunH3 = longestVRunRatio(img, plus3, G1_LINE_THRESHOLD);
    if (Math.abs(hRunW - s.expect.hRunW) > 0.05) {
      throw new Error(`${s.key} G1 主判据复核与附录 B 不符：实测 hRunW=${hRunW.toFixed(3)}，期望 ${s.expect.hRunW} ⇒ 中止（不静默）`);
    }
    if (Math.min(Math.abs(vRunH - s.expect.vRunH), Math.abs(vRunH3 - s.expect.vRunH)) > 0.05) {
      throw new Error(`${s.key} G1 佐证复核与附录 B 不符：vRunH 原始框=${vRunH.toFixed(3)} / +3px=${vRunH3.toFixed(3)}，期望 ${s.expect.vRunH} ⇒ 中止（不静默）`);
    }
    if (isBorderlessByInk(hRunW) !== (s.cls === "borderless")) {
      throw new Error(`${s.key} G1 判定与分类矛盾：hRunW=${hRunW.toFixed(3)} cls=${s.cls} ⇒ 中止`);
    }

    const page = pageDims(spec.doc, spec.index);
    const sx = page.width / res.width;
    const sy = page.height / res.height;
    const bboxPt = [bboxPx[0] * sx, bboxPx[1] * sy, bboxPx[2] * sx, bboxPx[3] * sy];
    const entry: Record<string, unknown> = {
      page: spec.index,
      bbox: bboxPt,
      class: s.cls,
      source: "v3",
      guard: { hRunW: Number(hRunW.toFixed(3)), vRunH: Number(vRunH.toFixed(3)) },
    };
    if (s.note) entry.note = s.note;

    if (s.cls === "text") {
      const html = res.table_res_list?.[0]?.pred_html ?? "";
      if (!html.includes("<table")) throw new Error(`${s.key} text 路由缺 pred_html（G3 门）⇒ 中止`);
      entry.html = html;
    }

    if (s.cls === "image") {
      const cropDir = join("data", "out", spec.doc, "table-crops");
      mkdirSync(cropDir, { recursive: true });
      const cropName = `p${String(spec.index + 1).padStart(3, "0")}-t0.png`;
      const cropPath = join(cropDir, cropName);
      let expectSize: [number, number];
      if (s.reuse) {
        // 复用附录 A 已裁 + 已目视核对的整表裁图（仍是 ffmpeg 产物，禁 sips）
        const src = join(TMP, s.reuse);
        if (!existsSync(src)) throw new Error(`${s.key} 复用裁图缺失：${src}`);
        copyFileSync(src, cropPath);
        expectSize = s.size!;
      } else {
        // 新裁：V3 table bbox 外扩 3px 夹到页界（附录 A 同口径），ffmpeg 从原卷页图裁
        // 页图命名实测两种：qx=page-07.png（2 位）、da=page-077.png（3 位）——都试，缺则响亮报错
        const pagesDir = join("data", "out", spec.doc, "pages");
        const candidates = [
          join(pagesDir, `page-${String(spec.index + 1).padStart(3, "0")}.png`),
          join(pagesDir, `page-${String(spec.index + 1).padStart(2, "0")}.png`),
        ];
        const pagePng = candidates.find((c) => existsSync(c));
        if (!pagePng) throw new Error(`${s.key} 页图缺失：${candidates.join(" / ")}`);
        const [pw, ph] = ffprobeSize(pagePng);
        if (pw !== res.width || ph !== res.height) throw new Error(`${s.key} 页图尺寸 ${pw}x${ph} ≠ V3 坐标域 ${res.width}x${res.height}（R7）⇒ 中止`);
        const x0 = Math.max(0, bboxPx[0] - 3);
        const y0 = Math.max(0, bboxPx[1] - 3);
        const x1 = Math.min(pw, bboxPx[2] + 3);
        const y1 = Math.min(ph, bboxPx[3] + 3);
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", pagePng, "-vf", `crop=${x1 - x0}:${y1 - y0}:${x0}:${y0}`, cropPath], { stdio: "pipe" });
        expectSize = [x1 - x0, y1 - y0];
      }
      const got = ffprobeSize(cropPath);
      if (got[0] !== expectSize[0] || got[1] !== expectSize[1]) {
        throw new Error(`${s.key} 裁图尺寸自检失败：ffprobe ${got} ≠ 期望 ${expectSize} ⇒ 中止`);
      }
      entry.crop = `table-crops/${cropName}`;
      entry.cropSize = got;
    }

    const list = byDoc.get(spec.doc) ?? [];
    list.push(entry);
    byDoc.set(spec.doc, list);
    console.log(
      `${s.key} ⇒ ${s.cls}  hRunW=${hRunW.toFixed(3)} vRunH=${vRunH.toFixed(3)}` +
        (entry.crop ? `  crop=${entry.crop} ${JSON.stringify(entry.cropSize)} ✔` : ""),
    );
  }

  for (const [doc, tables] of byDoc) {
    const out = join("data", "out", doc, "table-v3.json");
    writeFileSync(out, JSON.stringify({ version: 1, source: "v3", generatedBy: "scripts/table-v3-sample.ts", tables }, null, 1));
    console.log(`已写 ${out}（${tables.length} 表）`);
  }
  console.log("SAMPLE_DONE 9 页样本分类产物就绪；下一步 npm run stages:export -- <doc> <layoutPath> 透传进快照");
}

main();