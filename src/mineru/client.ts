/**
 * MinerU 云 API 客户端（上游适配实现）。
 *
 * 字段解析以 docs/real-api-notes.md 的实测记录为准（2026-08-18 真实冒烟）：
 *   - 请求体数组元素键名是 `name`（不是 fileName / filename，首探即 code:-10002）
 *   - zip 下载字段是 `data.extract_result[].full_zip_url`（不是 file_url；未完成时键不存在）
 *   - 业务错误 HTTP 恒 200 + 顶层 `code != 0`，客户端不能只看 HTTP 状态码
 *   - PUT 预签名上传不得带 Content-Type 头（否则 OSS 403 SignatureDoesNotMatch）
 *
 * transport 注入是为了离线测试；API Key 仅来自构造参数（调用方从环境变量读取），
 * 本文件不触碰环境变量。
 */
export interface MineruConfig {
  baseUrl: string;
  apiKey: string;
}

export interface PendingUpload {
  fileName: string;
  size: number;
}

export interface UploadBatch {
  batchId: string;
  putUrl: string;
}

export interface PollResult {
  zipUrl: string;
}

/** 防御式递归查找：按键名优先级在整棵树里找第一个非 undefined 值，字段事实表更新时无需改代码。 */
const find = (o: unknown, keys: string[]): unknown => {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) if (rec[k] !== undefined) return rec[k];
  for (const v of Object.values(rec)) {
    const r = find(v, keys);
    if (r !== undefined) return r;
  }
  return undefined;
};

/** 从响应顶层 code 判断业务失败：notes 实测业务错误 HTTP 恒 200 + code != 0。 */
const assertCodeOk = (json: unknown): void => {
  const code = find(json, ["code"]);
  if (typeof code === "number" && code !== 0) {
    const msg = String(find(json, ["msg"]) ?? "unknown error");
    throw new Error(`业务错误 code=${code}: ${msg}`);
  }
};

export class MineruClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly transport: typeof fetch;

  constructor(cfg: MineruConfig, transport: typeof fetch = fetch) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.headers = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
    this.transport = transport;
  }

  async createUpload(f: PendingUpload): Promise<UploadBatch> {
    const res = await this.transport(`${this.baseUrl}/file-urls/batch`, {
      method: "POST",
      headers: this.headers,
      // notes §1：键名必须是 name（不是 fileName），fileSize 为字节数
      body: JSON.stringify({ files: [{ name: f.fileName, fileSize: f.size }] }),
    });
    if (!res.ok) throw new Error(`file-urls/batch 失败: HTTP ${res.status} ${await res.text()}`);
    const json: unknown = await res.json();
    assertCodeOk(json);
    const batchId = find(json, ["batch_id", "batchId"]);
    const putUrl = find(json, ["file_urls", "file_url", "url", "uploadUrl"]);
    // notes §1：file_urls 是字符串数组（不是对象数组），取首个元素为预签名 PUT 地址
    const putUrlStr = Array.isArray(putUrl) ? putUrl[0] : putUrl;
    if (typeof batchId !== "string" || !batchId) throw new Error("响应中未找到 batch_id，见 docs/real-api-notes.md");
    if (typeof putUrlStr !== "string" || !putUrlStr) throw new Error("响应中未找到上传链接，见 docs/real-api-notes.md");
    return { batchId, putUrl: putUrlStr };
  }

  async uploadFile(putUrl: string, data: Buffer, _contentType: string): Promise<{ status: number }> {
    // notes §2：预签名 URL 签署时未纳入 Content-Type，带上任何 Content-Type 都会 403
    // SignatureDoesNotMatch；参数保留仅为接口兼容，实际不发送该头。
    const res = await this.transport(putUrl, {
      method: "PUT",
      body: data,
    });
    if (res.status >= 400) throw new Error(`PUT 上传失败: HTTP ${res.status} ${await res.text()}`);
    return { status: res.status };
  }

  async pollResult(
    batchId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PollResult> {
    const intervalMs = opts.intervalMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`轮询超时（${timeoutMs}ms）`);
      const res = await this.transport(`${this.baseUrl}/extract-results/batch/${batchId}`, {
        headers: this.headers,
      });
      if (!res.ok) throw new Error(`轮询失败: HTTP ${res.status}`);
      const json: unknown = await res.json();
      assertCodeOk(json);
      // notes §3：状态在 data.extract_result[].state，取值 waiting-file/pending/running/done/failed
      const state = String(find(json, ["state", "status"]) ?? "unknown");
      if (state === "failed") {
        const errMsg = String(find(json, ["err_msg"]) ?? "");
        throw new Error(`解析任务失败: ${errMsg || JSON.stringify(json).slice(0, 300)}`);
      }
      if (state === "done" || state === "finished") {
        // notes §3：完成态才出现 full_zip_url（未完成时该键不存在，须存在性检查）
        const zipUrl = find(json, ["full_zip_url", "file_url", "url"]);
        if (typeof zipUrl !== "string" || !zipUrl) throw new Error("完成态未找到 zip 下载地址");
        return { zipUrl };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * 下载结果 zip。
   *
   * ⚠️ **必须重试**（2026-10-28 实测）：这份环境里对 CDN 的 TLS 握手会被**时段性 RST**
   * （`ECONNRESET` / `SSL_ERROR_SYSCALL`，4–31ms 就断）。它不是 MinerU 限流 ——
   * 同一时刻上传与轮询（API）全部正常、8 页的 zip 能下、失败发生在**握手层**（应用层之前），
   * 而限流会返回 HTTP 429/业务 code。所以这是网络侧干扰，**重试是唯一有效的对抗手段**。
   *
   * 判据：只对**连接级失败**重试（ECONNRESET / ECONNREFUSED / ETIMEDOUT / socket 断开）；
   * HTTP 4xx/5xx 不重试（那是服务端的明确答复，重试只会重复烧请求）。
   */
  async downloadZip(zipUrl: string, attempts = 5): Promise<Buffer> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        // notes §3：zip 下载 GET 可直接带 Authorization 头
        const res = await this.transport(zipUrl, { headers: this.headers });
        if (!res.ok) throw new Error(`zip 下载失败: HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        const err = e as Error & { cause?: { code?: string } };
        const code = err.cause?.code ?? "";
        const retryable =
          /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket/i.test(code) ||
          /socket disconnected|fetch failed/i.test(err.message);
        lastErr = e;
        if (!retryable || i === attempts) break;
        const wait = 800 * i; // 800 / 1600 / 2400 / 3200ms
        console.warn(`  zip 下载第 ${i} 次失败（${code || err.message}），${wait}ms 后重试…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }
}