/**
 * oxr-client.ts —— OXR（SoMark）解析 API 客户端 + 自动分片
 *
 * 免费档限制（docs/oxr-evaluation.md §0）：**单文件 ≤10MB、≤20 页**，免注册、`api_key` 不校验。
 * 实测原卷普遍超标（「1 直线运动」16 页却 11.5MB；答案册 187 页 61.9MB）⇒
 * **分片是通用解**：拆分同时压低页数与体积，不必依赖用户 key 走正式版。
 *
 * 分片用 poppler（项目已依赖 pdftoppm）：`pdfseparate` 拆单页 → `pdfunite` 按批合并 →
 * 逐片上传 → 按页序合并 pages[]，并把 `page_num` 重写为全局序号。
 *
 * 不引入任何新依赖（Node 内置 fetch / FormData / Blob）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { OxrResponse } from "./oxr-convert.js";

const FREE_ENDPOINT = "https://free-oxr.somark.cn/api/v1/parse/sync";
/** 免费档硬限制 */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 20;
/** 单片上传超时（免费档排队，实测 15 页约 2 分钟） */
const TIMEOUT_MS = 420_000;

interface Page {
  page_num?: number;
  page_size?: { w?: number; h?: number } | number[];
  blocks?: unknown[];
}

export interface ParseOptions {
  /** 进度回调 */
  onProgress?: (msg: string) => void;
  /** 最多重试次数（默认 2，共 3 次尝试） */
  retries?: number;
}

function pdfPageCount(pdfPath: string): number {
  const out = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
  const m = /^Pages:\s+(\d+)/m.exec(out);
  if (!m?.[1]) throw new Error(`读不到页数：${pdfPath}`);
  return Number(m[1]);
}

/** 用 pdfunite 把 [from, to]（1-based，含两端）合成一个临时 PDF 并返回路径与体积 */
function slicePdf(pdfPath: string, from: number, to: number, tmpDir: string): { path: string; bytes: number } {
  const out = join(tmpDir, `part-${from}-${to}.pdf`);
  const args: string[] = [];
  for (let p = from; p <= to; p++) args.push(join(tmpDir, `page-${p}.pdf`));
  execFileSync("pdfunite", [...args, out]);
  return { path: out, bytes: statSync(out).size };
}

/** 上传单片并解析 */
async function parseOne(pdfPath: string, retries: number): Promise<Page[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const form = new FormData();
      form.append("api_key", "dummy"); // 免费档必须存在但不校验
      form.append("file", new Blob([readFileSync(pdfPath)], { type: "application/pdf" }), basename(pdfPath));
      form.append("formats[]", "json");
      form.append("keep_header_footer", "false");

      const resp = await fetch(FREE_ENDPOINT, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as OxrResponse & { code?: number; message?: string };
      if (typeof json.code === "number" && json.code !== 0) {
        throw new Error(`业务错误 code=${json.code} ${json.message ?? ""}`);
      }
      const pages =
        json.data?.result?.outputs?.json?.pages ??
        json.result?.outputs?.json?.pages ??
        json.pages ??
        [];
      if (pages.length === 0) throw new Error("响应里没有 pages[]");
      return pages;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new Error(`解析失败（已重试 ${retries} 次）：${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

/**
 * 解析 PDF（自动分片），返回合并后的 OXR 响应。
 * 合并后 `page_num` 为**全局页序**（从 1 开始），与输入 PDF 页序一致。
 */
export async function parsePdfWithOxr(pdfPath: string, opts: ParseOptions = {}): Promise<OxrResponse> {
  const log = opts.onProgress ?? (() => {});
  const retries = opts.retries ?? 2;
  const total = pdfPageCount(pdfPath);
  const bytes = statSync(pdfPath).size;
  log(`原卷 ${total} 页 / ${(bytes / 1024 / 1024).toFixed(1)}MB（免费档限 ${MAX_PAGES} 页 / 10MB）`);

  const needsSplit = total > MAX_PAGES || bytes > MAX_BYTES;
  if (!needsSplit) {
    log("单片直传…");
    const pages = await parseOne(pdfPath, retries);
    return { pages: pages as never };
  }

  // ---- 分片 ----
  const tmpDir = join("data", "_oxr-split");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    log("拆分 PDF（pdfseparate）…");
    execFileSync("pdfseparate", [pdfPath, join(tmpDir, "page-%d.pdf")]);

    const merged: Page[] = [];
    let from = 1;
    let part = 0;
    while (from <= total) {
      // 先按上限切，若体积超限就减半重试（下限 1 页）
      let size = Math.min(MAX_PAGES, total - from + 1);
      let piece = slicePdf(pdfPath, from, from + size - 1, tmpDir);
      while (piece.bytes > MAX_BYTES && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        piece = slicePdf(pdfPath, from, from + size - 1, tmpDir);
      }
      if (piece.bytes > MAX_BYTES) {
        throw new Error(
          `即使单片 1 页仍超 10MB（第 ${from} 页，${(piece.bytes / 1024 / 1024).toFixed(1)}MB）` +
            `——该页可能是高分辨率扫描图，需先降采样。`,
        );
      }
      part++;
      log(`  第 ${part} 片：第 ${from}–${from + size - 1} 页（${(piece.bytes / 1024 / 1024).toFixed(1)}MB）上传…`);
      const pages = await parseOne(piece.path, retries);
      // 全局页序重写
      pages.forEach((p, i) => merged.push({ ...p, page_num: from + i }));
      from += size;
    }
    log(`合并 ${part} 片 ⇒ ${merged.length} 页`);
    return { pages: merged as never };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
