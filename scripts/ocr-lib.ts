// scripts/ocr-lib.ts
/**
 * PaddleOCR-VL 的 MCP stdio 客户端 + 共用小工具
 * （被 `scripts/ocr-fill.ts`（区域裁图）与 `scripts/ocr-page-fill.ts`（整页）共用）。
 *
 * 两个**实测**要点写在这里，别在两处各踩一遍：
 *
 * 1. **必须按 `id` 匹配响应。** server 会先发 `notifications/message`；
 *    若把第一条消息当响应，会出现「0.0s 假完成」——调用看起来瞬时返回，实际结果根本没读到。
 * 2. **必须兜底设置 MODEL/SOURCE。** 只给 token 时后端**启动即崩**（`exitCode=1`，
 *    stderr 只有一行与故障无关的日志），现象是 `initialize` 永远超时，极难从现象反推原因。
 *    ⇒ 初始化失败时把 `exitCode` 打出来：**进程已死就不是网络/超时问题**。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 取 OCR 凭据：env 优先，其次读应用 MCP 配置（只读，**不打印**）。 */
export function readToken(): string {
  const fromEnv = process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  const cfg = join(homedir(), ".workbuddy-ai", "mcp.json");
  if (existsSync(cfg)) {
    try {
      const j = JSON.parse(readFileSync(cfg, "utf8"));
      const t = j?.mcpServers?.["PaddleOCR-VL-1.6"]?.env?.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN;
      if (typeof t === "string" && t) return t;
    } catch {
      /* 读不动就走下面的报错 */
    }
  }
  console.error(
    "缺少 PaddleOCR token：设置 PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN，" +
      "或在 ~/.workbuddy-ai/mcp.json 的 PaddleOCR-VL-1.6.env 里配置。",
  );
  process.exit(2);
}

/** 清洗 OCR 输出：去掉 markdown/HTML/图片占位符与多余空白（**不改字**）。 */
export function cleanOcr(s: string): string {
  return s
    .replace(/<div[\s\S]*?<\/div>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[#>*\s]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 同 {@link cleanOcr}，但**保留换行** —— 整页路径要按 OCR 的换行切段。 */
export function cleanOcrLines(s: string): string {
  return s
    .replace(/<div[\s\S]*?<\/div>/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/^[#>*\s]+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

type Box = [number, number, number, number];

export const inter = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** 本页正文块的**行高中位**（pt）——当作该页字号，用于宽度合理性判据。 */
export function medianLineHeightPt(blocks: any[]): number {
  const hs = blocks
    .filter((b: any) => b.kind !== "image" && b.text)
    .map((b: any) => b.bbox[3] - b.bbox[1])
    .sort((a: number, b: number) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)]! : 0;
}

/**
 * uvx 可执行路径：默认本机路径，可用 `UVX_BIN` 覆盖。
 * 换机/CI 不必改代码；找不到 uvx 时 OCR 会失败并被 daily 记录为 ocrError。
 */
export function uvxBin(): string {
  return process.env.UVX_BIN?.trim() || "/Users/john/.local/bin/uvx";
}

export class OcrMcp {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters = new Map<number, (v: any) => void>();
  private nextId = 100;

  constructor(token: string) {
    this.proc = spawn(uvxBin(), ["--from", "paddleocr-mcp", "paddleocr_mcp"], {
      env: {
        ...process.env,
        PADDLEOCR_MCP_MODEL: "PaddleOCR-VL-1.6",
        PADDLEOCR_MCP_PPOCR_SOURCE: "aistudio",
        PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: token,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr!.on("data", () => {}); // 吞掉 banner/日志
    this.proc.stdout!.on("data", (c: Buffer) => {
      this.buf += c.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        // ⚠️ 按 id 匹配（见文件头 1.）
        if (typeof m.id === "number" && this.waiters.has(m.id)) {
          this.waiters.get(m.id)!(m);
          this.waiters.delete(m.id);
        }
      }
    });
  }

  private send(o: unknown) {
    this.proc.stdin!.write(JSON.stringify(o) + "\n");
  }

  private await(id: number, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  async init(timeoutMs = 180_000): Promise<void> {
    this.send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ocr", version: "1" } },
    });
    const r = await this.await(1, timeoutMs);
    if (!r) {
      const rc = this.proc.exitCode;
      throw new Error(
        "MCP initialize 超时" +
          (rc !== null
            ? `（后端进程已退出 rc=${rc} ⇒ 多半是**后端环境变量缺失**或凭据无效，不是网络/超时问题）`
            : "（后端进程仍在运行 ⇒ 更可能是网络/代理问题）"),
      );
    }
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async ocr(pngBase64: string, timeoutMs = 300_000): Promise<string> {
    const id = ++this.nextId;
    this.send({
      jsonrpc: "2.0", id, method: "tools/call",
      params: {
        name: "paddleocr_vl",
        arguments: { input_data: pngBase64, file_type: "image", output_mode: "simple", return_images: false },
      },
    });
    const r = await this.await(id, timeoutMs);
    if (!r) return "";
    if (r.error) throw new Error(`tools/call 错误: ${JSON.stringify(r.error).slice(0, 200)}`);
    const res = r.result ?? {};
    if (res.isError) throw new Error("tools/call isError");
    return (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
  }

  close() {
    try {
      this.proc.kill();
    } catch {
      /* 已退出 */
    }
  }
}
