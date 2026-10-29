/* ---------------------------------------------------------------------------
 * 本分片：全局状态、设置持久化、仓库数据加载、轮询、toast / 对话框。
 * 组件通过 useStoreSnapshot() 订阅；写操作统一走 enqueue() 串行化。
 * ------------------------------------------------------------------------- */

const state = {
  rev: 0,
  ready: false,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  workspacePath: "",
  workspaceName: "",
  gitVersionRaw: "",
  gitAvailable: null,
  repos: [],
  repoCache: {},
  manualRepos: {},
  scanning: false,
  scanError: null,
  scanWarnings: [],
  activeRepo: "",
  activeTab: "changes",
  workbenchOpen: false,
  repoData: {},
  checkedByRepo: {},
  selectedFile: null, // {repo, path, staged}
  diffMode: "head", // head | staged | worktree
  ignoreWhitespace: false,
  drafts: {}, // repo -> commit message
  commitAmend: false,
  commitSignOff: false,
  commitSkipHooks: false,
  commitPush: false,
  commitAllowEmpty: false,
  commitNoGpg: false,
  commitHistory: [],
  logViews: {}, // repo -> {commits, loading, hasMore, offset, filter, error}
  blame: null, // {repo,path,start,end,lines,loading,error}
  history: null, // {repo,path}
  busy: "",
  toasts: [],
  dialog: null,
  diffDialog: null, // {repo,hash,path,origPath,title,loading,files,text,error}
  consoleEntries: [],
  panelCompact: false,
};

const storeListeners = new Set();
const toastTimers = new Map();
let settingsSaveChain = Promise.resolve();
let mutationQueue = Promise.resolve();
const statusInflight = new Map();
const detailsInflight = new Map();
const logInflight = new Map();
let pollTimer = null;
let pollRefs = 0;
let pollTask = null;
let disposed = false;
let deferredNotifyTimer = null;

/** 控制台等高频写入合并成一次通知，避免每条 git 命令触发全量重渲染。 */
function notifyDeferred() {
  if (disposed || deferredNotifyTimer) return;
  deferredNotifyTimer = setTimeout(() => {
    deferredNotifyTimer = null;
    notify();
  }, 60);
}

function notify() {
  if (disposed) return;
  if (deferredNotifyTimer) {
    clearTimeout(deferredNotifyTimer);
    deferredNotifyTimer = null;
  }
  state.rev += 1;
  state.consoleEntries = consoleEntries;
  for (const listener of Array.from(storeListeners)) {
    try {
      listener();
    } catch (error) {
      // 一个坏监听不应阻断其他组件刷新
    }
  }
}

function useStoreSnapshot() {
  const React = appCtx.react;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    storeListeners.add(listener);
    return () => {
      storeListeners.delete(listener);
    };
  }, []);
  return state;
}

function useTick() {
  const React = appCtx.react;
  const [, setTick] = React.useState(0);
  return () => setTick((value) => value + 1);
}

function activeRepoData() {
  return state.activeRepo ? ensureRepoData(state.activeRepo) : null;
}

function ensureRepoData(path) {
  const key = normalizePath(path);
  if (!state.repoData[key]) {
    state.repoData[key] = {
      path: key,
      name: repoDisplayName(key, state.workspacePath),
      gitDir: "",
      bare: false,
      quick: null,
      quickAt: 0,
      status: emptyStatus(),
      statusAt: 0,
      // 状态内容变化（或写操作后强制失效）才递增；差异缓存据此判断是否需要重载。
      statusGeneration: 0,
      statusSignature: "",
      statusRequest: 0,
      statusInvalidate: false,
      branches: { locals: [], remotes: [] },
      tags: [],
      stashes: [],
      remotes: [],
      worktrees: [],
      submodules: [],
      detailsErrors: {},
      refsTruncated: false,
      operations: { merge: false, rebase: false, cherryPick: false, revert: false, bisect: false },
      headMessage: "",
      loading: { status: false, details: false, head: false },
      error: null,
      compare: null,
      expandedDirs: new Set(),
      expandedDirsReady: false,
      diffCache: {},
    };
  }
  return state.repoData[key];
}

function setState(patch) {
  Object.assign(state, patch);
  notify();
}

function getSettings() {
  return state.settings;
}

