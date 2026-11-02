function renderManageList() {
  const box = $("manage-list");
  if (!box || !state.teach || !state.manage) return;
  /** @type {HTMLElement[]} */
  const nodes = [];
  const section = (label, kind, items) => {
    const { active, retired } = splitRetired(items);
    nodes.push(el("p", "mg-label", `${label}（${active.length}）`));
    if (!active.length) nodes.push(el("p", "mg-empty", `还没有${label}。`));
    for (const item of active) nodes.push(manageRow(kind, item, false));
    if (retired.length) {
      nodes.push(el("p", "mg-label mg-sublabel", `已下架（${retired.length}）· 题上的归类都还在`));
      for (const item of retired) nodes.push(manageRow(kind, item, true));
    }
  };
  section("专题", "topics", state.teach.topics ?? []);
  section("类别", "categories", state.teach.categories ?? []);
  section("常用组合", "combos", state.teach.combos ?? []);
  box.replaceChildren(...nodes);
}

/** 这一项现在被多少题在用（跨所有卷；数字没回来前如实写"题数未知"）。 */
function usageLabel(kind, id) {
  if (!state.manage?.usage) return "题数未知";
  const u = state.manage.usage[kind]?.[id];
  if (!u) return "还没用过";
  return `用在 ${u.live} 题上${u.stale ? `（另 ${u.stale} 题已漂移）` : ""}`;
}

/**
 * 一行：名字 + 说明 + 改名/下架；已下架的行只给「恢复」。
 * 下架是软删除（用户 2026-10-30 拍板）：点一下就下架、随时可恢复，
 * 所以不再需要"两步确认 + 影响几题"那套防手滑设计。
 * @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item @param {boolean} retired
 */
function manageRow(kind, item, retired) {
  const key = `${kind}:${item.id}`;
  const renaming = !retired && state.manage?.renaming === key;
  const row = el("div", "mg-row" + (retired ? " mg-retired" : ""));
  row.dataset.kind = kind;
  row.dataset.id = item.id;
  const main = el("div", "mg-main");
  if (renaming) {
    const form = el("form", "mg-edit");
    const input = el("input", "mg-input");
    input.type = "text";
    input.maxLength = 60;
    input.value = item.name;
    input.setAttribute("aria-label", "新名字");
    const ok = el("button", "mg-btn primary", "保存");
    ok.type = "submit";
    form.append(input, ok);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void commitManageRename(kind, item, input.value);
    });
    main.append(form);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    main.append(el("span", "mg-name", item.name));
    main.append(el("span", "mg-sum", kind === "combos" ? comboSummary(item) : usageLabel(kind, item.id)));
  }
  row.append(main);
  /** @type {HTMLElement[]} */
  const acts = [];
  if (retired) {
    const back = el("button", "mg-btn primary", "恢复");
    back.type = "button";
    back.addEventListener("click", () => void commitManageRestore(kind, item));
    acts.push(back);
  } else if (!renaming) {
    const rn = el("button", "mg-btn", "改名");
    rn.type = "button";
    rn.addEventListener("click", () => {
      if (!state.manage) return;
      state.manage.renaming = key;
      clearManageHint();
      renderManageList();
    });
    const off = el("button", "mg-btn danger", "下架");
    off.type = "button";
    off.title = "下架后挑题时不再出现，题上已归的类保留，可随时恢复";
    off.addEventListener("click", () => void commitManageRetire(kind, item));
    acts.push(rn, off);
  }
  if (acts.length) row.append(el("div", "mg-acts", null), ...acts);
  return row;
}

/** 管理成功后把服务端返回的新清单装回内存（下架/恢复都不返回 bindings——题上没动）。 */
function applyManageResult(kind, res) {
  if (!state.teach) return;
  if (Array.isArray(res.list)) {
    state.teach = { ...state.teach, [kind]: normalizeTeachList({ [kind]: res.list }, kind) };
  }
  if (Array.isArray(res.combos)) {
    state.teach = { ...state.teach, combos: normalizeCombos({ combos: res.combos }) };
  }
  const docPayload = res.bindings ? res.bindings[state.doc] : undefined;
  if (docPayload) {
    state.teach = { ...state.teach, bindings: normalizeTeachBindings(docPayload) };
    for (let i = 0; i < state.pages.length; i++) repaintPage(i);
  }
  updatePickTray();
  if (!state.manage) return;
  state.manage.usage = null; // 数字随清单一起过期，重新问
  state.manage.renaming = null;
  renderManageList();
  refreshManageUsage();
}

/** @param {'topics'|'categories'|'combos'} kind @param {{id:string,name:string}} item */
async function commitManageRename(kind, item, name) {
  if (!state.teach) return;
  const clean = String(name ?? "").trim();
  if (kind === "combos") {
    const res = renameCombo(state.teach.combos ?? [], item.id, clean);
    if (!res.item) {
      showManageHint(res.error ?? "改名失败");
      return;
    }
    const saved = await saveComboList(res.list, `组合「${res.item.name}」`);
    if (!saved.ok || !state.manage) return;
    renderManageList();
    showManageHint(`已改名为「${res.item.name}」`, "ok");
    return;
  }
  if (!clean) {
    showManageHint("名字不能为空");
    return;
  }
  const dup = (state.teach[kind] ?? []).some((x) => x.id !== item.id && x.name.trim() === clean);
  if (dup) {
    showManageHint(`已有同名：${clean}`);
    return;
  }
  const res = await manageTeach("rename", kind, item.id, clean);
  if (!res.ok) {
    showManageHint(res.error ?? "改名失败");
    return;
  }
  applyManageResult(kind, res);
  showManageHint(`已改名为「${clean}」`, "ok");
}

/** 下架（软删除）：题上的归属一个都不动。 @param {'topics'|'categories'|'combos'} kind */
async function commitManageRetire(kind, item) {
  if (!state.teach) return;
  clearManageHint();
  if (kind === "combos") {
    const res = retireCombo(state.teach.combos ?? [], item.id);
    if (!res.item) {
      showManageHint(res.error ?? "下架失败");
      return;
    }
    const saved = await saveComboList(res.list, `组合「${item.name}」`);
    if (!saved.ok || !state.manage) return;
    renderManageList();
    showManageHint(`已下架「${item.name}」，在「已下架」里可以恢复`, "ok");
    return;
  }
  const res = await manageTeach("retire", kind, item.id);
  if (!res.ok) {
    showManageHint(res.error ?? "下架失败");
    renderManageList();
    return;
  }
  applyManageResult(kind, res);
  showManageHint(
    `已下架「${res.item ?? item.name}」（${res.stillAssigned ?? 0} 题上的归类保留，随时可恢复）`,
    "ok",
  );
}

/** 恢复已下架项。 @param {'topics'|'categories'|'combos'} kind */
async function commitManageRestore(kind, item) {
  if (!state.teach) return;
  clearManageHint();
  if (kind === "combos") {
    const res = restoreCombo(state.teach.combos ?? [], item.id);
    if (!res.item) {
      showManageHint(res.error ?? "恢复失败");
      return;
    }
    const saved = await saveComboList(res.list, `组合「${item.name}」`);
    if (!saved.ok || !state.manage) return;
    renderManageList();
    showManageHint(`已恢复「${item.name}」`, "ok");
    return;
  }
  const res = await manageTeach("restore", kind, item.id);
  if (!res.ok) {
    showManageHint(res.error ?? "恢复失败");
    renderManageList();
    return;
  }
  applyManageResult(kind, res);
  showManageHint(`已恢复「${res.item ?? item.name}」，挑题时又能选了`, "ok");
}
