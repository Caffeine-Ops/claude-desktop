import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  useThreadListItem
} from '@assistant-ui/react'
import { motion } from 'motion/react'

import { useChatStore, useDelayedSessionLoading } from '../../stores/chat'
import { invalidateHistoryCache } from '../../runtime/FusionRuntimeProvider'
import { useT } from '../../i18n'
import { usePendingPermissionCountsBySession } from '../../stores/permissions'
import { pushUiLog } from '../../stores/uiLogs'
import { NotificationBadge } from '../common/NotificationBadge'

/**
 * Per-row session status flags, computed from:
 *   - running:             `listActiveRuntimeIds()` from main
 *   - awaitingPermission:  `usePermissionStore` entries keyed by sid
 *
 * Both signals drive the two-line row layout below: title on top,
 * status text + colored dot underneath. A slot for "paused" is
 * reserved for when the engine grows a real pause concept —
 * currently the row just falls back to `idle` when neither running
 * nor awaiting.
 */
type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaitingPermission'

/**
 * Hook: poll + subscribe main for the set of session ids that currently
 * have a live fusion-code runtime in this tab. Re-fetches on every
 * `onSessionListChanged` broadcast so closing / opening a session
 * elsewhere (e.g. clicking the X on a row) updates the badges
 * immediately.
 *
 * Kept inside ThreadListSidebar so FusionRuntimeProvider doesn't need
 * to plumb the set through React context — each consumer subscribes
 * for itself. The IPC is a tiny one-shot getter so the cost of two
 * subscribers doesn't matter in practice.
 */
function useActiveRuntimeIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!window.chatApi) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const res = await window.chatApi.listActiveRuntimeIds()
        if (cancelled) return
        setIds(new Set(res.sessionIds))
      } catch (err) {
        console.warn('[sidebar] listActiveRuntimeIds failed', err)
      }
    }
    void refresh()
    const unsub = window.chatApi.onSessionListChanged(() => {
      void refresh()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
  return ids
}

/**
 * Context so each ThreadListItem row can read the combined status
 * state (running + pending-permission counts) without each row
 * re-subscribing main-process IPC or the permission store. Set once
 * at the sidebar level via `useActiveRuntimeIds` +
 * `usePendingPermissionCountsBySession`.
 *
 * `awaitingPermissionCounts` is a plain Record so rows can read
 * both "is anything pending?" (value > 0) and "how many?" (the
 * number painted inside the red badge).
 */
interface SidebarStatusMap {
  running: ReadonlySet<string>
  awaitingPermissionCounts: Readonly<Record<string, number>>
}
const SidebarStatusContext = createContext<SidebarStatusMap>({
  running: new Set(),
  awaitingPermissionCounts: {}
})

function resolveStatus(
  sessionId: string,
  statusMap: SidebarStatusMap
): SessionStatus {
  if ((statusMap.awaitingPermissionCounts[sessionId] ?? 0) > 0) {
    return 'awaitingPermission'
  }
  if (statusMap.running.has(sessionId)) return 'running'
  return 'idle'
}

/**
 * ThreadListSidebar
 * -----------------
 * Left-side chat/session list, built from @assistant-ui's
 * ThreadListPrimitive + ThreadListItemPrimitive. Data is supplied by
 * the runtime's `threadList` adapter (see `useThreadListAdapter` in
 * FusionRuntimeProvider), which reads sessions from main process IPC
 * and mirrors them to assistant-ui's primitive tree — no direct store
 * access is needed here.
 *
 * Layout note
 * -----------
 * `w-64 shrink-0` gives the sidebar a fixed 256px rail. The parent in
 * App.tsx is a horizontal flex row, and the main `<ThreadView />` sits
 * beside this sidebar with `flex-1` consuming the remaining width.
 */
export function ThreadListSidebar(): React.JSX.Element {
  // Raw flag: gates the pointer-events lockout (must engage the instant a
  // switch starts so a mid-flight click can't queue a second switch).
  const sessionLoading = useChatStore((s) => s.sessionLoading)
  // Debounced flag: drives only the *visual* dim/desaturate, so a fast
  // switch (history-cache hit) doesn't flash the whole list darker for a
  // frame. The two diverge only in the sub-200ms window of a quick switch:
  // there the list stays bright but is still click-locked, which is exactly
  // right (no visible "busy" flicker, no accidental double-switch).
  const sessionLoadingChrome = useDelayedSessionLoading()
  const t = useT()
  const activeRuntimeIds = useActiveRuntimeIds()
  const awaitingPermissionCounts = usePendingPermissionCountsBySession()
  // Freeze the context value inside useMemo so ThreadListItem's
  // lookup has a stable reference across renders — otherwise every
  // row's status derivation would re-run on every parent rerender.
  const statusMap = useMemo<SidebarStatusMap>(
    () => ({
      running: activeRuntimeIds,
      awaitingPermissionCounts
    }),
    [activeRuntimeIds, awaitingPermissionCounts]
  )

  return (
    <SidebarStatusContext.Provider value={statusMap}>
    <ThreadListPrimitive.Root className="relative flex h-full w-64 shrink-0 flex-col border-r border-border/60 bg-sidebar/90 backdrop-blur-2xl backdrop-saturate-150">
      {/* Header — Apple-Mail-style section header: muted uppercase
          label on the left, plain-icon "+" action button on the
          right. Replaces the old full-width gradient CTA with a
          calmer layout that reads as "sidebar toolbar" rather
          than "marketing hero". */}
      {/* Header — kept in sync with the shell rail's "更多" group label
          style (12px, medium, muted) so the chat list reads as a
          continuation of the same left column rather than a separate
          pane. The `+` mints a new chat. */}
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className="text-[12px] font-medium tracking-wide text-muted-foreground/60">
          {t('sidebarChats')}
        </span>
        <ThreadListPrimitive.New
          disabled={sessionLoading}
          aria-label={t('sidebarNewChat')}
          title={t('sidebarNewChat')}
          className="group flex size-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </ThreadListPrimitive.New>
      </div>

      {/* Scrollable list. min-h-0 + flex-1 so the list body can shrink
          inside the flex-col sidebar instead of pushing the header off
          the top edge. Pointer events off during a switch so row
          clicks don't queue up while the previous switch is still
          finishing its cli cold start. The actual "Opening session…"
          feedback is now a fullscreen overlay rendered in App.tsx.

          The wrapper is `relative` so the bottom fade overlay below
          can absolutely position itself across the scroll viewport.
          The fade reads from `--background` so it auto-adapts to the
          current theme — without it, the last chat row visually runs
          straight into the pinned settings button. */}
      <div className="relative min-h-0 flex-1">
        {/* Chat list itself. The dim + pointer-events lockout during a
            session switch now animates via a motion.div so the fade is
            smooth instead of a class-toggle flick. aria-busy mirrors
            the loading flag for screen readers. */}
        <motion.div
          aria-busy={sessionLoadingChrome}
          animate={{
            opacity: sessionLoadingChrome ? 0.45 : 1,
            filter: sessionLoadingChrome ? 'saturate(0.6)' : 'saturate(1)'
          }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className={
            'h-full overflow-y-auto px-2 pb-6 pt-1 ' +
            (sessionLoading ? 'pointer-events-none' : '')
          }
        >
          <ThreadListPrimitive.Items components={{ ThreadListItem }} />
        </motion.div>
        {/* 底部渐隐 + 渐进模糊。两层叠加：
            ① 模糊层：backdrop-blur 把滚到底部的列表项透过一层毛玻璃柔化。
               单靠 backdrop-filter 无法做「越往下越模糊」，所以用一个
               `mask-image` 渐变把模糊强度从底部（不透明 mask = 全模糊）
               向上渐隐到 0（透明 mask = 不模糊），这样过渡才自然，不会有
               一条生硬的模糊边界线。
            ② 着色层：在模糊之上再叠一层 sidebar 底色的纵向渐变，让最底部
               几乎实色、向上渐透明——既盖住模糊层可能透出的半行文字，也保留
               原来那种「列表柔和淡出、不直接撞到边缘」的观感。
            两层都 pointer-events-none，不挡列表的滚动 / 点击。 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12 backdrop-blur-sm [mask-image:linear-gradient(to_top,black_0,black_30%,transparent_100%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[hsl(var(--sidebar))] via-[hsl(var(--sidebar)/0.7)] to-transparent"
        />
      </div>

      {/* The settings menu (UserInfoBar) used to be pinned here at the
          bottom-left of the sidebar. It moved to the shell's tab strip
          (ShellApp) so it's reachable from any tab — see UserInfoBar's
          header comment. Nothing replaces it here; the chat list now
          runs to the bottom of the rail. */}

      {/* No full-rail loading veil — replaced by ThreadView's thin
          top progress bar plus the in-place list dim above. The old
          veil (card + dots + label) read as a hard interrupt that
          yanked focus away from the content column; the new
          combination keeps the user's eye anchored on the main pane
          while still telegraphing "something is switching". */}
    </ThreadListPrimitive.Root>
    </SidebarStatusContext.Provider>
  )
}

/* ─────────────────── Quick actions grid ─────────────────── */

/* ─────────────────── Individual thread row ─────────────────── */

/**
 * One entry in the thread list. Two render modes:
 *
 *   - default: `ThreadListItemPrimitive.Trigger` (full-row click switches
 *     to the thread). A pencil icon fades in on row hover and clicking
 *     it enters edit mode without firing the row's switch handler
 *     (`stopPropagation` on the icon button).
 *   - editing: a sibling div replaces the trigger with an `<input>` +
 *     save icon. Enter or save click commits the rename via
 *     `chatApi.renameSession`; Esc / outside-click cancels.
 *
 * Rename state lives per-row (local `useState`) instead of being
 * lifted to the sidebar, because:
 *   - Only one row edits at a time in practice (clicking another
 *     row's edit icon while editing is rare; we just take the latest)
 *   - Per-row state means the popover doesn't have to track which
 *     thread it belongs to or worry about list re-orderings
 *
 * Active-state styling
 * --------------------
 * assistant-ui injects `data-active="true"` onto `ThreadListItemPrimitive.Root`,
 * NOT onto Trigger. Tailwind's `data-[active]:` variant only matches
 * attributes on the element itself, so we tag Root with a named group
 * (`group/thread`) and use `group-data-[active]/thread:` on every
 * descendant we want to restyle. The named group mirrors the
 * `group/tool` / `group/att` convention used in ThreadView.tsx so the
 * sidebar doesn't accidentally collide with a stray `.group` higher
 * up the tree.
 */
/**
 * Date-grouping metadata stashed in each thread's `custom` by
 * useThreadListAdapter (FusionRuntimeProvider). `groupLabel` is the row's
 * bucket (今天/昨天/7 天内/更早); `isGroupFirst` marks the first row of a
 * bucket so it can render the heading above itself.
 */
interface ThreadGroupMeta {
  groupLabel: string
  isGroupFirst: boolean
}

function ThreadListItem(): React.JSX.Element {
  const itemId = useThreadListItem((s) => s.id)
  const t = useT()
  const itemTitle = useThreadListItem((s) => s.title) ?? t('sidebarNewChat')
  // Date-group metadata, set in the runtime's threadData mapping
  // (ExternalStoreThreadData.custom). assistant-ui carries `custom`
  // through to the row state at runtime, but this version's
  // `ThreadListItemState` type doesn't declare it — so we read it off a
  // widened view of the state. Undefined defensively (e.g. a row
  // mid-creation before the adapter remaps), in which case no heading is
  // drawn.
  const groupMeta = useThreadListItem(
    (s) => (s as { custom?: ThreadGroupMeta }).custom
  )
  const statusMap = useContext(SidebarStatusContext)
  const status = resolveStatus(itemId, statusMap)
  // Read this session's latest context size from the chat store.
  // Undefined until the first turn completes for the session. The
  // selector subscribes to just the usage slice so rows without a
  // live runtime don't re-render on every message delta in other
  // sessions.
  const contextTokens = useChatStore(
    (s) => s.perSession[itemId]?.usage?.contextTokens
  )
  const pendingCount = statusMap.awaitingPermissionCounts[itemId] ?? 0
  const isAwaitingPermission = pendingCount > 0
  const isRunning = status === 'running' || isAwaitingPermission
  const [closing, setClosing] = useState(false)
  const closeRuntime = useCallback(
    async (e: React.MouseEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()
      if (closing) return
      setClosing(true)
      try {
        await window.chatApi.closeSessionRuntime({ sessionId: itemId })
        pushUiLog('runtime:close', { threadId: itemId })
        // Drop the renderer-side per-session slot too so the thread
        // viewer doesn't keep stale messages when the user switches
        // back later (main will serve fresh JSONL history on the
        // next open).
        useChatStore.getState().dropSession(itemId)
        // Also evict the history-LRU snapshot — otherwise the next
        // switch-back would serve the cached transcript and skip the
        // fresh JSONL read main now provides for this closed runtime.
        invalidateHistoryCache(itemId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[sidebar] closeSessionRuntime failed', err)
        pushUiLog('runtime:closeError', { threadId: itemId, message: msg })
      } finally {
        setClosing(false)
      }
    },
    [closing, itemId]
  )

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(itemTitle)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // Keep the draft synced with the upstream title whenever we're NOT
  // actively editing. This catches two cases:
  //   - First render: draft starts as `itemTitle`
  //   - Title updated by another rename in another window / by /rename
  //     in the cli — we don't want a stale draft sitting around for
  //     the next time the user opens the input.
  useEffect(() => {
    if (!editing) setDraft(itemTitle)
  }, [itemTitle, editing])

  // Auto-focus + select-all on entering edit mode so the user can
  // either type a fresh name or arrow-key into the existing one
  // without an extra click.
  useEffect(() => {
    if (!editing) return
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [editing])

  // Outside-click cancel. Only registers while editing — we don't
  // want a doc-level mousedown listener costing on every list row at
  // rest. Uses mousedown rather than click so the cancel happens
  // before any "switch session" click on a sibling row resolves; the
  // edit state reset prevents the brief flash of input → row.
  useEffect(() => {
    if (!editing) return
    const onMouseDown = (e: MouseEvent): void => {
      const node = rowRef.current
      if (!node) return
      if (e.target instanceof Node && node.contains(e.target)) return
      pushUiLog('rename:cancel', { reason: 'outsideClick' })
      setEditing(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [editing])

  const startEdit = useCallback(
    (e: React.MouseEvent | React.PointerEvent): void => {
      // The edit icon lives inside the row's hover area but visually
      // outside the Trigger button (Trigger is a button; can't nest
      // buttons). The icon is a sibling positioned absolutely. We
      // still stopPropagation as defense-in-depth in case the layout
      // changes in the future.
      e.preventDefault()
      e.stopPropagation()
      pushUiLog('rename:openInput', { threadId: itemId, currentTitle: itemTitle })
      setDraft(itemTitle)
      setEditing(true)
    },
    [itemId, itemTitle]
  )

  const cancelEdit = useCallback((): void => {
    pushUiLog('rename:cancel', { threadId: itemId })
    setEditing(false)
  }, [itemId])

  const submitEdit = useCallback(async (): Promise<void> => {
    const trimmed = draft.trim()
    pushUiLog('rename:submit', { threadId: itemId, from: itemTitle, to: trimmed })
    if (!trimmed || trimmed === itemTitle) {
      pushUiLog('rename:noop', {
        threadId: itemId,
        reason: trimmed ? 'unchanged' : 'empty'
      })
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await window.chatApi.renameSession({
        sessionId: itemId,
        title: trimmed
      })
      pushUiLog('rename:success', { threadId: itemId, title: trimmed })
      setEditing(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[sidebar] rename failed', err)
      pushUiLog('rename:error', { threadId: itemId, message })
      window.alert(`${t('renameChatFailed')}: ${message}`)
    } finally {
      setBusy(false)
    }
  }, [draft, itemId, itemTitle, t])

  return (
    <>
      {/* Date-group heading — rendered only above the first row of each
          bucket (今天 / 昨天 / 7 天内 / 更早). Sits outside the row Root so
          it doesn't inherit the row's hover/active styling. */}
      {groupMeta?.isGroupFirst ? (
        <div className="px-3 pb-1 pt-3 text-[12px] font-medium text-muted-foreground/55 first:pt-1">
          {groupMeta.groupLabel}
        </div>
      ) : null}
      <ThreadListItemPrimitive.Root
        // ref the wrapper div so the outside-click effect above can
        // discriminate "click landed inside this row" from "click
        // landed somewhere else in the document".
        ref={rowRef}
        className="group/thread relative mb-0.5"
      >
      {editing ? (
        // ── Edit mode ────────────────────────────────────────────────
        // Sibling div instead of the Trigger — Trigger is a button and
        // we don't want clicking the input to fire a session switch.
        // Layout mirrors the trigger (same paddings, same dot prefix)
        // so the row doesn't visibly jump on enter/exit edit.
        <div className="flex w-full items-center gap-2 rounded-lg bg-foreground/[0.08] py-1.5 pl-3 pr-1.5 text-[13px] text-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" />
          <input
            ref={inputRef}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
            }}
            maxLength={200}
            className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-0.5 text-[12.5px] text-foreground outline-none focus:border-ring disabled:opacity-60"
            aria-label={t('renameChatPrompt')}
          />
          <IconButton
            label={t('renameChatSave')}
            disabled={busy}
            // Prevent the input from blurring before the click fires —
            // mousedown happens first and would otherwise yank focus
            // away, leaving the input in an awkward "selected but not
            // editable" state on browsers that defocus on mousedown.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void submitEdit()}
          >
            <SaveIcon />
          </IconButton>
        </div>
      ) : (
        // ── Default mode ─────────────────────────────────────────────
        // Single-line row (reference design): just the title. The old
        // two-line layout (title + "空闲/运行中" status subline + context %)
        // was dropped for a calmer, denser list. Running / awaiting-permission
        // state still shows — as a tiny colored dot prefixed before the title
        // (only when NOT idle), so a streaming background turn is still
        // legible without spending a whole subline on it. A `···` more button
        // (rename) fades in on hover / when active.
        <>
          <ThreadListItemPrimitive.Trigger
            title={
              status === 'running'
                ? `${itemTitle} · ${t('sidebarStatusRunning')}`
                : status === 'awaitingPermission'
                  ? `${itemTitle} · ${t('sidebarStatusAwaitingPermission')}`
                  : itemTitle
            }
            className="flex h-9 w-full items-center gap-2 rounded-lg pl-3 pr-9 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground/90 group-data-[active]/thread:bg-foreground/[0.08] group-data-[active]/thread:text-foreground"
          >
            {/* Status dot only when something is happening; idle rows omit
                it so the list reads as plain titles per the reference. */}
            {status !== 'idle' ? <InlineStatusDot status={status} /> : null}
            <span className="min-w-0 flex-1 truncate text-[14px] leading-none">
              <ThreadListItemPrimitive.Title fallback={t('sidebarNewChat')} />
            </span>
            {/* Context % chip kept but demoted: only shown when near the cap
                (≥80%), as a quiet warning. Below that it's hidden to keep the
                single-line row clean. */}
            {typeof contextTokens === 'number' &&
            contextFraction(contextTokens) * 100 >= 80 ? (
              <span
                className={'shrink-0 text-[11px] tabular-nums ' + contextPercentClass(contextTokens)}
                title={`${contextTokens.toLocaleString()} tokens / ${CONTEXT_WINDOW_TOKENS.toLocaleString()}`}
              >
                {formatContextPercent(contextTokens)}
              </span>
            ) : null}
          </ThreadListItemPrimitive.Trigger>
          {/* Notification badge — Apple-style red pill with the
              count, always visible when the session has at least
              one pending permission request. Occupies the right
              edge; the X/pencil hover actions sit to its left so
              they don't collide. Rendered as a plain span on the
              absolute layer because it isn't clickable — tapping
              the row still switches to the session, which is what
              the user needs to do to answer the permission. */}
          {isAwaitingPermission ? (
            <NotificationBadge
              count={pendingCount}
              className="absolute right-2 top-1/2 -translate-y-1/2"
            />
          ) : null}

          {/* Hover-revealed actions cluster on the right edge. The
              close X only shows when a background runtime is live
              but NOT awaiting permission — if the user is already
              being asked to approve a tool, stopping the runtime
              would orphan that request, so hiding the X routes them
              into the permission dialog instead. Pencil (rename)
              stays available in all states. Both live outside
              ThreadListItemPrimitive.Trigger so clicking them
              doesn't fire a session switch. */}
          {isRunning && !isAwaitingPermission ? (
            <button
              type="button"
              aria-label={t('sidebarCloseRuntime')}
              title={t('sidebarCloseRuntime')}
              disabled={closing}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => void closeRuntime(e)}
              className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/80 transition hover:bg-secondary hover:text-foreground focus:outline-none disabled:opacity-40 opacity-100"
            >
              <StopIcon />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('renameChat')}
            title={t('renameChat')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={startEdit}
            className={
              'absolute top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/80 opacity-0 transition hover:bg-secondary hover:text-foreground focus:opacity-100 focus:outline-none group-hover/thread:opacity-100 group-data-[active]/thread:opacity-100 ' +
              (isAwaitingPermission ? 'right-8' : 'right-1.5')
            }
          >
            <MoreIcon />
          </button>
        </>
      )}
      </ThreadListItemPrimitive.Root>
    </>
  )
}

/* ─────────────────── Tiny icon set ─────────────────── */

/**
 * Bare-metal icon button. Stops pointerdown propagation so it never
 * triggers the parent row's hover-driven UI side effects, but lets
 * the click event bubble normally so React's onClick wires up.
 *
 * Two sizes baked in: the "p-1" padding + ~12px icon nests inside the
 * 28px-tall row without pushing the layout around.
 */
function IconButton({
  label,
  disabled,
  onClick,
  onMouseDown,
  children
}: {
  label: string
  disabled?: boolean
  onClick: (e: React.MouseEvent) => void
  onMouseDown?: (e: React.MouseEvent) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={onMouseDown}
      className="flex size-6 shrink-0 items-center justify-center rounded text-foreground/80 transition hover:bg-secondary hover:text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/**
 * Horizontal three-dot "more" glyph — the row's hover/active affordance.
 * Replaces the old pencil; clicking it still opens inline rename (the only
 * per-row action today), but the dots read as a generic "more" menu cue
 * matching the reference design's session list.
 */
function MoreIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  )
}

/**
 * Compact inline status dot, prefixed before the title on non-idle rows
 * (running / awaiting-permission). Smaller than the old standalone
 * StatusDot since it now shares the single title line rather than owning a
 * gutter column. Idle rows render no dot at all (see the Trigger above).
 */
function InlineStatusDot({ status }: { status: SessionStatus }): React.JSX.Element {
  const color =
    status === 'running'
      ? 'bg-emerald-500'
      : status === 'awaitingPermission'
        ? 'bg-amber-500'
        : 'bg-muted-foreground/50'
  return <span className={`size-1.5 shrink-0 rounded-full ${color}`} />
}

/**
 * Claude's effective context window in tokens. Used as the
 * denominator when turning a raw input-token count into the
 * percentage the sidebar shows. If a future model family extends
 * this, bump it here.
 */
const CONTEXT_WINDOW_TOKENS = 200_000

/**
 * Fraction of the window currently in use, clamped to [0, 1] so a
 * freak overshoot (e.g. the SDK briefly reporting a prompt slightly
 * bigger than the advertised window) doesn't push the label past
 * "100%" or render as negative on math drift.
 */
function contextFraction(tokens: number): number {
  if (tokens <= 0) return 0
  const f = tokens / CONTEXT_WINDOW_TOKENS
  if (f < 0) return 0
  if (f > 1) return 1
  return f
}

/**
 * Format the context usage as an integer percent ("0%", "24%",
 * "100%"). Keeps the width stable enough that the sidebar row
 * doesn't shift as the session grows. Floor rather than round so a
 * 79.9% session still reads as yellow rather than briefly tipping
 * into the red tier on a color boundary.
 */
function formatContextPercent(tokens: number): string {
  const pct = Math.floor(contextFraction(tokens) * 100)
  return `${pct}%`
}

/**
 * Color band for the percent label:
 *   - <40%  → green  (plenty of headroom)
 *   - 40-80% → amber (getting warm)
 *   - ≥80%  → red    (near the cap — consider /compact or a new session)
 */
function contextPercentClass(tokens: number): string {
  const pct = contextFraction(tokens) * 100
  if (pct < 40) return 'text-emerald-600 dark:text-emerald-400'
  if (pct < 80) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

/**
 * Stop icon — Apple SF-Symbols-style `stop.circle` glyph: a 1-line
 * outer circle with a filled rounded square inside. Semantically
 * reads as "stop running" (not "close" / "delete"), which is what
 * the sidebar button actually does: tears down the background cli
 * but leaves the jsonl transcript on disk for later resume.
 *
 * Sized at 13×13 to match the old close button's visual weight.
 */
function StopIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function SaveIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  )
}
