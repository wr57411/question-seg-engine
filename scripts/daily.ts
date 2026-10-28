// scripts/daily.ts
/**
 * 每天一条命令：把一份新试卷变成「成品页里能读的东西」。
 *
 * ## 为什么有这个脚本
 *
 * 2026-10-14 之前，导入一份新卷要手动串 4 条命令（MinerU 解析 → export-stages →
 * ocr-page-fill → 再 export），还得手改 `final/final.js` 的 `DOCS` 常量才能出现在下拉里。
 * 那不叫"能用"，叫"能演示"。这个脚本把整条链路收成一条命令，并把**体检结果**写进
 * `data/out/<docId>/meta.json` —— 成品页据此自动发现文档、显示本册健康状况。
 *
 * ## 用法
 *
 * ```bash
 * npm run daily -- <pdf>                     # 新卷：解析 + 导出 + OCR 补行 + 体检
 * npm run daily -- <layout.json> --id <docId> # 已有解析结果：跳过 MinerU（省额度）
 * npm run daily -- <pdf> --no-ocr             # 跳过 OCR 补行（更快）
 * npm run daily -- <pdf> --force-parse        # 强制重新解析（默认幂等：已有 layout.json 就跳过）
 * npm run daily -- <pdf> --no-proxy            # 强制直连（默认会自动用本机 Clash 端口）
 * ```
 *
 * ## 设计约束（别在这里加"聪明"的东西）
 *
 * - **幂等**：已有 `layout.json` 且未 `--force-parse` ⇒ 不重新解析。重跑不烧额度。
 * - **不静默**：每一步失败都打印「为什么 + 下一步怎么办」；OCR 缺凭据是**跳过并说明**，
 *   不是悄悄少做一步。
 * - **只写 `data/out/<docId>/`**：不再往 `data/out/` 根目录扔临时文件（历史遗留已归档到
 *   `data/archive/`，见 DECISIONS §30）。
 * - **不碰引擎**：只调 `src/` 的公开入口（经子进程跑既有脚本），不在这里重写切题逻辑。
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { convertOxrResponse } from "./oxr-convert.js";
import { parsePdfWithOxr } from "./oxr-client.js";

type Flags = Record<string, string | true>;

/** 极简参数解析：`--key value` / `--flag`；其余为位置参数 */
function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const input = positional[0];

if (!input) {
  console.error(
    [
      "用法: npm run daily -- <pdf|layout.json|已解包目录> [选项]",
      "",
      "选项：",
      "  --id <docId>      文档 id（默认取文件名去扩展名）",
      "  --label <文本>    成品页下拉里显示的名字",
      "  --kind <quiz|answer>  默认按文件名是否含「答案」判断",
      "  --no-ocr          跳过整页 OCR 补行",
      "  --force-parse     强制重新调用 MinerU 解析（默认幂等）",
      "  --parser <name>   解析引擎：mineru（默认）| oxr（免费档，超 20 页/10MB 自动分片）",
      "  --reuse-oxr       复用已有 oxr-response.json 重新转换（不调 OXR API；代码修复后重生成用）",
    ].join("\n"),
  );
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, "..");
const OUT_ROOT = join(ROOT, "data", "out");

/** 跑一个 Node 脚本（tsx 直跑 TS），stdout 直接透传 */
function run(script: string, args: string[]): void {
  execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", script), ...args], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
}

/**
 * 本机是否有 Clash 的混合端口在监听。
 *
 * 为什么需要（2026-10-28 实测，DECISIONS §44/§45）：这份环境里 **MinerU 的 CDN 直连会被
 * TLS 重置**（`ECONNRESET`，4–31ms 即断；`--noproxy` 真直连也一样），而**走 Clash 代理
 * 稳定 200**（实测 57MB 的 zip 5.7 秒下完）。node 的 fetch **不读 `HTTP(S)_PROXY`**，
 * 所以必须在进程里显式给 `MINERU_PROXY`。
 *
 * 判据：只认「端口在监听」，不猜节点是否可用 —— 代理不通时 real-pipeline 会报错，
 * 那时加 `--no-proxy` 走直连（或换网络）。
 */
