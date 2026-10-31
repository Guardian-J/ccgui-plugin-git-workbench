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
        const text = reportError(error, opts.errorPrefix || label);
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

async function ensureFileDiff(repo, entry, mode, force) {
  const data = ensureRepoData(repo);
  const diffMode = mode || state.diffMode || "head";
  if (!entry) return null;
  const key = diffCacheKey(entry, diffMode);
  const cached = data.diffCache[key];
  if (cached && cached.loading) return cached;
  if (!force && cached && cached.generation === data.statusGeneration && Date.now() - cached.at < 3000) return cached;
  const generationAtStart = data.statusGeneration;
  const result = {
    loading: true,
    error: null,
    text: "",
    files: [],
    preview: null,
    entry,
    mode: diffMode,
    at: Date.now(),
    generation: generationAtStart,
  };
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
      result.truncated = res.stdout.length >= GIT_MAX_OUTPUT - 64 || (res.stdout.length > 0 && !res.stdout.endsWith("\n"));
      result.files = parseUnifiedDiff(res.stdout);
    }
    result.loading = false;
    result.at = Date.now();
    // 请求期间状态已变化：这批内容属于旧代际，丢弃并立即按新代际重取，
    // 否则依赖数组不会再次变化，界面会一直停在旧差异上。
    if (generationAtStart !== data.statusGeneration) {
      if (data.diffCache[key] === result) delete data.diffCache[key];
      void ensureFileDiff(repo, entry, diffMode, true);
    }
  } catch (error) {
    result.loading = false;
    result.error = safeError(error);
    result.at = Date.now();
  }
  notify();
  return result;
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
