import React, { useEffect, useState } from 'react'
import type { TabDescriptor } from '../../../../shared/ipc-channels'
import { NotificationBadge } from '../common/NotificationBadge'

/**
 * Vertical navigation rail — rendered inside the shell window's own
 * `.shell-chrome` (a 220px left column; see main.css + tabRegistry's
 * NAV_RAIL_WIDTH). Source of truth for the tab set lives in main's
 * tabRegistry; this component subscribes to `TAB_LIST_CHANGED` and
 * renders one full-width nav row per tab.
 *
 * Visual model — sidebar nav (NOT browser tabs):
 *
 *   - Each tab is a full-width row: [icon] [label] stacked vertically
 *     down the rail, left-aligned. No more horizontal pill strip.
 *   - The **active** row gets a faint foreground wash + a 3px accent
 *     bar on its left edge (the classic macOS source-list selection
 *     cue), and its label firms to medium weight.
 *   - **Inactive** rows are transparent with a gentle hover wash.
 *   - The chat tab's own session list (ThreadListSidebar, a separate
 *     webContents) butts right up against this rail's right edge, so
 *     the two read as one continuous left column.
 *
 * The tab set is fixed (chat "智能助手" + web "工作画布"), built by main
 * at startup — rows only switch, they can't be closed or added.
 */
export default function TabBar(): React.ReactElement {
  const [tabs, setTabs] = useState<readonly TabDescriptor[]>([])

  useEffect(() => {
    const api = window.tabApi
    if (!api) {
      console.error('[tabBar] window.tabApi missing — preload did not load')
      return
    }
    let cancelled = false

    void api.listTabs().then((result) => {
      if (!cancelled) setTabs(result.tabs)
    })
    const unsub = api.onTabListChanged((next) => {
      setTabs(next)
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  const onSwitchTab = (id: number): void => {
    void window.tabApi?.switchTab(id)
  }

  // The chat tab is the one whose title is NOT "工作画布". "新对话" routes
  // The chat tab is the one whose title is NOT "工作画布".
  const chatTab = tabs.find((t) => t.title !== '工作画布')

  // "新对话" — the single new-chat entry point (the per-list `+` was
  // removed). First make sure the chat tab is foreground (a new chat only
  // makes sense there, and the switch command routes to the ACTIVE chat
  // tab), then ask main to mint a fresh session. `switchShellSession(null)`
  // = new chat; main forwards it to the chat tab's runtime which runs its
  // real new-session flow.
  const onNewChat = (): void => {
    if (!chatTab) return
    if (!chatTab.active) void window.tabApi?.switchTab(chatTab.id)
    void window.tabApi?.switchShellSession(null)
  }

  return (
    <>
      {/* Top action: 新对话 — accent-tinted primary row, the only new-chat
          entry point. Marks itself no-drag so the click lands instead of
          dragging the window. */}
      <button
        type="button"
        onClick={onNewChat}
        disabled={!chatTab}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="group mb-1 flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] font-semibold text-[color:var(--rail-accent-ink)] transition-colors hover:bg-[var(--rail-accent-soft)] disabled:cursor-not-allowed disabled:opacity-40"
        title="新对话"
      >
        <PlusIcon />
        <span className="min-w-0 flex-1 truncate">新对话</span>
      </button>

      {/* Tab rows — one per fixed tab. */}
      <div className="flex flex-col gap-0.5">
        {tabs.map((tab) => (
          <TabRow key={tab.id} tab={tab} onClick={() => onSwitchTab(tab.id)} />
        ))}
      </div>

      {/* "更多" group — settings entry point. Settings isn't a tab (it's a
          full-window overlay managed by main), so it's a plain nav row that
          calls openSettingsWindow rather than switchTab. 定时任务 is NOT
          listed: the desktop app has no cron page (that's a fusion-code
          /schedule capability with no UI), so a row here would be a dead
          button. */}
      <div className="mt-3 mb-1 px-3 text-[11px] font-medium tracking-wide text-[color:var(--rail-muted)]">
        更多
      </div>
      <NavActionRow
        label="设置"
        icon={<GearGlyph />}
        onClick={() => void window.tabApi?.openSettingsWindow()}
      />
    </>
  )
}

/**
 * A non-tab nav row (e.g. 设置) — same visual rhythm as TabRow but it
 * fires an arbitrary action instead of switching a WebContentsView, and
 * never shows an active state (it doesn't correspond to a foreground tab).
 */
function NavActionRow({
  label,
  icon,
  onClick
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="group flex h-9 w-full items-center gap-2.5 rounded-lg pl-3 pr-2.5 text-left text-[13px] leading-none text-[color:var(--rail-text-soft)] transition-colors hover:bg-[var(--rail-hover)] hover:text-[color:var(--rail-text)]"
      title={label}
    >
      <span aria-hidden className="flex shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function GearGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 对话气泡 —— chat tab（"智能助手"）的图标。线性单色，继承 currentColor。 */
function ChatBubbleIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path
        d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16.5H9l-4 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 画板 —— web tab（"工作画布"）的图标。画框 + 内部对角构图线。 */
function DesignBoardIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3.5 15l4.5-4 3 2.5 4-4.5 5 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="9" cy="9" r="1.4" fill="currentColor" />
    </svg>
  )
}

function PlusIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function TabRow({
  tab,
  onClick
}: {
  tab: TabDescriptor
  onClick: () => void
}): React.ReactElement {
  // web tab 标题在主进程固定为 "工作画布"（见 tabRegistry，不跟随工作区
  // basename），据此区分两个固定 tab 的图标：设计 web tab 用画板，其余
  // （chat "智能助手"）用对话气泡。
  const isWebTab = tab.title === '工作画布'

  // Full-width nav row. `relative` so the active accent bar can absolutely
  // position on the left edge. 1px transparent border keeps active/inactive
  // the same box size so the row doesn't nudge layout on selection.
  const sharedClass =
    'group relative flex h-9 w-full items-center gap-2.5 rounded-lg pl-3 pr-2.5 text-left text-[13px] leading-none transition-colors cursor-default select-none'

  // Active: solid rail fill + firm text (prototype --bg-active). The 3px
  // green accent bar is a separate absolutely-positioned span below. All
  // colors come from the rail palette (--rail-*) so the rail matches the
  // prototype in light and stays sane in dark.
  const activeClass =
    'bg-[var(--rail-active)] text-[color:var(--rail-text)] font-medium'
  const inactiveClass =
    'bg-transparent text-[color:var(--rail-text-soft)] hover:bg-[var(--rail-hover)] hover:text-[color:var(--rail-text)]'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={`${sharedClass} ${tab.active ? activeClass : inactiveClass}`}
      title={tab.workspacePath ?? tab.title}
    >
      {/* Active selection bar — 3px accent on the left edge, the macOS
          source-list cue. Only rendered for the active row. */}
      {tab.active ? (
        <span
          aria-hidden
          className="absolute left-0.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-[var(--rail-accent)]"
        />
      ) : null}
      <span aria-hidden className="flex shrink-0 items-center justify-center">
        {isWebTab ? <DesignBoardIcon /> : <ChatBubbleIcon />}
      </span>
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      {/* Apple-style red notification badge — only when this tab's engine
          has at least one unresolved tool-permission request. */}
      {tab.pendingPermissionCount > 0 ? (
        <NotificationBadge
          count={tab.pendingPermissionCount}
          ringClassName={
            tab.active
              ? 'ring-[hsl(var(--background))]'
              : 'ring-[hsl(var(--background)/0.72)]'
          }
        />
      ) : null}
    </div>
  )
}
