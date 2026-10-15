/**
 * tag-panel.js —— 题目面板里的「标签」区（展示层自有模块，不 import 引擎 src/）
 *
 * 为什么交互放在这里而不是纸面上：留白只有 22px、短码块高 12px，竖排的相邻两题标签列在密页里
 * 靠得极近——让它们可点就是「点不准 + 误触上一题/下一题」。触屏上唯一可靠的入口是题号牌
 * （它四周都是空白，热区可以无损扩到 ~42px），点开就是这个区。
 *
 * 「打上 / 摘掉」是同一个动作（点已选中的行即切换），所以 U7 与 U11 共用一行代码，
 * 也让触屏用户不需要区分两种手势。
 *
 * 面板拿到的 app 句柄形状：`{ tags, commitBindings, commitLibrary, onRepaint }`
 * （写在代码里而不是 JSDoc 的花括号里 —— `{ tags:{library,bindings} }` 这种嵌套花括号
 *  会让 JSDoc 解析器直接报语法错，2026-10-15 实测）。
 */
import { el } from "../stages/reconstruct.js";
import { makeTag, removeTagFromLibrary, tagIdsFor, toggleTag } from "./tag-store.js";

const MAX_NAME = 20;

/**
 * @param app    面板句柄：{ tags, commitBindings, commitLibrary, onRepaint }
 * @param q      当前题目
 * @param p      所在页
 * @param anchor 漂移核对用的锚点（tag-store.anchorOf）
 */