async function loadSettings() {
  let saved = null;
  try {
    saved = await appCtx.storage.get("settings");
  } catch (error) {
    saved = null;
  }
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    state.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }
  try {
    const history = await appCtx.storage.get("commitHistory");
    if (Array.isArray(history)) state.commitHistory = history.filter((item) => typeof item === "string");
  } catch (error) {
    // ignore
  }
  try {
    const manual = await appCtx.storage.get("manualRepos");
    if (manual && typeof manual === "object" && !Array.isArray(manual)) state.manualRepos = manual;
  } catch (error) {
    // ignore
  }
  try {
    const cache = await appCtx.storage.get("repoCache");
    if (cache && typeof cache === "object" && !Array.isArray(cache)) {
      const now = Date.now();
      for (const key of Object.keys(cache)) {
        const entry = cache[key];
        if (!entry || !Array.isArray(entry.repos)) continue;
        if (now - (entry.at || 0) > REPO_CACHE_MAX_AGE_MS) continue;
        state.repoCache[key] = entry;
      }
    }
  } catch (error) {
    // ignore
  }
  state.commitSignOff = Boolean(state.settings.signOff);
  state.commitSkipHooks = Boolean(state.settings.skipHooks);
  state.commitNoGpg = Boolean(state.settings.noGpgSign);
  state.ready = true;
  notify();
}

async function saveSettings(patch) {
  state.settings = Object.assign({}, state.settings, patch || {});
  if (patch && Object.prototype.hasOwnProperty.call(patch, "signOff")) state.commitSignOff = Boolean(patch.signOff);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "skipHooks")) state.commitSkipHooks = Boolean(patch.skipHooks);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "noGpgSign")) state.commitNoGpg = Boolean(patch.noGpgSign);
  notify();
  const snapshot = Object.assign({}, state.settings);
  settingsSaveChain = settingsSaveChain.then(async () => {
    try {
      await appCtx.storage.set("settings", snapshot);
    } catch (error) {
      toast("设置保存失败：" + safeError(error), "error");
    }
  });
  await settingsSaveChain;
}

async function saveCommitHistory(next) {
  state.commitHistory = next;
  notify();
  try {
    await appCtx.storage.set("commitHistory", next);
  } catch (error) {
    // 历史记录失败不影响提交
  }
}

async function saveManualRepos() {
  try {
    await appCtx.storage.set("manualRepos", state.manualRepos);
  } catch (error) {
    // ignore
  }
}

/* ---------- toast / dialog ---------- */

function toast(message, tone) {
  const id = uid("toast");
  const item = { id, message: String(message || ""), tone: tone || "info", at: Date.now() };
  state.toasts = state.toasts.concat([item]).slice(-4);
  notify();
  const timer = setTimeout(() => {
    toastTimers.delete(id);
    state.toasts = state.toasts.filter((toastItem) => toastItem.id !== id);
    notify();
  }, tone === "error" ? 9000 : 4200);
  toastTimers.set(id, timer);
}

function dismissToast(id) {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
  state.toasts = state.toasts.filter((item) => item.id !== id);
  notify();
}

function openDialog(spec) {
  const previous = state.dialog;
  if (previous && typeof previous.resolve === "function") {
    previous.resolve(previous.kind === "confirm" ? false : null);
  }
  const id = uid("dialog");
  state.dialog = Object.assign({ id }, spec);
  notify();
  return id;
}

function closeDialog(value) {
  const dialog = state.dialog;
  state.dialog = null;
  notify();
  if (dialog && typeof dialog.resolve === "function") dialog.resolve(value);
}

function confirmDialog(options) {
  return new Promise((resolve) => {
    openDialog({
      kind: "confirm",
      title: options.title || "确认操作",
      message: options.message || "",
      detail: options.detail || "",
      confirmLabel: options.confirmLabel || "确定",
      cancelLabel: options.cancelLabel || "取消",
      danger: Boolean(options.danger),
      resolve,
    });
  });
}

/**
 * 通用表单对话框。fields: [{key,label,type:'text'|'textarea'|'select'|'checkbox',
 * value, placeholder, options:[{value,label}], hint}]
 */
function promptDialog(options) {
  return new Promise((resolve) => {
    openDialog({
      kind: "prompt",
      title: options.title || "输入",
      description: options.description || "",
      fields: options.fields || [],
      confirmLabel: options.confirmLabel || "确定",
      cancelLabel: options.cancelLabel || "取消",
      danger: Boolean(options.danger),
      resolve,
    });
  });
}

function confirmDestructive(options) {
  if (!state.settings.confirmDestructive) return Promise.resolve(true);
  return confirmDialog(options);
}

/* ---------- 队列 / busy ---------- */

function enqueue(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => undefined);
  return run;
}

async function withBusy(label, task) {
  state.busy = label;
  notify();
  try {
    return await task();
  } finally {
    state.busy = "";
    notify();
  }
}

