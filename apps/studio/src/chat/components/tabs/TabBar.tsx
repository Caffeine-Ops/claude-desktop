import React, { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { TabDescriptor } from '@desktop-shared/ipc-channels'
import { NotificationBadge } from '../common/NotificationBadge'
import { railGliderSpring } from '../../shell/railMotion'

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

  // 搜索对话 — the dialog itself lives in the ACTIVE CHAT TAB's renderer
  // (this rail is only 220px of visible surface; a 580px Spotlight panel
  // physically can't render here). The row just fires the forwarded menu
  // action; main routes it to the chat tab, which owns the UI. ⌘K here
  // covers the case where FOCUS is on the shell webContents — the chat
  // renderer has its own listener for the (far more common) case where
  // focus sits in the composer.
  const onOpenSearch = (): void => {
    void window.tabApi?.triggerMenuAction('open-search')
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenSearch()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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
      <NavActionRow
        label="组件与扩展"
        icon={<PuzzleGlyph />}
        onClick={() => void window.tabApi?.triggerMenuAction('open-components')}
      />
      <NavActionRow
        label="搜索对话"
        icon={<SearchGlyph />}
        trailing={
          <span className="rounded border border-black/10 px-1 py-px font-mono text-[10px] text-[color:var(--rail-muted)] dark:border-white/15">
            ⌘K
          </span>
        }
        onClick={onOpenSearch}
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
  trailing,
  onClick
}: {
  label: string
  icon: React.ReactNode
  /** Right-edge adornment, e.g. the ⌘K shortcut hint on 搜索对话. */
  trailing?: React.ReactNode
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
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  )
}

function SearchGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="m21 21-4.35-4.35" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
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

function PuzzleGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
      <path
        d="M10 4.5A1.5 1.5 0 0 1 11.5 3h1A1.5 1.5 0 0 1 14 4.5V6h3a1 1 0 0 1 1 1v3h1.5a1.5 1.5 0 0 1 0 3H18v3a1 1 0 0 1-1 1h-3v-1.5a1.5 1.5 0 0 0-3 0V17H8a1 1 0 0 1-1-1v-3H5.5a1.5 1.5 0 0 1 0-3H7V7a1 1 0 0 1 1-1h2V4.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
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

  // Full-width nav row. `relative isolate` so the glider can sit on -z-[1]:
  // isolate opens a local stacking context, which puts the glider ABOVE the
  // row's own hover wash but BELOW the icon/label/badge — no per-child
  // z-index needed.
  const sharedClass =
    'group relative isolate flex h-9 w-full items-center gap-2.5 rounded-lg pl-3 pr-2.5 text-left text-[13px] leading-none transition-colors cursor-default select-none'

  // Active styling is now TEXT-ONLY: the fill + accent bar moved into the
  // shared-layout glider below, so switching tabs SLIDES the highlight from
  // the old row to the new one instead of blinking two backgrounds.
  const activeClass = 'text-[color:var(--rail-text)] font-medium'
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
      {/* Active highlight glider — fill + 3px macOS source-list accent bar in
          ONE absolutely-positioned layer. `layoutId` makes Motion FLIP it from
          the previously-active row to this one (transform-only, spring-driven,
          interruptible mid-flight), matching the v3 prototype's sliding
          glider. Rows are same-size so the FLIP is pure translation — no
          border-radius distortion to worry about. */}
      {tab.active ? (
        <motion.span
          aria-hidden
          layoutId="rail-nav-glider"
          transition={railGliderSpring}
          className="absolute inset-0 -z-[1] rounded-lg bg-[var(--rail-active)]"
        >
          <span className="absolute left-0.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-[var(--rail-accent)]" />
        </motion.span>
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
