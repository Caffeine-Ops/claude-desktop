import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import type { ThreadSummary } from '@desktop-shared/types'
import type { SessionContentHit } from '@desktop-shared/ipc-channels'
import { useDialogStore } from '../../stores/dialogs'
import { useT } from '../../i18n'

/**
 * SessionSearchDialog — Spotlight-style unified chat search (⌘K).
 *
 * Opened three ways, all funnelling into useDialogStore('search'):
 *   - shell rail's 「搜索对话」 row → triggerMenuAction('open-search') →
 *     App.tsx's onShellMenuAction branch
 *   - ⌘K in THIS renderer (listener below; the shell has its own for the
 *     rare case where focus sits on the rail webContents)
 *
 * Search model — one input, BOTH fields, no scope switch (user decision
 * over the prototype's segmented control):
 *   - titles: filtered locally from a one-shot listSessions pull at open —
 *     instant, zero IPC per keystroke
 *   - content: SESSION_SEARCH IPC, debounced 300ms, stale responses
 *     dropped by sequence number (a fast typist must never see hits for a
 *     query three edits ago)
 * Results merge per session: title hits rank first (a title hit usually
 * means "that's the chat I'm looking for"), content-only hits after, both
 * kinds highlight the query with <mark>-equivalent styling.
 *
 * Picking a result rides the EXISTING shell-switch loop
 * (tabApi.switchShellSession → main → SHELL_SESSION_SWITCH → runtime's
 * onSwitchToThread) rather than touching assistant-ui internals — one IPC
 * round-trip buys us the exact code path a rail click takes, so the shell
 * list's highlight moves too.
 */

/** Merged per-session row the list renders. */
interface SearchRow {
  id: string
  title: string
  titleHit: boolean
  /** First content hit's excerpt (absent for title-only matches). */
  snippet?: string
  who?: 'user' | 'assistant'
  hitCount: number
  /** Sidebar date-group label, shown for the empty-query "recent" rows. */
  meta?: string
}

const RECENT_LIMIT = 5

