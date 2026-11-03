/* 由 scripts/build.mjs 生成，请勿直接编辑。源文件：src/*.js */
"use strict";

/* ===== 00-utils.js ===== */

/* ---------------------------------------------------------------------------
 * Git 工作台 — 单文件插件的源码分片（构建脚本把它们按顺序拼成 main.js）。
 * 本分片：常量、平台/路径/文本工具、通用格式化。
 * 禁止 import：插件以 ESM blob 加载，只能使用宿主注入的 ctx.react。
 * ------------------------------------------------------------------------- */

const PLUGIN_ID = "git-workbench";
const PLUGIN_VERSION = "0.2.24";
const GIT_MAX_OUTPUT = 64 * 1024; // 宿主 plugin_exec_run 单流上限
const NETWORK_TIMEOUT_MS = 300 * 1000; // 宿主上限
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const PAGE_SIZE = 100;
const MAX_DIFF_LINES = 4000;
const MAX_BLAME_LINES = 250;
const DATA_DIR = ".tmp";

const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  /Windows|Win32|Win64/i.test(String(navigator.userAgent || navigator.platform || ""));
// macOS 默认文件系统（APFS/HFS+）大小写不敏感，仓库路径比较需忽略大小写；
// Linux 按 ext4 等大小写敏感处理。navigator 缺失时按非 macOS 处理。
const IS_MACOS =
  typeof navigator !== "undefined" &&
  /Macintosh|Mac OS X|Mac_PowerPC/i.test(String(navigator.userAgent || navigator.platform || ""));
// 宿主沙箱里的 navigator 可能拿不到 Windows UA；出现盘符/UNC 路径时补上判据，
// 让脚本选择与 shell 选择始终一致。
let WINDOWS_PATH_HINT = false;

const DEFAULT_SETTINGS = {
  scanDepth: 2,
  scanExclude:
    "node_modules,.git,.svn,.hg,.next,.nuxt,.output,.cache,.venv,venv,__pycache__,target,dist,build,out,vendor,.gradle,.idea,coverage,.pnpm-store,.yarn,.turbo,.parcel-cache,.svelte-kit,.angular",
  autoScan: true,
  autoRefresh: true,
  refreshInterval: 8,
  logPageSize: 100,
  diffContext: 3,
  confirmDestructive: true,
  pullStrategy: "merge", // merge | rebase | ff-only
  fetchPrune: true,
  signOff: false,
  skipHooks: false,
  noGpgSign: false,
  commitHistory: [],
  fileView: "tree", // tree | flat
  diffLayout: "unified", // unified | split
};

const STATUS_LABEL = {
  M: "已修改",
  T: "类型变更",
  A: "新增",
  D: "已删除",
  R: "重命名",
  C: "复制",
  U: "冲突",
  "?": "未跟踪",
  "!": "已忽略",
};

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const LANE_COLORS = [
  "#4f8cff",
  "#36b37e",
  "#ff9f43",
  "#a78bfa",
  "#f472b6",
  "#22d3ee",
  "#facc15",
  "#a3e635",
];

/* ---------- 基础工具 ---------- */