function detectLocalProxy(): string | null {
  for (const port of [7897, 7890, 1087]) {
    try {
      execFileSync("nc", ["-z", "-w", "1", "127.0.0.1", String(port)], { stdio: "ignore" });
      return `http://127.0.0.1:${port}`;
    } catch {
      /* 该端口没在监听，试下一个 */
    }
  }
  return null;
}

/** OCR 凭据是否可用（与 ocr-lib.readToken 同源，但**不打印 token**） */
function hasOcrToken(): boolean {
  if (process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN) return true;
  const cfg = join(homedir(), ".workbuddy-ai", "mcp.json");
  if (!existsSync(cfg)) return false;
  try {
    const j = JSON.parse(readFileSync(cfg, "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    return Boolean(j?.mcpServers?.["PaddleOCR-VL-1.6"]?.env?.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN);
  } catch {
    return false;
  }
}

/**
 * 从**产物**推断来源（不读旧 meta —— 旧值会一轮轮传下去，越传越离谱）：
 * `oxr-response.json` 存在 ⇒ 这卷是 OXR 解析的（分支 `feature/oxr` 专用）；
 * 否则 `layout.json` 只可能来自 MinerU；`ocr-page-fill.json` 存在即说明补行跑过。
 */
function inferSource(outDir: string): Meta["source"] {
  const hasOxr = existsSync(join(outDir, "oxr-response.json"));
  const hasFuse = existsSync(join(outDir, "fuse.json"));
  return {
    pdf: existsSync(join(outDir, "origin.pdf")),
    parser: hasFuse ? "fuse" : hasOxr ? "oxr" : existsSync(join(outDir, "layout.json")) ? "mineru" : "prebuilt",
    ocr: existsSync(join(outDir, "ocr-page-fill.json")) ? "page" : "skipped",
  };
}

interface Meta {
  id: string;
  label: string;
  kind: "quiz" | "answer";
  importedAt: string;
  source: { pdf: boolean; parser: "mineru" | "oxr" | "fuse" | "prebuilt"; ocr: "page" | "skipped" | "failed" };
  stats: {
    pages: number;
    questions: number;
    groups: number;
    needsReview: number;
    ocrFilled: number;
    suppressed: number;
    contentUncovered: number;
    inkCoveragePct: number | null;
    missingNumberGroups: number;
    /** 人工修正里未逐条回原卷核对但已应用的条数（2026-10-28 新增；>0 时体检告警） */
    correctionsUnverified: number;
    /** OCR 产物“存在但读不动”的错误条数（>0 时题号补行可能被跳过） */
    ocrInputErrors: number;
    /** 修正清单里已标记 disabled、未应用的条数（人工核对为重复；保留可审计） */
    correctionsDisabled: number;
  };
  /** `short` = 顶部工具栏那一枚胶囊的文案（一行放得下）；`issues` = 展开后的完整原因 */
  health: { level: "ok" | "warn" | "fail"; short: string; issues: string[] };
  /** OCR 补行失败的原因（source.ocr="failed" 时非空；成功/跳过为 null） */
  ocrError: string | null;
}

/** 从产物算体检摘要 —— 数字全部来自落盘文件，不从内存里猜 */
function buildMeta(docId: string, label: string, kind: "quiz" | "answer", src: Meta["source"], ocrError: string | null = null): Meta {
  const outDir = join(OUT_ROOT, docId);
  const qPath = join(outDir, "questions.json");
  const sPath = join(outDir, "stages.json");
  if (!existsSync(qPath) || !existsSync(sPath)) {
    throw new Error(`产物缺失：${qPath} 或 ${sPath} 不存在（导出步骤可能失败）`);
  }
  const questions = JSON.parse(readFileSync(qPath, "utf8")) as {
    number: string;
    chapter?: string;
    sectionSeq?: number;
    status?: string;
  }[];
  const snap = JSON.parse(readFileSync(sPath, "utf8")) as {
    pages: { ocrFill?: { accepted?: boolean }[]; uncovered?: { kind?: string }[] }[];
    reviews?: { reason?: string }[];
    inkCoverage?: { ratio: number; contentCount: number } | null;
    corrections?: { unverified?: number[]; disabled?: number[] } | null;
    ocrInputErrors?: string[];
  };

  // 组 = (章, 节序)；组内题号是否 1..N 连续（缺号合法但要如实报数）
  const groups = new Map<string, number[]>();
  for (const q of questions) {
    const k = `${q.chapter ?? "?"}|${q.sectionSeq ?? "?"}`;
    groups.set(k, [...(groups.get(k) ?? []), Number(q.number)]);
  }
  let missingNumberGroups = 0;
  for (const nums of groups.values()) {
    const sorted = [...nums].sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1)) missingNumberGroups++;
  }

  const ocrFilled = snap.pages.reduce(
    (n, p) => n + (p.ocrFill ?? []).filter((x) => x.accepted).length,
    0,
  );
  const suppressed = (snap.reviews ?? []).filter((r) => /未作为题目/.test(r.reason ?? "")).length;
  const needsReview = questions.filter((q) => q.status === "needs_review").length;
  const correctionsUnverified = snap.corrections?.unverified?.length ?? 0;
  const correctionsDisabled = snap.corrections?.disabled?.length ?? 0;
  const ocrInputErrors = (snap.ocrInputErrors ?? []).length;

  const issues: string[] = [];
  if (questions.length === 0) issues.push("没有切出任何题目（先看阶段 4 质检，多半是版式未识别）");
  if (ocrError) issues.push(`OCR 补行失败：${ocrError}（成品页仍可用，但漏读行可能未补）`);
  if (needsReview > 0) issues.push(`${needsReview} 题标记为需人工校对（点题号牌看原因）`);
  if (missingNumberGroups > 0) issues.push(`${missingNumberGroups} 个编号组的题号不连续（可能缺题）`);
  if (ocrInputErrors > 0) {
    issues.push(`OCR 产物有 ${ocrInputErrors} 处解析失败（题号补行可能被跳过，详见 stages.json 的 ocrInputErrors）`);
  }
  if (correctionsUnverified > 0) {
    issues.push(`${correctionsUnverified} 条人工修正未逐条回原卷核对（已应用，需抽查）`);
  }

  const short =
    questions.length === 0
      ? "未切出题目"
      : ocrError
        ? "OCR 失败"
        : needsReview > 0
        ? `${needsReview} 题待校对`
        : missingNumberGroups > 0
          ? `${missingNumberGroups} 组缺号`
          : ocrInputErrors > 0
            ? "OCR 输入异常"
            : correctionsUnverified > 0
              ? `${correctionsUnverified} 条修正待核`
              : "通过";

  return {
    id: docId,
    label,
    kind,
    importedAt: new Date().toISOString(),
    source: src,
    stats: {
      pages: snap.pages.length,
      questions: questions.length,
      groups: groups.size,
      needsReview,
      ocrFilled,
      suppressed,
      contentUncovered: snap.inkCoverage?.contentCount ?? 0,
      inkCoveragePct: snap.inkCoverage ? Number((snap.inkCoverage.ratio * 100).toFixed(2)) : null,
      missingNumberGroups,
      correctionsUnverified,
      correctionsDisabled,
      ocrInputErrors,
    },
    health: { level: questions.length === 0 ? "fail" : issues.length ? "warn" : "ok", short, issues },
    ocrError,
  };
}

