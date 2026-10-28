/**
 * oxr-verify-sheet.ts —— 生成「候选核对表」：把多条候选的原卷裁图排成一张长图
 *
 * 为什么不在对话里逐张看图：49 条候选 = 49 次看图，慢且易漏。
 * 这里按候选逐条裁原卷、内嵌为 base64 排进 HTML，一次截图就能整体核对。
 *
 * 判据仍是「回原卷看」：每格显示的是**原卷页图上该位置的裁图**，
 * 不是 OXR 的结论 —— 人看图判断"这里到底印没印这个字"。
 *
 * 用法：npx tsx scripts/oxr-verify-sheet.ts "<docA>" "<docB>" ...
 * 输出：tmp/verify/sheet-<i>.html（供 Chrome 截图）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const A4_WIDTH_PT = 596;
const OUT_DIR = "tmp/verify";

interface Item {
  doc: string;
  page: number;
  kind: "O2ZERO" | "CAPTION_MISSING";
  text: string;
  bbox?: number[];
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法：npx tsx scripts/oxr-verify-sheet.ts "<docId>" ...');
  process.exit(2);
}

const crosscheck = JSON.parse(readFileSync("data/oxr/crosscheck.json", "utf8")) as {
  doc: string;
  page: number;
  kind: "O2ZERO" | "CAPTION_MISSING";
  oxr: string;
  mineru: string;
}[];

function norm(s: string): string {
  return s.replace(/[\s\u3000]/g, "").replace(/[，。、；：？！,.;:?!"'“”‘’（）()【】\[\]·]/g, "");
}

/** 取候选在原卷页图上的 bbox（pt）：图注来自 OXR 响应，O→0 来自 MinerU stages */
function bboxOf(doc: string, it: { page: number; kind: string; oxr: string; mineru: string }):
  | { bbox: number[]; scale: number }
  | null {
  const oxrDoc = `${doc}-OXR`;
  const respPath = join("data", "out", oxrDoc, "oxr-response.json");
  if (!existsSync(respPath)) return null;
  const resp = JSON.parse(readFileSync(respPath, "utf8")) as {
    data?: { result?: { outputs?: { json?: { pages?: unknown[] } } } };
    pages?: unknown[];
  };
  const pages =
    (resp.data?.result?.outputs?.json?.pages as { page_size?: { w?: number }; blocks?: Record<string, unknown>[] }[]) ??
    (resp.pages as { page_size?: { w?: number }; blocks?: Record<string, unknown>[] }[]) ??
    [];
  const pg = pages[it.page - 1];
  if (!pg) return null;
  const pw = Number(pg.page_size?.w) || 1243;
  const scale = A4_WIDTH_PT / pw;

  if (it.kind === "CAPTION_MISSING") {
    const want = norm(it.oxr);
    for (const b of pg.blocks ?? []) {
      const t = String(b.type ?? "").toLowerCase();
      if (t !== "caption" && t !== "figure_caption") continue;
      if (norm(String(b.content ?? "")) !== want) continue;
      const bb = b.bbox as number[] | undefined;
      if (bb && bb.length >= 4) return { bbox: bb.map((v) => v * scale), scale };
    }
    return null;
  }

  // O→0：定位 MinerU 侧含 `0点` 的块（pt 已是 596 系，scale=1）
  const stagesPath = join("data", "out", doc, "stages.json");
  if (!existsSync(stagesPath)) return null;
  const snap = JSON.parse(readFileSync(stagesPath, "utf8")) as {
    pages?: { blocks?: { text?: string; bbox?: number[] }[] }[];
  };
  const blk = (snap.pages?.[it.page - 1]?.blocks ?? []).find((b) => /[0０][点角]/.test(b.text ?? ""));
  if (!blk?.bbox) return null;
  return { bbox: blk.bbox, scale: 1 };
}

