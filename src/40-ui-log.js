/* ---------------------------------------------------------------------------
 * 本分片：提交图（含 lane 拓扑）、提交详情、文件历史、Blame。
 * ------------------------------------------------------------------------- */

const COMMIT_DETAIL_CACHE_LIMIT = 8;

async function selectCommit(repo, commit) {
  const data = ensureRepoData(repo);
  if (!commit) {
    data.selectedCommit = null;
    notify();
    return;
  }
  const hash = commit.hash;
  data.selectedCommit = {
    hash,
    commit,
    loading: true,
    body: "",
    files: [],
    error: null,
  };
  notify();
  try {
    const metaRes = await runGit(repo, ["show", "-s", "--no-color", "--format=%an%x1f%ae%x1f%at%x1f%P%x1f%s%x1f%B", hash], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (metaRes.code !== 0) throw new GitCommandError((metaRes.stderr || "").trim(), metaRes.entry);
    const fields = metaRes.stdout.split("\x1f");
    const merged = Object.assign({}, commit, {
      author: fields[0] || commit.author || "",
      email: fields[1] || commit.email || "",
      at: parseEpoch(fields[2]) || commit.at || 0,
      parents: fields[3] ? fields[3].trim().split(" ").filter(Boolean) : commit.parents || [],
      subject: fields[4] || commit.subject || "",
      body: fields.slice(5).join("\x1f").trim(),
    });
    // 合并提交对比第一父提交，否则 IDEA 式的文件列表会为空。
    const diffArgs = merged.parents.length
      ? ["diff-tree", "--no-commit-id", "-r", "-M", "--name-status", "-z", merged.parents[0], hash]
      : ["diff-tree", "--no-commit-id", "-r", "-M", "--root", "--name-status", "-z", hash];
    const filesRes = await runGit(repo, diffArgs, { allowFailure: true, timeoutMs: 30000 });
    const files = filesRes.code === 0 ? parseNameStatusZ(filesRes.stdout) : [];
    if (!data.selectedCommit || data.selectedCommit.hash !== hash) return;
    data.selectedCommit = Object.assign({}, data.selectedCommit, {
      loading: false,
      commit: merged,
      body: merged.body,
      files,
      error: null,
    });
    notify();
  } catch (error) {
    if (!data.selectedCommit || data.selectedCommit.hash !== hash) return;
    data.selectedCommit = Object.assign({}, data.selectedCommit, {
      loading: false,
      error: safeError(error),
    });
    notify();
  }
}

/** 读取某提交中单个文件的 diff 文本（提交详情与差异弹窗共用）。 */
async function fetchCommitFileDiff(repo, hash, path, origPath, parents) {
  const paths = [path];
  if (origPath && origPath !== path) paths.push(origPath);
  const args = parents && parents.length
    ? ["diff", "--no-color", "--no-ext-diff", "--no-textconv", parents[0], hash, "--"].concat(paths)
    : ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", hash, "--"].concat(paths);
  const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
  if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  return res.stdout || "";
}

/** 打开提交中单个文件的差异弹窗（单击文件行、双击或行尾按钮触发）。 */
let diffDialogSeq = 0;
async function openCommitFileDiffDialog(repo, hash, item, commit) {
  if (!item) return;
  // 同一文件已打开时复用当前弹窗，双击会先触发两次单击，避免重复请求。
  if (state.diffDialog && state.diffDialog.hash === hash && state.diffDialog.path === item.path) return;
  state.diffDialog = {
    // 序号不随关闭归零，否则旧请求返回时会覆盖新弹窗的内容。
    id: (diffDialogSeq += 1),
    repo,
    hash,
    path: item.path,
    origPath: item.origPath || null,
    subject: (commit && commit.subject) || "",
    loading: true,
    text: "",
    files: [],
    error: null,
  };
  notify();
  const myId = state.diffDialog.id;
  try {
    const text = await fetchCommitFileDiff(repo, hash, item.path, item.origPath, (commit && commit.parents) || []);
    if (!state.diffDialog || state.diffDialog.id !== myId) return;
    state.diffDialog = Object.assign({}, state.diffDialog, {
      loading: false,
      text,
      files: parseUnifiedDiff(text),
      error: null,
    });
  } catch (error) {
    if (!state.diffDialog || state.diffDialog.id !== myId) return;
    state.diffDialog = Object.assign({}, state.diffDialog, {
      loading: false,
      text: "",
      files: [],
      error: safeError(error),
    });
  }
  notify();
}

function closeDiffDialog() {
  if (!state.diffDialog) return;
  state.diffDialog = null;
  notify();
}

async function openCommitFromBlame(repo, commit) {
  state.history = null;
  state.activeTab = "log";
  const view = getLogView(repo);
  view.filter = defaultLogFilter();
  // 之前可能是 --follow 的文件历史：必须清掉分页与旧列表，否则 --skip 会跳过新提交。
  view.commits = [];
  view.offset = 0;
  view.hasMore = true;
  view.error = null;
  notify();
  void (async () => {
    await loadLog(repo, true);
    await selectCommit(repo, commit);
  })();
}

/* ---------- 提交图布局 ---------- */

function buildGraphRows(commits) {
  const lanes = [];
  const rows = [];
  let maxLanes = 1;
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) {
        lane = lanes.length;
        lanes.push(null);
      }
      lanes[lane] = commit.hash;
    }
    const before = lanes.slice();
    const parents = (commit.parents || []).filter(Boolean);
    const after = before.slice();
    after[lane] = parents[0] || null;
    const extra = [];
    for (let index = 1; index < parents.length; index += 1) {
      const parent = parents[index];
      let at = after.indexOf(parent);
      if (at < 0) {
        at = after.indexOf(null);
        if (at < 0) {
          at = after.length;
          after.push(null);
        }
        after[at] = parent;
        extra.push(at);
      }
    }
    maxLanes = Math.max(maxLanes, before.length, after.length);
    rows.push({
      hash: commit.hash,
      lane,
      before,
      after,
      extra,
      parents,
    });
    lanes.length = 0;
    for (const value of after) lanes.push(value);
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
  }
  return { rows, maxLanes: Math.min(12, maxLanes) };
}