// 合并说明（2026-10-28）：本分支给 main() 加了 async（`--parser oxr` 分支需要 await 解析），
// main 那边加了「MinerU 出网走代理」——两者都要：保留 async，同时保留代理检测。
async function main(): Promise<void> {
  // MinerU 出网：直连会被 TLS 重置 ⇒ 本机有代理就默认走它（`--no-proxy` 可强制直连）
  if (!process.env.MINERU_PROXY && flags["no-proxy"] !== true) {
    const proxy = detectLocalProxy();
    if (proxy) {
      process.env.MINERU_PROXY = proxy;
      console.log(`MinerU 出网：走本机代理 ${proxy}（直连 CDN 会被 TLS 重置，见 DECISIONS §45）`);
    } else {
      console.log("MinerU 出网：直连（本机未发现 7897/7890/1087 代理端口）");
    }
  }
  const abs = resolve(input!);
  if (!existsSync(abs)) {
    console.error(`输入不存在：${abs}`);
    process.exit(2);
  }
  const st = statSync(abs);
  const isPdf = st.isFile() && extname(abs).toLowerCase() === ".pdf";
  const isLayout = st.isFile() && basename(abs) === "layout.json";
  const isDir = st.isDirectory();

  if (!isPdf && !isLayout && !isDir) {
    console.error(`不认识的输入：${abs}（要 .pdf / layout.json / 已解包目录）`);
    process.exit(2);
  }

  // ---- 决定 docId 与产物目录 ----
  const docId =
    (typeof flags.id === "string" ? flags.id : undefined) ??
    (isPdf ? basename(abs, extname(abs)) : basename(isDir ? abs : resolve(abs, "..")));
  const outDir = join(OUT_ROOT, docId);
  mkdirSync(outDir, { recursive: true });

  const kind: "quiz" | "answer" =
    flags.kind === "quiz" || flags.kind === "answer"
      ? flags.kind
      : /答案|解析/.test(docId)
        ? "answer"
        : "quiz";
  const label =
    typeof flags.label === "string"
      ? flags.label
      : `${kind === "quiz" ? "题册" : "答案册"} · ${docId}`;

  console.log(`\n=== 导入 ${docId}（${kind === "quiz" ? "题册" : "答案册"}） ===`);
  console.log(`产物目录 ${outDir}`);

  // --meta-only：只刷新体检摘要（产物已就位时用；不重跑导出，不动快照）
  if (flags["meta-only"] === true) {
    // source 从**产物**推断，不读旧 meta（旧 meta 可能带着上一轮的默认值，越传越错）
    writeMeta(docId, label, kind, inferSource(outDir), null);
    return;
  }

  // ---- ① 拿解析结果 ----
  let layoutPath = join(outDir, "layout.json");
  let parser: "mineru" | "oxr" | "prebuilt" = "prebuilt";

  if (isPdf) {
    // ⚠️ 命名是硬约定：export-stages 在「layout.json 所在目录」里找 `*_origin.pdf`
    // 来生成页图与墨迹覆盖率。写成裸 `origin.pdf` 它会找不到 ⇒ 静默降级成「没有页图」，
    // 而页图正是「解析漏了什么」的唯一地面真值（2026-10-27 实测踩过）。
    copyFileSync(abs, join(outDir, `${docId}_origin.pdf`));
    const cachedOxr = join(outDir, "oxr-response.json");
    const reuseOxr = flags["reuse-oxr"] === true && existsSync(cachedOxr);
    const needParse = flags["force-parse"] === true || reuseOxr || !existsSync(layoutPath);
    if (needParse && (flags["parser"] === "oxr" || reuseOxr)) {
      // OXR 第二解析源（分支 feature/oxr）。与 MinerU **走完全相同的下游**：
      // 产出的 layout.json 是同构格式，②导出 / ③OCR补行 / ④体检原样复用 —— 引擎一行不改。
      let resp;
      if (reuseOxr) {
        // 代码修复后重生成：原始响应已在本地，不重复调 OXR API（省时省钱，2026-10-28）。
        console.log("\n[1/4] OXR 复用缓存响应（--reuse-oxr，不调 API）…");
        resp = JSON.parse(readFileSync(cachedOxr, "utf8"));
      } else {
        console.log("\n[1/4] OXR 解析（免费档；超 20 页或 10MB 自动分片）…");
        resp = await parsePdfWithOxr(abs, { onProgress: (m) => console.log(`  ${m}`) });
        // 原始响应落盘：① 便于事后复现/复核 ② inferSource 靠它判定 parser="oxr"
        writeFileSync(cachedOxr, JSON.stringify(resp));
      }
      const conv = await convertOxrResponse(resp, { docId, outDir, onProgress: (m) => console.log(`  ${m}`) });
      writeFileSync(layoutPath, JSON.stringify(conv.layout, null, 1));
      console.log(
        `  ${conv.stats.pages} 页 · ${conv.stats.lines} 行 · 图片 ${conv.stats.imageOk}/${conv.stats.imageBlocks} 落盘` +
          ` · 字号 p50 ${conv.stats.fontSize.p50}pt` +
          (conv.stats.dedupeDropped ? ` · 合并重复块 ${conv.stats.dedupeDropped}（补题号 ${conv.stats.dedupeMergedBadge}）` : ""),
      );
      parser = "oxr";
    } else if (needParse) {
      console.log("\n[1/4] MinerU 解析（首次或 --force-parse）…");
      // 解析先落到**临时目录**再搬进来：real-pipeline 的 docId 固定取文件名，
      // 直接写 data/out 会在「--id 与文件名不同」时覆盖同名目录（例如重跑样张会盖掉已验收产物）。
      const tmpRoot = join(ROOT, "data", "_parse-tmp");
      run("real-pipeline.ts", [abs, tmpRoot]);
      const parsedDir = join(tmpRoot, basename(abs, extname(abs)));
      if (!existsSync(parsedDir)) {
        throw new Error(`MinerU 解析完成但没找到产物目录：${parsedDir}`);
      }
      for (const f of ["layout.json", "content_list.json", "full.md", "result.zip", "summary.txt"]) {
        if (existsSync(join(parsedDir, f))) copyFileSync(join(parsedDir, f), join(outDir, f));
      }
      const parsedImages = join(parsedDir, "images");
      if (existsSync(parsedImages)) cpSync(parsedImages, join(outDir, "images"), { recursive: true });
      rmSync(tmpRoot, { recursive: true, force: true });
      parser = "mineru";
    } else {
      console.log("\n[1/4] 已有 layout.json，跳过解析（要重解析加 --force-parse）");
    }
  } else {
    // 已有解析结果：layout.json 文件本身，或含 layout.json 的目录
    const srcLayout = isLayout ? abs : join(abs, "layout.json");
    if (!existsSync(srcLayout)) {
      console.error(
        `目录里没有 layout.json：${srcLayout}\n` +
          `  这条路径只接受「已解包」的结果；要解析 PDF 请直接把 .pdf 传进来。`,
      );
      process.exit(2);
    }
    if (resolve(srcLayout) !== resolve(layoutPath)) copyFileSync(srcLayout, layoutPath);
    // 原卷 PDF 一并带过来（页图与墨迹覆盖率都靠它）。源目录可能有两种命名：
    // export 的 `*_origin.pdf` 约定，或早期手工放的 `origin.pdf` —— 都接受，统一搬成前者。
    const srcDir = isDir ? abs : resolve(abs, "..");
    const srcPdf =
      (existsSync(srcDir)
        ? readdirSync(srcDir).find((f) => f.endsWith("_origin.pdf"))
        : undefined) ?? (existsSync(join(srcDir, "origin.pdf")) ? "origin.pdf" : undefined);
    if (srcPdf && !existsSync(join(outDir, `${docId}_origin.pdf`))) {
      copyFileSync(join(srcDir, srcPdf), join(outDir, `${docId}_origin.pdf`));
    }
    // content_list / images 一并带过来（导出与图版核对要用）
    for (const extra of ["content_list.json"]) {
      const from = join(isDir ? abs : resolve(abs, ".."), extra);
      if (existsSync(from) && !existsSync(join(outDir, extra))) copyFileSync(from, join(outDir, extra));
    }
    const imgDir = join(isDir ? abs : resolve(abs, ".."), "images");
    const imgDest = join(outDir, "images");
    // ⚠️ 源与目标可能是**同一个目录**（直接对 `data/out/<doc>/layout.json` 跑时），
    // cpSync 会抛 EINVAL（2026-10-28 合订本导入实测）。同路径就什么都不用做。
    if (existsSync(imgDir) && resolve(imgDir) !== resolve(imgDest)) {
      mkdirSync(imgDest, { recursive: true });
      cpSync(imgDir, imgDest, { recursive: true });
    }
    console.log("\n[1/4] 使用已有解析结果（跳过 MinerU）");
  }

  if (!existsSync(layoutPath)) {
    console.error(
      `\n❌ 没有 layout.json（${layoutPath}）。\n` +
        `   MinerU 这次没产出 layout.json —— 该卷可能只回了 content_list。\n` +
        `   下一步：把该卷的 content_list.json 目录作为输入再跑一次，或到 stages 的「原料」视图核对。`,
    );
    process.exit(1);
  }

  // ---- ② 导出快照（页图 + 墨迹覆盖率）----
  console.log("\n[2/4] 导出快照（页图 / 墨迹覆盖率）…");
  run("export-stages.ts", [docId, layoutPath]);

  // ---- ③ OCR 整页补行（可选，自己会重导快照）----
  let ocr: Meta["source"]["ocr"] = "skipped";
  let ocrError: string | null = null;
  if (flags["no-ocr"] === true) {
    console.log("\n[3/4] 跳过 OCR 补行（--no-ocr）");
  } else if (!hasOcrToken()) {
    console.log(
      "\n[3/4] 跳过 OCR 补行：没有 PaddleOCR 凭据\n" +
        "      （env PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN，或 ~/.workbuddy-ai/mcp.json 的 PaddleOCR-VL-1.6）\n" +
        "      ⇒ 上游整行漏读的内容不会被补回；成品页仍可用，缺的行会在审计视图里标出来。",
    );
  } else if (!existsSync(join(outDir, "origin.pdf")) && !existsSync(join(outDir, `${docId}_origin.pdf`))) {
    console.log("\n[3/4] 跳过 OCR 补行：没有原卷 PDF（OCR 要按页渲染原卷）");
  } else {
    console.log("\n[3/4] 整页 OCR 补行（上游漏读的行）…");
    try {
      run("ocr-page-fill.ts", [docId]);
      ocr = "page";
    } catch (e) {
      // 不静默：OCR 失败是「少补了一些行」，不是「这份卷坏了」；但必须写进 meta/体检。
      ocr = "failed";
      ocrError = String((e as Error)?.message ?? e).slice(0, 200);
      console.log(
        `      ⚠️ OCR 补行失败：${ocrError}\n` +
          "         快照仍是完整可用的，只是少补了漏读行；稍后可单独重试：npm run stages:ocr-page -- \"" + docId + '"',
      );
    }
  }

  // ---- ④ 体检摘要 ----
  console.log("\n[4/4] 体检摘要…");
  writeMeta(docId, label, kind, {
    pdf: existsSync(join(outDir, "origin.pdf")),
    parser,
    ocr,
  }, ocrError);
}

