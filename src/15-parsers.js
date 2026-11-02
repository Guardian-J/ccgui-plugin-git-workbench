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