function laneColor(index) {
  return LANE_COLORS[Math.abs(index) % LANE_COLORS.length];
}

function GraphCell(props) {
  const h = appCtx.react.createElement;
  const { row, maxLanes } = props;
  const width = Math.max(16, Math.min(12, maxLanes) * 14 + 8);
  const mid = 14;
  const limit = Math.min(12, maxLanes);
  // lane 数超过 12 时，后续列折到最后一列，避免节点画出 viewBox。
  const x = (index) => 7 + Math.min(index, limit - 1) * 14;
  const nodes = [];
  for (let index = 0; index < limit; index += 1) {
    const from = row.before[index];
    const to = row.after[index];
    if (from && to && from === to) {
      nodes.push(
        h("line", {
          key: "v" + index,
          x1: x(index),
          y1: 0,
          x2: x(index),
          y2: 28,
          stroke: laneColor(index),
          strokeWidth: 1.4,
          opacity: 0.75,
        }),
      );
    }
  }
  for (const parent of row.parents) {
    const target = row.after.indexOf(parent);
    if (target < 0 || target >= limit) continue;
    nodes.push(
      h("path", {
        key: "p" + parent,
        d: "M" + x(row.lane) + " " + mid + " C " + x(row.lane) + " 22, " + x(target) + " 20, " + x(target) + " 29",
        fill: "none",
        stroke: laneColor(target),
        strokeWidth: 1.4,
        opacity: 0.9,
      }),
    );
  }
  for (let index = 0; index < limit; index += 1) {
    if (row.before[index] && row.before[index] !== row.after[index] && index !== row.lane && !row.parents.includes(row.before[index])) {
      nodes.push(
        h("line", {
          key: "o" + index,
          x1: x(index),
          y1: 0,
          x2: x(index),
          y2: 28,
          stroke: laneColor(index),
          strokeWidth: 1.2,
          opacity: 0.4,
        }),
      );
    }
  }
  if (row.before[row.lane]) {
    nodes.push(
      h("line", {
        key: "top",
        x1: x(row.lane),
        y1: 0,
        x2: x(row.lane),
        y2: mid,
        stroke: laneColor(row.lane),
        strokeWidth: 1.4,
        opacity: 0.9,
      }),
    );
  }
  nodes.push(
    h("circle", {
      key: "node",
      cx: x(row.lane),
      cy: mid,
      r: 3.6,
      fill: laneColor(row.lane),
      stroke: "var(--color-background-primary-default)",
      strokeWidth: 1.2,
    }),
  );
  return h(
    "svg",
    { className: "cg-graph", width, height: 28, viewBox: "0 0 " + width + " 28", "aria-hidden": true },
    nodes,
  );
}

/* ---------- 提交图 ---------- */

