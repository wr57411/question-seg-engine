// scripts/teach-manage.ts
/**
 * 专题 / 类别「改名、删除」的**服务端计划**（纯函数，不碰磁盘、不发请求）。
 *
 * 为什么放在服务端：删除一个专题要同时动
 *   `topics.json` + **所有卷**的 `bindings/<doc>.json` + `combos.json`，
 * 客户端只看得见当前这一卷，让它逐文件写会出现「删了一半」的中间态（ticket 006 明令禁止）。
 * 这里只算「应该写成什么样」，落盘与回滚由 view-server 负责，判据与 I/O 因此可分别单测。
 *
 * 保守改写：只改必要字段（name / topicIds / categoryIds / 条目增删），
 * 其余字段原样保留——不做整份重建，避免把不认识但将来要用的字段洗掉。
 */

const ID_MAX_LEN = 80;
const NAME_MAX_LEN = 60;
/** id 只用来匹配文件里的条目，不参与拼路径；仍然收紧字符集，异常输入直接拒。 */
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type TeachKind = "topics" | "categories";
/**
 * rename   改名（按 id 更新，一题归属都不动）
 * retire   **下架**（软删除）：清单里标 retired，题目上的归属一个都不摘，可 restore 恢复
 * restore  恢复下架项
 * delete   彻底清除（跨所有卷摘引用）——服务端已实现并有测试，**界面暂未开放**
 */
export type ManageAction = "rename" | "retire" | "restore" | "delete";
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export interface ManageRequest {
  action: ManageAction;
  kind: TeachKind;
  id: string;
  name?: string;
}

/** 校验管理请求本身（不含数据形状）；返回错误说明或 null。 */
export function validateManageRequest(body: unknown): string | null {
  if (!isRec(body)) return "请求必须是 JSON 对象";
  if (body.kind !== "topics" && body.kind !== "categories") return "kind 只能是 topics / categories";
  if (body.action !== "rename" && body.action !== "retire" && body.action !== "restore" && body.action !== "delete") {
    return "action 只能是 rename / retire / restore / delete";
  }
  if (!isStr(body.id) || !ID_RE.test(body.id)) return `id 只能是字母/数字/-/_（≤${ID_MAX_LEN}）`;
  if (body.action === "rename" && (!isStr(body.name) || !body.name.trim() || body.name.trim().length > NAME_MAX_LEN)) {
    return `改名必须给非空名字（≤${NAME_MAX_LEN}）`;
  }
  return null;
}

export interface ManageInput extends ManageRequest {
  /** topics.json / categories.json 原文（null = 文件不存在，视为空清单） */
  list: unknown;
  /** combos.json 原文 */
  combos: unknown;
  /** 所有卷的 bindings 原文；doc = 文件名去掉 .json */
  bindings: { doc: string; raw: unknown }[];
  /** 注入时间戳，便于单测确定性 */
  now: string;
}

export interface BindingsFile {
  doc: string;
  payload: Rec;
}

export type ManagePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** 被摘掉这条归属的活题数（删除时）/ 当前在用它活题数（改名时，仅提示） */
      affected: number;
      /** 其中已漂移（stale）的题数 */
      staleAffected: number;
      /** 被改动的组合数（含被删掉的） */
      combosChanged: number;
      /** 因成员清空而被删掉的组合数 */
      combosDropped: number;
      listPayload: Rec;
      combosPayload: Rec | null;
      bindingsFiles: BindingsFile[];
      /** 下架/恢复/改名后的新名字；彻底清除时被清掉的组合数见 combosDropped */
      itemName: string;
      /** 这一项现在还在多少题上挂着（下架时如实告诉用户"题上没动"） */
      stillAssigned: number;
    };

function listArray(list: unknown, kind: TeachKind): Rec[] | null {
  if (list === null || list === undefined) return [];
  if (!isRec(list)) return null;
  const arr = list[kind];
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr) || !arr.every(isRec)) return null;
  return arr as Rec[];
}

