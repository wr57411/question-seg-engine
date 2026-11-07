// scripts/check-stamp.mjs
/**
 * 质量门通过凭证：把「scripts/ + src/ 当前改动」的指纹写到 `tmp/.check-stamp`。
 *
 * 存在理由（2026-11-06）：`npm run check` 是项目硬性条件，但此前只能靠自觉执行。
 * Stop hook（`~/.workbuddy-ai/hooks/qseg-check-guard.mjs`）需要判断「改动后到底跑没跑过门」，
 * 而它无法观察一次已经结束的命令 —— 所以由 check 自己在**全绿之后**留痕。
 *
 * 挂在 `npm run check` 末尾（`&&` 串联）：门失败时不会执行到这里，凭证不刷新，
 * 于是 hook 会继续拦住「改了代码却声称完成」的收尾。
 *
 * 只读 git、只写一个临时文件；任何异常都 exit 0，绝不把质量门带红。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PATHS = ["scripts", "src"];

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * 未跟踪文件（`??`）不在 `git diff HEAD` 里，且新增后内容再变 `git status` 也看不出差异
 * ⇒ 必须逐文件算内容哈希，否则「新增一个脚本后反复改它」永远检测不到。
 */
function untrackedDigest(status) {
  const files = status
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .sort();
  return files
    .map((f) => {
      try {
        return `${f}:${createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 10)}`;
      } catch {
        return `${f}:unreadable`;
      }
    })
    .join("\n");
}

try {
  const diff = git(["diff", "HEAD", "--", ...PATHS]);
  const status = git(["status", "--porcelain", "--", ...PATHS]);
  const untracked = untrackedDigest(status);
  const fingerprint = createHash("sha256")
    .update(`${diff}\n---\n${status}\n---\n${untracked}`)
    .digest("hex")
    .slice(0, 16);
  if (process.argv.includes("--print")) {
    // 只算不写：供 Stop hook 取「当前改动指纹」，避免指纹算法在 hook 里再实现一份
    console.log(fingerprint);
  } else {
    mkdirSync("tmp", { recursive: true });
    writeFileSync("tmp/.check-stamp", `${fingerprint}\n`);
    console.log(`质量门凭证：${fingerprint}`);
  }
} catch {
  // 凭证是辅助设施，写不了也不能影响质量门结果
}