export function SessionSearchDialog(): React.JSX.Element {
  const open = useDialogStore((s) => s.open === 'search')
  const closeDialog = useDialogStore((s) => s.closeDialog)
  const t = useT()

  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<readonly ThreadSummary[]>([])
  const [contentHits, setContentHits] = useState<readonly SessionContentHit[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // Monotonic guard: only the LATEST in-flight content search may land.
  const searchSeqRef = useRef(0)

  // ⌘K toggle — component stays mounted (renders null-ish when closed),
  // so this one listener covers the whole renderer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (open) closeDialog()
        else useDialogStore.getState().openDialog('search')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closeDialog])

  // Open: reset state, pull fresh titles, focus the input. listSessions is
  // a cheap stateless scan and the list may have changed since the dialog
  // last opened, so we don't cache across opens.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setContentHits([])
    setSelected(0)
    let cancelled = false
    void window.chatApi
      .listSessions()
      .then((r) => {
        if (!cancelled) setThreads(r.threads)
      })
      .catch((err) => console.warn('[sessionSearch] listSessions failed', err))
    // Fire-and-forget cache warm-up: an empty query returns [] but makes
    // main extract any changed transcripts NOW, off the typing hot path —
    // the first real keystroke then searches memory only.
    void window.chatApi.searchSessions({ query: '' }).catch(() => {})
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open])

  // Content search: debounce 300ms, drop stale responses.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setContentHits([])
      return
    }
    const seq = ++searchSeqRef.current
    const timer = window.setTimeout(() => {
      window.chatApi
        .searchSessions({ query: q })
        .then((r) => {
          if (searchSeqRef.current === seq) setContentHits(r.hits)
        })
        .catch((err) => console.warn('[sessionSearch] searchSessions failed', err))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, open])

  /* Merge titles + content hits into the rendered rows. */
  const rows = useMemo<SearchRow[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return threads.slice(0, RECENT_LIMIT).map((s) => ({
        id: s.id,
        title: s.title,
        titleHit: false,
        hitCount: 0
      }))
    }
    const hitsById = new Map(contentHits.map((h) => [h.sessionId, h]))
    const titleFirst: SearchRow[] = []
    const contentOnly: SearchRow[] = []
    for (const s of threads) {
      const titleHit = s.title.toLowerCase().includes(q)
      const hit = hitsById.get(s.id)
      if (!titleHit && !hit) continue
      const row: SearchRow = {
        id: s.id,
        title: s.title,
        titleHit,
        snippet: hit?.snippet,
        who: hit?.who,
        hitCount: hit?.hitCount ?? 0
      }
      ;(titleHit ? titleFirst : contentOnly).push(row)
    }
    return [...titleFirst, ...contentOnly]
  }, [threads, contentHits, query])

  // Clamp the keyboard cursor when the row set shrinks under it.
  useEffect(() => {
    if (selected >= rows.length) setSelected(0)
  }, [rows, selected])

  const pick = useCallback(
    (row: SearchRow | undefined): void => {
      if (!row) return
      closeDialog()
      // Same loop a rail click takes — keeps shell highlight in sync.
      void window.tabApi?.switchShellSession(row.id)
    },
    [closeDialog]
  )

  // Keyboard scroll-follow without scrollIntoView (it fights embedded
  // scrollers) — nudge the list container's scrollTop directly.
  const ensureVisible = useCallback((index: number): void => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
    if (!list || !el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top - 6
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight + 6
    }
  }, [])

  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = (selected + delta + rows.length) % rows.length
      setSelected(next)
      ensureVisible(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(rows[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeDialog()
    }
  }

  const q = query.trim()

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="session-search"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          // NO backdrop-blur here on purpose: a full-window backdrop-filter
          // re-samples the blur EVERY FRAME of the opacity fade (and again
          // whenever chat content under it repaints) — it single-handedly
          // made the open animation stutter. A slightly deeper plain scrim
          // gives comparable separation for free.
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[14vh]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeDialog()
          }}
        >
          <motion.div
            role="dialog"
            aria-label={t('searchChats')}
            initial={{ opacity: 0, scale: 0.98, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            // Heavier drop shadow + hairline border than a normal popover:
            // the panel floats over BLURRED chat content with no anchor, so
            // its silhouette has to carry the depth cue alone. (First cut
            // used border-border/shadow-2xl and read as a flat white sheet.)
            className="flex max-h-[62vh] w-[min(560px,calc(100vw-48px))] flex-col overflow-hidden rounded-[14px] border border-black/[0.08] bg-card shadow-[0_20px_70px_rgba(0,0,0,0.22),0_4px_14px_rgba(0,0,0,0.08)] dark:border-white/10 dark:shadow-[0_20px_70px_rgba(0,0,0,0.55),0_4px_14px_rgba(0,0,0,0.4)]"
          >
            {/* 输入区 */}
            <div className="flex items-center gap-3 border-b border-black/[0.06] px-5 py-4 dark:border-white/[0.08]">
              <SearchIcon />
              <input
                ref={inputRef}
                value={query}
                name="session-search"
                placeholder={t('searchChatsPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setSelected(0)
                }}
                onKeyDown={onInputKeyDown}
                className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>

            {/* 结果列表。行内不放图标——试过每行一个气泡 glyph，小尺寸下
                线条发糊反而显脏；纯文字两级层级（14px 标题 / 12.5px 片段）
                更接近 Raycast/Linear 的 ⌘K 质感。 */}
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
              {!q && rows.length > 0 ? (
                <div className="px-3 pb-1.5 pt-1.5 text-[12px] font-medium text-muted-foreground/80">
                  {t('searchRecent')}
                </div>
              ) : null}

              {rows.map((row, i) => (
                <div
                  key={row.id}
                  data-row-index={i}
                  role="option"
                  aria-selected={i === selected}
                  className={
                    'flex cursor-pointer flex-col gap-[3px] rounded-[10px] px-3 py-[9px] transition-colors duration-75 ' +
                    (i === selected ? 'bg-black/[0.05] dark:bg-white/[0.07]' : '')
                  }
                  onClick={() => pick(row)}
                  onMouseMove={() => {
                    if (selected !== i) setSelected(i)
                  }}
                >
                  <div className="min-w-0 truncate text-[14px] font-medium leading-snug text-foreground">
                    {row.titleHit && q ? (
                      <Highlight text={row.title} query={q} />
                    ) : (
                      row.title
                    )}
                  </div>
                  {row.snippet && q ? (
                    <div className="truncate text-[12.5px] leading-snug text-muted-foreground">
                      <span className="text-muted-foreground/60">
                        {row.who === 'user' ? t('searchWhoUser') : t('searchWhoAi')}
                      </span>
                      <Highlight text={row.snippet} query={q} />
                    </div>
                  ) : null}
                  {row.hitCount > 1 ? (
                    <div className="text-[11.5px] leading-snug text-muted-foreground/60">
                      {t('searchHitCountPrefix')}
                      {row.hitCount}
                      {t('searchHitCountSuffix')}
                    </div>
                  ) : null}
                </div>
              ))}

              {q && rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2.5 px-6 py-12 text-center">
                  <SearchIcon large />
                  <span className="text-[13px] text-muted-foreground [text-wrap:pretty]">
                    {t('searchNoResults')}
                  </span>
                </div>
              ) : null}
            </div>

            {/* 底部键位提示 */}
            <div className="flex items-center gap-4 border-t border-black/[0.06] px-5 py-2 text-[11.5px] text-muted-foreground/80 dark:border-white/[0.08]">
              <span className="flex items-center gap-1.5">
                <Kbd>↑↓</Kbd>
                {t('searchKbdSelect')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                {t('searchKbdOpen')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>esc</Kbd>
                {t('searchKbdClose')}
              </span>
              {q ? (
                <span className="ml-auto tabular-nums">
                  {rows.length}
                  {t('searchResultSuffix')}
                </span>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/**
 * Query highlighter — plain React splitting (no dangerouslySetInnerHTML),
 * so transcript text can never inject markup. First occurrence only,
 * matching the main-side snippet windowing which centers on that same
 * first hit.
 */
function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-[hsl(var(--accent)/0.16)] px-px font-medium text-[hsl(var(--accent))]">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

/** Borderless key cap — a soft filled chip reads calmer than the boxed
 *  <kbd> border look at this 10px size. */
function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-[5px] bg-black/[0.06] px-[6px] py-[2px] font-mono text-[10px] leading-none text-muted-foreground dark:bg-white/[0.1]">
      {children}
    </kbd>
  )
}

function SearchIcon({ large }: { large?: boolean }): React.JSX.Element {
  return (
    <svg
      width={large ? 26 : 16}
      height={large ? 26 : 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
      className={
        'shrink-0 ' + (large ? 'text-muted-foreground/40' : 'text-muted-foreground/80')
      }
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}