/** 统计每个 id 被多少题在用（跨所有卷；stale 单独计）。 */
export function countTeachUsage(input: { bindings: { doc: string; raw: unknown }[] }) {
  const topics: Record<string, { live: number; stale: number }> = {};
  const categories: Record<string, { live: number; stale: number }> = {};
  const bump = (bucket: Record<string, { live: number; stale: number }>, id: string, group: "live" | "stale") => {
    const cur = bucket[id] ?? { live: 0, stale: 0 };
    cur[group] += 1;
    bucket[id] = cur;
  };
  for (const entry of input.bindings) {
    const raw = entry.raw;
    if (!isRec(raw)) continue;
    for (const [group, key] of [
      ["live", "bindings"],
      ["stale", "stale"],
    ] as const) {
      const arr = raw[key];
      if (!Array.isArray(arr)) continue;
      for (const b of arr) {
        if (!isRec(b)) continue;
        for (const id of Array.isArray(b.topicIds) ? (b.topicIds as unknown[]) : []) {
          if (isStr(id)) bump(topics, id, group as "live" | "stale");
        }
        for (const id of Array.isArray(b.categoryIds) ? (b.categoryIds as unknown[]) : []) {
          if (isStr(id)) bump(categories, id, group as "live" | "stale");
        }
      }
    }
  }
  return { topics, categories };
}

/**
 * 算出「改名 / 删除」要写成什么样。任何一步不成立就整体返回 error，
 * 调用方据此一个文件都不写——不留半截状态。
 */
