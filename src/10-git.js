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
  '[ -f "$CCGIT_FILE" ] || exit 3; tail -c +$((CCGIT_OFFSET + 1)) "$CCGIT_FILE" | head -c "$CCGIT_LEN" | base64';

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
  return {
    text: binary ? "" : decodeUtf8(merged),
    bytes: merged,
    binary,
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
async function writeWorkspaceFile(path, text, options) {
  const opts = options || {};
  const windows = shellIsWindows({ CCGIT_FILE: path });
  const chunks = chunkText(text, windows ? 12000 : 24000);
  if (!chunks.length) chunks.push("");
  for (let i = 0; i < chunks.length; i += 1) {
    const append = Boolean(opts.append) || i > 0;
    await runShell(windows ? powershellWriteScript(append) : posixWriteScript(append), {
      CCGIT_FILE: toSlash(path),
      CCGIT_CHUNK: chunks[i],
    }, { description: "写入文件", timeoutMs: 30000, silent: true });
  }
  return true;
}

async function appendWorkspaceFile(path, text) {
  return writeWorkspaceFile(path, text, { append: true });
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
      .split(",")
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
  if (!list.length) return [];
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
  // owner 与 .git 路径按 NUL 成对输出；目录名含换行/制表符也不会错位。
  const tokens = String(res.stdout || "").replace(/^\uFEFF/, "").split("\0");
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
  return found;
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
      for (const item of await scanGitRoots(deepTargets.map((target) => target.path), settings)) {
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

/** 快速摘要：分支/上游/变更数量，用于仓库列表与状态栏。 */
async function loadQuickStatus(repoPath) {
  let res = await runGit(repoPath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
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
  const parsed = parseStatusPorcelain(res.stdout, res.stderr, gitVersion);
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