function reportError(error, prefix) {
  const message = safeError(error);
  const hint = networkHintFor(message);
  // 提示放尾部，但先把原始错误收窄，避免随后的 600 字截断把它吃掉。
  const body = hint ? truncate(message, 360) + hint : message;
  const text = (prefix ? prefix + "：" : "") + body;
  toast(truncate(text, 600), "error");
  return text;
}

/* ---------- 仓库清单 ---------- */

function setActiveRepo(path) {
  if (!path) return;
  const normalized = normalizePath(path);
  if (!state.repos.some((repo) => pathKey(repo.path) === pathKey(normalized))) {
    state.repos = state.repos.concat({
      path: normalized,
      name: repoDisplayName(normalized, state.workspacePath),
      sources: ["session"],
      relative: state.workspacePath ? relativePath(state.workspacePath, normalized) : normalized,
      nested: false,
      isActiveWorkspaceRepo: state.workspacePath ? isSubPath(state.workspacePath, normalized) : false,
    });
  }
  if (pathKey(state.activeRepo) !== pathKey(normalized)) state.commitAmend = false;
  state.activeRepo = normalized;
  if (state.history && pathKey(state.history.repo) !== pathKey(normalized)) {
    state.history = null;
    if (state.activeTab === "history") state.activeTab = "changes";
  }
  if (state.blame && pathKey(state.blame.repo) !== pathKey(normalized)) {
    state.blame = null;
    if (state.activeTab === "blame") state.activeTab = "changes";
  }
  const data = ensureRepoData(normalized);
  state.selectedFile = state.selectedFile && pathKey(state.selectedFile.repo) === pathKey(normalized)
    ? state.selectedFile
    : null;
  if (!data.expandedDirs || data.expandedDirs.size === 0) data.expandedDirs = new Set();
  notify();
  void loadRepoStatus(normalized, true);
  void loadRepoDetails(normalized, true);
  const logView = getLogView(normalized);
  if (!logView.commits.length) void loadLog(normalized, true);
}

async function setWorkspace(path, options) {
  const ws = path ? normalizePath(path) : "";
  if (pathKey(ws) === pathKey(state.workspacePath) && state.repos.length && !(options && options.force)) return;
  state.workspacePath = ws;
  state.workspaceName = ws ? baseName(ws) : "";
  state.scanToken = (state.scanToken || 0) + 1;
  state.scanning = false;
  state.repos = [];
  state.scanError = null;
  state.scanWarnings = [];
  state.activeRepo = "";
  state.selectedFile = null;
  state.blame = null;
  state.history = null;
  if (state.activeTab === "history" || state.activeTab === "blame") state.activeTab = "changes";
  state.logViews = {};
  notify();
  if (!ws) return;
  const cached = cachedRepoEntry(ws);
  if (cached && cached.repos.length) {
    applyCachedRepos(ws, cached.repos);
    notify();
  }
  if (state.settings.autoScan) {
    await scanWorkspace();
  } else {
    await loadRootRepoOnly(ws);
  }
}

async function loadRootRepoOnly(ws) {
  if (pathKey(state.workspacePath) !== pathKey(ws)) return;
  const token = state.scanToken;
  await loadGitVersion();
  const roots = new Map();
  const add = (path) => {
    if (!path) return;
    const normalized = normalizePath(path);
    roots.set(pathKey(normalized), normalized);
  };
  add(await resolveRepoRoot(ws));
  for (const manual of state.manualRepos[pathKey(ws)] || []) {
    add(await resolveRepoRoot(manual));
  }
  if (state.scanToken !== token || pathKey(state.workspacePath) !== pathKey(ws)) return;
  const repos = Array.from(roots.values()).map((path) => ({
    path,
    name: repoDisplayName(path, ws),
    sources: ["manual"],
    relative: relativePath(ws, path),
    nested: false,
    isActiveWorkspaceRepo: isSubPath(ws, path),
  }));
  applyDiscoveredRepos(repos);
  notify();
  if (!state.activeRepo && repos.length) setActiveRepo(repos[0].path);
  void loadQuickStatuses(repos);
}

const REPO_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cachedRepoEntry(ws) {
  if (!ws) return null;
  const entry = state.repoCache && state.repoCache[pathKey(ws)];
  if (!entry || !Array.isArray(entry.repos)) return null;
  // 运行期也要校验 TTL：会话跨过 7 天后应重新扫描，而不是继续展示旧仓库。
  if (!entry.at || Date.now() - entry.at > REPO_CACHE_MAX_AGE_MS) return null;
  return entry;
}