export function planTeachManage(input: ManageInput): ManagePlan {
  const items = listArray(input.list, input.kind);
  if (!items) return { ok: false, error: `${input.kind}.json 形状不对，先修数据再管理` };
  const idx = items.findIndex((t) => t.id === input.id);
  if (idx < 0) return { ok: false, error: "要操作的专题/类别不存在（可能已被别的窗口改名或删除）" };
  const item = items[idx]!;
  const itemName = isStr(item.name) ? item.name : input.id;

  // 先数影响面（跨所有卷），删除与改名都要报这个数
  let affected = 0;
  let staleAffected = 0;
  const key = input.kind === "topics" ? "topicIds" : "categoryIds";
  for (const entry of input.bindings) {
    const raw = entry.raw;
    if (!isRec(raw)) return { ok: false, error: `bindings/${entry.doc}.json 形状不对` };
    for (const [group, listKey] of [
      ["live", "bindings"],
      ["stale", "stale"],
    ] as const) {
      const arr = raw[listKey];
      if (!Array.isArray(arr)) continue;
      for (const b of arr) {
        if (!isRec(b) || !Array.isArray(b[key])) continue;
        if (!(b[key] as unknown[]).includes(input.id)) continue;
        if (group === "live") affected += 1;
        else staleAffected += 1;
      }
    }
  }

  if (input.action === "rename") {
    const clean = String(input.name ?? "").trim();
    if (!clean) return { ok: false, error: "名字不能为空" };
    if (clean.length > NAME_MAX_LEN) return { ok: false, error: `名字太长（≤${NAME_MAX_LEN}）` };
    if (items.some((t, i) => i !== idx && isStr(t.name) && t.name.trim() === clean)) {
      return { ok: false, error: `已有同名：${clean}` };
    }
    const nextItems = items.map((t, i) => (i === idx ? { ...t, name: clean } : t));
    return {
      ok: true,
      affected,
      staleAffected,
      combosChanged: 0,
      combosDropped: 0,
      listPayload: { ...(isRec(input.list) ? input.list : {}), version: 1, updatedAt: input.now, [input.kind]: nextItems },
      combosPayload: null,
      bindingsFiles: [],
      itemName: clean,
      stillAssigned: affected + staleAffected,
    };
  }

  /**
   * 下架 / 恢复（软删除，用户 2026-10-30 拍板的口径）：
   * 只给清单项打 retired 标记，**题目上的归属一个都不摘**、组合也不动——
   * 所以恢复就是去掉标记，不存在"还原到哪些题"的难题。
   */
  if (input.action === "retire" || input.action === "restore") {
    const retiring = input.action === "retire";
    const already = item.retired === true;
    if (retiring && already) return { ok: false, error: `「${itemName}」已经是下架状态` };
    if (!retiring && !already) return { ok: false, error: `「${itemName}」没有下架记录，无需恢复` };
    const nextItem: Rec = retiring ? { ...item, retired: true, retiredAt: input.now } : { ...item };
    if (!retiring) {
      delete nextItem.retired;
      delete nextItem.retiredAt;
    }
    const nextItems = items.map((t, i) => (i === idx ? nextItem : t));
    return {
      ok: true,
      affected,
      staleAffected,
      combosChanged: 0,
      combosDropped: 0,
      listPayload: { ...(isRec(input.list) ? input.list : {}), version: 1, updatedAt: input.now, [input.kind]: nextItems },
      combosPayload: null,
      bindingsFiles: [],
      itemName,
      stillAssigned: affected + staleAffected,
    };
  }

  // 删除：清单去掉这一项；所有卷摘掉引用；组合同样摘掉，成员空了的组合一并删
  const nextItems = items.filter((_, i) => i !== idx);
  const listPayload: Rec = {
    ...(isRec(input.list) ? input.list : {}),
    version: 1,
    updatedAt: input.now,
    [input.kind]: nextItems,
  };

  const bindingsFiles: BindingsFile[] = [];
  for (const entry of input.bindings) {
    const raw = entry.raw as Rec;
    let touched = false;
    const out: Rec = { ...raw };
    for (const listKey of ["bindings", "stale"] as const) {
      const arr = raw[listKey];
      if (!Array.isArray(arr)) continue;
      const nextList: Rec[] = [];
      for (const b of arr) {
        if (!isRec(b)) {
          nextList.push(b as Rec);
          continue;
        }
        const ids = b[key];
        if (!Array.isArray(ids) || !ids.includes(input.id)) {
          nextList.push(b);
          continue;
        }
        touched = true;
        const kept = ids.filter((x) => x !== input.id);
        const clone: Rec = { ...b, [key]: kept };
        // 两个集合都空了就整条删掉（与客户端 toggle 的语义一致：空归属不留记录）
        const other = b[key === "topicIds" ? "categoryIds" : "topicIds"];
        if (kept.length === 0 && (!Array.isArray(other) || other.length === 0)) continue;
        nextList.push(clone);
      }
      out[listKey] = nextList;
    }
    if (touched) {
      out.updatedAt = input.now;
      bindingsFiles.push({ doc: entry.doc, payload: out });
    }
  }

  let combosPayload: Rec | null = null;
  let combosChanged = 0;
  let combosDropped = 0;
  if (isRec(input.combos) && Array.isArray(input.combos.combos)) {
    const nextCombos: Rec[] = [];
    for (const c of input.combos.combos) {
      if (!isRec(c)) {
        nextCombos.push(c as Rec);
        continue;
      }
      const ids = c[key];
      if (!Array.isArray(ids) || !ids.includes(input.id)) {
        nextCombos.push(c);
        continue;
      }
      const kept = ids.filter((x) => x !== input.id);
      const other = c[key === "topicIds" ? "categoryIds" : "topicIds"];
      if (kept.length === 0 && (!Array.isArray(other) || other.length === 0)) {
        combosChanged += 1;
        combosDropped += 1;
        continue;
      }
      combosChanged += 1;
      nextCombos.push({ ...c, [key]: kept });
    }
    if (combosChanged > 0) combosPayload = { ...input.combos, version: 1, updatedAt: input.now, combos: nextCombos };
  }

  return {
    ok: true,
    affected,
    staleAffected,
    combosChanged,
    combosDropped,
    listPayload,
    combosPayload,
    bindingsFiles,
    itemName,
    stillAssigned: 0, // 彻底清除是真的把引用摘干净了
  };
}
