import React, { useEffect, useState } from 'react'
import type { TabDescriptor } from '../../../../shared/ipc-channels'

/**
 * Chrome-style tab strip rendered inside each tab renderer's
 * `<header>`, right next to the panel-toggle buttons. Source of
 * truth lives in main's tabRegistry; this component just subscribes
 * to `TAB_LIST_CHANGED` and renders.
 *
 * Visual model — faithful to desktop Chrome:
 *
 *   - Inactive tabs are **fully rounded** (`rounded-lg`) and sit as
 *     floating pills, slightly shorter than the active tab so they
 *     read as recessed into the header band.
 *   - The active tab is `rounded-t-lg` only and reaches all the way
 *     to the header's bottom border, painting a 1px box-shadow in
 *     the same color as the workspace background below — that's
 *     what makes its bottom edge disappear into the content area.
 *   - Between adjacent inactive tabs a thin vertical divider sits
 *     in the seam. A tab's right-side divider is hidden when either
 *     it or its right neighbor is active OR hovered, so dragging
 *     the mouse across the strip feels like Chrome: the line
 *     closest to the cursor vanishes.
 *   - Each tab carries a color chip (single letter of the workspace
 *     basename) as a favicon stand-in, and a close `×` that's
 *     always visible on the active tab / fades in on hover for
 *     inactives.
 */
export default function TabBar(): React.ReactElement {
  const [tabs, setTabs] = useState<readonly TabDescriptor[]>([])
  const [hoveredId, setHoveredId] = useState<number | null>(null)

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

  const onNewTab = (): void => {
    void window.tabApi?.newTab()
  }

  const onSwitchTab = (id: number): void => {
    void window.tabApi?.switchTab(id)
  }

  const onCloseTab = (
    id: number,
    e: React.MouseEvent<HTMLButtonElement>
  ): void => {
    e.stopPropagation()
    void window.tabApi?.closeTab(id)
  }

  const shouldShowDividerRightOf = (idx: number): boolean => {
    if (idx >= tabs.length - 1) return false
    const me = tabs[idx]!
    const next = tabs[idx + 1]!
    if (me.active || next.active) return false
    if (me.id === hoveredId || next.id === hoveredId) return false
    return true
  }

  return (
    <>
      {/* Tab strip proper: grows to fill whatever horizontal
          space the panel-toggles cluster leaves free, then lets
          its children (pills) distribute that width evenly via
          their own `flex-1`. `overflow-hidden` clips any
          residual overflow when even the pills' min-widths
          exceed the available band, so a packed row of tabs can
          never push the panel toggles off-screen. Individual
          pills and the `+` button mark themselves `no-drag` so
          clicks still route through the header drag region. */}
      <div className="flex min-w-0 flex-1 items-end self-stretch overflow-hidden">
        {tabs.map((tab, idx) => (
          <TabPill
            key={tab.id}
            tab={tab}
            showRightDivider={shouldShowDividerRightOf(idx)}
            onMouseEnter={() => setHoveredId(tab.id)}
            onMouseLeave={() =>
              setHoveredId((current) => (current === tab.id ? null : current))
            }
            onClick={() => onSwitchTab(tab.id)}
            onClose={(e) => onCloseTab(tab.id, e)}
          />
        ))}
        <button
          type="button"
          onClick={onNewTab}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="mb-[5px] ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label="New tab"
          title="New tab"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>
      </div>
    </>
  )
}

/** 8-hue palette used for the per-tab color chip. */
const CHIP_HUES = [212, 150, 32, 340, 264, 10, 180, 280] as const

function chipColor(key: string): { bg: string; fg: string } {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  const hue = CHIP_HUES[Math.abs(hash) % CHIP_HUES.length]!
  return {
    bg: `hsl(${hue} 65% 62%)`,
    fg: 'white'
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
  showRightDivider,
  onMouseEnter,
  onMouseLeave,
  onClick,
  onClose
}: {
  tab: TabDescriptor
  showRightDivider: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClick: () => void
  onClose: (e: React.MouseEvent<HTMLButtonElement>) => void
}): React.ReactElement {
  const chip = chipColor(tab.workspacePath ?? String(tab.id))
  const letter = chipLetter(tab.title)

  // All tabs: flex row with favicon + title + close. `flex-1`
  // (grow 1, shrink 1, basis 0) lets every pill share the tab
  // strip's available width equally — with a few tabs each one
  // stretches up to its `max-w`, and when the strip is packed
  // they all contract together down to `min-w`. That's Chrome's
  // adaptive feel.
  const sharedClass =
    'group relative flex flex-1 items-center gap-2 pl-3 pr-2 text-[12.5px] leading-none transition-colors cursor-default select-none'

  const activeClass =
    // Active tab: taller (h-9), rounded top only, flush with the
    // header's bottom border. The box-shadow is a 1px bar the same
    // color as the workspace background — it sits on top of the
    // header's `border-bottom` directly under this tab, painting
    // over it so the active tab flows seamlessly into the content
    // area below. `min-w-[64px]` is narrower than an inactive
    // pill's floor so the active tab visually "wins" when the
    // strip is packed.
    'h-9 min-w-[64px] max-w-[240px] rounded-t-lg bg-background text-foreground shadow-[0_1px_0_0_hsl(var(--background))] z-[1] before:absolute before:inset-x-0 before:-top-px before:h-px before:rounded-t-lg before:bg-border/40'

  const inactiveClass =
    // Inactive tab: shorter (h-7), fully rounded, margin-bottom
    // so there's a gap between the pill bottom and the header's
    // border. Min-width is tight (`52px`) so a crowded strip
    // collapses tabs down to just the favicon chip — the title
    // truncates with `…` in the middle and the close × hides
    // entirely below the hover threshold (see `opacity-0` on
    // the button further down).
    'h-7 min-w-[52px] max-w-[220px] mb-[5px] rounded-lg text-muted-foreground/80 hover:bg-foreground/[0.06] hover:text-foreground/90'

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={`${sharedClass} ${tab.active ? activeClass : inactiveClass}`}
      title={tab.workspacePath ?? tab.title}
    >
      {/* Right-edge vertical divider between adjacent inactive
          tabs. Parent decides visibility based on active / hover
          state of this tab and the next one, so neighbouring
          dividers disappear when the cursor lands on a pill. */}
      {showRightDivider && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-1/2 h-4 w-px -translate-y-1/2 bg-border/70"
        />
      )}

      <span
        aria-hidden="true"
        className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] text-[9px] font-semibold"
        style={{ backgroundColor: chip.bg, color: chip.fg }}
      >
        {letter}
      </span>
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      <button
        type="button"
        onClick={onClose}
        className={`ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-opacity hover:bg-foreground/15 hover:text-foreground ${
          tab.active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        aria-label={`Close ${tab.title}`}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </button>
    </div>
  )
}