/**
 * 写 `meta.json`（成品页据此发现文档 + 显示体检）。
 * 只读落盘产物算数字，不从内存里猜 —— 重算一次和重跑一遍必须得到同一个结论。
 */
function writeMeta(
  docId: string,
  label: string,
  kind: "quiz" | "answer",
  src: Meta["source"],
  ocrError: string | null = null,
): Meta {
  const outDir = join(OUT_ROOT, docId);
  const meta = buildMeta(docId, label, kind, src, ocrError);
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

  const s = meta.stats;
  console.log(
    [
      "",
      `✅ ${docId} 已就绪`,
      `   ${s.pages} 页 · ${s.questions} 题 · ${s.groups} 组` +
        (s.ocrFilled ? ` · OCR 补回 ${s.ocrFilled} 处` : "") +
        (s.suppressed ? ` · 抑制 ${s.suppressed} 条（方框条目，有记录）` : ""),
      `   墨迹未覆盖 ${s.inkCoveragePct ?? "—"}%（内容级 ${s.contentUncovered} 处）`,
      meta.health.level === "ok"
        ? "   体检：通过"
        : `   体检：${meta.health.level === "fail" ? "失败" : "有提示"} —— ${meta.health.issues.join("；")}`,
      "",
      `   打开成品页（下拉里已出现「${label}」）：`,
      `   http://localhost:4173/final/?doc=${encodeURIComponent(docId)}`,
      "",
    ].join("\n"),
  );
  return meta;
}

try {
  await main();
} catch (e) {
  console.error(`\n❌ 导入失败：${(e as Error)?.message ?? e}`);
  console.error("   排查顺序：① 是否有 layout.json ② MinerU 凭据/网络 ③ 上面最后一段脚本的报错");
  process.exit(1);
}
