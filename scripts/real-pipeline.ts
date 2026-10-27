// scripts/real-pipeline.ts
/**
 * 端到端：本地样卷 → MinerU 云解析 → 解包 → 结构化切分 → 产物落盘。
 * 运行：node --import tsx scripts/real-pipeline.ts <文件或目录> [outRoot]
 * API Key 从 process.env.mineru_API_KEY 读取，不打印。
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fetch as ufetch, ProxyAgent } from "undici";
import { MineruClient } from "../src/mineru/client.js";
import { unpackResult } from "../src/mineru/unpack.js";
import { segmentFromContentList, segmentFromLayout, summarize } from "../src/index.js";

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
  // ⚠️ 沙箱里的进程**不走 Clash 的 TUN**，唯一出口是 Clash 的 HTTP 代理口；
  // 且 node 内置 fetch 不认 HTTP(S)_PROXY、给它外部 undici 的 ProxyAgent 会 UND_ERR_INVALID_ARG。
  // ⇒ 用 undici 自己的 fetch + dispatcher，代理地址由 MINERU_PROXY 显式给出（不设则直连）。
  const PROXY = process.env.MINERU_PROXY;
  const transport = PROXY
    ? ((url: any, init: any = {}) =>
        ufetch(url, { ...init, dispatcher: new ProxyAgent(PROXY) })) as unknown as typeof fetch
    : undefined;
  if (PROXY) console.log(`[0/5] MinerU 走代理 ${PROXY}`);
  const client = new MineruClient({ baseUrl: "https://mineru.net/api/v4", apiKey: KEY! }, transport);
  for (const file of files) {
    const docId = basename(file).replace(/\.[^.]+$/, "");
    console.log(`[1/5] 上传 ${basename(file)}`);
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(file);
    const batch = await client.createUpload({ fileName: basename(file), size: data.length });
    await client.uploadFile(batch.putUrl, data, file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");

    console.log("[2/5] 轮询解析结果…");
    const { zipUrl } = await client.pollResult(batch.batchId);

    const out = join(outRoot, docId);
    mkdirSync(join(out, "images"), { recursive: true });
    // 先把 zip 地址落盘再下载（2026-10-27 实测教训）：MinerU 的解析**已经完成**、
    // 只是 CDN 下载被网络阻断时，重新跑一遍 = 重新上传 + 重新解析（白烧额度）。
    // 有了这个地址，网络恢复后可以直接下载解包，不必重解析。
    writeFileSync(join(out, "zip-url.txt"), `${zipUrl}\n`);

    console.log("[3/5] 下载结果 Zip");
    let zip: Buffer;
    try {
      zip = await client.downloadZip(zipUrl);
    } catch (e) {
      const err = e as Error;
      console.error(`  ❌ 下载失败：${err.message}`);
      console.error(`     解析已完成，zip 地址已存 ${join(out, "zip-url.txt")}`);
      console.error(`     网络恢复后可执行：curl -L -o ${join(out, "result.zip")} "<zip-url.txt 里的地址>"`);
      console.error(`     然后解包：unzip -o ${join(out, "result.zip")} -d ${out}`);
      console.error(`     （再跑 npm run daily 时，已有 layout.json 会自动跳过解析）`);
      throw err;
    }
    writeFileSync(join(out, "result.zip"), zip);

    console.log("[4/5] 解包 + 结构化切分");
    const { contentList, layoutJson, markdown, images } = unpackResult(zip);
    writeFileSync(join(out, "content_list.json"), JSON.stringify(contentList, null, 2));
    // zip 含 layout.json（实测条目名即 layout.json）时落盘，供二次回归/人工比对
    if (layoutJson !== undefined) {
      writeFileSync(join(out, "layout.json"), JSON.stringify(layoutJson, null, 2));
    }
    writeFileSync(join(out, "full.md"), markdown);
    for (const img of images) writeFileSync(join(out, "images", basename(img.path)), img.data);

    // 首选 layout.json（行级几何信息，选项结构化可用）；退化：无 layout 时走 content_list
    const result =
      layoutJson !== undefined
        ? segmentFromLayout(layoutJson, docId)
        : segmentFromContentList(contentList, docId);
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
