/* ---------------------------------------------------------------------------
 * 本分片：本地更改（文件列表/文件树、差异视图、提交区）。
 * ------------------------------------------------------------------------- */

async function syncWorkspaceFromHost(options) {
  try {
    const meta = await appCtx.workspace.getMetadata();
    if (meta && meta.path) await setWorkspace(meta.path, options);
  } catch (error) {
    // 宿主未提供工作区时保持空态
  }
}

function entryCode(entry) {
  if (!entry) return "";
  if (entry.unmerged) return "U";
  if (entry.code === "?") return "?";
  const x = entry.x || ".";
  const y = entry.y || ".";
  if (entry.staged) return x !== "." ? x : y;
  return y !== "." ? y : x;
}

function modeForEntry(entry) {
  if (!entry) return "worktree";
  if (entry.unmerged) return "worktree";
  return entry.staged ? "staged" : "worktree";
}

function changeGroups(data) {
  const status = data.status || emptyStatus();
  const groups = [];
  if (status.conflicted.length) groups.push({ key: "conflicted", title: "冲突", entries: status.conflicted });
  if (status.staged.length) groups.push({ key: "staged", title: "已暂存", entries: status.staged });
  if (status.unstaged.length) groups.push({ key: "unstaged", title: "未暂存", entries: status.unstaged });
  if (status.untracked.length) groups.push({ key: "untracked", title: "未跟踪", entries: status.untracked });
  return groups;
}

function countChanges(data) {
  const status = data && data.status ? data.status : emptyStatus();
  return uniquePaths(status.staged.concat(status.unstaged, status.untracked, status.conflicted)).length;
}

async function toggleDir(repo, path) {
  const data = ensureRepoData(repo);
  if (!data.expandedDirs) data.expandedDirs = new Set();
  if (data.expandedDirs.has(path)) data.expandedDirs.delete(path);
  else data.expandedDirs.add(path);
  notify();
}

/* ---------- 本地更改 ---------- */

function ChangesPanel(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const repo = props.repo;
  const data = ensureRepoData(repo);
  const groups = changeGroups(data);
  const selection = s.selectedFile && pathKey(s.selectedFile.repo) === pathKey(repo) ? s.selectedFile : null;
  const selectedEntry = selection ? data.status.entries.find((entry) => entry.path === selection.path && Boolean(entry.staged) === Boolean(selection.staged)) : null;
  const selectionForDiff = selectedEntry || (selection ? { path: selection.path, staged: selection.staged, code: "", x: "", y: "" } : null);
  const filterText = String(data.fileFilter || "").trim().toLowerCase();
  const shownGroups = filterText
    ? groups
      .map((group) => Object.assign({}, group, { entries: group.entries.filter((entry) => String(entry.path).toLowerCase().includes(filterText)) }))
      .filter((group) => group.entries.length)
    : groups;
  return h(
    "div",
    { className: "cg-changes" },
    data.status.truncated
      ? h(Banner, { tone: "error" }, "git status 输出达到 64KB 上限，文件列表可能不完整。建议分批提交或增加忽略规则。")
      : null,
    data.error ? h(Banner, { tone: "error" }, data.error) : null,
    h(OperationBanner, { repo, data }),
    h(
      "div",
      { className: "cg-changes-top" },
      h(
        "div",
        { className: "cg-filecol" },
      h(ChangesToolbar, { repo, data, groups }),
      h(FileFilterBar, { repo, data, total: groups.reduce((n, g) => n + g.entries.length, 0), shown: shownGroups.reduce((n, g) => n + g.entries.length, 0) }),
      h(
        "div",
        {
          className: "cg-files",
          tabIndex: 0,
          "aria-label": "更改文件列表（↑↓ 选择，空格暂存/取消暂存）",
          onKeyDown: (event) => onFileListKey(event, repo, data, shownGroups, selection, s.settings.fileView === "flat"),
        },
        !groups.length
          ? h(Empty, { icon: "check", title: "没有本地更改" }, h("span", null, "工作区干净"))
          : shownGroups.length
            ? shownGroups.map((group) => h(ChangeGroup, { key: group.key, repo, data, group, selection, flat: s.settings.fileView === "flat" }))
            : h(Empty, { icon: "search", title: "没有匹配的文件" }, h("span", null, "调整筛选条件")),
      ),
      ),
      h(DiffPane, { repo, entry: selectionForDiff, data }),
    ),
    h(CommitBox, { repo, data }),
  );
}

/** 按界面展示顺序列出可见文件（尊重分组折叠、目录折叠与平铺/树形）。 */
function visibleFileOrder(data, groups, flat) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === "dir") {
        const open = data.expandedDirs && data.expandedDirsReady ? data.expandedDirs.has(node.path) : true;
        if (open) walk(node.children);
      } else if (node.entry) {
        out.push(node.entry);
      }
    }
  };
  for (const group of groups) {
    if (data.expandedGroups && data.expandedGroups[group.key] === false) continue;
    if (flat) {
      for (const entry of group.entries.slice().sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-Hans-CN"))) out.push(entry);
    } else {
      walk(buildCompactFileTree(group.entries));
    }
  }
  return out;
}

function onFileListKey(event, repo, data, groups, selection, flat) {
  if (event.target !== event.currentTarget) return;
  const key = event.key;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== " " && key !== "Enter") return;
  const order = visibleFileOrder(data, groups, flat);
  if (!order.length) return;
  event.preventDefault();
  const index = selection
    ? order.findIndex((entry) => entry.path === selection.path && Boolean(entry.staged) === Boolean(selection.staged))
    : -1;
  if (key === "ArrowDown" || key === "ArrowUp") {
    const next = key === "ArrowDown"
      ? Math.min(order.length - 1, index + 1)
      : index < 0 ? 0 : Math.max(0, index - 1);
    selectFile(repo, order[next], modeForEntry(order[next]));
    return;
  }
  const current = index >= 0 ? order[index] : null;
  if (!current) {
    selectFile(repo, order[0], modeForEntry(order[0]));
    return;
  }
  if (key === "Enter") {
    selectFile(repo, current, modeForEntry(current));
    return;
  }
  if (current.unmerged) return;
  if (current.staged) void unstageEntries(repo, [current]);
  else void stageEntries(repo, [current]);
}

