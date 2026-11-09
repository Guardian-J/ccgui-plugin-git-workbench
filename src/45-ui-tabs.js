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
                  h(IconBtn, { name: "play", label: "应用", size: 12, onClick: (event) => { event.stopPropagation(); return stashApply(repo, item.selector, "apply"); } }),
                  h(IconBtn, { name: "check", label: "应用并删除", size: 12, onClick: (event) => { event.stopPropagation(); return stashApply(repo, item.selector, "pop"); } }),
                  h(IconBtn, { name: "branch", label: "从贮藏新建分支", size: 12, onClick: (event) => { event.stopPropagation(); return stashBranch(repo, item.selector); } }),
                  h(IconBtn, { name: "trash", label: "删除贮藏", size: 12, onClick: (event) => { event.stopPropagation(); return stashApply(repo, item.selector, "drop"); } }),
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
                h(ActionButton, { className: fileView === "tree" ? "cg-on" : "", title: "树形", onClick: () => saveSettings({ fileView: "tree" }) }, h(Icon, { name: "folder", size: 12 })),
                h(ActionButton, { className: fileView === "flat" ? "cg-on" : "", title: "平铺", onClick: () => saveSettings({ fileView: "flat" }) }, h(Icon, { name: "file", size: 12 })),
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
