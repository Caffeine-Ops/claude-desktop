import React, { useEffect, useState } from 'react'
import type { TabDescriptor } from '../../../../shared/ipc-channels'
import { NotificationBadge } from '../common/NotificationBadge'

/**
 * Safari / macOS-style tab strip — rendered inside each tab
 * renderer's `<header>`, right next to the panel-toggle buttons.
 * Source of truth lives in main's tabRegistry; this component
 * subscribes to `TAB_LIST_CHANGED` and renders.
 *
 * Visual model — Apple-inspired:
 *
 *   - All tabs are **uniformly rounded** (rounded-lg) pills that
 *     float inside the toolbar material. No Chrome-style "active
 *     tab merges into content" shoulder trick — that was a
 *     skeuomorphic cue from desktop browsers that Apple's own
 *     Safari 15+ abandoned in favor of a cleaner Ferris-wheel of
 *     identically-shaped pills.
 *   - The **active** pill gets a white / near-white fill and a
 *     soft drop shadow (card-like elevation). The title text
 *     flips to full foreground so it reads with clear emphasis
 *     over the toolbar material.
 *   - **Inactive** pills are transparent; hover adds a gentle
 *     gray fill. No vertical dividers between them — just gaps.
 *     The row reads as "a bar of breathing pills" rather than
 *     Chrome's "segmented contiguous strip".
 *   - Favicon chip is desaturated (pastel) rather than the
 *     bright rainbow it used to be — Apple's chrome is
 *     near-monochrome, and a loud hue here would fight the
 *     Apple Blue accent that lives on interactive elements.
 *   - Close `×` fades in on hover for inactive tabs, always
 *     visible on the active one.
 *   - The `+` New-tab button is a round, icon-only button
 *     following Apple's toolbar button idiom.
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

  return (
    <>
      {/* Tab strip proper: grows to fill whatever horizontal
          space the panel-toggles cluster leaves free, then lets
          its children (pills) distribute that width evenly via
          `flex-1` + `min-w-0`, which is what keeps the row from
          pushing the panel toggles off-screen without needing
          an overflow clip. We intentionally do NOT use
          `overflow-hidden` here — the active pill's drop shadow
          extends 1-2px above and below its box, and any vertical
          clip on this container would slice the shadow off the
          top/bottom edges. `gap-1` gives the Safari-style "pills
          float with air between them" rhythm. Individual pills
          mark themselves `no-drag` so clicks still route through
          the header drag region.

          关闭 `×` 和新建 `+` 按钮已移除：tab 集合是固定的（chat + Open
          Design），由主进程在启动时建好，用户不应增删，所以 pill 只能点击
          切换，不再可关闭，也没有新建入口。 */}
      <div className="flex min-w-0 flex-1 items-center gap-1 self-stretch">
        {tabs.map((tab) => (
          <TabPill
            key={tab.id}
            tab={tab}
            onClick={() => onSwitchTab(tab.id)}
          />
        ))}
      </div>
    </>
  )
}

/** 8-hue palette used for the per-tab color chip. Desaturated
 *  from the previous bright values so the chips read as pastel
 *  letter tiles instead of rainbow emoji — Apple's chrome is
 *  monochromatic and a loud hue here would fight the Apple Blue
 *  accent reserved for interactive elements. */
const CHIP_HUES = [212, 150, 32, 340, 264, 10, 180, 280] as const

function chipColor(key: string): { bg: string; fg: string } {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const hue = CHIP_HUES[Math.abs(hash) % CHIP_HUES.length]!
  return {
    bg: `hsl(${hue} 38% 88%)`,
    fg: `hsl(${hue} 52% 32%)`
  }
}

function chipLetter(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return '?'
  const match = trimmed.match(/[\p{L}\p{N}]/u)
  if (match) return match[0]!.toUpperCase()
  return trimmed[0]!.toUpperCase()
}

function TabPill({
  tab,
  onClick
}: {
  tab: TabDescriptor
  onClick: () => void
}): React.ReactElement {
  const chip = chipColor(tab.workspacePath ?? String(tab.id))
  const letter = chipLetter(tab.title)

  // All tabs share the same shape — uniformly rounded pills that
  // `flex-1` into the available width. Height is 28px (h-7) for a
  // compact Safari feel. Min-width is tight so a packed strip
  // collapses down to just the favicon + truncated letters. A 1px
  // transparent border keeps inactive/active the same box size so the
  // active border doesn't nudge layout — mirrors web `.workspace-tab`
  // (border: 1px solid transparent → border-color on .is-active).
  const sharedClass =
    'group relative flex flex-1 h-7 items-center gap-2 pl-2.5 pr-1.5 rounded-lg border border-transparent text-[12.5px] leading-none transition-colors cursor-default select-none min-w-[56px] max-w-[240px]'

  // Active: the strip itself is the web Open Design tab's warm black (see
  // `.dark .shell-chrome` in main.css), so a solid gray card fill would
  // clash with it. Instead the active pill
  // lifts off the bar with a very faint FOREGROUND wash (≈7%) plus a
  // hairline foreground border — enough to read as "selected" without
  // breaking the pure-black aesthetic. Using `foreground` (not literal
  // white) keeps it correct in BOTH themes: a faint dark tint on the
  // light bar, a faint white tint on the black bar — the same
  // theme-agnostic trick web's `.workspace-tab` uses with
  // `color-mix(--text …, transparent)`. Text firms to full foreground.
  const activeClass =
    'bg-foreground/[0.07] text-foreground border-foreground/[0.1]'

  // Inactive: transparent, with a gentle neutral hover wash. Border stays
  // transparent so only the active pill shows a hairline.
  const inactiveClass =
    'bg-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground/90'

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
      <span
        aria-hidden="true"
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold"
        style={{ backgroundColor: chip.bg, color: chip.fg }}
      >
        {letter}
      </span>
      {/* Active label firms to medium (500), echoing web
          `.workspace-tab.is-active .workspace-tab__label { font-weight: 500 }`
          so "which tab am I on" reads at a glance — the same emphasis
          cue the web chrome uses now that the fill is a subtle lifted
          card rather than a high-contrast white. */}
      <span className={`min-w-0 flex-1 truncate ${tab.active ? 'font-medium' : ''}`}>
        {tab.title}
      </span>
      {/* Apple-style red notification badge — only rendered when the
          tab's engine has at least one unresolved tool-permission
          request across any of its session runtimes. The ring color
          matches whichever pill state the tab is in (active = white
          fill, inactive = toolbar material) so the badge reads as
          "pinned to this tab" rather than floating above it. */}
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
      {/* 关闭 `×` 按钮已移除：tab 集合固定（chat + Open Design），由主进程
          建好，用户不可关闭——pill 只用于切换。 */}
    </div>
  )
}
