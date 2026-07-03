import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ThreadSummary } from '../../../shared/types'
import { railGliderSpring, railEaseOut } from './railMotion'

/**
 * Menu geometry. RAIL_WIDTH mirrors main/tabRegistry's NAV_RAIL_WIDTH and
 * .shell-chrome's CSS width — the shell renderer spans the WHOLE window but
 * only the left 220px are visible (the active tab's WebContentsView covers
 * the rest), so every floating surface here must fit inside x < 220 or it
 * gets swallowed by the content view. That constraint is also why delete
 * confirmation lives INSIDE the menu (two-step arm) instead of a dialog:
 * there is simply no visible real estate for one.
 */
const RAIL_WIDTH = 220
const MENU_WIDTH = 148
const MENU_EST_HEIGHT = 82

/** Anchor rect for the row menu — from the ··· button or a right-click. */
interface MenuAnchor {
  right: number
  top: number
  bottom: number
}

/**
 * ShellSessionList
 * ----------------
 * The chat session list, rendered in the shell's left nav rail BELOW the
 * nav rows (新对话 / 智能助手 / 工作画布 / 设置) so the whole left column
 * reads as one continuous rail — matching the reference design.
 *
 * Why it lives in the shell and not the chat tab: the shell is a separate
 * webContents with no ChatEngine, so it can't go through the per-tab
 * session IPC (resolveEngine would throw — see tabRegistry). Instead it
 * uses three shell-specific channels (window.tabApi):
 *   - listShellSessions()        → main reads the ACTIVE chat tab's
 *                                   workspace off disk and returns its
 *                                   ThreadSummary[] (with updatedAt)
 *   - switchShellSession(id)     → main forwards to the active chat tab's
 *                                   renderer, which runs its own switch
 *                                   flow (keeps the Thread view in sync).
 *                                   null = new chat.
 *   - onShellSessionListChanged  → re-pull when the active tab's list
 *                                   changes (new / rename / close / tab
 *                                   switch).
 *
 * MVP scope: list + click-to-switch + date grouping + single-line rows.
 * Per-row rename / running-status dot / permission badge / context% are
 * NOT here yet — those depend on the chat engine's live state and need
 * their own cross-process channels.
 *
 * Active-row highlight is OPTIMISTIC: we track the last id the user
 * clicked locally. The shell has no cheap read of the chat tab's true
 * active session, and the click always lands (main forwards it), so a
 * local latch is accurate in practice. A cold-start / tab-switch re-pull
 * clears it so we don't highlight a row that isn't actually active.
 *
 * Order STABILITY: main sorts by `lastModified` (the jsonl file's mtime),
 * but RESUMING a session appends to its jsonl (system-init / resume
 * markers) and bumps that mtime — so every click would yank the clicked
 * row to the top and the whole list would visibly re-shuffle. The SDK's
 * SDKSessionInfo exposes no "last message time" we could sort on instead
 * (only file mtime + createdAt), and re-reading each jsonl's last real
 * line would defeat the cheap stateless scan. So we stabilise on the
 * RENDER side: a ref remembers the last order we showed, and on every
 * re-pull we keep already-seen sessions in their previous relative
 * position, inserting only genuinely-new ids by their server (newest-
 * first) rank. Result: opening an old chat no longer reorders the list;
 * a brand-new chat still lands at the top. We never reset the remembered
 * order explicitly — on a tab switch the id set turns over and the kept
 * slice empties out, so it degrades to the server order on its own. The
 * date BUCKET each row sits in is frozen the same way (see bucketTimeRef)
 * so a resume can't jump a row across the 今天/昨天/… group boundaries.
 */
