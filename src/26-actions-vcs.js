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
  }, { success: "已获取远程更新", details: true, log: true, quick: true });
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
    const output = (res.stdout || res.stderr || "").trim();
    // --autostash 回放冲突时 git pull 仍以 0 退出，但工作区已留下冲突与未清理的 autostash。
    if (/resulted in conflicts/i.test(output)) {
      return { conflict: true, autostash: true, message: output };
    }
    return { conflict: false, message: output };
  }, { refresh: false, errorPrefix: "拉取失败" }).then(async (result) => {
    if (!result.ok) return result;
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
  return perform(repo, "推送", async () => {
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
  }, { success: "推送完成", details: true, quick: true });
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
  }, { success: "已检出 " + name, details: true, log: true, quick: true });
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
  }, { success: "已创建并检出分支 " + name, details: true, log: true, quick: true });
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
  }, { success: "已重命名分支", details: true, quick: true });
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
  }, { success: "已删除分支 " + name, details: true, quick: true });
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
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
  }, { success: "已重置到 " + shortHash(hash), details: true, log: true, quick: true });
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
  }, { success: "已检出提交", details: true, log: true, quick: true });
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
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
  }, { success: "已压缩 " + n + " 个提交", details: true, log: true, quick: true });
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
  }, { success: "已修改提交信息", details: true, log: true, quick: true });
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
  }, { success: "操作已继续", details: true, log: true, quick: true });
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
  }, { success: "已中止操作", details: true, log: true, quick: true });
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
  }, { success: "已跳过", details: true, log: true, quick: true });
}

async function resolveConflict(repo, path, side) {
  if (side !== "ours" && side !== "theirs") {
    toast("未知的冲突解决方式", "error");
    return { ok: false };
  }
  return perform(repo, "解决冲突", async () => {
    const res = await runGit(repo, ["checkout", "--" + side, "--", path], {
      allowFailure: true,
      timeoutMs: 30000,
    });
    if (res.code !== 0) throw new GitCommandError((res.stderr || "").trim(), res.entry);
    await runGit(repo, ["add", "--", path], { timeoutMs: 30000 });
  }, { success: "已采用 " + (side === "ours" ? "ours" : "theirs") + " 版本", details: true, quick: true });
}

async function saveConflictFile(repo, path, text) {
  return perform(repo, "保存冲突文件", async () => {
    await writeWorkspaceFile(joinPath(repo, path), text);
    await runGit(repo, ["add", "--", path], { timeoutMs: 30000 });
  }, { success: "已保存并标记为已解决", details: true, quick: true });
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
  }, { success: "已创建贮藏", details: true, quick: true });
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
    await refreshRepo(repo, { details: true, log: true, quick: true });
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
  }, { success: "已从贮藏创建分支", details: true, log: true, quick: true });
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
  }, { success: "已清空贮藏", details: true, quick: true });
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
  }, { success: "已删除远程", details: true, quick: true });
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
  }, { success: "子模块已更新", details: true, quick: true });
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
  }, { success: "子模块已添加", details: true, quick: true });
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
  }, { success: "工作树已创建", details: true, quick: true });
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
  }, { refresh: true, details: true, log: true, quick: true, errorPrefix: "命令失败" });
}