mkdirSync(OUT_DIR, { recursive: true });
const cells: string[] = [];
let idx = 0;
// 分批：长表一张截图看不清（sips 分段裁切的位置还不可控），改成每次只渲染一段。
// 用环境变量 FROM/TO 指定（1-based，含两端）。
const FROM = Number(process.env.FROM ?? 1);
const TO = Number(process.env.TO ?? 9999);

for (const doc of targets) {
  const items = crosscheck.filter((x) => x.doc === doc);
  for (const it of items) {
    idx++;
    if (idx < FROM || idx > TO) continue;
    const got = bboxOf(doc, it);
    // 页图命名两种都有：多数卷 `page-01.png`（补零），`光学` 是 `page-1.png`（不补零）
    const pageDir = join("data", "out", doc, "pages");
    const pagePng =
      [
        join(pageDir, `page-${String(it.page).padStart(2, "0")}.png`),
        join(pageDir, `page-${it.page}.png`),
      ].find(existsSync) ?? join(pageDir, `page-${String(it.page).padStart(2, "0")}.png`);
    let img = "";
    let note = "";
    if (!got) {
      note = "（取不到 bbox）";
    } else {
      try {
        const probe = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", pagePng], { encoding: "utf8" });
        const W = Number(/pixelWidth:\s*(\d+)/.exec(probe)?.[1] ?? 0);
        const H = Number(/pixelHeight:\s*(\d+)/.exec(probe)?.[1] ?? 0);
        const px = W / A4_WIDTH_PT; // 页图像素 / pt
        const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = got.bbox;
        // 留上下文：左右 60px、上方 110px（看清图注是挂在哪幅图下）
        const x0 = Math.max(0, Math.round(bx0 * px - 60));
        const x1 = Math.min(W, Math.round(bx1 * px + 60));
        const y0 = Math.max(0, Math.round(by0 * px - 110));
        const y1 = Math.min(H, Math.round(by1 * px + 60));
        const w = x1 - x0;
        const h = y1 - y0;
        if (w < 20 || h < 20) {
          note = "（区域过小）";
        } else {
          const tmp = join(OUT_DIR, `crop-${idx}.png`);
          execFileSync("sips", ["-c", String(h), String(w), "--cropOffset", String(y0), String(x0), pagePng, "--out", tmp]);
          img = readFileSync(tmp).toString("base64");
        }
      } catch (e) {
        note = `（裁切失败：${e instanceof Error ? e.message.slice(0, 40) : e}）`;
      }
    }
    const label = it.kind === "O2ZERO" ? `O→0 · MinerU「${it.mineru.slice(0, 26)}」` : `图注 · OXR「${it.oxr}」`;
    cells.push(`
      <div class="row">
        <div class="hd"><b>#${idx}</b> ${doc} p${it.page}<br><span>${label}</span></div>
        <div class="im">${img ? `<img src="data:image/png;base64,${img}">` : `<span class="miss">${note}</span>`}</div>
      </div>`);
  }
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;padding:14px;background:#fff;color:#111;}
h1{font-size:15px;margin:0 0 10px;}
.tip{font-size:12px;color:#666;margin:0 0 12px;}
.row{display:flex;gap:12px;align-items:flex-start;border-bottom:1px solid #eee;padding:8px 0;}
.hd{width:250px;flex:none;font-size:12px;line-height:1.5;}
.hd span{color:#666;}
.im{flex:1;}
.im img{max-width:100%;border:1px solid #ddd;}
.miss{color:#c00;font-size:12px;}
</style></head><body>
<h1>候选核对表 · 第 ${FROM}–${TO} 条（共 ${idx} 条；${targets.join(" / ")}）</h1>
<p class="tip">每格是**原卷页图上该位置的裁图**。看图判断：这里到底印没印那个字 / 那张图下有没有「甲」「乙」。</p>
${cells.join("")}
</body></html>`;

const outFile = `sheet-${FROM}-${TO}.html`;
writeFileSync(join(OUT_DIR, outFile), html);
console.log(`✓ tmp/verify/${outFile}（渲染 ${cells.length} 条，总量 ${idx}）`);