export function ShellSessionList(): React.ReactElement {
  const [sessions, setSessions] = useState<readonly ThreadSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Row-entrance gate. False until the FIRST non-empty list has painted, so
  // the cold-start list doesn't play N fade-ins at once (the whole rail would
  // shimmer on launch). Flipped in an effect — i.e. AFTER that first commit —
  // so only rows mounted later (new chat lands on top, tab-switch turnover)
  // animate in. Deliberately state (not a ref): reading a ref during render
  // to decide `initial` is unreliable under concurrent re-renders.
  const [entranceArmed, setEntranceArmed] = useState(false)

  // Last order we rendered, as a list of session ids. Drives stabiliseOrder:
  // a re-pull keeps these ids in their existing relative position so a
  // resume's mtime bump can't reshuffle the list. Never reset explicitly —
  // stabiliseOrder degrades to the server order on its own when the id set
  // turns over (tab switch).
  const orderRef = useRef<string[] | null>(null)
  // Frozen date-bucket timestamp per session id. Order stability alone isn't
  // enough: groupByDate buckets by updatedAt, and a resume's mtime bump would
  // still jump a row from「更早」into「今天」(a cross-bucket reshuffle) even
  // though stabiliseOrder kept its slot. So we FREEZE the updatedAt we first
  // saw for each id and bucket by that, not by the live (resume-polluted)
  // mtime. New ids get their current updatedAt frozen on first sight.
  const bucketTimeRef = useRef<Map<string, number>>(new Map())

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.tabApi
    if (!api?.listShellSessions) return
    try {
      const { threads } = await api.listShellSessions()
      const ordered = stabiliseOrder(threads, orderRef.current)
      orderRef.current = ordered.map((t) => t.id)
      // Freeze bucket time for first-seen ids; prune ids that vanished so the
      // map can't grow unbounded across tab switches.
      const bt = bucketTimeRef.current
      const live = new Set(ordered.map((t) => t.id))
      for (const id of bt.keys()) if (!live.has(id)) bt.delete(id)
      for (const t of ordered) if (!bt.has(t.id)) bt.set(t.id, t.updatedAt)
      setSessions(ordered)
      // Cold-start highlight seed. `activeId` is otherwise only set by an
      // explicit click (onClick) — but on first launch nobody clicks: the
      // chat tab auto-restores threads[0] (the most recent session) on its
      // own, leaving the shell list with no highlighted row. So if we still
      // have no active id, adopt the list's first row, which IS that same
      // most-recent session (the chat tab's cold-start picks threads[0] and
      // both sides share main's newest-first order). `prev ?? …` makes this
      // a one-time seed: once a real click / switch has set activeId we never
      // override it, and the clear-on-vanish effect below can re-trigger the
      // seed only when the active session genuinely left the list.
      if (ordered.length > 0) {
        setActiveId((prev) => prev ?? ordered[0].id)
      }
    } catch (err) {
      console.warn('[shellSessionList] listShellSessions failed', err)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const api = window.tabApi
    if (!api?.onShellSessionListChanged) return
    return api.onShellSessionListChanged(() => {
      // The active tab or its session list changed — re-pull, but DON'T
      // touch orderRef or activeId here:
      //   - orderRef: stabiliseOrder handles both cases on its own. A resume
      //     within one tab keeps the same id set, so the old order is fully
      //     preserved (the whole point — no reshuffle on click). A tab switch
      //     brings a near-disjoint id set, so almost nothing matches the old
      //     order and the result is effectively the server's newest-first
      //     sort. One code path, no need to distinguish the two events.
      //   - activeId: blanket-clearing it on every event caused a highlight
      //     flicker on each resume. The effect below clears it only when the
      //     active session genuinely drops out of the list (real tab switch /
      //     deletion), so a resume re-pull keeps the highlight steady.
      void refresh()
    })
  }, [refresh])

  // If a re-pull no longer contains the optimistically-highlighted session
  // (tab switched to a different workspace, session deleted), drop the
  // highlight so we don't mark a row that isn't in this list. A resume
  // re-pull keeps the id, so the highlight survives — no flicker.
  useEffect(() => {
    if (activeId !== null && !sessions.some((s) => s.id === activeId)) {
      setActiveId(null)
    }
  }, [sessions, activeId])

  // Arm row-entrance animations only after the first non-empty commit (see
  // entranceArmed above). Effects run post-commit, so the rows of that first
  // paint mounted with the gate still closed.
  useEffect(() => {
    if (sessions.length > 0) setEntranceArmed(true)
  }, [sessions])

  const onClick = useCallback((id: string): void => {
    setActiveId(id)
    void window.tabApi?.switchShellSession(id)
  }, [])

  /* ── 行菜单（···/右键）+ 行内重命名 + 删除 ──
     One menu at a time; `armed` is the two-step delete's first click.
     All three states live at the LIST level (not per row) so opening a
     menu / starting a rename on one row implicitly closes the others. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [armed, setArmed] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Row currently being deleted, i.e. the IPC round-trip is in flight.
  // Deleting is NOT instant: main first tears down any live fusion-code
  // runtime for the session (1–2s of child-process shutdown) before it can
  // unlink the jsonl. The row shows a dimmed + spinner state for that
  // window so the click visibly "took" — without it the UI looks dead
  // until the collapse suddenly plays.
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Serialize deletes: a double-click on 确认删除 must not fire the IPC
  // twice (the second would throw "session not found" after the first won).
  const deletingRef = useRef(false)

  const openMenu = useCallback((id: string, anchor: MenuAnchor): void => {
    setRenamingId(null)
    setArmed(false)
    // Clamp inside the visible rail (see RAIL_WIDTH above) and flip above
    // the anchor when the menu would poke past the window bottom.
    const x = Math.min(anchor.right, RAIL_WIDTH - MENU_WIDTH - 8)
    let y = anchor.bottom + 4
    if (y + MENU_EST_HEIGHT > window.innerHeight - 8) {
      y = anchor.top - MENU_EST_HEIGHT - 4
    }
    setMenu({ id, x, y })
  }, [])

  // Menu dismissal: outside mousedown or Escape. Re-registered per menu
  // open (deps on `menu`), so a closed menu costs no document listeners.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      const node = menuRef.current
      if (node && e.target instanceof Node && node.contains(e.target)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Two-step delete's 3s fuse: an armed 确认删除 that nobody clicks
  // disarms itself — a forgotten red button must not lie in wait.
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])

  const commitRename = useCallback(
    async (id: string, rawTitle: string): Promise<void> => {
      setRenamingId(null)
      const trimmed = rawTitle.trim()
      const current = sessions.find((s) => s.id === id)
      if (!trimmed || trimmed === current?.title) return
      // Optimistic: paint the new title now; the engine's
      // sessionListChanged broadcast re-pulls the same value from disk.
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s))
      )
      try {
        await window.tabApi.renameShellSession({ sessionId: id, title: trimmed })
      } catch (err) {
        console.warn('[shellSessionList] rename failed', err)
        // Roll back to disk truth rather than keeping a lie on screen.
        void refresh()
        window.alert('重命名失败')
      }
    },
    [sessions, refresh]
  )

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      if (deletingRef.current) return
      deletingRef.current = true
      setMenu(null)
      setDeletingId(id)
      try {
        await window.tabApi.deleteShellSession({ sessionId: id })
        // Deleting the highlighted session: hand the selection (and the
        // chat tab's foreground) to a neighbouring row BEFORE dropping the
        // row locally, so the clear-on-vanish effect never sees a dangling
        // activeId. Falls back to null = new chat when the list empties.
        if (activeId === id) {
          const idx = sessions.findIndex((s) => s.id === id)
          const neighbor = sessions[idx + 1]?.id ?? sessions[idx - 1]?.id ?? null
          setActiveId(neighbor)
          void window.tabApi.switchShellSession(neighbor)
        }
        // Optimistic removal — the row plays its AnimatePresence exit
        // (collapse) immediately instead of waiting for the broadcast.
        setSessions((prev) => prev.filter((s) => s.id !== id))
        orderRef.current = orderRef.current?.filter((x) => x !== id) ?? null
        bucketTimeRef.current.delete(id)
      } catch (err) {
        console.warn('[shellSessionList] delete failed', err)
        window.alert('删除失败')
      } finally {
        deletingRef.current = false
        setDeletingId(null)
      }
    },
    [activeId, sessions]
  )

  // Group by coarse date bucket using the FROZEN bucket time (not the live
  // mtime) so a resume can't bump a row across buckets. `sessions` is already
  // in stabilised order, so buckets keep that order within each label.
  const groups = groupByDate(sessions, bucketTimeRef.current)

  return (
    // The whole list column opts OUT of the rail's `-webkit-app-region: drag`
    // (set on .shell-chrome). Without this, the group labels and the gaps
    // between rows stay drag regions, and the OS interprets wheel/drag
    // gestures over them as "move the window" — which made scrolling feel
    // stuttery and unresponsive. SessionRow already sets no-drag per row;
    // hoisting it to the container covers the labels and inter-row gaps too.
    //
    // `-mr-2.5` (−10px) pushes THIS column's right edge past the rail's
    // 220px boundary into the CHAT_CARD_GAP strip (the 8px of shell
    // background the floating chat card leaves visible — see tabRegistry's
    // layoutActiveTab). The overlay scrollbar paints at that edge, so it
    // hugs the gap right beside the chat card instead of floating inset
    // inside the rail. (.shell-chrome's right padding is 0 nowadays; the
    // overhang is solely about scrollbar placement.) Row CONTENT doesn't
    // reach that far — the scroll container below re-insets it with pr-4.
    <div
      className="-mr-2.5 flex min-h-0 flex-1 flex-col"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Section header — same muted style as the nav's "更多" label so the
          list reads as part of the same rail. No `+` here: new-chat is the
          single "新对话" button at the top of the nav (TabBar). */}
      <div className="px-3 pb-1 pt-3">
        <span className="text-[12px] font-medium tracking-wide text-[color:var(--rail-muted)]">
          对话
        </span>
      </div>

      {/* Scrollable list. min-h-0 + flex-1 so it shrinks inside the rail's
          flex column instead of pushing the footer off. overscroll-contain
          stops a scroll that hits the top/bottom from bubbling out and
          dragging the window / over-scrolling the rail.

          Horizontal padding is asymmetric ON PURPOSE — both sides work out
          to the same VISUAL gap for the rows / selection glider:
            left:  .shell-chrome's 10px gutter + pl-1 (4px)          = 14px
            right: pr-4 (16px) − the column's -mr-2.5 overhang (10px)
                   + the 8px CHAT_CARD_GAP the chat card floats over  = 14px
          i.e. the active row's rounded fill now sits 14px off the chat
          card's left edge on both sides instead of butting into it.

          The scrollbar is NOT affected by pr: overlay scrollbars paint at
          the scroll container's border edge (outside the padding box), so
          it keeps hugging the rail's right edge exactly as before. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pl-1 pr-4 pb-3">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-3 pb-1 pt-3 text-[12px] font-medium text-[color:var(--rail-muted)] first:pt-1">
              {g.label}
            </div>
            {/* AnimatePresence per group: a deleted row plays its collapse
                exit in place. initial={false} keeps the cold-start batch
                from animating (same intent as entranceArmed). */}
            <AnimatePresence initial={false}>
              {g.items.map((s) => (
                <SessionRow
                  key={s.id}
                  title={s.title}
                  active={s.id === activeId}
                  animateIn={entranceArmed}
                  renaming={renamingId === s.id}
                  menuOpen={menu?.id === s.id}
                  deleting={deletingId === s.id}
                  onClick={() => onClick(s.id)}
                  onOpenMenu={(anchor) => openMenu(s.id, anchor)}
                  onCommitRename={(title) => void commitRename(s.id, title)}
                  onCancelRename={() => setRenamingId(null)}
                />
              ))}
            </AnimatePresence>
          </div>
        ))}
        {sessions.length === 0 ? (
          <div className="px-3 py-6 text-[12.5px] text-[color:var(--rail-muted)]">
            暂无对话
          </div>
        ) : null}
      </div>

      {/* Row menu — fixed-positioned INSIDE the no-drag column (so it
          can't act as a window-drag zone) but OUTSIDE the scroll container
          (so overflow can't clip it; `fixed` also detaches it from any
          row transform motion leaves behind). Two items: 重命名 opens the
          in-row editor; 删除 is two-step — first click arms it (red
          确认删除 with a 3s fuse line), second click actually deletes. */}
      <AnimatePresence>
        {menu ? (
          <motion.div
            ref={menuRef}
            key="session-row-menu"
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -3 }}
            transition={{ duration: 0.14, ease: railEaseOut }}
            style={
              {
                left: menu.x,
                top: menu.y,
                width: MENU_WIDTH,
                transformOrigin: 'top right',
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
            className="fixed z-50 rounded-xl border border-black/10 bg-white p-[5px] shadow-[0_2px_6px_rgba(0,0,0,.06),0_12px_32px_rgba(0,0,0,.12)] dark:border-white/10 dark:bg-[#333230] dark:shadow-[0_2px_6px_rgba(0,0,0,.4),0_16px_40px_rgba(0,0,0,.5)]"
          >
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-[13px] text-[color:var(--rail-text)] transition-colors hover:bg-[var(--rail-hover)]"
              onClick={() => {
                const id = menu.id
                setMenu(null)
                setRenamingId(id)
              }}
            >
              <PencilIcon />
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              className={
                'relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-[7px] px-2.5 text-[13px] transition-colors ' +
                (armed
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'text-red-600 hover:bg-red-600/10 dark:text-red-400')
              }
              onClick={() => {
                if (!armed) {
                  setArmed(true)
                  return
                }
                void deleteSession(menu.id)
              }}
            >
              <TrashIcon />
              {armed ? '确认删除？' : '删除'}
              {/* 3s fuse — matches the disarm timeout above so the visual
                  and the behavior can't drift apart by more than a frame. */}
              {armed ? (
                <motion.span
                  aria-hidden
                  className="absolute bottom-0 left-0 h-[2px] bg-white/55"
                  initial={{ width: '100%' }}
                  animate={{ width: 0 }}
                  transition={{ duration: 3, ease: 'linear' }}
                />
              ) : null}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function SessionRow({
  title,
  active,
  animateIn,
  renaming,
  menuOpen,
  deleting,
  onClick,
  onOpenMenu,
  onCommitRename,
  onCancelRename
}: {
  title: string
  active: boolean
  /** Play a light fade-in on mount (suppressed for the cold-start paint). */
  animateIn: boolean
  /** This row is showing the in-row rename editor. */
  renaming: boolean
  /** This row's ··· menu is open (keeps the button visible sans hover). */
  menuOpen: boolean
  /** Delete IPC in flight: dim the row, swap ··· for a spinner, no clicks. */
  deleting: boolean
  onClick: () => void
  onOpenMenu: (anchor: MenuAnchor) => void
  onCommitRename: (title: string) => void
  onCancelRename: () => void
}): React.ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState(title)

  // Reset + focus the editor each time this row enters rename mode. The
  // draft deliberately re-seeds from the CURRENT title (a rename elsewhere
  // must not leave a stale draft), and select() lets the user type over.
  useEffect(() => {
    if (!renaming) return
    setDraft(title)
    const t = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [renaming, title])

  // Outside-mousedown cancels the rename (mousedown, not click, so the
  // cancel lands before a sibling row's switch resolves — same rationale
  // as ThreadListSidebar's editor).
  useEffect(() => {
    if (!renaming) return
    const onDown = (e: MouseEvent): void => {
      const node = rowRef.current
      if (node && e.target instanceof Node && node.contains(e.target)) return
      onCancelRename()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [renaming, onCancelRename])

  return (
    <motion.div
      ref={rowRef}
      role="button"
      tabIndex={0}
      // Entrance: appear-only, no theatrics — expo-out, small offset. List
      // membership changes shouldn't out-act the selection glider.
      initial={animateIn ? { opacity: 0, y: -6 } : false}
      animate={{ opacity: 1, y: 0 }}
      // Delete: collapse in place (height → 0 reflows the rows below in the
      // same gesture). overflow-hidden on the row clips the content while it
      // shrinks; nothing inside paints past the row box normally.
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: railEaseOut }}
      onClick={renaming || deleting ? undefined : onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        if (deleting) return
        onOpenMenu({ right: e.clientX, top: e.clientY, bottom: e.clientY })
      }}
      onKeyDown={(e) => {
        if (renaming || deleting) return
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={renaming ? undefined : title}
      className={
        // `relative isolate` hosts the glider on -z-[1]: above the row's own
        // hover wash, below the title text — same layering trick as TabRow.
        // `group/srow` scopes the ···-reveal to THIS row's hover.
        'group/srow relative isolate flex h-9 select-none items-center overflow-hidden rounded-lg px-3 text-[14px] leading-none transition-colors ' +
        (deleting
          ? 'pointer-events-none opacity-50 '
          : renaming
            ? 'bg-[var(--rail-hover)] '
            : 'cursor-pointer ') +
        // Active row keeps accent TEXT only; the accent-tinted fill moved into
        // the shared-layout glider below so selection SLIDES between rows
        // (spring FLIP, interruptible) instead of blinking two backgrounds.
        // Hover keeps the neutral grey wash so only the *selected* row carries
        // the accent.
        (active
          ? 'font-medium text-[hsl(var(--accent))]'
          : 'text-[color:var(--rail-text-soft)] hover:bg-[var(--rail-hover)] hover:text-[color:var(--rail-text)]')
      }
    >
      {/* Selection glider — one shared layoutId across ALL rows (they render
          under different date groups, but share the same React tree, which is
          all layoutId needs). On cold start the first active row mounts with
          no predecessor, so it appears in place without a fly-in — exactly the
          behaviour the cold-start-highlight fix established. */}
      {active ? (
        <motion.div
          aria-hidden
          layoutId="rail-session-glider"
          transition={railGliderSpring}
          className="absolute inset-0 -z-[1] rounded-lg bg-[hsl(var(--accent)/0.12)]"
        />
      ) : null}
      {renaming ? (
        // ── In-row rename editor ──
        // Mirrors ThreadListSidebar's editor contract: Enter/✓ commits,
        // Esc/outside-click cancels, save's mousedown is swallowed so the
        // input doesn't blur before the click lands.
        <>
          <input
            ref={inputRef}
            value={draft}
            maxLength={200}
            name="rename-shell-session"
            aria-label="重命名对话"
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommitRename(draft)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancelRename()
              }
            }}
            className="h-[26px] min-w-0 flex-1 rounded-md border-[1.5px] border-[hsl(var(--accent))] bg-white px-2 text-[13px] text-[color:var(--rail-text)] outline-none dark:bg-[#333230]"
          />
          <button
            type="button"
            aria-label="保存名称"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              onCommitRename(draft)
            }}
            className="-mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[color:var(--rail-accent-ink)] transition-colors hover:bg-[var(--rail-accent-soft)]"
          >
            <CheckIcon />
          </button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {deleting ? (
            // Delete in flight — the ···'s slot becomes a spinner so the
            // row reads as "working on it" for the 1–2s runtime-teardown
            // window before the collapse plays.
            <span
              aria-label="删除中"
              className="-mr-1.5 flex size-6 shrink-0 items-center justify-center text-[color:var(--rail-muted)]"
            >
              <SpinnerIcon />
            </span>
          ) : (
            /* ··· row actions — sits in flex flow (not absolute) so the title
               never slides under it; invisible until hover / menu-open but
               always occupying its 24px, keeping the row metrics stable. */
            <button
              type="button"
              aria-label="更多操作"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onOpenMenu(e.currentTarget.getBoundingClientRect())
              }}
              className={
                '-mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[color:var(--rail-muted)] transition-opacity hover:bg-black/[0.07] hover:text-[color:var(--rail-text)] focus-visible:opacity-100 dark:hover:bg-white/10 ' +
                (menuOpen
                  ? 'bg-black/[0.07] text-[color:var(--rail-text)] opacity-100 dark:bg-white/10'
                  : 'opacity-0 group-hover/srow:opacity-100')
              }
            >
              <MoreIcon />
            </button>
          )}
        </>
      )}
    </motion.div>
  )
}