function LogTab(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const { useEffect, useRef, useMemo } = appCtx.react;
  const repo = props.repo;
  const data = ensureRepoData(repo);
  const view = getLogView(repo);
  const graph = useMemo(() => buildGraphRows(view.commits), [view.commits]);
  const selected = data.selectedCommit;
  const historyPath = s.history && pathKey(s.history.repo) === pathKey(repo) ? s.history.path : "";
  useEffect(() => {
    if (!view.commits.length && !view.loading) void loadLog(repo, true);
  }, [repo]);
  const searchRef = useRef(view.filter.text || "");
  const authorRef = useRef(view.filter.author || "");
  const searchInputRef = useRef(null);
  const authorInputRef = useRef(null);
  useEffect(() => {
    searchRef.current = view.filter.text || "";
    authorRef.current = view.filter.author || "";
    // 非受控输入只在筛选值来自外部（退出文件历史、切仓）时同步，避免打断正在输入的光标。
    if (searchInputRef.current && searchInputRef.current.value !== (view.filter.text || "")) {
      searchInputRef.current.value = view.filter.text || "";
    }
    if (authorInputRef.current && authorInputRef.current.value !== (view.filter.author || "")) {
      authorInputRef.current.value = view.filter.author || "";
    }
  }, [repo, view.filter.text, view.filter.author]);
  // 文件历史被切仓清空后，--follow 路径不能残留在普通提交图里。
  useEffect(() => {
    if (!historyPath && view.filter.path) {
      view.filter.path = "";
      void loadLog(repo, true);
    }
  }, [repo, historyPath, view.filter.path]);
  const applyFilter = () => {
    void loadLog(repo, true, {
      filter: { text: searchRef.current.trim(), author: authorRef.current.trim() },
    });
  };
  const clearFilter = () => {
    searchRef.current = "";
    authorRef.current = "";
    if (searchInputRef.current) searchInputRef.current.value = "";
    if (authorInputRef.current) authorInputRef.current.value = "";
    void loadLog(repo, true, { filter: { text: "", author: "" } });
  };
  const exitHistory = () => {
    const prev = s.history && s.history.prevFilter ? s.history.prevFilter : defaultLogFilter();
    state.history = null;
    state.activeTab = "log";
    void loadLog(repo, true, { filter: Object.assign(defaultLogFilter(), prev) });
    notify();
  };
  const commit = selected ? selected.commit : null;
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Icon, { name: "commit", size: 13 }),
      h("b", null, historyPath ? "文件历史" : "提交图"),
      historyPath ? h(Badge, { tone: "move", title: historyPath }, truncate(historyPath, 40)) : null,
      historyPath ? h(IconBtn, { name: "x", label: "退出文件历史", onClick: exitHistory }) : null,
      h("div", { style: { flex: 1 } }),
      h("input", {
        ref: authorInputRef,
        className: "cg-input cg-filter-input",
        placeholder: "作者",
        defaultValue: view.filter.author || "",
        onChange: (event) => {
          authorRef.current = event.target.value;
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") applyFilter();
          else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            clearFilter();
          }
        },
      }),
      h("input", {
        ref: searchInputRef,
        className: "cg-input cg-filter-input",
        placeholder: "搜索提交信息",
        defaultValue: view.filter.text || "",
        onChange: (event) => {
          searchRef.current = event.target.value;
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") applyFilter();
          else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            clearFilter();
          }
        },
      }),
      h(IconBtn, { name: "search", label: "筛选", onClick: applyFilter }),
      h(Check, {
        checked: view.filter.all,
        onChange: (value) => {
          view.filter.all = value;
          void loadLog(repo, true);
        },
        title: "显示所有引用（--all）",
      }, "所有分支"),
      h(IconBtn, {
        name: "refresh",
        label: "刷新提交图",
        onClick: () =>
          loadLog(repo, true, {
            filter: Object.assign({}, view.filter, {
              text: searchRef.current.trim(),
              author: authorRef.current.trim(),
            }),
          }),
      }),
      h(IconBtn, { name: "x", label: "清除筛选", onClick: clearFilter }),
      h(IconBtn, { name: "archive", label: "压缩最近提交", onClick: () => squashDialog(repo) }),
      h(IconBtn, { name: "file", label: "导出当前更改补丁", onClick: () => exportPatch(repo, null) }),
      h(IconBtn, { name: "download", label: "应用补丁文件", onClick: () => applyPatch(repo) }),
    ),
    view.error ? h(Banner, { tone: "error" }, view.error) : null,
    view.truncated ? h(Banner, { tone: "error" }, "git log 输出达到 64KB 上限，已截断。") : null,
    h(
      "div",
      { className: "cg-log" },
      h(
        "div",
        { className: "cg-log-list" },
        h(
          "div",
          { className: "cg-log-scroll" },
          h(
            "div",
            { className: "cg-commit-head" },
            h("span", { className: "cg-commit-head-label" }, "提交"),
            h("span", { className: "cg-commit-meta cg-commit-author" }, "作者"),
            h("span", { className: "cg-commit-meta cg-commit-date" }, "日期"),
            h("span", { className: "cg-commit-meta cg-commit-time" }, "时间"),
            h("span", { className: "cg-commit-meta cg-commit-hash" }, "哈希"),
          ),
          view.commits.map((item, index) =>
            h(CommitRow, {
              key: item.hash,
              repo,
              commit: item,
              graphRow: graph.rows[index],
              maxLanes: graph.maxLanes,
              selected: selected && selected.hash === item.hash,
              onSelect: () => selectCommit(repo, item),
            }),
          ),
          !view.commits.length && view.loading
            ? h("div", { className: "cg-notice" }, "正在加载提交…")
            : !view.commits.length
              ? h(Empty, { icon: "commit", title: "没有提交记录" }, h("span", null, "仓库可能还没有提交，或筛选条件过窄"))
              : null,
          view.hasMore
            ? h(
                "div",
                { style: { padding: "0.5rem", textAlign: "center" } },
                h(Btn, { size: "sm", icon: "chevron-down", onClick: () => loadLog(repo, false), disabled: view.loading }, view.loading ? "加载中…" : "加载更多"),
              )
            : null,
        ),
      ),
      h(CommitDetail, { repo, data }),
    ),
  );
}

