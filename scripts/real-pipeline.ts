// scripts/real-pipeline.ts
/**
 * 端到端：本地样卷 → MinerU 云解析 → 解包 → 结构化切分 → 产物落盘。
 * 运行：node --import tsx scripts/real-pipeline.ts <文件或目录> [--out data/out] [--strategy rule-engine-v1]
 * API Key 从 process.env.mineru_API_KEY 读取，不打印。
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { MineruClient } from "../src/mineru/client.js";
import { unpackResult } from "../src/mineru/unpack.js";
import { segmentFromContentList, summarize } from "../src/index.js";

const KEY = process.env.mineru_API_KEY;
if (!KEY) {
  console.error("缺少 mineru_API_KEY 环境变量");
  process.exit(2);
}

const input = process.argv[2];
const outRoot = process.argv[3] ?? "data/out";
if (!input) {
  console.error("用法: node --import tsx scripts/real-pipeline.ts <file|dir> [outRoot]");
  process.exit(2);
}

const files = statSync(input).isDirectory()
  ? readdirSync(input)
      .filter((f) => /\.(pdf|png|jpe?g|webp|bmp)$/i.test(f))
      .map((f) => join(input, f))
  : [input];
if (files.length === 0) {
  console.error("输入目录中没有可解析的 PDF/图片");
  process.exit(2);
}

async function main() {
  // KEY!：模块顶层 `if (!KEY) process.exit(2)` 已保证非空；tsc 7 不把顶层窄化
  // 传入 main() 闭包，故在此用非空断言（运行时守卫不变）。
  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: KEY! });
  for (const file of files) {
    const docId = basename(file).replace(/\.[^.]+$/, "");
    console.log(`[1/5] 上传 ${basename(file)}`);
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(file);
    const batch = await client.createUpload({ fileName: basename(file), size: data.length });
    await client.uploadFile(batch.putUrl, data, file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");

    console.log("[2/5] 轮询解析结果…");
    const { zipUrl } = await client.pollResult(batch.batchId);

    console.log("[3/5] 下载结果 Zip");
    const zip = await client.downloadZip(zipUrl);
    const out = join(outRoot, docId);
    mkdirSync(join(out, "images"), { recursive: true });
    writeFileSync(join(out, "result.zip"), zip);

    console.log("[4/5] 解包 + 结构化切分");
    const { contentList, markdown, images } = unpackResult(zip);
    writeFileSync(join(out, "content_list.json"), JSON.stringify(contentList, null, 2));
    writeFileSync(join(out, "full.md"), markdown);
    for (const img of images) writeFileSync(join(out, "images", basename(img.path)), img.data);

    const result = segmentFromContentList(contentList, docId);
    // 图片路径归一：content_list 的 img_path 形如 "images/<sha256>.jpg"（zip 内相对路径），
    // 落盘时图片按 basename 写入 images/ 目录；这里把题目里的 img.path 统一为 basename，
    // 保证 questions.json 的 path 与磁盘文件名一一对应。
    for (const q of result.questions) {
      for (const im of q.images) im.path = basename(im.path);
    }
    writeFileSync(join(out, "questions.json"), JSON.stringify(result.questions, null, 2));
    const summary = summarize(result);
    writeFileSync(join(out, "summary.txt"), summary);

    console.log(`[5/5] 完成 ${docId}: ${result.questions.length} 道题，${result.stats.reviewCount} 处待校对`);
    console.log(summary.split("\n").slice(0, 4).join("\n"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