function FileFilterBar(props) {
  const h = appCtx.react.createElement;
  const { data, total, shown } = props;
  const view = state.settings.fileView === "flat" ? "flat" : "tree";
  const setFilter = (value) => {
    data.fileFilter = value;
    notify();
  };
  if (!total) return null;
  return h(
    "div",
    { className: "cg-filterbar" },
    h(
      "div",
      { className: "cg-search" },
      h(Icon, { name: "search", size: 13 }),
      h(TextInput, {
        value: data.fileFilter || "",
        placeholder: "筛选路径",
        onChange: setFilter,
        onKeyDown: (event) => {
          if (event.key === "Escape" && data.fileFilter) {
            event.preventDefault();
            event.stopPropagation();
            setFilter("");
          }
        },
      }),
    ),
    data.fileFilter ? h("span", { className: "cg-muted cg-mini" }, shown + "/" + total) : null,
    h(
      "div",
      { className: "cg-seg", role: "group", "aria-label": "文件视图" },
      h("button", { type: "button", className: view === "tree" ? "cg-on" : "", title: "树形", onClick: () => saveSettings({ fileView: "tree" }) }, h(Icon, { name: "folder", size: 12 })),
      h("button", { type: "button", className: view === "flat" ? "cg-on" : "", title: "平铺", onClick: () => saveSettings({ fileView: "flat" }) }, h(Icon, { name: "file", size: 12 })),
    ),
  );
}

function OperationBanner(props) {
  const h = appCtx.react.createElement;
  const ops = props.data.operations;
  if (props.data.operationsError) {
    return h(Banner, { tone: "error" }, "无法检测进行中的 Git 操作：" + props.data.operationsError);
  }
  if (!ops.merge && !ops.rebase && !ops.cherryPick && !ops.revert) return null;
  const label = ops.rebase ? "变基" : ops.merge ? "合并" : ops.cherryPick ? "拣选（Cherry-pick）" : "还原（Revert）";
  return h(
    Banner,
    {
      tone: "info",
      actions: h(
        "span",
        { style: { display: "flex", gap: "0.25rem" } },
        h(Btn, { size: "sm", icon: "play", onClick: () => continueOperation(props.repo) }, "继续"),
        ops.rebase || ops.cherryPick || ops.revert
          ? h(Btn, { size: "sm", onClick: () => skipOperation(props.repo) }, "跳过")
          : null,
        h(Btn, { size: "sm", variant: "danger", onClick: () => abortOperation(props.repo) }, "中止"),
      ),
    },
    label + " 进行中，请在解决冲突后继续。",
  );
}

function ChangesToolbar(props) {
  const h = appCtx.react.createElement;
  const { repo, data, groups } = props;
  const checked = checkedKeys(repo);
  const checkedSet = new Set(checked);
  const allEntries = data.status.staged.concat(data.status.unstaged, data.status.untracked, data.status.conflicted);
  const allChecked = allEntries.length > 0 && allEntries.every((entry) => checkedSet.has(entryKey(entry)));
  const selectedPaths = checkedPaths(repo);
  const stageSelected = data.status.unstaged.concat(data.status.untracked).filter((entry) => checkedSet.has(entryKey(entry)));
  const unstageSelected = data.status.staged.filter((entry) => checkedSet.has(entryKey(entry)));
  const hasUnstaged = groups.some((group) => group.key === "unstaged" || group.key === "untracked");
  const hasStaged = groups.some((group) => group.key === "staged");
  return h(
    "div",
    { className: "cg-toolbar" },
    h(Check, {
      checked: allChecked,
      onChange: (value) => setAllChecked(repo, value),
      title: "全选/全不选",
    }, "全部"),
    selectedPaths.length ? h("span", { className: "cg-muted cg-mini" }, "已选 " + selectedPaths.length) : null,
    h("div", { className: "cg-toolbar-spacer" }),
    stageSelected.length || unstageSelected.length
      ? h(
          "div",
          { className: "cg-tgroup" },
          stageSelected.length
            ? h(Btn, { size: "sm", icon: "plus", onClick: () => stageEntries(repo, stageSelected) }, "暂存选中")
            : null,
          unstageSelected.length
            ? h(Btn, { size: "sm", icon: "minus", onClick: () => unstageEntries(repo, unstageSelected) }, "取消选中")
            : null,
        )
      : null,
    hasUnstaged || hasStaged
      ? h(
          "div",
          { className: "cg-tgroup" },
          hasUnstaged ? h(Btn, { size: "sm", icon: "plus", onClick: () => stageAll(repo) }, "全部暂存") : null,
          hasStaged
            ? h(Btn, {
                size: "sm",
                icon: "minus",
                disabled: data.status.conflicted.length > 0,
                title: data.status.conflicted.length ? "存在未解决冲突，无法全部取消暂存" : "",
                onClick: () => unstageAll(repo),
              }, "全部取消")
            : null,
        )
      : null,
    h("div", { className: "cg-header-sep" }),
    h(IconBtn, { name: "stash", label: "贮藏本地更改", onClick: () => stashDialog(repo) }),
    h(IconBtn, { name: "refresh", label: "刷新", onClick: () => refreshRepo(repo, { details: true, quick: true }) }),
  );
}

