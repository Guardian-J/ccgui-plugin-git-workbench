/* ---------------------------------------------------------------------------
 * Git 工作台 — 单文件插件的源码分片（构建脚本把它们按顺序拼成 main.js）。
 * 本分片：常量、平台/路径/文本工具、通用格式化。
 * 禁止 import：插件以 ESM blob 加载，只能使用宿主注入的 ctx.react。
 * ------------------------------------------------------------------------- */

const PLUGIN_ID = "git-workbench";
const PLUGIN_VERSION = "0.2.14";
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
