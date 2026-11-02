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
.cg-log-scroll{flex:1;overflow:auto;min-height:0;padding:2px 0}
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
.cg-panel-head{display:flex;align-items:center;gap:0.5625rem;padding:0.6875rem 0.875rem;border-bottom:1px solid var(--cg-border);min-height:3.125rem}
.cg-panel-head>svg:first-child{width:1.625rem;height:1.625rem;padding:0.375rem;border-radius:0.5rem;background:var(--cg-accent-soft);color:var(--cg-accent-text)}
.cg-panel-heading{display:flex;flex-direction:column;gap:1px;min-width:0}
.cg-panel-heading b{font-size:0.7813rem;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-panel-heading span{font-size:0.6563rem;color:var(--color-text-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-panel-card{flex:none;margin:0.375rem 0.625rem 0.5rem;border:1px solid var(--cg-border);border-radius:0.625rem;background:var(--cg-surface-2);overflow:hidden}
.cg-panel-card-head{display:flex;align-items:center;gap:0.375rem;padding:0.375rem 0.75rem;font-size:0.6875rem;font-weight:650;letter-spacing:.04em;color:var(--color-text-tertiary);border-bottom:1px solid var(--cg-border)}
.cg-panel-card>.cg-panel-summary{padding:0.375rem 0.75rem;border-bottom:0}
.cg-panel-summary{display:flex;flex-direction:column;gap:0.125rem;padding:0.375rem 0.875rem;border-bottom:1px solid var(--cg-border);line-height:1.35}
.cg-summary-row{display:flex;align-items:center;gap:0.75rem;min-width:0;font-size:0.6875rem;color:var(--color-text-tertiary)}
.cg-summary-counts{flex-wrap:wrap;gap:0.125rem 0.875rem}
.cg-summary-item{display:inline-flex;align-items:center;gap:0.1875rem;white-space:nowrap}
.cg-summary-item b{font-size:0.75rem;font-weight:650;color:var(--color-text-primary);font-variant-numeric:tabular-nums}
.cg-summary-branch{min-width:0;max-width:12rem;gap:0.25rem;color:var(--color-text-primary)}
.cg-summary-branch b{max-width:9rem}
.cg-summary-repo{margin-left:auto;min-width:0;max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-secondary)}
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