/** 把仓库发现结果写入状态，并同步每个仓库的展示名。 */
function applyDiscoveredRepos(repos) {
  state.repos = repos;
  for (const repo of repos) {
    const data = ensureRepoData(repo.path);
    data.name = repo.name;
    data.repo = repo;
  }
}

function applyCachedRepos(ws, repos) {
  applyDiscoveredRepos(
    repos.map((repo) =>
      Object.assign({}, repo, {
        isActiveWorkspaceRepo: isSubPath(ws, repo.path) || pathKey(repo.path) === pathKey(ws),
      }),
    ),
  );
}

async function saveRepoCache(ws, repos) {
  if (!ws) return;
  const key = pathKey(ws);
  state.repoCache = Object.assign({}, state.repoCache, {
    [key]: { at: Date.now(), repos: repos.slice() },
  });
  try {
    await appCtx.storage.set("repoCache", state.repoCache);
  } catch (error) {
    // 缓存写入失败不影响使用
  }
}

async function scanWorkspace(options) {
  const ws = state.workspacePath;
  if (!ws) return;
  const opts = options || {};
  const cached = cachedRepoEntry(ws);
  // 缓存里没有任何属于当前工作区的仓库时视为过期结果（工作区后来才 git init，
  // 或缓存由旧版本写入），直接重扫，避免面板长期显示空列表。
  const cacheInScope = Boolean(
    cached && cached.repos.length && cached.repos.some((repo) => repo.isActiveWorkspaceRepo),
  );
  if (!opts.force && cacheInScope) {
    if (!state.repos.length) applyCachedRepos(ws, cached.repos);
    if (!state.activeRepo && state.repos.length) {
      const preferred =
        state.repos.find((repo) => pathKey(repo.path) === pathKey(ws)) ||
        state.repos.find((repo) => repo.isActiveWorkspaceRepo) ||
        state.repos[0];
      setActiveRepo(preferred.path);
    }
    void loadQuickStatuses(state.repos);
    state.scanning = false;
    notify();
    return;
  }
  const token = (state.scanToken || 0) + 1;
  state.scanToken = token;
  state.scanning = true;
  state.scanError = null;
  state.scanWarnings = [];
  notify();
  try {
    await loadGitVersion();
    // 阶段一：并发 rev-parse，几百毫秒内先把仓库列表显示出来。
    const quick = await discoverRepos(ws, state.settings, { deep: false });
    if (state.scanToken !== token || pathKey(state.workspacePath) !== pathKey(ws)) return;
    applyDiscoveredRepos(quick.repos);
    // 阶段一只覆盖「工作区本身或已登记工作区是仓库」的情况。工作区里只有
    // 子仓库时（如 dc-eam/dc_eam），探测结果全是别的工作区，若此时结束扫描
    // 会让界面误报「没有 Git 仓库」，因此保持扫描态直到深扫结束。
    if (quick.repos.some((repo) => repo.isActiveWorkspaceRepo)) state.scanning = false;
    notify();
    // 阶段二：目录遍历补全子仓库，后台执行，不阻塞界面。
    void finishDeepScan(ws, token, quick);
  } catch (error) {
    if (state.scanToken !== token) return;
    state.scanning = false;
    state.scanError = safeError(error);
    notify();
  }
}

/** 扫描阶段二：复用阶段一的目标与仓库，只做一次批量目录遍历。 */
async function finishDeepScan(ws, token, quick) {
  let full;
  try {
    full = await discoverRepos(ws, state.settings, {
      deep: true,
      targets: quick.targets,
      seed: quick.repos,
      skipProbe: true,
    });
  } catch (error) {
    if (state.scanToken !== token || pathKey(state.workspacePath) !== pathKey(ws)) return;
    state.scanning = false;
    state.scanWarnings = [safeError(error)];
    notify();
    return;
  }
  if (state.scanToken !== token || pathKey(state.workspacePath) !== pathKey(ws)) return;
  const repos = full.repos;
  state.scanning = false;
  state.scanWarnings = full.errors;
  applyDiscoveredRepos(repos);
  notify();
  void saveRepoCache(ws, repos);
  if (state.activeRepo && !repos.some((repo) => pathKey(repo.path) === pathKey(state.activeRepo))) {
    state.activeRepo = "";
  }
  if (!state.activeRepo && repos.length) {
    const preferred =
      repos.find((repo) => pathKey(repo.path) === pathKey(ws)) ||
      repos.find((repo) => repo.isActiveWorkspaceRepo && isSubPath(repo.path, ws)) ||
      repos[0];
    setActiveRepo(preferred.path);
  }
  void loadQuickStatuses(repos);
}

