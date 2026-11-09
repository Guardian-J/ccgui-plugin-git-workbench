/* ---------------------------------------------------------------------------
 * 本分片：注册宿主扩展点、初始化状态、生命周期清理。
 * 入口必须是自包含 ESM（构建脚本直接拼接所有分片）。
 * ------------------------------------------------------------------------- */

function openWorkbench(tab, repo) {
  if (repo && pathKey(repo) !== pathKey(state.activeRepo)) setActiveRepo(repo);
  if (tab) state.activeTab = tab;
  state.workbenchOpen = true;
  notify();
}

function closeWorkbench() {
  state.workbenchOpen = false;
  state.diffDialog = null;
  if (contextMenuState) closeContextMenu();
  else notify();
}

function GitGlyph(props) {
  return appCtx.react.createElement(Icon, { name: "git", size: 14, className: props && props.className });
}

/** 右侧面板宿主只渲染插件页签的 icon，不给文字；把文字放进 icon 组件里。 */
function GitPanelGlyph(props) {
  const h = appCtx.react.createElement;
  return h(
    "span",
    {
      className: "cg-panel-glyph" + (props && props.className ? " " + props.className : ""),
      "aria-hidden": true,
      style: { display: "inline-flex", alignItems: "center", gap: "0.3125rem", width: "auto", height: "auto" },
    },
    h(Icon, { name: "git", size: 14 }),
    h("span", { className: "cg-panel-glyph-text" }, "Git 面板"),
  );
}

function PanelPage(props) {
  return appCtx.react.createElement(Workbench, {
    compact: true,
    workspacePath: props && props.workspacePath,
  });
}

function SettingsPage() {
  const h = appCtx.react.createElement;
  return h(
    "div",
    { className: "cg-root", style: { height: "auto", overflow: "visible", padding: "0.25rem" } },
    h(SettingsForm, {}),
  );
}

/* ---------- 命令 / 菜单辅助 ---------- */

async function ensureWorkspaceForCommand() {
  if (!state.workspacePath || !state.repos.length) await syncWorkspaceFromHost();
  if (!state.repos.length && state.scanning) {
    const task = scanInflight.get(pathKey(state.workspacePath));
    if (task) await task.promise;
  }
  return state.workspacePath;
}

async function ensureRepoForCommand() {
  await ensureWorkspaceForCommand();
  if (!state.activeRepo && state.repos.length) setActiveRepo(state.repos[0].path);
  if (!state.activeRepo) {
    toast("当前工作区没有 Git 仓库", "warning");
    return "";
  }
  return state.activeRepo;
}

async function workspacePathById(workspaceId) {
  try {
    const rows = await appCtx.workspaces.list();
    const row = (rows || []).find((item) => item.id === workspaceId);
    return row && row.path ? normalizePath(row.path) : "";
  } catch (error) {
    return "";
  }
}

async function openWorkspaceById(workspaceId, tab) {
  const path = await workspacePathById(workspaceId);
  if (!path) {
    toast("无法解析该工作区路径", "error");
    return;
  }
  await setWorkspace(path);
  if (!state.activeRepo && state.repos.length) setActiveRepo(state.repos[0].path);
  openWorkbench(tab || "changes");
}

async function openFileFromLink(target, mode) {
  const filePath = target && target.resolvedPath ? normalizePath(target.resolvedPath) : "";
  if (!filePath) return;
  const root = await resolveRepoRoot(dirName(filePath));
  if (!root) {
    toast("该文件不在 Git 仓库中", "warning");
    return;
  }
  const rel = relativePath(root, filePath);
  if (!rel || rel === filePath) {
    toast("无法计算文件在仓库中的路径", "warning");
    return;
  }
  if (target.workspacePath) await setWorkspace(target.workspacePath);
  if (!state.activeRepo) setActiveRepo(root);
  else if (pathKey(state.activeRepo) !== pathKey(root)) setActiveRepo(root);
  if (mode === "blame") await openBlame(root, rel);
  else await openFileHistory(root, rel);
  openWorkbench();
}