function CommitRow(props) {
  const h = appCtx.react.createElement;
  const { repo, commit, graphRow, maxLanes, selected, onSelect } = props;
  return h(
    "div",
    {
      className: cx("cg-commit-row", selected ? "cg-selected" : "", commit.head ? "cg-is-head" : ""),
      onClick: onSelect,
      onContextMenu: (event) => {
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY, commitMenuItems(repo, commit));
      },
      title: commit.hash + "\n" + commit.author + " · " + relativeTime(commit.at),
    },
    graphRow ? h(GraphCell, { row: graphRow, maxLanes }) : h("span", { style: { width: "1rem" } }),
    h(
      "div",
      { className: "cg-commit-text" },
      commit.head ? h("span", { className: "cg-ref cg-head", title: "当前提交（HEAD）" }, "HEAD") : null,
      commit.branches.map((name) => h("span", { key: "b" + name, className: "cg-ref cg-branch", title: name }, name)),
      commit.tags.map((name) => h("span", { key: "t" + name, className: "cg-ref cg-tag", title: name }, name)),
      (commit.remotes || [])
        .slice(0, 3)
        .map((ref) => h("span", { key: "r" + ref, className: "cg-ref cg-remote", title: ref }, ref)),
      h("span", { className: "cg-commit-subject" }, commit.subject || "(无提交信息)"),
    ),
    h("span", { className: "cg-commit-meta cg-commit-author", title: commit.author }, commit.author),
    h("span", { className: "cg-commit-meta cg-commit-date", title: shortDate(commit.at) }, dateOnly(commit.at)),
    h("span", { className: "cg-commit-meta cg-commit-time", title: shortDate(commit.at) }, relativeTime(commit.at)),
    h("span", { className: "cg-commit-meta cg-commit-hash cg-mono" }, shortHash(commit.hash)),
  );
}

function commitMenuItems(repo, commit) {
  return [
    { label: "在此新建分支", icon: "branch", onClick: () => createBranchDialog(repo, commit.hash) },
    { label: "检出此提交（游离 HEAD）", icon: "git", onClick: () => checkoutCommit(repo, commit.hash) },
    { label: "拣选到当前分支（Cherry-pick）", icon: "merge", onClick: () => cherryPickCommits(repo, [commit.hash]) },
    { label: "还原提交（Revert）", icon: "undo", onClick: () => revertCommit(repo, commit.hash) },
    { label: "重置当前分支到此提交", icon: "history", onClick: () => resetDialog(repo, commit.hash) },
    { label: "从历史中删除（drop）", icon: "trash", onClick: () => dropCommit(repo, commit.hash), danger: true },
    { label: "修改提交信息（仅最新提交）", icon: "edit", onClick: () => editCommitMessageDialog(repo, commit.hash) },
    { separator: true },
    { label: "创建标签", icon: "tag", onClick: () => tagCommitDialog(repo, commit.hash) },
    { label: "复制哈希", icon: "copy", onClick: () => copyText(commit.hash) },
    { label: "导出为补丁", icon: "file", onClick: () => exportPatch(repo, { kind: "commit", hash: commit.hash }) },
  ];
}

/** 带半选态的复选框：indeterminate 只能通过 DOM 属性设置。 */
function RowCheck(props) {
  const h = appCtx.react.createElement;
  const { useEffect, useRef } = appCtx.react;
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(props.indeterminate);
  });
  return h("input", {
    ref: ref,
    className: "cg-row-check",
    type: "checkbox",
    checked: Boolean(props.checked),
    title: props.title,
    onClick: (event) => event.stopPropagation(),
    onChange: () => {
      if (props.onChange) props.onChange();
    },
  });
}

/** 递归收集目录节点下的全部条目。 */
function treeEntries(node, out) {
  if (!node) return out;
  if (node.type === "dir") {
    for (const child of node.children || []) treeEntries(child, out);
  } else if (node.entry) {
    out.push(node.entry);
  }
  return out;
}