function ChangeGroup(props) {
  const h = appCtx.react.createElement;
  const { repo, data, group, selection } = props;
  const expanded = data.expandedGroups ? data.expandedGroups[group.key] !== false : true;
  const toggle = () => {
    data.expandedGroups = Object.assign({}, data.expandedGroups || {}, { [group.key]: !expanded });
    notify();
  };
  const tree = buildCompactFileTree(group.entries);
  return h(
    "div",
    { className: "cg-group" },
    h(
      "div",
      { className: "cg-group-head", onClick: toggle },
      h(Icon, { name: expanded ? "chevron-down" : "chevron-right", size: 11 }),
      h(
        "div",
        { className: "cg-group-title" },
        h("b", null, group.title),
        h(Badge, { tone: group.key === "conflicted" ? "conflict" : group.key === "untracked" ? "add" : "neutral" }, group.entries.length),
      ),
      h(
        "span",
        { style: { display: "flex", gap: "1px" }, onClick: (event) => event.stopPropagation() },
        group.key === "staged" ? h(IconBtn, { name: "minus", label: "取消暂存全部", size: 12, onClick: () => unstageEntries(repo, group.entries) }) : null,
        group.key === "unstaged" || group.key === "untracked"
          ? h(IconBtn, { name: "plus", label: "暂存全部", size: 12, onClick: () => stageEntries(repo, group.entries) })
          : null,
        group.key === "unstaged" || group.key === "untracked"
          ? h(IconBtn, {
              name: "undo",
              label: "回滚全部",
              size: 12,
              onClick: () => {
                if (group.key === "untracked") {
                  discardPaths(repo, group.entries.map((entry) => Object.assign({}, entry, { code: "?", staged: false })));
                } else {
                  discardPaths(repo, group.entries);
                }
              },
            })
          : null,
      ),
    ),
    expanded
      ? props.flat
        ? h(
            appCtx.react.Fragment,
            null,
            group.entries.slice().sort((a, b) => String(a.path).localeCompare(String(b.path), "zh-Hans-CN")).map((entry) =>
              h(FileRow, { key: "f:" + group.key + ":" + entry.path, repo, data, groupKey: group.key, entry, selection, depth: -1 }),
            ),
          )
        : h(FileTree, { repo, data, groupKey: group.key, nodes: tree, depth: 0, selection })
      : null,
  );
}

function FileTree(props) {
  const h = appCtx.react.createElement;
  const { repo, data, groupKey, nodes, depth, selection } = props;
  const rows = [];
  for (const node of nodes || []) {
    if (node.type === "dir") {
      const isExpanded = data.expandedDirs && data.expandedDirsReady
        ? data.expandedDirs.has(node.path)
        : true;
      const dirEntries = treeEntries(node, []);
      const dirChecked = dirEntries.length > 0 && dirEntries.every((entry) => isEntryChecked(repo, entry));
      const dirPartial = !dirChecked && dirEntries.some((entry) => isEntryChecked(repo, entry));
      rows.push(
        h(
          "div",
          {
            key: "d:" + groupKey + ":" + node.path,
            className: "cg-row cg-tree-row",
            style: { paddingLeft: 0.375 + depth * 0.75 + "rem" },
            title: node.path,
            onClick: () => toggleDir(repo, node.path),
          },
          h("span", { className: "cg-chev" }, h(Icon, { name: isExpanded ? "chevron-down" : "chevron-right", size: 11 })),
          h(RowCheck, {
            checked: dirChecked,
            indeterminate: dirPartial,
            title: dirChecked ? "取消选择该目录下全部文件" : "选择该目录下全部文件",
            onChange: () => setCheckedMany(repo, dirEntries, !dirChecked),
          }),
          h(Icon, { name: "folder", size: 12, style: { color: "var(--color-text-tertiary)" } }),
          h("span", { className: "cg-row-name" }, node.name),
        ),
      );
      if (isExpanded) {
        const sub = h(FileTree, { key: "t:" + groupKey + ":" + node.path, repo, data, groupKey, nodes: node.children, depth: depth + 1, selection });
        rows.push(sub);
      }
    } else {
      rows.push(h(FileRow, { key: "f:" + groupKey + ":" + node.path, repo, data, groupKey, entry: node.entry, selection, depth }));
    }
  }
  return h(appCtx.react.Fragment, null, rows);
}

