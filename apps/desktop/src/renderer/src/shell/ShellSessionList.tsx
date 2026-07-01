import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadSummary } from '../../../shared/types'

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

  const onClick = useCallback((id: string): void => {
    setActiveId(id)
    void window.tabApi?.switchShellSession(id)
  }, [])

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
    // `-mr-2.5` (−10px) cancels .shell-chrome's right padding (10px) for THIS
    // column only, so the scrollbar can hug the rail's true right edge instead
    // of floating 10px inset. The nav rows / footer keep that padding (they
    // don't get the negative margin). Rows still carry their own px-3, so row
    // text keeps right breathing room even with the column flush to the edge.
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
          Only LEFT padding (pl-1, no pr): the scrollbar should hug the right
          edge of the rail, not float inset. Rows keep their own px-3, so row
          text still has right breathing room even with the container flush. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pl-1 pb-3">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-3 pb-1 pt-3 text-[12px] font-medium text-[color:var(--rail-muted)] first:pt-1">
              {g.label}
            </div>
            {g.items.map((s) => (
              <SessionRow
                key={s.id}
                title={s.title}
                active={s.id === activeId}
                onClick={() => onClick(s.id)}
              />
            ))}
          </div>
        ))}
        {sessions.length === 0 ? (
          <div className="px-3 py-6 text-[12.5px] text-[color:var(--rail-muted)]">
            暂无对话
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SessionRow({
  title,
  active,
  onClick
}: {
  title: string
  active: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={title}
      className={
        'flex h-9 cursor-pointer select-none items-center rounded-lg px-3 text-[14px] leading-none transition-colors ' +
        // Active row uses the product accent (green): a soft accent-tinted fill
        // + accent text + medium weight, so the selection clearly stands out
        // from the rail (the old --rail-active grey was nearly identical to the
        // rail background and read as "no selection"). Hover keeps the neutral
        // grey wash so only the *selected* row carries the accent.
        (active
          ? 'bg-[hsl(var(--accent)/0.12)] font-medium text-[hsl(var(--accent))]'
          : 'text-[color:var(--rail-text-soft)] hover:bg-[var(--rail-hover)] hover:text-[color:var(--rail-text)]')
      }
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </div>
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
