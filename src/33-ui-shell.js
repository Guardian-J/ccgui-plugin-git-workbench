/* ---------------------------------------------------------------------------
 * 本分片：全屏工作台外壳（头部、仓库侧栏、视图导航、状态栏）。
 * ------------------------------------------------------------------------- */
/* ---------- 工作台 ---------- */

function Workbench(props) {
  const h = appCtx.react.createElement;
  const { useEffect } = appCtx.react;
  const s = useStoreSnapshot();
  const compact = Boolean(props && props.compact);
  useEffect(() => {
    if (props && props.workspacePath) void setWorkspace(props.workspacePath);
  }, [props && props.workspacePath]);
  useEffect(() => {
    if (!s.workspacePath) void syncWorkspaceFromHost();
  }, []);
  useEffect(() => {
    if (s.workspacePath && s.ready) startWorkspacePolling();
    return () => stopWorkspacePolling();
  }, [s.workspacePath, s.ready, s.settings.refreshInterval]);

  if (!s.ready) {
    if (compact) return h("div", { className: "cg-root cg-empty" }, h(Spinner, null), h("span", null, "正在加载 Git 插件…"));
    return h(
      "div",
      { className: "cg-root" },
      h(WorkbenchHeader, null),
      h(Empty, { title: "正在加载 Git 插件…" }, h(Spinner, null)),
    );
  }
  if (compact) return h(CompactPanel, { workspacePath: props && props.workspacePath });
  return h(
    "div",
    { className: "cg-root" },
    h(WorkbenchHeader, null),
    h(
      "div",
      { className: "cg-body" },
      h(RepoRail, null),
      h(
        "div",
        { className: "cg-main" },
        s.activeRepo ? h(WorkbenchTabs, null) : h(NoRepoState, null),
      ),
    ),
    h(WorkbenchStatusBar, null),
  );
}

