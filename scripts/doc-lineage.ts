// scripts/doc-lineage.ts
/**
 * T6：给 `/api/docs` 的每册标注**血缘（lineage）**与**产物角色（artifact）**，
 * 让成品网页一眼区分「当前工作流（M5 切 OXR）的阶段性产物」与旧产物。
 *
 * 判据（可核对；与 tests/doc-lineage.test.ts 一一对应）：
 * - 目录名后缀 `-OXR`   → artifact=parse（OXR 解析件 / 切换前快照）
 * - 目录名后缀 `-MinerU` → artifact=backup（MinerU 原件备份）
 * - 目录名 `_tablecheck` → artifact=test（10-29 旧测试目录，B-52；不进列表）
 * - 其余无后缀          → artifact=prod（生产册）
 *
 * lineage（"oxr" | "mineru" | "mixed"）：
 * - `-OXR` / `-MinerU` 由目录名后缀直接定；
 * - 生产册看 `layout.json` 的顶层 `_backend`：
 *     `"pipeline"` → mineru（MinerU 后端原始输出）；
 *     **无该字段** → oxr —— 该目录的 layout 已被 dedup/fuse/切源再处理（lessons L7：
 *     「无 _backend = 被处理过」），不是 MinerU 原始件。
 * - 后缀推断与 `_backend` 记录**矛盾**时标 `mixed`，不猜（同红线「拿不准就显式标注」）。
 *
 * ⚠️ 本文件只做**标注**，不改写任何数据（红线：检测不改写）。
 */
import { open } from "node:fs/promises";

export type Lineage = "oxr" | "mineru" | "mixed";
export type Artifact = "prod" | "parse" | "backup" | "test";

export interface DocLineage {
  lineage: Lineage;
  artifact: Artifact;
}

/** 旧测试目录（B-52）：不进 `/api/docs` 列表，避免混进生产册里。 */
export const TEST_DOC_NAMES = ["_tablecheck"] as const;

/** `_backend` 在 layout.json **末尾**（顶层字段，见数据实测）；只读尾部即可，免的全量 parse 42MB。 */
const TAIL_BYTES = 4096;

/**
 * 读 layout.json 顶层的 `_backend`（如 "pipeline"）；读不到 / 无该字段 → undefined。
 * 不抛：标注缺失时按「无字段 = 已切源」处理，不影响列表可用性（见文件头注释）。
 * @param {string} layoutPath
 * @returns {Promise<string | undefined>}
 */
export async function readLayoutBackend(layoutPath: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(layoutPath, "r");
    const size = (await fh.stat()).size;
    const len = Math.min(TAIL_BYTES, size);
    if (len <= 0) return undefined;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const m = buf.toString("utf8").match(/"_backend"\s*:\s*"([^"]*)"/);
    return m?.[1];
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * 判定一册的 lineage / artifact。
 * @param {string} name data/out 下的目录名（docId）
 * @param {string | undefined} backend layout.json 的 `_backend`（生产册据此分 oxr/mineru）
 */
export function classifyDoc(name: string, backend: string | undefined): DocLineage {
  if ((TEST_DOC_NAMES as readonly string[]).includes(name)) {
    return { artifact: "test", lineage: backend === "pipeline" ? "mineru" : "oxr" };
  }
  const byName: Lineage | null = /-OXR$/.test(name) ? "oxr" : /-MinerU$/.test(name) ? "mineru" : null;
  const byBackend: Lineage | null = backend === "pipeline" ? "mineru" : backend === "oxr" ? "oxr" : null;
  const artifact: Artifact = byName === "oxr" ? "parse" : byName === "mineru" ? "backup" : "prod";
  // 后缀与 _backend 矛盾 → 不猜，标 mixed
  const lineage: Lineage = byName && byBackend && byName !== byBackend ? "mixed" : byName ?? byBackend ?? "oxr";
  return { artifact, lineage };
}