function FileTreeList(props) {
  const h = appCtx.react.createElement;
  const { useState } = appCtx.react;
  const { files, activePath, onSelect, codeOf, toneOf, checkedOf, onToggleCheck, onCheckMany, onActivate } = props;
  const readCode = codeOf || ((entry) => entry.code);
  const readTone = toneOf || ((entry) => statusTone(entry.code));
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggleDir = (path) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const nodes = buildCompactFileTree(files || []);
  const rows = [];
  const walk = (list, depth) => {
    for (const node of list) {
      if (node.type === "dir") {
        const isCollapsed = collapsed.has(node.path);
        const dirEntries = checkedOf ? treeEntries(node, []) : [];
        const dirChecked = dirEntries.length > 0 && dirEntries.every((entry) => checkedOf(entry));
        const dirPartial = !dirChecked && dirEntries.some((entry) => checkedOf(entry));
        rows.push(
          h(
            "div",
            {
              key: "d:" + node.path,
              className: "cg-row cg-tree-row",
              style: { paddingLeft: 0.375 + depth * 0.75 + "rem" },
              title: node.path,
              onClick: () => toggleDir(node.path),
            },
            h("span", { className: "cg-chev" }, h(Icon, { name: isCollapsed ? "chevron-right" : "chevron-down", size: 11 })),
            checkedOf
              ? h(RowCheck, {
                  checked: dirChecked,
                  indeterminate: dirPartial,
                  title: dirChecked ? "取消选择该目录下全部文件" : "选择该目录下全部文件",
                  onChange: () => onCheckMany && onCheckMany(dirEntries, !dirChecked),
                })
              : null,
            h(Icon, { name: "folder", size: 12, style: { color: "var(--color-text-tertiary)" } }),
            h("span", { className: "cg-row-name" }, node.name),
          ),
        );
        if (!isCollapsed) walk(node.children, depth + 1);
        continue;
      }
      const entry = node.entry || {};
      rows.push(
        h(
          "div",
          {
            key: "f:" + node.path,
            className: cx("cg-row cg-tree-row", activePath === node.path ? "cg-selected" : ""),
            style: { paddingLeft: 0.375 + depth * 0.75 + "rem" },
            title: entry.origPath ? entry.origPath + " → " + node.path : node.path,
            onClick: () => onSelect(entry),
            onDoubleClick: onActivate ? () => onActivate(entry) : undefined,
          },
          h("span", { className: "cg-chev", style: { width: 11, flex: "none" } }),
          checkedOf
            ? h(RowCheck, {
                checked: Boolean(checkedOf(entry)),
                onChange: () => onToggleCheck && onToggleCheck(entry),
              })
            : null,
          h(Badge, { tone: readTone(entry) }, readCode(entry)),
          h("span", { className: "cg-row-name" }, node.name),
          entry.origPath ? h("span", { className: "cg-row-dir" }, "← " + entry.origPath) : null,
          onActivate
            ? h(IconBtn, {
                name: "external",
                label: "在弹窗中查看差异",
                size: 12,
                style: { marginLeft: "auto" },
                onClick: (event) => {
                  event.stopPropagation();
                  onActivate(entry);
                },
              })
            : null,
        ),
      );
    }
  };
  walk(nodes, 0);
  return h(appCtx.react.Fragment, null, rows);
}