async function loadQuickStatuses(repos) {
  const queue = (repos || []).slice();
  const workers = [];
  const limit = Math.min(4, queue.length);
  for (let i = 0; i < limit; i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const repo = queue.shift();
          if (!repo) return;
          await loadQuickStatusFor(repo.path);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

async function loadQuickStatusFor(path) {
  const key = normalizePath(path);
  const data = ensureRepoData(key);
  try {
    const quick = await loadQuickStatus(key);
    if (!state.repoData[key]) return;
    data.quick = quick;
    data.quickAt = Date.now();
    if (quick.error) data.error = quick.error;
    if (state.activeRepo === key) notify();
    else notify();
  } catch (error) {
    data.quick = { error: safeError(error) };
    data.quickAt = Date.now();
    notify();
  }
}

/* ---------- 状态加载 ---------- */

async function loadRepoStatus(path, force) {
  const key = normalizePath(path);
  const data = ensureRepoData(key);
  if (!force && data.loading.status) return statusInflight.get(key);
  if (!force && Date.now() - data.statusAt < 5000) return;
  if (statusInflight.has(key)) {
    const current = statusInflight.get(key);
    // 强制刷新必须等旧请求结束后再跑一次，否则会拿到变更前的旧 status。
    return force ? current.then(() => loadRepoStatus(key, true)) : current;
  }
  // statusRequest 只用于丢弃过期请求；statusGeneration 仅在内容变化或写操作要求失效时递增。
  const request = (data.statusRequest || 0) + 1;
  data.statusRequest = request;
  const invalidate = Boolean(data.statusInvalidate);
  data.statusInvalidate = false;
  data.loading.status = true;
  data.error = null;
  notify();
  const task = (async () => {
    try {
      const res = await runGit(
        key,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        { allowFailure: true, timeoutMs: 30000 },
      );
      let parsed;
      if (res.code === 0) {
        parsed = parseStatusPorcelain(res.stdout, res.stderr, gitVersion);
      } else if (/unknown option|not a git repository|fatal: bad revision/i.test(res.stderr || "")) {
        const fallback = await runGit(
          key,
          ["status", "--porcelain", "--branch", "-z", "--untracked-files=all"],
          { allowFailure: true, timeoutMs: 30000 },
        );
        if (fallback.code !== 0) {
          throw new GitCommandError((fallback.stderr || fallback.stdout || "").trim(), fallback.entry);
        }
        parsed = parseStatusPorcelain(fallback.stdout, fallback.stderr, gitVersion);
      } else {
        throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      }
      if (data.statusRequest !== request) {
        if (invalidate) data.statusInvalidate = true;
        return;
      }
      const signature = computeStatusSignature(parsed);
      const changed = invalidate || signature !== data.statusSignature;
      if (changed) {
        data.statusSignature = signature;
        data.statusGeneration = (data.statusGeneration || 0) + 1;
        data.status = parsed;
      } else {
        // 内容未变：沿用旧对象，避免轮询导致选中文件的差异重载与界面闪烁。
        parsed = data.status;
      }
      data.statusAt = Date.now();
      // 完整 status 已包含分支与文件清单，同步一份轻量快照给仓库侧栏，避免两边计数不一致。
      data.quick = {
        branch: parsed.branch,
        changed: uniquePaths(
          parsed.staged.concat(parsed.unstaged, parsed.untracked, parsed.conflicted),
        ).length,
        staged: parsed.staged.length,
        unstaged: parsed.unstaged.length,
        untracked: parsed.untracked.length,
        conflicted: parsed.conflicted.length,
        truncated: parsed.truncated,
        files: parsed.staged
          .concat(parsed.unstaged, parsed.untracked, parsed.conflicted)
          .map((entry) => (entry.staged ? "S:" : "W:") + entry.path)
          .sort(),
      };
      data.quickAt = Date.now();
      data.loading.status = false;
      data.error = null;
      if (changed) {
        syncCheckedFiles(key, parsed);
        updateExpandedDirs(key, parsed);
      }
      const selection = state.selectedFile;
      if (selection && pathKey(selection.repo) === pathKey(key)) {
        const match = parsed.entries.find(
          (entry) => entry.path === selection.path && Boolean(entry.staged) === Boolean(selection.staged),
        );
        if (!match) {
          const moved = parsed.entries.find((entry) => entry.path === selection.path);
          if (!moved) {
            state.selectedFile = null;
          } else {
            state.selectedFile = Object.assign({}, selection, { staged: Boolean(moved.staged) });
            state.diffMode = moved.staged ? "staged" : "worktree";
          }
        }
      }
      notify();
      void loadOperations(key).catch(() => undefined);
    } catch (error) {
      if (invalidate) data.statusInvalidate = true;
      if (data.statusRequest !== request) return;
      data.loading.status = false;
      data.error = safeError(error);
      notify();
    } finally {
      if (statusInflight.get(key) === task) statusInflight.delete(key);
    }
  })();
  statusInflight.set(key, task);
  return task;
}

/** 状态内容签名：仅包含会影响列表与差异的可序列化字段，用于判断轮询结果是否真的变化。 */
function computeStatusSignature(status) {
  const branch = status.branch || {};
  const parts = [
    [branch.head, branch.oid, branch.upstream, branch.ahead, branch.behind, branch.detached, branch.unborn, branch.upstreamGone].join("\u0001"),
    status.truncated ? "T" : "F",
    status.format || "",
  ];
  for (const entry of status.entries || []) {
    parts.push([entry.path, entry.origPath || "", entry.x, entry.y, entry.code, entry.staged ? 1 : 0, entry.unmerged ? 1 : 0, entry.sub || ""].join("\u0001"));
  }
  return parts.join("\u0000");
}

/**
 * 按行记录的输出若触达 64KB 上限，最后一行可能被截断：丢弃最后一个换行之后的残片。
 * 返回 {text, truncated}。
 */
function clipTruncatedLines(stdout) {
  const text = String(stdout || "");
  if (text.length < GIT_MAX_OUTPUT - 64) return { text, truncated: false };
  const cut = text.lastIndexOf("\n");
  return { text: cut >= 0 ? text.slice(0, cut) : "", truncated: true };
}

function syncCheckedFiles(repo, status) {
  const existing = state.checkedByRepo[repo] || {};
  const next = {};
  const entries = status.staged.concat(status.unstaged, status.untracked, status.conflicted);
  for (const entry of entries) {
    const key = entryKey(entry);
    next[key] = existing[key] === undefined ? true : existing[key];
  }
  state.checkedByRepo[repo] = next;
}

function updateExpandedDirs(repo, status) {
  const data = ensureRepoData(repo);
  const entries = status.staged.concat(status.unstaged, status.untracked, status.conflicted);
  if (!data.expandedDirs) data.expandedDirs = new Set();
  if (!data.expandedDirsReady && entries.length > 0) {
    data.expandedDirs = allDirPaths(buildCompactFileTree(entries));
    data.expandedDirsReady = true;
  }
}

async function loadOperations(repo) {
  const data = ensureRepoData(repo);
  const gitDir = data.gitDir || (await resolveGitDir(repo));
  const operations = { merge: false, cherryPick: false, revert: false, bisect: false, rebase: false };
  if (gitDir) {
    // 一次 shell 检查全部状态文件，避免轮询时反复启动 4 个 git 进程。
    const script = shellIsWindows({ CCGIT_GITDIR: gitDir })
      ? "$d=$env:CCGIT_GITDIR; $out=@(); foreach($n in @('MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','BISECT_LOG')){ if(Test-Path -LiteralPath ([IO.Path]::Combine($d,$n))){$out+='1'}else{$out+='0'} }; $r=0; if((Test-Path -LiteralPath ([IO.Path]::Combine($d,'rebase-merge'))) -or (Test-Path -LiteralPath ([IO.Path]::Combine($d,'rebase-apply')))){$r=1}; [Console]::Out.Write(($out -join ' ')+' '+$r)"
      : 'd="$CCGIT_GITDIR"; printf "%s %s %s %s %s\n" "$([ -f "$d/MERGE_HEAD" ] && echo 1 || echo 0)" "$([ -f "$d/CHERRY_PICK_HEAD" ] && echo 1 || echo 0)" "$([ -f "$d/REVERT_HEAD" ] && echo 1 || echo 0)" "$([ -f "$d/BISECT_LOG" ] && echo 1 || echo 0)" "$([ -d "$d/rebase-merge" ] || [ -d "$d/rebase-apply" ] && echo 1 || echo 0)"';
    try {
      const res = await runShell(script, { CCGIT_GITDIR: toSlash(gitDir) }, {
        allowFailure: true,
        description: "检测进行中的 Git 操作",
        timeoutMs: 10000,
      });
      const parts = String(res.stdout || "").trim().split(/\s+/);
      if (parts.length >= 5) {
        operations.merge = parts[0] === "1";
        operations.cherryPick = parts[1] === "1";
        operations.revert = parts[2] === "1";
        operations.bisect = parts[3] === "1";
        operations.rebase = parts[4] === "1";
      }
    } catch (error) {
      // 检测失败时保持全部 false；后续操作会由 git 自身报错。
    }
  }
  data.operations = operations;
  notify();
}

/* ---------- 分支 / 标签 / 暂存 / 远程 / 子模块 ---------- */

async function loadRepoDetails(path, force) {
  const key = normalizePath(path);
  const data = ensureRepoData(key);
  if (!force && detailsInflight.has(key)) return detailsInflight.get(key);
  if (!force && Date.now() - (data.detailsAt || 0) < 15000) return;
  const generation = (data.detailsGeneration || 0) + 1;
  data.detailsGeneration = generation;
  data.loading.details = true;
  notify();
  const task = (async () => {
    const errors = {};
    let truncated = false;
    const safe = async (fn, fallback, name) => {
      try {
        return await fn();
      } catch (error) {
        if (name) errors[name] = safeError(error);
        return fallback;
      }
    };
    // 失败时抛出 git 原始 stderr；触达输出上限时丢弃最后一条可能残缺的记录。
    const refs = async (args, timeoutMs, parse) => {
      const res = await runGit(key, args, { allowFailure: true, timeoutMs });
      if (res.code !== 0) throw new Error((res.stderr || res.stdout || "git " + args[0] + " 失败").trim());
      const clipped = clipTruncatedLines(res.stdout);
      if (clipped.truncated) truncated = true;
      return parse(clipped.text);
    };
    const [gitDir, bare, branches, tags, stashes, remotes, worktrees, submodules, headMessage] =
      await Promise.all([
        safe(() => resolveGitDir(key), data.gitDir || ""),
        safe(async () => {
          const res = await runGit(key, ["rev-parse", "--is-bare-repository"], {
            allowFailure: true,
            timeoutMs: 10000,
          });
          return res.code === 0 && /true/.test(res.stdout);
        }, false),
        safe(() => refs([
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)%00%(authorname)%00%(subject)",
          "refs/heads",
          "refs/remotes",
        ], 20000, parseBranches), { locals: [], remotes: [] }, "branches"),
        safe(() => refs([
          "for-each-ref",
          "--format=%(refname:short)%00%(objectname)%00%(objecttype)%00%(taggername)%00%(taggerdate:unix)%00%(subject)%00%(*objectname:short)",
          "refs/tags",
        ], 20000, parseTags), [], "tags"),
        safe(() => refs(["stash", "list", "--pretty=format:%gd%x1f%H%x1f%ct%x1f%gs"], 20000, parseStashes), [], "stashes"),
        safe(() => refs(["remote", "-v"], 10000, parseRemotes), [], "remotes"),
        safe(() => refs(["worktree", "list", "--porcelain"], 15000, parseWorktrees), [], "worktrees"),
        safe(() => refs(["submodule", "status", "--recursive"], 20000, parseSubmodules), [], "submodules"),
        safe(async () => {
          const res = await runGit(key, ["log", "-1", "--format=%B"], {
            allowFailure: true,
            timeoutMs: 10000,
          });
          return (res.stdout || "").trim();
        }, ""),
      ]);
    if (data.detailsGeneration !== generation) return;
    data.gitDir = gitDir || data.gitDir;
    data.bare = bare;
    data.branches = branches;
    data.tags = tags;
    data.stashes = stashes;
    data.remotes = remotes;
    data.worktrees = worktrees;
    data.submodules = submodules;
    data.headMessage = headMessage;
    data.detailsErrors = errors;
    data.refsTruncated = truncated;
    data.detailsAt = Date.now();
    data.loading.details = false;
    notify();
    if (detailsInflight.get(key) === task) detailsInflight.delete(key);
  })().catch((error) => {
    if (detailsInflight.get(key) === task) detailsInflight.delete(key);
    if (data.detailsGeneration !== generation) return;
    data.loading.details = false;
    data.error = safeError(error);
    notify();
  });
  detailsInflight.set(key, task);
  return task;
}

/* ---------- 提交日志 ---------- */

function defaultLogFilter() {
  return { text: "", author: "", path: "", all: false };
}

function getLogView(repo) {
  if (!state.logViews[repo]) {
    state.logViews[repo] = {
      commits: [],
      loading: false,
      hasMore: true,
      offset: 0,
      filter: defaultLogFilter(),
      error: null,
      truncated: false,
    };
  }
  return state.logViews[repo];
}

async function loadLog(path, reset, options) {
  const key = normalizePath(path);
  const view = getLogView(key);
  const opts = options || {};
  if (opts.filter) view.filter = Object.assign({}, view.filter, opts.filter);
  if (view.loading) {
    if (reset) view.reloadAfter = true;
    return logInflight.get(key);
  }
  view.reloadAfter = false;
  if (reset) {
    view.commits = [];
    view.offset = 0;
    view.hasMore = true;
    view.error = null;
  }
  if (!view.hasMore && !reset) return;
  view.loading = true;
  notify();
  const pageSize = Math.max(20, Math.min(200, Number(state.settings.logPageSize) || PAGE_SIZE));
  const args = [
    "log",
    "--no-color",
    "--decorate=full",
    "--date=unix",
    "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e",
    "--max-count=" + pageSize,
    "--skip=" + view.offset,
  ];
  if (view.filter.all) args.push("--all");
  if (view.filter.text) args.push("--grep=" + view.filter.text, "-i");
  if (view.filter.author) args.push("--author=" + view.filter.author);
  if (view.filter.path) args.push("--follow", "--", view.filter.path);
  else args.push("--");
  const task = (async () => {
    try {
      const res = await runGit(key, args, { allowFailure: true, timeoutMs: 60000 });
      if (res.code !== 0) {
        view.error = (res.stderr || res.stdout || "git log 失败").trim();
        view.loading = false;
        notify();
        return;
      }
      const commits = parseLog(res.stdout);
      if (reset) {
        view.commits = commits;
      } else {
        const seen = new Set(view.commits.map((commit) => commit.hash));
        view.commits = view.commits.concat(commits.filter((commit) => !seen.has(commit.hash)));
      }
      const selected = ensureRepoData(key).selectedCommit;
      if (selected && !view.commits.some((commit) => commit.hash === selected.hash)) {
        ensureRepoData(key).selectedCommit = null;
      }
      view.offset += commits.length;
      view.hasMore = commits.length >= pageSize;
      view.loading = false;
      view.error = null;
      view.truncated = res.stdout.length >= GIT_MAX_OUTPUT - 64;
      notify();
    } catch (error) {
      view.loading = false;
      view.error = safeError(error);
      notify();
    } finally {
      logInflight.delete(key);
      if (view.reloadAfter && state.logViews[key] === view) {
        view.reloadAfter = false;
        void loadLog(key, true);
      }
    }
  })();
  logInflight.set(key, task);
  return task;
}

/* ---------- 工作区轮询 ---------- */

function startWorkspacePolling() {
  pollRefs += 1;
  if (pollTimer) clearInterval(pollTimer);
  const interval = Math.max(3, Number(state.settings.refreshInterval) || 8) * 1000;
  pollTimer = setInterval(() => {
    void pollWorkspace();
  }, interval);
  void pollWorkspace();
}

function pollWorkspace() {
  if (pollTask) return pollTask;
  pollTask = pollWorkspaceOnce().finally(() => {
    pollTask = null;
  });
  return pollTask;
}

async function pollWorkspaceOnce() {
  if (disposed) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  let meta = null;
  try {
    meta = await appCtx.workspace.getMetadata();
  } catch (error) {
    return;
  }
  const path = meta && meta.path ? normalizePath(meta.path) : "";
  if (path && pathKey(path) !== pathKey(state.workspacePath)) {
    await setWorkspace(path);
    return;
  }
  if (!state.settings.autoRefresh) return;
  const repo = state.activeRepo;
  if (!repo) return;
  const data = ensureRepoData(repo);
  if (data.loading.status) return;
  if (Date.now() - (data.statusAt || 0) < 3000) return;
  // 直接重载完整 status：quick 快照无法发现同一路径的内容变化。
  await loadRepoStatus(repo, true);
  // 非活动仓库的侧栏计数也需要跟上，但降低频率，避免每轮对全部仓库跑 status。
  const stale = state.repos.filter((item) => {
    if (pathKey(item.path) === pathKey(repo)) return false;
    const itemData = ensureRepoData(item.path);
    return Date.now() - (itemData.quickAt || 0) >= 15000;
  });
  if (stale.length) void loadQuickStatuses(stale);
}

function stopWorkspacePolling() {
  pollRefs = Math.max(0, pollRefs - 1);
  if (pollRefs > 0) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function disposeStore() {
  disposed = true;
  pollRefs = 0;
  if (deferredNotifyTimer) {
    clearTimeout(deferredNotifyTimer);
    deferredNotifyTimer = null;
  }
  stopWorkspacePolling();
  for (const timer of toastTimers.values()) clearTimeout(timer);
  toastTimers.clear();
  state.toasts = [];
  state.dialog = null;
  state.busy = "";
  state.workbenchOpen = false;
  storeListeners.clear();
}