function NoRepoState() {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  if (s.scanning) {
    return h(Empty, { icon: "search", title: "正在扫描 Git 仓库…" }, h(Spinner, null));
  }
  if (s.workspacePath) {
    return h(
      "div",
      { className: "cg-content" },
      s.scanError ? h(Banner, { tone: "error" }, "扫描 Git 仓库失败：" + s.scanError) : null,
      h(
        Empty,
        { icon: "git", title: "当前工作区没有发现 Git 仓库" },
        h("span", null, s.workspacePath),
        h("span", { className: "cg-muted cg-mini" }, "扫描深度 " + s.settings.scanDepth + " 层；确认项目没有被排除目录规则过滤。"),
        h(
          "div",
          { style: { display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap", justifyContent: "center" } },
          h(Btn, { icon: "refresh", onClick: () => scanWorkspace({ force: true }) }, "重新扫描"),
          h(Btn, { icon: "plus", onClick: () => addRepoManually() }, "添加仓库"),
          h(Btn, { icon: "fetch", onClick: () => cloneRepository() }, "克隆仓库"),
          h(Btn, { icon: "git", onClick: () => initRepository(s.workspacePath) }, "初始化仓库"),
        ),
      ),
    );
  }
  return h(Empty, { icon: "git", title: "未连接工作区" }, "在宿主中打开一个工作区后即可管理 Git 仓库。");
}

function WorkbenchHeader() {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const data = s.activeRepo ? ensureRepoData(s.activeRepo) : null;
  const branch = data ? data.status.branch : emptyStatus().branch;
  const dirty = data ? countChanges(data) : 0;
  const scanning = s.scanning || (data && (data.loading.status || data.loading.details));
  return h(
    "div",
    { className: "cg-header" },
    h(
      "div",
      { className: "cg-header-title" },
      h("span", { className: "cg-brand" }, h(Icon, { name: "git", size: 15 })),
      h("span", null, "Git 工作台"),
    ),
    s.repos.length
      ? h(Select, {
          className: "cg-repo-select",
          value: s.activeRepo,
          options: s.repos.map((repo) => ({ value: repo.path, label: repoDisplayName(repo.path) })),
          onChange: (value) => setActiveRepo(value),
          title: s.activeRepo,
        })
      : null,
    branch.head || branch.detached
      ? h(
          "span",
          { className: "cg-branch", title: branch.upstream ? "上游：" + branch.upstream : "无上游分支" },
          h(Icon, { name: "branch", size: 12 }),
          h("b", null, branch.detached ? "游离 HEAD" : branch.head),
          branch.ahead ? h("span", { className: "cg-ahead", title: "领先远程 " + branch.ahead + " 个提交" }, "↑" + branch.ahead) : null,
          branch.behind ? h("span", { className: "cg-behind", title: "落后远程 " + branch.behind + " 个提交" }, "↓" + branch.behind) : null,
        )
      : null,
    dirty ? h(Badge, { tone: "mod", title: dirty + " 个文件有更改" }, dirty + " 处更改") : null,
    h("div", { className: "cg-header-spacer" }),
    scanning ? h(Spinner, { size: 13 }) : null,
    h(
      "div",
      { className: "cg-tgroup" },
      h(Btn, {
        size: "sm",
        icon: "fetch",
        title: "获取所有远程更新（git fetch --all）",
        disabled: !s.activeRepo,
        onClick: () => s.activeRepo && fetchRepo(s.activeRepo, { all: true }),
      }, "获取"),
      h(Btn, {
        size: "sm",
        icon: "pull",
        title: branch.upstream ? "从 " + branch.upstream + " 拉取" : "当前分支没有上游",
        disabled: !s.activeRepo || branch.detached,
        onClick: () => s.activeRepo && pullRepo(s.activeRepo),
      }, "拉取", branch.behind ? h("span", { className: "cg-behind" }, branch.behind) : null),
      h(Btn, {
        size: "sm",
        icon: "push",
        title: branch.upstream ? "推送到 " + branch.upstream : "推送并设置上游",
        disabled: !s.activeRepo || branch.detached,
        onClick: () => s.activeRepo && pushCurrent(s.activeRepo),
      }, "推送", branch.ahead ? h("span", { className: "cg-ahead" }, branch.ahead) : null),
    ),
    h("div", { className: "cg-header-sep" }),
    h(IconBtn, {
      name: "refresh",
      label: "刷新当前仓库",
      disabled: !s.activeRepo,
      onClick: () => s.activeRepo && refreshRepo(s.activeRepo, { details: true, log: true }),
    }),
    h(IconBtn, {
      name: "terminal",
      label: "打开 Git 控制台",
      active: s.activeTab === "console",
      onClick: () => {
        state.activeTab = "console";
        notify();
      },
    }),
    h(IconBtn, { name: "x", label: "关闭工作台（Esc）", className: "cg-workbench-close", onClick: closeWorkbench }),
  );
}

function RepoRail() {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const activeKey = pathKey(s.workspacePath);
  const currentRepos = s.repos.filter(
    (repo) => repo.isActiveWorkspaceRepo || pathKey(repo.workspace) === activeKey,
  );
  const otherGroups = new Map();
  for (const repo of s.repos) {
    if (currentRepos.includes(repo)) continue;
    const owner = repo.workspace || "";
    const key = pathKey(owner);
    if (!otherGroups.has(key)) {
      otherGroups.set(key, { path: owner, name: owner ? baseName(owner) : "其它工作区", repos: [] });
    }
    otherGroups.get(key).repos.push(repo);
  }
  const renderRepo = (repo) => {
    const data = s.repoData[repo.path] || null;
    const quick = data && data.quick && !data.quick.error ? data.quick : null;
    const branch = quick ? quick.branch : data ? data.status.branch : emptyStatus().branch;
    const dirty = quick
      ? quick.changed || 0
      : data
        ? countChanges(data)
        : 0;
    const active = pathKey(s.activeRepo) === pathKey(repo.path);
    const rel = relativePath(repo.workspace || s.workspacePath, repo.path);
    return h(
      "button",
      {
        key: repo.path,
        type: "button",
        className: cx("cg-repo", active ? "cg-active" : ""),
        onClick: () => setActiveRepo(repo.path),
        title: repo.path + (rel && rel !== repo.path ? "\n" + rel : ""),
      },
      h(Icon, { name: repo.worktree ? "archive" : "git", size: 13, className: "cg-repo-icon" }),
      h(
        "span",
        { className: "cg-repo-main" },
        h("span", { className: "cg-repo-name" }, repoDisplayName(repo.path)),
        branch && (branch.head || branch.detached)
          ? h("span", { className: "cg-repo-sub cg-mono" }, branch.detached ? "游离 HEAD" : branch.head)
          : null,
      ),
      dirty ? h("span", { className: "cg-repo-dirty", title: dirty + " 处更改" }, dirty) : null,
    );
  };
  const rows = [];
  if (currentRepos.length) {
    rows.push(
      h(
        "div",
        { key: "group:current", className: "cg-rail-group", title: s.workspacePath || "" },
        h("span", null, "当前工作区"),
        h(Badge, null, currentRepos.length),
      ),
    );
    for (const repo of currentRepos) rows.push(renderRepo(repo));
  } else if (s.repos.length) {
    rows.push(
      h(
        "div",
        { key: "group:current", className: "cg-rail-group", title: s.workspacePath || "" },
        h("span", null, "当前工作区"),
        h(Badge, null, 0),
      ),
    );
    rows.push(
      h("div", { key: "current-empty", className: "cg-notice cg-notice-tight" }, "工作区不是 Git 仓库"),
    );
  }
  for (const group of Array.from(otherGroups.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    rows.push(
      h(
        "div",
        { key: "group:" + group.path, className: "cg-rail-group", title: group.path },
        h("span", { className: "cg-ellipsis" }, group.name),
        h(Badge, null, group.repos.length),
      ),
    );
    for (const repo of group.repos) rows.push(renderRepo(repo));
  }
  return h(
    "div",
    { className: "cg-rail" },
    h(
      "div",
      { className: "cg-rail-head" },
      h(Icon, { name: "folder", size: 14 }),
      h(
        "div",
        { className: "cg-rail-title" },
        h("b", { className: "cg-ellipsis", title: s.workspacePath || "" }, s.workspaceName || "工作区"),
        h("span", { className: "cg-ellipsis" }, s.repos.length ? s.repos.length + " 个仓库" + (s.scanning ? " · 扫描中" : "") : "没有仓库"),
      ),
      h("div", { style: { flex: 1 } }),
      s.scanning ? h(Spinner, { size: 12 }) : h(IconBtn, { name: "refresh", label: "重新扫描", onClick: () => scanWorkspace({ force: true }), size: 13 }),
    ),
    h(
      "div",
      { className: "cg-rail-list" },
      rows,
      !s.repos.length && !s.scanning
        ? h(
            "div",
            { className: cx("cg-notice", s.scanError ? "cg-scan-error" : "") },
            s.scanError ? "扫描失败：" + s.scanError : "没有发现仓库",
          )
        : null,
      (s.scanWarnings || []).length
        ? h(
            "div",
            { className: "cg-notice cg-scan-warn", title: s.scanWarnings.join("\n") },
            s.scanWarnings.length + " 个工作区扫描失败",
          )
        : null,
    ),
    h(
      "div",
      { className: "cg-rail-foot" },
      h(IconBtn, { name: "plus", label: "添加仓库", onClick: () => addRepoManually() }),
      h(IconBtn, { name: "fetch", label: "克隆仓库", onClick: () => cloneRepository() }),
      h(IconBtn, { name: "git", label: "初始化仓库", onClick: () => s.workspacePath && initRepository(s.workspacePath) }),
      h("div", { style: { flex: 1 } }),
      h(IconBtn, { name: "settings", label: "插件设置", onClick: () => openWorkbench("settings") }),
    ),
  );
}

function WorkbenchTabs() {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const data = s.activeRepo ? ensureRepoData(s.activeRepo) : null;
  if (!data) return null;
  const dirty = countChanges(data);
  const showStashes = data.stashes.length > 0 || s.activeTab === "stashes";
  const tabs = [
    { key: "changes", label: "本地更改", icon: "edit", count: dirty || null },
    { key: "log", label: "提交图", icon: "commit" },
    { key: "branches", label: "分支", icon: "branch", count: (data.branches.locals.length + data.branches.remotes.length) || null },
    showStashes ? { key: "stashes", label: "贮藏", title: "贮藏（Stash）", sub: true, count: data.stashes.length || null } : null,
    { key: "tags", label: "标签", sub: true, count: data.tags.length || null },
    { key: "remotes", label: "远程", sub: true, count: data.remotes.length || null },
    data.submodules.length || s.activeTab === "submodules"
      ? { key: "submodules", label: "子模块", sub: true, count: data.submodules.length || null }
      : null,
    s.history ? { key: "history", label: "文件历史", sub: true } : null,
    s.blame ? { key: "blame", label: "逐行溯源", sub: true } : null,
    { key: "console", label: "控制台", sub: true },
    { key: "settings", label: "设置", sub: true },
  ].filter(Boolean);
  const active = s.activeTab || "changes";
  const rendered = tabs.some((tab) => tab.key === active) ? active : "changes";
  return h(
    "div",
    { className: "cg-content" },
    h(TabBar, {
      tabs,
      active: rendered,
      onChange: (key) => {
        state.activeTab = key;
        notify();
        const repo = state.activeRepo;
        if (key === "log" && repo) {
          const view = getLogView(repo);
          if (!view.commits.length) void loadLog(repo, true);
        }
        if (key === "settings" && repo) void loadConfig(repo);
      },
    }),
    rendered === "changes" ? h(ChangesPanel, { repo: s.activeRepo })
      : rendered === "log" ? h(LogTab, { repo: s.activeRepo })
      : rendered === "branches" ? h(BranchesTab, { repo: s.activeRepo })
      : rendered === "stashes" ? h(StashesTab, { repo: s.activeRepo })
      : rendered === "tags" ? h(TagsTab, { repo: s.activeRepo })
      : rendered === "remotes" ? h(RemotesTab, { repo: s.activeRepo })
      : rendered === "submodules" ? h(SubmodulesTab, { repo: s.activeRepo })
      : rendered === "console" ? h(ConsoleTab, { repo: s.activeRepo })
      : rendered === "settings" ? h(SettingsTab, { repo: s.activeRepo })
      : rendered === "blame" ? h(BlameTab, { repo: s.activeRepo })
      : rendered === "history" ? h(HistoryTab, { repo: s.activeRepo })
      : h(ChangesPanel, { repo: s.activeRepo }),
  );
}

function WorkbenchStatusBar() {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const inWorkspace = (path) => Boolean(path) && isSubPath(s.workspacePath, path);
  const repo = inWorkspace(s.activeRepo) ? s.activeRepo : "";
  const data = repo ? ensureRepoData(repo) : null;
  const branch = data ? data.status.branch : null;
  const detailErrors = data ? Object.keys(data.detailsErrors || {}) : [];
  const detailErrorText = detailErrors.map((key) => key + ": " + data.detailsErrors[key]).join("\n");
  const repoCount = s.repos.filter((item) => inWorkspace(item.path)).length;
  return h(
    "div",
    { className: "cg-statusbar" },
    h(
      "span",
      { className: cx("cg-sb-item", s.busy ? "cg-sb-busy" : "") },
      s.busy ? h(Spinner, { size: 11 }) : h("span", { className: "cg-sb-dot" }),
      h("span", { className: "cg-ellipsis" }, s.busy ? s.busy : "就绪"),
    ),
    data && data.error
      ? h("span", { className: "cg-sb-item cg-sb-error", title: data.error }, h(Icon, { name: "warning", size: 11 }), "加载失败")
      : null,
    detailErrors.length
      ? h("span", { className: "cg-sb-item cg-sb-warn", title: detailErrorText }, h(Icon, { name: "warning", size: 11 }), detailErrors.length + " 项引用读取失败")
      : null,
    data && data.refsTruncated
      ? h("span", { className: "cg-sb-item cg-sb-warn", title: "git 输出超过 64 KiB，列表已截断" }, h(Icon, { name: "info", size: 11 }), "引用列表已截断")
      : null,
    branch && branch.upstreamGone ? h("span", { className: "cg-sb-item cg-sb-warn" }, "上游已删除") : null,
    h("div", { className: "cg-spacer" }),
    s.workspacePath
      ? h("span", { className: "cg-sb-item cg-sb-path cg-ellipsis", title: s.workspacePath }, h(Icon, { name: "folder", size: 11 }), (s.workspaceName || s.workspacePath) + " · " + repoCount + " 个仓库")
      : null,
    s.gitVersionRaw
      ? h("span", { className: "cg-sb-item cg-mono", title: s.gitVersionRaw }, s.gitVersionRaw.replace(/^git version\s*/i, "Git ").replace(/\.windows\.\d+$/i, ""))
      : null,
  );
}