/* ─────────────────── Tiny icon set ─────────────────── */

function MoreIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  )
}

function PencilIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function TrashIcon(): React.ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12l5 5L20 7" />
    </svg>
  )
}

/** 3/4-arc spinner; tailwind's animate-spin does the rotation (pure CSS,
 *  no per-frame JS). Sized to sit in the ··· button's 24px slot. */
function SpinnerIcon(): React.ReactElement {
  return (
    <svg
      className="animate-spin"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

/**
 * Reorder `incoming` (server newest-first) to preserve the relative order of
 * sessions we've already shown, given `prevOrder` (the ids in last render's
 * order, or null on first paint / cold start).
 *
 * Rules:
 *   - Every id already in `prevOrder` keeps its previous slot — even if its
 *     mtime moved it elsewhere in the server sort (the resume-bump case).
 *   - Genuinely-new ids (not in `prevOrder`) are inserted at the FRONT, in
 *     the server's newest-first order, so a brand-new chat lands on top.
 *   - Ids that disappeared from `incoming` are dropped (deleted / tab switch).
 *
 * `prevOrder === null` (or empty) → adopt the server order verbatim, which is
 * also exactly what we want right after a tab switch to a fresh session set.
 */
function stabiliseOrder(
  incoming: readonly ThreadSummary[],
  prevOrder: readonly string[] | null
): ThreadSummary[] {
  const byId = new Map(incoming.map((t) => [t.id, t]))
  if (!prevOrder || prevOrder.length === 0) return [...incoming]

  const known = new Set(prevOrder)
  // New ids in server order (newest-first) go on top.
  const fresh = incoming.filter((t) => !known.has(t.id))
  // Previously-seen ids keep their old relative order, minus any that vanished.
  const kept = prevOrder
    .map((id) => byId.get(id))
    .filter((t): t is ThreadSummary => t !== undefined)
  return [...fresh, ...kept]
}

interface DateGroup {
  label: string
  items: ThreadSummary[]
}

/**
 * Bucket sessions into 今天 / 昨天 / 7 天内 / 更早, compared against
 * local-midnight boundaries (so "今天" = since 00:00 today, which is how
 * users read a chat list). Buckets by the FROZEN time from `bucketTimes`
 * (the updatedAt first seen for each id) rather than the live, resume-bumped
 * `s.updatedAt`, so opening an old chat doesn't yank its row into「今天」.
 * Falls back to `s.updatedAt` for any id not yet frozen. Preserves the
 * input's (already stabilised) order within each bucket; emits only non-empty
 * buckets in chronological order.
 */
function groupByDate(
  sessions: readonly ThreadSummary[],
  bucketTimes: ReadonlyMap<string, number>
): DateGroup[] {
  const now = new Date()
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime()
  const dayMs = 24 * 60 * 60 * 1000

  const labelFor = (t: number): string => {
    if (t >= startOfToday) return '今天'
    if (t >= startOfToday - dayMs) return '昨天'
    if (t >= startOfToday - 7 * dayMs) return '7 天内'
    return '更早'
  }

  const order = ['今天', '昨天', '7 天内', '更早']
  const map = new Map<string, ThreadSummary[]>()
  for (const s of sessions) {
    const label = labelFor(bucketTimes.get(s.id) ?? s.updatedAt)
    const bucket = map.get(label)
    if (bucket) bucket.push(s)
    else map.set(label, [s])
  }
  return order
    .filter((label) => map.has(label))
    .map((label) => ({ label, items: map.get(label)! }))
}
