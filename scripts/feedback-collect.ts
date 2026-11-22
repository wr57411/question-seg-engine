// scripts/feedback-collect.ts —— 反馈收集器（2026-11-22 用户需求：自动收集新反馈排进流程）
//
// 扫 data/out/feedback/feedbacks.json，把未处理（status=open）反馈列为**处理队列**；
// 处理闭环 = 逐条看截图 + 回原卷裁定 → 修/登记 → status=working/fixed + reply 回写
// （可 POST /api/feedback {action:"update"} 或直接改 json——数据单一事实源就是它）。
// 开工自检：每轮会话开工先跑 `npm run feedback:collect`（已写进 HANDOFF §9.5 流程）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const file = join("data", "out", "feedback", "feedbacks.json");
if (!existsSync(file)) {
  console.log("（无反馈库——还没有人通过成品页/阶段页的「反馈」窗口提交过）");
  process.exit(0);
}
const store = JSON.parse(readFileSync(file, "utf8")) as {
  version?: number;
  items?: { id: string; docId: string; page?: number | null; questionNumber?: string; comment: string; shot?: string | null; status: string; reply?: string }[];
};
const items = store.items ?? [];
const open = items.filter((i) => i.status === "open");
const working = items.filter((i) => i.status === "working");
const fixed = items.filter((i) => i.status === "fixed");
console.log(
  `反馈库：共 ${items.length} 条 | 待处理(open) ${open.length} | 处理中(working) ${working.length} | 已修(fixed) ${fixed.length}`,
);
if (!open.length) {
  console.log("✅ 无待处理反馈");
  process.exit(0);
}
console.log("\n== 待处理队列（按提交序） ==");
for (const it of open) {
  console.log(`[${it.id}] ${it.docId} p${it.page ?? "?"}${it.questionNumber ? " #" + it.questionNumber : ""}`);
  console.log(`  现象: ${it.comment.slice(0, 110)}${it.comment.length > 110 ? "…" : ""}`);
  if (it.shot) console.log(`  截图: data/out/feedback/${it.shot}`);
}
console.log("\n处理方式：逐条看截图+回原卷裁定 → 修/登记台账 → status=working/fixed + reply 回写。");