function FileRow(props) {
  const h = appCtx.react.createElement;
  const { repo, data, groupKey, entry, selection, depth } = props;
  const checked = Boolean(isEntryChecked(repo, entry));
  const selected = selection && selection.path === entry.path && Boolean(selection.staged) === Boolean(entry.staged);
  const code = entryCode(entry);
  const open = () => selectFile(repo, entry, modeForEntry(entry));
  const stage = () => stageEntries(repo, [entry]);
  const unstage = () => unstageEntries(repo, [entry]);
  const menuItems = [
    entry.unmerged
      ? null
      : entry.staged
        ? { label: "取消暂存", icon: "minus", onClick: unstage }
        : { label: "暂存文件", icon: "plus", onClick: stage },
    { label: "查看差异", icon: "eye", onClick: open },
    { separator: true },
    { label: "显示文件历史", icon: "history", onClick: () => openFileHistory(repo, entry.path) },
    { label: "逐行溯源", icon: "user", onClick: () => openBlame(repo, entry.path) },
    { label: "复制路径", icon: "copy", onClick: () => copyText(entry.path) },
    { label: "添加到 .gitignore", icon: "file", onClick: () => addToGitignore(repo, [entry.path]) },
  ];
  if (entry.code !== "?" && !entry.unmerged && !(entry.staged && entry.x === "D")) {
    menuItems.push(
      { separator: true },
      { label: "标记为未更改", icon: "eye", onClick: () => setAssumeUnchanged(repo, [entry.path], true) },
      { label: "从索引移除", icon: "minus", onClick: () => removeFromIndex(repo, [entry.path]), danger: true },
      { label: "跳过工作树", icon: "archive", onClick: () => setSkipWorktree(repo, [entry.path], true) },
    );
  }
  if (entry.unmerged) {
    menuItems.unshift(
      { label: "采用我方版本（ours）", icon: "check", onClick: () => resolveConflict(repo, entry.path, "ours") },
      { label: "采用对方版本（theirs）", icon: "download", onClick: () => resolveConflict(repo, entry.path, "theirs") },
      { separator: true },
    );
  }
  if (entry.unmerged) {
    // 冲突文件不提供直接暂存，避免未编辑就标记为已解决
  } else if (entry.code === "?") {
    menuItems.splice(2, 0, { label: "删除文件", icon: "trash", danger: true, onClick: () => discardPaths(repo, [entry]) });
  } else {
    menuItems.splice(2, 0, { label: "回滚更改", icon: "undo", danger: true, onClick: () => discardPaths(repo, [entry]) });
  }
  const finalMenu = menuItems.filter(Boolean);
  return h(
    "div",
    {
      className: cx("cg-row cg-tree-row", selected ? "cg-selected" : ""),
      style: { paddingLeft: 0.375 + (depth + 1) * 0.75 + "rem" },
      onClick: open,
      onContextMenu: (event) => {
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY, finalMenu);
      },
      title: entry.origPath ? entry.origPath + " → " + entry.path : entry.path,
    },
    h("input", {
      className: "cg-row-check",
      type: "checkbox",
      checked,
      onClick: (event) => event.stopPropagation(),
      onChange: () => toggleChecked(repo, entry),
    }),
    h(Icon, { name: entry.unmerged ? "warning" : entry.code === "?" ? "file" : "file", size: 12, style: { color: "var(--color-text-tertiary)" } }),
    h("span", { className: "cg-row-name" }, entry.path.split("/").pop()),
    h("span", { className: "cg-row-dir" }, dirName(entry.path)),
    h(Badge, { tone: entry.unmerged ? "conflict" : statusTone(code), title: statusText(code) }, code),
    h(
      "span",
      { className: "cg-row-actions", onClick: (event) => event.stopPropagation() },
      entry.unmerged
        ? null
        : entry.staged
          ? h(IconBtn, { name: "minus", label: "取消暂存", size: 12, onClick: unstage })
          : h(IconBtn, { name: "plus", label: "暂存", size: 12, onClick: stage }),
      h(IconBtn, {
        name: "more",
        label: "更多操作",
        size: 12,
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openContextMenu(rect.left, rect.bottom + 2, finalMenu);
        },
      }),
    ),
  );
}

/** 读取勾选状态（普通函数，避免为每行引入 hook）。 */
function isEntryChecked(repo, entry) {
  const checked = state.checkedByRepo[repo] || {};
  return entry ? checked[entryKey(entry)] : false;
}

/* ---------- 右键菜单 ---------- */

let contextMenuState = null;
const contextMenuListeners = new Set();

/** 根字号（px），用于把 CSS 里的 rem 尺寸换算成定位用的像素。 */
function rootFontPx() {
  try {
    const size = Number.parseFloat(window.getComputedStyle(window.document.documentElement).fontSize);
    return Number.isFinite(size) && size > 0 ? size : 16;
  } catch (error) {
    return 16;
  }
}

function openContextMenu(x, y, items) {
  const font = rootFontPx();
  const viewportW = window.innerWidth || 0;
  const viewportH = window.innerHeight || 0;
  const margin = 0.5 * font;
  const menuW = Math.min(21.25 * font, viewportW * 0.9);
  const menuH = Math.min((items.length * 2 + 0.75) * font, viewportH * 0.8);
  contextMenuState = {
    x: Math.min(x, Math.max(margin, viewportW - menuW - margin)),
    y: Math.min(y, Math.max(margin, viewportH - menuH - margin)),
    items,
  };
  for (const listener of contextMenuListeners) listener();
  notify();
}

function closeContextMenu() {
  contextMenuState = null;
  for (const listener of contextMenuListeners) listener();
  notify();
}

function ContextMenuHost() {
  const h = appCtx.react.createElement;
  const { useState, useEffect } = appCtx.react;
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((value) => value + 1);
    contextMenuListeners.add(listener);
    return () => contextMenuListeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!contextMenuState) return;
    const onDown = () => closeContextMenu();
    const onKey = (event) => {
      if (event.key === "Escape") closeContextMenu();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onDown, true);
    window.addEventListener("blur", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onDown, true);
      window.removeEventListener("blur", onDown);
    };
  }, [contextMenuState]);
  if (!contextMenuState) return null;
  const menu = contextMenuState;
  return h(
    "div",
    {
      className: "cg-menu",
      style: { left: menu.x, top: menu.y },
      onMouseDown: (event) => event.stopPropagation(),
    },
    menu.items.map((item, index) =>
      !item
        ? null
        : item.separator
          ? h("hr", { key: "sep" + index })
          : h(
            "button",
            {
              key: item.label + index,
              type: "button",
              className: item.danger ? "cg-danger" : "",
              disabled: item.disabled,
              onClick: () => {
                closeContextMenu();
                if (item.onClick) void item.onClick();
              },
            },
            item.icon ? h(Icon, { name: item.icon, size: 13 }) : h("span", { style: { width: "0.8125rem" } }),
            item.label,
          ),
    ),
  );
}

async function copyText(text) {
  const value = String(text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    toast("已复制", "success");
  } catch (error) {
    reportError(error, "复制失败");
  }
}

/* ---------- 差异面板 ---------- */

