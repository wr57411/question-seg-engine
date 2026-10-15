// dts-drift.test.ts —— 「手写 .d.ts 会不会对实现说谎」的漂移门。
//
// 为什么需要它：展示层是浏览器**直接加载的 .js**（没有构建步骤），类型靠旁边一份手写 `.d.ts`。
// 但 `.d.ts` 会整体**遮蔽**同名 `.js` —— tsc 从不校验两者一致。于是声明可以随便说谎：
// 实测过一次，`final/tag-store.d.ts` 里写着 `export const TAG_ROOT`，实现里 `TAG_ROOT`
// 根本没导出，`npm run typecheck` 全程绿。这类谎只有拿运行时真值去比对才看得见。
//
// 本门双向比对：
//   ① d.ts 声明了、实现里没有 ⇒ 红（消费方会 import 到 undefined，运行才炸）；
//   ② 实现导出了、d.ts 没写 ⇒ 红（TS 侧看不见，早晚有人再手抄一份，抄漏就是这次）。
//
// ⚠️ 已知局限：只比对**值导出**的名字集合，不比对类型与签名（那要 `checkJs`，见 DECISIONS §31）。
//    新增 `.js`/`.d.ts` 配对时把路径加进 PAIRS，否则等于没锁。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 仍然手写 `.d.ts` 的模块（`tag-layout` / `tag-store` 已改为实现自带类型，不在列）。 */
const PAIRS = [
  "stages/block-dedup",
  "stages/font-metrics",
  "stages/latex-display",
  "stages/uncovered-layout",
  "stages/reconstruct",
  "viewer/doc-utils",
];

/** 从 .d.ts 里抠出值导出的名字：`export const x` / `export function x` / `export async function x` / `export class x`。 */
function declaredNames(dts: string): string[] {
  const re = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  return [...dts.matchAll(re)].map((m) => m[1] as string);
}

for (const rel of PAIRS) {
  test(`.d.ts 与实现不漂移：${rel}`, async () => {
    const dtsPath = `${ROOT}${rel}.d.ts`;
    const jsPath = `${ROOT}${rel}.js`;
    assert.ok(existsSync(dtsPath), `${rel}.d.ts 不见了（要么补回来，要么把这条从 PAIRS 删掉）`);
    const declared = new Set(declaredNames(readFileSync(dtsPath, "utf8")));
    const actual = new Set(Object.keys(await import(new URL(`../${rel}.js`, import.meta.url).href)));
    assert.ok(declared.size > 0, `${rel}.d.ts 里一个值导出都没解析到 —— 正则该修了，别把门变成死门`);
    const lies = [...declared].filter((n) => !actual.has(n));
    const hidden = [...actual].filter((n) => !declared.has(n));
    assert.deepEqual(lies, [], `${rel}.d.ts 声明了实现里不存在的东西：${lies.join(", ")}`);
    assert.deepEqual(hidden, [], `${rel}.js 导出了但 .d.ts 没写：${hidden.join(", ")}`);
  });
}