export function tagSection(app, q, p, anchor) {
  const box = el("div", "tag-box");
  const err = el("div", "tag-err");
  err.hidden = true;

  const showError = (msg) => {
    err.hidden = false;
    err.replaceChildren();
    err.append(el("p", "", `未能保存：${msg}`));
    // 移动端 http://局域网IP 不是安全上下文，navigator.clipboard 不可用 ⇒ 给出可选中拷贝的出口
    const ta = el("textarea", "tag-dump");
    ta.readOnly = true;
    ta.value = JSON.stringify({ library: app.tags.library, bindings: app.tags.bindings }, null, 1);
    err.append(ta, el("p", "hint", "长按上面这段文本可全选拷贝，存进备忘录不会丢"));
  };
  const clearError = () => {
    err.hidden = true;
    err.replaceChildren();
  };

  const paint = () => {
    box.querySelectorAll(".tag-rows, .tag-new, .tag-lib, .tag-stale").forEach((n) => n.remove());
    box.append(rows(), newTagRow(), libToggle());
    const stale = staleNotice(); // 没有漂移条目就**什么都不加**：空框会让人以为"这里该有东西但没渲染出来"
    if (stale) box.append(stale);
  };

  /** 唯一的写路径：改内存 → 落盘 → 重绘纸面。保存失败必须让用户看见（U23）。 */
  const commit = async (next) => {
    clearError();
    app.tags = { ...app.tags, bindings: next };
    const r = await app.commitBindings(next);
    if (!r.ok) showError(r.error);
    paint();
    app.onRepaint(q, p);
  };

  function rows() {
    const cur = new Set(tagIdsFor(app.tags.bindings, q.id));
    const list = el("div", "tag-rows");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "给本题加标签：点亮即加上，再点即摘掉");
    if (!app.tags.library.tags.length) {
      list.append(el("p", "tag-empty", "标签库是空的，用下面「新建标签」建一个。"));
    }
    for (const t of app.tags.library.tags) {
      const on = cur.has(t.id);
      const row = el("button", `tag-row${on ? " on" : ""}`);
      row.type = "button";
      row.setAttribute("aria-pressed", on ? "true" : "false");
      const sw = el("span", "qtag", t.short);
      sw.style.background = t.color;
      row.append(sw, el("span", "tag-name", t.name), el("span", "tag-act", on ? "摘掉" : "加上"));
      row.addEventListener("click", () => {
        void commit(toggleTag(app.tags.bindings, q.id, t.id, anchor));
      });
      list.append(row);
    }
    return list;
  }

  function newTagRow() {
    const wrap = el("div", "tag-new");
    const btn = el("button", "tag-new-btn", "＋ 新建标签");
    btn.type = "button";
    const form = el("div", "tag-new-form");
    form.hidden = true;
    const input = el("input", "tag-new-input");
    input.type = "text";
    input.maxLength = MAX_NAME;
    input.placeholder = "标签名（如 力学综合）";
    input.setAttribute("aria-label", "新标签名称");
    const add = el("button", "tag-new-add", "建好并打上");
    add.type = "button";
    const submit = async () => {
      const t = makeTag(input.value);
      if (!t) return;
      clearError();
      const nextLib = { ...app.tags.library, tags: [...app.tags.library.tags, t] };
      const rl = await app.commitLibrary(nextLib); // 库里先有这个名字，绑定才不会指向幽灵标签
      if (!rl.ok) return showError(rl.error);
      app.tags = { ...app.tags, library: nextLib };
      input.value = "";
      form.hidden = true;
      await commit(toggleTag(app.tags.bindings, q.id, t.id, anchor));
    };
    btn.addEventListener("click", () => {
      form.hidden = !form.hidden;
      if (!form.hidden) input.focus(); // iOS：聚焦才弹键盘，键盘高度由 CSS 变量交回布局
    });
    add.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });
    form.append(input, add);
    wrap.append(btn, form);
    return wrap;
  }

  function libToggle() {
    const wrap = el("div", "tag-lib");
    const btn = el("button", "tag-lib-btn", "管理标签库");
    btn.type = "button";
    const panel = el("div", "tag-lib-panel");
    panel.hidden = true;
    btn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      panel.replaceChildren();
      if (panel.hidden) return;
      for (const t of app.tags.library.tags) panel.append(libRow(t));
      if (!app.tags.library.tags.length) panel.append(el("p", "tag-empty", "库里没有标签，回上面新建。"));
    });
    wrap.append(btn, panel);
    return wrap;
  }

  /** 改名/改短码/改色即时写库（库是全卷共享的一份，U17）；删除要先报"会摘掉 N 题"再二次确认。 */
  function libRow(t) {
    const row = el("div", "tag-lib-row");
    const field = (kind, val, extra) => {
      const i = el("input", `tag-f tag-f-${kind}`);
      i.type = kind === "color" ? "color" : "text";
      i.value = val;
      if (extra) Object.assign(i, extra);
      i.setAttribute("aria-label", `${t.name} 的${kind === "name" ? "名称" : kind === "short" ? "短码" : "颜色"}`);
      return i;
    };
    const name = field("name", t.name, { maxLength: MAX_NAME });
    const short = field("short", t.short, { maxLength: 2 });
    const color = field("color", t.color);
    const save = el("button", "tag-lib-save", "保存");
    save.type = "button";
    const del = el("button", "tag-lib-del");
    del.type = "button";
    let armed = false;
    const affected = () =>
      [...app.tags.bindings.bindings, ...app.tags.bindings.stale].filter((b) => b.tagIds.includes(t.id)).length;
    const labelDel = () => {
      const n = affected();
      del.textContent = armed ? `确认删除（摘掉 ${n} 题）` : `删除（影响 ${n} 题）`;
    };
    labelDel();
    save.addEventListener("click", async () => {
      const next = {
        ...app.tags.library,
        tags: app.tags.library.tags.map((x) =>
          x.id === t.id
            ? { ...x, name: name.value.trim().slice(0, MAX_NAME) || x.name, short: short.value.trim().slice(0, 2) || x.short, color: color.value || x.color }
            : x,
        ),
      };
      const r = await app.commitLibrary(next);
      if (!r.ok) return showError(r.error);
      app.tags = { ...app.tags, library: next };
      paint();
      app.onRepaint(q, p);
    });
    del.addEventListener("click", async () => {
      if (!armed) {
        armed = true; // 二次确认：删库会级联摘除别人的劳动成果，不给"一触即删"
        labelDel();
        return;
      }
      const { library, state } = removeTagFromLibrary(app.tags.library, app.tags.bindings, t.id);
      const rl = await app.commitLibrary(library);
      if (!rl.ok) {
        armed = false;
        return showError(rl.error);
      }
      const rb = await app.commitBindings(state);
      if (!rb.ok) return showError(rb.error);
      app.tags = { library, bindings: state };
      armed = false;
      paint();
      app.onRepaint(q, p);
    });
    row.append(sw(t), name, short, color, save, del);
    return row;
  }

  const sw = (t) => {
    const s = el("span", "qtag", t.short);
    s.style.background = t.color;
    return s;
  };

  function staleNotice() {
    const stale = app.tags.bindings.stale ?? [];
    if (!stale.length) return null;
    const box2 = el("div", "tag-stale");
    box2.append(el("p", "", `${stale.length} 条标签在当前快照里对不上题目（切分重新导出后位置型 ID 会变），数据已原样保留：`));
    for (const s of stale) {
      const a = s.anchor ?? {};
      const names = (s.tagIds ?? []).map((id) => app.tags.library.tags.find((t) => t.id === id)?.name ?? id).join("、");
      box2.append(
        el("p", "tag-stale-line", `第 ${a.page ?? "?"} 页 第 ${a.number ?? "?"} 题 ·「${names}」· 题干当时记作「${a.firstText ?? ""}」`),
      );
    }
    return box2;
  }

  box.append(el("div", "lbl", "标签"), err);
  paint();
  return box;
}
