// meta-consistency.test.ts —— 体检摘要（meta.json）必须与产物同步。
//
// 成品页头部与 /api/docs 只读 meta.json 的 stats；10-30 重生成走导出路径时没重算 meta，
// 6 册页头显示错误题数（电路 31 vs 实际 30、机械能守恒 38 vs 48，2026-10-30 接管复查实测）。
// 数字可以重算，来源（pdf/parser/ocr）与 importedAt 由 daily --meta-only 沿用旧记录，不在此门范围。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "data", "out");
const hasData = existsSync(OUT);

const DIRS = hasData
  ? readdirSync(OUT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(
        (d) =>
          existsSync(join(OUT, d, "meta.json")) &&
          existsSync(join(OUT, d, "questions.json")) &&
          existsSync(join(OUT, d, "stages.json")),
      )
  : [];

test(
  "meta.json 的页数/题数与产物一致（体检摘要不撒谎）",
  { skip: hasData ? false : "无 data/out：运行时产物未生成，本门跳过（不是通过）" },
  () => {
    assert.ok(DIRS.length > 0, "有 data/out 但没有任何可校验的文档，门是死的");
    const bad: string[] = [];
    for (const d of DIRS) {
      const meta = JSON.parse(readFileSync(join(OUT, d, "meta.json"), "utf8")) as {
        stats?: { pages?: number; questions?: number };
      };
      const raw = JSON.parse(readFileSync(join(OUT, d, "questions.json"), "utf8")) as unknown;
      const questions = Array.isArray(raw) ? raw : ((raw as { questions?: unknown[] }).questions ?? []);
      const snap = JSON.parse(readFileSync(join(OUT, d, "stages.json"), "utf8")) as {
        pages?: unknown[];
      };
      if (meta.stats?.questions !== questions.length) {
        bad.push(`${d}: meta.questions=${meta.stats?.questions}，实际 ${questions.length}`);
      }
      if (meta.stats?.pages !== snap.pages?.length) {
        bad.push(`${d}: meta.pages=${meta.stats?.pages}，实际 ${snap.pages?.length}`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      `体检摘要与产物不一致（跑 \`npm run daily -- "data/out/<docId>" --id "<docId>" --meta-only\` 刷新）：\n${bad.join("\n")}`,
    );
  },
);