function DiffPane(props) {
  const h = appCtx.react.createElement;
  const { repo, entry, data } = props;
  if (!entry) {
    return h(
      "div",
      { className: "cg-diffcol" },
      h(Empty, { icon: "file", title: "选择一个文件查看差异" }, h("span", null, "支持按区块暂存、取消暂存与丢弃")),
    );
  }
  return h(
    "div",
    { className: "cg-diffcol" },
    h(FileDiffView, {
      key: (entry.path || "") + ":" + (entry.staged ? "s" : "w"),
      repo,
      entry,
      data,
      mode: modeForEntry(entry),
    }),
  );
}

function FileDiffView(props) {
  const h = appCtx.react.createElement;
  const { repo, entry, data, mode } = props;
  const key = diffCacheKey(entry, mode);
  const cache = data.diffCache[key];
  const s = useStoreSnapshot();
  const { useEffect, useState } = appCtx.react;
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState(null);
  useEffect(() => {
    void ensureFileDiff(repo, entry, mode);
  }, [repo, entry.path, entry.staged, mode, s.ignoreWhitespace, s.settings.diffContext, data.statusGeneration, Boolean(cache)]);
  const refresh = () => ensureFileDiff(repo, entry, mode, true);
  const stageFile = async () => {
    const result = await stageEntries(repo, [entry]);
    if (result && result.ok) void refresh();
  };
  const unstageFile = async () => {
    const result = await unstageEntries(repo, [entry]);
    if (result && result.ok) void refresh();
  };
  const discardFile = async () => {
    const result = await discardPaths(repo, [entry]);
    if (result && result.ok) void refresh();
  };
  const startEdit = () => {
    if (!cache || !cache.preview) return;
    setEditText(cache.preview.text || "");
    setEditError(null);
    setEditing(true);
  };
  const saveEdit = async () => {
    // textarea 会把换行统一成 LF；写回时恢复原文件的 CRLF，避免整文件换行被改写。
    const crlf = Boolean(cache && cache.preview && /\r\n/.test(cache.preview.text || ""));
    const textForSave = crlf
      ? editText.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
      : editText.replace(/\r\n/g, "\n");
    const result = await saveConflictFile(repo, entry.path, textForSave);
    if (result.ok) {
      setEditing(false);
      void refresh();
    } else {
      setEditError(result.text || "保存失败");
    }
  };
  const totalLines = cache && cache.files ? cache.files.reduce((sum, file) => sum + file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0), 0) : 0;
  let diffBudget = MAX_DIFF_LINES;
  return h(
    "div",
    { className: "cg-diff" },
    h(
      "div",
      { className: "cg-diff-head" },
      h(Icon, { name: entry.unmerged ? "warning" : "file", size: 13 }),
      h("span", { className: "cg-diff-head-title", title: entry.path }, entry.path),
      h(Badge, { tone: entry.unmerged ? "conflict" : statusTone(entryCode(entry)) }, entryCode(entry) || "?"),
      h("span", { className: "cg-muted cg-mini" }, mode === "staged" ? "暂存区 ↔ 当前提交" : entry.unmerged ? "冲突" : mode === "head" ? "工作区 ↔ 当前提交" : "工作区 ↔ 暂存区"),
      h("div", { style: { flex: 1 } }),
      cache && cache.loading ? h(Spinner, { size: 12 }) : null,
      entry.unmerged
        ? null
        : entry.staged
          ? h(IconBtn, { name: "minus", label: "取消暂存文件", onClick: unstageFile })
          : h(IconBtn, { name: "plus", label: "暂存文件", onClick: stageFile }),
      !entry.staged && entry.code !== "?" && !entry.unmerged
        ? h(IconBtn, { name: "undo", label: "回滚文件", onClick: discardFile })
        : null,
      h(IconBtn, { name: "history", label: "文件历史", onClick: () => openFileHistory(repo, entry.path) }),
      h(IconBtn, { name: "user", label: "逐行溯源", onClick: () => openBlame(repo, entry.path) }),
      h(IconBtn, { name: "refresh", label: "刷新差异", onClick: refresh }),
      h(
        "div",
        { className: "cg-seg", role: "group", "aria-label": "差异布局" },
        h("button", { type: "button", className: s.settings.diffLayout === "split" ? "" : "cg-on", title: "统一视图", onClick: () => saveSettings({ diffLayout: "unified" }) }, "统一"),
        h("button", { type: "button", className: s.settings.diffLayout === "split" ? "cg-on" : "", title: "并排视图", onClick: () => saveSettings({ diffLayout: "split" }) }, "并排"),
      ),
      h(Check, {
        checked: s.ignoreWhitespace,
        onChange: (value) => {
          state.ignoreWhitespace = value;
          notify();
        },
        title: "忽略空白差异（git diff -w）",
      }, "忽略空白"),
    ),
    cache && cache.error ? h(Banner, { tone: "error" }, cache.error) : null,
    entry.unmerged
      ? h(
          Banner,
          {
            tone: "info",
            actions: h(
              "span",
              { style: { display: "flex", gap: "0.25rem", flexWrap: "wrap" } },
              h(Btn, { size: "sm", onClick: () => resolveConflict(repo, entry.path, "ours") }, "采用我方"),
              h(Btn, { size: "sm", onClick: () => resolveConflict(repo, entry.path, "theirs") }, "采用对方"),
              cache && cache.preview && !cache.preview.binary && !cache.preview.truncated
                ? h(Btn, { size: "sm", icon: "edit", onClick: startEdit }, "编辑并解决")
                : null,
            ),
          },
          "该文件存在合并冲突。采用一侧或手动编辑后保存，即会标记为已解决。",
        )
      : null,
    editing
      ? h(
          "div",
          { className: "cg-diff", style: { padding: "0.5rem", gap: "0.375rem" } },
          editError ? h(Banner, { tone: "error" }, editError) : null,
          h("textarea", {
            className: "cg-textarea",
            value: editText,
            onChange: (event) => setEditText(event.target.value),
            style: { flex: 1, minHeight: "clamp(10rem,40vh,24rem)", height: "100%" },
            spellCheck: false,
          }),
          h(
            "div",
            { style: { display: "flex", gap: "0.375rem", justifyContent: "flex-end" } },
            h(Btn, { onClick: () => setEditing(false) }, "取消"),
            h(Btn, { variant: "primary", icon: "check", onClick: saveEdit }, "保存并标记解决"),
          ),
        )
      : h(
          "div",
          { className: "cg-diff-body" },
          !cache ? h("div", { className: "cg-notice" }, "正在加载差异…")
            : cache.loading && !cache.preview && !cache.files.length ? h("div", { className: "cg-notice" }, "正在加载差异…")
            : cache.preview ? h(PreviewFile, { preview: cache.preview })
            : cache.files.length
              ? cache.files.map((file, fileIndex) => {
                  if (diffBudget <= 0) return null;
                  const block = h(DiffFileBlock, {
                    key: fileIndex,
                    repo,
                    entry,
                    file,
                    mode,
                    refresh,
                    budget: diffBudget,
                  });
                  for (const hunk of file.hunks) diffBudget -= hunk.lines.length;
                  return block;
                })
              : h(Empty, { icon: "check", title: "没有差异" }, h("span", null, "该文件在该视图下没有可显示的差异")),
          cache && cache.truncated ? h("div", { className: "cg-truncated" }, "差异内容达到 64KB 输出上限，仅显示前半部分。") : null,
          cache && totalLines > MAX_DIFF_LINES
            ? h("div", { className: "cg-truncated" }, "差异过大，已截断显示（" + totalLines + " 行）。")
            : null,
        ),
  );
}

