// scripts/api-smoke.ts
/**
 * 真实 MinerU API 冒烟：<file> → 申请上传链接 → PUT → 轮询 → 下载 Zip。
 * 运行：node --import tsx scripts/api-smoke.ts <样卷路径>
 * 产物：data/smoke/raw/*.json（原始响应）、data/smoke/result.zip
 * 本脚本用于开发期确认字段结构，结果记录进 docs/real-api-notes.md。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const BASE = "https://mineru.net/api/v4";
const KEY = process.env.mineru_API_KEY;
if (!KEY) {
  console.error("缺少 mineru_API_KEY 环境变量");
  process.exit(2);
}
const filePath = process.argv[2] ?? "";
if (!filePath) {
  console.error("用法: node --import tsx scripts/api-smoke.ts <file>");
  process.exit(2);
}

mkdirSync("data/smoke/raw", { recursive: true });
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const find = (o: any, keys: string[]): any => {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  for (const v of Object.values(o)) {
    const r = find(v, keys);
    if (r !== undefined) return r;
  }
  return undefined;
};
// 递归找第一个 http(s) 字符串（实测 file_urls 是「字符串数组」，find 对字符串无效）
const findUrl = (o: any): string | undefined => {
  if (typeof o === "string" && /^https?:\/\//.test(o)) return o;
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) {
      const u = findUrl(v);
      if (u) return u;
    }
  }
  return undefined;
};

async function main() {
  const data = readFileSync(filePath);

  // 1) 申请上传链接（file-urls/batch；实测 files[i] 键名为 name 而非 fileName）
  const uploadRes = await fetch(`${BASE}/file-urls/batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ files: [{ name: basename(filePath), fileSize: data.length }] }),
  });
  const uploadJson = await uploadRes.json();
  writeFileSync("data/smoke/raw/upload-response.json", JSON.stringify(uploadJson, null, 2));
  const batchId = find(uploadJson, ["batch_id", "batchId"]) as string | undefined;
  const putUrl = (find(uploadJson, ["file_url", "url", "uploadUrl"]) ?? findUrl(uploadJson)) as string | undefined;
  if (!batchId || !putUrl) {
    console.error("未能解析 batch_id / 上传链接，详见 data/smoke/raw/upload-response.json");
    process.exit(3);
  }
  console.log("batch_id:", batchId);

  // 2) PUT 上传（实测：预签名 URL 签署时未含 Content-Type，带任何 Content-Type 头都会 403
  //    SignatureDoesNotMatch，与文件类型无关；node fetch 对 Buffer body 默认不带头即可）
  const putRes = await fetch(putUrl, {
    method: "PUT",
    body: data,
  });
  writeFileSync("data/smoke/raw/put-status.txt", `status=${putRes.status} ${await putRes.text()}`);
  if (putRes.status >= 400) {
    console.error("PUT 上传失败，见 data/smoke/raw/put-status.txt");
    process.exit(4);
  }

  // 3) 轮询（最多 10 分钟，每 5s 一次）
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${BASE}/extract-results/batch/${batchId}`, { headers });
    const j = await r.json();
    const state = String(find(j, ["state", "status"]) ?? "unknown");
    const el = find(j, ["extract_result"]) as any;
    const detail = (Array.isArray(el) ? el.map((e: any) => `${e.file_name}:${e.state}:${e.err_msg ?? ""}`).join(" | ") : "");
    writeFileSync("data/smoke/raw/poll-states.log", `${new Date().toISOString()} poll[${i}] state=${state} ${detail}\n`, { flag: "a" });
    if (i % 10 === 0) console.log(`poll[${i}] state=${state}`);
    if (state === "done" || state === "finished") {
      writeFileSync("data/smoke/raw/poll-final.json", JSON.stringify(j, null, 2));
      const zipUrl = find(j, ["full_zip_url", "file_url", "url"]) as string | undefined;
      if (!zipUrl) {
        console.error("任务完成但未找到 zip 下载地址，见 data/smoke/raw/poll-final.json");
        process.exit(5);
      }
      const zip = Buffer.from(await (await fetch(zipUrl, { headers })).arrayBuffer());
      writeFileSync("data/smoke/result.zip", zip);
      console.log(`zip 已保存: data/smoke/result.zip (${zip.byteLength} bytes)`);
      return;
    }
    if (state === "failed") {
      console.error("任务失败:", JSON.stringify(j).slice(0, 500));
      process.exit(6);
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.error("轮询超时（10 分钟）");
  process.exit(7);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});