function CommitDetail(props) {
  const h = appCtx.react.createElement;
  const { useState } = appCtx.react;
  const { repo, data } = props;
  const s = useStoreSnapshot();
  const [collapsed, setCollapsed] = useState(() => ({ head: false, body: false, files: false }));
  const toggleSection = (key) => setCollapsed((prev) => Object.assign({}, prev, { [key]: !prev[key] }));
  const sectionHead = (key, label) =>
    h(
      "div",
      {
        className: "cg-detail-section cg-section-toggle",
        role: "button",
        tabIndex: 0,
        "aria-expanded": !collapsed[key],
        title: (collapsed[key] ? "展开" : "折叠") + label,
        onClick: () => toggleSection(key),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleSection(key);
          }
        },
      },
      h(Icon, { name: collapsed[key] ? "chevron-right" : "chevron-down", size: 11 }),
      h("span", null, label),
    );
  const fileView = s.settings.fileView === "flat" ? "flat" : "tree";
  const selected = data.selectedCommit;
  if (!selected) {
    return h(
      "div",
      { className: "cg-log-detail" },
      h(Empty, { icon: "commit", title: "选择一个提交" }, h("span", null, "查看提交信息、变更文件与差异")),
    );
  }
  const commit = selected.commit || {};
  return h(
    "div",
    { className: "cg-log-detail" },
    h(
      "div",
      { className: "cg-detail-head" },
      h(
        "div",
        { className: "cg-detail-subject-row" },
        h("div", { className: "cg-detail-subject" }, commit.subject || "(无提交信息)"),
        h(IconBtn, {
          name: collapsed.head ? "chevron-right" : "chevron-down",
          label: collapsed.head ? "展开提交信息" : "折叠提交信息",
          onClick: () => toggleSection("head"),
        }),
      ),
      collapsed.head
        ? null
        : h(
        "dl",
        { className: "cg-detail-meta" },
        h("dt", null, "提交"),
        h("dd", { className: "cg-mono", title: commit.hash }, commit.hash || selected.hash),
        h("dt", null, "作者"),
        h("dd", null, (commit.author || "") + (commit.email ? " <" + commit.email + ">" : "")),
        h("dt", null, "时间"),
        h("dd", null, shortDate(commit.at)),
        h("dt", null, "父提交"),
        h(
          "dd",
          { className: "cg-mono" },
          (commit.parents || []).length
            ? commit.parents.map((parent, index) =>
                h(
                  ActionButton,
                  {
                    key: parent,
                    className: "cg-btn cg-ghost cg-sm",
                    onClick: () => parentCommit(repo, parent),
                  },
                  truncate(parent, 10),
                )
              )
            : "（根提交）",
        ),
      ),
      collapsed.head
        ? null
        : h(
        "div",
        { className: "cg-actions-row", style: { borderBottom: 0, padding: "0.5rem 0 0" } },
        h(Btn, { size: "sm", icon: "branch", onClick: () => createBranchDialog(repo, selected.hash) }, "新建分支"),
        h(Btn, { size: "sm", icon: "merge", disabled: Boolean(s.busy), onClick: () => cherryPickCommits(repo, [selected.hash]) }, "拣选（Cherry-pick）"),
        h(Btn, { size: "sm", icon: "undo", disabled: Boolean(s.busy), onClick: () => revertCommit(repo, selected.hash) }, "还原（Revert）"),
        h(Btn, { size: "sm", icon: "tag", onClick: () => tagCommitDialog(repo, selected.hash) }, "标签"),
        h(Btn, { size: "sm", icon: "copy", onClick: () => copyText(selected.hash) }, "复制哈希"),
        h(IconBtn, {
          name: "more",
          label: "更多操作",
          onClick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openContextMenu(rect.left, rect.bottom + 2, commitMenuItems(repo, commit));
          },
        }),
      ),
    ),
    selected.loading ? h("div", { className: "cg-notice" }, "正在加载提交详情…") : null,
    selected.error ? h(Banner, { tone: "error" }, selected.error) : null,
    selected.body && selected.body !== commit.subject
      ? h(
          appCtx.react.Fragment,
          null,
          sectionHead("body", "提交说明"),
          collapsed.body ? null : h("div", { className: "cg-detail-body" }, selected.body),
        )
      : null,
    h(
      "div",
      {
        className: "cg-detail-section cg-section-toggle",
        role: "button",
        tabIndex: 0,
        "aria-expanded": !collapsed.files,
        title: collapsed.files ? "展开变更文件" : "折叠变更文件",
        onClick: () => toggleSection("files"),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleSection("files");
          }
        },
      },
      h(Icon, { name: collapsed.files ? "chevron-right" : "chevron-down", size: 11 }),
      h("span", null, "变更文件 " + selected.files.length),
      h("div", { style: { flex: 1 } }),
      collapsed.files
        ? null
        : h(
            "div",
            {
              className: "cg-seg",
              role: "group",
              "aria-label": "文件视图",
              onClick: (event) => event.stopPropagation(),
              onKeyDown: (event) => event.stopPropagation(),
            },
            h(ActionButton, { className: fileView === "tree" ? "cg-on" : "", title: "树形", onClick: () => saveSettings({ fileView: "tree" }) }, h(Icon, { name: "folder", size: 12 })),
            h(ActionButton, { className: fileView === "flat" ? "cg-on" : "", title: "平铺", onClick: () => saveSettings({ fileView: "flat" }) }, h(Icon, { name: "file", size: 12 })),
          ),
    ),
    collapsed.files
      ? null
      : h(
      "div",
      { className: "cg-detail-files" },
      selected.files.length
        ? fileView === "tree"
          ? h(FileTreeList, {
              files: selected.files,
              onSelect: (item) => openCommitFileDiffDialog(repo, selected.hash, item, commit),
              onActivate: (item) => openCommitFileDiffDialog(repo, selected.hash, item, commit),
            })
          : selected.files.map((item) =>
              h(
                "div",
                {
                  key: item.path + item.status,
                  className: "cg-row",
                  onClick: () => openCommitFileDiffDialog(repo, selected.hash, item, commit),
                  title: item.origPath ? item.origPath + " → " + item.path : item.path,
                },
                h(Badge, { tone: statusTone(item.code) }, item.code),
                h("span", { className: "cg-row-name" }, item.path),
                item.origPath ? h("span", { className: "cg-row-dir" }, "← " + item.origPath) : null,
                h(IconBtn, {
                  name: "external",
                  label: "在弹窗中查看差异",
                  size: 12,
                  style: { marginLeft: "auto" },
                  onClick: (event) => {
                    event.stopPropagation();
                    openCommitFileDiffDialog(repo, selected.hash, item, commit);
                  },
                }),
              ),
            )
        : h("div", { className: "cg-notice" }, "该提交没有变更文件"),
    ),
  );
}