function PreviewFile(props) {
  const h = appCtx.react.createElement;
  const preview = props.preview;
  if (preview.binary) return h("div", { className: "cg-notice" }, "二进制文件，无法预览。");
  const lines = splitLines(preview.text || "");
  if (lines.length && lines[lines.length - 1] === "" && /\n$/.test(preview.text || "")) lines.pop();
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return h(
    "div",
    { className: "cg-diff-file" },
    h(
      "div",
      { className: "cg-diff-file-head" },
      h(Icon, { name: "file", size: 12 }),
      preview.conflict ? "冲突文件当前内容" : "新文件内容",
      h("span", { className: "cg-muted cg-mini" }, lines.length + " 行"),
    ),
    preview.conflict
      ? h("div", { className: "cg-notice", style: { textAlign: "left" } }, "文件中仍可能包含 <<<<<<< / ======= / >>>>>>> 冲突标记，可使用上方“编辑并解决”。")
      : null,
    shown.map((line, index) =>
      h(
        "div",
        { key: index, className: "cg-preview-line" },
        h("span", { className: "cg-ln" }, index + 1),
        h("span", { className: "cg-code" }, line || " "),
      ),
    ),
    lines.length > shown.length ? h("div", { className: "cg-truncated" }, "仅显示前 " + MAX_DIFF_LINES + " 行。") : null,
    preview.truncated ? h("div", { className: "cg-truncated" }, "文件读取达到上限，内容已截断。") : null,
  );
}

function DiffFileBlock(props) {
  const h = appCtx.react.createElement;
  const { useState } = appCtx.react;
  const { repo, entry, file, mode, refresh } = props;
  const [picked, setPicked] = useState({});
  const limit = Math.max(0, Math.min(MAX_DIFF_LINES, Number(props.budget) || MAX_DIFF_LINES));
  const split = state.settings.diffLayout === "split";
  const selectable = !entry.unmerged && (mode === "staged" || (mode === "worktree" && entry.code !== "?"));
  const toggleLine = (hunkIndex, lineIndex) => {
    const next = Object.assign({}, picked);
    const set = new Set(next[hunkIndex] || []);
    if (set.has(lineIndex)) set.delete(lineIndex);
    else set.add(lineIndex);
    next[hunkIndex] = set;
    setPicked(next);
  };
  const run = (hunkIndex, hunk, action) => {
    const set = picked[hunkIndex];
    return applyHunk(repo, file, hunk, action, set && set.size ? set : null).then((result) => {
      setPicked({});
      refresh();
      return result;
    });
  };
  let rendered = 0;
  const blocks = [];
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
    const hunk = file.hunks[hunkIndex];
    if (rendered >= limit) break;
    const set = picked[hunkIndex];
    const count = set ? set.size : 0;
    const suffix = count ? "所选 " + count + " 行" : "区块";
    const actions = [];
    if (count) {
      actions.push(h(Btn, { key: "c", size: "sm", variant: "ghost", onClick: () => setPicked(Object.assign({}, picked, { [hunkIndex]: new Set() })) }, "清除选择"));
    }
    if (mode === "worktree" && !entry.unmerged) {
      actions.push(h(Btn, { key: "s", size: "sm", icon: "plus", onClick: () => run(hunkIndex, hunk, "stage") }, "暂存" + suffix));
    }
    if (mode === "staged") {
      actions.push(h(Btn, { key: "u", size: "sm", icon: "minus", onClick: () => run(hunkIndex, hunk, "unstage") }, "取消暂存" + suffix));
    }
    if (mode === "worktree" && !entry.unmerged && entry.code !== "?") {
      actions.push(
        h(Btn, {
          key: "d",
          size: "sm",
          variant: "danger",
          icon: "undo",
          onClick: async () => {
            const confirmed = await confirmDestructive({
              title: count ? "丢弃所选行" : "丢弃区块",
              message: (count ? "丢弃所选 " + count + " 行" : "丢弃 " + hunk.header + " 对应") + "的本地更改？此操作无法撤销。",
              confirmLabel: "丢弃",
              danger: true,
            });
            if (confirmed) void run(hunkIndex, hunk, "discard");
          },
        }, "丢弃" + suffix),
      );
    }
    blocks.push(
      h(
        "div",
        { key: "h" + hunkIndex, className: "cg-hunk-head" },
        h("span", { className: "cg-mono cg-ellipsis", title: hunk.header }, hunk.header),
        h("span", { className: "cg-spacer" }),
        selectable && !count ? h("span", { className: "cg-muted cg-mini" }, "点击行号可选择单行") : null,
        actions,
      ),
    );
    const onPick = selectable ? (lineIndex) => toggleLine(hunkIndex, lineIndex) : null;
    const bodyRows = [];
    if (split) {
      const rows = pairSplitRows(hunk.lines);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (rendered >= limit) break;
        rendered += 1;
        bodyRows.push(h(SplitDiffRow, { key: "r" + hunkIndex + ":" + rowIndex, row: rows[rowIndex], lines: hunk.lines, set, onPick }));
      }
      blocks.push(h("div", { key: "b" + hunkIndex, className: "cg-hunk-body" }, h("div", { className: split ? "cg-split-grid" : "cg-hunk-inner" }, bodyRows)));
      continue;
    }
    for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
      const line = hunk.lines[lineIndex];
      if (rendered >= limit) break;
      rendered += 1;
      bodyRows.push(h(DiffLine, { key: "l" + hunkIndex + ":" + lineIndex, line, index: lineIndex, picked: Boolean(set && set.has(lineIndex)), onPick }));
    }
    blocks.push(h("div", { key: "b" + hunkIndex, className: "cg-hunk-body" }, h("div", { className: split ? "cg-split-grid" : "cg-hunk-inner" }, bodyRows)));
  }
  return h(
    "div",
    { className: "cg-diff-file" },
    h(
      "div",
      { className: "cg-diff-file-head" },
      h(Icon, { name: "file", size: 12 }),
      h("span", { className: "cg-ellipsis", style: { flex: 1 } }, file.name || entry.path),
      file.isNew ? h(Badge, { tone: "add" }, "新增") : null,
      file.isDeleted ? h(Badge, { tone: "del" }, "删除") : null,
      file.isRename ? h(Badge, { tone: "move" }, "重命名") : null,
      h("span", { className: "cg-muted cg-mini" }, "+" + file.adds + " −" + file.dels),
    ),
    file.binary ? h("div", { className: "cg-notice" }, "二进制文件，无法显示文本差异。") : null,
    blocks,
    rendered >= limit ? h("div", { className: "cg-truncated" }, "差异显示达到 " + MAX_DIFF_LINES + " 行上限，已截断。") : null,
  );
}