function isWindows() {
  return IS_WINDOWS || WINDOWS_PATH_HINT;
}

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function uid(prefix) {
  return (
    (prefix || "id") +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

function toSlash(value) {
  return String(value == null ? "" : value).replace(/\\/g, "/");
}

function stripTrailingSlash(value) {
  const s = toSlash(value);
  if (s.length <= 1) return s;
  return s.replace(/\/+$/, "");
}

function baseName(value) {
  const s = stripTrailingSlash(value);
  const idx = s.lastIndexOf("/");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function dirName(value) {
  const s = stripTrailingSlash(value);
  const idx = s.lastIndexOf("/");
  if (idx < 0) return "";
  if (idx === 0) return "/";
  return s.slice(0, idx);
}

/** 仓库内相对路径拼接；绝对路径原样返回，不会被 base 吃掉。 */
function joinPath(base, rel) {
  const r = toSlash(rel);
  if (isAbsolutePath(r)) return normalizePath(r);
  const b = stripTrailingSlash(toSlash(base));
  const cleaned = r.replace(/^\.\//, "");
  return b ? b + "/" + cleaned : cleaned;
}

function isAbsolutePath(value) {
  const s = toSlash(value);
  return /^[A-Za-z]:\//.test(s) || s.startsWith("/") || s.startsWith("//");
}

function normalizePath(value) {
  const raw = String(value == null ? "" : value);
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]/.test(raw)) WINDOWS_PATH_HINT = true;
  let s = toSlash(raw);
  const unc = s.startsWith("//");
  s = s.replace(/\/+/g, "/");
  if (unc && !s.startsWith("//")) s = "/" + s;
  if (/^[A-Za-z]:/.test(s)) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  // 保留盘符根（C:/），否则 "C:" 在 Windows 上表示该盘当前目录而不是根目录。
  if (/^[A-Za-z]:\/$/.test(s)) return s;
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s;
}

function pathKey(value) {
  const s = normalizePath(value);
  // Windows 与 macOS 默认不区分大小写；Linux 保留大小写。
  return (isWindows() || IS_MACOS || /^[A-Za-z]:\//.test(s)) ? s.toLowerCase() : s;
}

function isSubPath(parent, child) {
  const p = pathKey(parent);
  const c = pathKey(child);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

function relativePath(root, target) {
  const r = normalizePath(root);
  const t = normalizePath(target);
  if (pathKey(t) === pathKey(r)) return "";
  const prefix = r.endsWith("/") ? r : r + "/";
  const baseKey = pathKey(r);
  const prefixKey = baseKey.endsWith("/") ? baseKey : baseKey + "/";
  if (pathKey(t).startsWith(prefixKey)) return t.slice(prefix.length);
  return t;
}

function shortHash(hash) {
  return String(hash || "").slice(0, 8);
}

function shortDate(epochSeconds) {
  const n = Number(epochSeconds);
  if (!n) return "";
  const d = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

/** 只保留日期部分（提交图日期列）。 */
function dateOnly(epochSeconds) {
  const text = shortDate(epochSeconds);
  return text ? text.slice(0, 10) : "";
}

function relativeTime(epochSeconds) {
  const n = Number(epochSeconds);
  if (!n) return "";
  const diff = Math.max(0, Date.now() / 1000 - n);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
  if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + " 个月前";
  return Math.floor(diff / (86400 * 365)) + " 年前";
}

function truncate(value, max) {
  const s = String(value == null ? "" : value);
  const limit = max || 200;
  return s.length <= limit ? s : s.slice(0, limit) + "…";
}

/** git 网络类失败：连不上、解析不了、握手失败、传输中断。 */
const NETWORK_ERROR_RE =
  /unable to access|could not resolve host|failed to connect|could not connect|connection (?:refused|reset|timed out)|operation timed out|timed out|SSL certificate|TLS handshake|RPC failed|early EOF|remote end hung up|proxy/i;

/**
 * 网络失败时追加的排查提示。git 不读 Windows 系统代理，本机常见的
 * 「Failed to connect to github.com:443」多由代理未配置导致。
 */
function networkHintFor(message) {
  return NETWORK_ERROR_RE.test(String(message || ""))
    ? " （网络不可达：请检查网络或代理设置，必要时执行 git config --global http.proxy <代理地址>）"
    : "";
}

function splitLines(text) {
  if (!text) return [];
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split("\n").length;
}

function hashText(text) {
  let hash = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** 把统一 diff / 补丁等文本按 UTF-16 单元切块，用于经环境变量写入文件。 */
function chunkText(text, size) {
  const s = String(text == null ? "" : text);
  const step = Math.max(512, size || 12000);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + step);
    // 不在代理对中间切分，否则 emoji 等增补平面字符会变成半个字符。
    if (end < s.length) {
      const code = s.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= i) end = Math.min(s.length, i + step);
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** 类似 shell 的参数切分：支持双/单引号与反斜杠转义，够控制台使用。 */
function splitCommandLine(input) {
  const s = String(input || "");
  const out = [];
  let cur = "";
  let quote = "";
  let escaped = false;
  let has = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      has = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      const next = s[i + 1];
      // Windows 路径里的反斜杠不是转义符：只有后跟空白、引号或另一个反斜杠时才转义，
      // 这样 `src\main.js` 不会被吞成 `srcmain.js`，同时保留 `a\ b` 这类 POSIX 写法。
      if (next !== undefined && !/[\s"'\\]/.test(next)) {
        cur += ch;
        has = true;
        continue;
      }
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 命令行展示：带空格/引号的参数加引号；不用于实际执行。 */
function formatArgv(argv) {
  return (argv || [])
    .map((arg) => {
      const s = String(arg);
      if (!s) return '""';
      if (/[\s"'\\$`]/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"';
      return s;
    })
    .join(" ");
}

function maskSecrets(text) {
  return String(text || "")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@")
    .replace(/([?&](?:token|access_token|password|private_token)=)[^&\s]+/gi, "$1***");
}

function safeError(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.stderr && !String(error.message || "").includes(error.stderr)) {
    parts.push(String(error.stderr));
  }
  return maskSecrets(parts.join("\n").trim()) || "未知错误";
}

function parseEpoch(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 将 "1.2.3" 之类的版本字符串转成可比较数组；解析失败返回 null。 */
function parseGitVersion(raw) {
  const m = String(raw || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function gitVersionAtLeast(version, major, minor) {
  if (!version) return true;
  if (version[0] > major) return true;
  if (version[0] < major) return false;
  return version[1] >= minor;
}

/** 文件状态两列码 → 人类可读标签。 */
function statusText(code) {
  return STATUS_LABEL[code] || code || "";
}

function statusTone(code) {
  switch (code) {
    case "A":
    case "?":
      return "add";
    case "D":
      return "del";
    case "R":
    case "C":
      return "move";
    case "U":
      return "conflict";
    case "T":
      return "type";
    default:
      return "mod";
  }
}

function fileKindLabel(entry) {
  if (!entry) return "";
  if (entry.unmerged) return "冲突";
  const code = entry.staged ? entry.x : entry.y;
  const label = statusText(code);
  if (entry.origPath && (code === "R" || code === "C")) {
    return label + "：" + entry.origPath + " → " + entry.path;
  }
  return label;
}

/** 状态行唯一 key：同一路径可能同时有 staged 与 unstaged 两条。 */
function entryKey(entry) {
  return (entry.staged ? "s:" : "u:") + entry.path;
}

function isConflictEntry(entry) {
  return Boolean(entry && (entry.unmerged || CONFLICT_CODES.has(String(entry.x || "") + String(entry.y || ""))));
}

/** 从 porcelain 状态里筛出需要提交的路径（去重）。 */
function uniquePaths(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    if (!entry || !entry.path) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry.path);
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 仓库名：父目录 + 名称，避免多个 worktree 同名。 */
function repoDisplayName(path, workspacePath) {
  const rel = workspacePath ? relativePath(workspacePath, path) : "";
  if (rel && !rel.startsWith("/") && rel !== path) return rel;
  return baseName(path) || path;
}

/** 简易防抖，用于输入过滤。 */
function debounce(fn, wait) {
  let timer = null;
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(null, args);
    }, wait || 150);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/* ===== 10-git.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：git CLI 执行层、跨平台 shell、工作区文件读写、仓库发现。
 * 插件没有文件系统 API：探测目录与读写工作区文件只能走 exec:sh /
 * exec:powershell（用户在权限清单里看得到），git 操作走 exec:git。
 * ------------------------------------------------------------------------- */

let appCtx = null; // activate() 注入
let dataRoot = null; // plugin.storage 根目录，用于临时补丁
let gitVersion = null;
let gitVersionRaw = "";
let consoleEntries = [];
let consoleSeq = 0;
let lastGitError = null;

function setAppContext(ctx) {
  appCtx = ctx;
}

function bridgeInvoke(command, args) {
  if (!appCtx || !appCtx.bridge || typeof appCtx.bridge.invoke !== "function") {
    return Promise.reject(new Error("插件桥不可用：缺少 ctx.bridge"));
  }
  return appCtx.bridge.invoke(command, args);
}

async function getDataRoot() {
  if (dataRoot) return dataRoot;
  try {
    const location = await appCtx.documentStorage.getLocation();
    dataRoot = stripTrailingSlash(toSlash(location && location.path ? location.path : ""));
  } catch (error) {
    dataRoot = "";
  }
  return dataRoot;
}

async function getTempDir() {
  const root = await getDataRoot();
  if (!root) throw new Error("无法获取插件数据目录，无法创建临时补丁文件");
  const dir = joinPath(root, DATA_DIR);
  await ensureDir(dir);
  return dir;
}

function pushConsole(entry) {
  consoleSeq += 1;
  const item = Object.assign(
    {
      id: "c" + consoleSeq,
      at: Math.floor(Date.now() / 1000),
      code: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      display: "",
      kind: "git",
    },
    entry,
  );
  if (!item.display) item.display = maskSecrets(formatArgv(item.argv || []));
  // 控制台是纯文本视图：NUL（-z 输出、目录扫描）不可见，转成换行更易读。
  item.stdout = maskSecrets(truncate(String(item.stdout || "").replace(/\0/g, "\n"), 20000));
  item.stderr = maskSecrets(truncate(String(item.stderr || "").replace(/\0/g, "\n"), 20000));
  consoleEntries = consoleEntries.concat([item]);
  if (consoleEntries.length > 300) consoleEntries = consoleEntries.slice(-300);
  notifyDeferred();
  return item;
}

function clearConsole() {
  consoleEntries = [];
  notify();
}

/** 全局 git 配置参数：关闭颜色/分页/签名展示，路径不转义。 */
function gitGlobalArgs(repoPath) {
  const args = [];
  if (repoPath) args.push("-C", toSlash(repoPath));
  args.push(
    "-c",
    "core.quotepath=false",
    "-c",
    "color.ui=false",
    "-c",
    "advice.detachedHead=false",
    "-c",
    "core.pager=cat",
    "-c",
    "log.showSignature=false",
    "-c",
    "interactive.singleKey=false",
    "--literal-pathspecs",
  );
  return args;
}

function gitEnv(extra) {
  return Object.assign(
    {
      // 统一英文输出，冲突/操作状态的正则判断不依赖用户 locale。
      LC_ALL: "C",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_ASKPASS: "echo",
    },
    extra || {},
  );
}

class GitCommandError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "GitCommandError";
    this.detail = detail || null;
    this.stderr = detail && detail.stderr ? detail.stderr : "";
    this.stdout = detail && detail.stdout ? detail.stdout : "";
    this.code = detail ? detail.code : null;
    this.argv = detail ? detail.argv : [];
  }
}

function isNotARepoError(error) {
  return /not a git repository|NOT_A_REPO/i.test(safeError(error));
}

/**
 * 执行 git 命令。所有命令都带 --literal-pathspecs，路径按字面量处理。
 * @returns {Promise<{code:number|null,stdout:string,stderr:string,argv:string[],durationMs:number}>}
 */
async function runGit(repoPath, args, options) {
  const opts = options || {};
  const argv = gitGlobalArgs(repoPath).concat(args || []);
  const started = Date.now();
  let result;
  try {
    result = await bridgeInvoke("plugin_exec_run", {
      bin: "git",
      args: argv,
      env: gitEnv(opts.env),
      timeoutMs: Math.max(1000, Math.min(NETWORK_TIMEOUT_MS, opts.timeoutMs || DEFAULT_TIMEOUT_MS)),
    });
  } catch (error) {
    const message = safeError(error);
    const item = pushConsole({
      kind: "git",
      repoPath: repoPath || "",
      argv,
      description: opts.description || "",
      code: null,
      stderr: message,
      durationMs: Date.now() - started,
    });
    throw new GitCommandError(message, item);
  }
  const entry = pushConsole({
    kind: "git",
    repoPath: repoPath || "",
    argv,
    description: opts.description || "",
    code: result.code,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    durationMs: Date.now() - started,
  });
  if (result.code !== 0 && !opts.allowFailure) {
    lastGitError = entry;
    const detail = (result.stderr || result.stdout || "").trim();
    throw new GitCommandError(detail || "git 命令失败（exit " + result.code + "）", entry);
  }
  if (result.code !== 0) lastGitError = entry;
  return {
    code: result.code,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    argv,
    durationMs: Date.now() - started,
    entry,
  };
}

function looksWindowsPath(value) {
  const s = String(value == null ? "" : value);
  const hit = /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s);
  if (hit) WINDOWS_PATH_HINT = true;
  return hit;
}

function shellIsWindows(env) {
  if (isWindows()) return true;
  // 宿主沙箱里的 navigator 不一定报告 Windows；工作区路径（D:/… 或 UNC）是更可靠的信号。
  const map = env && typeof env === "object" ? env : {};
  if (["CCGIT_ROOT", "CCGIT_FILE", "CCGIT_DIR", "CCGIT_GITDIR"].some((key) => looksWindowsPath(map[key]))) {
    return true;
  }
  // 扫描脚本的根目录按换行拼接，任意一行是盘符/UNC 即视为 Windows。
  return String(map.CCGIT_ROOTS || "")
    .split("\n")
    .some((line) => looksWindowsPath(line.trim()));
}

function shellBin(env) {
  return shellIsWindows(env) ? "powershell" : "sh";
}

function shellArgs(script, windows) {
  if (windows) {
    return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
  }
  return ["-c", script, "ccgui"];
}

/** 执行平台 shell 脚本；调用方负责把所有用户数据放进 env，避免注入。 */
async function runShell(script, env, options) {
  const opts = options || {};
  const started = Date.now();
  const windows = shellIsWindows(env);
  const bin = shellBin(env);
  const display = bin + (windows ? " -Command <script>" : " -c <script>");
  let result;
  try {
    result = await bridgeInvoke("plugin_exec_run", {
      bin,
      args: shellArgs(script, windows),
      env: Object.assign({}, env || {}),
      timeoutMs: Math.max(1000, Math.min(NETWORK_TIMEOUT_MS, opts.timeoutMs || 30000)),
    });
  } catch (error) {
    const message = safeError(error);
    if (!opts.silent) {
      pushConsole({
        kind: "shell",
        description: opts.description || "",
        display,
        code: null,
        stderr: message,
        durationMs: Date.now() - started,
      });
    }
    throw new GitCommandError(message);
  }
  const entry = opts.silent
    ? null
    : pushConsole({
        kind: "shell",
        description: opts.description || "",
        display,
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        durationMs: Date.now() - started,
      });
  if (result.code !== 0 && !opts.allowFailure) {
    throw new GitCommandError((result.stderr || "").trim() || "shell 命令失败", entry);
  }
  return { code: result.code, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/* ---------- 工作区文件读写（经 shell，按字节分块） ---------- */

function bytesFromBase64(b64) {
  const clean = String(b64 || "").replace(/[\s\r\n]/g, "");
  if (!clean) return new Uint8Array(0);
  let bin;
  try {
    bin = atob(clean);
  } catch (error) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeUtf8(bytes) {
  if (!bytes || !bytes.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (error) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

/**
 * 严格解码：非法 UTF-8 字节（GBK/GB18030 等）不返回替换字符，而是标记 invalid。
 * 以非 UTF-8 预览后再按 UTF-8 写回会永久损坏文件，因此调用方必须禁用编辑。
 */
function decodeUtf8Strict(bytes) {
  if (!bytes || !bytes.length) return { text: "", invalid: false };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), invalid: false };
  } catch (error) {
    return { text: "", invalid: true };
  }
}

function bytesHaveNul(bytes) {
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0) return true;
  return false;
}

const POWERSHELL_B64_PREFIX =
  "$ErrorActionPreference='Stop';\n" +
  "$fs=[IO.File]::OpenRead($env:CCGIT_FILE);\n" +
  "try{$fs.Seek([int64]$env:CCGIT_OFFSET,'Begin')|Out-Null;" +
  "$len=[int][Math]::Min([int64]$env:CCGIT_LEN,[Math]::Max(0,$fs.Length-$fs.Position));" +
  "$buf=New-Object byte[] $len; $n=0;" +
  "while($n -lt $len){$k=$fs.Read($buf,$n,$len-$n); if($k -le 0){break}; $n+=$k};" +
  "[Convert]::ToBase64String($buf,0,$n)}finally{$fs.Close()}";

const POSIX_B64_READ =
  '[ -f "$CCGIT_FILE" ] || exit 3; t=$(mktemp) || exit 4; trap \'rm -f "$t"\' EXIT; ' +
  'tail -c +$((CCGIT_OFFSET + 1)) "$CCGIT_FILE" > "$t" || exit 5; head -c "$CCGIT_LEN" "$t" | base64';

/**
 * 读取工作区文件。返回 {text, bytes, binary, truncated, size}；文件不存在返回 null。
 * 分块（base64）读取，避免 64KB 单次输出上限与 UTF-8 边界截断。
 */
async function readWorkspaceFile(path, options) {
  const opts = options || {};
  const maxBytes = Math.max(1024, Math.min(opts.maxBytes || 512 * 1024, 8 * 1024 * 1024));
  const chunkRaw = 45000;
  // 脚本必须与 runShell 实际选择的 shell 一致：以目标路径判断 Windows，
  // 而不是只看宿主 UA（沙箱里的 navigator 可能不报告 Windows）。
  const script = shellIsWindows({ CCGIT_FILE: path }) ? POWERSHELL_B64_PREFIX : POSIX_B64_READ;
  const parts = [];
  let offset = 0;
  let total = 0;
  let readOk = false;
  let readFailed = false;
  let truncated = false;
  for (;;) {
    // 多读 1 字节：用于区分「正好读满 maxBytes」和「文件还有更多内容」。
    const want = Math.min(chunkRaw, maxBytes - total + 1);
    if (want <= 0) break;
    const res = await runShell(script, {
      CCGIT_FILE: toSlash(path),
      CCGIT_OFFSET: String(offset),
      CCGIT_LEN: String(want),
    }, { description: "读取文件", allowFailure: true, timeoutMs: 30000, silent: true });
    if (res.code !== 0) {
      if (offset === 0) return null;
      readFailed = true;
      break;
    }
    readOk = true;
    const bytes = bytesFromBase64(res.stdout);
    if (!bytes.length) break;
    if (total + bytes.length > maxBytes) {
      parts.push(bytes.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    parts.push(bytes);
    offset += bytes.length;
    total += bytes.length;
    if (bytes.length < want) break;
  }
  if (!parts.length) {
    if (!readOk) return null;
    return { text: "", bytes: new Uint8Array(0), binary: false, size: 0, truncated: false };
  }
  let merged;
  if (parts.length === 1) merged = parts[0];
  else {
    merged = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      merged.set(part, at);
      at += part.length;
    }
  }
  const binary = bytesHaveNul(merged);
  // 截断点可能落在多字节 UTF-8 中间，严格解码会把这种大文件误判成二进制；
  // 截断内容不允许写回（调用方按 truncated 禁用编辑），这里只求可读。
  const decoded = binary
    ? { text: "", invalid: false }
    : readFailed || truncated
      ? { text: decodeUtf8(merged), invalid: false }
      : decodeUtf8Strict(merged);
  return {
    text: decoded.text,
    bytes: merged,
    // 非 UTF-8 文本不能安全写回，按二进制处理（UI 会禁用预览与编辑）。
    binary: binary || decoded.invalid,
    size: merged.length,
    truncated: readFailed || truncated,
  };
}

/** 路径是否存在（用于区分“文件不存在”和“文件不可读”，避免误覆盖）。 */
async function workspacePathExists(path) {
  const res = await runShell(
    shellIsWindows({ CCGIT_FILE: path })
      ? "if(Test-Path -LiteralPath $env:CCGIT_FILE){exit 0}else{exit 1}"
      : '[ -e "$CCGIT_FILE" ]',
    { CCGIT_FILE: toSlash(path) },
    { description: "检查文件是否存在", allowFailure: true, timeoutMs: 15000, silent: true },
  );
  return res.code === 0;
}

function powershellWriteScript(append) {
  return (
    "$ErrorActionPreference='Stop';\n" +
    "[IO.File]::" +
    (append ? "AppendAllText" : "WriteAllText") +
    "($env:CCGIT_FILE,$env:CCGIT_CHUNK,[Text.UTF8Encoding]::new($false))"
  );
}

function posixWriteScript(append) {
  return 'printf \'%s\' "$CCGIT_CHUNK" ' + (append ? '>>' : '>') + ' "$CCGIT_FILE"';
}

/** 写入工作区文件（UTF-8，无 BOM）。文本不能含 NUL。 */
async function writeWorkspaceFile(path, text) {
  const windows = shellIsWindows({ CCGIT_FILE: path });
  const chunks = chunkText(text, windows ? 12000 : 24000);
  if (!chunks.length) chunks.push("");
  const writeChunk = async (target, chunk, append) => {
    await runShell(windows ? powershellWriteScript(append) : posixWriteScript(append), {
      CCGIT_FILE: toSlash(target),
      CCGIT_CHUNK: chunk,
    }, { description: "写入文件", timeoutMs: 30000, silent: true });
  };
  // 分块写直接作用于目标文件时，任一块失败就只剩半截内容；先写临时文件再整体替换。
  const tmp = path + ".cg-tmp";
  try {
    for (let i = 0; i < chunks.length; i += 1) await writeChunk(tmp, chunks[i], i > 0);
    const move = windows
      ? "Move-Item -LiteralPath $env:CCGIT_TMP -Destination $env:CCGIT_FILE -Force"
      : 'if [ -e "$CCGIT_FILE" ]; then p=$(stat -c %a "$CCGIT_FILE" 2>/dev/null || stat -f %Lp "$CCGIT_FILE" 2>/dev/null); [ -n "$p" ] && chmod "$p" "$CCGIT_TMP"; fi; mv -f "$CCGIT_TMP" "$CCGIT_FILE"';
    await runShell(move, { CCGIT_TMP: toSlash(tmp), CCGIT_FILE: toSlash(path) }, {
      description: "替换文件",
      timeoutMs: 30000,
      silent: true,
    });
  } catch (error) {
    await removeWorkspaceFile(tmp);
    throw error;
  }
  return true;
}

async function removeWorkspaceFile(path) {
  const script = shellIsWindows({ CCGIT_FILE: path })
    ? "if(Test-Path -LiteralPath $env:CCGIT_FILE){Remove-Item -LiteralPath $env:CCGIT_FILE -Force}"
    : 'rm -f "$CCGIT_FILE"';
  await runShell(script, { CCGIT_FILE: toSlash(path) }, {
    description: "删除临时文件",
    allowFailure: true,
    timeoutMs: 15000,
    silent: true,
  });
}

async function ensureDir(path) {
  const script = shellIsWindows({ CCGIT_DIR: path })
    ? "[IO.Directory]::CreateDirectory($env:CCGIT_DIR)|Out-Null"
    : 'mkdir -p "$CCGIT_DIR"';
  await runShell(script, { CCGIT_DIR: toSlash(path) }, {
    description: "创建目录",
    timeoutMs: 15000,
    silent: true,
  });
}

/* ---------- 仓库发现 ---------- */

function normalizeExcludes(raw) {
  // 名字会按单引号转义后写进 sh/PowerShell 脚本，因此允许中文、空格和符号，
  // 只拒绝控制字符（会破坏脚本与输出分隔）与超长项。
  return Array.from(new Set(
    String(raw || "")
      // 设置页是多行文本框：逗号与换行都当作分隔符，避免整行含控制字符被丢弃。
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter((item) =>
        item &&
        item !== ".git" &&
        item.length <= 64 &&
        !/[\u0000-\u001f\u007f]/.test(item)),
  )).slice(0, 100);
}

/** 依赖、虚拟环境、构建缓存目录：无论设置如何都不进入遍历。 */
const BUILTIN_SCAN_SKIP = [
  "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "__pycache__",
  ".gradle", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache", ".svelte-kit",
];

function findScript(excludes, windows) {
  const names = Array.from(new Set([".git"].concat(BUILTIN_SCAN_SKIP, excludes || [])));
  if (windows) {
    // 单引号内只需翻倍单引号；中文、空格、$、反引号均为字面量。
    const list = names.map((name) => "'" + String(name).replace(/'/g, "''") + "'").join(",");
    return (
      "$ErrorActionPreference='SilentlyContinue';\n" +
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n" +
      "$max=[int]$env:CCGIT_DEPTH; $ex=@(" +
      list +
      ");\n" +
      "$out=New-Object System.Collections.Generic.List[string];\n" +
      "function Walk([string]$owner,[string]$d,[int]$lvl){\n" +
      " if($lvl -gt $max){return}\n" +
      " try{$items=[IO.Directory]::EnumerateFileSystemEntries($d)}catch{return}\n" +
      " foreach($p in $items){\n" +
      "  try{$n=[IO.Path]::GetFileName($p)}catch{continue}\n" +
      "  if($n -eq '.git'){$out.Add($owner + [char]0 + $p);continue}\n" +
      "  try{$attr=[IO.File]::GetAttributes($p)}catch{continue}\n" +
      "  if(($attr -band [IO.FileAttributes]::Directory) -eq 0){continue}\n" +
      "  if(($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0){continue}\n" +
      "  if($ex -contains $n){continue}\n" +
      "  Walk $owner $p ($lvl+1)\n" +
      " }\n" +
      "}\n" +
      "foreach($r in ($env:CCGIT_ROOTS -split \"`n\")){ $t=$r.Trim(); if($t){ Walk $t $t 0 } }\n" +
      "[Console]::Out.Write((($out -join ([char]0)) + [char]0))"
    );
  }
  // case 模式用单引号包裹：名字里的空格、中文、*、| 都按字面量匹配。
  const patterns = names
    .map((name) => "'" + String(name).replace(/'/g, "'\\''") + "'")
    .join("|");
  // 位置参数在 POSIX 函数里是局部的；不要用 owner/d/lvl 这类全局变量，
  // 否则递归返回后会覆盖父层深度，导致兄弟目录被提前跳过（漏扫仓库）。
  return [
    'max="$CCGIT_DEPTH";',
    'walk() {',
    '  [ "$3" -gt "$max" ] && return;',
    "  if [ -e \"$2/.git\" ]; then printf '%s\\000%s\\000' \"$1\" \"$2/.git\"; fi;",
    '  for p in "$2"/* "$2"/.*; do',
    '    [ -e "$p" ] || continue;',
    '    n="${p##*/}";',
    '    [ "$n" = "." ] && continue;',
    '    [ "$n" = ".." ] && continue;',
    '    [ -L "$p" ] && continue;',
    '    [ -d "$p" ] || continue;',
    '    [ "$n" = ".git" ] && continue;',
    '    case "$n" in ' + patterns + ') continue;; esac;',
    '    walk "$1" "$p" $(( $3 + 1 ));',
    '  done;',
    '}',
    'printf \'%s\\n\' "$CCGIT_ROOTS" | while IFS= read -r root; do',
    '  [ -n "$root" ] && walk "$root" "$root" 0;',
    'done',
  ].join("\n");
}

/**
 * 一次 shell 调用扫描多个根目录下的 .git（目录或 worktree/submodule 的 gitfile）。
 * 合并成单次进程启动，避免每个工作区各起一个 shell。
 * 返回 [{ owner, path }]，owner 是发起扫描的根。
 */
async function scanGitRoots(roots, settings) {
  const list = [];
  const seenRoot = new Set();
  for (const root of roots || []) {
    if (!root) continue;
    const normalized = normalizePath(root);
    const key = pathKey(normalized);
    if (seenRoot.has(key)) continue;
    seenRoot.add(key);
    list.push(normalized);
  }
  if (!list.length) return { roots: [], truncated: false };
  const depth = Math.max(1, Math.min(20, Number(settings.scanDepth) || 2));
  const excludes = normalizeExcludes(settings.scanExclude);
  const windows = isWindows() || list.some((root) => looksWindowsPath(root));
  const res = await runShell(findScript(excludes, windows), {
    CCGIT_ROOTS: list.map((root) => toSlash(root)).join("\n"),
    CCGIT_DEPTH: String(depth),
  }, { description: "扫描 Git 仓库", timeoutMs: 60000, allowFailure: true });
  if (res.code !== 0 && !res.stdout) {
    throw new GitCommandError((res.stderr || "").trim() || "目录扫描失败");
  }
  const found = [];
  const seen = new Set();
  const raw = String(res.stdout || "").replace(/^\uFEFF/, "");
  // 每对记录都以 NUL 收尾；末尾缺 NUL 或长度触顶说明输出被宿主截断。
  const truncated = raw.length >= GIT_MAX_OUTPUT - 64 || (raw.length > 0 && !raw.endsWith("\0"));
  // owner 与 .git 路径按 NUL 成对输出；目录名含换行/制表符也不会错位。
  const tokens = raw.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const owner = normalizePath(tokens[i]);
    const gitPath = toSlash(tokens[i + 1]);
    if (!gitPath) continue;
    if (baseName(gitPath) !== ".git") continue;
    const root = dirName(gitPath);
    if (!root) continue;
    const key = pathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ owner: owner || normalizePath(root), path: normalizePath(root) });
  }
  return { roots: found, truncated };
}

/** 并发探测一组路径所在的 Git 仓库根（只跑 git rev-parse，不做目录遍历）。 */
async function probeRepoRoots(paths, options) {
  const opts = options || {};
  const limit = Math.max(1, opts.concurrency || 8);
  const timeoutMs = opts.timeoutMs || 5000;
  const queue = [];
  const seen = new Set();
  for (const path of paths || []) {
    if (!path) continue;
    const normalized = normalizePath(path);
    const key = pathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(normalized);
  }
  const results = [];
  const worker = async () => {
    for (;;) {
      const path = queue.shift();
      if (!path) return;
      let root = "";
      try {
        root = await resolveRepoRoot(path, timeoutMs);
      } catch (error) {
        root = "";
      }
      results.push({ path, root: root ? normalizePath(root) : "" });
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, queue.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function resolveRepoRoot(path, timeoutMs) {
  const res = await runGit(toSlash(path), ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
    timeoutMs: timeoutMs || 15000,
  });
  if (res.code !== 0) return null;
  const line = splitLines(String(res.stdout || "").replace(/^\uFEFF/, ""))[0] || "";
  return line.trim() ? normalizePath(line) : null;
}

async function resolveGitDir(repoPath) {
  const res = await runGit(repoPath, ["rev-parse", "--absolute-git-dir"], {
    allowFailure: true,
    timeoutMs: 15000,
  });
  if (res.code !== 0) return null;
  const line = splitLines(String(res.stdout || "").replace(/^\uFEFF/, ""))[0] || "";
  return line.trim() ? normalizePath(line) : null;
}

async function loadGitVersion(force) {
  if (gitVersionRaw && !force) return gitVersionRaw;
  try {
    const res = await runGit(null, ["--version"], {
      allowFailure: true,
      timeoutMs: 10000,
      description: "检测 Git 版本",
    });
    gitVersionRaw = (res.stdout || res.stderr || "").trim();
    gitVersion = parseGitVersion(gitVersionRaw);
    if (res.code !== 0 && !gitVersionRaw) gitVersionRaw = "Git 不可用";
  } catch (error) {
    gitVersionRaw = safeError(error);
    gitVersion = null;
  }
  state.gitVersionRaw = gitVersionRaw;
  state.gitAvailable = gitVersion != null;
  notify();
  return gitVersionRaw;
}

/** 已登记的侧栏工作区（含 worktree 子行）。只读，用来补全仓库清单。 */
async function listRegisteredWorkspaces() {
  try {
    if (!appCtx.workspaces || typeof appCtx.workspaces.list !== "function") return [];
    const rows = await appCtx.workspaces.list();
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    return [];
  }
}

/** 收集仓库发现的目标：当前工作区 + 已登记工作区 + 手动仓库，各只出现一次。 */
async function collectRepoTargets(ws) {
  const targets = [];
  const seenTargets = new Set();
  const pushTarget = (path, source, owner) => {
    if (!path) return;
    const normalized = normalizePath(path);
    const key = pathKey(normalized);
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    targets.push({ path: normalized, source, owner: owner ? normalizePath(owner) : normalized });
  };

  if (ws) pushTarget(ws, "workspace", ws);
  for (const row of await listRegisteredWorkspaces()) {
    if (!row || !row.path) continue;
    const path = normalizePath(row.path);
    // 已被当前工作区覆盖（同一目录或当前工作区的子目录）时跳过。
    if (ws && (pathKey(path) === pathKey(ws) || isSubPath(ws, path))) continue;
    pushTarget(path, row.kind === "worktree" ? "worktree" : "registered", path);
  }
  for (const manual of state.manualRepos[pathKey(ws)] || []) {
    pushTarget(manual, "manual", ws);
  }
  return targets;
}

/**
 * 仓库发现：扫描当前工作区 + 已登记工作区 + 手动添加 + 当前工作区所在的父仓库。
 * 返回 [{path,name,source,relative,nested,workspaceId?}]。
 */
async function discoverRepos(workspacePath, settings, options) {
  const ws = workspacePath ? normalizePath(workspacePath) : "";
  const opts = options || {};
  const found = new Map();
  const errors = [];
  const noteError = (label, error) => {
    const message = safeError(error);
    errors.push(label ? label + "：" + message : message);
  };
  const add = (path, source, owner) => {
    if (!path) return;
    const normalized = normalizePath(path);
    const key = pathKey(normalized);
    if (found.has(key)) {
      const item = found.get(key);
      if (!item.sources.includes(source)) item.sources.push(source);
      if (!item.workspace && owner) item.workspace = normalizePath(owner);
      return;
    }
    found.set(key, { path: normalized, sources: [source], workspace: owner ? normalizePath(owner) : "" });
  };

  // 第二阶段可复用第一阶段的仓库与目标，避免重复探测。
  for (const repo of opts.seed || []) {
    add(repo.path, (repo.sources && repo.sources[0]) || "scan", repo.workspace);
  }
  const targets = Array.isArray(opts.targets) ? opts.targets : await collectRepoTargets(ws);

  // 1) 快速探测：并发 rev-parse，本身就是仓库的路径直接收录，不做目录遍历。
  if (!opts.skipProbe) {
    const probed = await probeRepoRoots(
      targets.map((target) => target.path),
      { concurrency: 8, timeoutMs: 5000 },
    );
    const targetByKey = new Map(targets.map((target) => [pathKey(target.path), target]));
    for (const item of probed) {
      if (!item.root) continue;
      const target = targetByKey.get(pathKey(item.path));
      if (target) add(item.root, target.source, target.owner);
    }
  }

  // 2) 深扫：所有需要补全的根合并成一次 shell 调用。
  const deepTargets = targets.filter((target) => target.source !== "worktree");
  if (opts.deep !== false && deepTargets.length) {
    const metaByRoot = new Map(
      deepTargets.map((target) => [
        pathKey(target.path),
        { source: target.source, owner: target.owner },
      ]),
    );
    try {
      const scan = await scanGitRoots(deepTargets.map((target) => target.path), settings);
      if (scan.truncated) {
        errors.push("仓库扫描输出达到 64KB 上限，部分仓库可能未列出；请减小扫描深度或增加排除目录。");
      }
      for (const item of scan.roots) {
        const meta = metaByRoot.get(pathKey(item.owner)) || { source: "scan", owner: item.owner };
        add(item.path, meta.source, meta.owner);
      }
    } catch (error) {
      noteError("扫描工作区", error);
    }
  }

  const repos = Array.from(found.values()).map((item) => {
    const path = item.path;
    const parents = Array.from(found.values()).filter(
      (other) => pathKey(other.path) !== pathKey(path) && isSubPath(other.path, path),
    );
    return {
      path,
      name: repoDisplayName(path, ws),
      sources: item.sources,
      workspace: item.workspace || (ws ? ws : ""),
      relative: ws ? relativePath(ws, path) : path,
      nested: parents.length > 0,
      isActiveWorkspaceRepo: ws ? isSubPath(ws, path) || pathKey(path) === pathKey(ws) : false,
    };
  });
  repos.sort((a, b) => {
    if (a.isActiveWorkspaceRepo !== b.isActiveWorkspaceRepo) return a.isActiveWorkspaceRepo ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return { repos, errors, targets };
}

/** 未跟踪条目按「排除目录」名单过滤：依赖、构建产物与编辑器缓存不应计入变更。
 *  只作用于未跟踪（`?`），已跟踪文件的修改（未暂存）保持原样。 */
function pruneExcludedUntracked(status, settings) {
  if (!status || !Array.isArray(status.untracked) || !status.untracked.length) return status;
  const excludes = normalizeExcludes(settings && settings.scanExclude);
  if (!excludes.length) return status;
  const skip = new Set(excludes.map((item) => item.toLowerCase()));
  // entries 持有与 untracked 相同的条目引用，必须一起过滤：
  // computeStatusSignature 只看 entries，不同步会导致内容变化被判为「未变」而沿用旧数据。
  const dropped = new Set();
  const kept = status.untracked.filter((entry) => {
    const segments = String(entry.path || "").toLowerCase().split("/");
    if (segments.some((segment) => skip.has(segment))) {
      dropped.add(entry);
      return false;
    }
    return true;
  });
  if (!dropped.size) return status;
  return Object.assign({}, status, {
    untracked: kept,
    entries: Array.isArray(status.entries)
      ? status.entries.filter((entry) => !dropped.has(entry))
      : status.entries,
  });
}

/** 快速摘要：分支/上游/变更数量，用于仓库列表与状态栏。 */
async function loadQuickStatus(repoPath) {
  let res = await runGit(repoPath, ["-c", "status.aheadBehind=true", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
    allowFailure: true,
    timeoutMs: 20000,
  });
  if (res.code !== 0 && /unknown option|unknown argument/i.test(res.stderr || "")) {
    res = await runGit(repoPath, ["status", "--porcelain", "--branch", "-z", "--untracked-files=all"], {
      allowFailure: true,
      timeoutMs: 20000,
    });
  }
  if (res.code !== 0) {
    return { error: maskSecrets((res.stderr || res.stdout || "git status 失败").trim()) };
  }
  const parsed = pruneExcludedUntracked(parseStatusPorcelain(res.stdout, res.stderr, gitVersion), state.settings);
  return {
    branch: parsed.branch,
    changed: uniquePaths(
      parsed.staged.concat(parsed.unstaged, parsed.untracked, parsed.conflicted),
    ).length,
    staged: parsed.staged.length,
    unstaged: parsed.unstaged.length,
    untracked: parsed.untracked.length,
    conflicted: parsed.conflicted.length,
    truncated: parsed.truncated,
    // 与完整 status 使用同一份路径签名，轮询据此判断是否需要重载文件列表。
    files: parsed.staged
      .concat(parsed.unstaged, parsed.untracked, parsed.conflicted)
      .map((entry) => (entry.staged ? "S:" : "W:") + entry.path)
      .sort(),
  };
}

/* ===== 15-parsers.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：所有 git 文本协议的解析（纯函数，便于回归验证）。
 * 以 porcelain v2 为主、v1 兜底；尽量使用 -z，路径不做任何反转义。
 * ------------------------------------------------------------------------- */

function makeEntry(path, origPath, x, y, extra) {
  const entry = {
    path,
    origPath: origPath || null,
    x: x || ".",
    y: y || ".",
    staged: Boolean(extra && extra.staged),
    unmerged: Boolean(extra && extra.unmerged),
    sub: (extra && extra.sub) || null,
  };
  entry.code = entry.unmerged ? "U" : entry.staged ? entry.x : entry.y;
  entry.key = entryKey(entry);
  return entry;
}

function emptyStatus() {
  return {
    branch: {
      head: "",
      oid: "",
      upstream: "",
      ahead: 0,
      behind: 0,
      detached: false,
      unborn: false,
      upstreamGone: false,
    },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    entries: [],
    truncated: false,
    format: "v2",
  };
}

/** 根据输出形状选择 v2 / v1 解析；两者都以 NUL 分隔记录。 */
function parseStatusPorcelain(raw, stderr, version) {
  const text = String(raw || "");
  const status = emptyStatus();
  // 字节数是宿主上限，字符数只在小输出上等价；末尾不是 NUL 说明记录被切断。
  status.truncated = outputTruncated(text) || (text.length > 0 && !text.endsWith("\0"));
  status.warnings = String(stderr || "").trim();
  const looksV1 = /^## /.test(text.replace(/^\uFEFF/, ""));
  const looksV2 = /(^|\0)# branch\.|(^|\0)[12u?] /.test(text);
  if (looksV1 && !looksV2) return parseStatusV1(text, status);
  return parseStatusV2(text, status);
}

function pushStatusEntry(status, entry) {
  status.entries.push(entry);
  if (entry.unmerged) status.conflicted.push(entry);
  else if (entry.code === "?") status.untracked.push(entry);
  else if (entry.staged) status.staged.push(entry);
  else status.unstaged.push(entry);
}

function parseStatusV2(text, status) {
  const tokens = text.split("\0");
  let index = 0;
  let sawAb = false;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) continue;
    if (token[0] === "#") {
      if (token.startsWith("# branch.ab ")) sawAb = true;
      parseStatusHeaderLine(token, status.branch);
      continue;
    }
    if (token[0] === "1") {
      const m = token.match(/^1 (..) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/);
      if (!m) continue;
      const x = m[1][0];
      const y = m[1][1];
      const path = m[8];
      if (CONFLICT_CODES.has(x + y)) {
        pushStatusEntry(status, makeEntry(path, null, x, y, { unmerged: true, sub: m[2] }));
      } else {
        if (x !== "." && x !== " ") {
          pushStatusEntry(status, makeEntry(path, null, x, y, { staged: true, sub: m[2] }));
        }
        if (y !== "." && y !== " ") {
          pushStatusEntry(status, makeEntry(path, null, x, y, { staged: false, sub: m[2] }));
        }
      }
      continue;
    }
    if (token[0] === "2") {
      const m = token.match(/^2 (..) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/);
      if (!m) continue;
      const x = m[1][0];
      const y = m[1][1];
      const path = m[9];
      const origPath = tokens[index] || "";
      index += 1;
      if (x !== "." && x !== " ") {
        pushStatusEntry(status, makeEntry(path, origPath, x, y, { staged: true, sub: m[2] }));
      }
      if (y !== "." && y !== " ") {
        pushStatusEntry(status, makeEntry(path, origPath, x, y, { staged: false, sub: m[2] }));
      }
      continue;
    }
    if (token[0] === "u") {
      const m = token.match(/^u (..) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/);
      if (!m) continue;
      pushStatusEntry(
        status,
        makeEntry(m[10], null, m[1][0], m[1][1], { unmerged: true, sub: m[2] }),
      );
      continue;
    }
    if (token[0] === "?") {
      const path = token.slice(2);
      pushStatusEntry(status, makeEntry(path, null, "?", "?", {}));
      continue;
    }
    if (token[0] === "!") continue; // ignored: 默认不展示
  }
  status.format = "v2";
  // porcelain v2 没有 v1 的 [gone] 标记：有上游却没有 branch.ab 即上游引用已不存在。
  if (status.branch.upstream && !sawAb) status.branch.upstreamGone = true;
  return status;
}

function parseStatusHeaderLine(token, branch) {
  const line = token.slice(1).trim();
  if (line.startsWith("branch.oid ")) {
    branch.oid = line.slice("branch.oid ".length).trim();
    branch.unborn = branch.oid === "(initial)";
  } else if (line.startsWith("branch.head ")) {
    const head = line.slice("branch.head ".length).trim();
    if (head === "(detached)") branch.detached = true;
    else branch.head = head;
  } else if (line.startsWith("branch.upstream ")) {
    branch.upstream = line.slice("branch.upstream ".length).trim();
  } else if (line.startsWith("branch.ab ")) {
    const m = line.match(/\+(\d+)\s+-(\d+)/);
    if (m) {
      branch.ahead = Number(m[1]);
      branch.behind = Number(m[2]);
    }
  }
}

function parseStatusV1(text, status) {
  const tokens = text.replace(/^\uFEFF/, "").split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith("## ")) {
      parseStatusV1Header(token.slice(3).trim(), status.branch);
      continue;
    }
    if (token.startsWith("?? ")) {
      pushStatusEntry(status, makeEntry(token.slice(3), null, "?", "?", {}));
      continue;
    }
    if (token.startsWith("!! ")) continue;
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    let origPath = null;
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      origPath = tokens[i + 1] || null;
      i += 1;
    }
    if (CONFLICT_CODES.has(xy)) {
      pushStatusEntry(status, makeEntry(path, origPath, xy[0], xy[1], { unmerged: true }));
      continue;
    }
    if (xy[0] !== " " && xy[0] !== ".") {
      pushStatusEntry(status, makeEntry(path, origPath, xy[0], xy[1], { staged: true }));
    }
    if (xy[1] !== " " && xy[1] !== ".") {
      pushStatusEntry(status, makeEntry(path, origPath, xy[0], xy[1], { staged: false }));
    }
  }
  status.format = "v1";
  return status;
}

function parseStatusV1Header(header, branch) {
  if (/^HEAD \(no branch\)/.test(header)) {
    branch.detached = true;
    return;
  }
  const initial = header.match(/^(?:Initial commit|No commits yet) on (.+)$/);
  if (initial) {
    branch.head = initial[1];
    branch.unborn = true;
    return;
  }
  const m = header.match(/^(.+?)(?:\.\.\.(\S+?))?(?: \[(.+)\])?$/);
  if (!m) {
    branch.head = header;
    return;
  }
  branch.head = m[1];
  branch.upstream = m[2] || "";
  const track = m[3] || "";
  const ahead = track.match(/ahead (\d+)/);
  const behind = track.match(/behind (\d+)/);
  if (ahead) branch.ahead = Number(ahead[1]);
  if (behind) branch.behind = Number(behind[1]);
  if (/gone/.test(track)) branch.upstreamGone = true;
}

/** 解析 log 的 \x1e 记录；字段用 \x1f 分隔。 */
function parseLog(raw) {
  const records = String(raw || "").split("\x1e");
  const commits = [];
  for (const record of records) {
    const text = record.replace(/^\s+/, "");
    if (!text) continue;
    const fields = text.split("\x1f");
    if (fields.length < 7) continue;
    // %D 里含逗号的分支名（如 feat,bug）不能按逗号切碎；只有以已知引用前缀开头的
    // token 才是新条目，其余 token 属于上一个名称。
    const refs = [];
    for (const token of String(fields[5] || "").split(", ")) {
      if (!token) continue;
      if (!refs.length || /^(HEAD -> |tag: |refs\/)/.test(token)) refs.push(token);
      else refs[refs.length - 1] += ", " + token;
    }
    const branches = [];
    const tags = [];
    const remotes = [];
    let head = false;
    for (const ref of refs) {
      if (ref.startsWith("HEAD -> ")) {
        head = true;
        const name = ref.slice("HEAD -> ".length).replace(/^refs\/heads\//, "");
        if (name && name !== "HEAD") branches.push(name);
      } else if (ref === "HEAD") {
        head = true;
      } else if (ref.startsWith("tag: ")) {
        tags.push(ref.slice(5).replace(/^refs\/tags\//, ""));
      } else if (ref.startsWith("refs/heads/")) {
        branches.push(ref.slice("refs/heads/".length));
      } else if (ref.startsWith("refs/remotes/")) {
        const name = ref.slice("refs/remotes/".length);
        if (!/\/HEAD(?: -> .*)?$/.test(name)) remotes.push(name);
      } else if (ref.startsWith("refs/tags/")) {
        tags.push(ref.slice("refs/tags/".length));
      } else if (!ref.startsWith("refs/")) {
        branches.push(ref);
      }
    }
    commits.push({
      hash: fields[0].trim(),
      parents: String(fields[1] || "").trim() ? String(fields[1]).trim().split(" ") : [],
      author: fields[2] || "",
      email: fields[3] || "",
      at: parseEpoch(fields[4]),
      refs: Array.from(new Set(refs)),
      branches: Array.from(new Set(branches)),
      tags: Array.from(new Set(tags)),
      remotes: Array.from(new Set(remotes)),
      head,
      subject: fields[6] || "",
    });
  }
  return commits;
}

function parseTrack(track) {
  const out = { ahead: 0, behind: 0, gone: false };
  const text = String(track || "");
  if (/gone/.test(text)) out.gone = true;
  const ahead = text.match(/ahead (\d+)/);
  const behind = text.match(/behind (\d+)/);
  if (ahead) out.ahead = Number(ahead[1]);
  if (behind) out.behind = Number(behind[1]);
  return out;
}

function parseBranches(raw) {
  const locals = [];
  const remotes = [];
  for (const line of splitLines(raw)) {
    if (!line.trim()) continue;
    const f = line.split("\0");
    if (f.length < 8) continue;
    const refname = f[0];
    const track = parseTrack(f[4]);
    const item = {
      name: refname.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, ""),
      refname,
      hash: f[1] || "",
      shortHash: f[2] || shortHash(f[1]),
      upstream: f[3] || "",
      ahead: track.ahead,
      behind: track.behind,
      upstreamGone: track.gone,
      at: parseEpoch(f[5]),
      author: f[6] || "",
      subject: f[7] || "",
      kind: refname.startsWith("refs/remotes/") ? "remote" : "local",
    };
    if (item.kind === "remote") {
      if (/\/HEAD$/.test(refname)) continue;
      const rest = refname.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      item.remote = slash >= 0 ? rest.slice(0, slash) : rest;
      item.name = slash >= 0 ? rest.slice(slash + 1) : rest;
      remotes.push(item);
    } else {
      locals.push(item);
    }
  }
  locals.sort((a, b) => (b.at || 0) - (a.at || 0));
  remotes.sort((a, b) => a.name.localeCompare(b.name));
  return { locals, remotes };
}

function parseTags(raw) {
  const tags = [];
  for (const line of splitLines(raw)) {
    if (!line.trim()) continue;
    const f = line.split("\0");
    if (f.length < 7) continue;
    tags.push({
      name: f[0],
      hash: f[1] || "",
      type: f[2] || "commit",
      tagger: f[3] || "",
      at: parseEpoch(f[4]),
      subject: f[5] || "",
      target: f[6] || shortHash(f[1]),
      annotated: (f[2] || "") === "tag",
    });
  }
  tags.sort((a, b) => (b.at || 0) - (a.at || 0));
  return tags;
}

function parseStashes(raw) {
  const stashes = [];
  for (const line of splitLines(raw)) {
    if (!line.trim()) continue;
    const f = line.split("\x1f");
    if (f.length < 4) continue;
    stashes.push({
      selector: f[0],
      hash: f[1] || "",
      at: parseEpoch(f[2]),
      subject: f[3] || "",
      branch: (f[3] || "").match(/^(?:WIP on|On) ([^:]+)/)
        ? (f[3] || "").match(/^(?:WIP on|On) ([^:]+)/)[1]
        : "",
    });
  }
  return stashes;
}

function parseRemotes(raw) {
  const byName = new Map();
  for (const line of splitLines(raw)) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)\s*$/);
    if (!m) continue;
    const name = m[1];
    const item = byName.get(name) || { name, fetchUrl: "", pushUrl: "", fetchUrlRaw: "", pushUrlRaw: "" };
    if (m[3] === "fetch") {
      item.fetchUrlRaw = m[2];
      item.fetchUrl = maskSecrets(m[2]);
    } else {
      item.pushUrlRaw = m[2];
      item.pushUrl = maskSecrets(m[2]);
    }
    byName.set(name, item);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function parseWorktrees(raw) {
  const blocks = String(raw || "").split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const item = { path: "", head: "", branch: "", bare: false, detached: false, locked: "", prunable: false };
    for (const line of splitLines(block)) {
      if (line.startsWith("worktree ")) item.path = normalizePath(line.slice(9));
      else if (line.startsWith("HEAD ")) item.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) item.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") item.bare = true;
      else if (line === "detached") item.detached = true;
      else if (line.startsWith("locked")) item.locked = line.slice(6).trim() || "locked";
      else if (line.startsWith("prunable")) item.prunable = true;
    }
    if (item.path) out.push(item);
  }
  return out;
}

/**
 * git submodule status 的括号描述。路径本身也可能带空格和括号（如 `lib (old)`），
 * 只有括号内容符合 describe 形态时才当作描述，否则整段仍是路径。
 */
function looksLikeSubmoduleDescribe(value) {
  const text = String(value || "").trim();
  if (!text || /[\s()]/.test(text)) return false;
  return (
    /^[0-9a-f]{7,}(-dirty)?$/.test(text) ||
    /^.+-[0-9]+-g[0-9a-f]+(-dirty)?$/.test(text) ||
    /^(heads|tags|remotes)\/.+$/.test(text) ||
    /^[A-Za-z0-9._\/+-]+$/.test(text)
  );
}

function parseSubmodules(raw) {
  const out = [];
  for (const line of splitLines(raw)) {
    if (!line.trim()) continue;
    const m = line.match(/^([ +\-U])([0-9a-fA-F]+) (.*)$/);
    if (!m) continue;
    let rest = m[3];
    let describe = "";
    const noted = rest.match(/^(.*) \(([^()]*)\)$/);
    if (noted && looksLikeSubmoduleDescribe(noted[2])) {
      rest = noted[1];
      describe = noted[2];
    }
    const path = rest.trim();
    if (!path) continue;
    out.push({
      flag: m[1],
      hash: m[2],
      path,
      describe,
      tone: m[1] === "U" ? "conflict" : m[1] === "-" ? "missing" : m[1] === "+" ? "dirty" : "ok",
    });
  }
  return out;
}

/** `.gitmodules` 缺映射导致 `git submodule status` 直接 fatal 时的兜底：
 *  从索引里 mode 160000 的 gitlink 重建列表（这些路径本质仍是子模块）。 */
function parseGitlinks(raw) {
  const out = [];
  for (const line of splitLines(raw)) {
    const m = line.match(/^160000 ([0-9a-fA-F]+) \d+\t(.+)$/);
    if (!m) continue;
    const path = m[2].trim();
    if (!path) continue;
    out.push({
      flag: "?",
      hash: m[1],
      path,
      describe: "索引中的子模块，未在 .gitmodules 登记",
      tone: "unknown",
    });
  }
  return out;
}

function decodeGitPath(raw) {
  const value = String(raw || "").trim();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseGitDiffPath(raw) {
  const path = decodeGitPath(raw);
  return path === null ? null : path.replace(/^[ab]\//, "");
}

/** 从 diff --git 头里取新旧路径；优先处理带引号形式，其次按 " b/" 切分。 */
function gitDiffHeaderPaths(header) {
  const rest = String(header || "").replace(/^diff --git /, "");
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) {
    return {
      oldPath: (decodeGitPath(quoted[1]) || "").replace(/^a\//, "") || null,
      newPath: (decodeGitPath(quoted[2]) || "").replace(/^b\//, "") || null,
    };
  }
  const split = rest.lastIndexOf(" b/");
  if (split > 0) {
    return {
      oldPath: parseGitDiffPath(rest.slice(0, split)),
      newPath: parseGitDiffPath(rest.slice(split + 1)),
    };
  }
  return { oldPath: null, newPath: null };
}

/** 解析统一 diff；返回每个文件的 hunk / 行号，供渲染与按 hunk 暂存。 */
function parseUnifiedDiff(raw) {
  const text = String(raw || "");
  // 不能走 splitLines：它会把 CRLF 归一成 LF，重建补丁时丢掉正文里的 \r。
  const lines = text.split("\n");
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const finishFile = () => {
    if (!file) return;
    if (!file.oldPath && !file.newPath) {
      const paths = gitDiffHeaderPaths(file.header);
      file.oldPath = paths.oldPath;
      file.newPath = paths.newPath;
    }
    file.name = file.newPath || file.oldPath || "";
    files.push(file);
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      finishFile();
      file = {
        header: line,
        oldPath: null,
        newPath: null,
        name: "",
        binary: false,
        hunks: [],
        meta: [],
        adds: 0,
        dels: 0,
        isNew: false,
        isDeleted: false,
        isRename: false,
        oldLine: "",
        newLine: "",
      };
      hunk = null;
      continue;
    }
    if (!file && line.startsWith("--- ")) {
      // 标准 unified diff（diff -u / diff -ruN）没有 diff --git 头：从 ---/+++ 起一条记录，
      // 否则 applyPatch 的“与已暂存内容重叠”保护拿不到受影响路径。
      file = {
        header: "",
        oldPath: null,
        newPath: null,
        name: "",
        binary: false,
        hunks: [],
        meta: [],
        adds: 0,
        dels: 0,
        isNew: false,
        isDeleted: false,
        isRename: false,
        oldLine: "",
        newLine: "",
      };
      hunk = null;
      file.oldLine = line;
      file.oldPath = parseGitDiffPath(line.slice(4));
      continue;
    }
    if (!file) continue;
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (!m) {
        file.meta.push(line);
        hunk = null;
        continue;
      }
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      hunk = {
        header: line,
        oldStart: oldNo,
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: newNo,
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] || "",
        lines: [],
        addCount: 0,
        delCount: 0,
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk && line.startsWith("--- ")) {
      file.oldLine = line;
      file.oldPath = parseGitDiffPath(line.slice(4));
      continue;
    }
    if (!hunk && line.startsWith("+++ ")) {
      file.newLine = line;
      file.newPath = parseGitDiffPath(line.slice(4));
      continue;
    }
    if (!hunk) {
      if (line.startsWith("new file mode")) file.isNew = true;
      else if (line.startsWith("deleted file mode")) file.isDeleted = true;
      else if (line.startsWith("rename from ") || line.startsWith("rename to ")) file.isRename = true;
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
      if (line) file.meta.push(line);
      continue;
    }
    if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "note", text: line, oldNo: null, newNo: null });
      continue;
    }
    const prefix = line[0];
    const content = rawLine.slice(1);
    if (prefix === "+") {
      hunk.lines.push({ kind: "add", text: content, oldNo: null, newNo });
      newNo += 1;
      hunk.addCount += 1;
      file.adds += 1;
    } else if (prefix === "-") {
      hunk.lines.push({ kind: "del", text: content, oldNo, newNo: null });
      oldNo += 1;
      hunk.delCount += 1;
      file.dels += 1;
    } else if (prefix === " ") {
      hunk.lines.push({ kind: "ctx", text: content, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else if (line === "") {
      // splitLines 在末尾换行后产生的空串不是 diff 正文；真正的空行带一个空格前缀。
      // 计入 hunk 会让 patch 头行数多 1，git apply 直接失败。
      continue;
    } else {
      hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    }
  }
  finishFile();
  return files;
}

/** name-status -z 输出：状态、路径（重命名再跟一个旧路径）。 */
function parseNameStatusZ(raw) {
  const tokens = String(raw || "").split("\0");
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!status) continue;
    const code = status[0];
    let path = tokens[i + 1] || "";
    i += 1;
    if (!path) continue;
    if (code === "R" || code === "C") {
      // -z 的 name-status：R100\0<old>\0<new>\0
      const origPath = path;
      path = tokens[i + 1] || "";
      i += 1;
      out.push({ code, status, path, origPath });
    } else {
      out.push({ code, status, path, origPath: null });
    }
  }
  return out;
}

/** git blame --line-porcelain。返回按最终行号索引的数组。 */
function parseBlamePorcelain(raw) {
  const lines = splitLines(raw);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/);
    if (head) {
      cur = {
        sha: head[1],
        finalLine: Number(head[3]),
        author: "",
        time: 0,
        summary: "",
        filename: "",
        text: "",
      };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\t")) {
      cur.text = line.slice(1);
      out[cur.finalLine] = cur;
      cur = null;
      continue;
    }
    if (line.startsWith("author ")) cur.author = line.slice(7);
    else if (line.startsWith("author-time ")) cur.time = parseEpoch(line.slice(12));
    else if (line.startsWith("summary ")) cur.summary = line.slice(8);
    else if (line.startsWith("filename ")) cur.filename = line.slice(9);
  }
  return out;
}

/** 文件树：目录在前，文件按名称排序。 */
function buildFileTree(entries) {
  const root = { type: "dir", name: "", path: "", children: new Map() };
  for (const entry of entries || []) {
    const parts = String(entry.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    let path = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      path = path ? path + "/" + part : part;
      const last = i === parts.length - 1;
      if (last) {
        const key = "f:" + path;
        if (!node.children.has(key)) {
          node.children.set(key, { type: "file", name: part, path, entries: [] });
        }
        node.children.get(key).entries.push(entry);
      } else {
        const key = "d:" + path;
        if (!node.children.has(key)) {
          node.children.set(key, { type: "dir", name: part, path, children: new Map() });
        }
        node = node.children.get(key);
      }
    }
  }
  const convert = (node) => {
    const children = Array.from(node.children.values()).map((child) => {
      if (child.type === "dir") return convert(child);
      return Object.assign({}, child, { entry: child.entries[0] });
    });
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
    return { type: node.type, name: node.name, path: node.path, children };
  };
  return convert(root).children;
}

/** 合并单链目录：目录下仅一个子目录且无文件时，与子目录并成一行（如 src/main/java）。 */
function buildCompactFileTree(entries) {
  const collapse = (nodes) =>
    (nodes || []).map((node) => {
      if (node.type !== "dir") return node;
      const children = collapse(node.children);
      if (children.length === 1 && children[0].type === "dir") {
        const child = children[0];
        return { type: "dir", name: node.name + "/" + child.name, path: child.path, children: child.children };
      }
      return { type: "dir", name: node.name, path: node.path, children };
    });
  return collapse(buildFileTree(entries));
}

/** 目录树的默认展开集合：所有目录都展开。 */
function allDirPaths(nodes, out) {
  const acc = out || new Set();
  for (const node of nodes || []) {
    if (node.type === "dir") {
      acc.add(node.path);
      allDirPaths(node.children, acc);
    }
  }
  return acc;
}

/* ===== 20-store.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：全局状态、设置持久化、仓库数据加载、轮询、toast / 对话框。
 * 组件通过 useStoreSnapshot() 订阅；写操作统一走 enqueue() 串行化。
 * ------------------------------------------------------------------------- */

const state = {
  rev: 0,
  ready: false,
  settingsLoadFailed: false,
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
  repoDataOrder: [],
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

/** 常驻内存的仓库数据上限；超出后淘汰最久未访问、且不属于当前工作区的仓库。 */
const REPO_DATA_MAX = 24;
/** 持久化的仓库发现缓存上限；切换过多工作区时保留最近使用的若干个。 */
const REPO_CACHE_MAX_WORKSPACES = 8;

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
  touchRepoData(key);
  return state.repoData[key];
}

function touchRepoData(key) {
  const order = state.repoDataOrder;
  if (order[order.length - 1] === key) return;
  const at = order.indexOf(key);
  if (at >= 0) order.splice(at, 1);
  order.push(key);
  if (order.length <= REPO_DATA_MAX) return;
  const active = state.activeRepo ? pathKey(state.activeRepo) : "";
  const live = new Set((state.repos || []).map((item) => pathKey(item.path)));
  for (let index = 0; index < order.length && order.length > REPO_DATA_MAX; ) {
    const old = order[index];
    if (old === key || old === active || live.has(old)) {
      index += 1;
      continue;
    }
    delete state.repoData[old];
    delete state.checkedByRepo[old];
    order.splice(index, 1);
  }
}

/** 仓库发现缓存只保留最近使用的若干个工作区，避免持久化体积无限增长。 */
function trimRepoCache() {
  const keys = Object.keys(state.repoCache);
  if (keys.length <= REPO_CACHE_MAX_WORKSPACES) return;
  keys.sort((a, b) => (state.repoCache[b].at || 0) - (state.repoCache[a].at || 0));
  for (const key of keys.slice(REPO_CACHE_MAX_WORKSPACES)) delete state.repoCache[key];
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
    // 读不到旧设置时默认值不可信，后续保存会把默认值写回去覆盖用户配置。
    state.settingsLoadFailed = true;
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
      trimRepoCache();
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
  if (state.settingsLoadFailed) {
    toast("设置读取失败，已阻止覆盖；请重启插件后重试。", "error");
    return;
  }
  state.settings = Object.assign({}, state.settings, patch || {});
  if (patch && Object.prototype.hasOwnProperty.call(patch, "signOff")) state.commitSignOff = Boolean(patch.signOff);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "skipHooks")) state.commitSkipHooks = Boolean(patch.skipHooks);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "noGpgSign")) state.commitNoGpg = Boolean(patch.noGpgSign);
  notify();
  if (patch && Object.prototype.hasOwnProperty.call(patch, "scanExclude")) {
    // 排除名单参与未跟踪过滤，改变后立即重载当前工作区仓库，避免旧列表残留。
    // 仓库根可能在工作区之上（工作区是上级仓库的子目录），两个方向都要覆盖。
    const ws = state.workspacePath;
    if (ws) {
      for (const repo of state.repos) {
        if (isSubPath(ws, repo.path) || isSubPath(repo.path, ws)) {
          void loadRepoStatus(repo.path, true);
        }
      }
    }
  }
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

function formatError(error, prefix) {
  const message = safeError(error);
  const hint = networkHintFor(message);
  // 提示放尾部，但先把原始错误收窄，避免随后的 600 字截断把它吃掉。
  const body = hint ? truncate(message, 360) + hint : message;
  return (prefix ? prefix + "：" : "") + body;
}

function reportError(error, prefix) {
  const text = formatError(error, prefix);
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
  trimRepoCache();
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
    notify();
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
        ["-c", "status.aheadBehind=true", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        { allowFailure: true, timeoutMs: 30000 },
      );
      let parsed;
      if (res.code === 0) {
        parsed = pruneExcludedUntracked(parseStatusPorcelain(res.stdout, res.stderr, gitVersion), state.settings);
      } else if (/unknown option|not a git repository|fatal: bad revision/i.test(res.stderr || "")) {
        const fallback = await runGit(
          key,
          ["status", "--porcelain", "--branch", "-z", "--untracked-files=all"],
          { allowFailure: true, timeoutMs: 30000 },
        );
        if (fallback.code !== 0) {
          throw new GitCommandError((fallback.stderr || fallback.stdout || "").trim(), fallback.entry);
        }
        parsed = pruneExcludedUntracked(parseStatusPorcelain(fallback.stdout, fallback.stderr, gitVersion), state.settings);
      } else {
        throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      }
      if (data.statusRequest !== request) {
        if (invalidate) data.statusInvalidate = true;
        return;
      }
      const signature = computeStatusSignature(parsed);
      const changed = invalidate || signature !== data.statusSignature || parsed.warnings !== (data.status.warnings || "");
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
      return changed;
    } catch (error) {
      if (invalidate) data.statusInvalidate = true;
      if (data.statusRequest !== request) return false;
      data.loading.status = false;
      data.error = safeError(error);
      notify();
      return false;
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

/** 宿主按字节截断单流输出；多字节文本的字符数会低估实际字节数。 */
function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function outputTruncated(text) {
  const value = String(text || "");
  if (!value) return false;
  if (value.length >= GIT_MAX_OUTPUT - 64) return true;
  return utf8ByteLength(value) >= GIT_MAX_OUTPUT - 64;
}

/**
 * 普通行记录输出触达 64KB 上限时，最后一行可能被切断：丢弃最后一个换行之后的残片。
 * 仅按长度判定，不要求末尾换行——否则正常输出会被误裁。
 */
function clipTruncatedLines(stdout) {
  const text = String(stdout || "");
  if (!outputTruncated(text)) return { text, truncated: false };
  const cut = text.lastIndexOf("\n");
  return { text: cut >= 0 ? text.slice(0, cut) : "", truncated: true };
}

/**
 * git log 用 %x1e 分隔记录；输出触达上限或末尾缺分隔符时最后一条可能被切断。
 * 与 clipTruncatedLines 分开：普通命令（for-each-ref 等）不以 %x1e 结尾。
 */
function clipLogRecords(stdout) {
  const text = String(stdout || "");
  const nearLimit = outputTruncated(text);
  const complete = !text.length || text.endsWith("\x1e");
  if (!nearLimit && complete) return { text, truncated: false };
  const cut = text.lastIndexOf("\x1e");
  return { text: cut >= 0 ? text.slice(0, cut + 1) : "", truncated: true };
}

function syncCheckedFiles(repo, status) {
  const existing = state.checkedByRepo[repo] || {};
  const next = {};
  const entries = status.staged.concat(status.unstaged, status.untracked, status.conflicted);
  for (const entry of entries) {
    const key = entryKey(entry);
    // 暂存/取消暂存会让同一路径在 s:/u: 之间换键；继承旧键的决定，
    // 否则用户取消过的文件会在状态变化后重新变成已勾选，静默放大提交范围。
    const alternateKey = (entry.staged ? "u:" : "s:") + entry.path;
    if (existing[key] !== undefined) next[key] = existing[key];
    else if (existing[alternateKey] !== undefined) next[key] = existing[alternateKey];
    else next[key] = true;
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
  let operationsError = null;
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
      } else {
        operationsError = "无法识别进行中的 Git 操作检测结果";
      }
    } catch (error) {
      // 检测失败时保持全部 false；后续操作会由 git 自身报错，但界面要提示检测不可用。
      operationsError = safeError(error);
    }
  }
  data.operations = operations;
  data.operationsError = operationsError;
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
        safe(async () => {
          try {
            return await refs(["submodule", "status", "--recursive"], 20000, parseSubmodules);
          } catch (error) {
            // 索引里有 gitlink 而 .gitmodules 缺映射时 git 退出码 128；
            // 这不是读取失败，用索引重建子模块列表即可。
            if (!/no submodule mapping found/i.test(safeError(error))) throw error;
            return await refs(["ls-files", "--stage"], 20000, parseGitlinks);
          }
        }, [], "submodules"),
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
      const clipped = clipLogRecords(res.stdout);
      const commits = parseLog(clipped.text);
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
      view.hasMore = commits.length >= pageSize || clipped.truncated;
      view.loading = false;
      view.error = null;
      view.truncated = clipped.truncated;
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
    void pollWorkspace().catch(() => undefined);
  }, interval);
  void pollWorkspace().catch(() => undefined);
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
    if (disposed) return;
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
  const changed = await loadRepoStatus(repo, true);
  // 状态签名未变（外部反复编辑同一路径）时，status 不会推进代际，
  // 这里静默重取选中文件的差异，内容真变了才替换，避免每轮轮询重置区块选择。
  if (changed === false) refreshSelectedDiff(repo);
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

/* ===== 25-actions-core.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：写操作（暂存/提交/丢弃/差异/按 hunk 应用/忽略/补丁/初始化/克隆）。
 * 所有写操作经 enqueue() 串行执行，完成后强制刷新状态。
 * ------------------------------------------------------------------------- */

async function refreshRepo(repo, options) {
  const opts = options || {};
  // 主动刷新一律视为内容变化：让 statusGeneration 递增，差异缓存随之失效。
  // 否则文件内容变了但状态码没变（已修改文件再次编辑）时，预览不会重载。
  ensureRepoData(repo).statusInvalidate = true;
  // 只要侧栏指示（分支与更改计数）时走轻量 status，避免为每个仓库拉完整 diff 状态。
  if (opts.quick && !opts.details && !opts.log) {
    await loadQuickStatusFor(repo);
    return;
  }
  // loadRepoStatus 成功后会同步 data.quick（分支与计数），无需再单独拉一次 quick。
  await loadRepoStatus(repo, true);
  if (opts.details) await loadRepoDetails(repo, true);
  if (opts.log) await loadLog(repo, true);
}

/**
 * 统一写操作入口：busy 提示 + 串行 + 错误 toast + 刷新。
 * 返回 {ok:true,value} / {ok:false,error}，调用方无需 try/catch。
 */
async function perform(repo, label, task, options) {
  const opts = options || {};
  return enqueue(() =>
    withBusy(label, async () => {
      try {
        const value = await task();
        if (opts.refresh !== false) {
          await refreshRepo(repo, opts);
        }
        if (opts.success && !(value && value.canceled)) toast(opts.success, "success");
        return { ok: true, value };
      } catch (error) {
        // silentError：调用方会自行决定是否提示（例如推送被拒后自动拉取重试）。
        const text = opts.silentError ? formatError(error, opts.errorPrefix || label) : reportError(error, opts.errorPrefix || label);
        // 部分失败发生在状态已改动之后（钩子拒绝提交、--3way 留下冲突标记等）；
        // 失败也刷新一次，避免界面与索引/工作区脱节。
        if (repo) await refreshRepo(repo, { details: true }).catch(() => undefined);
        return { ok: false, error, text };
      }
    }),
  );
}

function checkedKeys(repo) {
  const checked = state.checkedByRepo[repo] || {};
  return Object.keys(checked).filter((key) => checked[key]);
}

function checkedPaths(repo) {
  const seen = new Set();
  const paths = [];
  for (const key of checkedKeys(repo)) {
    const path = key.slice(key.indexOf(":") + 1);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function toggleChecked(repo, entry) {
  const key = entryKey(entry);
  const checked = Object.assign({}, state.checkedByRepo[repo] || {});
  checked[key] = !checked[key];
  state.checkedByRepo[repo] = checked;
  notify();
}

function setAllChecked(repo, value) {
  const data = ensureRepoData(repo);
  const checked = {};
  const entries = data.status.staged.concat(data.status.unstaged, data.status.untracked, data.status.conflicted);
  for (const entry of entries) checked[entryKey(entry)] = Boolean(value);
  state.checkedByRepo[repo] = checked;
  notify();
}

/** 批量设置勾选：目录行的全选/全不选。 */
function setCheckedMany(repo, entries, value) {
  const checked = Object.assign({}, state.checkedByRepo[repo] || {});
  for (const entry of entries || []) checked[entryKey(entry)] = Boolean(value);
  state.checkedByRepo[repo] = checked;
  notify();
}

function selectFile(repo, entry, mode) {
  if (!entry) {
    state.selectedFile = null;
    notify();
    return;
  }
  state.selectedFile = { repo, path: entry.path, staged: Boolean(entry.staged) };
  if (mode) state.diffMode = mode;
  notify();
  void ensureFileDiff(repo, entry, mode || state.diffMode);
}

function selectedEntry() {
  const selection = state.selectedFile;
  if (!selection) return null;
  const data = ensureRepoData(selection.repo);
  const entries = data.status.staged.concat(
    data.status.unstaged,
    data.status.untracked,
    data.status.conflicted,
  );
  return (
    entries.find(
      (entry) => entry.path === selection.path && Boolean(entry.staged) === Boolean(selection.staged),
    ) ||
    entries.find((entry) => entry.path === selection.path) ||
    null
  );
}

async function stagePaths(repo, paths, options) {
  const list = Array.from(new Set((paths || []).filter(Boolean)));
  if (!list.length) return;
  await runGit(repo, ["add", "-A", "--"].concat(list), { timeoutMs: 60000 });
  if (!(options && options.silent)) toast("已暂存 " + list.length + " 个文件", "success");
}

function expandRenamePaths(repo, paths) {
  const data = ensureRepoData(repo);
  const selected = new Set(paths || []);
  const out = Array.from(selected);
  for (const entry of data.status.staged.concat(data.status.unstaged)) {
    if (entry.origPath && selected.has(entry.path) && (entry.x === "R" || entry.x === "C" || entry.y === "R" || entry.y === "C")) {
      out.push(entry.origPath);
    }
  }
  return Array.from(new Set(out.filter(Boolean)));
}

async function unstagePaths(repo, paths, options) {
  const list = expandRenamePaths(repo, (paths || []).filter(Boolean));
  if (!list.length) return;
  const conflicted = new Set(ensureRepoData(repo).status.conflicted.map((entry) => entry.path));
  if (list.some((path) => conflicted.has(path))) {
    throw new Error("冲突文件不能直接取消暂存，请先解决冲突");
  }
  const res = await runGit(repo, ["reset", "-q", "HEAD", "--"].concat(list), {
    allowFailure: true,
    timeoutMs: 30000,
  });
  if (res.code !== 0) {
    if (await hasHeadCommit(repo)) {
      throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    }
    const fallback = await runGit(repo, ["rm", "-r", "--cached", "--quiet", "--"].concat(list), {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (fallback.code !== 0) throw new GitCommandError((fallback.stderr || "").trim(), fallback.entry);
  }
  if (!(options && options.silent)) toast("已取消暂存 " + list.length + " 个文件", "success");
}

function stageEntryPaths(entries, repo) {
  const out = [];
  const stagedRenamePaths = new Set(
    ((repo && ensureRepoData(repo).status.staged) || [])
      .filter((entry) => entry.origPath && (entry.x === "R" || entry.x === "C"))
      .map((entry) => entry.path),
  );
  for (const entry of entries || []) {
    if (!entry) continue;
    if (entry.path) out.push(entry.path);
    // 已暂存重命名/复制的旧路径已经不在索引里，再 git add 旧路径会报 pathspec 不存在。
    if (entry.origPath && !entry.staged && !stagedRenamePaths.has(entry.path)) out.push(entry.origPath);
  }
  return Array.from(new Set(out.filter(Boolean)));
}

async function stageEntries(repo, entries) {
  const paths = stageEntryPaths(entries, repo);
  if (!paths.length) return { ok: true };
  return perform(repo, "暂存文件", () => stagePaths(repo, paths, { silent: true }), {
    success: "已暂存 " + uniquePaths(entries || []).length + " 个文件",
  });
}

async function unstageEntries(repo, entries) {
  const paths = uniquePaths(entries || []);
  if (!paths.length) return { ok: true };
  return perform(repo, "取消暂存", () => unstagePaths(repo, paths, { silent: true }), {
    success: "已取消暂存 " + paths.length + " 个文件",
  });
}

async function stageAll(repo) {
  const data = ensureRepoData(repo);
  const paths = stageEntryPaths(data.status.unstaged.concat(data.status.untracked), repo);
  if (!paths.length) return { ok: true };
  return perform(repo, "暂存全部更改", () => stagePaths(repo, paths, { silent: true }), {
    success: "已暂存全部更改",
  });
}

async function unstageAll(repo) {
  return perform(repo, "取消暂存全部", async () => {
    if (ensureRepoData(repo).status.conflicted.length) {
      throw new Error("存在未解决冲突，不能取消暂存全部");
    }
    const res = await runGit(repo, ["reset", "-q", "HEAD"], { allowFailure: true });
    if (res.code !== 0) {
      if (await hasHeadCommit(repo)) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      const fallback = await runGit(repo, ["rm", "-r", "--cached", "--quiet", "."], {
        allowFailure: true,
      });
      if (fallback.code !== 0) throw new GitCommandError((fallback.stderr || "").trim(), fallback.entry);
    }
  }, { success: "已取消暂存全部更改" });
}

async function discardPaths(repo, entries) {
  const list = entries && entries.length ? entries : [];
  if (!list.length) return { ok: true };
  const names = list.map((entry) => entry.path);
  const data = ensureRepoData(repo);
  const untrackedOnly = list.every((entry) => entry.code === "?" && !entry.staged);
  const addedOnly =
    !untrackedOnly &&
    list.every(
      (entry) =>
        entry.staged &&
        entry.x === "A" &&
        !data.status.unstaged.some((item) => item.path === entry.path),
    );
  const deleteOnly = untrackedOnly || addedOnly;
  const confirmed = await confirmDestructive({
    title: deleteOnly ? "删除未提交文件" : "回滚更改",
    message: deleteOnly
      ? "将永久删除 " + names.length + " 个从未提交的文件，且无法从 Git 恢复。"
      : "将丢弃 " + names.length + " 个文件的本地更改，且不可恢复。",
    detail: names.slice(0, 12).join("\n") + (names.length > 12 ? "\n…" : ""),
    confirmLabel: deleteOnly ? "删除" : "回滚",
    danger: true,
  });
  if (!confirmed) return { ok: false, canceled: true };
  return perform(repo, deleteOnly ? "删除未提交文件" : "回滚更改", async () => {
    const untracked = [];
    const added = [];
    const restoreFromIndex = [];
    const restoreFromHead = [];
    const resetStagedOnly = [];
    const handled = new Set();
    const fullStatus = ensureRepoData(repo).status;
    const allEntries = fullStatus.staged.concat(
      fullStatus.unstaged,
      fullStatus.untracked,
      fullStatus.conflicted,
    );
    const renameByPath = new Map();
    const worktreeRenameByPath = new Map();
    for (const entry of allEntries) {
      if (entry.staged && entry.origPath && (entry.x === "R" || entry.x === "C")) {
        renameByPath.set(entry.path, entry);
      } else if (!entry.staged && entry.origPath && (entry.y === "R" || entry.y === "C")) {
        worktreeRenameByPath.set(entry.path, entry);
      }
    }
    const renames = [];
    for (const entry of list) {
      if (!entry.staged) continue;
      const rename = renameByPath.get(entry.path);
      if (rename && !renames.includes(rename)) renames.push(rename);
    }
    for (const entry of renames) {
      handled.add(entry.path);
      const resetArgs =
        entry.x === "R"
          ? ["reset", "-q", "HEAD", "--", entry.origPath, entry.path]
          : ["reset", "-q", "HEAD", "--", entry.path];
      const reset = await runGit(repo, resetArgs, { allowFailure: true });
      if (reset.code !== 0) throw new GitCommandError((reset.stderr || reset.stdout || "").trim(), reset.entry);
      if (entry.x === "R") {
        const restored = await runGit(repo, ["checkout", "--", entry.origPath], {
          allowFailure: true,
          timeoutMs: 60000,
        });
        if (restored.code !== 0) {
          throw new GitCommandError((restored.stderr || "").trim(), restored.entry);
        }
      }
      untracked.push(entry.path);
    }
    for (const entry of list) {
      if (handled.has(entry.path)) continue;
      const worktreeRename = worktreeRenameByPath.get(entry.path);
      if (worktreeRename && !entry.staged) {
        if (worktreeRename.y === "R") {
          // 只回滚工作区：从索引恢复原路径，再删掉新路径。
          const restored = await runGit(repo, ["checkout", "--", worktreeRename.origPath], {
            allowFailure: true,
            timeoutMs: 60000,
          });
          if (restored.code !== 0) throw new GitCommandError((restored.stderr || "").trim(), restored.entry);
        }
        untracked.push(entry.path);
        continue;
      }
      if (entry.code === "?" || (entry.staged && entry.x === "A")) {
        const hasUnstagedSamePath = fullStatus.unstaged.some((item) => item.path === entry.path);
        if (entry.staged && hasUnstagedSamePath) resetStagedOnly.push(entry.path);
        else if (entry.staged) added.push(entry.path);
        else untracked.push(entry.path);
      } else if (entry.staged) {
        // `checkout HEAD --` 会同时覆盖工作区；同文件还有未暂存改动时必须只重置索引。
        if (fullStatus.unstaged.some((item) => item.path === entry.path)) resetStagedOnly.push(entry.path);
        else restoreFromHead.push(entry.path);
      } else {
        // 未暂存改动只回滚到索引版本；若同一文件还有已暂存内容，不能连带清掉。
        restoreFromIndex.push(entry.path);
      }
    }
    if (added.length) {
      let reset = await runGit(repo, ["reset", "-q", "HEAD", "--"].concat(added), { allowFailure: true });
      if (reset.code !== 0 && !(await hasHeadCommit(repo))) {
        reset = await runGit(repo, ["rm", "-r", "--cached", "--quiet", "--"].concat(added), { allowFailure: true });
      }
      if (reset.code !== 0) throw new GitCommandError((reset.stderr || reset.stdout || "").trim(), reset.entry);
      untracked.push.apply(untracked, added);
    }
    if (restoreFromIndex.length) {
      const res = await runGit(repo, ["checkout", "--"].concat(restoreFromIndex), {
        allowFailure: true,
        timeoutMs: 60000,
      });
      if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    }
    if (resetStagedOnly.length) {
      let reset = await runGit(repo, ["reset", "-q", "HEAD", "--"].concat(resetStagedOnly), { allowFailure: true });
      if (reset.code !== 0 && !(await hasHeadCommit(repo))) {
        reset = await runGit(repo, ["rm", "-r", "--cached", "--quiet", "--"].concat(resetStagedOnly), { allowFailure: true });
      }
      if (reset.code !== 0) throw new GitCommandError((reset.stderr || reset.stdout || "").trim(), reset.entry);
    }
    if (restoreFromHead.length) {
      const hasHead = await hasHeadCommit(repo);
      const args = hasHead ? ["checkout", "HEAD", "--"] : ["checkout", "--"];
      const res = await runGit(repo, args.concat(restoreFromHead), { allowFailure: true, timeoutMs: 60000 });
      if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    }
    if (untracked.length) {
      // -x：已强制加入索引但命中 .gitignore 的文件，reset 后也要真正删掉。
      const res = await runGit(repo, ["clean", "-f", "-d", "-x", "--"].concat(untracked), {
        allowFailure: true,
        timeoutMs: 60000,
      });
      if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    }
    return { count: list.length };
  }, { success: deleteOnly ? "已删除 " + names.length + " 个未提交文件" : "已回滚 " + names.length + " 个文件", details: false });
}

async function hasHeadCommit(repo) {
  const res = await runGit(repo, ["rev-parse", "-q", "--verify", "HEAD"], {
    allowFailure: true,
    timeoutMs: 8000,
  });
  return res.code === 0;
}

async function removeFromIndex(repo, paths) {
  const list = paths || [];
  if (!list.length) return;
  return perform(repo, "从索引移除", async () => {
    await runGit(repo, ["rm", "-r", "--cached", "--"].concat(list), { timeoutMs: 30000 });
  }, { success: "已从索引移除" });
}

async function setAssumeUnchanged(repo, paths, value) {
  const list = paths || [];
  if (!list.length) return;
  return perform(repo, value ? "标记为未更改" : "取消未更改标记", async () => {
    const flag = value ? "--assume-unchanged" : "--no-assume-unchanged";
    await runGit(repo, ["update-index", flag, "--"].concat(list), { timeoutMs: 30000 });
  }, { success: value ? "已标记为未更改" : "已取消标记" });
}

async function setSkipWorktree(repo, paths, value) {
  const list = paths || [];
  if (!list.length) return;
  return perform(repo, value ? "跳过工作树" : "恢复工作树跟踪", async () => {
    const flag = value ? "--skip-worktree" : "--no-skip-worktree";
    await runGit(repo, ["update-index", flag, "--"].concat(list), { timeoutMs: 30000 });
  }, { success: value ? "已跳过工作树" : "已恢复工作树跟踪" });
}

/** 清掉 assume-unchanged / skip-worktree；这两个标记会让文件从状态里消失。 */
async function resetIndexFlags(repo) {
  return perform(repo, "恢复隐藏文件", async () => {
    const res = await runGit(repo, ["ls-files", "-v", "-z"], { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    const assume = [];
    const skip = [];
    for (const token of res.stdout.split("\0")) {
      if (token.length < 3 || token[1] !== " ") continue;
      const path = token.slice(2);
      if (token[0] === "h" || token[0] === "s") assume.push(path);
      if (token[0] === "S" || token[0] === "s") skip.push(path);
    }
    if (assume.length) {
      await runGit(repo, ["update-index", "--no-assume-unchanged", "--"].concat(assume), {
        timeoutMs: 30000,
      });
    }
    if (skip.length) {
      await runGit(repo, ["update-index", "--no-skip-worktree", "--"].concat(skip), {
        timeoutMs: 30000,
      });
    }
    return { assume: assume.length, skip: skip.length };
  }, { success: "已恢复所有被隐藏的文件标记" });
}

/* ---------- 提交 ---------- */

function draftFor(repo) {
  return state.drafts[repo] || "";
}

function setDraft(repo, value) {
  state.drafts = Object.assign({}, state.drafts, { [repo]: value });
  notify();
}

function buildCommitArgs(options) {
  const args = ["commit"];
  if (options.amend) args.push("--amend");
  if (options.message) args.push("-m", options.message);
  else if (options.amend) args.push("--no-edit");
  if (options.signOff) args.push("-s");
  if (options.skipHooks) args.push("--no-verify");
  if (options.noGpgSign) args.push("--no-gpg-sign");
  if (options.allowEmpty) args.push("--allow-empty");
  return args;
}

async function commitChanges(repo, options) {
  const opts = Object.assign(
    {
      message: draftFor(repo),
      amend: state.commitAmend,
      signOff: state.commitSignOff,
      skipHooks: state.commitSkipHooks,
      push: state.commitPush,
      allowEmpty: state.commitAllowEmpty,
      noGpgSign: state.commitNoGpg,
    },
    options || {},
  );
  if (!opts.message.trim() && !opts.amend) {
    toast("请填写提交信息", "error");
    return { ok: false };
  }
  const data = ensureRepoData(repo);
  const changed = uniquePaths(
    data.status.staged.concat(data.status.unstaged, data.status.untracked, data.status.conflicted),
  );
  const selectedRaw = checkedPaths(repo).filter((path) => changed.includes(path));
  const conflictedPaths = new Set(data.status.conflicted.map((entry) => entry.path));
  const selectedConflict = selectedRaw.find((path) => conflictedPaths.has(path));
  if (selectedConflict) {
    toast("冲突文件需先解决，不能直接提交：" + selectedConflict, "error");
    return { ok: false };
  }
  const selected = selectedRaw;
  // 勾选是提交范围的唯一依据：空勾选时不能悄悄退化成「提交全部已暂存」。
  if (!selected.length && !opts.amend && !opts.allowEmpty) {
    toast("请先勾选要提交的文件", "error");
    return { ok: false };
  }
  // 同一文件的已暂存/未暂存条目必须一起勾选：--only 提交的是工作区内容，
  // 只勾其中一组会静默带上另一组未经审阅的改动。
  const checkedSet = new Set(checkedKeys(repo));
  const groupEntries = data.status.staged.concat(data.status.unstaged, data.status.untracked);
  const byPath = new Map();
  for (const item of groupEntries) {
    const bucket = byPath.get(item.path) || [];
    bucket.push(item);
    byPath.set(item.path, bucket);
  }
  for (const [path, items] of byPath) {
    if (items.length < 2) continue;
    const flags = items.map((item) => checkedSet.has(entryKey(item)));
    if (flags.some(Boolean) && !flags.every(Boolean)) {
      toast("同一文件的已暂存与未暂存改动需一起勾选：" + path, "warning");
      return { ok: false };
    }
  }
  // 提交路径：已暂存的重命名需要同时带上旧路径，--only 才能把删除一并写入提交。
  const paths = expandRenamePaths(
    repo,
    selected.length ? selected : uniquePaths(data.status.staged),
  );
  // 暂存路径：只暂存被勾选的未暂存/未跟踪条目，避免把同路径里未勾选的内容一起 add。
  const stageTargets = data.status.unstaged.concat(data.status.untracked)
    .filter((entry) => checkedSet.has(entryKey(entry)))
    .map((entry) => entry.path);
  if (!paths.length && !opts.allowEmpty && !opts.amend) {
    toast("没有可提交的更改", "error");
    return { ok: false };
  }
  // amend 配合部分勾选时不能用普通索引：--amend 会带上全部已暂存内容。
  // 用临时索引从 HEAD 起算，只把勾选路径的当前内容带入改写后的提交。
  const useTempIndex = Boolean(opts.amend && selected.length && paths.length);
  return perform(repo, "提交更改", async () => {
    let tempIndex = "";
    const env = {};
    try {
      if (useTempIndex) {
        tempIndex = joinPath(await getTempDir(), "amend-" + uid("index"));
        env.GIT_INDEX_FILE = tempIndex;
        const seeded = await runGit(repo, ["read-tree", "HEAD"], { env, allowFailure: true, timeoutMs: 30000 });
        if (seeded.code !== 0) throw new GitCommandError((seeded.stderr || "无法基于当前提交（HEAD）建立临时索引").trim(), seeded.entry);
        const added = await runGit(repo, ["add", "-A", "--"].concat(paths), { env, allowFailure: true, timeoutMs: 60000 });
        if (added.code !== 0) throw new GitCommandError((added.stderr || added.stdout || "").trim(), added.entry);
      } else if (stageTargets.length) {
        await stagePaths(repo, stageTargets, { silent: true });
      }
      const args = buildCommitArgs(opts);
      // 非 amend 且用户只勾选了一部分文件：--only 保证不把其它已暂存内容带进提交。
      const allChangedSelected = changed.every((path) => paths.includes(path));
      if (!opts.amend && selected.length && paths.length && !allChangedSelected) {
        args.push("--only", "--");
        args.push.apply(args, paths);
      }
      const res = await runGit(repo, args, { timeoutMs: 120000, allowFailure: true, env });
      if (res.code !== 0) {
        throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      }
      if (useTempIndex) {
        // 提交后把勾选路径的真实索引对齐到新 HEAD，避免旧暂存内容与新提交互相对冲。
        await runGit(repo, ["reset", "-q", "HEAD", "--"].concat(paths), { allowFailure: true, timeoutMs: 30000 });
      }
      state.drafts = Object.assign({}, state.drafts, { [repo]: "" });
      state.checkedByRepo[repo] = {};
      state.commitAmend = false;
      if (opts.message.trim()) {
        const next = [opts.message].concat(state.commitHistory.filter((item) => item !== opts.message)).slice(0, 30);
        void saveCommitHistory(next);
      }
      const firstLine = (res.stdout || "").split("\n").find((line) => line.trim()) || "提交完成";
      return { summary: firstLine.trim(), push: opts.push };
    } finally {
      if (tempIndex) await removeWorkspaceFile(tempIndex);
    }
  }, {
    refresh: false,
    errorPrefix: "提交失败",
  }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    if (opts.push) {
      toast("提交完成，正在推送…", "info");
      const pushed = await pushCurrent(repo);
      if (pushed && pushed.ok) toast("提交并推送完成", "success");
    } else {
      toast("提交完成：" + truncate(result.value.summary, 120), "success");
    }
    return result;
  });
}

/* ---------- 文件差异 ---------- */

function diffCacheKey(entry, mode) {
  const context = Math.max(0, Math.min(50, Number(state.settings.diffContext) || 0));
  return mode + "::" + (state.ignoreWhitespace ? "w" : "s") + "::" + context + "::" + entry.path;
}

/** 静默刷新时判断差异内容是否真的变化；未变化就复用旧对象，避免重置区块选择。 */
function diffContentUnchanged(previous, next) {
  if (!previous || !next || previous.error || next.error) return false;
  if (previous.text !== next.text) return false;
  const a = previous.preview || {};
  const b = next.preview || {};
  return a.text === b.text && a.binary === b.binary && a.truncated === b.truncated && a.conflict === b.conflict;
}

async function ensureFileDiff(repo, entry, mode, force, silent) {
  const data = ensureRepoData(repo);
  const diffMode = mode || state.diffMode || "head";
  if (!entry) return null;
  const key = diffCacheKey(entry, diffMode);
  const cached = data.diffCache[key];
  if (cached && cached.loading) return cached;
  if (!force && cached && cached.generation === data.statusGeneration && Date.now() - cached.at < 3000) return cached;
  // 静默刷新就地比对内容：不显示 loading、不替换缓存对象，内容没变时界面完全不重渲染。
  const silentRefresh = Boolean(silent && cached && !cached.loading);
  const generationAtStart = data.statusGeneration;
  const result = {
    loading: !silentRefresh,
    error: null,
    text: "",
    files: [],
    preview: null,
    entry,
    mode: diffMode,
    at: Date.now(),
    generation: generationAtStart,
  };
  if (!silentRefresh) {
    data.diffCache[key] = result;
    const keys = Object.keys(data.diffCache);
    if (keys.length > 80) {
      const evict = keys
        .filter((item) => item !== key && !data.diffCache[item].loading)
        .sort((a, b) => (data.diffCache[a].at || 0) - (data.diffCache[b].at || 0))
        .slice(0, keys.length - 80);
      for (const item of evict) delete data.diffCache[item];
    }
    notify();
  }
  try {
    if (entry.unmerged) {
      const abs = joinPath(repo, entry.path);
      const file = await readWorkspaceFile(abs, { maxBytes: 384 * 1024 });
      // 文件存在却读不出来（被占用/无权限）时不能当作空文件：允许编辑会把整份冲突内容覆盖成空。
      const readError =
        !file && (await workspacePathExists(abs))
          ? "无法读取该冲突文件（可能被其它程序占用或无权限），请先在外部程序中处理"
          : "";
      result.preview = file
        ? { text: file.text, binary: file.binary, truncated: file.truncated, conflict: true }
        : { text: "", binary: false, truncated: false, conflict: true, error: readError };
    } else if (entry.code === "?" || (entry.staged && entry.x === "A")) {
      // 已暂存的新文件必须读索引内容，工作区可能已被继续修改。
      const shown = entry.staged
        ? await runGit(repo, ["show", ":" + entry.path], { allowFailure: true, timeoutMs: 30000 })
        : null;
      if (shown && shown.code === 0) {
        result.text = shown.stdout;
        result.truncated = outputTruncated(shown.stdout);
        result.preview = {
          text: shown.stdout,
          binary: shown.stdout.indexOf("\u0000") >= 0,
          truncated: result.truncated,
          conflict: false,
        };
      } else {
        const file = await readWorkspaceFile(joinPath(repo, entry.path), { maxBytes: 384 * 1024 });
        result.preview = file
          ? { text: file.text, binary: file.binary, truncated: file.truncated, conflict: false }
          : { text: "", binary: false, truncated: false, conflict: false };
      }
    } else {
      const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      if (diffMode === "staged") args.push("--cached");
      else if (diffMode === "head") args.push("HEAD");
      if (state.ignoreWhitespace) args.push("-w");
      const rawContext = Number(state.settings.diffContext);
      const context = Math.max(0, Math.min(50, Number.isFinite(rawContext) ? rawContext : 3));
      const paths = [entry.path];
      if (entry.origPath && entry.origPath !== entry.path) paths.push(entry.origPath);
      args.push("-U" + context, "--");
      args.push.apply(args, paths);
      const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
      if (res.code !== 0) {
        throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      }
      result.text = res.stdout;
      result.truncated = outputTruncated(res.stdout) || (res.stdout.length > 0 && !res.stdout.endsWith("\n"));
      result.files = parseUnifiedDiff(res.stdout);
    }
    result.loading = false;
    result.at = Date.now();
    // 请求期间状态已变化：这批内容属于旧代际，丢弃并立即按新代际重取，
    // 否则依赖数组不会再次变化，界面会一直停在旧差异上。
    // 静默刷新不写缓存也不递归，交给状态变化后的正常重取或下一轮轮询。
    if (!silentRefresh && generationAtStart !== data.statusGeneration) {
      if (data.diffCache[key] === result) delete data.diffCache[key];
      void ensureFileDiff(repo, entry, diffMode, true);
    }
  } catch (error) {
    result.loading = false;
    result.error = safeError(error);
    result.at = Date.now();
    // 静默刷新失败时保留旧内容，不打断正在查看的差异。
    if (silentRefresh) return cached;
  }
  if (silentRefresh) {
    if (diffContentUnchanged(cached, result)) {
      cached.at = Date.now();
      cached.generation = generationAtStart;
      return cached;
    }
    data.diffCache[key] = result;
  }
  notify();
  return result;
}

/** 轮询发现状态签名未变时仍静默重取当前选中文件的差异：外部编辑同一路径不会改变签名。 */
function refreshSelectedDiff(repo) {
  const selection = state.selectedFile;
  if (!selection || pathKey(selection.repo) !== pathKey(repo)) return;
  const data = ensureRepoData(repo);
  const entry = data.status.entries.find(
    (item) => item.path === selection.path && Boolean(item.staged) === Boolean(selection.staged),
  );
  if (!entry) return;
  void ensureFileDiff(repo, entry, entry.staged ? "staged" : "worktree", true, true).catch(() => undefined);
}

/**
 * 按 hunk 暂存 / 取消暂存 / 丢弃。mode 决定 git apply 的方向与目标。
 * selected（可选）为 hunk.lines 下标集合：只应用所选的增删行。
 */
async function applyHunk(repo, file, hunk, action, selected) {
  if (!file || !hunk) return { ok: false };
  // 新增/删除文件在补丁头里带 new/deleted file mode，只应用部分行会得到
  // 行数不匹配或语义相反的补丁，git apply 直接拒绝；整块操作仍然有效。
  if (selected && selected.size && (file.isNew || file.isDeleted)) {
    toast("新增或删除的文件不支持按行操作，请整块暂存或丢弃", "warning");
    return { ok: false };
  }
  const part = selected && selected.size ? subsetHunk(hunk, selected, action !== "stage") : hunk;
  const patch = part ? buildHunkPatch(file, part) : "";
  if (!patch) {
    toast("无法从该差异构造补丁", "error");
    return { ok: false };
  }
  return perform(repo, action === "discard" ? "丢弃区块" : action === "unstage" ? "取消暂存区块" : "暂存区块", async () => {
    const dir = await getTempDir();
    const patchPath = joinPath(dir, "hunk-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".patch");
    await writeWorkspaceFile(patchPath, patch);
    try {
      const args = ["apply", "--whitespace=nowarn", "--unidiff-zero"];
      if (action === "stage") args.push("--cached");
      if (action === "unstage") args.push("--cached", "--reverse");
      if (action === "discard") args.push("--reverse");
      args.push("--", patchPath);
      const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
      if (res.code !== 0) {
        throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      }
    } finally {
      void removeWorkspaceFile(patchPath);
    }
  }, { success: action === "discard" ? "已丢弃区块" : action === "unstage" ? "已取消暂存区块" : "已暂存区块" });
}

function buildHunkPatch(file, hunk) {
  if (!file || !hunk) return "";
  const meta = (file.meta || []).filter(
    (line) =>
      line &&
      !line.startsWith("Binary files") &&
      line !== "GIT binary patch" &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  );
  const oldLine = file.oldLine || "--- " + (file.oldPath ? "a/" + file.oldPath : "/dev/null");
  const newLine = file.newLine || "+++ " + (file.newPath ? "b/" + file.newPath : "/dev/null");
  const lines = [file.header].concat(meta, [oldLine, newLine, hunk.header]);
  for (const line of hunk.lines) {
    if (line.kind === "add") lines.push("+" + line.text);
    else if (line.kind === "del") lines.push("-" + line.text);
    else if (line.kind === "ctx") lines.push(" " + line.text);
    else if (line.kind === "note") lines.push(line.text);
  }
  return lines.join("\n") + "\n";
}

/**
 * 裁剪 hunk 只保留所选增删行。正向应用（暂存）时：未选的新增行丢弃、未选的删除行转为上下文；
 * 反向应用（取消暂存/丢弃）时相反。这样被匹配的一侧与原文件保持一致。
 */
function subsetHunk(hunk, selected, reverse) {
  const lines = [];
  let oldCount = 0;
  let newCount = 0;
  let changed = 0;
  let lastKept = false;
  let lastIntact = false;
  for (let index = 0; index < hunk.lines.length; index += 1) {
    const line = hunk.lines[index];
    if (line.kind === "note") {
      // note（\ No newline）描述紧邻的前一行；前一行被丢弃或改成上下文时，
      // 补丁会自相矛盾（git apply 会静默把两行合并），整块拒绝交给 UI 提示。
      if (!lastKept || !lastIntact) return null;
      lines.push(line);
      continue;
    }
    let kind = line.kind;
    const intact = !((kind === "add" || kind === "del") && !selected.has(index));
    if (!intact) {
      const keepAsContext = reverse ? kind === "add" : kind === "del";
      if (!keepAsContext) {
        lastKept = false;
        lastIntact = false;
        continue;
      }
      kind = "ctx";
    }
    if (kind === "add" || kind === "del") changed += 1;
    if (kind === "ctx" || kind === "del") oldCount += 1;
    if (kind === "ctx" || kind === "add") newCount += 1;
    lines.push(kind === line.kind ? line : Object.assign({}, line, { kind }));
    lastKept = kind !== "meta";
    lastIntact = intact && kind === line.kind;
  }
  if (!changed) return null;
  const header =
    "@@ -" + hunk.oldStart + "," + oldCount + " +" + hunk.newStart + "," + newCount + " @@" + (hunk.section ? " " + hunk.section.trim() : "");
  return Object.assign({}, hunk, { header, oldCount, newCount, lines });
}

/* ---------- .gitignore ---------- */

function escapeGitignorePath(path) {
  let value = toSlash(path).replace(/^\/+/, "");
  value = value.replace(/\\/g, "/");
  value = value.replace(/([\\[\]*?!#])/g, "\\$1");
  return "/" + value;
}

async function addToGitignore(repo, paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { ok: false };
  return perform(repo, "添加到 .gitignore", async () => {
    const gitignorePath = joinPath(repo, ".gitignore");
    const exists = await workspacePathExists(gitignorePath);
    const existing = exists ? await readWorkspaceFile(gitignorePath, { maxBytes: 512 * 1024 }) : null;
    if (exists && (!existing || existing.binary || existing.truncated)) {
      throw new Error(".gitignore 不是可完整读取的文本文件，已取消写入");
    }
    const current = existing ? existing.text : "";
    const eol = /\r\n/.test(current) ? "\r\n" : "\n";
    const lines = splitLines(current);
    let next = current;
    const appended = [];
    for (const path of list) {
      const pattern = escapeGitignorePath(path);
      if (lines.some((line) => line.trim() === pattern || line.trim() === path)) continue;
      appended.push(pattern);
    }
    if (!appended.length) return { count: 0 };
    if (next && !next.endsWith(eol)) next += eol;
    next += appended.join(eol) + eol;
    await writeWorkspaceFile(gitignorePath, next);
    return { count: appended.length };
  }, { success: "已写入 .gitignore" });
}

/* ---------- 补丁 ---------- */

async function exportPatch(repo, scope) {
  const target = await promptDialog({
    title: "导出补丁",
    description: "将差异写为统一差异文件（unified diff，绝对路径，或相对仓库根目录）。",
    fields: [{ key: "path", label: "补丁路径", placeholder: "绝对路径，例如 /tmp/changes.patch", value: "" }],
    confirmLabel: "导出",
  });
  if (!target || !target.path || !String(target.path).trim()) return { ok: false };
  const raw = String(target.path).trim();
  const outPath = isAbsolutePath(raw) ? normalizePath(raw) : joinPath(repo, raw);
  return perform(repo, "导出补丁", async () => {
    let args = ["diff", "--no-color", "--no-ext-diff", "--binary", "--full-index", "--output=" + outPath];
    if (scope && scope.kind === "commit") {
      const parent = await runGit(repo, ["rev-parse", "-q", "--verify", scope.hash + "^"], {
        allowFailure: true,
        timeoutMs: 10000,
      });
      if (parent.code === 0) args.push(scope.hash + "^!", "--");
      else args = ["show", "--no-color", "--no-ext-diff", "--binary", "--format=", "--output=" + outPath, scope.hash, "--"];
    } else if (scope && scope.kind === "range") {
      args.push(scope.from + ".." + scope.to);
    } else {
      args.push("HEAD");
    }
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 120000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    return outPath;
  }, { refresh: false, success: "补丁已导出" });
}

/**
 * `git apply --3way` 会隐式写索引。对比应用前后的暂存差异，只 reset 新出现的路径，
 * 返回未能恢复的路径（空数组表示成功或无需恢复）。
 */
async function restoreIndexAfterThreeWay(repo, stagedBefore) {
  const afterRes = await runGit(repo, ["diff", "--cached", "--name-only", "-z"], {
    allowFailure: true,
    timeoutMs: 30000,
  });
  if (afterRes.code !== 0) return [];
  const stagedAfter = new Set(String(afterRes.stdout || "").split("\u0000").filter(Boolean));
  const newlyStaged = Array.from(stagedAfter).filter((path) => !stagedBefore.has(path));
  if (!newlyStaged.length) return [];
  const reset = await runGit(repo, ["reset", "-q", "HEAD", "--"].concat(newlyStaged), {
    allowFailure: true,
    timeoutMs: 30000,
  });
  return reset.code === 0 ? [] : newlyStaged;
}

async function applyPatch(repo) {
  const target = await promptDialog({
    title: "应用补丁",
    description: "选择一个补丁文件（patch）；相对路径按仓库根目录解析。",
    fields: [
      { key: "path", label: "补丁路径", placeholder: "绝对路径，例如 /tmp/changes.patch" },
      { key: "threeWay", label: "三方合并（--3way，失败时更容易出冲突）", type: "checkbox", value: false },
    ],
    confirmLabel: "应用",
  });
  if (!target || !target.path) return { ok: false };
  const raw = String(target.path).trim();
  const patchPath = isAbsolutePath(raw) ? normalizePath(raw) : joinPath(repo, raw);
  return perform(repo, "应用补丁", async () => {
    const touched = new Set();
    let stagedBefore = new Set();
    if (target.threeWay) {
      const patchText = await readWorkspaceFile(patchPath, { maxBytes: 8 * 1024 * 1024 });
      if (!patchText || patchText.truncated) {
        throw new Error("无法完整读取补丁文件，三方应用已取消（补丁需小于 8MB）");
      }
      const parsed = parseUnifiedDiff(patchText.text);
      for (const file of parsed) {
        if (file.newPath) touched.add(file.newPath);
        if (file.oldPath) touched.add(file.oldPath);
        if (file.name) touched.add(file.name);
      }
      // --3way 之后必须 reset 索引；若这些路径原本有暂存内容，reset 会静默丢弃。
      const stagedRes = await runGit(repo, ["diff", "--cached", "--name-only", "-z"], {
        allowFailure: true,
        timeoutMs: 30000,
      });
      const staged = new Set(String(stagedRes.stdout || "").split("\u0000").filter(Boolean));
      stagedBefore = staged;
      if (touched.size) {
        const overlap = Array.from(touched).filter((path) => staged.has(path));
        if (overlap.length) {
          throw new Error("补丁涉及已暂存文件，请先提交或取消暂存后再应用：" + overlap.slice(0, 5).join(", "));
        }
      }
    } else {
      const check = await runGit(repo, ["apply", "--check", "--", patchPath], {
        allowFailure: true,
        timeoutMs: 60000,
      });
      if (check.code !== 0) {
        throw new GitCommandError("补丁无法直接应用：" + (check.stderr || check.stdout || "").trim(), check.entry);
      }
    }
    const args = ["apply", "--whitespace=nowarn"];
    if (target.threeWay) args.push("--3way");
    args.push("--", patchPath);
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 120000 });
    if (res.code !== 0) {
      // --3way 失败也可能已写入索引（冲突条目）：先恢复应用前的暂存状态，再报原始错误。
      if (target.threeWay) {
        const failed = await restoreIndexAfterThreeWay(repo, stagedBefore);
        if (failed.length) toast("补丁应用失败，且索引未完全恢复：" + failed.slice(0, 5).join(", "), "warning");
      }
      throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    }
    if (target.threeWay) {
      // --3way 隐式使用 --index；用应用前后的暂存差异精确找出新写入的路径，避免误动原有暂存。
      const failed = await restoreIndexAfterThreeWay(repo, stagedBefore);
      if (failed.length) {
        throw new GitCommandError("补丁已应用，但取消暂存失败：" + failed.slice(0, 5).join(", "), null);
      }
    }
  }, { success: "补丁已应用", details: true });
}

/* ---------- 仓库初始化 / 克隆 ---------- */

async function initRepository(path) {
  const target = normalizePath(path);
  return perform(null, "初始化 Git 仓库", async () => {
    const res = await runGit(target, ["init"], { allowFailure: true, timeoutMs: 60000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { refresh: false, success: "已初始化 Git 仓库" }).then(async (result) => {
    if (result.ok) await scanWorkspace({ force: true });
    return result;
  });
}

async function cloneRepository() {
  const values = await promptDialog({
    title: "克隆仓库",
    description: "目标目录不存在时由 Git 创建；克隆完成后会自动登记为工作区。",
    fields: [
      { key: "url", label: "仓库地址", placeholder: "https://… 或 git@…" },
      { key: "dest", label: "目标目录", placeholder: "绝对路径，例如 /path/to/my-repo" },
      { key: "depth", label: "浅克隆深度（留空为完整克隆）", placeholder: "例如 1", optional: true },
    ],
    confirmLabel: "克隆",
  });
  if (!values || !values.url || !values.dest) return { ok: false };
  const rawDest = String(values.dest).trim();
  const dest = isAbsolutePath(rawDest) ? normalizePath(rawDest) : state.workspacePath ? joinPath(state.workspacePath, rawDest) : "";
  if (!dest) {
    toast("请填写绝对路径，或先打开一个工作区", "error");
    return { ok: false };
  }
  return enqueue(() =>
    withBusy("克隆仓库", async () => {
      try {
        const args = ["clone", "--no-single-branch"];
        const depth = String(values.depth || "").trim();
        if (/^\d+$/.test(depth)) args.push("--depth", depth);
        args.push("--", String(values.url).trim(), dest);
        const res = await runGit(null, args, { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS });
        if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
        const ws = pathKey(state.workspacePath);
        state.manualRepos = Object.assign({}, state.manualRepos, {
          [ws]: Array.from(new Set((state.manualRepos[ws] || []).concat([dest]))),
        });
        void saveManualRepos();
        try {
          await appCtx.workspaces.add(dest);
        } catch (error) {
          // 登记失败不影响克隆结果
        }
        await scanWorkspace({ force: true });
        setActiveRepo(dest);
        toast("克隆完成：" + dest, "success");
        return { ok: true, value: dest };
      } catch (error) {
        const text = reportError(error, "克隆失败");
        return { ok: false, error, text };
      }
    }),
  );
}

async function addRepoManually() {
  const values = await promptDialog({
    title: "添加仓库",
    description: "加入一个不在当前工作区扫描范围内的 Git 仓库。",
    fields: [{ key: "path", label: "仓库路径", placeholder: "绝对路径，例如 /path/to/repo" }],
    confirmLabel: "添加",
  });
  if (!values || !values.path) return { ok: false };
  const rawPath = String(values.path).trim();
  const path = isAbsolutePath(rawPath)
    ? normalizePath(rawPath)
    : state.workspacePath
      ? joinPath(state.workspacePath, rawPath)
      : "";
  if (!path) {
    toast("请填写绝对路径，或先打开一个工作区", "error");
    return { ok: false };
  }
  const root = await resolveRepoRoot(path);
  if (!root) {
    toast("该路径不是 Git 仓库", "error");
    return { ok: false };
  }
  const ws = pathKey(state.workspacePath);
  state.manualRepos = Object.assign({}, state.manualRepos, {
    [ws]: Array.from(new Set((state.manualRepos[ws] || []).concat([root]))),
  });
  void saveManualRepos();
  await scanWorkspace({ force: true });
  setActiveRepo(root);
  return { ok: true };
}

async function removeRepoManually(path) {
  const ws = pathKey(state.workspacePath);
  const next = (state.manualRepos[ws] || []).filter(
    (item) => pathKey(item) !== pathKey(path),
  );
  state.manualRepos = Object.assign({}, state.manualRepos, { [ws]: next });
  void saveManualRepos();
  await scanWorkspace({ force: true });
}

/* ---------- 文件历史 / Blame ---------- */

async function openFileHistory(repo, path) {
  const view = getLogView(repo);
  const previous = state.history && pathKey(state.history.repo) === pathKey(repo)
    ? state.history.prevFilter
    : Object.assign({}, view.filter);
  state.history = { repo, path, prevFilter: Object.assign({}, previous) };
  state.activeTab = "history";
  view.filter = Object.assign(defaultLogFilter(), { path });
  view.commits = [];
  view.offset = 0;
  view.hasMore = true;
  notify();
  await loadLog(repo, true);
}

async function openBlame(repo, path, start) {
  const data = ensureRepoData(repo);
  const rangeStart = Math.max(1, Number(start) || 1);
  state.blame = {
    repo,
    path,
    start: rangeStart,
    end: rangeStart + MAX_BLAME_LINES - 1,
    lines: [],
    loading: true,
    error: null,
  };
  state.activeTab = "blame";
  notify();
  await loadBlame(repo, path, rangeStart);
}

async function loadBlame(repo, path, start) {
  const rangeStart = Math.max(1, Number(start) || 1);
  const rangeEnd = rangeStart + MAX_BLAME_LINES - 1;
  const token = Date.now() + ":" + Math.random();
  state.blame = Object.assign({}, state.blame, {
    token,
    repo,
    path,
    start: rangeStart,
    end: rangeEnd,
    loading: true,
    error: null,
  });
  notify();
  try {
    const res = await runGit(
      repo,
      ["blame", "--line-porcelain", "-L", rangeStart + "," + rangeEnd, "--", path],
      { allowFailure: true, timeoutMs: 120000 },
    );
    if (res.code !== 0) {
      throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    }
    const lines = parseBlamePorcelain(res.stdout);
    const truncated = outputTruncated(res.stdout) || (res.stdout.length > 0 && !res.stdout.endsWith("\n"));
    let maxLine = 0;
    for (let i = 0; i < lines.length; i += 1) if (lines[i]) maxLine = i;
    if (!state.blame || state.blame.token !== token) return;
    state.blame = Object.assign({}, state.blame, {
      lines,
      truncated,
      // 本段没填满，说明已经到文件末尾；输出被截断时不能据此判定，
      // 且把 end 收窄到最后解析到的行，下一页不会跳过被截掉的尾部。
      end: truncated && maxLine ? maxLine : rangeEnd,
      exhausted: !truncated && maxLine < rangeEnd,
      loading: false,
      error: null,
    });
    notify();
  } catch (error) {
    const message = safeError(error);
    const short = message.match(/has only (\d+) lines?/i);
    if (short) {
      const total = Number(short[1]);
      if (total > 0 && rangeStart > total) {
        await loadBlame(repo, path, Math.max(1, total - MAX_BLAME_LINES + 1));
        return;
      }
    }
    if (!state.blame || state.blame.token !== token) return;
    state.blame = Object.assign({}, state.blame, { loading: false, error: message });
    notify();
  }
}

async function shiftBlame(delta) {
  if (!state.blame) return;
  // 输出被截断时 end 是实际解析到的最后一行，向前翻页必须接上它，否则会跳过被截掉的尾部。
  const next = delta > 0 && state.blame.truncated
    ? Math.max(1, (Number(state.blame.end) || 0) + 1)
    : Math.max(1, state.blame.start + delta);
  await loadBlame(state.blame.repo, state.blame.path, next);
}

/* ===== 26-actions-vcs.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：分支 / 网络 / 提交图操作 / 暂存 / 标签 / 远程 / 子模块 / 配置 / 控制台。
 * 所有面向用户的写操作都允许失败并以 toast + 控制台呈现，不吞掉 stderr。
 * ------------------------------------------------------------------------- */

function branchOf(repo) {
  const data = ensureRepoData(repo);
  return data.status && data.status.branch ? data.status.branch : emptyStatus().branch;
}

async function requireBranch(repo) {
  let branch = branchOf(repo);
  if (!branch.head && !branch.detached) {
    await loadRepoStatus(repo, true);
    branch = branchOf(repo);
  }
  if (branch.detached) throw new Error("当前处于游离 HEAD（detached），请先切回分支");
  if (!branch.head) throw new Error("当前仓库还没有分支");
  return branch;
}

function defaultRemote(repo) {
  const data = ensureRepoData(repo);
  const branch = branchOf(repo);
  if (branch.upstream && branch.upstream.indexOf("/") > 0) {
    return branch.upstream.slice(0, branch.upstream.indexOf("/"));
  }
  if (data.remotes.length) return data.remotes[0].name;
  return "origin";
}

function optionLikeRef(value) {
  return String(value || "").startsWith("-");
}

function validBranchName(name, label) {
  const value = String(name || "").trim();
  const what = label || "分支名";
  if (!value) return what + "不能为空";
  if (value.startsWith("-")) return what + "不能以 - 开头";
  if (/[\s~^:?*\\[\x00-\x1f\x7f]/.test(value)) return what + "包含非法字符（空白、控制字符或 ~^:?*[\\）";
  if (value.includes("..") || value.includes("@{")) return what + "包含非法序列";
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return what + "不能包含空路径段";
  const parts = value.split("/");
  if (parts.some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return what + "的每一段都不能以 . 开头或以 .lock 结尾";
  }
  if (value.endsWith(".")) return what + "不能以 . 结尾";
  if (value === "@") return what + "不能是 @";
  return null;
}

/* ---------- 网络：fetch / pull / push ---------- */

async function fetchRepo(repo, options) {
  const opts = Object.assign({ all: false, remote: "", prune: state.settings.fetchPrune, tags: false }, options || {});
  return perform(repo, "获取远程更新", async () => {
    const args = ["fetch"];
    if (opts.all) {
      args.push("--all");
    }
    if (opts.prune) args.push("--prune");
    if (opts.tags) args.push("--tags");
    if (!opts.all && opts.remote) args.push("--", opts.remote);
    const res = await runGit(repo, args, {
      allowFailure: true,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    return (res.stderr || res.stdout || "").trim();
  }, { success: "已获取远程更新", details: true, log: true });
}

async function reportRequireBranch(repo, prefix) {
  try {
    return await requireBranch(repo);
  } catch (error) {
    reportError(error, prefix);
    return null;
  }
}

async function pullRepo(repo, options) {
  const opts = Object.assign({ strategy: state.settings.pullStrategy, autostash: true }, options || {});
  const branch = await reportRequireBranch(repo, "拉取失败");
  if (!branch) return { ok: false };
  return perform(repo, "拉取远程更新", async () => {
    const args = ["pull", "--no-edit"];
    if (opts.strategy === "rebase") args.push("--rebase");
    else if (opts.strategy === "ff-only") args.push("--ff-only");
    else args.push("--no-rebase");
    if (opts.autostash) args.push("--autostash");
    const res = await runGit(repo, args, {
      allowFailure: true,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      const message = (res.stderr || res.stdout || "").trim();
      if (/CONFLICT|conflict/i.test(message)) {
        return { conflict: true, message };
      }
      throw new GitCommandError(message, res.entry);
    }
    const output = ((res.stderr || "") + "\n" + (res.stdout || "")).trim();
    // --autostash 回放冲突时 git pull 仍以 0 退出，但工作区已留下冲突与未清理的 autostash。
    if (/resulted in conflicts/i.test(output)) {
      return { conflict: true, autostash: true, message: output };
    }
    return { conflict: false, message: output };
  }, { refresh: false, errorPrefix: "拉取失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    if (result.value && result.value.autostash) {
      toast("拉取完成，但自动贮藏回放冲突：请解决冲突，贮藏仍保留在 stash 中", "warning");
    } else if (result.value && result.value.conflict) {
      toast("拉取产生冲突，请在“本地更改”中解决", "warning");
    } else {
      toast("拉取完成", "success");
    }
    return result;
  });
}

async function pushCurrent(repo, options) {
  const opts = Object.assign(
    { remote: "", setUpstream: null, force: false, tags: false, all: false },
    options || {},
  );
  const branch = await reportRequireBranch(repo, "推送失败");
  if (!branch) return { ok: false };
  const remote = opts.remote || defaultRemote(repo);
  const hasUpstream = Boolean(branch.upstream);
  const slash = branch.upstream ? branch.upstream.indexOf("/") : -1;
  const upstreamRemote = slash > 0 ? branch.upstream.slice(0, slash) : "";
  const upstreamBranch = slash > 0 ? branch.upstream.slice(slash + 1) : "";
  const setUpstream = opts.setUpstream === null ? !hasUpstream : Boolean(opts.setUpstream);
  const runPush = (silentError) =>
    perform(repo, "推送", async () => {
      const args = ["push"];
      if (opts.all) args.push("--all");
      if (opts.force) args.push("--force-with-lease");
      if (opts.tags) args.push("--tags");
      if (setUpstream) args.push("--set-upstream");
      args.push("--", remote);
      if (opts.all) {
        // --all 已在前方指定，这里只需要 remote。
      } else if (hasUpstream && upstreamRemote === remote && upstreamBranch) {
        // 尊重已配置的上游分支名（本地与远程可能不同名）。
        args.push(branch.head + ":" + upstreamBranch);
      } else {
        args.push(branch.head);
      }
      const res = await runGit(repo, args, {
        allowFailure: true,
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
      if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
      return (res.stderr || res.stdout || "").trim();
    }, { success: "推送完成", details: true, silentError });

  // 首次静默：非快进拒绝会自动拉取重试，避免先闪一条错误提示。
  const first = await runPush(true);
  if (first.ok) return first;
  // 非快进拒绝（远程有新提交）时自动拉取一次再重推，省掉手动 fetch + pull + push。
  // 强制推送与多引用推送不自动合并，避免覆盖或跨分支误操作。
  const raw = safeError(first.error);
  const retry = !opts.force && !opts.all && !opts.tags && /\[rejected\]/.test(raw) && /(fetch first|non-fast-forward)/i.test(raw);
  if (!retry) {
    toast(truncate(first.text, 600), "error");
    return first;
  }
  toast("远程有新提交，正在自动拉取并重试推送…", "info");
  const pulled = await pullRepo(repo, { strategy: state.settings.pullStrategy, autostash: true });
  if (!pulled.ok) {
    toast(truncate(first.text, 600), "error");
    return first;
  }
  if (pulled.value && pulled.value.conflict) {
    toast("推送已取消：解决冲突后可重新推送", "warning");
    return first;
  }
  const second = await runPush(false);
  if (second.ok) toast("已合并远程更新并重新推送到 " + remote, "success");
  return second;
}

async function updateProject(repo) {
  const fetched = await fetchRepo(repo, { all: false, remote: defaultRemote(repo), prune: state.settings.fetchPrune });
  if (!fetched.ok) return fetched;
  return pullRepo(repo, { strategy: state.settings.pullStrategy, autostash: true });
}

async function pushDialog(repo) {
  const branch = branchOf(repo);
  const remotes = ensureRepoData(repo).remotes;
  const values = await promptDialog({
    title: "推送到远程",
    description: "当前分支：" + (branch.head || "（游离 HEAD）") + (branch.upstream ? "，上游：" + branch.upstream : "，尚未设置上游"),
    fields: [
      {
        key: "remote",
        label: "远程",
        type: "select",
        value: defaultRemote(repo),
        options: (remotes.length ? remotes : [{ name: "origin" }]).map((item) => ({
          value: item.name,
          label: item.name,
        })),
      },
      { key: "setUpstream", label: "设置上游分支（-u）", type: "checkbox", value: !branch.upstream },
      { key: "force", label: "强制推送（--force-with-lease）", type: "checkbox", value: false },
      { key: "tags", label: "同时推送所有标签（--tags）", type: "checkbox", value: false },
    ],
    confirmLabel: "推送",
    danger: false,
  });
  if (!values) return { ok: false };
  if (values.force) {
    const confirmed = await confirmDestructive({
      title: "强制推送",
      message: "强制推送会用本地历史覆盖远程分支。确认继续？",
      confirmLabel: "强制推送",
      danger: true,
    });
    if (!confirmed) return { ok: false };
  }
  return pushCurrent(repo, {
    remote: values.remote,
    setUpstream: Boolean(values.setUpstream),
    force: Boolean(values.force),
    tags: Boolean(values.tags),
  });
}

/* ---------- 分支 ---------- */

async function checkoutBranch(repo, name, remote) {
  if (optionLikeRef(name)) {
    toast("分支名不能以 - 开头", "error");
    return { ok: false };
  }
  const isRemote = Boolean(remote);
  const localName = isRemote && name.indexOf("/") > 0 ? name.slice(name.indexOf("/") + 1) : name;
  return perform(repo, "检出分支 " + name, async () => {
    let args;
    if (isRemote) {
      const data = ensureRepoData(repo);
      const existing = data.branches.locals.some((item) => item.name === localName);
      args = existing ? ["checkout", localName] : ["checkout", "-b", localName, "--track", name];
    } else {
      args = ["checkout", name];
    }
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    state.selectedFile = null;
    state.activeTab = "changes";
    return { branch: isRemote ? localName : name };
  }, { success: "已检出 " + name, details: true, log: true });
}

async function createBranch(repo, name, startPoint) {
  if (startPoint && optionLikeRef(String(startPoint).trim())) {
    toast("起点不能以 - 开头", "error");
    return { ok: false };
  }
  const problem = validBranchName(name);
  if (problem) {
    toast(problem, "error");
    return { ok: false };
  }
  return perform(repo, "创建分支 " + name, async () => {
    const args = ["checkout", "-b", String(name).trim()];
    if (startPoint) args.push(startPoint);
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    return { branch: String(name).trim() };
  }, { success: "已创建并检出分支 " + name, details: true, log: true });
}

async function createBranchDialog(repo, startPoint) {
  const values = await promptDialog({
    title: "新建分支",
    description: startPoint ? "基于 " + startPoint + " 创建并检出" : "基于当前提交（HEAD）创建并检出",
    fields: [{ key: "name", label: "分支名", placeholder: "feature/my-change" }],
    confirmLabel: "创建",
  });
  if (!values || !values.name) return { ok: false };
  return createBranch(repo, values.name, startPoint);
}

async function renameBranch(repo, oldName, newName) {
  if (optionLikeRef(oldName)) {
    toast("分支名不能以 - 开头", "error");
    return { ok: false };
  }
  const problem = validBranchName(newName);
  if (problem) {
    toast(problem, "error");
    return { ok: false };
  }
  return perform(repo, "重命名分支", async () => {
    const branch = branchOf(repo);
    const args = branch.head === oldName ? ["branch", "-m", newName] : ["branch", "-m", oldName, newName];
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已重命名分支", details: true });
}

async function renameBranchDialog(repo, oldName) {
  const values = await promptDialog({
    title: "重命名分支",
    fields: [{ key: "name", label: "新分支名", value: oldName }],
    confirmLabel: "重命名",
  });
  if (!values || !values.name) return { ok: false };
  return renameBranch(repo, oldName, values.name);
}

async function deleteBranch(repo, name, force) {
  const confirmed = await confirmDestructive({
    title: "删除分支",
    message: "删除本地分支 " + name + "？" + (force ? "（强制删除，未合并提交会丢失）" : ""),
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除分支 " + name, async () => {
    const res = await runGit(repo, ["branch", force ? "-D" : "-d", "--", name], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已删除分支 " + name, details: true });
}

async function mergeBranch(repo, ref, options) {
  if (optionLikeRef(ref)) {
    toast("引用名不能以 - 开头", "error");
    return { ok: false };
  }
  const opts = Object.assign({ mode: "default", message: "", squash: false }, options || {});
  return perform(repo, "合并 " + ref, async () => {
    const args = ["merge"];
    if (opts.squash) args.push("--squash");
    else if (opts.mode === "no-ff") args.push("--no-ff");
    else if (opts.mode === "ff-only") args.push("--ff-only");
    if (opts.message) args.push("-m", opts.message);
    args.push(ref);
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 180000 });
    const output = (res.stderr || res.stdout || "").trim();
    if (res.code !== 0) {
      if (/CONFLICT|Automatic merge failed|fix conflicts/i.test(output)) {
        return { conflict: true, output };
      }
      throw new GitCommandError(output, res.entry);
    }
    return { conflict: false, output };
  }, { refresh: false, errorPrefix: "合并失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    if (result.value.conflict) toast("合并产生冲突，请在“本地更改”中解决", "warning");
    else if (opts.squash) toast("已压缩合并（squash），更改已暂存", "success");
    else toast("合并完成", "success");
    return result;
  });
}

async function mergeBranchDialog(repo, ref) {
  const values = await promptDialog({
    title: "合并 " + ref + " 到当前分支",
    fields: [
      {
        key: "mode",
        label: "合并方式",
        type: "select",
        value: "default",
        options: [
          { value: "default", label: "默认（允许快进）" },
          { value: "no-ff", label: "始终生成合并提交（--no-ff）" },
          { value: "ff-only", label: "仅快进（--ff-only）" },
          { value: "squash", label: "压缩为一次暂存更改（--squash）" },
        ],
      },
      { key: "message", label: "合并提交信息（可选）", value: "", optional: true },
    ],
    confirmLabel: "合并",
  });
  if (!values) return { ok: false };
  return mergeBranch(repo, ref, {
    mode: values.mode,
    message: values.message,
    squash: values.mode === "squash",
  });
}

async function rebaseBranch(repo, onto) {
  if (optionLikeRef(onto)) {
    toast("引用名不能以 - 开头", "error");
    return { ok: false };
  }
  const confirmed = await confirmDestructive({
    title: "变基",
    message: "将当前分支变基到 " + onto + "？这会重写当前分支的提交。",
    confirmLabel: "变基",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "变基到 " + onto, async () => {
    const res = await runGit(repo, ["rebase", "--autostash", onto], {
      allowFailure: true,
      timeoutMs: 180000,
    });
    const output = (res.stderr || res.stdout || "").trim();
    if (res.code !== 0) {
      if (/CONFLICT|conflict|Resolve all conflicts/i.test(output)) return { conflict: true, output };
      throw new GitCommandError(output, res.entry);
    }
    if (/resulted in conflicts/i.test(output)) return { conflict: true, autostash: true, output };
    return { conflict: false, output };
  }, { refresh: false, errorPrefix: "变基失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    if (result.value.autostash) {
      toast("变基完成，但自动贮藏回放冲突：请解决冲突，贮藏仍保留在 stash 中", "warning");
    } else {
      toast(result.value.conflict ? "变基产生冲突，请解决后继续" : "变基完成", result.value.conflict ? "warning" : "success");
    }
    return result;
  });
}

async function compareBranches(repo, base, head) {
  if (optionLikeRef(base) || optionLikeRef(head)) {
    toast("引用名不能以 - 开头", "error");
    return { ok: false };
  }
  const data = ensureRepoData(repo);
  const token = Date.now() + ":" + Math.random();
  data.compare = { base, head, token, loading: true, ahead: [], behind: [], stat: "", error: null };
  notify();
  try {
    const [aheadRes, behindRes, statRes] = await Promise.all([
      runGit(repo, ["log", "--no-color", "--pretty=format:%h%x1f%an%x1f%at%x1f%s", base + ".." + head], {
        allowFailure: true,
        timeoutMs: 60000,
      }),
      runGit(repo, ["log", "--no-color", "--pretty=format:%h%x1f%an%x1f%at%x1f%s", head + ".." + base], {
        allowFailure: true,
        timeoutMs: 60000,
      }),
      runGit(repo, ["diff", "--stat", "--no-color", base + "..." + head], {
        allowFailure: true,
        timeoutMs: 60000,
      }),
    ]);
    const parse = (raw) =>
      splitLines(raw)
        .filter(Boolean)
        .map((line) => {
          const f = line.split("\x1f");
          return { hash: f[0] || "", author: f[1] || "", at: parseEpoch(f[2]), subject: f[3] || "" };
        });
    if (!data.compare || data.compare.token !== token) return;
    data.compare = {
      base,
      head,
      token,
      loading: false,
      ahead: aheadRes.code === 0 ? parse(aheadRes.stdout) : [],
      behind: behindRes.code === 0 ? parse(behindRes.stdout) : [],
      stat: statRes.code === 0 ? statRes.stdout : "",
      error: null,
    };
    notify();
  } catch (error) {
    if (!data.compare || data.compare.token !== token) return;
    data.compare = { base, head, token, loading: false, ahead: [], behind: [], stat: "", error: safeError(error) };
    notify();
  }
}

/* ---------- 提交图操作 ---------- */

async function cherryPickCommits(repo, hashes) {
  const list = (hashes || []).slice().reverse();
  if (!list.length) return { ok: false };
  return perform(repo, "拣选（Cherry-pick）", async () => {
    const res = await runGit(repo, ["cherry-pick", "--allow-empty"].concat(list), {
      allowFailure: true,
      timeoutMs: 180000,
    });
    const output = (res.stderr || res.stdout || "").trim();
    if (res.code !== 0) {
      if (/CONFLICT|conflict|after resolving the conflicts/i.test(output)) return { conflict: true, output };
      throw new GitCommandError(output, res.entry);
    }
    return { conflict: false, output };
  }, { refresh: false, errorPrefix: "拣选失败（Cherry-pick）" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    toast(result.value.conflict ? "拣选产生冲突（Cherry-pick）" : "拣选完成（Cherry-pick）", result.value.conflict ? "warning" : "success");
    return result;
  });
}

async function revertCommit(repo, hash) {
  const confirmed = await confirmDestructive({
    title: "还原提交",
    message: "生成一个反向提交来撤销 " + shortHash(hash) + "？",
    confirmLabel: "还原",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "还原提交", async () => {
    const res = await runGit(repo, ["revert", "--no-edit", hash], {
      allowFailure: true,
      timeoutMs: 180000,
    });
    const output = (res.stderr || res.stdout || "").trim();
    if (res.code !== 0) {
      if (/CONFLICT|conflict/i.test(output)) return { conflict: true, output };
      throw new GitCommandError(output, res.entry);
    }
    return { conflict: false, output };
  }, { refresh: false, errorPrefix: "还原失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    toast(result.value.conflict ? "还原产生冲突" : "已还原提交", result.value.conflict ? "warning" : "success");
    return result;
  });
}

async function resetTo(repo, hash, mode) {
  const modeLabel = mode === "soft" ? "软重置（Soft）" : mode === "hard" ? "硬重置（Hard）" : "混合重置（Mixed）";
  const confirmed = await confirmDestructive({
    title: "重置到 " + shortHash(hash),
    message: "模式：" + modeLabel + "。" + (mode === "hard" ? "工作区与暂存区都会被覆盖，未提交更改会丢失。" : "已跟踪文件的工作区内容保留。"),
    confirmLabel: "重置",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "重置分支", async () => {
    const res = await runGit(repo, ["reset", "--" + mode, hash], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已重置到 " + shortHash(hash), details: true, log: true });
}

async function resetDialog(repo, hash) {
  const values = await promptDialog({
    title: "重置当前分支",
    description: "目标提交：" + shortHash(hash),
    fields: [
      {
        key: "mode",
        label: "模式",
        type: "select",
        value: "mixed",
        options: [
          { value: "soft", label: "软重置（Soft）：保留暂存区与工作区" },
          { value: "mixed", label: "混合重置（Mixed）：重置暂存区，保留工作区" },
          { value: "hard", label: "硬重置（Hard）：暂存区与工作区都重置" },
        ],
      },
    ],
    confirmLabel: "重置",
    danger: true,
  });
  if (!values) return { ok: false };
  return resetTo(repo, hash, values.mode);
}

async function checkoutCommit(repo, hash) {
  const confirmed = await confirmDestructive({
    title: "检出提交",
    message: "将进入游离 HEAD 状态（detached，" + shortHash(hash) + "）。建议改用“在此新建分支”。",
    confirmLabel: "检出",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "检出提交", async () => {
    const res = await runGit(repo, ["checkout", hash], { allowFailure: true, timeoutMs: 60000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已检出提交", details: true, log: true });
}

async function tagCommit(repo, hash, name, message) {
  const tagName = String(name || "").trim();
  if (!tagName) return { ok: false };
  const problem = validBranchName(tagName, "标签名");
  if (problem) {
    toast(problem, "error");
    return { ok: false };
  }
  return perform(repo, "创建标签", async () => {
    const args = ["tag"];
    if (message) args.push("-a", "-m", message);
    args.push("--", tagName, hash);
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已创建标签 " + name, details: true });
}

async function tagCommitDialog(repo, hash) {
  const values = await promptDialog({
    title: "在 " + shortHash(hash) + " 上创建标签",
    fields: [
      { key: "name", label: "标签名", placeholder: "v1.0.0" },
      { key: "message", label: "注释（留空为轻量标签）", value: "", optional: true },
      { key: "push", label: "创建后推送到远程", type: "checkbox", value: false },
    ],
    confirmLabel: "创建",
  });
  if (!values || !values.name) return { ok: false };
  const result = await tagCommit(repo, hash, values.name, values.message);
  if (result.ok && values.push) await pushTags(repo, [String(values.name).trim()]);
  return result;
}

async function dropCommit(repo, hash) {
  const confirmed = await confirmDestructive({
    title: "删除提交",
    message: "从当前分支移除提交 " + shortHash(hash) + "（其后的提交会被重放）。仅在提交是当前提交（HEAD）的祖先时可用。",
    confirmLabel: "删除提交",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除提交", async () => {
    const ancestor = await runGit(repo, ["merge-base", "--is-ancestor", hash, "HEAD"], {
      allowFailure: true,
      timeoutMs: 15000,
    });
    if (ancestor.code !== 0) throw new Error("只能删除当前分支上的祖先提交");
    const parent = await runGit(repo, ["rev-parse", hash + "^"], { allowFailure: true, timeoutMs: 15000 });
    if (parent.code !== 0) throw new Error("根提交不能通过该方式删除");
    const res = await runGit(repo, ["rebase", "--onto", hash + "^", hash], {
      allowFailure: true,
      timeoutMs: 180000,
    });
    const output = (res.stderr || res.stdout || "").trim();
    if (res.code !== 0) {
      if (/CONFLICT|conflict/i.test(output)) return { conflict: true, output };
      throw new GitCommandError(output, res.entry);
    }
    return { conflict: false, output };
  }, { refresh: false, errorPrefix: "删除提交失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    toast(result.value.conflict ? "删除提交产生冲突" : "已删除提交", result.value.conflict ? "warning" : "success");
    return result;
  });
}

async function squashLast(repo, count, message) {
  const n = Math.max(2, Math.min(100, Number(count) || 2));
  const confirmed = await confirmDestructive({
    title: "压缩最近 " + n + " 个提交",
    message: "用软重置（soft reset）把最近 " + n + " 个提交合并成一个新提交，作者信息取当前用户。",
    confirmLabel: "压缩",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "压缩提交", async () => {
    const oldHead = await runGit(repo, ["rev-parse", "HEAD"], { allowFailure: true, timeoutMs: 10000 });
    const reset = await runGit(repo, ["reset", "--soft", "HEAD~" + n], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (reset.code !== 0) throw new GitCommandError((reset.stderr || "").trim(), reset.entry);
    const commit = await runGit(repo, buildCommitArgs({ message, skipHooks: state.commitSkipHooks, noGpgSign: state.commitNoGpg }), {
      allowFailure: true,
      timeoutMs: 120000,
    });
    if (commit.code !== 0) {
      // 提交失败（钩子拒绝等）时把分支指针放回原处，避免历史被静默回退。
      if (oldHead.code === 0 && oldHead.stdout.trim()) {
        await runGit(repo, ["reset", "--soft", oldHead.stdout.trim()], { allowFailure: true, timeoutMs: 30000 });
      }
      throw new GitCommandError((commit.stderr || commit.stdout || "").trim(), commit.entry);
    }
  }, { success: "已压缩 " + n + " 个提交", details: true, log: true });
}

async function squashDialog(repo) {
  const values = await promptDialog({
    title: "压缩最近提交",
    fields: [
      { key: "count", label: "提交数量", value: "2" },
      { key: "message", label: "新的提交信息", type: "textarea", value: "", optional: true },
    ],
    confirmLabel: "压缩",
    danger: true,
  });
  if (!values) return { ok: false };
  return squashLast(repo, values.count, values.message || "压缩提交");
}

async function editCommitMessageDialog(repo, hash) {
  let head = "";
  let body = "";
  try {
    const [headRes, bodyRes] = await Promise.all([
      runGit(repo, ["rev-parse", "HEAD"], { allowFailure: true, timeoutMs: 10000 }),
      runGit(repo, ["show", "-s", "--no-color", "--format=%B", hash], { allowFailure: true, timeoutMs: 10000 }),
    ]);
    if (headRes.code === 0) head = (headRes.stdout || "").trim();
    if (bodyRes.code === 0) body = (bodyRes.stdout || "").replace(/\s+$/, "");
  } catch (error) {
    reportError(error, "读取提交信息失败");
    return { ok: false };
  }
  if (head && head !== hash) {
    toast("只能修改最新提交的说明；更早的提交请通过变基（rebase）或命令行处理", "warning");
    return { ok: false };
  }
  const values = await promptDialog({
    title: "修改提交信息",
    description: "提交 " + shortHash(hash) + "；只修改提交说明，暂存区中的内容保持不变。",
    fields: [{ key: "message", label: "提交信息", type: "textarea", value: body }],
    confirmLabel: "保存",
    danger: true,
  });
  if (!values || !String(values.message || "").trim()) return { ok: false };
  return perform(repo, "修改提交信息", async () => {
    const res = await runGit(repo, ["commit", "--amend", "--only", "-m", String(values.message)], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "已修改提交信息", details: true, log: true });
}

/* ---------- 合并/变基/Cherry-pick 的继续与中止 ---------- */

async function continueOperation(repo) {
  const data = ensureRepoData(repo);
  return perform(repo, "继续操作", async () => {
    let args;
    if (data.operations.rebase) args = ["rebase", "--continue"];
    else if (data.operations.merge) args = ["merge", "--continue"];
    else if (data.operations.cherryPick) args = ["cherry-pick", "--continue"];
    else if (data.operations.revert) args = ["revert", "--continue"];
    else throw new Error("当前没有进行中的合并、变基或拣选（Cherry-pick）");
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 180000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "操作已继续", details: true, log: true });
}

async function abortOperation(repo) {
  const data = ensureRepoData(repo);
  const confirmed = await confirmDestructive({
    title: "中止操作",
    message: "放弃当前进行中的合并、变基、拣选（Cherry-pick）或还原（Revert）？",
    confirmLabel: "中止",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "中止操作", async () => {
    let args;
    if (data.operations.rebase) args = ["rebase", "--abort"];
    else if (data.operations.merge) args = ["merge", "--abort"];
    else if (data.operations.cherryPick) args = ["cherry-pick", "--abort"];
    else if (data.operations.revert) args = ["revert", "--abort"];
    else throw new Error("当前没有进行中的合并、变基或拣选（Cherry-pick）");
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已中止操作", details: true, log: true });
}

async function skipOperation(repo) {
  const data = ensureRepoData(repo);
  return perform(repo, "跳过当前提交", async () => {
    let args;
    if (data.operations.rebase) args = ["rebase", "--skip"];
    else if (data.operations.cherryPick) args = ["cherry-pick", "--skip"];
    else if (data.operations.revert) args = ["revert", "--skip"];
    else throw new Error("当前操作不支持跳过");
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 180000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "已跳过", details: true, log: true });
}

async function resolveConflict(repo, path, side) {
  if (side !== "ours" && side !== "theirs") {
    toast("未知的冲突解决方式", "error");
    return { ok: false };
  }
  return perform(repo, "解决冲突", async () => {
    // modify/delete 冲突中某一侧可能没有文件版本：采用该侧等于保留删除。
    const stage = side === "ours" ? 2 : 3;
    const listing = await runGit(repo, ["ls-files", "-u", "--", path], {
      allowFailure: true,
      timeoutMs: 15000,
    });
    const hasStage = listing.code === 0 && new RegExp("(^|\\n)\\d+ [0-9a-f]+ " + stage + "\\t").test(listing.stdout || "");
    if (!hasStage) {
      const removed = await runGit(repo, ["rm", "-f", "--", path], { allowFailure: true, timeoutMs: 30000 });
      if (removed.code !== 0) throw new GitCommandError((removed.stderr || "").trim(), removed.entry);
      return;
    }
    const res = await runGit(repo, ["checkout", "--" + side, "--", path], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    await runGit(repo, ["add", "--", path], { timeoutMs: 30000 });
  }, { success: "已采用 " + (side === "ours" ? "ours" : "theirs") + " 版本", details: true });
}

async function saveConflictFile(repo, path, text) {
  return perform(repo, "保存冲突文件", async () => {
    await writeWorkspaceFile(joinPath(repo, path), text);
    await runGit(repo, ["add", "--", path], { timeoutMs: 30000 });
  }, { success: "已保存并标记为已解决", details: true });
}

/* ---------- 暂存（stash） ---------- */

async function createStash(repo, options) {
  const opts = Object.assign({ message: "", includeUntracked: true, keepIndex: false }, options || {});
  return perform(repo, "创建贮藏", async () => {
    const args = ["stash", "push"];
    if (opts.message) args.push("-m", opts.message);
    if (opts.includeUntracked) args.push("--include-untracked");
    if (opts.keepIndex) args.push("--keep-index");
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 60000 });
    if (res.code !== 0) {
      if (/unknown subcommand|unknown option/i.test(res.stderr || "")) {
        if (opts.includeUntracked || opts.keepIndex) {
          throw new Error("当前 git 版本不支持 stash push 的 --include-untracked/--keep-index，请升级 git");
        }
        const legacy = ["stash", "save"];
        if (opts.message) legacy.push(opts.message);
        const fallback = await runGit(repo, legacy, { allowFailure: true, timeoutMs: 60000 });
        if (fallback.code !== 0) {
          throw new GitCommandError((fallback.stderr || fallback.stdout || "").trim(), fallback.entry);
        }
        return;
      }
      throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
    }
  }, { success: "已创建贮藏", details: true });
}

async function stashDialog(repo) {
  const values = await promptDialog({
    title: "贮藏当前更改",
    fields: [
      { key: "message", label: "说明（可选）", value: "", optional: true },
      { key: "includeUntracked", label: "包含未跟踪文件（-u）", type: "checkbox", value: true },
      { key: "keepIndex", label: "保留暂存区内容（--keep-index）", type: "checkbox", value: false },
    ],
    confirmLabel: "贮藏",
  });
  if (!values) return { ok: false };
  return createStash(repo, values);
}

async function stashApply(repo, selector, action) {
  if (action !== "apply" && action !== "pop" && action !== "drop") {
    toast("未知的贮藏操作", "error");
    return { ok: false };
  }
  // stash@{n} 会随删除/新建整体位移：操作前用 hash 确认仍是列表里的同一条。
  const expected = ensureRepoData(repo).stashes.find((item) => item.selector === selector);
  if (!expected) {
    toast("贮藏列表已变化，请刷新后重试", "warning");
    return { ok: false };
  }
  if (action === "drop") {
    const confirmed = await confirmDestructive({
      title: "删除贮藏",
      message: "删除 " + selector + "？该操作不可恢复。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return { ok: false };
  }
  return perform(repo, action === "pop" ? "应用并删除贮藏" : action === "drop" ? "删除贮藏" : "应用贮藏", async () => {
    const current = await runGit(repo, ["rev-parse", "--verify", selector], { allowFailure: true, timeoutMs: 10000 });
    if (current.code !== 0 || current.stdout.trim() !== expected.hash) {
      throw new Error("贮藏列表已变化，请刷新后重试");
    }
    const res = await runGit(repo, ["stash", action, selector], {
      allowFailure: true,
      timeoutMs: 120000,
    });
    const output = (res.stderr || res.stdout || "").trim();
    if (res.code !== 0) {
      if (/CONFLICT|conflict/i.test(output)) return { conflict: true, output };
      throw new GitCommandError(output, res.entry);
    }
    return { conflict: false, output };
  }, { refresh: false, errorPrefix: "贮藏操作失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true });
    toast(result.value.conflict ? "应用贮藏产生冲突" : "贮藏操作完成", result.value.conflict ? "warning" : "success");
    return result;
  });
}

async function stashBranch(repo, selector) {
  const stash = ensureRepoData(repo).stashes.find((item) => item.selector === selector);
  if (!stash) {
    toast("贮藏列表已变化，请刷新后重试", "warning");
    return { ok: false };
  }
  const suffix = shortHash(stash.hash);
  const values = await promptDialog({
    title: "从贮藏创建分支",
    fields: [{ key: "name", label: "新分支名", value: "stash/" + suffix }],
    confirmLabel: "创建",
  });
  if (!values || !values.name) return { ok: false };
  const problem = validBranchName(values.name);
  if (problem) {
    toast(problem, "error");
    return { ok: false };
  }
  return perform(repo, "从贮藏创建分支", async () => {
    const current = await runGit(repo, ["rev-parse", "--verify", selector], { allowFailure: true, timeoutMs: 10000 });
    if (current.code !== 0 || current.stdout.trim() !== stash.hash) {
      throw new Error("贮藏列表已变化，请刷新后重试");
    }
    const res = await runGit(repo, ["stash", "branch", String(values.name).trim(), selector], {
      allowFailure: true,
      timeoutMs: 120000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "已从贮藏创建分支", details: true, log: true });
}

async function loadStashDiff(repo, selector, hash) {
  const data = ensureRepoData(repo);
  const expected = hash || ((data.stashes.find((item) => item.selector === selector) || {}).hash || "");
  data.stashDiff = { selector, hash: expected, loading: true, text: "", files: [], filesList: [], error: null };
  notify();
  try {
    const show = async (args) => {
      const withUntracked = await runGit(repo, ["stash", "show"].concat(args, ["--include-untracked", selector]), {
        allowFailure: true,
        timeoutMs: 60000,
      });
      if (withUntracked.code !== 0 && /unknown option|--include-untracked/i.test(withUntracked.stderr || "")) {
        return runGit(repo, ["stash", "show"].concat(args, [selector]), {
          allowFailure: true,
          timeoutMs: 60000,
        });
      }
      return withUntracked;
    };
    const [diffRes, filesRes] = await Promise.all([
      show(["-p", "--no-color"]),
      show(["--name-status", "-z"]),
    ]);
    if (diffRes.code !== 0) throw new GitCommandError((diffRes.stderr || "").trim(), diffRes.entry);
    if (!data.stashDiff || data.stashDiff.selector !== selector || data.stashDiff.hash !== expected) return;
    data.stashDiff = {
      selector,
      hash: expected,
      loading: false,
      text: diffRes.stdout,
      files: parseUnifiedDiff(diffRes.stdout),
      filesList: parseNameStatusZ(filesRes.stdout),
      error: null,
    };
    notify();
  } catch (error) {
    if (!data.stashDiff || data.stashDiff.selector !== selector || data.stashDiff.hash !== expected) return;
    data.stashDiff = { selector, hash: expected, loading: false, text: "", files: [], filesList: [], error: safeError(error) };
    notify();
  }
}

async function clearStashes(repo) {
  const confirmed = await confirmDestructive({
    title: "清空贮藏",
    message: "删除全部贮藏记录（stash）？该操作不可恢复。",
    confirmLabel: "清空",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "清空贮藏", async () => {
    await runGit(repo, ["stash", "clear"], { timeoutMs: 30000 });
  }, { success: "已清空贮藏", details: true });
}

/* ---------- 标签 ---------- */

async function createTagDialog(repo) {
  const values = await promptDialog({
    title: "新建标签",
    fields: [
      { key: "name", label: "标签名", placeholder: "v1.0.0" },
      { key: "message", label: "注释（留空为轻量标签）", value: "", optional: true },
      { key: "ref", label: "目标（提交/分支，留空为当前提交 HEAD）", value: "", optional: true },
      { key: "push", label: "创建后推送到远程", type: "checkbox", value: false },
    ],
    confirmLabel: "创建",
  });
  if (!values || !values.name) return { ok: false };
  const tagName = String(values.name).trim();
  const problem = validBranchName(tagName, "标签名");
  if (problem) {
    toast(problem, "error");
    return { ok: false };
  }
  const result = await perform(repo, "创建标签", async () => {
    const args = ["tag"];
    if (values.message) args.push("-a", "-m", values.message);
    args.push("--", tagName);
    if (values.ref) args.push(String(values.ref).trim());
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已创建标签 " + values.name, details: true });
  if (result.ok && values.push) await pushTags(repo, [tagName]);
  return result;
}

async function deleteTag(repo, name) {
  const confirmed = await confirmDestructive({
    title: "删除标签",
    message: "删除本地标签 " + name + "？",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除标签 " + name, async () => {
    const res = await runGit(repo, ["tag", "-d", "--", name], { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已删除标签", details: true });
}

async function pushTags(repo, names) {
  const remote = defaultRemote(repo);
  return perform(repo, "推送标签", async () => {
    const args = ["push"];
    if (!names || !names.length) args.push("--tags");
    args.push("--", remote);
    if (names && names.length) args.push.apply(args, names.map((name) => "refs/tags/" + name));
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "标签已推送", details: true });
}

async function deleteRemoteTag(repo, name) {
  const remote = defaultRemote(repo);
  const confirmed = await confirmDestructive({
    title: "删除远程标签",
    message: "在 " + remote + " 上删除标签 " + name + "？",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除远程标签", async () => {
    const res = await runGit(repo, ["push", "--", remote, ":refs/tags/" + name], {
      allowFailure: true,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "已删除远程标签", details: true });
}

/* ---------- 远程 ---------- */

async function addRemoteDialog(repo) {
  const values = await promptDialog({
    title: "添加远程",
    fields: [
      { key: "name", label: "名称", value: "origin" },
      { key: "url", label: "地址", placeholder: "git@github.com:owner/repo.git" },
    ],
    confirmLabel: "添加",
  });
  if (!values || !values.name || !values.url) return { ok: false };
  return perform(repo, "添加远程", async () => {
    const res = await runGit(repo, ["remote", "add", "--", values.name, values.url], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已添加远程 " + values.name, details: true });
}

async function removeRemote(repo, name) {
  const confirmed = await confirmDestructive({
    title: "删除远程",
    message: "删除远程 " + name + "？分支的上游配置也会失效。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除远程", async () => {
    const res = await runGit(repo, ["remote", "remove", "--", name], { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已删除远程", details: true });
}

async function renameRemoteDialog(repo, name) {
  const values = await promptDialog({
    title: "重命名远程",
    fields: [{ key: "name", label: "新名称", value: name }],
    confirmLabel: "重命名",
  });
  if (!values || !values.name) return { ok: false };
  return perform(repo, "重命名远程", async () => {
    const res = await runGit(repo, ["remote", "rename", "--", name, values.name], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已重命名远程", details: true });
}

async function setRemoteUrlDialog(repo, name, currentUrl) {
  const values = await promptDialog({
    title: "修改远程地址",
    fields: [{ key: "url", label: "地址", value: currentUrl || "" }],
    confirmLabel: "保存",
  });
  if (!values || !values.url) return { ok: false };
  // 展示层脱敏值（***）写回会覆盖真实凭证，直接拒绝。
  if (/\*\*\*/.test(values.url)) {
    toast("地址包含脱敏占位符 ***，请填写完整地址", "error");
    return { ok: false };
  }
  return perform(repo, "修改远程地址", async () => {
    const res = await runGit(repo, ["remote", "set-url", "--", name, values.url], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已修改远程地址", details: true });
}

async function pruneRemote(repo, name) {
  return perform(repo, "清理远程分支", async () => {
    const res = await runGit(repo, ["remote", "prune", "--", name], {
      allowFailure: true,
      timeoutMs: 120000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已清理远程分支", details: true });
}

/* ---------- 子模块 / worktree ---------- */

async function updateSubmodules(repo) {
  return perform(repo, "更新子模块", async () => {
    const res = await runGit(repo, ["submodule", "update", "--init", "--recursive"], {
      allowFailure: true,
      timeoutMs: 300000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "子模块已更新", details: true });
}

async function syncSubmodules(repo) {
  return perform(repo, "同步子模块地址", async () => {
    const res = await runGit(repo, ["submodule", "sync", "--recursive"], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "子模块地址已同步", details: true });
}

async function addSubmoduleDialog(repo) {
  const values = await promptDialog({
    title: "添加子模块",
    fields: [
      { key: "url", label: "仓库地址", placeholder: "https://…" },
      { key: "path", label: "本地路径", placeholder: "vendor/lib" },
    ],
    confirmLabel: "添加",
  });
  if (!values || !values.url || !values.path) return { ok: false };
  return perform(repo, "添加子模块", async () => {
    const res = await runGit(repo, ["submodule", "add", "--", values.url, values.path], {
      allowFailure: true,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "子模块已添加", details: true });
}

async function createWorktreeDialog(repo) {
  const values = await promptDialog({
    title: "新建工作树（Worktree）",
    description: "在独立目录中检出分支，与当前工作区共享同一个 Git 仓库。",
    fields: [
      { key: "path", label: "目录", value: repo + "-worktree", placeholder: "例如 ../repo-feature" },
      { key: "branch", label: "分支", placeholder: "feature/xxx" },
      {
        key: "create",
        label: "创建新分支（取消则检出现有分支）",
        type: "checkbox",
        value: true,
      },
      { key: "base", label: "起点（留空为当前提交 HEAD，仅新建分支时使用）", value: "", optional: true },
    ],
    confirmLabel: "创建",
  });
  if (!values || !values.path || !values.branch) return { ok: false };
  const target = String(values.path).trim();
  const branch = String(values.branch).trim();
  if (target.startsWith("-")) {
    toast("工作树目录不能以 - 开头", "error");
    return { ok: false };
  }
  if (!values.create && branch.startsWith("-")) {
    toast("分支名不能以 - 开头", "error");
    return { ok: false };
  }
  if (values.create) {
    const problem = validBranchName(branch);
    if (problem) {
      toast(problem, "error");
      return { ok: false };
    }
  }
  const base = values.create && values.base ? String(values.base).trim() : "";
  if (optionLikeRef(base)) {
    toast("起点不能以 - 开头", "error");
    return { ok: false };
  }
  return perform(repo, "新建工作树", async () => {
    const args = ["worktree", "add"];
    if (values.create) {
      args.push("-b", branch, target);
      if (base) args.push(base);
    } else {
      args.push(target, branch);
    }
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 120000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "工作树已创建", details: true });
}

async function removeWorktree(repo, path) {
  const confirmed = await confirmDestructive({
    title: "删除工作树",
    message: "从仓库注销工作树 " + path + "？",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  if (String(path).startsWith("-")) {
    toast("工作树路径不能以 - 开头", "error");
    return { ok: false };
  }
  return perform(repo, "删除工作树", async () => {
    let res = await runGit(repo, ["worktree", "remove", "--", path], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0 && /modified|untracked|--force/i.test(res.stderr || "")) {
      const force = await confirmDestructive({
        title: "强制删除工作树",
        message: "该工作树含未提交的更改或未跟踪文件，强制删除会丢失这些内容。继续？",
        confirmLabel: "强制删除",
        danger: true,
      });
      if (!force) return { canceled: true };
      res = await runGit(repo, ["worktree", "remove", "--force", path], {
        allowFailure: true,
        timeoutMs: 60000,
      });
    }
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    return { canceled: false };
  }, { success: "工作树已删除", details: true });
}

async function pruneWorktrees(repo) {
  return perform(repo, "清理工作树", async () => {
    const res = await runGit(repo, ["worktree", "prune"], { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "工作树已清理", details: true });
}

/* ---------- 配置 ---------- */

async function loadConfig(repo) {
  const data = ensureRepoData(repo);
  data.config = { loading: true, text: "", entries: [], error: null };
  notify();
  try {
    const res = await runGit(repo, ["config", "--list", "--show-origin"], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    const text = maskSecrets(res.stdout);
    data.config = { loading: false, text, entries: splitLines(text), error: null };
  } catch (error) {
    data.config = { loading: false, text: "", entries: [], error: safeError(error) };
  }
  notify();
}

async function setConfigDialog(repo) {
  const values = await promptDialog({
    title: "修改 Git 配置",
    description: "例如 user.name、user.email、core.autocrlf；写入仓库本地配置。",
    fields: [
      { key: "key", label: "键", placeholder: "user.name" },
      { key: "value", label: "值", placeholder: "", optional: true },
      { key: "global", label: "写入全局配置（--global）", type: "checkbox", value: false },
    ],
    confirmLabel: "保存",
  });
  if (!values || !values.key) return { ok: false };
  const configKey = String(values.key).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)*$/.test(configKey)) {
    toast("配置键格式无效，例如 user.name", "error");
    return { ok: false };
  }
  return perform(repo, "修改 Git 配置", async () => {
    const args = ["config"];
    if (values.global) args.push("--global");
    args.push("--", configKey, values.value);
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: 30000 });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    await loadConfig(repo);
  }, { success: "配置已保存", refresh: false });
}

/* ---------- 控制台 ---------- */

async function runConsoleCommand(repo, input) {
  const parsed = splitCommandLine(input);
  // 用户常直接粘贴 `git status`：去掉可选的 git 前缀，避免拼成 `git ... git status`。
  const args = parsed.length && parsed[0].toLowerCase() === "git" ? parsed.slice(1) : parsed;
  if (!args.length) return { ok: false };
  return perform(repo, "执行 git " + args[0], async () => {
    const res = await runGit(repo, args, { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS });
    if (res.code !== 0) {
      // 控制台允许失败：错误已记录在输出里，不弹二次错误
      return { code: res.code, output: res.stdout, error: res.stderr };
    }
    return { code: 0, output: res.stdout, error: res.stderr };
  }, { refresh: true, details: true, log: true, errorPrefix: "命令失败" });
}

/* ===== 30-ui-base.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：插件样式、图标、基础组件（按钮/输入/弹窗/toast/标签页）。
 * 所有类名以 cg- 前缀，避免污染宿主；颜色全部走宿主语义 token。
 * ------------------------------------------------------------------------- */

const PLUGIN_CSS = `
/* ---------- 设计令牌：只作用于插件挂载点，不污染宿主 ---------- */
.cg-root,.cg-panel,.cg-overlay,.cg-menu,.cg-toasts{
  --cg-radius-lg:0.875rem;--cg-radius:0.625rem;--cg-radius-sm:0.5rem;
  /* 布局尺寸统一走 rem / clamp，跟随宿主根字号缩放；窄窗口不产生横向溢出。 */
  --cg-rail-w:clamp(12rem,22vw,20rem);
  --cg-line-no:2.75rem;
  --cg-diff-head:2.25rem;
  --cg-border:var(--color-separator-border);
  --cg-surface:var(--color-background-primary-default);
  --cg-surface-2:var(--color-background-secondary-default);
  --cg-hover:var(--color-background-secondary-hover);
  --cg-accent:var(--color-accent-500);
  --cg-accent-text:var(--color-accent-600);
  /* 先给不支持 color-mix 的旧 WebView 一个实色回退，现代浏览器用后一条覆盖。 */
  --cg-accent-soft:var(--cg-surface-2);
  --cg-accent-soft:color-mix(in srgb,var(--color-accent-500) 12%,transparent);
  --cg-accent-softer:var(--cg-surface-2);
  --cg-accent-softer:color-mix(in srgb,var(--color-accent-500) 6%,transparent);
  --cg-shadow:var(--shadow-card);
}
.dark .cg-root,.dark .cg-panel,.dark .cg-overlay,.dark .cg-menu,.dark .cg-toasts{--cg-accent-text:var(--color-accent-400)}
.cg-root *,.cg-panel *,.cg-overlay *,.cg-menu *,.cg-toasts *{box-sizing:border-box}
.cg-root button,.cg-panel button,.cg-overlay button,.cg-menu button,.cg-toasts button{font:inherit;color:inherit}
.cg-root svg,.cg-panel svg{flex:none}
.cg-root :focus-visible,.cg-panel :focus-visible,.cg-overlay :focus-visible,.cg-menu :focus-visible{outline:2px solid var(--cg-accent);outline-offset:1px}

/* ---------- 外壳 ---------- */
.cg-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--cg-surface);color:var(--color-text-primary);font-family:var(--font-sans);font-size:0.8125rem;line-height:1.5;letter-spacing:.005em;overflow:hidden;-webkit-font-smoothing:antialiased}
.cg-workbench-modal{position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;overscroll-behavior:contain;pointer-events:auto;isolation:isolate;background:var(--color-background-secondary-default);color:var(--color-text-primary);font-family:var(--font-sans);font-size:0.8125rem;line-height:1.5}
/* 宿主 PluginOverlayHost 是 pointer-events:none 的 fixed 容器、z-index:auto，
 * 会把插件内部任何 z-index 困在自身层叠上下文里；右侧页签等宿主 chrome 带
 * relative z-10 就会透上来。借宿主注入的 unlayered 样式把“包含全屏弹窗的
 * 覆盖层容器”抬到页面壳层级（宿主同层是 z-100，模态 z-110 / 菜单 z-120
 * 仍在其上，toast z-105 保持在弹窗上方）。两个选择器分别覆盖全屏工作台与
 * 独立确认框（设置页等无工作台场景），都不匹配时零开销。 */
[data-plugin-overlay-host]:has(.cg-workbench-modal){z-index:100}
[data-plugin-overlay-host]:has(.cg-dialog){z-index:100}
/* 不支持 :has() 的 WebView 由 OverlayHost 在打开工作台/对话框时给宿主容器加类。 */
[data-plugin-overlay-host].cg-overlay-raised{z-index:100}
.cg-workbench-modal>.cg-root{flex:1;width:100%;min-width:0}
.cg-workbench-close{flex:none}
.cg-header{display:flex;align-items:center;gap:0.625rem;padding:0.5rem 0.75rem 0.5rem 0.875rem;border-bottom:1px solid var(--cg-border);flex:none;flex-wrap:wrap;min-height:3.25rem;background:var(--cg-surface)}
.cg-header-title{display:flex;align-items:center;gap:0.5rem;font-size:0.8125rem;font-weight:600;min-width:0}
.cg-header-title>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-brand{display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;flex:none;border-radius:0.5rem;background:var(--cg-accent-soft);color:var(--cg-accent-text)}
.cg-header-spacer{flex:1}
.cg-header-sep{width:1px;height:1.25rem;background:var(--cg-border);flex:none;margin:0 2px}
.cg-header-actions{display:flex;align-items:center;gap:0.25rem}
.cg-repo-select{max-width:min(13.75rem,45vw);height:2rem;background:transparent;border-color:transparent;font-weight:600}
.cg-repo-select:hover{border-color:var(--cg-border)}
.cg-branch{display:inline-flex;align-items:center;gap:0.375rem;height:1.75rem;padding:0 0.625rem;border-radius:0.5rem;background:var(--cg-surface-2);color:var(--color-text-secondary);max-width:min(17.5rem,45vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem}
.cg-branch b{font-weight:600;font-size:0.75rem;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis}
.cg-ahead{color:var(--color-state-success-text);font-size:0.6875rem;font-weight:600}
.cg-behind{color:var(--color-text-warning-primary);font-size:0.6875rem;font-weight:600}

/* ---------- 仓库侧栏 ---------- */
.cg-body{flex:1;min-height:0;display:flex;background:var(--cg-surface)}
.cg-rail{flex:0 0 var(--cg-rail-w);width:auto;border-right:1px solid var(--cg-border);display:flex;flex-direction:column;min-height:0;background:var(--cg-surface-2);overflow:hidden}
.cg-rail-head{display:flex;align-items:center;gap:0.625rem;padding:0 0.625rem 0 0.875rem;border-bottom:1px solid var(--cg-border);min-height:3.25rem;flex:none}
.cg-rail-title{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;line-height:1.3}
.cg-rail-title b{font-size:0.8125rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-rail-title span{font-size:0.7188rem;color:var(--color-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-rail-list{overflow:auto;padding:0.5rem;min-height:0;flex:1;display:flex;flex-direction:column;gap:2px}
.cg-rail-group{display:flex;align-items:center;gap:0.375rem;padding:0.875rem 0.625rem 0.375rem;font-size:0.6875rem;font-weight:650;letter-spacing:.05em;color:var(--color-text-tertiary)}
.cg-rail-group:first-child{padding-top:0.25rem}
.cg-rail-foot{border-top:1px solid var(--cg-border);padding:0.5rem 0.625rem;display:flex;align-items:center;gap:0.25rem;flex-wrap:wrap;flex:none}
.cg-repo{position:relative;display:flex;align-items:center;gap:0.625rem;width:100%;text-align:left;min-height:3.25rem;padding:0.5rem 0.625rem 0.5rem 0.75rem;border:0;border-radius:0.5rem;background:transparent;cursor:pointer;color:var(--color-text-primary);transition:background 100ms ease}
.cg-repo:hover{background:var(--cg-hover)}
.cg-repo.cg-active{background:var(--cg-accent-soft)}
.cg-repo.cg-active .cg-repo-name,.cg-repo.cg-active .cg-repo-icon{color:var(--cg-accent-text)}
.cg-repo-icon{flex:none;color:var(--color-foreground-icon-secondary,var(--color-text-tertiary))}
.cg-repo-main{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1rem}
.cg-repo-name{font-size:0.7813rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-repo-sub{color:var(--color-text-tertiary);font-size:0.6875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-repo-dirty{flex:none;min-width:1.125rem;height:1.125rem;padding:0 0.3125rem;border-radius:0.5625rem;background:var(--cg-surface);border:1px solid var(--cg-border);color:var(--color-text-secondary);font-size:0.6563rem;font-weight:600;display:inline-flex;align-items:center;justify-content:center}

/* ---------- 主区域 / 页签 ---------- */
.cg-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--cg-surface);overflow:hidden}
.cg-tabs{display:flex;align-items:center;gap:2px;padding:0 0.625rem;border-bottom:1px solid var(--cg-border);flex:none;overflow-x:auto;height:2.75rem;background:var(--cg-surface)}
.cg-tab{position:relative;height:1.875rem;border:0;background:transparent;padding:0 0.625rem;border-radius:0.5rem;cursor:pointer;color:var(--color-text-secondary);white-space:nowrap;display:inline-flex;align-items:center;gap:0.375rem;font-size:0.8125rem;font-weight:500;transition:background 100ms ease,color 100ms ease}
.cg-tab:hover{background:var(--cg-hover);color:var(--color-text-primary)}
.cg-tab.cg-active{color:var(--color-text-primary);font-weight:600;background:var(--cg-surface-2)}
.cg-tab.cg-active::after{content:"";position:absolute;left:0.625rem;right:0.625rem;bottom:-0.4375rem;height:2px;border-radius:2px;background:var(--cg-accent)}
.cg-tab-cnt{background:var(--cg-surface-2);background:color-mix(in srgb,var(--color-text-tertiary) 16%,transparent);border-radius:999px;padding:0 0.375rem;font-size:0.6563rem;font-weight:600;line-height:1rem;color:var(--color-text-secondary)}
.cg-tab.cg-active .cg-tab-cnt{background:var(--cg-accent-soft);color:var(--cg-accent-text)}
.cg-tabs-sep{width:1px;height:1.125rem;background:var(--cg-border);margin:0 0.375rem;flex:none}
.cg-tab.cg-tab-sub{font-size:0.75rem;height:1.75rem;padding:0 0.5rem;color:var(--color-text-tertiary)}
.cg-tab.cg-tab-sub.cg-active{color:var(--color-text-primary)}
.cg-tab.cg-tab-sub.cg-active::after{bottom:-0.5rem}
.cg-content{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--cg-surface)}
.cg-toolbar{display:flex;align-items:center;gap:0.375rem;padding:0.375rem 0.75rem;border-bottom:1px solid var(--cg-border);flex-wrap:wrap;flex:none;min-height:2.75rem;background:var(--cg-surface)}
.cg-toolbar b{font-size:0.8125rem;font-weight:600}
.cg-toolbar .cg-filter-input{flex:0 1 10rem;min-width:6rem;width:auto}
.cg-toolbar .cg-filter-select{flex:0 1 5rem;min-width:4.5rem;width:auto}
.cg-toolbar .cg-input,.cg-toolbar .cg-select{height:1.75rem}
.cg-toolbar-spacer{flex:1}
.cg-tgroup{display:inline-flex;align-items:center;gap:2px}
.cg-tgroup+.cg-tgroup{padding-left:0.375rem;margin-left:2px;border-left:1px solid var(--cg-border)}
.cg-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:0.5rem;background:var(--cg-surface-2);flex:none}
.cg-seg>button{height:1.5rem;border:0;background:transparent;padding:0 0.5rem;border-radius:0.375rem;cursor:pointer;color:var(--color-text-secondary);font-size:0.75rem;display:inline-flex;align-items:center;gap:0.3125rem}
.cg-seg>button:hover{color:var(--color-text-primary)}
.cg-seg>button.cg-on{background:var(--cg-surface);color:var(--color-text-primary);box-shadow:var(--shadow-xs,0 1px 2px rgba(0,0,0,.06));font-weight:600}
.cg-search{position:relative;display:flex;align-items:center;flex:1 1 7.5rem;min-width:6rem}
.cg-search>svg{position:absolute;left:0.5rem;color:var(--color-text-tertiary);pointer-events:none}
.cg-search>.cg-input{width:100%;padding-left:1.75rem;height:1.75rem}
.cg-btn{display:inline-flex;align-items:center;justify-content:center;gap:0.375rem;height:2rem;padding:0 0.75rem;border:1px solid var(--cg-border);background:var(--cg-surface);border-radius:0.5rem;cursor:pointer;white-space:nowrap;font-size:0.8125rem;font-weight:500;color:var(--color-text-primary);transition:background 100ms ease,border-color 100ms ease}
.cg-btn:hover:not(:disabled){background:var(--cg-hover);border-color:var(--color-border-button-hover)}
.cg-btn:disabled{opacity:.45;cursor:not-allowed}
.cg-btn.cg-primary{background-image:var(--gradient-button-primary-default,linear-gradient(180deg,#3b82f6,#2563eb));border-color:transparent;color:var(--color-text-white);box-shadow:var(--cg-shadow)}
.cg-btn.cg-primary:hover:not(:disabled){background-image:var(--gradient-button-primary-hover,linear-gradient(180deg,#60a5fa,#3b82f6))}
.cg-btn.cg-primary:disabled{background-image:var(--gradient-button-primary-disabled,linear-gradient(180deg,#ebebeb,#d4d4d4));color:var(--color-button-primary-disabled-foreground);box-shadow:none}
.cg-btn.cg-danger{color:var(--color-text-error-primary);border-color:var(--color-border-error-default);background:transparent}
.cg-btn.cg-danger:hover:not(:disabled){background:var(--color-background-tertiary-error)}
.cg-btn.cg-ghost{border-color:transparent;background:transparent;color:var(--color-text-secondary)}
.cg-btn.cg-ghost:hover:not(:disabled){background:var(--cg-hover);color:var(--color-text-primary)}
.cg-btn.cg-sm{height:1.75rem;padding:0 0.625rem;font-size:0.75rem;border-radius:0.4375rem;gap:0.3125rem}
.cg-btn.cg-xs{height:1.5rem;padding:0 0.5rem;font-size:0.75rem;border-radius:0.375rem;gap:0.25rem}
.cg-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;border:0;background:transparent;border-radius:0.4375rem;padding:0;cursor:pointer;color:var(--color-foreground-icon-secondary,var(--color-text-secondary));transition:background 100ms ease,color 100ms ease;flex:none}
.cg-iconbtn:hover:not(:disabled){background:var(--cg-hover);color:var(--color-text-primary)}
.cg-iconbtn.cg-on{background:var(--cg-accent-soft);color:var(--cg-accent-text)}
.cg-iconbtn:disabled{opacity:.35;cursor:not-allowed}
.cg-input,.cg-select,.cg-textarea{border:1px solid var(--cg-border);background:var(--cg-surface);color:var(--color-text-primary);border-radius:0.5rem;padding:0 0.625rem;min-width:0;outline:none;font:inherit;font-size:0.8125rem;transition:border-color 100ms ease,box-shadow 100ms ease}
.cg-input,.cg-select{height:2rem}
.cg-select{padding-right:1.625rem}
.cg-textarea{padding:0.5rem 0.625rem;resize:vertical;font-size:0.8125rem;line-height:1.55}
.cg-input:hover,.cg-select:hover,.cg-textarea:hover{border-color:var(--color-border-button-hover)}
.cg-input:focus,.cg-select:focus,.cg-textarea:focus{border-color:var(--color-border-focus-ring);box-shadow:0 0 0 3px var(--cg-accent-soft)}
.cg-check{display:inline-flex;align-items:center;gap:0.375rem;cursor:pointer;user-select:none;white-space:nowrap;font-size:0.75rem;color:var(--color-text-secondary)}
.cg-check:hover{color:var(--color-text-primary)}
.cg-check input{accent-color:var(--color-accent-500);margin:0;width:0.875rem;height:0.875rem}
.cg-badge.cg-add{background:var(--color-status-lime-background);color:var(--color-status-lime-text)}
.cg-badge{display:inline-flex;align-items:center;justify-content:center;min-width:1.125rem;height:1.125rem;padding:0 0.3125rem;border-radius:0.3125rem;font-size:0.6563rem;font-weight:600;letter-spacing:.02em;background:var(--color-background-tertiary-default);color:var(--color-text-secondary);flex:none}
.cg-badge.cg-del{background:var(--color-status-rose-background);color:var(--color-status-rose-text)}
.cg-badge.cg-mod{background:var(--color-status-yellow-background);color:var(--color-status-yellow-text)}
.cg-badge.cg-move{background:var(--color-status-cyan-background);color:var(--color-status-cyan-text)}
.cg-badge.cg-conflict{background:var(--color-status-rose-background);color:var(--color-status-rose-text)}
.cg-badge.cg-neutral{background:var(--color-badge-neutral-background);color:var(--color-text-secondary)}
.cg-spacer{flex:1}
.cg-muted{color:var(--color-text-tertiary)}
.cg-dim{color:var(--color-text-secondary)}
.cg-mono{font-family:var(--font-mono);font-size:.96em}
.cg-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-spin{animation:cg-spin 1s linear infinite;display:inline-flex}
@keyframes cg-spin{to{transform:rotate(360deg)}}

/* ---------- 空态 / 提示条 ---------- */
.cg-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5rem;color:var(--color-text-tertiary);padding:2rem;text-align:center;min-height:8.75rem}
.cg-empty>svg{width:2.25rem;height:2.25rem;padding:0.5625rem;border-radius:0.625rem;background:var(--cg-surface-2);color:var(--color-foreground-icon-secondary,var(--color-text-tertiary))}
.cg-empty span{font-size:0.75rem;color:var(--color-text-tertiary);max-width:min(22.5rem,100%)}
.cg-banner{display:flex;align-items:center;gap:0.625rem;padding:0.5625rem 0.875rem;border-bottom:1px solid var(--cg-border);background:var(--color-background-tertiary-warning);color:var(--color-text-warning-primary);flex:none;font-size:0.75rem}
.cg-banner.cg-error{background:var(--color-background-tertiary-error);color:var(--color-text-error-primary)}
.cg-banner.cg-info{background:var(--cg-accent-softer);color:var(--color-text-secondary)}
.cg-banner-body{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.cg-banner-actions{display:flex;gap:0.25rem;align-items:center;flex:none}
.cg-notice{padding:0.875rem;color:var(--color-text-tertiary);font-size:0.75rem;text-align:center}
.cg-notice.cg-scan-error{color:var(--color-text-error-primary);white-space:pre-wrap;word-break:break-word}
.cg-notice.cg-scan-warn{color:var(--color-text-warning-primary);padding-top:0}
.cg-notice.cg-notice-tight{padding:0.625rem 0.75rem;text-align:left}
.cg-truncated{padding:0.4375rem 0.75rem;color:var(--color-text-warning-primary);font-size:0.7188rem;border-top:1px solid var(--cg-border)}
.cg-mini{font-size:0.6875rem}

/* ---------- 本地更改 ---------- */
.cg-changes{flex:1;min-height:0;display:flex;flex-direction:column}
.cg-changes-top{flex:1;min-height:0;display:flex}
.cg-filecol{flex:0 1 38%;width:auto;min-width:min(17.5rem,45%);max-width:56%;border-right:1px solid var(--cg-border);display:flex;flex-direction:column;min-height:0;background:var(--cg-surface);overflow:hidden}
.cg-filecol>.cg-toolbar{padding:0.375rem 0.5rem 0.375rem 0.75rem;min-height:2.75rem}
.cg-diffcol{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--cg-surface);overflow:hidden}
.cg-filterbar{display:flex;align-items:center;gap:0.375rem;padding:0.375rem 0.5rem;border-bottom:1px solid var(--cg-border);flex:none}
.cg-files{overflow:auto;min-height:0;flex:1;padding:2px 0 0.5rem;display:flex;flex-direction:column;outline:none}
.cg-group{flex:none}
.cg-group-head{display:flex;align-items:center;gap:0.375rem;height:1.875rem;padding:0 0.5rem 0 0.625rem;background:var(--cg-surface);cursor:pointer;user-select:none;position:sticky;top:0;z-index:1}
.cg-group-head:hover{background:var(--cg-hover)}
.cg-group-head b{font-weight:600;font-size:0.7188rem;color:var(--color-text-secondary)}
.cg-group-title{flex:1;display:flex;align-items:center;gap:0.375rem;min-width:0}
.cg-group-head .cg-row-actions{display:none}
.cg-group-head:hover .cg-row-actions{display:inline-flex}
.cg-row{display:flex;align-items:center;gap:0.375rem;height:1.75rem;padding:0 0.5rem 0 0.625rem;cursor:pointer;min-width:0;border-radius:0.375rem;margin:0 0.25rem;font-size:0.8125rem;transition:background 80ms ease}
.cg-row:hover{background:var(--cg-hover)}
.cg-row.cg-selected{background:var(--cg-accent-soft)}
.cg-row.cg-cursor{box-shadow:inset 0 0 0 1px var(--color-border-focus-ring)}
.cg-row.cg-tree-row{margin:0 0.25rem}
.cg-row-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-row-dir{flex:1;color:var(--color-text-tertiary);font-size:0.7188rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cg-row-actions{display:none;align-items:center;gap:1px;flex:none}
.cg-row:hover .cg-row-actions,.cg-row.cg-selected .cg-row-actions{display:inline-flex}
.cg-row-check{margin:0;accent-color:var(--color-accent-500);flex:none;width:0.875rem;height:0.875rem}
.cg-chev{display:inline-flex;width:0.875rem;flex:none;color:var(--color-text-tertiary);cursor:pointer}
.cg-row .cg-iconbtn,.cg-group-head .cg-iconbtn{width:1.375rem;height:1.375rem;border-radius:0.3125rem}
.cg-commitbox{position:relative;flex:none;border-top:1px solid var(--cg-border);padding:0.625rem 0.75rem;display:flex;flex-direction:column;gap:0.5rem;background:var(--cg-surface-2)}
.cg-commitbox textarea{width:100%;min-height:4rem;max-height:12.5rem;font-family:var(--font-sans);font-size:0.8125rem;background:var(--cg-surface)}
.cg-commit-row1{display:flex;align-items:center;gap:0.375rem;min-width:0}
.cg-commit-row1 .cg-select{height:1.75rem;font-size:0.75rem}
.cg-subject-len{font-family:var(--font-mono);color:var(--color-text-tertiary);white-space:nowrap}
.cg-subject-len.cg-warn{color:var(--color-text-warning-primary)}
.cg-subject-len.cg-over{color:var(--color-text-error-primary)}
/* 提交框内的弹出菜单相对提交框定位，不再依赖固定像素偏移。 */
.cg-menu.cg-commit-pop{position:absolute;right:0;bottom:calc(100% + 0.25rem);max-height:min(16rem,50vh);overflow:auto;min-width:min(13.75rem,80vw)}
.cg-menu.cg-commit-opts{display:flex;flex-direction:column;align-items:stretch;gap:2px;padding:0.375rem 0.625rem;min-width:min(13.75rem,80vw)}
.cg-menu.cg-commit-opts .cg-check{height:1.75rem}
.cg-commit-actions{display:flex;align-items:center;gap:0.375rem;flex-wrap:wrap}
.cg-commit-actions .cg-spacer{flex:1}
.cg-commit-actions .cg-muted{font-size:0.6875rem}

/* ---------- 差异 ---------- */
.cg-diff{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--cg-surface)}
.cg-diff-head{display:flex;align-items:center;gap:0.5rem;padding:0.5625rem 0.875rem;border-bottom:1px solid var(--cg-border);flex-wrap:wrap;flex:none;background:var(--cg-surface)}
.cg-diff-head-title{font-family:var(--font-mono);font-size:0.7188rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.cg-diff-body{flex:1;min-height:0;overflow:auto;font-family:var(--font-mono);font-size:0.75rem;line-height:1.72;background:var(--cg-surface)}
.cg-diff-file{border-bottom:1px solid var(--cg-border)}
.cg-diff-file-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:0.5rem;min-height:var(--cg-diff-head);padding:0.25rem 0.75rem;background:var(--cg-surface);font-weight:600;font-size:0.75rem;font-family:var(--font-sans);border-bottom:1px solid var(--cg-border)}
.cg-hunk-head{display:flex;align-items:center;gap:0.5rem;min-height:1.875rem;padding:2px 0.5rem 2px 0.75rem;background:var(--cg-surface-2);color:var(--color-text-tertiary);border-top:1px solid var(--cg-border);border-bottom:1px solid var(--cg-border);position:sticky;top:var(--cg-diff-head);z-index:1;font-size:0.6875rem}
.cg-hunk-head .cg-mono{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-hunk{display:flex;flex-direction:column;min-width:0}
.cg-hunk-body{overflow:auto;scrollbar-width:auto}
.cg-hunk-inner{display:inline-block;min-width:100%;vertical-align:top}
.cg-split-grid{display:grid;grid-template-columns:minmax(max-content,1fr) minmax(max-content,1fr);min-width:100%}
.cg-split-grid .cg-split-row{display:contents}
.cg-hunk-body::-webkit-scrollbar{width:0.625rem;height:0.625rem}
.cg-hunk-body::-webkit-scrollbar-track{background:transparent}
.cg-hunk-body::-webkit-scrollbar-thumb{background:var(--cg-border);border-radius:0.375rem}
.cg-hunk-body::-webkit-scrollbar-thumb:hover{background:var(--color-text-tertiary)}
.cg-hunk-head .cg-btn{opacity:.75}
.cg-hunk-head:hover .cg-btn{opacity:1}
.cg-dline{display:flex;min-width:max-content;white-space:pre}
.cg-dline:hover{background:var(--cg-hover)}
.cg-ln,.cg-ln2{box-sizing:border-box;width:var(--cg-line-no);flex:none;text-align:right;padding-right:0.5rem;color:var(--color-text-tertiary);user-select:none;font-size:0.6875rem;position:sticky;left:0;z-index:1;background:var(--cg-surface)}
.cg-ln2{left:var(--cg-line-no);margin-right:0.5rem}
.cg-split-cell .cg-ln{position:static;left:auto}
.cg-dline:hover .cg-ln,.cg-dline:hover .cg-ln2{background:var(--cg-hover)}
.cg-code{white-space:pre;padding-right:1.75rem}
.cg-add{background:var(--color-status-lime-background);background:color-mix(in srgb,var(--color-status-lime-background) 45%,transparent)}
.cg-add .cg-ln,.cg-add .cg-ln2{background:var(--color-status-lime-background);background:color-mix(in srgb,var(--color-status-lime-background) 80%,var(--cg-surface))}
.cg-del{background:var(--color-status-rose-background);background:color-mix(in srgb,var(--color-status-rose-background) 40%,transparent)}
.cg-del .cg-ln,.cg-del .cg-ln2{background:var(--color-status-rose-background);background:color-mix(in srgb,var(--color-status-rose-background) 75%,var(--cg-surface))}
.cg-note{color:var(--color-text-tertiary);font-style:italic}
.cg-preview-line{display:flex;min-width:max-content}
.cg-preview-line .cg-code{white-space:pre}
.cg-pickable{cursor:pointer}
.cg-pickable:hover{color:var(--color-text-primary);opacity:1;text-decoration:underline}
.cg-picked,.cg-picked .cg-ln,.cg-picked .cg-ln2{background:var(--cg-hover);background:color-mix(in srgb,var(--color-accent-500) 18%,transparent)}
.cg-picked .cg-ln,.cg-picked .cg-ln2{color:var(--cg-accent-text);font-weight:600;opacity:1}
.cg-split-row{display:grid;grid-template-columns:minmax(max-content,1fr) minmax(max-content,1fr);min-width:100%}
.cg-split-cell{display:flex;min-width:max-content;white-space:pre}
.cg-split-cell+.cg-split-cell{border-left:1px solid var(--cg-border)}
.cg-split-cell .cg-ln{margin-right:0.5rem}
.cg-split-cell .cg-code{overflow:hidden;text-overflow:ellipsis}
.cg-split-empty{background:var(--cg-surface-2)}
.cg-split-row:hover .cg-split-cell:not(.cg-add):not(.cg-del):not(.cg-split-empty){background:var(--cg-hover)}

/* ---------- 提交图 ---------- */
.cg-log{flex:1;min-height:0;display:flex;background:var(--cg-surface)}
.cg-log-list{flex:0 1 56%;width:auto;min-width:min(18.75rem,45%);max-width:70%;border-right:1px solid var(--cg-border);display:flex;flex-direction:column;min-height:0;container-type:inline-size}
.cg-log-scroll{flex:1;overflow:auto;min-height:0;padding:0 0 2px}
.cg-commit-head{display:flex;align-items:center;gap:0.625rem;height:1.625rem;padding:0 0.75rem 0 0.5rem;font-size:0.6563rem;font-weight:650;letter-spacing:.04em;color:var(--color-text-tertiary);background:var(--cg-surface);border-bottom:1px solid var(--cg-border);position:sticky;top:0;z-index:1;flex:none}
.cg-commit-head-label{flex:1;min-width:0}
.cg-commit-row{display:flex;align-items:center;gap:0.625rem;height:1.875rem;padding:0 0.75rem 0 0.5rem;cursor:pointer;min-width:0;transition:background 100ms ease}
.cg-commit-row:hover{background:var(--cg-hover)}
.cg-commit-row.cg-selected{background:var(--cg-accent-soft);box-shadow:inset 2px 0 0 var(--cg-accent)}
.cg-commit-row.cg-is-head .cg-commit-subject{font-weight:600}
.cg-graph{flex:none;align-self:center}
.cg-commit-text{flex:1;min-width:0;display:flex;align-items:center;gap:0.4375rem}
.cg-commit-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.7813rem}
.cg-commit-meta{flex:none;color:var(--color-text-tertiary);font-size:0.6875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cg-commit-author{width:6rem}
.cg-commit-date{width:4.5rem;text-align:right;font-variant-numeric:tabular-nums}
.cg-commit-time{width:4.5rem;text-align:right}
.cg-commit-hash{width:3.875rem;text-align:right}
@container (max-width:35rem){.cg-commit-author{display:none}}
.cg-ref{display:inline-flex;align-items:center;gap:2px;height:1.125rem;padding:0 0.375rem;border-radius:0.375rem;font-size:0.625rem;font-weight:650;letter-spacing:.02em;max-width:min(10.625rem,45%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-ref.cg-head{background:var(--color-accent-500);color:var(--color-text-white)}
.cg-ref.cg-branch{background:var(--color-status-cyan-background);color:var(--color-status-cyan-text)}
.cg-ref.cg-tag{background:var(--color-status-yellow-background);color:var(--color-status-yellow-text)}
.cg-ref.cg-remote{background:var(--color-background-tertiary-default);color:var(--color-text-secondary)}
.cg-detail-head{padding:0.75rem 1rem;border-bottom:1px solid var(--cg-border);flex:none}
.cg-detail-subject-row{display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.5rem}
.cg-detail-subject{flex:1;min-width:0;font-size:0.875rem;font-weight:600;word-break:break-word}
.cg-detail-meta{display:grid;grid-template-columns:minmax(4rem,max-content) minmax(0,1fr);gap:0.25rem 0.625rem;color:var(--color-text-secondary);font-size:0.75rem}
.cg-detail-meta dt{color:var(--color-text-tertiary)}
.cg-detail-meta dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-detail-body{flex:none;white-space:pre-wrap;font-family:var(--font-mono);font-size:0.7188rem;padding:0.625rem 1rem;border-bottom:1px solid var(--cg-border);max-height:min(42vh,26rem);overflow:auto;background:var(--cg-surface-2);color:var(--color-text-secondary)}
.cg-detail-section{display:flex;align-items:center;gap:0.5rem;padding:0.4375rem 1rem;font-weight:650;font-size:0.6875rem;letter-spacing:.04em;color:var(--color-text-tertiary);background:var(--cg-surface-2);border-bottom:1px solid var(--cg-border);flex:none}
.cg-detail-files{flex:none;border-bottom:1px solid var(--cg-border);padding:2px 0}
.cg-log-detail{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:auto}
.cg-actions-row{display:flex;align-items:center;gap:0.375rem;padding:0.4375rem 0.75rem;border-bottom:1px solid var(--cg-border);flex-wrap:wrap;flex:none}

/* ---------- 通用列表 ---------- */
.cg-list{flex:1;overflow:auto;min-height:0;padding:0.5rem 0.625rem}
.cg-list-scroll{max-height:min(13.75rem,40vh);overflow:auto;flex:none}
.cg-list-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:0.5rem;padding:0.625rem 0.875rem;background:var(--cg-surface-2);border-bottom:1px solid var(--cg-border);font-weight:650;font-size:0.75rem}
.cg-list-row{display:flex;align-items:center;gap:0.625rem;padding:0.625rem 0.75rem;border:1px solid transparent;border-radius:0.625rem;margin:2px 0;min-width:0;transition:background 100ms ease}
.cg-list-row:hover{background:var(--cg-hover)}
.cg-list-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.cg-list-title{display:flex;align-items:center;gap:0.375rem;min-width:0}
.cg-list-title b{font-weight:650;font-size:0.7813rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-list-sub{color:var(--color-text-tertiary);font-size:0.6875rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-list-actions{display:flex;align-items:center;gap:1px;flex:none}
.cg-section-title{display:flex;align-items:center;gap:0.5rem;padding:0.6875rem 0.875rem;font-weight:650;font-size:0.6875rem;letter-spacing:.04em;color:var(--color-text-tertiary);background:var(--cg-surface-2);border-bottom:1px solid var(--cg-border);position:sticky;top:0;z-index:1}
.cg-section-toggle{cursor:pointer;user-select:none;-webkit-user-select:none}
.cg-section-toggle:hover{color:var(--color-text-secondary)}
.cg-section-actions{display:inline-flex;align-items:center;gap:0.125rem;margin-left:auto}
.cg-section-actions .cg-iconbtn{width:1.25rem;height:1.25rem;border-radius:0.3125rem}

/* ---------- 控制台 ---------- */
.cg-console{flex:1;min-height:0;display:flex;flex-direction:column}
.cg-console-input{display:flex;gap:0.625rem;padding:0.75rem 0.875rem;border-bottom:1px solid var(--cg-border);flex:none;align-items:center;background:var(--cg-surface-2)}
.cg-console-input .cg-input{flex:1;font-family:var(--font-mono)}
.cg-console-log{flex:1;overflow:auto;min-height:0;padding:0.75rem 0.875rem;font-family:var(--font-mono);font-size:0.7188rem}
.cg-console-entry{border:1px solid var(--cg-border);border-radius:0.625rem;padding:0.625rem 0.75rem;margin-bottom:0.625rem;background:var(--cg-surface)}
.cg-console-entry:last-child{margin-bottom:0}
.cg-console-cmd{display:flex;align-items:center;gap:0.4375rem;min-width:0}
.cg-console-cmd code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary)}
.cg-console-out{white-space:pre-wrap;word-break:break-word;color:var(--color-text-secondary);max-height:15rem;overflow:auto;padding:0.4375rem 0.5625rem;margin:0.3125rem 0 0;background:var(--cg-surface-2);border-radius:0.4375rem}
.cg-console-out.cg-err{color:var(--color-text-error-primary)}

/* ---------- 设置 ---------- */
.cg-settings{overflow:auto;padding:1.5rem 1.625rem 2rem;display:flex;flex-direction:column;gap:1.25rem;min-height:0;max-width:58.75rem;width:100%;margin:0 auto}
.cg-settings h3{margin:0.25rem 0 0;font-size:0.6875rem;font-weight:650;letter-spacing:.06em;color:var(--color-text-tertiary);padding-bottom:0.5rem;border-bottom:1px solid var(--cg-border)}
.cg-settings-sub{color:var(--color-text-tertiary);font-size:0.7188rem;line-height:1.6}
.cg-num{width:100%;max-width:6.25rem}
.cg-select-wide{width:100%;max-width:13.75rem}
.cg-kv{display:grid;grid-template-columns:minmax(7.5rem,12rem) minmax(0,1fr);gap:0.875rem 1.25rem;align-items:center;max-width:100%;padding:1rem;border:1px solid var(--cg-border);border-radius:0.75rem;background:var(--cg-surface)}
.cg-kv label{color:var(--color-text-secondary);font-size:0.7813rem}
.cg-kv-wide{grid-column:1/-1}
.cg-kv .cg-input,.cg-kv .cg-select{height:2rem}

/* ---------- 对话框 / 菜单 / Toast ---------- */
.cg-overlay{position:fixed;inset:0;background:var(--color-overlay-backdrop);display:flex;align-items:center;justify-content:center;padding:1.5rem;pointer-events:auto;backdrop-filter:blur(2px)}
.cg-workbench-modal .cg-overlay{z-index:2}
.cg-dialog{background:var(--cg-surface);border:1px solid var(--cg-border);border-radius:var(--cg-radius-lg);box-shadow:var(--shadow-xl);max-width:36.25rem;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden}
.cg-diff-modal{width:min(68.75rem,94vw);height:min(80vh,53.75rem);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;background:var(--cg-surface);border:1px solid var(--cg-border);border-radius:var(--cg-radius-lg);box-shadow:var(--shadow-xl)}
.cg-diff-modal-head{display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0.625rem 0.5rem 0.875rem;border-bottom:1px solid var(--cg-border);flex:none;min-height:2.5rem}
.cg-diff-modal-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.cg-dialog-head{padding:1.125rem 1.25rem 0.625rem;font-weight:650;font-size:0.875rem;display:flex;align-items:center;gap:0.625rem}
.cg-dialog-body{padding:0.5rem 1.25rem 0.375rem;overflow:auto;display:flex;flex-direction:column;gap:0.875rem}
.cg-dialog-desc{color:var(--color-text-secondary);white-space:pre-wrap;font-size:0.75rem;line-height:1.55}
.cg-dialog-detail{background:var(--cg-surface-2);border-radius:0.5rem;padding:0.5rem 0.625rem;font-family:var(--font-mono);font-size:0.6875rem;white-space:pre-wrap;max-height:11.25rem;overflow:auto;color:var(--color-text-secondary)}
.cg-dialog-field{display:flex;flex-direction:column;gap:0.3125rem}
.cg-dialog-field>label{font-size:0.75rem;color:var(--color-text-secondary)}
.cg-dialog-foot{padding:0.75rem 1.125rem;display:flex;justify-content:flex-end;gap:0.5rem;border-top:1px solid var(--cg-border);background:var(--cg-surface-2)}
.cg-menu{position:fixed;pointer-events:auto;background:var(--cg-surface);border:1px solid var(--cg-border);border-radius:0.6875rem;box-shadow:var(--shadow-lg);padding:0.375rem;min-width:min(12.5rem,90vw);max-width:min(21.25rem,90vw);max-height:min(80vh,30rem);overflow:auto}
.cg-menu button{display:flex;align-items:center;gap:0.5625rem;width:100%;text-align:left;border:0;background:transparent;border-radius:0.5rem;height:2rem;padding:0 0.625rem;cursor:pointer;font-size:0.7813rem;color:var(--color-text-primary);transition:background 100ms ease}
.cg-menu button:hover:not(:disabled){background:var(--cg-hover)}
.cg-menu button:disabled{opacity:.4;cursor:not-allowed}
.cg-menu button.cg-danger{color:var(--color-text-error-primary)}
.cg-menu hr{border:0;border-top:1px solid var(--cg-border);margin:0.25rem 2px}
.cg-toasts{position:fixed;right:1.125rem;bottom:1.125rem;display:flex;flex-direction:column;gap:0.5rem;max-width:min(26.875rem,calc(100vw - 2.25rem));pointer-events:auto}
.cg-toast{background:var(--cg-surface);border:1px solid var(--cg-border);border-left:3px solid var(--cg-accent);border-radius:0.6875rem;box-shadow:var(--shadow-lg);padding:0.625rem 0.75rem;display:flex;gap:0.5625rem;align-items:flex-start;font-size:0.75rem}
.cg-toast.cg-error{border-left-color:var(--color-border-error-default);color:var(--color-text-error-primary)}
.cg-toast.cg-success{border-left-color:var(--color-state-success-base)}
.cg-toast.cg-warning{border-left-color:var(--color-text-warning-primary)}
.cg-toast div{flex:1;white-space:pre-wrap;word-break:break-word}
.cg-workbench-modal .cg-menu{z-index:3}
.cg-workbench-modal .cg-toasts{z-index:4}

/* ---------- 状态栏 / 右侧面板 ---------- */
.cg-statusbar{flex:none;border-top:1px solid var(--cg-border);padding:0.125rem 0.75rem;display:flex;align-items:center;gap:0.875rem;color:var(--color-text-tertiary);font-size:0.6875rem;min-height:1.625rem;background:var(--cg-surface-2);overflow:hidden}
.cg-statusbar .cg-spacer{flex:1}
.cg-sb-item{display:inline-flex;align-items:center;gap:0.3125rem;min-width:0;white-space:nowrap}
.cg-sb-path{max-width:40%;flex-shrink:1}
.cg-sb-dot{width:0.375rem;height:0.375rem;border-radius:50%;background:var(--color-state-success-text);flex:none}
.cg-sb-busy{color:var(--color-text-secondary)}
.cg-sb-warn{color:var(--color-text-warning-primary)}
.cg-sb-error{color:var(--color-text-error-primary)}
.cg-bar{height:2px;background:var(--color-accent-500);animation:cg-indeterminate 1.2s ease-in-out infinite;transform-origin:left}
@keyframes cg-indeterminate{0%{transform:scaleX(.15)}50%{transform:scaleX(.6)}100%{transform:scaleX(.15)}}
.cg-panel-glyph{font-family:var(--font-sans);font-size:var(--text-body-2-medium,0.8125rem);font-weight:var(--text-body-2-medium--font-weight,500);line-height:var(--text-body-2-medium--line-height,1.125rem);white-space:nowrap}
.cg-panel-glyph-text{overflow:hidden;text-overflow:ellipsis}
.cg-panel{height:100%;display:flex;flex-direction:column;overflow:hidden;font-family:var(--font-sans);font-size:0.8125rem;line-height:1.5;color:var(--color-text-primary);background:var(--cg-surface)}
.cg-section-wsname{flex:1;min-width:0;font-weight:400;letter-spacing:0;opacity:.75}
.cg-panel-card{flex:none;margin:0.375rem 0.625rem 0.5rem;border:1px solid var(--cg-border);border-radius:0.625rem;background:var(--cg-surface-2);overflow:hidden}
.cg-panel-card>.cg-panel-summary{padding:0.4375rem 0.75rem;border-bottom:0}
.cg-panel-summary{display:flex;flex-direction:column;gap:0.125rem;padding:0.375rem 0.875rem;border-bottom:1px solid var(--cg-border);line-height:1.35}
.cg-summary-row{display:flex;align-items:center;gap:0.75rem;min-width:0;font-size:0.875rem;color:var(--color-text-tertiary)}
.cg-summary-counts{flex-wrap:wrap;gap:0.125rem 0.875rem;font-size:0.6875rem}
.cg-summary-item{display:inline-flex;align-items:center;gap:0.1875rem;white-space:nowrap}
.cg-summary-item b{font-size:0.875rem;font-weight:650;color:var(--color-text-primary);font-variant-numeric:tabular-nums}
.cg-summary-counts .cg-summary-item b{font-size:0.6875rem}
.cg-summary-branch{min-width:0;max-width:12rem;gap:0.25rem;color:var(--color-text-primary)}
.cg-summary-branch b{max-width:9rem;font-size:0.9375rem;font-weight:700}
.cg-summary-repo{margin-left:auto;min-width:0;max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-secondary);font-size:0.6875rem;font-weight:400}
.cg-panel-list{flex:1;overflow:auto;min-height:0;padding:0 0.625rem 0.75rem}
/* 仓库区最多占面板高度 45%，不按行数写死高度。 */
.cg-panel-list.cg-panel-repos{flex:0 1 auto;max-height:min(8.5rem,45%);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}

/* ---------- 分支 / 暂存分隔视图 ---------- */
.cg-split{flex:1;min-height:0;display:flex}
.cg-stash-diff{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.cg-branch-cols{display:flex;flex:1;min-height:0}
.cg-branch-list{flex:1;min-width:0;overflow:auto;min-height:0;padding:0.375rem 0.5rem}
.cg-compare{flex:0 1 44%;width:auto;min-width:min(17.5rem,40%);border-left:1px solid var(--cg-border);display:flex;flex-direction:column;min-height:0}
.cg-compare-body{flex:1;overflow:auto;min-height:0;padding:0.625rem 0.75rem}
.cg-compare h4{margin:0.75rem 0 0.375rem;font-size:0.6875rem;font-weight:650;letter-spacing:.04em;color:var(--color-text-tertiary)}
.cg-blame{flex:1;overflow:auto;min-height:0;font-family:var(--font-mono);font-size:0.7188rem}
.cg-blame-row{display:flex;min-width:max-content;align-items:stretch}
.cg-blame-row:hover{background:var(--cg-hover)}
.cg-blame-meta{width:min(18.75rem,45%);flex:none;display:flex;gap:0.4375rem;align-items:center;padding:0 0.625rem;border-right:1px solid var(--cg-border);overflow:hidden;white-space:nowrap;color:var(--color-text-tertiary);font-size:0.6875rem}
.cg-blame-ln{width:3.25rem;flex:none;text-align:right;padding-right:0.625rem;color:var(--color-text-tertiary);user-select:none}
.cg-blame-code{padding-left:0.625rem;white-space:pre}

/* ---------- 杂项 ---------- */
.cg-kbd{font-family:var(--font-mono);font-size:0.625rem;border:1px solid var(--cg-border);border-radius:0.3125rem;padding:1px 0.3125rem;color:var(--color-text-tertiary);background:var(--cg-surface-2)}
.cg-file-dot{width:0.4375rem;height:0.4375rem;border-radius:999px;flex:none}
.cg-hr{border:0;border-top:1px solid var(--cg-border);margin:0}
.cg-wrap{white-space:pre-wrap;word-break:break-word}
.cg-hidden{display:none!important}
@media (max-width:51.25rem){.cg-rail{flex-basis:clamp(11rem,30vw,14rem)}.cg-filecol{flex-basis:50%;min-width:min(15rem,45%)}.cg-settings{padding:1.125rem}.cg-kv{grid-template-columns:minmax(6rem,10rem) minmax(0,1fr)}}
`;

/* ---------- 图标 ---------- */

const ICONS = {
  git: ["M12 3v18", "M12 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"],
  branch: ["M6 3v12", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M18 9a9 9 0 0 1-9 9"],
  commit: ["M12 3v6", "M12 15v6", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  fetch: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
  download: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
  push: ["M12 21V9", "m7 14 5-5 5 5", "M5 3h14"],
  pull: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
  check: ["m20 6-11 11-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  "arrow-left": ["M19 12H5", "m12 19-7-7 7-7"],
  "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 3v6h6", "M12 7v5l4 2"],
  user: ["M20 21a8 8 0 0 0-16 0", "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"],
  tag: ["M20 12 12 20 4 12V4h8Z", "M8 8h.01"],
  server: ["M4 4h16v6H4Z", "M4 14h16v6H4Z", "M8 7h.01", "M8 17h.01"],
  archive: ["M3 5h18v4H3Z", "M5 9v10h14V9", "M10 13h4"],
  settings: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.3-4.3"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  warning: ["M12 3 2 21h20Z", "M12 9v6", "M12 18h.01"],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 16v-4", "M12 8h.01"],
  edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"],
  merge: ["M7 3v10a4 4 0 0 0 4 4h6", "M17 13l4 4-4 4", "M7 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M7 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
  play: ["m7 4 12 8-12 8Z"],
  undo: ["M3 7v6h6", "M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"],
  copy: ["M9 9h11v11H9Z", "M5 15H4V4h11v1"],
  external: ["M14 3h7v7", "M10 14 21 3", "M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"],
  stash: ["M4 5h16", "M5 10h14", "M6 15h12", "M7 20h10"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  dot: ["M12 12h.01"],
};

/**
 * 大列表行组件用浅比较 memo：父级状态变化时不再整表重建。
 * 这些行只依赖 props，不会跳过自身 store 订阅触发的更新。
 */
let listRowsMemoized = false;

function memoComponent(component) {
  const memo = appCtx && appCtx.react && appCtx.react.memo;
  if (!memo || !component) return component;
  return memo(component);
}

function memoizeListRows() {
  if (listRowsMemoized) return;
  if (!appCtx || !appCtx.react.memo) return;
  listRowsMemoized = true;
  CommitRow = memoComponent(CommitRow);
  DiffLine = memoComponent(DiffLine);
  SplitDiffRow = memoComponent(SplitDiffRow);
  FileRow = memoComponent(FileRow);
}

function Icon(props) {
  const name = props.name || "git";
  const paths = ICONS[name] || ICONS.dot;
  const size = props.size || 14;
  return appCtx.react.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: props.strokeWidth || 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: props.className,
      style: props.style,
      "aria-hidden": true,
    },
    paths.map((d, index) => appCtx.react.createElement("path", { key: index, d })),
  );
}

/* ---------- 基础组件 ---------- */

function Spinner(props) {
  return appCtx.react.createElement(
    "span",
    { className: "cg-spin", style: props && props.style },
    appCtx.react.createElement(Icon, { name: "refresh", size: (props && props.size) || 14 }),
  );
}

function Btn(props) {
  const h = appCtx.react.createElement;
  return h(
    "button",
    {
      type: "button",
      className: cx("cg-btn", props.variant ? "cg-" + props.variant : "", props.size === "sm" ? "cg-sm" : "", props.className),
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.title,
      style: props.style,
    },
    props.icon ? h(Icon, { name: props.icon, size: props.iconSize || 13 }) : null,
    props.children,
  );
}

function IconBtn(props) {
  const h = appCtx.react.createElement;
  return h(
    "button",
    {
      type: "button",
      className: cx("cg-iconbtn", props.active ? "cg-on" : "", props.className),
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.label,
      "aria-label": props.label,
      style: props.style,
    },
    props.loading
      ? h(Spinner, { style: { width: (props.size || 14) + "px", height: (props.size || 14) + "px" } })
      : h(Icon, { name: props.name, size: props.size || 14 }),
  );
}

function Check(props) {
  const h = appCtx.react.createElement;
  return h(
    "label",
    { className: "cg-check", title: props.title },
    h("input", {
      type: "checkbox",
      checked: Boolean(props.checked),
      disabled: props.disabled,
      onChange: (event) => props.onChange && props.onChange(event.target.checked),
    }),
    props.children,
  );
}

function TextInput(props) {
  const h = appCtx.react.createElement;
  return h("input", {
    className: cx("cg-input", props.mono ? "cg-mono" : "", props.className),
    value: props.value == null ? "" : props.value,
    placeholder: props.placeholder,
    disabled: props.disabled,
    autoFocus: props.autoFocus,
    spellCheck: false,
    onChange: (event) => props.onChange && props.onChange(event.target.value),
    onKeyDown: props.onKeyDown,
    style: props.style,
  });
}

function Select(props) {
  const h = appCtx.react.createElement;
  return h(
    "select",
    {
      className: cx("cg-select", props.className),
      value: props.value,
      disabled: props.disabled,
      onChange: (event) => props.onChange && props.onChange(event.target.value),
      title: props.title,
      style: props.style,
    },
    (props.options || []).map((option) =>
      h("option", { key: option.value, value: option.value }, option.label),
    ),
  );
}

const DETAIL_ERROR_LABELS = {
  branches: "分支",
  tags: "标签",
  stashes: "贮藏",
  remotes: "远程",
  worktrees: "Worktree",
  submodules: "子模块",
};

/** `detailsErrors` → 多行可读明细，用作 title / 悬停提示。 */
function detailErrorSummary(errors) {
  return Object.keys(errors || {})
    .map((key) => (DETAIL_ERROR_LABELS[key] || key) + "：" + errors[key])
    .join("\n");
}

function Badge(props) {
  return appCtx.react.createElement(
    "span",
    { className: cx("cg-badge", props.tone ? "cg-" + props.tone : "", props.className), title: props.title },
    props.children,
  );
}

function Empty(props) {
  const h = appCtx.react.createElement;
  return h(
    "div",
    { className: "cg-empty" },
    h(Icon, { name: props.icon || "git", size: 26 }),
    props.title ? h("b", null, props.title) : null,
    props.children,
  );
}

function Banner(props) {
  const h = appCtx.react.createElement;
  return h(
    "div",
    { className: cx("cg-banner", props.tone ? "cg-" + props.tone : "") },
    h(Icon, { name: props.tone === "error" ? "warning" : "info", size: 14 }),
    h("div", { className: "cg-banner-body" }, props.children),
    props.actions ? h("div", { className: "cg-banner-actions" }, props.actions) : null,
  );
}

function TabBar(props) {
  const h = appCtx.react.createElement;
  const tabs = (props.tabs || []).filter(Boolean);
  const firstSubKey = (tabs.find((tab) => tab.sub) || {}).key;
  return h(
    "div",
    { className: "cg-tabs", role: "tablist" },
    tabs.map((tab) => {
      const node = h(
        "button",
        {
          key: tab.key,
          type: "button",
          role: "tab",
          "aria-selected": props.active === tab.key,
          className: cx("cg-tab", tab.sub ? "cg-tab-sub" : "", props.active === tab.key ? "cg-active" : ""),
          onClick: () => props.onChange(tab.key),
          title: tab.title || tab.label,
        },
        tab.icon ? h(Icon, { name: tab.icon, size: 14 }) : null,
        h("span", null, tab.label),
        tab.count ? h("span", { className: "cg-tab-cnt" }, tab.count) : null,
      );
      if (tab.key === firstSubKey) {
        return h(
          appCtx.react.Fragment,
          { key: "sep:" + tab.key },
          h("span", { className: "cg-tabs-sep", "aria-hidden": true }),
          node,
        );
      }
      return node;
    }),
  );
}

/** 工作台与其菜单、确认框、差异弹窗共用覆盖层，内层浮层始终显示在全屏工作台上方。 */
function workbenchFocusScope(root) {
  if (state.diffDialog) return root.querySelector(".cg-diff-modal") || root;
  if (state.dialog) return root.querySelector(".cg-dialog") || root;
  return root;
}

function workbenchFocusables(root) {
  return Array.from(root.querySelectorAll(
    'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getClientRects().length && window.getComputedStyle(element).visibility !== "hidden");
}

function OverlayHost() {
  const h = appCtx.react.createElement;
  const { useEffect, useRef } = appCtx.react;
  const s = useStoreSnapshot();
  const modalRef = useRef(null);
  useEffect(() => {
    if (!s.workbenchOpen) return;
    const root = modalRef.current;
    if (!root) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFirst = () => {
      const scope = workbenchFocusScope(root);
      // 关闭差异弹窗/确认框时 cleanup 已把焦点还给触发元素，此时不要再抢焦点。
      if (document.activeElement && scope.contains(document.activeElement)) return;
      const target = scope === root
        ? root.querySelector(".cg-workbench-close") || workbenchFocusables(root)[0]
        : workbenchFocusables(scope)[0];
      (target || root).focus();
    };
    const onFocus = (event) => {
      if (!workbenchFocusScope(root).contains(event.target)) focusFirst();
    };
    document.addEventListener("focusin", onFocus);
    focusFirst();
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.body.style.overflow = previousOverflow;
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
    };
  }, [s.workbenchOpen, Boolean(s.diffDialog)]);
  // :has() 需要 Chromium 105+；旧 WebView 上改为直接标记宿主覆盖层容器。
  useEffect(() => {
    if (!s.workbenchOpen && !s.dialog) return;
    const root = modalRef.current;
    const host = root && typeof root.closest === "function"
      ? root.closest("[data-plugin-overlay-host]")
      : null;
    if (!host) return;
    host.classList.add("cg-overlay-raised");
    return () => host.classList.remove("cg-overlay-raised");
  }, [s.workbenchOpen, s.dialog]);
  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // 内层确认框和菜单先处理 Esc，不能一并关闭工作台。
      event.preventDefault();
      event.stopPropagation();
      if (state.diffDialog) closeDiffDialog();
      else if (contextMenuState) closeContextMenu();
      else if (state.dialog) closeDialog(state.dialog.kind === "confirm" ? false : null);
      else closeWorkbench();
    } else if (event.key === "Tab") {
      const root = modalRef.current;
      if (!root) return;
      const focusable = workbenchFocusables(workbenchFocusScope(root));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!first) {
        event.preventDefault();
        root.focus();
      } else if (event.shiftKey && (active === first || !focusable.includes(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !focusable.includes(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  return h(
    "div",
    {
      ref: modalRef,
      className: s.workbenchOpen ? "cg-workbench-modal" : undefined,
      role: s.workbenchOpen ? "dialog" : undefined,
      "aria-modal": s.workbenchOpen ? "true" : undefined,
      "aria-label": s.workbenchOpen ? "Git 工作台" : undefined,
      tabIndex: s.workbenchOpen ? -1 : undefined,
      onKeyDown: s.workbenchOpen ? onKeyDown : undefined,
    },
    s.workbenchOpen ? h(Workbench, null) : null,
    h(DiffDialog, null),
    h(ContextMenuHost, null),
    h(DialogHost, null),
    h(ToastHost, null),
  );
}

/* ---------- 对话框 ---------- */

function DialogHost() {
  const s = useStoreSnapshot();
  const dialog = s.dialog;
  if (!dialog) return null;
  return appCtx.react.createElement(DialogBody, { key: dialog.id, dialog });
}

function DialogBody(props) {
  const h = appCtx.react.createElement;
  const dialog = props.dialog;
  const { useState, useEffect, useRef } = appCtx.react;
  const initial = {};
  for (const field of dialog.fields || []) {
    initial[field.key] = field.value == null ? (field.type === "checkbox" ? false : "") : field.value;
  }
  const [values, setValues] = useState(initial);
  const [error, setError] = useState("");
  const panelRef = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog(null);
      }
    };
    document.addEventListener("keydown", onKey);
    const first = panelRef.current ? workbenchFocusables(panelRef.current)[0] : null;
    if (first) first.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
    };
  }, []);
  const update = (key, value) => {
    setError("");
    setValues((current) => Object.assign({}, current, { [key]: value }));
  };
  const confirm = () => {
    if (dialog.kind === "confirm") {
      closeDialog(true);
      return;
    }
    // 默认必填；调用方可用 optional: true 放开（如“留空为 HEAD”）。
    const missing = (dialog.fields || []).find(
      (field) =>
        field.optional !== true &&
        field.type !== "checkbox" &&
        !String(values[field.key] || "").trim(),
    );
    if (missing) {
      setError("请填写「" + (missing.label || missing.key) + "」");
      return;
    }
    setError("");
    closeDialog(values);
  };
  const cancel = () => closeDialog(dialog.kind === "confirm" ? false : null);
  return h(
    "div",
    {
      className: "cg-overlay",
      onMouseDown: (event) => {
        if (event.target === event.currentTarget) cancel();
      },
    },
    h(
      "div",
      { className: "cg-dialog", ref: panelRef, role: "dialog", "aria-modal": "true" },
      h(
        "div",
        { className: "cg-dialog-head" },
        h(Icon, { name: dialog.danger ? "warning" : "info", size: 15 }),
        h("span", null, dialog.title || ""),
      ),
      h(
        "div",
        { className: "cg-dialog-body" },
        dialog.kind === "prompt" && dialog.description
          ? h("div", { className: "cg-dialog-desc" }, dialog.description)
          : null,
        dialog.kind === "confirm" && dialog.message
          ? h("div", { className: "cg-dialog-desc" }, dialog.message)
          : null,
        dialog.kind === "confirm" && dialog.detail
          ? h("div", { className: "cg-dialog-detail" }, dialog.detail)
          : null,
        error ? h(Banner, { tone: "error" }, error) : null,
        dialog.kind === "prompt"
          ? (dialog.fields || []).map((field) => {
              const value = values[field.key];
              let control;
              if (field.type === "checkbox") {
                control = h(
                  "label",
                  { className: "cg-check" },
                  h("input", {
                    type: "checkbox",
                    checked: Boolean(value),
                    onChange: (event) => update(field.key, event.target.checked),
                  }),
                  field.label,
                );
              } else if (field.type === "select") {
                control = h(Select, {
                  value,
                  options: field.options || [],
                  onChange: (next) => update(field.key, next),
                });
              } else if (field.type === "textarea") {
                control = h("textarea", {
                  className: "cg-textarea",
                  value,
                  placeholder: field.placeholder,
                  rows: field.rows || 4,
                  onChange: (event) => update(field.key, event.target.value),
                });
              } else {
                control = h(TextInput, {
                  value,
                  placeholder: field.placeholder,
                  mono: field.mono,
                  onChange: (next) => update(field.key, next),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      confirm();
                    }
                  },
                });
              }
              return h(
                "div",
                { key: field.key, className: "cg-dialog-field" },
                field.type === "checkbox" ? null : h("label", null, field.label),
                control,
                field.hint ? h("span", { className: "cg-muted cg-mini" }, field.hint) : null,
              );
            })
          : null,
      ),
      h(
        "div",
        { className: "cg-dialog-foot" },
        h(Btn, { onClick: cancel }, dialog.cancelLabel || "取消"),
        h(
          Btn,
          { variant: dialog.danger ? "danger" : "primary", onClick: confirm },
          dialog.confirmLabel || "确定",
        ),
      ),
    ),
  );
}

function ToastHost() {
  const s = useStoreSnapshot();
  const h = appCtx.react.createElement;
  if (!s.toasts.length) return null;
  return h(
    "div",
    { className: "cg-toasts", role: "status", "aria-live": "polite" },
    s.toasts.map((item) =>
      h(
        "div",
        { key: item.id, className: cx("cg-toast", "cg-" + item.tone) },
        h(Icon, { name: item.tone === "error" ? "warning" : item.tone === "success" ? "check" : "info", size: 13 }),
        h("div", null, item.message),
        h(IconBtn, { name: "x", label: "关闭", onClick: () => dismissToast(item.id), size: 12 }),
      ),
    ),
  );
}

/* ===== 33-ui-shell.js ===== */

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
  const detailErrorText = detailErrorSummary(data && data.detailsErrors);
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
      ? h("span", { className: "cg-sb-item cg-sb-warn", title: detailErrorText }, h(Icon, { name: "warning", size: 11 }), detailErrors.length + " 项仓库信息读取失败")
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

/* ===== 35-ui-changes.js ===== */

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
    !data.status.truncated && data.status.warnings
      ? h(Banner, { tone: "error" }, "git status 报告了警告，部分路径可能未列出：" + truncate(data.status.warnings, 300))
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
          ? data.loading.status && !data.statusAt
            ? h(Empty, { icon: "refresh", title: "正在读取工作区状态…" }, h(Spinner, null))
            : h(Empty, { icon: "check", title: "没有本地更改" }, h("span", null, "工作区干净"))
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
    notifyDeferred();
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
    h(IconBtn, { name: "refresh", label: "刷新", onClick: () => refreshRepo(repo, { details: true }) }),
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
    cache && cache.preview && cache.preview.error
      ? h(Banner, { tone: "error" }, cache.preview.error)
      : null,
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
              cache && cache.preview && !cache.preview.binary && !cache.preview.truncated && !cache.preview.error
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
  const { useEffect, useState } = appCtx.react;
  const { repo, entry, file, mode, refresh } = props;
  const [picked, setPicked] = useState({});
  // 差异重新解析后行号会变，旧选择必须作废，否则会暂存/丢弃到错误行。
  useEffect(() => {
    setPicked({});
  }, [file]);
  const limit = Math.max(0, Math.min(MAX_DIFF_LINES, Number(props.budget) || MAX_DIFF_LINES));
  const split = state.settings.diffLayout === "split";
  const selectable = !entry.unmerged && !file.isNew && !file.isDeleted && (mode === "staged" || (mode === "worktree" && entry.code !== "?"));
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
  const { useEffect, useState } = appCtx.react;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);
  useEffect(() => {
    setHistoryOpen(false);
    setOptsOpen(false);
  }, [repo]);
  useEffect(() => {
    if (!historyOpen && !optsOpen) return;
    const onDown = (event) => {
      if (event.target && event.target.closest && event.target.closest(".cg-commit-pop")) return;
      setHistoryOpen(false);
      setOptsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen, optsOpen]);
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
    {
      className: "cg-commitbox",
      onKeyDown: (event) => {
        if (event.key === "Escape" && (historyOpen || optsOpen)) {
          event.preventDefault();
          event.stopPropagation();
          setHistoryOpen(false);
          setOptsOpen(false);
        }
      },
    },
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

/* ===== 40-ui-log.js ===== */

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
                  "button",
                  {
                    key: parent,
                    type: "button",
                    className: "cg-btn cg-ghost cg-sm",
                    onClick: () => parentCommit(repo, parent),
                  },
                  truncz(parent, 10),
                ),
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
            h("button", { type: "button", className: fileView === "tree" ? "cg-on" : "", title: "树形", onClick: () => saveSettings({ fileView: "tree" }) }, h(Icon, { name: "folder", size: 12 })),
            h("button", { type: "button", className: fileView === "flat" ? "cg-on" : "", title: "平铺", onClick: () => saveSettings({ fileView: "flat" }) }, h(Icon, { name: "file", size: 12 })),
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
          h("button", { type: "button", className: s.settings.diffLayout === "split" ? "" : "cg-on", title: "统一视图", onClick: () => saveSettings({ diffLayout: "unified" }) }, "统一"),
          h("button", { type: "button", className: s.settings.diffLayout === "split" ? "cg-on" : "", title: "并排视图", onClick: () => saveSettings({ diffLayout: "split" }) }, "并排"),
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
        "button",
        {
          type: "button",
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

/* ===== 45-ui-tabs.js ===== */

/* ---------------------------------------------------------------------------
 * 本分片：分支、暂存、标签、远程、子模块/worktree、控制台、设置、右侧轻量面板。
 * ------------------------------------------------------------------------- */

async function deleteRemoteBranch(repo, remoteRef) {
  const slash = remoteRef.indexOf("/");
  if (slash <= 0) return { ok: false };
  const remote = remoteRef.slice(0, slash);
  const branch = remoteRef.slice(slash + 1);
  const confirmed = await confirmDestructive({
    title: "删除远程分支",
    message: "在 " + remote + " 上删除分支 " + branch + "？",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除远程分支", async () => {
    const res = await runGit(repo, ["push", "--delete", "--", remote, branch], {
      allowFailure: true,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "已删除远程分支", details: true });
}

async function checkoutTag(repo, name) {
  const confirmed = await confirmDestructive({
    title: "检出标签",
    message: "检出标签 " + name + " 将进入游离 HEAD 状态（detached）。可先基于标签新建分支。",
    confirmLabel: "检出",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "检出标签 " + name, async () => {
    const res = await runGit(repo, ["checkout", "tags/" + name], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
  }, { success: "已检出标签", details: true, log: true });
}

async function unsetUpstream(repo, branch) {
  return perform(repo, "取消上游分支", async () => {
    const res = await runGit(repo, ["branch", "--unset-upstream", "--", branch], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已取消上游分支", details: true });
}

async function setUpstream(repo, branch, upstream) {
  return perform(repo, "设置上游分支", async () => {
    const res = await runGit(repo, ["branch", "--set-upstream-to=" + upstream, branch], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
  }, { success: "已设置上游分支", details: true });
}

async function setUpstreamDialog(repo, branch) {
  const values = await promptDialog({
    title: "设置上游分支",
    fields: [{ key: "upstream", label: "上游（远程仓库/分支）", placeholder: "origin/main" }],
    confirmLabel: "设置",
  });
  if (!values || !values.upstream) return { ok: false };
  return setUpstream(repo, branch, values.upstream);
}

async function removeSubmodule(repo, path) {
  const confirmed = await confirmDestructive({
    title: "删除子模块",
    message: "注销并移除子模块 " + path + "？工作区中的子模块目录会一并删除。",
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return { ok: false };
  return perform(repo, "删除子模块", async () => {
    const first = await runGit(repo, ["submodule", "deinit", "-f", "--", path], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (first.code !== 0) throw new GitCommandError((first.stderr || first.stdout || "").trim(), first.entry);
    const second = await runGit(repo, ["rm", "-f", "--", path], {
      allowFailure: true,
      timeoutMs: 60000,
    });
    if (second.code !== 0) throw new GitCommandError((second.stderr || second.stdout || "").trim(), second.entry);
  }, { success: "子模块已删除", details: true });
}

/* ---------- 分支 ---------- */

function BranchesTab(props) {
  const h = appCtx.react.createElement;
  const { useState } = appCtx.react;
  const s = useStoreSnapshot();
  const repo = props.repo;
  const data = ensureRepoData(repo);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const current = data.status.branch.head;
  const filter = (item) =>
    (kind === "all" || item.kind === kind) &&
    (!query || item.name.toLowerCase().includes(query.toLowerCase()) || (item.upstream || "").toLowerCase().includes(query.toLowerCase()));
  const locals = data.branches.locals.filter(filter);
  const remotes = data.branches.remotes.filter(filter);
  const compare = data.compare;
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Btn, { size: "sm", icon: "plus", onClick: () => createBranchDialog(repo) }, "新建分支"),
      h(Btn, { size: "sm", icon: "fetch", title: "获取远程更新（Fetch）", onClick: () => fetchRepo(repo, { all: true, prune: s.settings.fetchPrune }) }, "获取"),
      h(Btn, { size: "sm", icon: "pull", title: "拉取远程更新（Pull）", onClick: () => pullRepo(repo) }, "拉取"),
      h(Btn, { size: "sm", icon: "push", title: "推送到远程（Push）", onClick: () => pushDialog(repo) }, "推送"),
      h("div", { className: "cg-toolbar-spacer" }),
      h("input", {
        className: "cg-input cg-filter-input",
        placeholder: "筛选分支",
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      h(Select, {
        value: kind,
        options: [
          { value: "all", label: "全部" },
          { value: "local", label: "本地" },
          { value: "remote", label: "远程" },
        ],
        onChange: setKind,
        className: "cg-filter-select",
      }),
      h(IconBtn, { name: "refresh", label: "刷新分支", onClick: () => loadRepoDetails(repo, true) }),
    ),
    h(
      "div",
      { className: "cg-branch-cols" },
      h(
        "div",
        { className: "cg-branch-list" },
        h("div", { className: "cg-section-title" }, h(Icon, { name: "branch", size: 12 }), "本地分支", h(Badge, null, locals.length)),
        locals.length
          ? locals.map((item) => h(BranchRow, { key: "l:" + item.refname, repo, item, current: item.name === current, remote: false }))
          : h("div", { className: "cg-notice" }, "没有匹配的本地分支"),
        h("div", { className: "cg-section-title" }, h(Icon, { name: "server", size: 12 }), "远程分支", h(Badge, null, remotes.length)),
        remotes.length
          ? remotes.map((item) => h(BranchRow, { key: "r:" + item.refname, repo, item, current: false, remote: true }))
          : h("div", { className: "cg-notice" }, "没有匹配的远程分支"),
      ),
      h(
        "div",
        { className: "cg-compare" },
        h(
          "div",
          { className: "cg-section-title" },
          h(Icon, { name: "git", size: 12 }),
          "与当前分支比较",
          h("div", { style: { flex: 1 } }),
          compare ? h(IconBtn, { name: "x", label: "关闭比较", onClick: () => { data.compare = null; notify(); } }) : null,
        ),
        compare
          ? h(CompareView, { repo, compare })
          : h("div", { className: "cg-empty" }, h(Icon, { name: "branch", size: 22 }), h("span", null, "点击分支行的比较按钮"), h("span", { className: "cg-muted" }, "显示领先/落后提交与差异统计")),
      ),
    ),
  );
}

function BranchRow(props) {
  const h = appCtx.react.createElement;
  const { repo, item, current, remote } = props;
  return h(
    "div",
    { className: "cg-list-row" },
    h(Icon, { name: remote ? "server" : "branch", size: 12, style: { color: current ? "var(--color-accent-500)" : "var(--color-text-tertiary)" } }),
    h(
      "div",
      { className: "cg-list-main" },
      h(
        "div",
        { className: "cg-list-title" },
        h("b", null, item.name),
        current ? h(Badge, { tone: "add" }, "当前") : null,
        item.upstreamGone ? h(Badge, { tone: "conflict" }, "上游已删除") : null,
        item.ahead ? h("span", { className: "cg-ahead" }, "↑" + item.ahead) : null,
        item.behind ? h("span", { className: "cg-behind" }, "↓" + item.behind) : null,
      ),
      h(
        "div",
        { className: "cg-list-sub" },
        item.upstream ? item.upstream + " · " : "",
        item.subject || "(无提交)",
        " · ",
        shortDate(item.at),
      ),
    ),
    h(
      "div",
      { className: "cg-list-actions" },
      !current ? h(IconBtn, { name: "check", label: remote ? "检出为本地分支" : "检出", size: 13, onClick: () => checkoutBranch(repo, remote ? item.remote + "/" + item.name : item.name, remote) }) : null,
      !current && !remote ? h(IconBtn, { name: "merge", label: "合并到当前分支", size: 13, onClick: () => mergeBranchDialog(repo, item.name) }) : null,
      !current && !remote ? h(IconBtn, { name: "history", label: "变基当前分支到此分支", size: 13, onClick: () => rebaseBranch(repo, item.name) }) : null,
      !remote ? h(IconBtn, { name: "git", label: "与当前分支比较", size: 13, onClick: () => compareBranches(repo, item.name, current || "HEAD") }) : null,
      remote ? h(IconBtn, { name: "git", label: "与当前分支比较", size: 13, onClick: () => compareBranches(repo, item.remote + "/" + item.name, current || "HEAD") }) : null,
      h(IconBtn, {
        name: "more",
        label: "更多",
        size: 13,
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openContextMenu(
            rect.left,
            rect.bottom + 2,
            remote
              ? [
                  { label: "检出为本地分支", icon: "check", onClick: () => checkoutBranch(repo, item.remote + "/" + item.name, true) },
                  { label: "合并到当前分支", icon: "merge", onClick: () => mergeBranchDialog(repo, item.remote + "/" + item.name) },
                  { label: "变基当前分支到此分支", icon: "history", onClick: () => rebaseBranch(repo, item.remote + "/" + item.name) },
                  { label: "与当前分支比较", icon: "git", onClick: () => compareBranches(repo, item.remote + "/" + item.name, current || "HEAD") },
                  { label: "复制分支名", icon: "copy", onClick: () => copyText(item.remote + "/" + item.name) },
                  { separator: true },
                  { label: "删除远程分支", icon: "trash", danger: true, onClick: () => deleteRemoteBranch(repo, item.remote + "/" + item.name) },
                ]
              : [
                  { label: "检出", icon: "check", disabled: current, onClick: () => checkoutBranch(repo, item.name) },
                  { label: "合并到当前分支", icon: "merge", disabled: current, onClick: () => mergeBranchDialog(repo, item.name) },
                  { label: "变基当前分支到此分支", icon: "history", disabled: current, onClick: () => rebaseBranch(repo, item.name) },
                  { label: "重命名", icon: "edit", onClick: () => renameBranchDialog(repo, item.name) },
                  { label: "设置上游分支", icon: "server", onClick: () => setUpstreamDialog(repo, item.name) },
                  { label: "取消上游分支", icon: "x", disabled: !item.upstream, onClick: () => unsetUpstream(repo, item.name) },
                  { label: "复制分支名", icon: "copy", onClick: () => copyText(item.name) },
                  { separator: true },
                  { label: "删除分支", icon: "trash", danger: true, disabled: current, onClick: () => deleteBranch(repo, item.name, false) },
                  { label: "强制删除分支", icon: "trash", danger: true, disabled: current, onClick: () => deleteBranch(repo, item.name, true) },
                ],
          );
        },
      }),
    ),
  );
}

function CompareView(props) {
  const h = appCtx.react.createElement;
  const { compare } = props;
  if (compare.loading) return h("div", { className: "cg-notice" }, "正在比较…");
  if (compare.error) return h(Banner, { tone: "error" }, compare.error);
  return h(
    "div",
    { className: "cg-compare-body" },
    h("div", { className: "cg-muted cg-mini cg-mono" }, compare.base + " … " + compare.head),
    h("h4", null, "领先 " + compare.ahead.length + " 个提交"),
    compare.ahead.length
      ? compare.ahead.map((item) => h("div", { key: "a" + item.hash, className: "cg-list-row" }, h(Badge, { tone: "add" }, item.hash), h("span", { className: "cg-ellipsis" }, item.subject), h("span", { className: "cg-muted cg-mini" }, item.author)))
      : h("div", { className: "cg-notice" }, "无"),
    h("h4", null, "落后 " + compare.behind.length + " 个提交"),
    compare.behind.length
      ? compare.behind.map((item) => h("div", { key: "b" + item.hash, className: "cg-list-row" }, h(Badge, { tone: "del" }, item.hash), h("span", { className: "cg-ellipsis" }, item.subject), h("span", { className: "cg-muted cg-mini" }, item.author)))
      : h("div", { className: "cg-notice" }, "无"),
    h("h4", null, "变更统计"),
    h("pre", { className: "cg-code cg-mini", style: { whiteSpace: "pre-wrap", margin: 0 } }, compare.stat || "无差异"),
  );
}

/* ---------- 暂存 ---------- */

function StashesTab(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const { useState, useEffect } = appCtx.react;
  const repo = props.repo;
  const data = ensureRepoData(repo);
  const [selected, setSelected] = useState(data.stashes.length ? data.stashes[0].selector : null);
  const diff = data.stashDiff;
  const selectedItem = data.stashes.find((item) => item.selector === selected) || null;
  const selectedHash = selectedItem ? selectedItem.hash : "";
  useEffect(() => {
    const first = selectedItem || data.stashes[0] || null;
    if (!first) {
      if (selected) setSelected(null);
      if (data.stashDiff) data.stashDiff = null;
      return;
    }
    if (first.selector !== selected) setSelected(first.selector);
    if (data.stashDiff && data.stashDiff.loading && data.stashDiff.selector === first.selector && data.stashDiff.hash === first.hash) return;
    if (!data.stashDiff || data.stashDiff.selector !== first.selector || data.stashDiff.hash !== first.hash) {
      void loadStashDiff(repo, first.selector, first.hash);
    }
  }, [repo, data.stashes.length, selected, selectedHash]);
  const pick = (item) => {
    setSelected(item.selector);
    void loadStashDiff(repo, item.selector, item.hash);
  };
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Btn, { size: "sm", icon: "plus", onClick: () => stashDialog(repo) }, "贮藏当前更改"),
      h(Btn, { size: "sm", icon: "refresh", onClick: () => refreshRepo(repo, { details: true }) }, "刷新"),
      h("div", { className: "cg-toolbar-spacer" }),
      h(Btn, { size: "sm", variant: "danger", icon: "trash", disabled: !data.stashes.length, onClick: () => clearStashes(repo) }, "清空贮藏"),
    ),
    h(
      "div",
      { className: "cg-split" },
      h(
        "div",
        { className: "cg-filecol", style: { width: "40%" } },
        data.stashes.length
          ? data.stashes.map((item) =>
              h(
                "div",
                {
                  key: item.selector,
                  className: cx("cg-row", selected === item.selector ? "cg-selected" : ""),
                  style: { padding: "6px 8px", alignItems: "flex-start", flexDirection: "column", gap: "2px" },
                  onClick: () => pick(item),
                },
                h(
                  "div",
                  { style: { display: "flex", gap: "0.375rem", width: "100%", alignItems: "center" } },
                  h(Badge, { tone: "move" }, item.selector),
                  h("span", { className: "cg-ellipsis", style: { flex: 1, fontWeight: 600 } }, item.subject.replace(/^(WIP on|On) [^:]+:\s*/, "") || "(无说明)"),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: "0.375rem", width: "100%", alignItems: "center" } },
                  h("span", { className: "cg-muted cg-mini cg-ellipsis", style: { flex: 1 } }, (item.branch ? item.branch + " · " : "") + shortDate(item.at)),
                  h(IconBtn, { name: "play", label: "应用", size: 12, onClick: (event) => { event.stopPropagation(); stashApply(repo, item.selector, "apply"); } }),
                  h(IconBtn, { name: "check", label: "应用并删除", size: 12, onClick: (event) => { event.stopPropagation(); stashApply(repo, item.selector, "pop"); } }),
                  h(IconBtn, { name: "branch", label: "从贮藏新建分支", size: 12, onClick: (event) => { event.stopPropagation(); stashBranch(repo, item.selector); } }),
                  h(IconBtn, { name: "trash", label: "删除贮藏", size: 12, onClick: (event) => { event.stopPropagation(); stashApply(repo, item.selector, "drop"); } }),
                ),
              ),
            )
          : h(Empty, { icon: "stash", title: "没有贮藏记录" }, h("span", null, "使用“贮藏当前更改”保存工作区")),
      ),
      h(
        "div",
        { className: "cg-stash-diff" },
        diff
          ? h(
              appCtx.react.Fragment,
              null,
              h(
                "div",
                { className: "cg-diff-head" },
                h(Icon, { name: "stash", size: 13 }),
                h("b", null, diff.selector),
                h("span", { className: "cg-muted cg-mini" }, diff.loading ? "加载中…" : (diff.filesList || []).length + " 个文件"),
                h("div", { style: { flex: 1 } }),
                h(IconBtn, { name: "refresh", label: "刷新", onClick: () => loadStashDiff(repo, diff.selector) }),
              ),
              diff.error ? h(Banner, { tone: "error" }, diff.error) : null,
              h(ReadonlyDiff, { key: diff.selector, files: diff.files, fallback: diff.text }),
            )
          : h(Empty, { icon: "stash", title: "选择一条贮藏查看内容" }),
      ),
    ),
  );
}

/* ---------- 标签 ---------- */

function TagsTab(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const { useState } = appCtx.react;
  const repo = props.repo;
  const data = ensureRepoData(repo);
  const [query, setQuery] = useState("");
  const tags = data.tags.filter((tag) => !query || tag.name.toLowerCase().includes(query.toLowerCase()) || (tag.subject || "").toLowerCase().includes(query.toLowerCase()));
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Btn, { size: "sm", icon: "plus", onClick: () => createTagDialog(repo) }, "新建标签"),
      h(Btn, { size: "sm", icon: "push", onClick: () => pushTags(repo, []), disabled: !data.remotes.length }, "推送全部标签"),
      h(Btn, { size: "sm", icon: "fetch", onClick: () => fetchRepo(repo, { tags: true, prune: s.settings.fetchPrune }) }, "获取标签"),
      h("div", { className: "cg-toolbar-spacer" }),
      h("input", {
        className: "cg-input cg-filter-input",
        placeholder: "筛选标签",
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      h(IconBtn, { name: "refresh", label: "刷新标签", onClick: () => loadRepoDetails(repo, true) }),
    ),
    tags.length
      ? h(
          "div",
          { className: "cg-list" },
          tags.map((tag) =>
            h(
              "div",
              { key: tag.name, className: "cg-list-row" },
              h(Icon, { name: "tag", size: 12, style: { color: "var(--color-status-yellow-text)" } }),
              h(
                "div",
                { className: "cg-list-main" },
                h("div", { className: "cg-list-title" }, h("b", null, tag.name), tag.annotated ? h(Badge, { tone: "mod" }, "注释") : h(Badge, null, "轻量"), h("span", { className: "cg-mono cg-muted cg-mini" }, tag.target)),
                h("div", { className: "cg-list-sub" }, (tag.tagger ? tag.tagger + " · " : "") + (tag.at ? shortDate(tag.at) + " · " : "") + (tag.subject || "")),
              ),
              h(
                "div",
                { className: "cg-list-actions" },
                h(IconBtn, { name: "check", label: "检出标签", size: 13, onClick: () => checkoutTag(repo, tag.name) }),
                h(IconBtn, { name: "branch", label: "基于标签新建分支", size: 13, onClick: () => createBranchDialog(repo, tag.name) }),
                h(IconBtn, { name: "push", label: "推送标签", size: 13, onClick: () => pushTags(repo, [tag.name]), disabled: !data.remotes.length }),
                h(IconBtn, {
                  name: "more",
                  label: "更多",
                  size: 13,
                  onClick: (event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu(rect.left, rect.bottom + 2, [
                      { label: "检出标签", icon: "check", onClick: () => checkoutTag(repo, tag.name) },
                      { label: "基于标签新建分支", icon: "branch", onClick: () => createBranchDialog(repo, tag.name) },
                      { label: "推送标签", icon: "push", disabled: !data.remotes.length, onClick: () => pushTags(repo, [tag.name]) },
                      { label: "删除远程标签", icon: "server", danger: true, disabled: !data.remotes.length, onClick: () => deleteRemoteTag(repo, tag.name) },
                      { label: "复制标签名", icon: "copy", onClick: () => copyText(tag.name) },
                      { separator: true },
                      { label: "删除本地标签", icon: "trash", danger: true, onClick: () => deleteTag(repo, tag.name) },
                    ]);
                  },
                }),
              ),
            ),
          ),
        )
      : h(Empty, { icon: "tag", title: "没有标签" }, h("span", null, "创建标签来标记发布版本")),
  );
}

/* ---------- 远程 ---------- */

function RemotesTab(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const repo = props.repo;
  const data = ensureRepoData(repo);
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Btn, { size: "sm", icon: "plus", onClick: () => addRemoteDialog(repo) }, "添加远程"),
      h(Btn, { size: "sm", icon: "fetch", title: "获取全部远程更新（Fetch）", onClick: () => fetchRepo(repo, { all: true, prune: s.settings.fetchPrune }) }, "获取全部"),
      h(Btn, { size: "sm", icon: "refresh", onClick: () => loadRepoDetails(repo, true) }, "刷新"),
      h("div", { className: "cg-toolbar-spacer" }),
      h("span", { className: "cg-muted cg-mini" }, "凭据由本机 Git 凭据管理器（credential helper）或 SSH agent 提供"),
    ),
    data.remotes.length
      ? h(
          "div",
          { className: "cg-list" },
          data.remotes.map((remote) =>
            h(
              "div",
              { key: remote.name, className: "cg-list-row", style: { alignItems: "flex-start" } },
              h(Icon, { name: "server", size: 13, style: { marginTop: "2px" } }),
              h(
                "div",
                { className: "cg-list-main" },
                h("div", { className: "cg-list-title" }, h("b", null, remote.name), h("span", { className: "cg-mono cg-muted cg-mini" }, remote.fetchUrl)),
                remote.pushUrl && remote.pushUrl !== remote.fetchUrl
                  ? h("div", { className: "cg-list-sub" }, "推送地址：" + remote.pushUrl)
                  : null,
              ),
              h(
                "div",
                { className: "cg-list-actions" },
                h(IconBtn, { name: "fetch", label: "获取远程更新（Fetch）", size: 13, onClick: () => fetchRepo(repo, { remote: remote.name, prune: s.settings.fetchPrune }) }),
                h(IconBtn, { name: "trash", label: "清理已删除的远程分支（Prune）", size: 13, onClick: () => pruneRemote(repo, remote.name) }),
                h(IconBtn, { name: "edit", label: "修改地址", size: 13, onClick: () => setRemoteUrlDialog(repo, remote.name, remote.fetchUrlRaw || remote.fetchUrl) }),
                h(IconBtn, {
                  name: "more",
                  label: "更多",
                  size: 13,
                  onClick: (event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu(rect.left, rect.bottom + 2, [
                      { label: "获取远程更新（Fetch）", icon: "fetch", onClick: () => fetchRepo(repo, { remote: remote.name, prune: s.settings.fetchPrune }) },
                      { label: "清理已删除的远程分支（Prune）", icon: "trash", onClick: () => pruneRemote(repo, remote.name) },
                      { label: "修改地址", icon: "edit", onClick: () => setRemoteUrlDialog(repo, remote.name, remote.fetchUrlRaw || remote.fetchUrl) },
                      { label: "重命名", icon: "edit", onClick: () => renameRemoteDialog(repo, remote.name) },
                      { label: "复制地址", icon: "copy", onClick: () => copyText(remote.fetchUrlRaw || remote.fetchUrl) },
                      { separator: true },
                      { label: "删除远程", icon: "trash", danger: true, onClick: () => removeRemote(repo, remote.name) },
                    ]);
                  },
                }),
              ),
            ),
          ),
        )
      : h(Empty, { icon: "server", title: "没有远程仓库" }, h("span", null, "添加远程仓库后即可获取、拉取、推送")),
    h(
      "div",
      { className: "cg-section-title", style: { position: "static" } },
      h(Icon, { name: "archive", size: 12 }),
      "工作树（" + data.worktrees.length + "）",
      h("div", { style: { flex: 1 } }),
      h(Btn, { size: "sm", icon: "plus", onClick: () => createWorktreeDialog(repo) }, "新建"),
      h(Btn, { size: "sm", title: "清理已失效的工作树（Prune）", onClick: () => pruneWorktrees(repo) }, "清理"),
    ),
    h(
      "div",
      { className: "cg-list-scroll" },
      data.worktrees.length
        ? data.worktrees.map((item, index) =>
            h(
              "div",
              { key: item.path, className: "cg-list-row" },
              h(Icon, { name: "archive", size: 12 }),
              h(
                "div",
                { className: "cg-list-main" },
                h("div", { className: "cg-list-title" }, h("b", { className: "cg-ellipsis" }, item.path), item.bare ? h(Badge, null, "裸仓库") : null, item.locked ? h(Badge, { tone: "mod" }, "已锁定") : null),
                h("div", { className: "cg-list-sub" }, (item.branch || (item.detached ? "游离 HEAD" : "")) + " · " + shortHash(item.head)),
              ),
              h(
                "div",
                { className: "cg-list-actions" },
                pathKey(item.path) !== pathKey(repo)
                  ? h(IconBtn, {
                      name: "external",
                      label: "在 Git 工作台中查看该工作树",
                      size: 13,
                      onClick: () => setActiveRepo(item.path),
                    })
                  : null,
                pathKey(item.path) !== pathKey(repo) && !item.bare && index > 0
                  ? h(IconBtn, { name: "trash", label: "删除工作树", size: 13, onClick: () => removeWorktree(repo, item.path) })
                  : null,
                h(IconBtn, { name: "copy", label: "复制路径", size: 13, onClick: () => copyText(item.path) }),
              ),
            ),
          )
        : h("div", { className: "cg-notice" }, "没有额外工作树"),
    ),
  );
}

/* ---------- 子模块 ---------- */

function SubmodulesTab(props) {
  const h = appCtx.react.createElement;
  const repo = props.repo;
  const data = ensureRepoData(repo);
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Btn, { size: "sm", icon: "refresh", onClick: () => updateSubmodules(repo) }, "更新全部"),
      h(Btn, { size: "sm", icon: "check", onClick: () => syncSubmodules(repo) }, "同步地址"),
      h(Btn, { size: "sm", icon: "plus", onClick: () => addSubmoduleDialog(repo) }, "添加子模块"),
      h("div", { className: "cg-toolbar-spacer" }),
      h(IconBtn, { name: "refresh", label: "刷新", onClick: () => loadRepoDetails(repo, true) }),
    ),
    data.submodules.length
      ? h(
          "div",
          { className: "cg-list" },
          data.submodules.map((item) =>
            h(
              "div",
              { key: item.path, className: "cg-list-row" },
              h(Icon, { name: "archive", size: 12 }),
              h(
                "div",
                { className: "cg-list-main" },
                h(
                  "div",
                  { className: "cg-list-title" },
                  h("b", null, item.path),
                  h(Badge, { tone: item.tone === "conflict" ? "conflict" : item.tone === "dirty" ? "mod" : item.tone === "missing" ? "del" : "neutral" }, item.tone === "unknown" ? "未登记" : item.flag.trim() || "正常"),
                  h("span", { className: "cg-mono cg-muted cg-mini" }, shortHash(item.hash)),
                ),
                h("div", { className: "cg-list-sub" }, item.describe || ""),
              ),
              h(
                "div",
                { className: "cg-list-actions" },
                h(IconBtn, { name: "refresh", label: "更新此子模块", size: 13, onClick: () => perform(repo, "更新子模块", async () => {
                  const res = await runGit(repo, ["submodule", "update", "--init", "--recursive", "--", item.path], { allowFailure: true, timeoutMs: 300000 });
                  if (res.code !== 0) throw new GitCommandError((res.stderr || res.stdout || "").trim(), res.entry);
                }, { success: "子模块已更新", details: true }) }),
                h(IconBtn, { name: "copy", label: "复制路径", size: 13, onClick: () => copyText(item.path) }),
                h(IconBtn, { name: "trash", label: "删除子模块", size: 13, onClick: () => removeSubmodule(repo, item.path) }),
              ),
            ),
          ),
        )
      : h(Empty, { icon: "archive", title: "没有子模块" }, h("span", null, "使用“添加子模块”引入外部仓库")),
  );
}

/* ---------- 控制台 ---------- */

function ConsoleTab(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const { useState, useEffect, useRef } = appCtx.react;
  const repo = props.repo;
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [s.consoleEntries.length]);
  const run = async (command) => {
    const value = String(command == null ? input : command).trim();
    if (!value || running) return;
    setRunning(true);
    setInput("");
    try {
      await runConsoleCommand(repo, value);
    } finally {
      setRunning(false);
    }
  };
  return h(
    "div",
    { className: "cg-content" },
    h(
      "div",
      { className: "cg-toolbar" },
      h(Icon, { name: "terminal", size: 13 }),
      h("b", null, "Git 控制台"),
      h("span", { className: "cg-muted cg-mini" }, "在 " + repoDisplayName(repo) + " 中执行，自动补全全局参数"),
      h("div", { style: { flex: 1 } }),
      h(Btn, { size: "sm", title: "git status --short --branch", onClick: () => run("status --short --branch") }, "状态"),
      h(Btn, { size: "sm", title: "git log --oneline -20", onClick: () => run("log --oneline -20") }, "日志"),
      h(Btn, { size: "sm", title: "git remote -v", onClick: () => run("remote -v") }, "远程"),
      h(Btn, { size: "sm", title: "git branch -a", onClick: () => run("branch -a") }, "分支"),
      h(IconBtn, { name: "trash", label: "清空输出", onClick: () => clearConsole() }),
    ),
    h(
      "div",
      { className: "cg-console-input" },
      h("span", { className: "cg-mono cg-muted" }, "git"),
      h("input", {
        className: "cg-input",
        value: input,
        placeholder: "例如：状态摘要（status --short）/ 最近提交（log --oneline -10）",
        spellCheck: false,
        onChange: (event) => setInput(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") run();
        },
        disabled: running || !repo,
      }),
      h(Btn, { variant: "primary", icon: running ? "refresh" : "play", onClick: () => run(), disabled: running || !repo }, running ? "执行中…" : "执行"),
    ),
    h(
      "div",
      { className: "cg-console-log", ref: logRef },
      s.consoleEntries.length
        ? s.consoleEntries.map((entry) =>
            h(
              "div",
              { key: entry.id, className: "cg-console-entry" },
              h(
                "div",
                { className: "cg-console-cmd" },
                h("span", { className: "cg-muted cg-mini" }, shortDate(entry.at)),
                h("code", null, entry.display || "git"),
                entry.code == null ? null : h(Badge, { tone: entry.code === 0 ? "add" : "del" }, String(entry.code)),
                entry.durationMs ? h("span", { className: "cg-muted cg-mini" }, entry.durationMs + " 毫秒") : null,
                h(IconBtn, { name: "copy", label: "复制命令", size: 11, onClick: () => copyText(entry.display || "") }),
              ),
              entry.stdout ? h("pre", { className: "cg-console-out" }, entry.stdout) : null,
              entry.stderr ? h("pre", { className: "cg-console-out cg-err" }, entry.stderr) : null,
            ),
          )
        : h(Empty, { icon: "terminal", title: "还没有执行命令" }, h("span", null, "命令会记录在上方，便于排查")),
    ),
  );
}

/* ---------- 设置 ---------- */

function SettingsTab(props) {
  const repo = props.repo;
  const { useEffect } = appCtx.react;
  useEffect(() => {
    if (!repo) return;
    const data = ensureRepoData(repo);
    if (!data.config) void loadConfig(repo);
  }, [repo]);
  return appCtx.react.createElement(SettingsForm, { repo });
}

function SettingsForm(props) {
  const h = appCtx.react.createElement;
  const s = useStoreSnapshot();
  const { useEffect, useState } = appCtx.react;
  const settings = s.settings;
  const data = props.repo ? ensureRepoData(props.repo) : null;
  const [exclude, setExclude] = useState(settings.scanExclude);
  const [depth, setDepth] = useState(String(settings.scanDepth));
  const [interval, setIntervalValue] = useState(String(settings.refreshInterval));
  const [pageSize, setPageSize] = useState(String(settings.logPageSize));
  const [context, setContext] = useState(String(settings.diffContext));
  // 设置从别处变更（重置、宿主同步）时同步本地输入，避免输入框停在旧值。
  useEffect(() => { setExclude(settings.scanExclude); }, [settings.scanExclude]);
  useEffect(() => { setDepth(String(settings.scanDepth)); }, [settings.scanDepth]);
  useEffect(() => { setIntervalValue(String(settings.refreshInterval)); }, [settings.refreshInterval]);
  useEffect(() => { setPageSize(String(settings.logPageSize)); }, [settings.logPageSize]);
  useEffect(() => { setContext(String(settings.diffContext)); }, [settings.diffContext]);
  // 数值输入在 Enter 时提交（失焦触发 onBlur 的钳制与保存），不必再点别处。
  const blurOnEnter = (event) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };
  const save = (patch) => {
    void saveSettings(patch);
  };
  const reset = async () => {
    const confirmed = await confirmDestructive({
      title: "重置设置",
      message: "将所有 Git 工作台设置恢复为默认值？",
      confirmLabel: "重置",
      danger: true,
    });
    if (confirmed) {
      await saveSettings(Object.assign({}, DEFAULT_SETTINGS));
      state.commitSignOff = Boolean(DEFAULT_SETTINGS.signOff);
      state.commitSkipHooks = Boolean(DEFAULT_SETTINGS.skipHooks);
      state.commitNoGpg = Boolean(DEFAULT_SETTINGS.noGpgSign);
      setExclude(DEFAULT_SETTINGS.scanExclude);
      setDepth(String(DEFAULT_SETTINGS.scanDepth));
      setIntervalValue(String(DEFAULT_SETTINGS.refreshInterval));
      setPageSize(String(DEFAULT_SETTINGS.logPageSize));
      setContext(String(DEFAULT_SETTINGS.diffContext));
    }
  };
  return h(
    "div",
    { className: "cg-settings" },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" } },
      h(Icon, { name: "git", size: 18 }),
      h("b", { style: { fontSize: "0.875rem" } }, "Git 工作台设置"),
      h("div", { style: { flex: 1 } }),
      h(Btn, { size: "sm", icon: "refresh", onClick: () => scanWorkspace({ force: true }), disabled: !s.workspacePath }, "重新扫描仓库"),
    ),
    h("div", { className: "cg-settings-sub" }, "当前工作区：" + (s.workspacePath || "未连接") + (s.gitVersionRaw ? " · " + s.gitVersionRaw : "")),
    h("h3", null, "仓库发现"),
    h(
      "div",
      { className: "cg-kv" },
      h("label", null, "扫描深度"),
      h("input", {
        className: "cg-input cg-num",
        type: "number",
        min: 1,
        max: 20,
        value: depth,
        onChange: (event) => setDepth(event.target.value),
        onKeyDown: blurOnEnter,
        onBlur: () => {
          const clamped = Math.max(1, Math.min(20, Number(depth) || 2));
          setDepth(String(clamped));
          save({ scanDepth: clamped });
        },
      }),
      h("label", { title: "仓库扫描时跳过这些目录；未跟踪列表也会过滤同名目录（已跟踪文件的修改不受影响）" }, "排除目录"),
      h("textarea", {
        className: "cg-textarea",
        rows: 3,
        value: exclude,
        spellCheck: false,
        onChange: (event) => setExclude(event.target.value),
        onBlur: () => save({ scanExclude: exclude }),
      }),
      h("label", null, "自动扫描"),
      h(Check, { checked: Boolean(settings.autoScan), onChange: (value) => save({ autoScan: value }) }, "打开工作区时自动扫描"),
      h("label", null, "手动仓库"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "3px" } },
        ((s.manualRepos[pathKey(s.workspacePath)] || [])).length
          ? (s.manualRepos[pathKey(s.workspacePath)] || []).map((path) =>
              h("div", { key: path, style: { display: "flex", alignItems: "center", gap: "0.25rem" } },
                h("span", { className: "cg-mono cg-ellipsis", style: { flex: 1 }, title: path }, path),
                h(IconBtn, { name: "trash", label: "移除", size: 12, onClick: () => removeRepoManually(path) }),
              ),
            )
          : h("span", { className: "cg-muted" }, "无（使用左侧“添加/克隆”加入）"),
        h(Btn, { size: "sm", icon: "plus", onClick: () => addRepoManually() }, "添加仓库"),
      ),
    ),
    h("h3", null, "刷新与显示"),
    h(
      "div",
      { className: "cg-kv" },
      h("label", null, "自动刷新"),
      h(Check, { checked: Boolean(settings.autoRefresh), onChange: (value) => save({ autoRefresh: value }) }, "定时刷新当前仓库状态"),
      h("label", null, "刷新间隔（秒）"),
      h("input", {
        className: "cg-input cg-num",
        type: "number",
        min: 3,
        max: 300,
        value: interval,
        onChange: (event) => setIntervalValue(event.target.value),
        onKeyDown: blurOnEnter,
        onBlur: () => {
          const clamped = Math.max(3, Math.min(300, Number(interval) || 8));
          setIntervalValue(String(clamped));
          save({ refreshInterval: clamped });
        },
      }),
      h("label", null, "日志每页条数"),
      h("input", {
        className: "cg-input cg-num",
        type: "number",
        min: 20,
        max: 200,
        value: pageSize,
        onChange: (event) => setPageSize(event.target.value),
        onKeyDown: blurOnEnter,
        onBlur: () => {
          const clamped = Math.max(20, Math.min(200, Number(pageSize) || 100));
          setPageSize(String(clamped));
          save({ logPageSize: clamped });
        },
      }),
      h("label", null, "差异上下文行数"),
      h("input", {
        className: "cg-input cg-num",
        type: "number",
        min: 0,
        max: 50,
        value: context,
        onChange: (event) => setContext(event.target.value),
        onKeyDown: blurOnEnter,
        onBlur: () => {
          const clamped = Math.max(0, Math.min(50, Number.isFinite(Number(context)) ? Number(context) : 3));
          setContext(String(clamped));
          save({ diffContext: clamped });
        },
      }),
    ),
    h("h3", null, "提交与同步"),
    h(
      "div",
      { className: "cg-kv" },
      h("label", null, "默认拉取策略（Pull）"),
      h(Select, {
        value: settings.pullStrategy,
        options: [
          { value: "merge", label: "合并（Merge，--no-rebase）" },
          { value: "rebase", label: "变基（Rebase，--rebase）" },
          { value: "ff-only", label: "仅快进（--ff-only）" },
        ],
        onChange: (value) => save({ pullStrategy: value }),
        className: "cg-select-wide",
      }),
      h("label", null, "获取时清理（Fetch --prune）"),
      h(Check, { checked: Boolean(settings.fetchPrune), onChange: (value) => save({ fetchPrune: value }) }, "自动清理已删除的远程分支"),
      h("label", null, "新提交默认署名（Sign-off）"),
      h(Check, { checked: Boolean(settings.signOff), onChange: (value) => save({ signOff: value }) }, "使用 git commit -s 署名"),
      h("label", null, "默认跳过 Git 钩子"),
      h(Check, { checked: Boolean(settings.skipHooks), onChange: (value) => save({ skipHooks: value }) }, "使用 git commit --no-verify"),
      h("label", null, "默认禁用 GPG 签名"),
      h(Check, { checked: Boolean(settings.noGpgSign), onChange: (value) => save({ noGpgSign: value }) }, "使用 git commit --no-gpg-sign"),
      h("label", null, "危险操作二次确认"),
      h(Check, { checked: Boolean(settings.confirmDestructive), onChange: (value) => save({ confirmDestructive: value }) }, "回滚、重置、删除前弹窗确认"),
    ),
    h("h3", null, "仓库信息"),
    data
      ? h(
          "div",
          { className: "cg-kv" },
          h("label", null, "当前仓库"),
          h("span", { className: "cg-mono cg-ellipsis" }, props.repo),
          h("label", null, "Git 目录"),
          h("span", { className: "cg-mono cg-ellipsis" }, data.gitDir || "(未知)"),
          h("label", null, "Git 版本"),
          h("span", { className: "cg-mono" }, s.gitVersionRaw || "(未检测)"),
          h("label", null, "裸仓库（bare）"),
          h("span", null, data.bare ? "是" : "否"),
          h("label", null, "索引标记"),
          h("div", { style: { display: "flex", alignItems: "center", gap: "0.375rem" } },
            h("span", { className: "cg-muted cg-mini" }, "“假定未更改”（assume-unchanged）与“跳过工作树”（skip-worktree）会让文件从状态中隐藏"),
            h(Btn, { size: "sm", icon: "undo", onClick: () => resetIndexFlags(props.repo) }, "恢复隐藏文件"),
          ),
        )
      : h("div", { className: "cg-settings-sub" }, "选择一个仓库后显示详细信息。"),
    h("h3", null, "Git 配置"),
    data
      ? h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "0.375rem" } },
          h(
            "div",
            { style: { display: "flex", gap: "0.375rem", alignItems: "center" } },
            h("span", { className: "cg-muted cg-mini" }, "仓库本地配置（--show-origin）"),
            h("div", { style: { flex: 1 } }),
            h(Btn, { size: "sm", icon: "refresh", onClick: () => loadConfig(props.repo) }, "刷新"),
            h(Btn, { size: "sm", icon: "edit", onClick: () => setConfigDialog(props.repo) }, "修改配置"),
          ),
          data.config && data.config.error
            ? h(Banner, { tone: "error" }, data.config.error)
            : data.config && data.config.loading
              ? h("div", { className: "cg-notice" }, "正在读取配置…")
              : h("pre", { className: "cg-code cg-mini", style: { whiteSpace: "pre-wrap", margin: 0, maxHeight: "13.75rem", overflow: "auto" } }, (data.config && data.config.text) || "(没有配置项)"),
        )
      : null,
    h(
      "div",
      { style: { display: "flex", gap: "0.375rem", paddingTop: "0.5rem", borderTop: "1px solid var(--color-separator-border)" } },
      h(Btn, { icon: "undo", variant: "danger", onClick: reset }, "恢复默认设置"),
      h("div", { style: { flex: 1 } }),
      h("span", { className: "cg-muted cg-mini" }, "设置保存在插件存储中，按工作区隔离手动仓库"),
    ),
  );
}

/* ---------- 右侧聊天面板轻量视图 ---------- */

/** 板块标题的键盘切换：Enter / 空格。 */
function sectionToggleKeys(toggle) {
  return (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };
}

function CompactPanel(props) {
  const h = appCtx.react.createElement;
  const { useEffect, useState } = appCtx.react;
  const s = useStoreSnapshot();
  const [reposOpen, setReposOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [groupOpen, setGroupOpen] = useState({});
  const inWorkspace = (path) =>
    Boolean(path) &&
    (pathKey(path) === pathKey(s.workspacePath) ||
      isSubPath(s.workspacePath, path) ||
      isSubPath(path, s.workspacePath));
  const scopedRepos = s.repos.filter((item) => item.isActiveWorkspaceRepo || inWorkspace(item.path));
  const workspaceRepos = scopedRepos;
  const repo =
    s.activeRepo && inWorkspace(s.activeRepo)
      ? s.activeRepo
      : workspaceRepos.length
      ? workspaceRepos[0].path
      : "";
  const view = repo ? getLogView(repo) : null;
  useEffect(() => {
    if (props && props.workspacePath) void setWorkspace(props.workspacePath);
    else if (!s.workspacePath) void syncWorkspaceFromHost();
  }, [props && props.workspacePath]);
  useEffect(() => {
    if (repo && view && !view.commits.length && !view.loading) void loadLog(repo, true);
  }, [repo]);
  const workspaceRepoKey = workspaceRepos.map((item) => item.path).join("\n");
  useEffect(() => {
    for (const item of workspaceRepos) {
      if (!ensureRepoData(item.path).quick) void refreshRepo(item.path, { quick: true });
    }
  }, [workspaceRepoKey]);
  if (!s.ready) return h("div", { className: "cg-panel cg-empty" }, h(Spinner, null));
  const data = repo ? ensureRepoData(repo) : null;
  const quick = data && data.quick && !data.quick.error ? data.quick : null;
  const branch = (quick ? quick.branch : data ? data.status.branch : null) || {};
  const fileView = s.settings.fileView === "flat" ? "flat" : "tree";
  const changeTotal = data ? countChanges(data) : 0;
  const selectedPath = s.selectedFile && pathKey(s.selectedFile.repo) === pathKey(repo) ? s.selectedFile.path : "";
  const checkedSet = new Set(checkedKeys(repo));
  const allEntries = data ? data.status.staged.concat(data.status.unstaged, data.status.untracked, data.status.conflicted) : [];
  const allChecked = allEntries.length > 0 && allEntries.every((entry) => checkedSet.has(entryKey(entry)));
  const checkedCount = checkedPaths(repo).length;
  const stageSelected = data ? data.status.unstaged.concat(data.status.untracked).filter((entry) => checkedSet.has(entryKey(entry))) : [];
  const unstageSelected = data ? data.status.staged.filter((entry) => checkedSet.has(entryKey(entry))) : [];
  return h(
    "div",
    { className: "cg-panel" },
    h(
      "div",
      {
        className: "cg-panel-list cg-panel-repos",
        // 列表容器默认 flex:1 撑满剩余高度，折叠时必须取消伸展，否则下方内容被推到底部。
        style: reposOpen ? null : { flex: "none", paddingBottom: 0 },
      },
      h(
        "div",
        {
          className: cx("cg-section-title", "cg-section-toggle"),
          role: "button",
          tabIndex: 0,
          title: reposOpen ? "折叠工作区仓库" : "展开工作区仓库",
          onClick: () => setReposOpen((value) => !value),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setReposOpen((value) => !value);
            }
          },
        },
        h(Icon, { name: reposOpen ? "chevron-down" : "chevron-right", size: 11 }),
        h("span", null, "工作区仓库"),
        h(Badge, null, workspaceRepos.length),
        h("span", { className: "cg-section-wsname cg-ellipsis", title: s.workspacePath || "" }, s.workspaceName || s.workspacePath || "未连接工作区"),
        h(
          "span",
          { className: "cg-section-actions", onClick: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation() },
          h(IconBtn, { name: "external", size: 12, label: "打开全屏 Git 工作台", onClick: () => openWorkbench("changes", repo) }),
          h(IconBtn, {
            name: "refresh",
            size: 12,
            label: s.scanning ? "正在扫描仓库…" : data && data.loading.status ? "刷新中…" : "重新扫描仓库并刷新",
            loading: Boolean(s.scanning || (data && data.loading.status)),
            disabled: Boolean(s.scanning || (data && data.loading.status)),
            onClick: async () => {
              // 面板刷新必须重扫工作区：新克隆/新建/删除的仓库只有扫描才会出现在列表里。
              await scanWorkspace({ force: true });
              const target = state.activeRepo || repo;
              if (target && state.repos.some((item) => pathKey(item.path) === pathKey(target))) {
                await refreshRepo(target, { quick: true });
              }
            },
          }),
        ),
      ),
      !reposOpen
        ? null
        : workspaceRepos.length
        ? workspaceRepos.map((item) => {
            const d = ensureRepoData(item.path);
            const q = d.quick && !d.quick.error ? d.quick : null;
            const b = (q ? q.branch : d.status.branch) || {};
            const changed = q ? q.changed || 0 : countChanges(d);
            return h(
              "div",
              {
                key: item.path,
                className: cx("cg-row", pathKey(item.path) === pathKey(repo) ? "cg-active" : ""),
                onClick: () => setActiveRepo(item.path),
                title: item.path,
              },
              h(Icon, { name: item.worktree ? "archive" : "git", size: 11 }),
              h("span", { className: "cg-row-name" }, repoDisplayName(item.path, s.workspacePath)),
              h("span", { className: "cg-row-dir cg-mono" }, b.detached ? "游离 HEAD" : b.head || ""),
              changed ? h(Badge, null, changed) : null,
            );
          })
        : h("div", { className: "cg-notice" }, s.scanning ? "正在扫描仓库…" : "当前工作区不是 Git 仓库"),
    ),
    !repo
      ? h(
          Empty,
          { icon: "git", title: s.scanning ? "正在扫描 Git 仓库…" : "未发现 Git 仓库" },
          h("span", null, s.workspacePath || ""),
          s.scanning
            ? h(Spinner, null)
            : h("span", { className: "cg-muted" }, "点击右上角刷新按钮重新扫描工作区"),
        )
      : h(
          appCtx.react.Fragment,
          null,
          h(
            "div",
            { className: "cg-panel-card" },
            h(
              "div",
              { className: "cg-panel-summary" },
              h(
                "div",
                { className: "cg-summary-row" },
                h(
                  "span",
                  { className: "cg-summary-item cg-summary-branch", title: "分支" },
                  h(Icon, { name: "branch", size: 11 }),
                  h("b", { className: "cg-ellipsis" }, branch.detached ? "游离 HEAD" : branch.head || "(无)"),
                ),
                h("span", { className: "cg-summary-item", title: "领先/落后" }, "↑" + (branch.ahead || 0) + " ↓" + (branch.behind || 0)),
                h("span", { className: "cg-summary-repo", title: repo }, repoDisplayName(repo)),
              ),
              h(
                "div",
                { className: "cg-summary-row cg-summary-counts" },
                h("span", { className: "cg-summary-item", title: "变更文件" }, "变更 ", h("b", null, quick ? quick.changed || 0 : countChanges(data))),
                h("span", { className: "cg-summary-item", title: "暂存区" }, "暂存 ", h("b", null, quick ? quick.staged || 0 : data.status.staged.length)),
                h("span", { className: "cg-summary-item", title: "未暂存" }, "未暂存 ", h("b", null, quick ? quick.unstaged || 0 : data.status.unstaged.length)),
                h("span", { className: "cg-summary-item", title: "未跟踪" }, "未跟踪 ", h("b", null, quick ? quick.untracked || 0 : data.status.untracked.length)),
              ),
            ),
          ),
          h(
            "div",
            { style: { display: "flex", gap: "0.375rem", padding: "0 12px 8px", flexWrap: "wrap" } },
            h(Btn, { size: "sm", icon: "fetch", title: "获取远程更新（Fetch）", onClick: () => fetchRepo(repo, { all: true }) }, "获取"),
            h(Btn, { size: "sm", icon: "pull", title: "拉取远程更新（Pull）", onClick: () => pullRepo(repo) }, "拉取"),
            h(Btn, { size: "sm", icon: "push", title: "推送到远程（Push）", onClick: () => pushDialog(repo) }, "推送"),
            h(Btn, { size: "sm", icon: "commit", onClick: () => openWorkbench("changes", repo) }, "提交"),
          ),
          Object.keys(data.detailsErrors || {}).length || data.refsTruncated
            ? h(
                "div",
                {
                  className: "cg-notice",
                  style: { margin: "0 12px 8px" },
                  title: detailErrorSummary(data.detailsErrors),
                },
                Object.keys(data.detailsErrors || {}).length ? Object.keys(data.detailsErrors).length + " 项仓库信息读取失败" : "",
                data.refsTruncated ? "引用列表已截断（超过 64 KiB）" : "",
              )
            : null,
          h(
            "div",
            { className: "cg-panel-list" },
            h(
              "div",
              {
                className: cx("cg-section-title", "cg-section-toggle"),
                style: { position: "static" },
                role: "button",
                tabIndex: 0,
                title: changesOpen ? "折叠工作区更改" : "展开工作区更改",
                onClick: () => setChangesOpen((value) => !value),
                onKeyDown: sectionToggleKeys(() => setChangesOpen((value) => !value)),
              },
              h(Icon, { name: changesOpen ? "chevron-down" : "chevron-right", size: 11 }),
              h(
                "span",
                { style: { display: "inline-flex" }, onClick: (event) => event.stopPropagation() },
                h(Check, { checked: allChecked, onChange: (value) => setAllChecked(repo, value), title: "全选/全不选" }),
              ),
              "工作区更改",
              h(Badge, null, changeTotal),
              h("div", { style: { flex: 1 } }),
              h(
                "div",
                { className: "cg-seg", role: "group", "aria-label": "文件视图", onClick: (event) => event.stopPropagation() },
                h("button", { type: "button", className: fileView === "tree" ? "cg-on" : "", title: "树形", onClick: () => saveSettings({ fileView: "tree" }) }, h(Icon, { name: "folder", size: 12 })),
                h("button", { type: "button", className: fileView === "flat" ? "cg-on" : "", title: "平铺", onClick: () => saveSettings({ fileView: "flat" }) }, h(Icon, { name: "file", size: 12 })),
              ),
            ),
            changesOpen && checkedCount
              ? h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: "0.375rem", padding: "0 10px 6px" } },
                  h("span", { className: "cg-muted cg-mini" }, "已选 " + checkedCount),
                  h("div", { style: { flex: 1 } }),
                  stageSelected.length ? h(Btn, { size: "sm", icon: "plus", onClick: () => stageEntries(repo, stageSelected) }, "暂存") : null,
                  unstageSelected.length ? h(Btn, { size: "sm", icon: "minus", onClick: () => unstageEntries(repo, unstageSelected) }, "取消暂存") : null,
                )
              : null,
            !changesOpen
              ? null
              : changeTotal
                ? changeGroups(data).map((group) => {
                    const open = groupOpen[group.key] !== false;
                    const toggleGroup = () => setGroupOpen((prev) => Object.assign({}, prev, { [group.key]: !(prev[group.key] !== false) }));
                    return h(
                      "div",
                      { key: group.key },
                      h(
                        "div",
                        {
                          className: cx("cg-group-head", "cg-section-toggle"),
                          style: { position: "static" },
                          role: "button",
                          tabIndex: 0,
                          title: (open ? "折叠" : "展开") + group.title,
                          onClick: toggleGroup,
                          onKeyDown: sectionToggleKeys(toggleGroup),
                        },
                        h(Icon, { name: open ? "chevron-down" : "chevron-right", size: 11 }),
                        h("span", { className: "cg-group-title" }, group.title),
                        h(Badge, null, group.entries.length),
                      ),
                      open
                        ? fileView === "tree"
                          ? h(FileTreeList, {
                              files: group.entries,
                              activePath: selectedPath,
                              codeOf: entryCode,
                              toneOf: (entry) => (entry.unmerged ? "conflict" : statusTone(entryCode(entry))),
                              checkedOf: (entry) => checkedSet.has(entryKey(entry)),
                              onToggleCheck: (entry) => toggleChecked(repo, entry),
                              onCheckMany: (entries, value) => setCheckedMany(repo, entries, value),
                              onSelect: (entry) => {
                                selectFile(repo, entry, modeForEntry(entry));
                                openWorkbench("changes", repo);
                              },
                            })
                          : group.entries.map((entry) =>
                              h(
                                "div",
                                {
                                  key: group.key + entry.path,
                                  className: cx("cg-row", selectedPath === entry.path ? "cg-selected" : ""),
                                  onClick: () => {
                                    selectFile(repo, entry, modeForEntry(entry));
                                    openWorkbench("changes", repo);
                                  },
                                  title: entry.path,
                                },
                                h("input", {
                                  className: "cg-row-check",
                                  type: "checkbox",
                                  checked: checkedSet.has(entryKey(entry)),
                                  onClick: (event) => event.stopPropagation(),
                                  onChange: () => toggleChecked(repo, entry),
                                }),
                                h(Icon, { name: "file", size: 11, style: { color: "var(--color-text-tertiary)" } }),
                                h("span", { className: "cg-row-name" }, entry.path.split("/").pop()),
                                h("span", { className: "cg-row-dir" }, dirName(entry.path)),
                                h(Badge, { tone: entry.unmerged ? "conflict" : statusTone(entryCode(entry)) }, entryCode(entry)),
                              ),
                            )
                        : null,
                    );
                  })
                : h("div", { className: "cg-notice" }, "工作区干净"),
            view && view.commits.length
              ? h(
                  appCtx.react.Fragment,
                  null,
                  h(
                    "div",
                    {
                      className: cx("cg-section-title", "cg-section-toggle"),
                      style: { position: "static", marginTop: "0.25rem" },
                      role: "button",
                      tabIndex: 0,
                      title: commitsOpen ? "折叠最近提交" : "展开最近提交",
                      onClick: () => setCommitsOpen((value) => !value),
                      onKeyDown: sectionToggleKeys(() => setCommitsOpen((value) => !value)),
                    },
                    h(Icon, { name: commitsOpen ? "chevron-down" : "chevron-right", size: 11 }),
                    "最近提交",
                    h("div", { style: { flex: 1 } }),
                    h(Badge, null, view.commits.length),
                  ),
                  commitsOpen
                    ? view.commits.slice(0, 5).map((commit) =>
                        h(
                          "div",
                          { key: commit.hash, className: "cg-row", onClick: () => { openWorkbench("log", repo); selectCommit(repo, commit); } },
                          h(Icon, { name: "commit", size: 11 }),
                          h("span", { className: "cg-row-name" }, commit.subject),
                          h("span", { className: "cg-muted cg-mono cg-mini" }, shortHash(commit.hash)),
                        ),
                      )
                    : null,
                )
              : null,
          ),
        ),
  );
}

/* ===== 90-activate.js ===== */

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
    run: () => {
      void ensureRepoForCommand().then((repo) => repo && refreshRepo(repo, { details: true }));
    },
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
  void (async () => {
    try {
      await loadSettings();
      if (disposed) return;
      await syncWorkspaceFromHost();
      if (disposed) return;
      state.ready = true;
      notify();
    } catch (error) {
      // 热重载期间 appCtx 已被置空，此时不再向用户报错。
      if (!disposed) reportError(error, "Git 插件初始化");
    }
  })();
  return dispose;
}