function truncz(value, length) {
  const text = String(value || "");
  return text.length > length ? text.slice(0, length) + "…" : text;
}

async function parentCommit(repo, hash) {
  const view = getLogView(repo);
  const commit = view.commits.find((item) => item.hash === hash);
  if (commit) {
    state.activeTab = "log";
    notify();
    await selectCommit(repo, commit);
    return;
  }
  state.activeTab = "log";
  notify();
  await selectCommit(repo, { hash, subject: hash, author: "", at: 0, parents: [], branches: [], tags: [], refs: [] });
}

/* 只读差异渲染（提交详情、stash、补丁预览共用）。 */
function ReadonlyDiff(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const split = s.settings.diffLayout === "split";
  const { files, path, fallback } = props;
  if (!files || !files.length) {
    if (fallback && fallback.trim()) {
      return h(
        "div",
        { className: "cg-diff-body" },
        h("pre", { className: "cg-code", style: { margin: 0, padding: "0.5rem" } }, fallback.slice(0, 200000)),
      );
    }
    return h("div", { className: "cg-notice" }, "没有可显示的差异（可能是二进制文件或模式变更）。");
  }
  let rendered = 0;
  const blocks = [];
  for (let fi = 0; fi < files.length; fi += 1) {
    const file = files[fi];
    const parts = [];
    for (let hi = 0; hi < file.hunks.length; hi += 1) {
      if (rendered > MAX_DIFF_LINES) break;
      const hunk = file.hunks[hi];
      const hunkLines = [];
      if (split) {
        const rows = pairSplitRows(hunk.lines);
        for (let ri = 0; ri < rows.length; ri += 1) {
          if (rendered >= MAX_DIFF_LINES) break;
          rendered += 1;
          hunkLines.push(h(SplitDiffRow, { key: "s" + hi + ":" + ri, row: rows[ri], lines: hunk.lines }));
        }
      } else {
        for (let li = 0; li < hunk.lines.length; li += 1) {
          if (rendered >= MAX_DIFF_LINES) break;
          rendered += 1;
          hunkLines.push(h(DiffLine, { key: "l" + hi + ":" + li, line: hunk.lines[li] }));
        }
      }
      parts.push(
        h(
          "div",
          { key: "h" + hi, className: "cg-hunk" },
          h("div", { className: "cg-hunk-head" }, h("span", { className: "cg-mono" }, hunk.header)),
          h("div", { className: "cg-hunk-body" }, h("div", { className: split ? "cg-split-grid" : "cg-hunk-inner" }, hunkLines)),
        ),
      );
    }
    blocks.push(
      h(
        "div",
        { key: fi, className: "cg-diff-file" },
        h(
          "div",
          { className: "cg-diff-file-head" },
          h(Icon, { name: "file", size: 12 }),
          h("span", { className: "cg-ellipsis", style: { flex: 1 } }, file.name || path || ""),
          file.isNew ? h(Badge, { tone: "add" }, "新增") : null,
          file.isDeleted ? h(Badge, { tone: "del" }, "删除") : null,
          file.isRename ? h(Badge, { tone: "move" }, "重命名") : null,
          h("span", { className: "cg-muted cg-mini" }, "+" + file.adds + " −" + file.dels),
        ),
        file.binary ? h("div", { className: "cg-notice" }, "二进制文件") : null,
        parts,
      ),
    );
  }
  return h(
    "div",
    { className: "cg-diff-body" },
    blocks,
    rendered >= MAX_DIFF_LINES ? h("div", { className: "cg-truncated" }, "差异过大，仅显示前 " + MAX_DIFF_LINES + " 行。") : null,
  );
}

/* ---------- 差异弹窗 ---------- */

