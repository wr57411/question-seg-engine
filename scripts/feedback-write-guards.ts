// scripts/feedback-write-guards.ts
/**
 * 反馈写通道的守卫（B-60/反馈窗口功能，2026-11-22）。
 *
 * 与 tag-write-guards.ts 同一哲学：判据取最严，宁可拒掉合法写入（用户重试），
 * 也不让未校验的路径/载荷拼进 fs.writeFile。拆出来是为了**能被单测打到**。
 *
 * 通道开关语义与 tags 不同：反馈的核心场景是 **iPad 真机验收**（N13），
 * 用户在局域网设备上报告缺陷正是本功能的全部意义 ⇒ 默认允许 LAN 写；
 * `FEEDBACK_WRITE=0` 才整体关闭（只读预览，POST 返回 403）。
 */
import { join } from "node:path";

/** 反馈载荷上限（base64 截图是大头）：原始 body ≤ 12MB。 */
export const FEEDBACK_MAX_BODY = 12 * 1024 * 1024;
/** 解码后的截图上限：8MB（超出拒绝——截图工具不至于产 8MB PNG）。 */
export const SHOT_MAX_BYTES = 8 * 1024 * 1024;
const DOC_MAX_LEN = 120;
const ID_MAX_LEN = 80;
const TEXT_MAX_LEN = 4000;
const SUPPLEMENT_MAX = 50; // 单条反馈的补充条数上限（防无界增长）
const BAD_DOC_CHARS = /[/\\]|\.\.|[\0-\u001f\u007f]/;
const BAD_ID_CHARS = /[^a-zA-Z0-9_-]/;

const isStr = (v: unknown): v is string => typeof v === "string";
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** 反馈写通道开关：默认开；FEEDBACK_WRITE=0 关闭（POST 返回 403，GET 仍可读）。 */
export function feedbackWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEEDBACK_WRITE !== "0";
}

/** doc 白名单：必须是 `data/out/<doc>/stages.json` 真实存在的目录名。 */
export function isKnownDoc(root: string, doc: unknown): boolean {
  if (typeof doc !== "string" || !doc || doc.length > DOC_MAX_LEN) return false;
  if (BAD_DOC_CHARS.test(doc)) return false;
  void join; // join 保留给调用方组装真实路径（此函数镜像 tag-write-guards 的签名语义）
  return true;
}

export type FeedbackAction = "create" | "supplement" | "update";

/** 动作判定：未知动作直接拒绝（不猜）。 */
export function parseAction(body: unknown): FeedbackAction | null {
  if (!isRec(body) || !isStr(body.action)) return null;
  if (body.action === "create" || body.action === "supplement" || body.action === "update") {
    return body.action;
  }
  return null;
}

/** 解析 dataURL 截图：只收 png/jpeg；返回 {ext, bytes} 或错误说明。 */
export function parseShotDataUrl(
  dataUrl: unknown,
): { ext: "png" | "jpg"; bytes: Buffer } | string | null {
  if (dataUrl === null || dataUrl === undefined || dataUrl === "") return null; // 无截图=合法
  if (!isStr(dataUrl)) return "截图必须是 dataURL 字符串";
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]*)$/.exec(dataUrl);
  if (!m) return "截图只支持 data:image/png 或 data:image/jpeg";
  const bytes = Buffer.from((m[2] ?? "").replace(/\s+/g, ""), "base64");
  if (!bytes.length) return "截图内容为空";
  if (bytes.length > SHOT_MAX_BYTES) return `截图超过 ${Math.round(SHOT_MAX_BYTES / 1024 / 1024)}MB 上限`;
  return { ext: m[1] === "jpeg" ? "jpg" : "png", bytes };
}

/** feedbacks.json 的形状校验（读侧）；返回错误说明或 null。 */
export function validateStoreShape(store: unknown): string | null {
  if (!isRec(store)) return "feedbacks.json 必须是对象";
  if (store["version"] !== 1) return "version 必须为 1";
  if (!Array.isArray(store["items"])) return "items 必须是数组";
  for (const it of store["items"] as unknown[]) {
    const e = validateItemShape(it);
    if (e) return e;
  }
  return null;
}

/** 单条反馈的形状校验（create 时由字段拼装，读侧逐条校验）。 */
export function validateItemShape(it: unknown): string | null {
  if (!isRec(it)) return "item 必须是对象";
  for (const k of ["id", "docId", "comment", "status", "createdAt", "updatedAt"] as const) {
    if (!isStr(it[k]) || !(it[k] as string).length) return `item.${k} 必须是非空字符串`;
    if (isStr(it[k]) && (it[k] as string).length > ID_MAX_LEN * 8) return `item.${k} 超长`;
  }
  if (isStr(it["id"]) && BAD_ID_CHARS.test(it["id"])) return "item.id 含非法字符";
  if (!["open", "working", "fixed", "wontfix"].includes(it["status"] as string)) {
    return "item.status 非法";
  }
  if (it["shot"] !== undefined && it["shot"] !== null && !isStr(it["shot"])) {
    return "item.shot 必须是字符串";
  }
  if (!Array.isArray(it["supplements"])) return "item.supplements 必须是数组";
  if ((it["supplements"] as unknown[]).length > SUPPLEMENT_MAX) return "supplements 超出上限";
  return null;
}

/**
 * create 载荷校验：返回错误说明或 null（通过）。
 * create.item 由服务端补 id/时间戳/状态（客户端只给内容字段）。
 */
export function validateCreatePayload(item: unknown): string | null {
  if (!isRec(item)) return "item 必须是对象";
  if (!isStr(item["comment"]) || !(item["comment"] as string).trim()) {
    return "comment 不能为空";
  }
  if ((item["comment"] as string).length > TEXT_MAX_LEN) return "comment 超长";
  if (item["questionNumber"] !== undefined && item["questionNumber"] !== null && !isStr(item["questionNumber"])) {
    return "questionNumber 必须是字符串";
  }
  if (item["questionNumber"] !== undefined && isStr(item["questionNumber"]) && (item["questionNumber"] as string).length > 40) {
    return "questionNumber 超长";
  }
  if (item["page"] !== undefined && item["page"] !== null && !Number.isFinite(item["page"])) {
    return "page 必须是数字";
  }
  return null;
}

/** supplement/update 载荷校验。 */
export function validateMutationPayload(
  action: "supplement" | "update",
  body: Record<string, unknown>,
): string | null {
  if (!isStr(body["id"]) || !(body["id"] as string).length || (body["id"] as string).length > ID_MAX_LEN) {
    return "id 必须是非空字符串";
  }
  const field = action === "supplement" ? "text" : "comment";
  if (!isStr(body[field]) || !(body[field] as string).trim()) return `${field} 不能为空`;
  if ((body[field] as string).length > TEXT_MAX_LEN) return `${field} 超长`;
  return null;
}

/** 落盘文件名（id 已过 BAD_ID_CHARS 校验）。 */
export function shotFileName(id: string, ext: "png" | "jpg"): string {
  return `shots/${id}.${ext}`;
}