function registerGitWorkbench(ctx) {
  const disposers = [];
  const add = (disposer) => {
    if (typeof disposer === "function") disposers.push(disposer);
    return disposer;
  };

  add(ctx.theme.injectCss(PLUGIN_CSS));

  add(ctx.ui.registerPanelTab({
    key: "git-status",
    label: () => "Git 面板",
    icon: GitPanelGlyph,
    component: PanelPage,
    order: 40,
  }));

  add(ctx.ui.registerSettingsSection({
    key: "settings",
    label: () => "Git 工作台",
    icon: GitGlyph,
    component: SettingsPage,
  }));

  add(ctx.ui.registerOverlay({
    key: "git-overlay",
    component: OverlayHost,
    order: 90,
  }));

  add(ctx.ui.registerSidebarNav({
    key: "git-workbench",
    label: () => "Git 工作台",
    icon: GitGlyph,
    order: 60,
    onOpen: () => openWorkbench("changes"),
  }));

  add(ctx.ui.registerCommand({
    key: "git-workbench-open",
    title: () => "Git：打开工作台",
    keywords: () => ["git", "工作台", "仓库", "branch"],
    run: () => openWorkbench("changes"),
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-refresh",
    title: () => "Git：刷新状态",
    keywords: () => ["git", "refresh", "status"],
    run: () => ensureRepoForCommand().then((repo) => repo && refreshRepo(repo, { details: true })),
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-fetch",
    title: () => "Git：获取所有远程更新",
    keywords: () => ["git", "fetch", "remote"],
    run: () => {
      void ensureRepoForCommand().then((repo) => repo && fetchRepo(repo, { all: true, prune: state.settings.fetchPrune }));
    },
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-pull",
    title: () => "Git：拉取当前分支",
    keywords: () => ["git", "pull", "update"],
    run: () => {
      void ensureRepoForCommand().then((repo) => repo && pullRepo(repo));
    },
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-push",
    title: () => "Git：推送当前分支",
    keywords: () => ["git", "push", "upload"],
    run: () => {
      void (async () => {
        const repo = await ensureRepoForCommand();
        if (!repo) return;
        openWorkbench("changes");
        await pushDialog(repo);
      })();
    },
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-commit",
    title: () => "Git：提交更改",
    keywords: () => ["git", "commit", "提交"],
    run: () => openWorkbench("changes"),
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-log",
    title: () => "Git：打开提交图",
    keywords: () => ["git", "log", "history", "提交"],
    run: () => openWorkbench("log"),
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-branches",
    title: () => "Git：管理分支",
    keywords: () => ["git", "branch", "checkout", "merge"],
    run: () => openWorkbench("branches"),
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-stash",
    title: () => "Git：查看暂存",
    keywords: () => ["git", "stash", "暂存"],
    run: () => openWorkbench("stashes"),
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-scan",
    title: () => "Git：重新扫描仓库",
    keywords: () => ["git", "scan", "discover", "仓库"],
    run: () => {
      void (async () => {
        const ws = await ensureWorkspaceForCommand();
        if (ws) await scanWorkspace({ force: true });
      })();
    },
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-init",
    title: () => "Git：初始化当前工作区仓库",
    keywords: () => ["git", "init", "初始化"],
    run: () => {
      void (async () => {
        const ws = await ensureWorkspaceForCommand();
        if (!ws) return;
        const result = await initRepository(ws);
        if (result.ok) await setWorkspace(ws, { force: true });
      })();
    },
  }));
  add(ctx.ui.registerCommand({
    key: "git-workbench-update",
    title: () => "Git：更新项目（获取 + 拉取）",
    keywords: () => ["git", "update", "sync", "pull"],
    run: () => {
      void ensureRepoForCommand().then((repo) => repo && updateProject(repo));
    },
  }));

  add(ctx.ui.registerWorkspaceMenuItem({
    key: "git-workbench-open-workspace",
    label: () => "在 Git 工作台中打开",
    icon: GitGlyph,
    visible: (menuCtx) => !menuCtx.archived,
    onSelect: (menuCtx) => {
      void openWorkspaceById(menuCtx.workspaceId, "changes");
    },
    order: 80,
  }));

  add(ctx.ui.registerWorkspaceMenuItem({
    key: "git-workbench-init-workspace",
    label: () => "初始化 Git 仓库",
    icon: GitGlyph,
    visible: (menuCtx) => !menuCtx.archived,
    onSelect: (menuCtx) => {
      void (async () => {
        const path = await workspacePathById(menuCtx.workspaceId);
        if (!path) return;
        const result = await initRepository(path);
        if (result.ok) {
          await setWorkspace(path, { force: true });
          openWorkbench("changes");
        }
      })();
    },
    order: 81,
  }));

  add(ctx.ui.registerFileLinkMenuItem({
    key: "git-workbench-file-history",
    label: (target) => "Git：显示文件历史",
    icon: GitGlyph,
    visible: (target) => Boolean(target && target.resolvedPath),
    run: (target) => openFileFromLink(target, "history"),
    order: 60,
  }));

  add(ctx.ui.registerFileLinkMenuItem({
    key: "git-workbench-file-blame",
    label: (target) => "Git：逐行溯源",
    icon: GitGlyph,
    visible: (target) => Boolean(target && target.resolvedPath),
    run: (target) => openFileFromLink(target, "blame"),
    order: 61,
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        // 卸载阶段吞掉单个 disposer 错误
      }
    }
    disposeStore();
    appCtx = null;
  };
}

export default function activate(ctx) {
  setAppContext(ctx);
  disposed = false;
  pollRefs = 0;
  memoizeListRows();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const dispose = registerGitWorkbench(ctx);
  // 存储与宿主工作区元数据同时读取，省掉一次串行 IPC。
  const metadataTask = Promise.resolve().then(() => appCtx.workspace.getMetadata()).catch(() => null);
  void (async () => {
    try {
      await loadSettings();
      if (disposed) return;
      state.ready = true;
      notify();
      // 工作区同步可能触发深扫，不能让首屏等它结束。
      void syncWorkspaceFromHost({ metadata: metadataTask });
    } catch (error) {
      // 热重载期间 appCtx 已被置空，此时不再向用户报错。
      if (!disposed) reportError(error, "Git 插件初始化");
    }
  })();
  return dispose;
}