/** 并排视图:上下文行两侧同显;连续的删除段与新增段按顺序配对。元素为 {left, right} 行下标(可为 -1)。 */
function pairSplitRows(lines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i += 1) rows.push({ left: i < dels.length ? dels[i] : -1, right: i < adds.length ? adds[i] : -1 });
    dels = [];
    adds = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const kind = lines[i].kind;
    if (kind === "del") {
      if (adds.length) flush();
      dels.push(i);
    } else if (kind === "add") adds.push(i);
    else {
      flush();
      rows.push({ left: i, right: i, both: true });
    }
  }
  flush();
  return rows;
}

function SplitDiffRow(props) {
  const h = appCtx.react.createElement;
  const { row, lines, set, onPick } = props;
  const cell = (index, side) => {
    if (index < 0) return h("div", { className: "cg-split-cell cg-split-empty" });
    const line = lines[index];
    if (line.kind === "meta" || line.kind === "note") {
      return h("div", { className: "cg-split-cell cg-note" }, h("span", { className: "cg-code" }, line.text || " "));
    }
    const changed = line.kind === "add" || line.kind === "del";
    const no = side === "left" ? line.oldNo : line.newNo;
    const isPicked = Boolean(changed && set && set.has(index));
    return h(
      "div",
      { className: cx("cg-split-cell", line.kind === "add" ? "cg-add" : line.kind === "del" ? "cg-del" : "", isPicked ? "cg-picked" : "") },
      h(
        "span",
        {
          className: cx("cg-ln", changed && onPick ? "cg-pickable" : ""),
          onClick: changed && onPick ? () => onPick(index) : undefined,
          title: changed && onPick ? "选择/取消选择此行" : undefined,
        },
        no == null ? "" : no,
      ),
      h("span", { className: "cg-code" }, (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + (line.text || " ")),
    );
  };
  return h("div", { className: "cg-split-row" }, cell(row.left, "left"), cell(row.right, "right"));
}

function DiffLine(props) {
  const h = appCtx.react.createElement;
  const { line, onPick, index } = props;
  const cls = line.kind === "add" ? "cg-add" : line.kind === "del" ? "cg-del" : line.kind === "note" ? "cg-note" : "";
  if (line.kind === "meta") {
    return h("div", { className: "cg-dline cg-note" }, h("span", { className: "cg-code" }, line.text || " "));
  }
  const changed = line.kind === "add" || line.kind === "del";
  const pick = changed && onPick ? () => onPick(index) : undefined;
  return h(
    "div",
    { className: cx("cg-dline", cls, props.picked ? "cg-picked" : "") },
    h("span", { className: cx("cg-ln", pick ? "cg-pickable" : ""), onClick: pick, title: pick ? "选择/取消选择此行" : undefined }, line.oldNo == null ? "" : line.oldNo),
    h("span", { className: cx("cg-ln2", pick ? "cg-pickable" : ""), onClick: pick }, line.newNo == null ? "" : line.newNo),
    h("span", { className: "cg-code" }, (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + (line.text || " ")),
  );
}

/* ---------- 提交区 ---------- */

function CommitBox(props) {
  const h = appCtx.react.createElement;
  const { repo, data } = props;
  const s = useStoreSnapshot();
  const { useState } = appCtx.react;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);
  const message = s.drafts[repo] || "";
  const checked = checkedPaths(repo);
  const stagedCount = data.status.staged.length;
  const conflicts = data.status.conflicted.length;
  const busy = Boolean(s.busy);
  const canCommit = !busy && !conflicts && (message.trim().length > 0 || s.commitAmend) && (checked.length > 0 || s.commitAmend || s.commitAllowEmpty);
  const subjectLen = (message.split("\n")[0] || "").trim().length;
  const optionCount = [s.commitSignOff, s.commitSkipHooks, s.commitNoGpg, s.commitAllowEmpty, s.commitPush].filter(Boolean).length;
  const setFlag = (key, value) => {
    state[key] = value;
    const settingKey = { commitSignOff: "signOff", commitSkipHooks: "skipHooks", commitNoGpg: "noGpgSign" }[key];
    if (settingKey) void saveSettings({ [settingKey]: Boolean(value) });
    notify();
  };
  const doCommit = (push) => {
    void commitChanges(repo, { message, push: Boolean(push || state.commitPush) });
  };
  return h(
    "div",
    { className: "cg-commitbox" },
    conflicts
      ? h(Banner, { tone: "error" }, "还有 " + conflicts + " 个未解决冲突，解决前无法提交。")
      : null,
    h(
      "div",
      { style: { display: "flex", gap: "0.375rem", alignItems: "flex-start" } },
      h("textarea", {
        className: "cg-textarea",
        style: { flex: 1, minHeight: "3.5rem" },
        placeholder: s.commitAmend ? "修改最新提交的说明（会包含已暂存更改）" : "提交信息（Ctrl+Enter 提交）",
        value: message,
        spellCheck: false,
        onChange: (event) => setDraft(repo, event.target.value),
        onKeyDown: (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            if (canCommit) doCommit(false);
          }
        },
      }),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "3px", flex: "none", position: "relative" } },
        h(IconBtn, {
          name: "history",
          label: "提交信息历史",
          active: historyOpen,
          onClick: () => setHistoryOpen(!historyOpen),
        }),
        h(IconBtn, {
          name: "check",
          label: "提交 (Ctrl+Enter)",
          onClick: () => canCommit && doCommit(false),
          disabled: !canCommit,
          style: { color: canCommit ? "var(--color-state-success-text)" : undefined },
        }),
      ),
    ),
    historyOpen
      ? h(
          "div",
          { className: "cg-menu cg-commit-pop" },
          s.commitHistory.length
            ? s.commitHistory.map((item, index) =>
                h(
                  "button",
                  {
                    key: index,
                    type: "button",
                    title: item,
                    onClick: () => {
                      setDraft(repo, item);
                      setHistoryOpen(false);
                    },
                  },
                  h(Icon, { name: "history", size: 12 }),
                  h("span", { className: "cg-ellipsis" }, item.split("\n")[0]),
                ),
              )
            : h("div", { className: "cg-notice" }, "暂无历史"),
        )
      : null,
    optsOpen
      ? h(
          "div",
          { className: "cg-menu cg-commit-opts cg-commit-pop" },
          h(Check, { checked: s.commitSignOff, onChange: (value) => setFlag("commitSignOff", value) }, "署名（Sign-off）"),
          h(Check, { checked: s.commitSkipHooks, onChange: (value) => setFlag("commitSkipHooks", value) }, "跳过钩子（--no-verify）"),
          h(Check, { checked: s.commitNoGpg, onChange: (value) => setFlag("commitNoGpg", value) }, "禁用 GPG 签名（--no-gpg-sign）"),
          h(Check, { checked: s.commitAllowEmpty, onChange: (value) => setFlag("commitAllowEmpty", value) }, "允许空提交"),
          h(Check, { checked: s.commitPush, onChange: (value) => setFlag("commitPush", value) }, "提交后推送"),
        )
      : null,
    h(
      "div",
      { className: "cg-commit-actions" },
      h(Check, {
        checked: s.commitAmend,
        onChange: (value) => {
          state.commitAmend = value;
          if (value && !message.trim()) setDraft(repo, data.headMessage || "");
          // Amend 默认只提交索引；勾选文件才会把工作区内容加入，避免误把全部更改写进旧提交。
          if (value) {
            // 取消 Amend 时恢复用户原本的勾选，不能无条件全选把提交范围放大。
            data.amendCheckedSnapshot = Object.assign({}, state.checkedByRepo[repo] || {});
            setAllChecked(repo, false);
          } else if (data.amendCheckedSnapshot) {
            state.checkedByRepo[repo] = data.amendCheckedSnapshot;
            data.amendCheckedSnapshot = null;
          } else {
            setAllChecked(repo, true);
          }
          notify();
        },
        title: "修改最新提交（--amend）",
      }, "修补"),
      h(Btn, {
        size: "sm",
        variant: "ghost",
        icon: "settings",
        className: optsOpen ? "cg-on" : "",
        title: "提交选项",
        onClick: () => setOptsOpen(!optsOpen),
      }, "选项" + (optionCount ? " · " + optionCount : "")),
      h(
        "span",
        { className: cx("cg-mini cg-subject-len", subjectLen > 72 ? "cg-over" : subjectLen > 50 ? "cg-warn" : ""), title: "主题行建议不超过 50 字符，最多 72" },
        subjectLen ? subjectLen + "/50" : "",
      ),
      h("span", { className: "cg-spacer" }),
      h("span", { className: "cg-muted cg-mini" }, stagedCount ? "已暂存 " + stagedCount : checked.length ? "已选 " + checked.length : "无暂存"),
      h(Btn, { size: "sm", icon: "push", onClick: () => doCommit(true), disabled: !canCommit }, "提交并推送"),
      h(Btn, { size: "sm", icon: "check", onClick: () => doCommit(false), disabled: !canCommit, variant: "primary" }, busy ? "提交中…" : s.commitAmend ? "修补提交" : "提交"),
    ),
  );
}
