import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  useThreadListItem
} from '@assistant-ui/react'
import { motion } from 'motion/react'

import { useChatStore } from '../../stores/chat'
import { useT } from '../../i18n'
import { pushUiLog } from '../../stores/uiLogs'
import { UserInfoBar } from './UserInfoBar'

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
  const sessionLoading = useChatStore((s) => s.sessionLoading)
  const t = useT()

  return (
    <ThreadListPrimitive.Root className="relative flex h-full w-64 shrink-0 flex-col bg-background/45 backdrop-blur-xl backdrop-saturate-150">
      {/* Header row — section label, could grow to hold filters later. */}
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
          {t('sidebarChats')}
        </span>
      </div>

      {/* New chat button — wired to runtime.switchToNewThread() via the
          ThreadListPrimitive.New primitive. Dimmed while a session
          switch is in flight so rapid double-clicks don't stack.
          Primary CTA: diagonal accent→violet gradient that mirrors
          the aurora backdrop, white text, soft colored glow. The
          subtle `hover:-translate-y-px` + shadow bump makes it
          feel like it floats a hair above the sidebar. */}
      <div className="px-3 pb-3">
        <ThreadListPrimitive.New
          disabled={sessionLoading}
          className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl border border-accent/20 bg-gradient-to-br from-accent/12 via-accent/8 to-accent/4 px-3 py-2.5 text-[13px] font-semibold text-foreground shadow-[0_1px_2px_rgba(17,24,39,0.04),inset_0_1px_0_rgba(255,255,255,0.5)] transition-all duration-200 hover:-translate-y-px hover:border-accent/35 hover:from-accent/18 hover:via-accent/12 hover:to-accent/6 hover:shadow-[0_4px_14px_-4px_hsl(var(--accent)/0.25),inset_0_1px_0_rgba(255,255,255,0.6)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 dark:text-foreground dark:shadow-none dark:hover:shadow-[0_4px_14px_-4px_hsl(var(--accent)/0.3)]"
        >
          {/* Plus glyph in an accent-tinted chip — echoes the folder
              chip on the workspace button above for visual symmetry. */}
          <span className="flex size-5 items-center justify-center rounded-md bg-accent/15 text-accent transition-colors group-hover:bg-accent/25">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </span>
          <span className="tracking-wide">{t('sidebarNewChat')}</span>
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
          aria-busy={sessionLoading}
          animate={{
            opacity: sessionLoading ? 0.45 : 1,
            filter: sessionLoading ? 'saturate(0.6)' : 'saturate(1)'
          }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className={
            'h-full overflow-y-auto px-2 pb-6 ' +
            (sessionLoading ? 'pointer-events-none' : '')
          }
        >
          <ThreadListPrimitive.Items components={{ ThreadListItem }} />
        </motion.div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/80 to-transparent"
        />
      </div>

      {/* User info row pinned to the bottom — shrink-0 keeps it from
          being squeezed when the chat list grows. The component owns
          its own popup menu (logs, ~/.claude, version line). */}
      <UserInfoBar />

      {/* No full-rail loading veil — replaced by ThreadView's thin
          top progress bar plus the in-place list dim above. The old
          veil (card + dots + label) read as a hard interrupt that
          yanked focus away from the content column; the new
          combination keeps the user's eye anchored on the main pane
          while still telegraphing "something is switching". */}
    </ThreadListPrimitive.Root>
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
function ThreadListItem(): React.JSX.Element {
  const itemId = useThreadListItem((s) => s.id)
  const t = useT()
  const itemTitle = useThreadListItem((s) => s.title) ?? t('sidebarNewChat')

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
        <div className="flex w-full items-center gap-2 rounded-md bg-muted py-1.5 pl-3 pr-1.5 text-[13px] text-foreground">
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
        <>
          <ThreadListItemPrimitive.Trigger
            title={itemTitle}
            className="flex w-full items-center gap-2 rounded-md py-2 pl-3 pr-9 text-left text-[13px] text-foreground/80 transition hover:bg-muted/70 group-data-[active]/thread:bg-muted group-data-[active]/thread:text-foreground"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/80 transition group-data-[active]/thread:bg-foreground/60" />
            <span className="min-w-0 flex-1 truncate">
              <ThreadListItemPrimitive.Title fallback={t('sidebarNewChat')} />
            </span>
          </ThreadListItemPrimitive.Trigger>
          {/* Hover edit icon. Absolutely positioned over the right
              edge of the trigger so it doesn't have to live inside
              the trigger button (nested buttons are invalid HTML).
              Becomes visible on row hover OR when the row is the
              active session, so the user always has a visible
              affordance for the current chat. */}
          <button
            type="button"
            aria-label={t('renameChat')}
            title={t('renameChat')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={startEdit}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/80 opacity-0 transition hover:bg-secondary hover:text-foreground focus:opacity-100 focus:outline-none group-hover/thread:opacity-100 group-data-[active]/thread:opacity-100"
          >
            <PencilIcon />
          </button>
        </>
      )}
    </ThreadListItemPrimitive.Root>
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

function PencilIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
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