/** 提交中单个文件的差异弹窗：渲染在工作台内层，层级高于提交详情。 */
function DiffDialog() {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const dialog = s.diffDialog;
  if (!dialog) return null;
  const title = dialog.origPath && dialog.origPath !== dialog.path ? dialog.origPath + " → " + dialog.path : dialog.path;
  return h(
    "div",
    {
      className: "cg-overlay",
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) closeDiffDialog();
      },
    },
    h(
      "div",
      { className: "cg-diff-modal", role: "dialog", "aria-modal": "true", "aria-label": "文件差异" },
      h(
        "div",
        { className: "cg-diff-modal-head" },
        h(Icon, { name: "file", size: 14 }),
        h("span", { className: "cg-ellipsis cg-mono", title }, title),
        h("span", { className: "cg-muted cg-mini cg-mono" }, truncz(dialog.hash, 10)),
        h("div", { style: { flex: 1 } }),
        h(
          "div",
          { className: "cg-seg", role: "group", "aria-label": "差异布局" },
          h(ActionButton, { className: s.settings.diffLayout === "split" ? "" : "cg-on", title: "统一视图", onClick: () => saveSettings({ diffLayout: "unified" }) }, "统一"),
          h(ActionButton, { className: s.settings.diffLayout === "split" ? "cg-on" : "", title: "并排视图", onClick: () => saveSettings({ diffLayout: "split" }) }, "并排"),
        ),
        h(IconBtn, { name: "copy", label: "复制差异", onClick: () => copyText(dialog.text || "") }),
        h(IconBtn, { name: "x", label: "关闭", onClick: closeDiffDialog }),
      ),
      h(
        "div",
        { className: "cg-diff-modal-body" },
        dialog.loading
          ? h("div", { className: "cg-notice" }, "正在加载差异…")
          : dialog.error
            ? h(Banner, { tone: "error" }, dialog.error)
            : h(ReadonlyDiff, { key: dialog.id, files: dialog.files, path: dialog.path, fallback: dialog.text }),
      ),
    ),
  );
}

/* ---------- 文件历史 ---------- */

function HistoryTab(props) {
  return appCtx.react.createElement(LogTab, { repo: props.repo, key: "history:" + props.repo });
}

/* ---------- Blame ---------- */

function BlameTab(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const blame = s.blame;
  if (!blame || pathKey(blame.repo) !== pathKey(props.repo)) {
    return h(
      "div",
      { className: "cg-content" },
      h(Empty, { icon: "user", title: "尚未加载逐行溯源" }, h("span", null, "在文件上使用“逐行溯源”操作")),
    );
  }
  const rows = [];
  for (let line = blame.start; line <= blame.end; line += 1) {
    const item = blame.lines[line];
    if (!item) continue;
    rows.push(h(BlameRow, { key: line, repo: props.repo, item, line }));
  }
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Icon, { name: "user", size: 13 }),
      h("b", { className: "cg-ellipsis", title: blame.path }, blame.path),
      h("span", { className: "cg-muted cg-mini" }, "行 " + blame.start + "–" + blame.end),
      h("div", { style: { flex: 1 } }),
      h(Btn, { size: "sm", icon: "arrow-left", disabled: blame.start <= 1 || blame.loading, onClick: () => shiftBlame(-MAX_BLAME_LINES) }, "上一段"),
      h(Btn, { size: "sm", icon: "arrow-right", disabled: blame.loading || blame.exhausted, onClick: () => shiftBlame(MAX_BLAME_LINES) }, "下一段"),
      h(IconBtn, { name: "history", label: "文件历史", onClick: () => openFileHistory(props.repo, blame.path) }),
      h(IconBtn, { name: "refresh", label: "刷新逐行溯源", onClick: () => loadBlame(props.repo, blame.path, blame.start) }),
    ),
    blame.error ? h(Banner, { tone: "error" }, blame.error) : null,
    blame.truncated ? h(Banner, { tone: "error" }, "逐行溯源输出达到 64KB 上限，本段可能不完整；请缩小文件或分段查看。") : null,
    blame.loading ? h("div", { className: "cg-notice" }, "正在加载逐行溯源…") : null,
    h(
      "div",
      { className: "cg-blame" },
      rows.length
        ? rows
        : !blame.loading
          ? h(Empty, { icon: "file", title: "没有可显示的行" }, h("span", null, "文件可能为空或超出范围"))
          : null,
    ),
  );
}

function BlameRow(props) {
  const h = appCtx.react.createElement;
  const { repo, item, line } = props;
  const color = laneColor(item.sha.charCodeAt(0) + item.sha.charCodeAt(1));
  return h(
    "div",
    { className: "cg-blame-row" },
    h(
      "span",
      { className: "cg-blame-meta" },
      h("span", { className: "cg-file-dot", style: { background: color } }),
      h(
        ActionButton,
        {
          className: "cg-btn cg-ghost cg-sm cg-mono",
          title: item.sha + "\n" + item.summary,
          onClick: () => openCommitFromBlame(repo, { hash: item.sha, subject: item.summary, author: item.author, at: item.time, parents: [], branches: [], tags: [], refs: [] }),
        },
        shortHash(item.sha),
      ),
      h("span", { className: "cg-ellipsis", style: { flex: 1 }, title: item.summary }, item.author || "(未知作者)"),
      h("span", { title: shortDate(item.time) }, relativeTime(item.time)),
    ),
    h("span", { className: "cg-blame-ln" }, line),
    h("span", { className: "cg-blame-code" }, item.text || " "),
  );
}
