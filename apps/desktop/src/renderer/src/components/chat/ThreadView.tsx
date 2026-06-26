import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  useAuiState,
  useComposerRuntime,
  useMessage
} from '@assistant-ui/react'
import type { Attachment } from '@assistant-ui/core'
import { AnimatePresence, motion } from 'motion/react'

import type { SessionMeta, WorkflowTask, PermissionRequest } from '../../../../shared/types'
import { useI18n, useT, useToolLabel } from '../../i18n'
import {
  REASONING_PLACEHOLDER,
  useChatStore,
  useToolCallTasks,
  useStreamingAskArgsText
} from '../../stores/chat'
import { useComposerModeStore, type ComposerModeId } from '../../stores/composerMode'
import { parsePartialToolArgs } from '../../stores/todos'
import { useComposerOverlayStore } from '../../stores/composerOverlay'
import { useSessionTitleStore } from '../../stores/sessionTitle'
import { buildSlashAdapter } from '../../composer/slashAdapter'
import { buildFileMentionAdapter } from '../../composer/fileMentionAdapter'
import { ProseMirrorComposerInput } from '../../composer/ProseMirrorComposerInput'
import { ThinkingSpinner } from './ThinkingSpinner'
import { AppleGlowEffect } from './AppleGlowEffect'
import { FileTypeIcon, fileIconPathsByKey } from './FileTypeIcon'
import { findSkillChipSpec } from '../../composer/skillChipRegistry'
import { AssistantMarkdown } from './AssistantMarkdown'
import { DictationWaveform } from './DictationWaveform'
import { extractText, safeStringify } from './toolHelpers'
import { friendlyToolView } from './ToolFormatters'
import { PermissionModePicker } from '../permissions/PermissionModePicker'
import { InlinePermissionPrompt } from '../permissions/InlinePermissionPrompt'
import {
  usePermissionForToolUseId,
  usePendingAskUserQuestion,
  usePermissionStore
} from '../../stores/permissions'
import {
  parseQuestions,
  seedAnswers,
  type AskUserQuestionItem
} from '../permissions/AskUserQuestionView'
import { cancelActiveDictation } from '../../runtime/openaiWhisperDictationAdapter'
import hljs from 'highlight.js/lib/common'

/**
 * ThreadView
 * ----------
 * A minimal but polished chat UI assembled from assistant-ui primitives.
 * We deliberately avoid the high-level `<Thread />` component because it
 * ships only via the shadcn CLI and would drag the whole shadcn/ui stack
 * into this repo. Primitives give us the same runtime wiring (auto
 * scroll-to-bottom, keyboard handling, message pairing, streaming
 * indicator) while leaving us in full control of styling.
 *
 * Layout
 * ------
 *   ThreadPrimitive.Root              (flex column, fills .main)
 *     ThreadPrimitive.Viewport        (flex-1, scrollable)
 *       centered width-capped column
 *         Empty state (when no messages)
 *         ThreadPrimitive.Messages    (renders per-message UI)
 *           UserMessage               (right-aligned bubble)
 *           AssistantMessage          (avatar + streaming text + tools)
 *     Composer dock                   (shrink-0, pinned to bottom)
 *       Composer                      (textarea + send / cancel)
 *
 * Important: the Composer lives OUTSIDE the Viewport instead of inside
 * a `ViewportFooter` with `sticky bottom-0`. Sticky only pins when there
 * is enough content to scroll; with a short thread it collapses into the
 * normal flow and floats in the middle of the screen. Making Composer a
 * direct flex child of Root guarantees it always sits at the bottom.
 *
 * Message rendering dispatches per role via MessagePrimitive.Parts —
 * text parts render as plain text (whitespace-pre-wrap), tool-call
 * parts render an inline collapsible card (ToolCallCard).
 */

// Chat-rail width bounds (px). The min keeps the composer + messages
// readable; the max stops the rail from swallowing the slides pane. The
// default matches the old hard-coded `w-[560px]`.
const CHAT_COL_MIN = 380
const CHAT_COL_MAX = 880
const CHAT_COL_DEFAULT = 560
const CHAT_COL_STORAGE_KEY = 'slides.chatColWidth'

/**
 * Resizable width state for the slides-mode chat rail.
 *
 * Returns the current width (px) and an `onResizeStart` to wire to the
 * gutter handle's `onPointerDown`. The width is seeded from localStorage so
 * a drag persists across reloads and session switches, and written back when
 * a drag ends (not on every move — one write per gesture).
 *
 * The drag tracks raw `clientX` deltas against the width captured at
 * pointer-down (held in a ref so the move handler isn't re-created per
 * render), clamps to [MIN, MAX], and uses Pointer Events + setPointerCapture
 * so the gesture keeps tracking even if the cursor outruns the thin handle.
 */
function useResizableChatColumn(): {
  width: number
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void
} {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return CHAT_COL_DEFAULT
    const raw = window.localStorage.getItem(CHAT_COL_STORAGE_KEY)
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
    if (Number.isNaN(parsed)) return CHAT_COL_DEFAULT
    // Clamp on read too — a persisted value can fall out of range if the
    // bounds change between versions.
    return Math.min(CHAT_COL_MAX, Math.max(CHAT_COL_MIN, parsed))
  })

  // Drag bookkeeping. Refs (not state) so the listeners are stable and the
  // move handler reads live values without re-subscribing per frame.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left button / primary pointer only.
      if (e.button !== 0) return
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      const handleEl = e.currentTarget
      handleEl.setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent): void => {
        const drag = dragRef.current
        if (drag === null) return
        // The handle sits to the RIGHT of the chat rail, so dragging right
        // (positive delta) widens the rail.
        const next = drag.startW + (ev.clientX - drag.startX)
        setWidth(Math.min(CHAT_COL_MAX, Math.max(CHAT_COL_MIN, next)))
      }
      const onUp = (): void => {
        dragRef.current = null
        handleEl.releasePointerCapture?.(e.pointerId)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        // Persist once per gesture. Read the freshest width via the setter's
        // functional form so we never write a stale closure value.
        setWidth((w) => {
          window.localStorage.setItem(CHAT_COL_STORAGE_KEY, String(Math.round(w)))
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width]
  )

  return { width, onResizeStart }
}

/**
 * Drag handle / gutter between the chat rail and the slides pane.
 *
 * This is what replaced the `border-r` hairline. It is a fixed-width
 * transparent gutter (so the two panes read as separated blocks across a
 * gap, per design figure 2) whose center reveals a faint vertical divider on
 * hover / during a drag, and which carries `cursor-col-resize` + the resize
 * gesture. `shrink-0` so flex never collapses the gutter; `group` so the
 * inner divider can react to the gutter's own hover.
 */
function ChatColumnResizeHandle({
  onResizeStart
}: {
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onResizeStart}
      // w-1.5 = 6px transparent gutter between the two white panes. Because the
      // gutter is transparent and the panes are bg-white, this strip reveals
      // the .app background behind them — that's what makes the two cards read
      // as separated. The hit area spans the whole gutter so the handle is easy
      // to grab; touch-none stops scroll/pan hijacking the drag; `group` drives
      // the child divider's hover reveal.
      className="group relative flex h-full w-1.5 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
    >
      {/* The visible divider: a soft accent (green) line, invisible at rest,
          fading in on hover and while dragging (group-active). A vertical
          mask-image gradient fades the line's TOP and BOTTOM ends out to
          transparent so it does NOT run edge-to-edge — it's strongest in the
          middle and dissolves at both ends. A gentle accent glow keeps it
          reading as the highlighted drag affordance. Centered in the gutter so
          the whitespace splits evenly between the two panes. */}
      <div className="h-full w-px bg-accent/80 opacity-0 shadow-[0_0_8px_2px_hsl(var(--accent)/0.3)] transition-opacity duration-150 [mask-image:linear-gradient(to_bottom,transparent_0,black_18%,black_82%,transparent_100%)] group-hover:opacity-100 group-active:opacity-100" />
    </div>
  )
}

export function ThreadView(): React.JSX.Element {
  // Session transition signals from the chat store.
  //   - sessionId      : switches when loadSession resolves (~100ms),
  //                      drives the keyed content remount that plays
  //                      the entrance tween.
  //   - sessionLoading : stays true until switchSession resolves
  //                      (~3-8s cold start). Drives ONLY the thin
  //                      top progress bar — no full-column veil, no
  //                      content hide. Old content stays visible
  //                      until the new messages arrive, then swaps
  //                      in a single graceful enter animation.
  // Rationale: the full-screen loading overlay was reading as a hard
  // interrupt — eye jumped to the center, waited, jumped back. A
  // thin top bar is standard "something is loading" signal that
  // keeps the user's focus anchored on content, while the keyed
  // enter on swap preserves the sense of "the view changed".
  const sessionId = useChatStore((s) => s.sessionId)
  const sessionLoading = useChatStore((s) => s.sessionLoading)
  // Slides two-pane layout is bound PER SESSION, not to the live composer
  // picker: a session shows the right-hand slides workspace only if it was
  // *started* in slides mode (marked on first send — see the composer send
  // path / markSlidesSession). So switching to a slides session splits the
  // layout; switching to any other session keeps it single-column,
  // regardless of what the picker currently says. We subscribe to the
  // whole map so re-marking the active session re-renders this.
  const slidesSessions = useComposerModeStore((s) => s.slidesSessions)
  const isSlidesMode =
    sessionId !== null && slidesSessions[sessionId] === true
  // Slides two-pane split is user-resizable. The chat rail used to be a
  // hard `w-[560px]` with a `border-r` hairline between the panes; per design
  // the hairline is gone (the panes now read as two separated blocks across a
  // gutter), and the boundary is a drag handle. `chatColWidth` is the chat
  // rail's width in px, persisted to localStorage so a drag survives reloads
  // and session switches. See useResizableChatColumn for the clamp + persist.
  const { width: chatColWidth, onResizeStart } = useResizableChatColumn()
  // Hide the composer's frosted transition strip while any composer popover
  // (mode / permission picker) is open — its backdrop-blur otherwise sliced a
  // blurred band across the open menu (see stores/composerOverlay).
  const composerOverlayOpen = useComposerOverlayStore((s) => s.openCount > 0)
  // Content key: sessionId plus a sentinel so the null → id case (first
  // session, or after a hard reset) still flips the key and replays
  // the entrance animation.
  const contentKey = sessionId ?? '__new__'

  return (
    <ThreadPrimitive.Root
      className={
        'relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-row bg-transparent ' +
        // Slides mode: a 4px inset keeps the two white cards off the .app edges
        // so each card's own `rounded` corners show in full — without it the
        // outer corners get clipped by .app's radius and fight the card radius.
        // The transparent inset reveals the .app background between/around the
        // cards. Normal single-column chat keeps zero inset (fills the surface).
        (isSlidesMode ? 'p-1' : '')
      }
    >
      {/* Left column: the chat itself (progress bar + message viewport +
          composer dock). In normal modes it's flex-1 and fills the whole
          width — visually identical to the old single column. In slides
          mode it shrinks to a fixed-width chat rail card and the slides
          workspace card takes the rest (figure 27). */}
      <div
        className={
          'relative flex h-full min-h-0 flex-col ' +
          (isSlidesMode
            ? 'shrink-0 overflow-hidden rounded bg-white'
            : 'min-w-0 flex-1 bg-white')
        }
        // Slides mode: width is user-controlled (drag handle below) and
        // persisted. The old fixed `w-[560px]` + `border-r` hairline are both
        // gone — the gutter handle now provides the visual separation. In
        // normal modes width stays flex-driven, so leave style unset.
        style={isSlidesMode ? { width: chatColWidth } : undefined}
      >
      {/* Chat header — the current session's title over a muted "内容由 AI
          生成" subtitle, pinned to the top of the chat column. shrink-0 so it
          never gets squeezed by the scrolling viewport below. Sits above the
          viewport's top mask, so it reads as a fixed banner the messages
          scroll under. */}
      <ChatHeader />

      {/* Top indeterminate progress bar. Absolute at the very top of
          the Thread root so it sits above the viewport mask and the
          composer. Presence-animated so it also fades in/out rather
          than popping. */}
      <AnimatePresence>
        {sessionLoading && <TopProgressBar />}
      </AnimatePresence>

      {/* Scrollable message area. min-h-0 + flex-1 is the canonical
          flexbox pattern that lets the viewport shrink correctly inside
          another flex column. */}
      <ThreadPrimitive.Viewport
        autoScroll
        // (Removed) top/bottom fade mask. The viewport used to fade its first
        // ~44px and last ~56px to transparent so scrolling text dissolved
        // near the header / composer; per design that fade-out is gone, so
        // messages now cut off cleanly at the edges. The inner column's
        // `pt-8` / `pb-20` padding still keeps the first/last message clear of
        // the header and composer dock.
        //
        // `scrollbar-gutter: stable` (kept) reserves the scrollbar track slot
        // whether or not the content overflows. Without it, the empty state
        // can land at the "just fits" boundary and any sub-pixel wobble
        // (font-metric changes, motion, font loading) flickers the scrollbar
        // in/out → horizontal reflow → visible jitter.
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        {/* Inner column caps reading width and centers messages. The
            `min-h-full` lets the empty-state `flex-1` stretch so the
            hero text lands at the vertical center of the viewport
            even when there are no messages yet.

            No session-switch animation: the previous y-translate +
            blur intro caused the empty-state content to briefly push
            the scroll container past its viewport, flickering the
            scrollbar and jittering the page horizontally. An
            instant content swap is calmer and matches Apple's
            "no surprise motion" sensibility. */}
        <div
          key={`content-${contentKey}`}
          className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-3 pb-20 pt-8"
        >
          <ThreadPrimitive.Empty>
            <EmptyState />
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
              SystemMessage
            }}
          />
        </div>
      </ThreadPrimitive.Viewport>

      {/* (Removed) 顶部渐进模糊带 — the backdrop-blur strip over the viewport
          top was dropped per design. The viewport's own top mask-image still
          fades the first ~44px of text to transparent so messages don't hit a
          hard edge as they scroll up; only the frosted blur layer is gone. */}

      <ScrollToBottomButton />

      {/* Composer dock — pinned to the bottom of Root, but ONLY once the
          thread has messages. While empty, the composer is rendered inside
          the centered EmptyState block instead (figure 26), so the dock is
          hidden to avoid a second Composer instance.

          `relative` so the frosted transition strip can absolutely position
          itself directly ABOVE the dock (bottom-full). The strip is a thin
          backdrop-blur band whose blur + opacity fade UPWARD to zero via a
          mask, so messages scrolling toward the composer soften and dissolve
          into it instead of hitting a hard edge — the bottom counterpart of
          the (removed) top blur band. pointer-events-none so it never blocks
          scrolling or text selection underneath. */}
      <ThreadPrimitive.If empty={false}>
        {/* Wrapper carries NO backdrop-filter of its own — critical, because a
            backdrop-filter on an ancestor cancels a descendant's
            backdrop-filter (CSS spec). The earlier strip lived INSIDE the
            blurred dock and so never blurred anything. Here the strip is a
            child of this clean wrapper, with the blur kept on the inner dock,
            so the strip's own backdrop-blur actually applies to the messages
            behind it. */}
        <div className="relative shrink-0">
          {/* Frosted transition strip — sits directly above the dock
              (bottom-full), blur + opacity fading UPWARD via the mask, so
              messages soften and dissolve into the composer instead of a hard
              edge. pointer-events-none so it never blocks scroll / selection. */}
          {/* Geometry: `bottom` is measured from the WRAPPER's bottom, and the
              wrapper hugs the dock, so bottom:100% puts the strip's bottom edge
              at the dock's TOP. The dock's pt-4 is 16px, so to drop the strip
              down to ~1px above the input we offset by (16px − 1px) = 15px:
              bottom-[calc(100%-15px)]. This covers the dock's pale pt-4
              background gap while leaving a 1px sliver for the input's top
              border. (Earlier 1px offset barely entered the dock → full gap;
              16px reached the input → blurred its border.) */}
          {!composerOverlayOpen ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-[calc(100%-15px)] z-10 h-14 backdrop-blur-md [mask-image:linear-gradient(to_top,black_0,black_40%,transparent_100%)]"
            />
          ) : null}
          {/* rounded-b matches the card's bottom corners. The dock's
              `backdrop-blur` rasterizes independently of the card's
              overflow-hidden + rounded clip (Chromium behavior), so without its
              OWN bottom radius the dock's square corners punched through and the
              card's bottom-left/right read as square. Rounding the dock itself
              restores the corners. */}
          <div className="rounded-b bg-background/45 px-3 pb-3 pt-4 backdrop-blur-xl backdrop-saturate-150">
            <Composer />
          </div>
        </div>
      </ThreadPrimitive.If>
      </div>

      {/* Drag handle + gutter between the chat rail and the slides pane.
          Replaces the old `border-r` hairline: it carries the visual gap
          (a transparent gutter that reveals a faint divider on hover) AND
          the resize affordance. Gated on the same empty={false} as the pane
          so it only appears once the layout actually splits. */}
      {isSlidesMode ? (
        <ThreadPrimitive.If empty={false}>
          <ChatColumnResizeHandle onResizeStart={onResizeStart} />
        </ThreadPrimitive.If>
      ) : null}

      {/* Right pane: slides workspace. Only in slides mode AND once the
          thread has messages (empty={false}) — so picking 幻灯片 on the
          empty state keeps the centered hero until the first message is
          sent, then the layout splits (figure 27). */}
      {isSlidesMode ? (
        <ThreadPrimitive.If empty={false}>
          <SlidesWorkspace />
        </ThreadPrimitive.If>
      ) : null}
    </ThreadPrimitive.Root>
  )
}

/**
 * Floating "scroll to bottom" affordance.
 *
 * Built on `ThreadPrimitive.ScrollToBottom`, which auto-disables
 * itself when the viewport is already pinned to the end of the
 * thread. We key on that `disabled` attribute with Tailwind's
 * `disabled:` variant to fade + lift the button out of view, so no
 * extra state subscription is needed — the primitive handles the
 * scroll math and we just react to the resulting disabled flag.
 *
 * Positioned absolutely inside Thread.Root (above the composer dock)
 * so it floats over the fading bottom of the message list without
 * pushing other layout around.
 */
function ScrollToBottomButton(): React.JSX.Element {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        aria-label="Scroll to bottom"
        className={
          'pointer-events-auto absolute left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/70 bg-background/90 text-foreground shadow-lg shadow-black/10 backdrop-blur transition-all duration-200 ease-out hover:border-accent/60 hover:bg-background hover:text-accent active:scale-95 ' +
          // Float just above the composer dock. The dock got shorter after its
          // bottom padding was trimmed (pb-7 → pb-3, ~16px less), so the old
          // bottom-[96px] dropped the button down into the composer; 80px puts
          // it clearly above the (now shorter) dock again.
          'bottom-[80px] ' +
          // When already at bottom, the primitive sets `disabled`.
          // Fade + lift + disable pointer so it doesn't trap clicks.
          'disabled:pointer-events-none disabled:translate-y-2 disabled:opacity-0'
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 5v14" />
          <path d="m6 13 6 6 6-6" />
        </svg>
      </button>
    </ThreadPrimitive.ScrollToBottom>
  )
}

/* ───────────────────────── TopProgressBar ───────────────────────── */

/**
 * Thin indeterminate progress bar pinned to the top of ThreadView.
 * Shown while a session switch / new-session IPC is in flight
 * (see FusionRuntimeProvider.onSwitchToThread / onSwitchToNewThread —
 * both toggle `sessionLoading` on the chat store).
 *
 * Replaces the old full-column SessionLoadingView: that one read as a
 * hard interrupt (focus jumped to center, waited, jumped back). A
 * 2px top bar is the standard "something is loading" signal for modern
 * apps — keeps the user's focus on content and lets the existing keyed
 * enter animation do the "view changed" work on its own.
 *
 * Visual anatomy:
 *   - Track: full-width line, transparent so it only reads as the
 *            moving segment on top of the thread.
 *   - Segment: 35%-wide accent-colored strip that slides left → right
 *              in a 1.1s loop. The segment has a soft box-shadow in
 *              the accent color so it looks like a faint glow trailing
 *              the leading edge, echoing browser loading bars.
 *   - Fade in/out: the whole container fades 0 → 1 / 1 → 0 via
 *                  AnimatePresence in ThreadView. Keeps the bar from
 *                  popping in harshly for very fast switches.
 */
function TopProgressBar(): React.JSX.Element {
  return (
    <motion.div
      role="progressbar"
      aria-label="Loading session"
      aria-busy="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden"
    >
      {/* Inner slider is absolutely positioned inside the track (which
          is already `absolute`, so it's the positioning context). A
          35%-wide accent segment animates from off-screen left to
          off-screen right in a 1.1s loop — the track's `overflow-hidden`
          clips the ends so it reads as a sliding highlight rather
          than a wrapping strip. Box-shadow in accent gives the
          leading edge a soft glow trail. */}
      <motion.div
        className="absolute top-0 h-full w-[35%] rounded-r-full bg-accent shadow-[0_0_10px_0_hsl(var(--accent)/0.55)]"
        initial={{ left: '-40%' }}
        animate={{ left: '100%' }}
        transition={{
          duration: 1.1,
          repeat: Infinity,
          ease: [0.42, 0, 0.58, 1]
        }}
      />
    </motion.div>
  )
}

/* ─────────────────────────── Chat header ─────────────────────── */

/**
 * Chat column header: the current session's title on one line, with a muted
 * "内容由 AI 生成" subtitle beneath it. Title comes from the shared
 * sessionTitle store (fed by FusionRuntimeProvider's thread-list adapter from
 * the active session's ThreadSummary). Falls back to a placeholder while no
 * session is selected or a freshly-minted one hasn't surfaced in the list yet.
 *
 * `shrink-0` keeps it from being compressed by the scrolling viewport; the
 * messages scroll underneath. Title truncates on one line so a long session
 * name can't push the layout or wrap into the subtitle.
 */
function ChatHeader(): React.JSX.Element {
  const t = useT()
  const title = useSessionTitleStore((s) => s.title)
  const display = title && title.trim() ? title : t('chatHeaderUntitled')
  return (
    // Window drag region. The chat WebContentsView is positioned at y≈gap
    // (tabRegistry.setBounds) on a `titleBarStyle: 'hiddenInset'` window, so
    // its top strip IS the title-bar zone — the macOS traffic lights float
    // over its top-left. The shell's `-webkit-app-region: drag` only covers
    // the LEFT rail (a separate webContents), so the chat surface's own header
    // never moved the window. Marking the header a drag region fixes that. The
    // WHOLE header (title + subtitle included) stays draggable — the text does
    // NOT opt out — and `select-none` keeps the text from being selected so a
    // press-drag on it always moves the window instead of starting a selection.
    <div className="shrink-0 select-none p-3 [-webkit-app-region:drag]">
      <h1
        className="truncate text-[16px] font-semibold leading-tight text-foreground"
        title={display}
      >
        {display}
      </h1>
      <p className="mt-1 text-[12px] leading-none text-muted-foreground">
        {t('chatHeaderSubtitle')}
      </p>
    </div>
  )
}

/* ─────────────────────── Slides workspace ───────────────────── */

type CanvasTab = 'slides' | 'outline' | 'files' | 'questions'

const CANVAS_TAB_ICONS: Record<CanvasTab, React.ReactNode> = {
  slides: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  outline: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  files: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  questions: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7M12 17h.01" />
    </svg>
  )
}

/**
 * Right-hand canvas workspace, shown beside the chat in slides mode. Tabs:
 * 幻灯片 / 大纲 / 文件 are still static shells; 「问题」is live — it appears
 * only while this session has a pending AskUserQuestion and hosts the
 * questionnaire there (instead of inline in the chat stream — ThreadView
 * suppresses the inline prompt for AskUserQuestion, see suppressAskInline).
 * When a question arrives we auto-switch to 「问题」; after the user submits,
 * the tab disappears and we fall back to 幻灯片.
 */
function SlidesWorkspace(): React.JSX.Element {
  const sessionId = useChatStore((s) => s.sessionId)
  // Two sources for the 问题 tab, covering the whole AskUserQuestion lifecycle:
  //   - streamingArgs: the tool's input WHILE it streams (no requestId yet →
  //     read-only preview, rendered from half-open JSON via parsePartialToolArgs).
  //   - pendingAsk: the permission request once canUseTool fires (has requestId
  //     → the form becomes answerable). pendingAsk supersedes streamingArgs.
  const pendingAsk = usePendingAskUserQuestion(sessionId)
  const streamingArgs = useStreamingAskArgsText()
  const hasQuestions = pendingAsk !== null || streamingArgs !== null
  const [tab, setTab] = useState<CanvasTab>('slides')

  // Auto-focus 问题 the moment a questionnaire appears (streaming OR pending);
  // when it fully clears, drop back to 幻灯片 if we were on 问题.
  useEffect(() => {
    if (hasQuestions) setTab('questions')
    else setTab((t) => (t === 'questions' ? 'slides' : t))
  }, [hasQuestions])

  const tabs: { id: CanvasTab; label: string }[] = [
    { id: 'slides', label: '幻灯片' },
    { id: 'outline', label: '大纲' },
    { id: 'files', label: '文件' },
    // 问题 tab exists while a questionnaire is streaming or pending.
    ...(hasQuestions ? [{ id: 'questions' as const, label: '问题' }] : [])
  ]

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded bg-white">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-2 py-1.5">
        {tabs.map((tDef) => {
          const active = tDef.id === tab
          return (
            <button
              key={tDef.id}
              type="button"
              onClick={() => setTab(tDef.id)}
              className={
                'flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition-colors ' +
                (active
                  ? 'bg-foreground/[0.06] font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/90')
              }
            >
              {CANVAS_TAB_ICONS[tDef.id]}
              {tDef.label}
            </button>
          )
        })}
      </div>

      {/* Body */}
      {tab === 'questions' && hasQuestions ? (
        <CanvasQuestionnaire
          request={pendingAsk}
          streamingArgsText={streamingArgs}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="text-[15px] font-semibold text-foreground">未命名</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            确认大纲后将在此处展示幻灯片
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Canvas questionnaire — the AskUserQuestion form rendered in the 问题 tab
 * (the full-form layout from the reference: numbered questions, option cards
 * with descriptions, an 其他 free-text row, and a 提交答案 / AI 自行决定 bar).
 *
 * Answers ride the SAME permission-broker path the inline prompt uses — there
 * is no separate channel. Submit → respond(requestId, 'allow-once', {answers})
 * feeds the answers back as the tool's updatedInput; 「AI 自行决定」→
 * respond(requestId, 'deny') cancels the question so the model proceeds on its
 * own. (We must NOT send a user message / fabricate a tool_result — the broker
 * would hang and the text would be swallowed; see the project's error notes.)
 */
function CanvasQuestionnaire({
  request,
  streamingArgsText
}: {
  request: PermissionRequest | null
  streamingArgsText: string | null
}): React.JSX.Element {
  const respond = usePermissionStore((s) => s.respond)
  // answerable once the permission request exists (has a requestId); during the
  // pure-streaming phase it's a read-only preview.
  const answerable = request !== null

  // Hold the last successfully-parsed questions so a streaming frame that
  // lands mid-`\uXXXX` escape (parsePartialToolArgs returns null that tick)
  // doesn't blank the preview — we keep showing the previous good parse.
  const lastQuestionsRef = useRef<AskUserQuestionItem[]>([])
  const questions = useMemo(() => {
    // Prefer the finalized permission input; fall back to the streaming text.
    if (request) {
      const qs = parseQuestions(request.input)
      lastQuestionsRef.current = qs
      return qs
    }
    if (streamingArgsText) {
      const partial = parsePartialToolArgs(streamingArgsText)
      const qs = parseQuestions(partial)
      // Only adopt a non-empty parse; otherwise keep the last good one.
      if (qs.length > 0) lastQuestionsRef.current = qs
    }
    return lastQuestionsRef.current
  }, [request, streamingArgsText])
  // Per-question selection: question text → chosen option label (or the user's
  // free-text for 其他). Seeded from any prior answers on the input (resume).
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    request ? seedAnswers(request.input) : {}
  )
  // Per-question 其他 draft text, kept separate so toggling between a preset
  // option and 其他 doesn't lose what was typed.
  const [otherDraft, setOtherDraft] = useState<Record<string, string>>({})

  const pick = (q: string, label: string): void =>
    setAnswers((a) => ({ ...a, [q]: label }))

  const typeOther = (q: string, text: string): void => {
    setOtherDraft((d) => ({ ...d, [q]: text }))
    // Selecting 其他 means the answer IS the typed text.
    setAnswers((a) => ({ ...a, [q]: text }))
  }

  const submit = (): void => {
    if (!request) return // still streaming — not answerable yet
    // Build answers in question order for a stable tool_result.
    const out: Record<string, string> = {}
    for (const q of questions) {
      const a = answers[q.question]
      if (a && a.trim()) out[q.question] = a
    }
    void respond(request.requestId, 'allow-once', { answers: out })
  }

  const letAi = (): void => {
    if (!request) return
    // Cancel the question — the model proceeds without an explicit answer.
    void respond(request.requestId, 'deny')
  }

  if (questions.length === 0) {
    // Streaming but nothing parseable yet → "generating"; finalized but empty
    // → a real parse failure.
    return (
      <div className="relative min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {!answerable ? <AppleGlowEffect /> : null}
        <h2 className="text-[20px] font-bold text-foreground">请回答以下问题</h2>
        <p
          className={
            'mt-3 text-[13px] ' +
            // While streaming, the "generating" line gets the shimmer sweep; a
            // real parse failure is a static muted message.
            (answerable ? 'text-muted-foreground' : 'shimmer-text font-medium')
          }
        >
          {answerable ? '无法解析问题内容。' : 'AI 正在生成问题…'}
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Siri / Apple-Intelligence edge glow — a rotating conic-gradient ring
          hugging the panel's inner border while the questionnaire is still
          streaming (!answerable). Pure CSS (.siri-edge in main.css); removed
          once answering is possible. */}
      {!answerable ? <AppleGlowEffect /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <h2 className="text-[20px] font-bold text-foreground">请回答以下问题</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">问题</p>

        {/* While streaming (!answerable) the whole questionnaire breathes — a
            gentle opacity pulse signalling「生成中」— and each freshly-arrived
            question fades + slides in. Both stop once the form is answerable.
            motion respects prefers-reduced-motion automatically. */}
        <motion.div
          className="mt-6 flex flex-col gap-8"
          animate={answerable ? { opacity: 1 } : { opacity: [0.72, 1, 0.72] }}
          transition={
            answerable
              ? { duration: 0.2 }
              : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
          }
        >
          {questions.map((q, i) => {
            const otherText = otherDraft[q.question] ?? ''
            const otherSelected =
              answers[q.question] !== undefined &&
              answers[q.question] === otherText &&
              otherText.length > 0
            return (
              <motion.div
                // Index key (not question text): during streaming the last
                // question's text mutates token-by-token, so a text key would
                // make that row re-mount and replay its enter animation every
                // tick (flicker). Index is stable — questions only append,
                // never reorder — so only a genuinely NEW row animates in.
                key={i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
              >
                <div className="text-[13px] font-medium text-muted-foreground">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h3 className="mt-1 text-[17px] font-bold text-foreground">
                  {q.header ?? q.question}
                </h3>
                {q.header ? (
                  <p className="mt-1 text-[14px] text-muted-foreground">
                    {q.question}
                  </p>
                ) : null}
                <p className="mt-2 text-[12.5px] text-muted-foreground">单选</p>

                <div className="mt-2 flex flex-col gap-2">
                  {q.options.map((opt) => {
                    const selected = answers[q.question] === opt.label
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        disabled={!answerable}
                        onClick={() => answerable && pick(q.question, opt.label)}
                        className={
                          'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors ' +
                          (selected
                            ? 'border-accent bg-accent/[0.06]'
                            : 'border-border hover:border-foreground/20 hover:bg-foreground/[0.02]') +
                          (!answerable ? ' cursor-default opacity-70' : '')
                        }
                      >
                        <span
                          className={
                            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ' +
                            (selected ? 'border-accent' : 'border-muted-foreground/40')
                          }
                          aria-hidden
                        >
                          {selected ? (
                            <span className="size-2 rounded-full bg-accent" />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-semibold text-foreground">
                            {opt.label}
                          </span>
                          {opt.description ? (
                            <span className="mt-0.5 block text-[13px] text-muted-foreground">
                              {opt.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}

                  {/* 其他 free-text row. */}
                  <input
                    type="text"
                    value={otherText}
                    disabled={!answerable}
                    onChange={(e) => typeOther(q.question, e.target.value)}
                    placeholder="其他（请填写）"
                    className={
                      'w-full rounded-xl border px-4 py-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors disabled:opacity-70 ' +
                      (otherSelected
                        ? 'border-accent bg-accent/[0.06]'
                        : 'border-border focus:border-foreground/30')
                    }
                  />
                </div>
              </motion.div>
            )
          })}
        </motion.div>
      </div>

      {/* Action bar. Disabled while streaming (no requestId yet → can't answer);
          enabled once the permission request lands. */}
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-8 py-4">
        <button
          type="button"
          onClick={submit}
          disabled={!answerable}
          className="rounded-full bg-foreground px-5 py-2 text-[13px] font-medium text-background transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          提交答案
        </button>
        <button
          type="button"
          onClick={letAi}
          disabled={!answerable}
          className="text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          AI 自行决定
        </button>
        {!answerable ? (
          <span className="text-[12.5px] text-muted-foreground">
            AI 正在生成问题…
          </span>
        ) : null}
      </div>
    </div>
  )
}

/* ───────────────────────── EmptyState ───────────────────────── */

/* The scenario prompt-card grid was removed from the empty state — it's now
   just the title + hint, and the user starts by typing in the composer.
   The card definitions (SCENARIO_CARDS), the onPickScenario handler, and the
   per-card icon components (PptIcon / LightbulbIcon / UserCheckIcon /
   ChartIcon) were deleted with it; the `scenario*` i18n keys are left in
   i18n.ts. Restore from git history to bring the grid back. */

/**
 * Empty thread state (figure 26): a vertically-centered block of
 * mascot → title → subtitle → composer → promo banner. The composer is
 * rendered HERE (not in the bottom dock) so it sits in the centered group;
 * the bottom dock is hidden while empty (ThreadPrimitive.If empty={false}
 * in the main render) so there's only ever one Composer instance. Once the
 * thread has messages, the dock takes over and the composer pins to the
 * bottom as usual.
 */
function EmptyState(): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-1 flex-col items-stretch justify-center py-10">
      {/* Mascot — green chat-bubble glyph. */}
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-[var(--rail-accent-soft,#dcf5e6)]">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16.5H9l-4 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z"
            stroke="var(--rail-accent-ink,#0f7a38)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="9" cy="11" r="1" fill="var(--rail-accent-ink,#0f7a38)" />
          <circle cx="15" cy="11" r="1" fill="var(--rail-accent-ink,#0f7a38)" />
        </svg>
      </div>
      <h1 className="mb-2.5 text-[30px] font-bold tracking-tight text-foreground">
        {t('emptyStateTitle')}
      </h1>
      <p className="mb-7 text-[14px] text-muted-foreground/80">
        {t('emptyStateScenarioHint')}
      </p>

      {/* Composer sits inside the centered block (not the bottom dock). */}
      <Composer />

      {/* Promo banner (figure 26) — VISUAL-ONLY placeholder; the desktop app
          has no credits/PRO system behind it. */}
      <div className="mt-7 flex items-center gap-4 rounded-2xl bg-foreground/[0.03] px-5 py-4 ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
        <div className="size-11 shrink-0 rounded-xl bg-gradient-to-br from-sky-200 to-emerald-200" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-foreground">
            新用户首登立领2000积分，教师/学生认证再送4000积分
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            2000积分含新用户注册时赠送的300积分，查看{' '}
            <span className="text-[var(--rail-accent-ink,#0f7a38)]">教师/学生认证</span> 和{' '}
            <span className="text-[var(--rail-accent-ink,#0f7a38)]">活动规则</span>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full bg-foreground px-4 py-2 text-[12.5px] font-medium text-background"
        >
          领取PRO
        </button>
      </div>
    </div>
  )
}

/* ─────────────────────── User message ──────────────────────── */

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-6 flex w-full flex-col items-end gap-2">
      {/* User bubble — text content. `components.Image` overrides the
          default renderer with our own, and `components.Text` (implicit
          default) just returns the raw string, which is then wrapped by
          the bubble's whitespace-pre-wrap styling.
          Image parts render OUTSIDE the bubble so the blue pill stays
          clean — thumbnails sit above the text bubble, right-aligned,
          matching how messaging apps (iMessage, WhatsApp) stack an
          image caption. */}
      <MessagePrimitive.Parts
        unstable_showEmptyOnNonTextEnd={false}
        components={{
          Image: UserImagePart,
          // Text is set to null so the outer Parts renders only
          // images. The bubble below renders the text instead — this
          // split avoids text flowing "through" the image thumb gap.
          Text: () => null
        }}
      />
      {/* Apple iMessage-style user bubble. rounded-[22px] is the
          softer inner curve iMessage/Messages uses. Pure `bg-accent`
          (Apple Blue, no alpha) is DESIGN.md §2's mandate: Apple Blue
          is the singular interactive accent and should never be
          diluted. 15px body with apple-body tracking gives the
          signature tight-but-readable Apple rhythm.

          ClampedUserBubble caps the height of a very long message so one
          giant paste can't fill the whole transcript — it clamps to
          USER_BUBBLE_MAX_PX and fades the overflow out at the bottom. */}
      <ClampedUserBubble />
    </MessagePrimitive.Root>
  )
}

/**
 * Max rendered height (px) of a user bubble before it clamps. ~6 lines at
 * the bubble's 15px/1.47 rhythm plus its py-2.5 padding. A long paste gets
 * cut here so it can't dominate the transcript; shorter messages render in
 * full and never clamp.
 */
const USER_BUBBLE_MAX_PX = 150

/** Join a user message's text parts into the full raw string (for the
 *  full-text modal + copy). Mirrors the content-walk in AssistantFileCards. */
function useUserMessageText(): string {
  const message = useMessage()
  return useMemo(() => {
    const content = (message as { content?: readonly unknown[] }).content
    if (!Array.isArray(content)) return ''
    let text = ''
    for (const part of content) {
      const p = part as { type?: string; text?: string }
      if (p.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text
      }
    }
    return text
  }, [message])
}

/**
 * The user bubble body, height-clamped when it overflows. We measure the
 * content's natural scrollHeight against USER_BUBBLE_MAX_PX (re-measuring on
 * resize) and only then apply the max-height + a bottom fade mask — so a
 * short message keeps clean edges and only a genuinely long one gets the
 * truncation + fade.
 *
 * When clamped, the bubble becomes clickable: a click opens a modal showing
 * the full message text (scrollable) with a copy button and close affordances
 * (✕ / backdrop / Esc). Short, un-clamped bubbles aren't clickable.
 */
function ClampedUserBubble(): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [clamped, setClamped] = useState(false)
  const [open, setOpen] = useState(false)
  const fullText = useUserMessageText()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      // scrollHeight is the full content height regardless of max-height;
      // compare against the cap to decide whether to clamp + fade.
      setClamped(el.scrollHeight > USER_BUBBLE_MAX_PX + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <>
      <div
        ref={ref}
        onClick={clamped ? () => setOpen(true) : undefined}
        role={clamped ? 'button' : undefined}
        tabIndex={clamped ? 0 : undefined}
        onKeyDown={
          clamped
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen(true)
                }
              }
            : undefined
        }
        title={clamped ? '点击查看完整内容' : undefined}
        style={
          clamped
            ? {
                maxHeight: `${USER_BUBBLE_MAX_PX}px`,
                // Fade the bottom ~40px to transparent so the cut reads as
                // "there's more" rather than a hard slice. WebkitMaskImage for
                // Chromium (Electron's renderer).
                WebkitMaskImage:
                  'linear-gradient(to bottom, black 0, black calc(100% - 40px), transparent 100%)',
                maskImage:
                  'linear-gradient(to bottom, black 0, black calc(100% - 40px), transparent 100%)'
              }
            : undefined
        }
        className={
          'max-w-[80%] overflow-hidden whitespace-pre-wrap break-words rounded-[22px] bg-accent px-4 py-2.5 text-[15px] leading-[1.47] tracking-apple-body text-white empty:hidden ' +
          (clamped ? 'cursor-pointer transition hover:brightness-[1.06]' : '')
        }
      >
        <MessagePrimitive.Parts
          unstable_showEmptyOnNonTextEnd={false}
          components={{
            // Within the bubble, skip image parts — they're already
            // rendered above. We provide a no-op Image component so
            // nothing appears here, and render Text via UserBubbleText
            // so `@"path"` file mentions become inline file chips
            // instead of raw absolute paths.
            Image: () => null,
            Text: UserBubbleText
          }}
        />
      </div>
      {open ? (
        <UserMessageModal text={fullText} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

/**
 * Full-text modal for a clamped user message. Portal'd to <body> over a
 * blurred backdrop (same lightbox pattern as the image viewer). Dismisses on
 * ✕ / backdrop click / Esc. A copy button lifts the raw text to the clipboard.
 */
function UserMessageModal({
  text,
  onClose
}: {
  text: string
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = (): void => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-8">
      {/* Backdrop — owns dismiss-on-click. */}
      <div
        className="absolute inset-0 bg-background/78 backdrop-blur-lg"
        onClick={onClose}
        aria-hidden
      />
      {/* Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_80px_-20px_rgba(0,0,0,0.4)]"
      >
        {/* Header: copy + close. */}
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <CopyGlyph />
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <CloseGlyph />
          </button>
        </div>
        {/* Full text — scrollable, preserves wrapping. */}
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-5 py-4 text-[14px] leading-[1.6] text-foreground">
          {text}
        </div>
      </div>
    </div>,
    document.body
  )
}

function CopyGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  )
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

/**
 * Render the user bubble's text, turning `@"/abs/path"` / `@/abs/path`
 * file mentions into inline chips (document glyph + file name) instead
 * of dumping the raw absolute path into the blue bubble.
 *
 * Why here and not upstream: the wire format sent to fusion-code MUST
 * stay `@"path"` (extractAtMentionedFiles parses it), and the chat
 * store keeps that verbatim text so a reload re-renders identically.
 * The chip is a pure *display* transform applied at render time — the
 * stored/sent string is untouched, exactly like the composer's own
 * mention chips (chipNodeView) are a view layer over the same text.
 *
 * Matching mirrors fusion-code's own regexes (and pmSchema's TOKEN_RE):
 *   - quoted:  @"path with spaces.pdf"
 *   - bare:    @src/foo.ts   (runs to the next whitespace)
 * A mention is only recognized at start-of-string or after whitespace,
 * so `a@b` / `http://x` don't false-trigger.
 */
const USER_MENTION_RE = /(^|\s)(@"[^"]+"|@\S+)/g

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return name || path
}

/**
 * A leading slash command, e.g. `/claude-desktop:ppt-master rest...`. Only the
 * command token at the very start is matched — a `/` mid-text is left alone.
 * The command may carry a plugin namespace (`claude-desktop:`) and hyphens.
 */
const USER_SLASH_RE = /^(\/[\w:-]+)(\s|$)/

function UserBubbleText({ text }: { text: string }): React.JSX.Element {
  // Split into alternating plain-text / mention segments. We keep the
  // leading-whitespace capture group so spacing around chips is faithful.
  const nodes: React.ReactNode[] = []
  let last = 0
  let key = 0

  // Leading skill command → friendly chip (icon + 「制作PPT」/「生成图片」),
  // mirroring the composer chip. Pure display transform: the stored/sent text
  // keeps the raw `/claude-desktop:…` verbatim. Only known skills (those in the
  // chip registry) get the treatment; other `/cmd` stays plain text.
  const slashMatch = USER_SLASH_RE.exec(text)
  const slashSkill = slashMatch ? findSkillChipSpec(slashMatch[1]!) : null
  if (slashMatch && slashSkill) {
    nodes.push(
      <span
        key={`sk-${key++}`}
        title={slashMatch[1]}
        className="mr-0.5 inline-flex items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 align-baseline text-[13px] font-medium ring-1 ring-white/25"
      >
        <svg width={12} height={12} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
          {fileIconPathsByKey(slashSkill.icon).map((p, pi) => (
            <path key={pi} d={p.d} fill={p.fill} />
          ))}
        </svg>
        <span>{slashSkill.label}</span>
      </span>
    )
    // Skip past the command token (keep the separating space as plain text).
    last = slashMatch[1]!.length
  }

  let m: RegExpExecArray | null
  USER_MENTION_RE.lastIndex = last
  while ((m = USER_MENTION_RE.exec(text)) !== null) {
    const lead = m[1] ?? ''
    const token = m[2]!
    const tokenStart = m.index + lead.length
    // Plain text before this mention (including the captured leading WS).
    if (tokenStart > last) {
      nodes.push(text.slice(last, tokenStart))
    }
    // Strip the `@` and any surrounding quotes to get the raw path.
    const raw = token.slice(1)
    const path =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    nodes.push(
      <span
        key={`fm-${key++}`}
        title={path}
        className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-md bg-white/20 px-1.5 py-0.5 align-baseline text-[13px] font-medium ring-1 ring-white/25"
      >
        {/* Per-type glyph, but NOT coloured — the chip sits on the blue
            user bubble where the icon inherits the bubble's white text;
            a type accent colour would read as dirty here. */}
        <FileTypeIcon
          pathOrName={path}
          size={12}
          className="shrink-0 opacity-90"
        />
        <span className="truncate">{basenameOf(path)}</span>
      </span>
    )
    last = tokenStart + token.length
  }
  if (last < text.length) {
    nodes.push(text.slice(last))
  }
  // No mentions → render the string as-is (keeps the common path cheap).
  if (nodes.length === 0) return <>{text}</>
  return <>{nodes}</>
}

/**
 * Render a user-attached image as a thumbnail chip above the message
 * bubble. `image` is the data URL that flowed through:
 *   paste → imageAttachmentAdapter.send → ImageMessagePart.image
 *         → AppendMessage → chat store.appendUserMessage → here
 *
 * We cap the thumbnail at 220×220 (object-cover crops overflow); clicking
 * it opens an in-app lightbox modal — ESC or backdrop click dismisses.
 */
function UserImagePart({
  image,
  filename
}: {
  image: string
  filename?: string
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const altText = filename ?? t('imageAttachedAlt')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-block max-w-[80%] cursor-zoom-in overflow-hidden rounded-xl border border-input bg-card/70 transition hover:border-input"
        title={altText}
      >
        <img
          src={image}
          alt={altText}
          className="max-h-[220px] max-w-full object-cover"
        />
      </button>
      {/* Portal the lightbox into document.body so `position: fixed`
          covers the entire window, not just the ThreadView column.
          Ancestors in the message tree (motion wrappers, assistant-ui
          Viewport) set `transform` / `will-change` which turns them
          into containing blocks for fixed descendants, causing the
          modal to visually clip to the chat column. Portaling escapes
          that chain entirely. */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={filename ?? t('imagePreviewAria')}
              // `WebkitAppRegion: no-drag` on the outer wrapper — the
              // app's `.header` has `-webkit-app-region: drag` so the
              // user can drag the window by the title bar. That
              // property works in screen coordinates; without a
              // `no-drag` override on the modal, the top ~48px strip
              // (overlapping the header) would still be a window-drag
              // zone and clicks there (backdrop dismiss, image click,
              // close button top half) would be swallowed by the OS.
              // `no-drag` inherits through the subtree so every
              // interactive element in the lightbox is click-safe.
              //
              // No onClick here — dismiss-on-backdrop lives on the blur
              // layer below so the close button's click has a clean
              // path and doesn't need to fight with this wrapper.
              style={
                { WebkitAppRegion: 'no-drag' } as React.CSSProperties
              }
              className="fixed inset-0 z-[100] flex items-center justify-center"
            >
              {/* Blur layer — owns the backdrop dismiss. Static
                  backdrop-filter isolated in its own layer so Chromium
                  doesn't re-run the blur on every frame of the opacity
                  tween (backdrop-filter + animated opacity is the #1
                  cause of laggy modal transitions in Electron).
                  Entry and exit share the same tween duration with
                  entry using easeOutExpo (snappy start, soft stop)
                  and exit using easeInOutQuad (gentle both ends) so
                  the close doesn't feel like it's been yanked away. */}
              <motion.div
                aria-hidden
                onClick={() => setOpen(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1]
                }}
                style={{ willChange: 'opacity' }}
                className="absolute inset-0 z-0 bg-background/78 backdrop-blur-lg"
              />

              {/* Image wrapper. `z-10` sits above the blur layer; the
                  motion element creates its own stacking context via
                  `willChange: transform` anyway, but the explicit z
                  makes hit-test order unambiguous. Tween with
                  cubic-bezier easeOutExpo — snappier and more
                  predictable than the old bouncy spring. Exit uses a
                  gentler scale-down (0.94, matching the entry) so the
                  reverse motion reads as a true inverse instead of
                  snapping shut. */}
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{
                  opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                  scale: { duration: 0.36, ease: [0.22, 1, 0.36, 1] }
                }}
                style={{ willChange: 'transform, opacity' }}
                className="relative z-10 flex max-h-[85vh] max-w-[90vw] flex-col items-center transform-gpu"
              >
                <img
                  src={image}
                  alt={altText}
                  onClick={() => setOpen(false)}
                  draggable={false}
                  className="max-h-[85vh] max-w-[90vw] cursor-zoom-out rounded-xl object-contain shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/10"
                />
                {/* Filename caption pill. Only shown when we actually
                    know the name — pasted clipboard images have none. */}
                {filename && (
                  <div className="mt-3 max-w-full truncate rounded-full border border-border/60 bg-card/80 px-3 py-1 font-mono text-[11px] text-muted-foreground">
                    {filename}
                  </div>
                )}
              </motion.div>

              {/* Close button — `motion.button` with **opacity-only**
                  animation. No `scale` / `y` / `rotate`: those would
                  introduce a transform layer and re-trigger the
                  earlier hit-test bug where the button's top half was
                  unclickable (will-change: transform + the image
                  wrapper's transform-gpu layer made Chromium's
                  cross-layer hit-test non-deterministic). Pure
                  opacity fades don't create a transform containing
                  block, so the hit rect stays exactly the layout box.
                  Hit target: `p-2.5` extends the clickable region to
                  60×60 while the visible 40×40 pill is an inner span.
                  `WebkitAppRegion: no-drag` is inherited from the
                  parent wrapper but spelled out here defensively —
                  the app header's drag region would otherwise swallow
                  clicks on the top half of the button. */}
              <motion.button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                }}
                aria-label={t('imagePreviewClose')}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1]
                }}
                style={
                  {
                    WebkitAppRegion: 'no-drag',
                    willChange: 'opacity'
                  } as React.CSSProperties
                }
                className="group/close fixed right-4 top-4 z-50 flex items-center justify-center p-2.5"
              >
                <span
                  aria-hidden
                  className="flex size-10 items-center justify-center rounded-full border border-border/70 bg-background/90 text-foreground shadow-lg transition-colors group-hover/close:border-input group-hover/close:bg-muted"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </motion.button>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

/* ───────────────────── Assistant message ───────────────────── */

/**
 * Free-code-style assistant message: no avatar column. The visual
 * vocabulary is per-part gutter glyphs instead — each text segment
 * gets a `●`, each tool call gets a `⎿`, each thinking segment gets
 * a `∴`. This matches how the fusion-code CLI renders an assistant
 * turn in the terminal: every content block stands on its own row,
 * with its own gutter character on the left.
 *
 * The actual glyph rendering lives inside each per-part component
 * (AssistantTextRow, ToolCallCard, ThinkingSpinner) so a turn that
 * mixes text + tool + text reads as three vertically stacked rows
 * with three different gutter characters, exactly like the terminal.
 */
function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-6 flex w-full flex-col gap-3">
      {/* unstable_showEmptyOnNonTextEnd={false}: without this, Empty
          (= ThinkingSpinner) fires after every part whose type isn't
          text — i.e. after every tool-call. A turn that's [Bash, Grep,
          Glob, Read, ...] would then render a Thinking row between
          every pair of tools, all reading the same elapsed seconds
          because they share the global turnStartedAt. We only want
          the spinner to appear in the genuine "no parts yet" gap. */}
      <MessagePrimitive.Parts
        unstable_showEmptyOnNonTextEnd={false}
        components={{
          Text: AssistantTextRow,
          // Reasoning (extended-thinking) parts. assistant-ui's
          // default for this slot is `() => null`, which is why
          // thinking blocks were invisible before. Our custom card
          // makes them collapsible so they don't overwhelm the chat
          // when the model thinks for a long time.
          Reasoning: ReasoningCard,
          tools: {
            Fallback: ToolCallCard
          },
          // Empty fires when the assistant message has no content
          // parts yet — typically the runtime-injected optimistic
          // placeholder during the pre-text gap of a new turn.
          // ThinkingSpinner already renders its own animated glyph
          // in the gutter, so it slots right in next to text rows.
          Empty: ThinkingSpinner
        }}
      />
      {/* File cards for any files the assistant wrote this turn. Renders
          only once the turn completes (see AssistantFileCards). */}
      <AssistantFileCards />
    </MessagePrimitive.Root>
  )
}

/**
 * Match absolute file paths inside assistant text. The assistant often
 * writes files via a Bash/python heredoc (no `file_path` tool arg to
 * scrape), so the only reliable signal is the path it prints in prose,
 * e.g. "已保存为 `/Users/me/Desktop/方案/报告.docx`". We therefore scrape
 * the TEXT, not tool args.
 *
 * The path:
 *   - starts at `/` that's at string start or preceded by whitespace,
 *     a backtick, or a quote (so we catch `…` / "…" wrapped paths and
 *     bare ones, but not a `//` inside a URL's `http://`).
 *   - runs over any non-whitespace, non-quote, non-backtick chars —
 *     this includes CJK, spaces are NOT allowed (a path with spaces in
 *     prose is usually backtick/quote-wrapped, handled by the boundary).
 *   - must contain a filename with an extension in the last segment, so
 *     we don't card a bare directory like `/Users/me/Desktop`.
 *
 * Existence is verified server-side (chatApi.statFiles) — this regex
 * only proposes candidates; main drops anything that isn't a real file.
 */
const ABS_PATH_RE = /(?:^|[\s`"'(])(\/[^\s`"'()]*\/[^\s`"'()/]+\.[A-Za-z0-9]+)/g

function scrapeAbsolutePaths(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  ABS_PATH_RE.lastIndex = 0
  while ((m = ABS_PATH_RE.exec(text)) !== null) {
    let path = m[1]!
    // Trim trailing sentence punctuation the regex may have swept in
    // (e.g. "保存为 /a/b.docx。" → drop the 。/,/) etc.).
    path = path.replace(/[。，、,.;:)）】」"'`]+$/, '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * Extract absolute file paths a tool call PRODUCED or MODIFIED — the
 * reliable source for "what file did this turn leave on disk", since
 * it's the path the model passed to the tool, not prose it wrote after.
 *
 *   - Write/Edit/MultiEdit/NotebookEdit → the `file_path` arg.
 *   - Bash → absolute paths inside the `command` string, but ONLY when
 *     the command looks like it WRITES (mv/cp/touch/tee/install/… or a
 *     `>`/`>>` redirect). A read-only `cat /a/x.txt` / `grep … /a/y.log`
 *     must not card files it merely inspected, and those paths usually
 *     still exist so statFiles wouldn't catch them. The source path of a
 *     `mv` is included too, but statFiles drops it (it no longer exists),
 *     so only the resulting file ends up carded.
 *
 * Deliberately NOT Read: a turn that merely reads files shouldn't card
 * them — the cards mean "here's what I made for you", and a read file
 * almost always still exists, so it would survive statFiles and spam a
 * card per file the model glanced at.
 *
 * Returns only absolute (`/…`) paths so statFiles gets resolvable input;
 * a bare `file_path: "src/foo.ts"` from a relative-cwd tool is skipped
 * (we can't resolve cwd here) rather than stat'd against the wrong root.
 */
const FILE_WRITING_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit'
])

// A Bash command is treated as file-producing if it invokes a known
// write/move verb OR contains an output redirect. Word-boundary anchored
// so `cat`/`category` don't match a `cp`-style verb by substring; the
// redirect alternative catches `cmd > /abs/out` regardless of the verb.
const BASH_WRITE_RE =
  /(?:^|[\s;&|(])(?:mv|cp|touch|tee|install|dd|rsync|ln|mkdir|convert|ffmpeg|pandoc|zip|tar|sed\s+-i)\b|>>?/

function pathsFromToolCall(toolName?: string, args?: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const obj = args as Record<string, unknown>
  if (toolName === 'Bash') {
    const cmd = obj.command
    if (typeof cmd !== 'string' || !BASH_WRITE_RE.test(cmd)) return []
    return scrapeAbsolutePaths(cmd)
  }
  if (toolName && FILE_WRITING_TOOLS.has(toolName)) {
    const fp = pickFilePath(args)
    return fp && fp.startsWith('/') ? [fp] : []
  }
  return []
}

/**
 * Render a card per file the assistant produced this turn, beneath the
 * message body — appearing only AFTER the turn finishes so cards don't
 * pop in mid-stream while the model is still writing.
 *
 * Pipeline:
 *   1. Collect candidate absolute paths from this turn from TWO sources:
 *      a) the tool calls the assistant actually ran — `file_path` of
 *         Write/Edit/MultiEdit/NotebookEdit, and any absolute path inside
 *         a Bash `command` (so a `mv …/a.docx …/b.docx` cards the result).
 *         This is the reliable source: it's the path the model operated
 *         on, not whatever it happened to spell out in prose afterwards.
 *      b) the prose text parts (scrapeAbsolutePaths) — a fallback for
 *         turns that produced a file via a tool we don't special-case but
 *         still named the absolute path in the reply.
 *   2. Ask main which of those actually exist as files (chatApi.statFiles)
 *      — the renderer has no fs access, and we don't want to card a path
 *      the model merely mentioned/read but didn't leave on disk (a renamed
 *      file's old path is gone, so only the survivor cards).
 *   3. Render a card per surviving file; clicking opens it with the OS
 *      default app (chatApi.openPath → shell.openPath).
 */
function AssistantFileCards(): React.JSX.Element | null {
  const message = useMessage()

  // Gate on completion. A streaming assistant message has
  // `status.type === 'running'`; we only verify + render once it's done.
  const status = (message as { status?: { type?: string } }).status
  const isRunning = status?.type === 'running'

  // Candidate paths for this turn, drawn from the tool calls the model
  // actually ran (reliable) plus a prose fallback. Memoized on message
  // identity so we don't re-scrape on unrelated rerenders.
  const candidates = useMemo(() => {
    const content = (message as { content?: readonly unknown[] }).content
    if (!Array.isArray(content)) return [] as string[]
    const out: string[] = []
    let text = ''
    for (const part of content) {
      const p = part as {
        type?: string
        text?: string
        toolName?: string
        args?: unknown
      }
      if (p.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text
      } else if (p.type === 'tool-call') {
        out.push(...pathsFromToolCall(p.toolName, p.args))
      }
    }
    // Prose paths come after tool paths so tool-derived candidates (the
    // ones we trust most) sort first; the final dedupe keeps first-seen.
    if (text) out.push(...scrapeAbsolutePaths(text))
    // Dedupe while preserving order.
    return out.filter((p, i) => out.indexOf(p) === i)
  }, [message])

  // Verified subset (exists + is-file), resolved by main. Empty until
  // the async statFiles round-trip resolves.
  const [files, setFiles] = useState<readonly string[]>([])

  useEffect(() => {
    // Only verify after the turn completes and only if we found any
    // candidates — keeps the IPC chatter to one call per finished turn
    // that actually mentions a path.
    if (isRunning || candidates.length === 0) {
      setFiles([])
      return
    }
    let cancelled = false
    window.chatApi
      .statFiles({ paths: candidates })
      .then((res) => {
        if (!cancelled) setFiles(res.files)
      })
      .catch((err) => {
        console.error('[AssistantFileCards] statFiles failed', err)
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
    // candidates is a fresh array each render but its *contents* only
    // change when the message text changes; join to a stable dep key.
  }, [isRunning, candidates.join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isRunning || files.length === 0) return null

  return (
    // Indented to line up under the text column (gutter dot is size-6
    // + gap-3 ≈ the `ml-9` here), so cards sit flush with the prose.
    <div className="ml-9 flex flex-col gap-2">
      {files.map((path) => (
        <AssistantFileCard key={path} path={path} />
      ))}
    </div>
  )
}

/**
 * One file card: document glyph + file name + a type sub-label, the
 * whole row clickable to open the file. Visual reference is the
 * attachment-list card style (rounded border, muted icon tile, name +
 * meta stacked). On click we call chatApi.openPath; a non-empty error
 * is surfaced inline so a missing/unhandled file isn't a silent no-op.
 */
function AssistantFileCard({ path }: { path: string }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const name = basenameOf(path)
  // Reuse the composer's extension→language map only for a friendly
  // upper-case type tag; fall back to the bare extension.
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
  const lang = languageFromPath(path)
  const typeLabel = lang ? `${lang} · ${ext}` : ext || 'FILE'

  const handleOpen = useCallback(async () => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      const res = await window.chatApi.openPath({ absPath: path })
      if (res.error) setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }, [opening, path])

  return (
    <button
      type="button"
      onClick={handleOpen}
      title={path}
      className="group/fc flex w-full max-w-md items-center gap-3 rounded-xl border border-border bg-card/60 p-2.5 text-left transition-colors hover:border-accent/40 hover:bg-accent/[0.04] disabled:opacity-60"
      disabled={opening}
    >
      {/* Icon tile — coloured per file type (sits on a neutral surface). */}
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <FileTypeIcon pathOrName={path} size={22} />
      </div>
      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">
          {name}
        </div>
        <div className="truncate text-[11px] text-muted-foreground/70">
          {error ? error : typeLabel}
        </div>
      </div>
    </button>
  )
}

/**
 * One row of assistant text with the `●` gutter glyph on the left.
 * The glyph column is fixed-width and aligns with `⎿` / `∴` glyphs
 * on adjacent rows so a multi-part turn reads as a clean ASCII tree
 * down the left edge — same shape as the fusion-code CLI.
 */
function AssistantTextRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex w-full gap-3">
      {/* Gutter dot. We used to render the `●` character, but its
          vertical position depends on the font's glyph metrics and
          ends up sitting above the visual center of the line.
          Replacing it with a real 6px CSS circle lets us offset it
          with pixel precision: AssistantMarkdown's first paragraph
          is `text-[14px] leading-relaxed` (line-height ≈ 22.75px),
          so the line's visual center is at ~11.4px and a 6px dot
          wants its top edge at ~8px to sit dead-center. */}
      <span
        aria-hidden
        className="mt-[8px] block size-[6px] shrink-0 rounded-full bg-foreground/60"
      />
      <div className="min-w-0 flex-1">
        <AssistantMarkdown text={text} />
      </div>
    </div>
  )
}

/* ─────────────────── Reasoning (thinking) card ─────────────── */

/**
 * Collapsible card for an extended-thinking part. The Anthropic API
 * streams `content_block_delta.thinking_delta` events for any
 * thinking block; the engine pipes them into ChatEvent.thinking_delta
 * and the chat store accumulates them into a `reasoning` part on the
 * assistant message. Without this component the part would be
 * invisible — assistant-ui ships a default `Reasoning: () => null`
 * for the slot, presumably because most apps want to hide raw chain
 * of thought.
 *
 * Behavior
 * --------
 * - While the turn is streaming, the card auto-expands so the user
 *   can watch the model think in real time.
 * - Once the turn ends, it auto-collapses to a one-line summary
 *   ("Thinking · 12s · 482 chars"). The user can click to re-expand.
 * - The expand state is per-card local — the user's collapse choice
 *   on one message doesn't affect another.
 *
 * `status` arrives from assistant-ui's MessagePartState. We treat
 * `running` as "still streaming" for the auto-expand decision.
 */
function ReasoningCard({
  text,
  status
}: {
  text: string
  status?: { type: string }
}): React.JSX.Element {
  const isStreaming = status?.type === 'running'
  // A ZWSP-only reasoning part is our "pre-show placeholder" — the
  // card label should appear immediately, but the body should stay
  // collapsed until a real delta replaces the placeholder. We also
  // strip the ZWSP out of the rendered text below so a late-arriving
  // copy-paste doesn't surface an invisible character.
  const displayText = text.replace(REASONING_PLACEHOLDER, '')
  // Trim so a single stray whitespace / newline delta doesn't light
  // up an empty rounded box under the label ("思考过程 · 1 字" with
  // nothing inside).
  const trimmedText = displayText.trim()
  const hasText = trimmedText.length > 0
  // `null` ⇒ user hasn't manually toggled yet — let the streaming
  // flag drive the open state. Once they click, lock to their
  // explicit choice. This way the card auto-expands while thinking
  // and auto-collapses at end-of-turn, but doesn't fight a user
  // who expanded an old card to re-read the chain of thought.
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  // Don't auto-open the body until we actually have text to show.
  // The reasoning part is pre-created on `thinking_start` (so the
  // dot + label appear instantly), and without this guard we'd
  // briefly render an empty rounded box before the first delta
  // lands a few seconds later. Empty reasoning always stays closed.
  const open = hasText && (userToggled ?? isStreaming)
  const charCount = trimmedText.length

  return (
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className="mt-[7px] flex size-[6px] shrink-0 items-center justify-center"
      >
        {/* State indicator dot — mirrors the TodoRow status pattern:
            in-progress = accent (blue) pulsing, done = emerald.
            Same colours used for active todos / completed todos in
            the right rail, so the chat reads as a single visual
            language across surfaces. */}
        <span
          className={
            'block size-[6px] rounded-full ' +
            (isStreaming ? 'bg-accent' : 'bg-emerald-500')
          }
        />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => hasText && setUserToggled(!open)}
          aria-expanded={open}
          disabled={!hasText}
          className={
            'group/reason flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-muted-foreground transition-colors ' +
            (hasText ? 'hover:text-foreground' : 'cursor-default')
          }
        >
          {hasText && (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={
                'shrink-0 transition-transform ' + (open ? 'rotate-90' : '')
              }
              aria-hidden
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          )}
          {isStreaming ? (
            <ShimmerText>正在思考…</ShimmerText>
          ) : (
            <span className="font-medium tracking-tight">思考过程</span>
          )}
          {!isStreaming && hasText && (
            <span className="text-[11px] text-muted-foreground/60">
              · {charCount} 字
            </span>
          )}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="reasoning-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              {/* Apple card (DESIGN.md §4): no border, subtle bg
                  contrast supplies elevation. `bg-muted` sits 1-2
                  shades off the canvas on both themes, so the card
                  reads as "inset" without any visible stroke. 13px
                  text with apple-micro tracking is Apple's smallest
                  comfortable reading size — tight but legible. */}
              <div className="mt-1.5 rounded-apple-lg bg-muted px-4 py-3 text-[13px] leading-[1.47] tracking-apple-micro text-muted-foreground">
                <pre className="whitespace-pre-wrap break-words font-sans">
                  {displayText}
                </pre>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/* ───────────────────── System message ──────────────────────── */

function SystemMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-4 flex w-full justify-center">
      {/* Borderless Apple pill (DESIGN.md §4). `rounded-pill` is the
          signature 980px capsule shape used for Apple CTA links; a
          system message is informational, not interactive, so we keep
          the shape but use `bg-muted` with no accent tint. */}
      <div className="rounded-pill bg-muted px-4 py-1.5 text-[12px] tracking-apple-micro text-muted-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

/**
 * ShimmerText
 * -----------
 * Apple-style text shimmer — a bright highlight sweeps through the
 * characters while the dimmer base color stays put, producing the
 * same "breathing" label effect used on iOS loading states and the
 * Apple homepage hero headlines during async data loads.
 *
 * How it works
 * ------------
 * 1. The `<motion.span>` has its background painted with a 3-stop
 *    horizontal gradient: muted at both ends, foreground at the
 *    center, so the middle third is brighter than the edges.
 * 2. `background-size: 200% 100%` makes the gradient twice as wide
 *    as the text, so there's room to slide the bright center in
 *    and out of view.
 * 3. `background-clip: text` + `color: transparent` clips the
 *    gradient to the letterforms — you see the gradient only where
 *    there's a glyph, so the effect looks like the letters
 *    themselves are breathing, not a rectangle pulsing behind them.
 * 4. Motion interpolates `backgroundPositionX` from `200%` to
 *    `-200%` over 2.4s on a linear repeat, sliding the bright
 *    center of the gradient right-to-left across the element.
 *    (Motion parses percentage string keyframes and smoothly
 *    animates them.)
 *
 * Respects `prefers-reduced-motion` indirectly: motion honors the
 * user's OS setting and will fall back to the final frame instead
 * of animating when `Reduce Motion` is on.
 */
function ShimmerText({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <motion.span
      className="font-medium tracking-tight"
      style={{
        backgroundImage:
          'linear-gradient(90deg, hsl(var(--muted-foreground) / 0.35) 0%, hsl(var(--foreground)) 50%, hsl(var(--muted-foreground) / 0.35) 100%)',
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent'
      }}
      initial={{ backgroundPositionX: '200%' }}
      animate={{ backgroundPositionX: '-200%' }}
      transition={{ duration: 2.4, ease: 'linear', repeat: Infinity }}
    >
      {children}
    </motion.span>
  )
}

/* ───────────────────── Tool-call card ──────────────────────── */

/**
 * Inline tool-call row in free-code's gutter style. Layout:
 *
 *     ⎿  Read  done
 *        │ Input
 *        │   { file_path: "..." }
 *        │ Output
 *        │   ...
 *
 * The leading `⎿` glyph is the gutter character (matches fusion-code
 * terminal's box-drawings light up-and-left for tool blocks). Color
 * is amber while the tool is running, dim when done. The whole block
 * is an inline `<details>` that expands during running and collapses
 * once the result lands, so finished tool calls don't visually crowd
 * the assistant text around them. The Input / Output sub-blocks are
 * indented under a thin left rule (`border-l`) to echo the gutter.
 *
 * Prop shape follows assistant-ui's `tools.Fallback` contract.
 */
type ToolFallbackProps = {
  toolName: string
  toolCallId: string
  args: unknown
  argsText?: string
  result?: unknown
  status?: {
    type: 'running' | 'requires-action' | 'complete' | 'incomplete'
    reason?: string
  }
}

function ToolCallCard(props: ToolFallbackProps): React.JSX.Element {
  const { toolName, toolCallId, args, argsText, result, status } = props
  const toolLabel = useToolLabel()
  const t = useT()
  const lang = useI18n((s) => s.lang)
  const running = status?.type === 'running' || status?.type === 'requires-action'
  // Look up any pending tool-permission request whose `toolUseId` matches
  // this card. When present we render an inline `InlinePermissionPrompt`
  // below the Input pane instead of the old fullscreen modal — one
  // prompt per tool call means parallel tool_use blocks all get their
  // own decision UI and the assistant never stalls waiting on a lost
  // sibling request. See stores/permissions.ts for the store shape.
  const pendingPermission = usePermissionForToolUseId(toolCallId)
  // Workflow/Task subagents spawned by THIS tool call (Task / Workflow
  // tools). Looked up by id from the chat store — same indirection as
  // the permission prompt above, since assistant-ui's Fallback props
  // don't carry the part's `tasks` field. Empty for ordinary tools.
  const subtasks = useToolCallTasks(toolCallId)
  // AskUserQuestion is a special beast — its "args" are the questions
  // themselves and the InlinePermissionPrompt renders the dedicated
  // interactive view that lets the user pick answers. While that prompt
  // is pending, ANY static preview of the same questions above it is
  // pure duplication (the user sees the question list twice — once as a
  // read-only card, once as the live picker). So when AskUserQuestion is
  // pending we suppress not just the raw JSON Input pane but ALSO the
  // friendly headline + friendly input pane (the AskUserQuestion
  // formatter's question preview). After the user answers,
  // pendingPermission clears and the friendly summary comes back so the
  // resolved turn still shows what was asked.
  const askPending =
    pendingPermission !== null && toolName === 'AskUserQuestion'
  // In slides sessions the canvas's 问题 tab hosts the WHOLE AskUserQuestion
  // lifecycle — the streaming input preview AND the answerable form. So for
  // any AskUserQuestion call in a slides session, suppress this card's inline
  // surfaces entirely (input pane, friendly headline, inline prompt): the
  // canvas owns it. This covers the streaming phase too (pendingPermission is
  // still null then), which is why it keys off toolName, not askPending.
  // Outside slides sessions (no canvas) the inline prompt stays the only place
  // to answer. Subscribed (not getState) so flipping into slides mode re-renders.
  const cardSessionId = useChatStore((s) => s.sessionId)
  const cardIsSlides = useComposerModeStore((s) =>
    cardSessionId ? s.slidesSessions[cardSessionId] === true : false
  )
  const askHandledByCanvas =
    toolName === 'AskUserQuestion' && cardIsSlides
  const hideInputPane = askPending || askHandledByCanvas

  // Input-pane display logic — see the original prop-shape comment.
  const hasArgsText = typeof argsText === 'string' && argsText.length > 0
  const inputBody = running
    ? hasArgsText
      ? argsText!
      : '…'
    : safeStringify(args !== undefined ? args : argsText)

  // One-line preview shown next to the tool name while collapsed —
  // lets the user eyeball the call without expanding. `summarizeArgs`
  // picks the most informative scalar field (file_path / query /
  // command / pattern / url …) and falls back to "…" otherwise.
  const summary = summarizeArgs(args)

  // If this is a file-oriented tool (Read / Write / Edit / MultiEdit)
  // we know the result is source code and which language to highlight
  // it as from the `file_path` arg. For everything else (Bash, Grep,
  // Glob, WebFetch, …) we fall back to the original JsonView.
  const filePath = pickFilePath(args)
  const codeLanguage = filePath ? languageFromPath(filePath) : undefined
  const isCodeResult =
    filePath !== undefined &&
    (toolName === 'Read' ||
      toolName === 'Write' ||
      toolName === 'Edit' ||
      toolName === 'MultiEdit')

  // Friendly (human-readable) view, if the tool has a formatter. See
  // ToolFormatters.tsx for the per-tool rules. The formatter owns the
  // panes it sets; anything it leaves `undefined` falls through to the
  // raw JSON / CodeFileView default below, and explicit `null` hides
  // the pane entirely. Formatters gracefully return null when `args`
  // is still a streaming text blob (we don't memoize for the same
  // reason — args can mutate mid-stream).
  const friendly = friendlyToolView(toolName, {
    args,
    argsText,
    result,
    running,
    lang
  })

  // Decide what goes into the input slot.
  //   - friendly.input === undefined ⇒ default JSON pane (honouring
  //     hideInputPane from the AskUserQuestion special-case)
  //   - friendly.input === null      ⇒ no input pane at all
  //   - friendly.input === object    ⇒ friendly replacement
  const useFriendlyInput = Boolean(friendly?.input)
  const hideDefaultInput =
    hideInputPane || friendly?.input === null || useFriendlyInput

  // Same semantics for the output slot, with the extra wrinkle that
  // the default output splits into CodeFileView vs JsonView based on
  // `isCodeResult`. Friendly formatters for Read leave `output`
  // undefined so Read's CodeFileView continues to render.
  const useFriendlyOutput = Boolean(friendly?.output)
  const hideDefaultOutput =
    friendly?.output === null || useFriendlyOutput || result === undefined

  // The "raw data" fallback toggle is only meaningful when we actually
  // replaced at least one of the default panes with a friendly one.
  // Otherwise the default panes are already on screen and there's
  // nothing to "reveal". Suppressed while AskUserQuestion is pending so
  // the user can't expand a duplicate JSON copy of the questions the
  // interactive prompt is already showing.
  const showRawDataToggle =
    !askPending && (useFriendlyInput || useFriendlyOutput)

  // Slides-session AskUserQuestion is rendered entirely in the canvas's 问题
  // tab (streaming preview + answerable form), so this inline card — headline,
  // streaming JSON, prompt and all — would be a duplicate. Render nothing.
  // All hooks above have already run, so this early return is hook-safe.
  if (askHandledByCanvas) return <></>

  return (
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className={
          'mt-[3px] shrink-0 select-none font-mono text-[13px] leading-relaxed ' +
          // DESIGN.md §2: Apple Blue is the ONLY chromatic accent;
          // no amber/yellow anywhere in the palette. The gutter glyph
          // turns accent-blue while streaming and neutral when done.
          (running ? 'text-accent' : 'text-muted-foreground/60')
        }
      >
        ⎿
      </span>
      <div className="min-w-0 flex-1">
        <details open={running} className="group/tool">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
            <StatusDot running={running} />
            <span className="font-mono font-medium text-foreground">
              {toolLabel(toolName)}
            </span>
            <StatusPill running={running} />
            {summary && (
              <span className="ml-0.5 min-w-0 truncate font-mono text-[11.5px] text-muted-foreground/70 group-open/tool:hidden">
                {summary}
              </span>
            )}
            <span
              aria-hidden
              className="ml-auto font-mono text-[10.5px] text-muted-foreground/60 transition group-open/tool:rotate-90"
            >
              ▸
            </span>
          </summary>

          <div className="mt-2 space-y-2 text-[12px]">
            {/* While AskUserQuestion is pending, hide the static question
                preview (headline + friendly input) — the interactive
                InlinePermissionPrompt below already shows the questions,
                so rendering both duplicates the whole list. */}
            {!askPending && friendly?.headline && (
              <div className="text-[12.5px] leading-relaxed text-foreground/85">
                {friendly.headline}
              </div>
            )}

            {!askPending && useFriendlyInput && friendly?.input && (
              <ToolPane
                label={friendly.input.label}
                copyText={friendly.input.copyText}
              >
                {friendly.input.content}
              </ToolPane>
            )}

            {!hideDefaultInput && (
              <ToolPane label={t('toolPaneInputLabel')} copyText={inputBody}>
                <JsonView text={inputBody} maxHeight />
              </ToolPane>
            )}

            {pendingPermission && !askHandledByCanvas && (
              <InlinePermissionPrompt request={pendingPermission} />
            )}

            {subtasks.length > 0 && <WorkflowTaskList tasks={subtasks} />}

            {useFriendlyOutput && friendly?.output && (
              <ToolPane
                label={friendly.output.label}
                copyText={friendly.output.copyText}
              >
                {friendly.output.content}
              </ToolPane>
            )}

            {!hideDefaultOutput &&
              (isCodeResult ? (
                <ToolPane
                  label={t('toolPaneOutputLabel')}
                  copyText={extractText(result)}
                >
                  <CodeFileView
                    text={extractText(result)}
                    language={codeLanguage}
                  />
                </ToolPane>
              ) : (
                <ToolPane
                  label={t('toolPaneOutputLabel')}
                  copyText={safeStringify(result)}
                >
                  <JsonView text={safeStringify(result)} maxHeight />
                </ToolPane>
              ))}

            {showRawDataToggle && (
              <details className="group/raw">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/60 transition hover:text-muted-foreground">
                  <span
                    aria-hidden
                    className="inline-block transition group-open/raw:rotate-90"
                  >
                    ▸
                  </span>
                  {t('toolRawDataSummary')}
                </summary>
                <div className="mt-1.5 space-y-2">
                  {!hideInputPane && (
                    <ToolPane
                      label={t('toolPaneInputLabel')}
                      copyText={inputBody}
                    >
                      <JsonView text={inputBody} maxHeight />
                    </ToolPane>
                  )}
                  {result !== undefined && (
                    <ToolPane
                      label={t('toolPaneOutputLabel')}
                      copyText={safeStringify(result)}
                    >
                      <JsonView text={safeStringify(result)} maxHeight />
                    </ToolPane>
                  )}
                </div>
              </details>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

/**
 * Live sub-agent list rendered inside a Task/Workflow tool card, styled
 * after Claude Code's terminal output: a `⎿` gutter, one row per spawned
 * agent (status glyph + name + right-aligned `tok · tool · elapsed`
 * metadata), with a header line summarising `done/total agents · total
 * elapsed`. Fed by the `task_update` event stream (see stores/chat.ts
 * `updateToolCallTasks`). Deliberately flat — an at-a-glance strip, not
 * a nested transcript.
 */
function WorkflowTaskList({
  tasks
}: {
  tasks: WorkflowTask[]
}): React.JSX.Element {
  const t = useT()
  const done = tasks.filter(
    (task) =>
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'stopped'
  ).length
  // Header elapsed = the longest single agent's elapsed (they run
  // concurrently, so summing would overstate wall-clock).
  const elapsedMs = tasks.reduce(
    (max, task) => Math.max(max, task.durationMs ?? 0),
    0
  )
  return (
    <div className="mt-1 border-l border-border/50 pl-3">
      <div className="flex items-center gap-2 pb-1.5 font-mono text-[11px] text-muted-foreground/70">
        <span className="tabular-nums">
          {done}/{tasks.length} {t('toolWorkflowAgentsLabel')}
        </span>
        {elapsedMs > 0 && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span className="tabular-nums">{formatWfDuration(elapsedMs)}</span>
          </>
        )}
      </div>
      <div className="space-y-1.5">
        {tasks.map((task) => (
          <WorkflowTaskRow key={task.taskId} task={task} />
        ))}
      </div>
    </div>
  )
}

/** One agent row: status glyph + name + right-aligned token/tool/elapsed
 * metadata, with an optional second line (progress summary / error) and
 * an expandable result block when the agent has completed. */
function WorkflowTaskRow({ task }: { task: WorkflowTask }): React.JSX.Element {
  const t = useT()
  const label =
    task.workflowName || task.description || task.subagentType || task.taskId
  const secondary = task.error || task.summary
  const meta = formatWfMeta(task)
  // Only completed tasks carry a meaningful deliverable to expand; while
  // running, `summary` (the live progress line) already shows above.
  const hasResult =
    task.status === 'completed' &&
    Boolean(task.result) &&
    task.result !== task.summary
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 font-mono text-[12px]">
        <WorkflowTaskGlyph status={task.status} />
        <span className="min-w-0 truncate font-medium text-foreground/90">
          {label}
        </span>
        {task.subagentType && task.subagentType !== label && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground/40">
            {task.subagentType}
          </span>
        )}
        {meta && (
          <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
            {meta}
          </span>
        )}
      </div>
      {secondary && (
        <div
          className={
            'pl-5 text-[11px] leading-snug ' +
            (task.error
              ? 'text-red-500/85'
              : 'line-clamp-2 text-muted-foreground/65')
          }
        >
          {secondary}
        </div>
      )}
      {hasResult && (
        <details className="group/wfres pl-5">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 transition hover:text-muted-foreground">
            <span
              aria-hidden
              className="inline-block transition group-open/wfres:rotate-90"
            >
              ▸
            </span>
            {t('toolWorkflowResultLabel')}
          </summary>
          <div className="mt-1 whitespace-pre-wrap rounded-md bg-muted/30 p-2 text-[11.5px] leading-relaxed text-foreground/80">
            {task.result}
          </div>
        </details>
      )}
    </div>
  )
}

/** Right-aligned `27.2k tok · 1 tool · 16s` metadata for an agent row. */
function formatWfMeta(task: WorkflowTask): string {
  const bits: string[] = []
  if (typeof task.tokens === 'number' && task.tokens > 0) {
    bits.push(`${formatWfTokens(task.tokens)} tok`)
  }
  if (typeof task.toolUses === 'number' && task.toolUses > 0) {
    bits.push(`${task.toolUses} tool${task.toolUses === 1 ? '' : 's'}`)
  }
  if (typeof task.durationMs === 'number' && task.durationMs > 0) {
    bits.push(formatWfDuration(task.durationMs))
  }
  return bits.join(' · ')
}

/** 27200 → "27.2k", 950 → "950". */
function formatWfTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** 16000 → "16s", 95000 → "1m35s". */
function formatWfDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m${rem}s`
}

/**
 * Monospace status glyph echoing Claude Code's terminal vocabulary:
 * `✔` done · `✗` failed · `⊘` stopped · `◐` (pulsing) running ·
 * `○` pending. Coloured per state; only the running glyph animates.
 */
function WorkflowTaskGlyph({
  status
}: {
  status: WorkflowTask['status']
}): React.JSX.Element {
  const map = {
    completed: { glyph: '✔', cls: 'text-emerald-500' },
    failed: { glyph: '✗', cls: 'text-red-500' },
    stopped: { glyph: '⊘', cls: 'text-muted-foreground/60' },
    pending: { glyph: '○', cls: 'text-muted-foreground/40' },
    running: { glyph: '◐', cls: 'text-accent animate-pulse' }
  } as const
  const { glyph, cls } = map[status]
  return (
    <span aria-hidden className={'w-3 shrink-0 text-center ' + cls}>
      {glyph}
    </span>
  )
}

function StatusDot({ running }: { running: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={
        'inline-block size-1.5 rounded-full ' +
        (running ? 'bg-accent' : 'bg-emerald-500')
      }
    />
  )
}

function StatusPill({ running }: { running: boolean }): React.JSX.Element {
  const t = useT()
  const lang = useI18n((s) => s.lang)
  // English pills keep the original mono-uppercase look; Chinese pills
  // drop the uppercase / wide-tracking classes since neither apply to
  // CJK glyphs (they just inflate the label box).
  const typographyClasses =
    lang === 'zh'
      ? 'font-sans text-[10px]'
      : 'font-mono text-[10px] uppercase tracking-wider'
  // Apple pill (DESIGN.md §4): fully rounded 980px capsule, no
  // border, color comes from a tinted bg + matching tinted text.
  // Running = Apple accent (the ONLY chromatic interactive color);
  // done = emerald (universal success signal — DESIGN.md reserves
  // blue for interactive elements, so completion state uses the
  // conventional macOS "check" green instead of spending accent on
  // a non-interactive indicator).
  return (
    <span
      className={
        'rounded-pill px-2 py-[2px] ' +
        typographyClasses +
        ' ' +
        (running
          ? 'bg-accent/15 text-accent'
          : 'bg-emerald-500/10 text-emerald-500')
      }
    >
      {running ? t('toolStatusRunning') : t('toolStatusDone')}
    </span>
  )
}

function ToolPane({
  label,
  copyText,
  children
}: {
  label: string
  copyText: string
  children: React.ReactNode
}): React.JSX.Element {
  // `min-w-0` on both the outer card and the body wrapper lets the
  // pane shrink below its child <pre>'s intrinsic width — without it,
  // a single long unwrappable line in INPUT/OUTPUT would push the
  // chat column wider than its flex slot and steal pixels from the
  // right rail on narrow windows. The pre inside JsonView then
  // owns the actual horizontal scroll.
  // Apple card (DESIGN.md §4): no border, elevation comes from bg
  // contrast alone. Outer card = `bg-muted` (one shade off canvas),
  // label strip = `bg-card` (card surface, same as message content
  // cards). The two tones create an implied separation where we
  // used to draw a border-b. Radius bumps to apple-md (11px) — the
  // DESIGN.md value for "inputs / filter controls".
  return (
    <div className="min-w-0 overflow-hidden rounded-apple-md bg-muted">
      <div className="flex items-center justify-between bg-card/80 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        <CopyButton text={copyText} />
      </div>
      <div className="min-w-0 px-3 py-2">{children}</div>
    </div>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const handle = useCallback(() => {
    void navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [text])
  return (
    <button
      type="button"
      onClick={handle}
      className="rounded px-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70 transition hover:bg-muted hover:text-foreground"
      aria-label="Copy to clipboard"
    >
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

/**
 * Lightweight JSON syntax highlighter. Walks a pretty-printed JSON
 * string with a single regex and wraps each token in a colored span.
 * No dependency on a prism / shiki bundle — the tool-call card
 * renders inline in every assistant message, so cheap & dependency-
 * free wins over the perfect highlight.
 *
 * Falls back to plain text if the input is empty or doesn't contain
 * obvious JSON markers (e.g. raw command output strings from Bash).
 */
function JsonView({
  text,
  maxHeight
}: {
  text: string
  maxHeight?: boolean
}): React.JSX.Element {
  if (!text) {
    return (
      <pre className="font-mono text-[11.5px] text-muted-foreground/60">
        (empty)
      </pre>
    )
  }
  const looksJson = /^[\s]*[\{\[]/.test(text)
  return (
    // `whitespace-pre` (no wrap) + `overflow-x-auto` so long lines
    // scroll horizontally inside the pane instead of forcing the
    // column wider. `max-w-full` + parent `min-w-0` (set on ToolPane)
    // is what keeps the chat column from bursting and stealing
    // pixels from the right rail on narrow windows. Vertical
    // scrolling is opt-in via `maxHeight` for paths where we want
    // to cap a giant tool result.
    <pre
      className={
        'max-w-full overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-snug text-foreground/85 ' +
        (maxHeight
          ? 'max-h-80 overflow-y-auto pb-5 [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-28px),transparent_100%)]'
          : '')
      }
    >
      {looksJson ? highlightJson(text) : text}
    </pre>
  )
}

function highlightJson(src: string): React.ReactNode[] {
  // Single regex pulls out the four JSON token kinds plus runs of
  // structural / whitespace text in between. Order matters: strings
  // first so embedded `:`/`,` inside a string don't get mistaken for
  // structural tokens.
  const tokenRe =
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(src)) !== null) {
    if (m.index > last) {
      out.push(<span key={key++}>{src.slice(last, m.index)}</span>)
    }
    if (m[1] !== undefined) {
      // Quoted string. If immediately followed by `:`, it's a key.
      const isKey = m[2] !== undefined
      out.push(
        <span
          key={key++}
          className={isKey ? 'text-accent' : 'text-emerald-500'}
        >
          {m[1]}
        </span>
      )
      if (isKey) out.push(<span key={key++}>{m[2]}</span>)
    } else if (m[3] !== undefined) {
      out.push(
        <span key={key++} className="text-amber-400">
          {m[3]}
        </span>
      )
    } else if (m[4] !== undefined) {
      out.push(
        <span key={key++} className="text-sky-400">
          {m[4]}
        </span>
      )
    }
    last = tokenRe.lastIndex
  }
  if (last < src.length) {
    out.push(<span key={key++}>{src.slice(last)}</span>)
  }
  return out
}

/**
 * Pull a single representative scalar out of a tool-call args object
 * for the collapsed summary. Picks the first matching field from a
 * priority list, truncates to ~60 chars, and returns null if no
 * scalar is found (the summary is then omitted).
 */
function summarizeArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  const keys = [
    'file_path',
    'path',
    'pattern',
    'query',
    'command',
    'cmd',
    'url',
    'name',
    'description'
  ]
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) {
      const trimmed = v.length > 60 ? `${v.slice(0, 57)}…` : v
      return trimmed
    }
    if (typeof v === 'number') return String(v)
  }
  return null
}

/* ───────────── Code-file output highlighting ────────────── */

/**
 * Pull `file_path` out of an arbitrary tool-args blob. Tools are
 * free-form JSON so we just poke at the conventional keys the
 * file-oriented tools use.
 */
function pickFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const obj = args as Record<string, unknown>
  const v = obj.file_path ?? obj.filePath ?? obj.path
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Map a file extension (or basename for Dockerfile / Makefile) to a
 * highlight.js language id. Only covers the subset bundled in
 * `highlight.js/lib/common` — anything else falls through to
 * `undefined` so hljs.highlightAuto can take a guess.
 */
function languageFromPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop() ?? path
  const lower = base.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    py: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    svelte: 'xml',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    sql: 'sql',
    php: 'php',
    lua: 'lua'
  }
  return map[ext]
}

/**
 * Parse Claude Code's `Read` output which is `cat -n` style:
 *     `     1\timport foo from 'bar'`
 *
 * Returns a `{ gutter, code }` pair with matching line counts so the
 * renderer can show them side-by-side. If the input doesn't match the
 * numbered format (Write/Edit output, raw files from other tools) we
 * generate sequential line numbers so every view looks consistent.
 */
function splitNumberedLines(text: string): {
  gutter: number[]
  code: string
} {
  const lines = text.split('\n')
  const gutter: number[] = []
  const codeLines: string[] = []
  let allNumbered = lines.length > 0
  for (const line of lines) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line)
    if (!m) {
      allNumbered = false
      break
    }
    gutter.push(parseInt(m[1]!, 10))
    codeLines.push(m[2]!)
  }
  if (!allNumbered) {
    return {
      gutter: lines.map((_, i) => i + 1),
      code: text
    }
  }
  return { gutter, code: codeLines.join('\n') }
}

function CodeFileView({
  text,
  language
}: {
  text: string
  language: string | undefined
}): React.JSX.Element {
  const { gutter, code, html } = useMemo(() => {
    const { gutter: g, code: c } = splitNumberedLines(text)
    // highlight.js throws if you hand it an unregistered language, so
    // we check `getLanguage` first and otherwise fall back to
    // `highlightAuto` which scans for the best match across the
    // bundled set. `ignoreIllegals: true` keeps partial / mid-stream
    // snippets from tripping the highlighter.
    let rendered: string
    try {
      if (language && hljs.getLanguage(language)) {
        rendered = hljs.highlight(c, { language, ignoreIllegals: true }).value
      } else {
        rendered = hljs.highlightAuto(c).value
      }
    } catch {
      rendered = escapeHtml(c)
    }
    return { gutter: g, code: c, html: rendered }
  }, [text, language])

  if (!text) {
    return (
      <pre className="font-mono text-[11.5px] text-muted-foreground/60">
        (empty)
      </pre>
    )
  }

  return (
    // Vertical scroll + fade-out mask lives on the outer div so both
    // the line-number gutter and the code column share the exact same
    // viewport. `pb-6` leaves enough breathing room that the last line
    // of code stays fully legible once the user scrolls to the bottom —
    // only the trailing padding gets eaten by the mask.
    <div className="max-h-80 overflow-auto rounded-sm bg-card/20 pb-6 [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-32px),transparent_100%)]">
      <div className="flex font-mono text-[11.5px] leading-[1.55]">
        <pre
          aria-hidden
          className="select-none whitespace-pre py-1 pl-2 pr-3 text-right tabular-nums text-muted-foreground/50"
        >
          {gutter.join('\n')}
        </pre>
        <pre
          className="flex-1 overflow-x-auto whitespace-pre py-1 pr-3 text-foreground/90 [font-feature-settings:'calt','tnum'] [hyphens:none]"
          // hljs returns already-escaped HTML with <span class="hljs-*">
          // wrappers. These are the same class names our highlight.css
          // palette targets, so no extra theming needed here.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
  // `code` is only used for clipboard parity; suppressed here since
  // ToolPane's CopyButton uses the outer extractText() value.
  void code
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/* ───────────────────── Composer ────────────────────────────── */

/**
 * Composer with `/` slash-command autocomplete AND `@` file-mention
 * autocomplete.
 *
 * Wired in four layers:
 *
 *   1. **SessionMeta fetch** — pulled from main on mount and after
 *      every turn end. The first user turn triggers fusion-code's
 *      cold start, which emits a `system init` SDK message containing
 *      `slash_commands` / `mcp_servers` / `skills`. Once that meta is
 *      cached in main, subsequent `getSessionMeta` calls return the
 *      real list.
 *
 *   2. **File list fetch** — pulled from main via IPC on mount and
 *      when streaming ends. Main scans `cwd` via `git ls-files` (or
 *      readdir fallback) with a 5s TTL cache, so rapid re-fetches
 *      share the same result. Loaded into React state so the
 *      Unstable_TriggerAdapter.search() can be synchronous (the
 *      primitive requires sync data access).
 *
 *   3. **Adapters** — `buildSlashAdapter` and `buildFileMentionAdapter`
 *      return Unstable_TriggerAdapter instances memoized on their
 *      respective data sources. File adapter does O(n) substring +
 *      path-depth ranking on every keystroke (see fileMentionAdapter.ts).
 *
 *   4. **Popover JSX** — Two nested `Unstable_TriggerPopoverRoot`s
 *      share the same ComposerPrimitive.Input. Each root listens to
 *      its own trigger character (`/` or `@`) and only opens its
 *      popover when that character is active. Because
 *      `unstable_useTriggerPopoverContext()` walks up the React tree
 *      to find the *nearest* root, the slash popover JSX lives in
 *      the outer root (above the @ root) and the file popover lives
 *      inside the inner root — each then reads its own context.
 *
 * On selection both popovers use `insertDirective`, which removes
 * the `<trigger><query>` token from the input and writes
 * `serialize(item)` in its place. For slash commands that's the
 * literal `/cmd`; for file mentions that's `@path `. The user then
 * presses Enter to submit — at which point free-code's CLI runs
 * `extractAtMentionedFiles` on the text and auto-attaches each file.
 */
function Composer(): React.JSX.Element {
  const t = useT()
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [files, setFiles] = useState<readonly string[]>([])
  const streaming = useChatStore((s) => s.streaming)
  // Slides binding: when the user sends while the global picker is on
  // 幻灯片, mark the CURRENT session as a slides session so ThreadView
  // shows its two-pane layout from then on (per-session, not global).
  // Called on every send path (Enter → onSubmit, and the Send button's
  // onClick); markSlidesSession is idempotent so double-calls are fine.
  const composerSessionId = useChatStore((s) => s.sessionId)
  const markIfSlides = useCallback(() => {
    const st = useComposerModeStore.getState()
    if (st.mode === 'slides') st.markSlidesSession(composerSessionId ?? '')
  }, [composerSessionId])
  // Read dictation state at the Composer level (single subscription)
  // and branch the composer row layout on it. When dictating, the
  // textarea is replaced by a live waveform, the send + mic slots
  // become a pair of X / ✓ controls — matching the mutually
  // exclusive UX in the design reference.
  const isDictating = useAuiState(
    (s) => (s as { composer?: { dictation?: unknown } }).composer?.dictation != null
  )
  // Composer runtime — used to submit via the same path Send uses
  // (the ProseMirror input's onSubmit calls composerRuntime.send()).
  const composerRuntime = useComposerRuntime()

  // Pull session meta on mount and whenever a turn ends. The first
  // pull (mount) returns empty arrays because fusion-code hasn't
  // spawned yet; the post-first-turn pull picks up the populated
  // cache. Subsequent turn-end pulls are no-ops on stable data but
  // cheap (one IPC round-trip).
  useEffect(() => {
    if (streaming) return
    let cancelled = false
    window.chatApi
      .getSessionMeta()
      .then((meta) => {
        if (!cancelled) setSessionMeta(meta)
      })
      .catch((err) => {
        console.error('[Composer] getSessionMeta failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [streaming])

  // Also refresh sessionMeta the instant main fires
  // `session:meta-changed` — this is what carries fusion-code's
  // skills / mcp servers / slash commands, and it arrives on the
  // first `system init` message (which is ~30s into the initial
  // cold start, mid-stream). Without this subscription, the `/`
  // popover would only see the full command set after the first
  // turn ends and the [streaming] effect above re-polls — a bad
  // UX when the user is already typing their second prompt while
  // the first is still rendering. One IPC round-trip per push,
  // main-side cache keeps it cheap.
  useEffect(() => {
    if (!window.chatApi) return
    let cancelled = false
    const unsub = window.chatApi.onSessionMetaChanged(() => {
      window.chatApi
        .getSessionMeta()
        .then((meta) => {
          if (!cancelled) setSessionMeta(meta)
        })
        .catch((err) => {
          console.error('[Composer] getSessionMeta (pushed) failed', err)
        })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Pull the file list on the same cadence as session meta. Main's
  // 5s TTL cache makes rapid re-fetches cheap, so we don't need to
  // throttle here. First fetch fires on mount so the `@` popover
  // has data available before the user even types.
  useEffect(() => {
    if (streaming) return
    let cancelled = false
    window.chatApi
      .listFileSuggestions()
      .then((result) => {
        if (cancelled) return
        if (result.truncated) {
          console.warn(
            `[Composer] file list truncated to ${result.files.length} entries — large project`
          )
        }
        setFiles(result.files)
      })
      .catch((err) => {
        console.error('[Composer] listFileSuggestions failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [streaming])

  // Build the adapters from the latest data. Memoized so the popover
  // primitives don't recreate their internal state on every render.
  const slashAdapter = useMemo(
    () => buildSlashAdapter(sessionMeta),
    [sessionMeta]
  )
  const fileAdapter = useMemo(() => buildFileMentionAdapter(files), [files])

  // ── Attachment "+" button: any file, images OR path-only files ──────
  // The native ComposerPrimitive.AddAttachment hard-wires the adapter's
  // accept ('image/*' on the old image-only adapter) and only opens a
  // file picker filtered to that. We replace it with our own hidden
  // <input> (no accept filter) so the user can pick ANY file, and route
  // every pick through the same runtime.addAttachment the unified
  // fileAttachmentAdapter consumes (see fileAttachmentAdapter.ts):
  //
  //   - image/*  → resized + base64-encoded → inline thumbnail chip →
  //     sent to the model as a vision block.
  //   - any other file → resolved to its on-disk absolute path → shown
  //     above the input as a chip carrying the FILE NAME (not a
  //     thumbnail) → on send, the path (not the bytes) is appended to
  //     the prompt as an `@"path"` mention so fusion-code's
  //     extractAtMentionedFiles reads the file itself.
  //
  // Both kinds therefore appear in the SAME attachments row above the
  // composer, exactly like pasted/dropped images already do.
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleFilesPicked = useCallback(
    async (fileList: FileList | null): Promise<void> => {
      if (!fileList || fileList.length === 0) return
      const picked = Array.from(fileList)
      await Promise.all(
        picked.map((file) =>
          composerRuntime.addAttachment(file).catch((err) => {
            console.error('[Composer] addAttachment failed', err)
          })
        )
      )
      // Reset the input so re-picking the same file fires `change` again.
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [composerRuntime]
  )

  return (
    <div className="mx-auto w-full max-w-4xl">
      {/* Two-row composer (per docs/ui-prototype-composer.html): a large
          multi-line input on top, then a dedicated toolbar row below. The
          PermissionModePicker moved OUT of a strip above the card and INTO
          the toolbar's right cluster (it sits where the prototype's "Auto"
          pill is). All assistant-ui wiring is preserved — only the layout
          (rows/positions/classNames) changed.

          The slash/mention popovers are driven by the ProseMirror
          suggestion plugin inside ProseMirrorComposerInput; only the
          assistant-ui pieces that read the composer *store*
          (AttachmentDropzone / Attachments / Send / Cancel / Dictation)
          remain. */}
      <div className="relative">
        {/* AttachmentDropzone is the outer "card" — owns the border +
            background + rounded corners so drag-over highlights the
            whole composer. Bigger radius to match the prototype. */}
        <ComposerPrimitive.AttachmentDropzone className="rounded-[22px] bg-popover/95 ring-1 ring-black/[0.08] backdrop-blur-xl backdrop-saturate-150 transition-all focus-within:ring-[hsl(var(--accent)/0.35)] shadow-[0_8px_30px_-10px_rgba(0,0,0,0.12),0_1px_3px_-1px_rgba(0,0,0,0.06)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-[hsl(var(--accent)/0.5)] data-[dragging=true]:bg-accent/[0.08] dark:ring-white/[0.08]">
          {/* Attachment preview row (pasted / dropped / picked). */}
          <div className="flex flex-wrap gap-2 px-4 pt-3 empty:hidden">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => (
                <ComposerAttachmentChip attachment={attachment} />
              )}
            </ComposerPrimitive.Attachments>
          </div>

          {/* ComposerPrimitive.Root is the composer form context. We lay it
              out as a column: input row on top, toolbar row beneath. */}
          <ComposerPrimitive.Root className="flex w-full flex-col">
            {/* Hidden file input — shared by the toolbar "+" button. Kept
                here (inside Root) so it lives in the form context. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => {
                void handleFilesPicked(e.target.files)
              }}
            />

            {isDictating ? (
              // Dictation takes over the whole composer body (input + mic +
              // send slot) — same as before, just hosted in the column.
              <div className="flex items-end gap-2 px-3 py-2">
                <DictationActiveControls
                  cancelLabel={t('composerCancelDictation')}
                  confirmLabel={t('composerConfirmDictation')}
                />
              </div>
            ) : (
              <>
                {/* —— Top row: the multi-line input —— */}
                <div className="min-h-[52px] max-h-52 overflow-y-auto px-5 pb-1 pt-4 text-[15px] leading-relaxed">
                  <ProseMirrorComposerInput
                    placeholder={t('composerPlaceholder')}
                    slashAdapter={slashAdapter}
                    mentionAdapter={fileAdapter}
                    onSubmit={() => {
                      markIfSlides()
                      composerRuntime.send()
                    }}
                  />
                </div>

                {/* —— Bottom row: toolbar —— */}
                <div className="flex items-center gap-2 px-3 pb-3 pt-1">
                  {/* Left: attachment "+". We do NOT use
                      ComposerPrimitive.AddAttachment (it hard-wires
                      accept='image/*'); the hidden input above accepts any
                      file and routes images vs. other files via
                      handleFilesPicked. */}
                  <button
                    type="button"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 ring-1 ring-black/[0.06] transition-colors hover:bg-foreground/[0.06] hover:text-foreground dark:ring-white/[0.08]"
                    aria-label={t('composerAttachFile')}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>

                  {/* Composer mode picker (通用 / 设计 / 幻灯片 / 写作). The
                      幻灯片 option is the slides entry point: choosing it sets
                      mode='slides', and sending then marks the session as a
                      slides session → ThreadView's two-pane layout. Replaces
                      the old single monitor-icon slides toggle. */}
                  <ComposerModePicker />

                  {/* Spacer pushes the rest to the right edge. */}
                  <div className="flex-1" />

                  {/* Right cluster: permission mode (prototype "Auto"
                      slot) · mic · send. */}
                  <PermissionModePicker />
                  <MicButton label={t('composerDictate')} />
                  {/* Mutually exclusive Send / Stop slot. */}
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send
                      aria-label="Send message"
                      onClick={markIfSlides}
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_8px_-2px_rgba(0,0,0,0.18)] transition-all hover:brightness-[1.12] active:scale-95 disabled:cursor-not-allowed disabled:bg-foreground/[0.08] disabled:text-muted-foreground/50 disabled:shadow-none"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 19V5" />
                        <path d="m6 11 6-6 6 6" />
                      </svg>
                    </ComposerPrimitive.Send>
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running>
                    <ComposerPrimitive.Cancel
                      aria-label="Stop generating"
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_8px_-2px_rgba(0,0,0,0.15)] transition-all hover:brightness-[1.1] active:scale-95"
                    >
                      <span className="block size-2.5 rounded-[2px] bg-card" />
                    </ComposerPrimitive.Cancel>
                  </ThreadPrimitive.If>
                </div>
              </>
            )}
          </ComposerPrimitive.Root>
        </ComposerPrimitive.AttachmentDropzone>

        {/* Below-card chips (figure 18): 选择工作目录 · 语气 创意. Like the
            decor cluster above, these are VISUAL-ONLY placeholders for now —
            no backing feature on the desktop side. They sit just under the
            card, matching the mockup. */}
        <div className="mt-3 flex items-center gap-4 px-2">
          <ComposerBelowChip
            label="选择工作目录"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            }
          />
          <ComposerBelowChip
            label="语气 创意"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
                <path d="m12 3 2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
              </svg>
            }
          />
        </div>
      </div>
    </div>
  )
}

/** Composer mode metadata for the picker (通用 / 设计 / 幻灯片 / 写作). */
interface ComposerModeMeta {
  id: ComposerModeId
  label: string
  beta?: boolean
  icon: React.ReactNode
}

const COMPOSER_MODES: readonly ComposerModeMeta[] = [
  {
    id: 'general',
    label: '通用',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5v-3.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z" />
      </svg>
    )
  },
  {
    id: 'design',
    label: '设计',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M4 9h16M9 9v11" />
      </svg>
    )
  },
  {
    id: 'slides',
    label: '幻灯片',
    beta: true,
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4.5" width="18" height="12" rx="2" />
        <path d="M8 20.5h8M12 16.5v4" />
      </svg>
    )
  },
  {
    id: 'writing',
    label: '写作',
    beta: true,
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M16.5 3.5 20.5 7.5 8 20 3.5 20.5 4 16z" />
        <path d="M14 6 18 10" />
      </svg>
    )
  }
]

/**
 * Composer mode picker in the toolbar — a pill showing the current mode
 * (icon + label, e.g.「通用」) that opens a popover to switch between
 * 通用 / 设计 / 幻灯片 / 写作. Replaces the old single monitor-icon slides
 * toggle: the popover's 幻灯片 row is now the slides entry point (picking it
 * sets mode='slides'; sending then marks the session as a slides session via
 * markIfSlides → ThreadView's two-pane layout).
 *
 * Reuses PermissionModePicker's interaction shape: upward popover (the
 * composer sits at the window bottom), click-outside + Esc to close, motion
 * fade, a check on the selected row. 幻灯片 / 写作 carry a blue "Beta" tag.
 */
function ComposerModePicker(): React.JSX.Element {
  const mode = useComposerModeStore((s) => s.mode)
  const setMode = useComposerModeStore((s) => s.setMode)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const current =
    COMPOSER_MODES.find((m) => m.id === mode) ?? COMPOSER_MODES[0]!

  useEffect(() => {
    if (!open) return
    // Hold an "overlay open" count while this popover is up so the composer's
    // blur strip hides (its backdrop-blur otherwise slices across the menu).
    // +1 on open, -1 in cleanup → balanced (open→false runs the cleanup, then
    // the early return skips re-incrementing).
    const overlay = useComposerOverlayStore.getState()
    overlay.setOpen(true)
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      overlay.setOpen(false)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (next: ComposerModeId): void => {
    setMode(next)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="对话模式"
        className={
          'group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12.5px] transition-colors ' +
          'border-border/70 bg-card/70 text-muted-foreground hover:border-accent/50 hover:bg-card hover:text-foreground ' +
          (open ? ' border-accent/60 text-foreground' : '')
        }
      >
        <span className="flex shrink-0 items-center">{current.icon}</span>
        <span className="leading-none">{current.label}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={'opacity-60 transition-transform ' + (open ? 'rotate-180' : '')}
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className="absolute bottom-full left-0 z-40 mb-1.5 w-56 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
            role="listbox"
          >
            {COMPOSER_MODES.map((meta) => {
              const selected = meta.id === mode
              return (
                <button
                  key={meta.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(meta.id)}
                  className={
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ' +
                    (selected
                      ? 'bg-accent/15 text-foreground'
                      : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground')
                  }
                >
                  <span className="flex shrink-0 items-center">{meta.icon}</span>
                  <span className="font-medium">{meta.label}</span>
                  {meta.beta ? (
                    <span className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-sky-500">
                      Beta
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  {selected ? (
                    <svg
                      width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      className="shrink-0 text-accent"
                      aria-hidden
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * A below-card placeholder chip (选择工作目录 / 语气 创意 in figure 18).
 * VISUAL-ONLY for now.
 */
function ComposerBelowChip({
  label,
  icon
}: {
  label: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70"
      aria-hidden="true"
    >
      {icon}
      {label}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground/40">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  )
}

/**
 * Highlight layer that sits *behind* the composer textarea and renders
 * the same text — but with slash commands (`/skill`) and file mentions
 * (`@src/index.ts`) swapped out for proper pill chips with an icon and
 * real horizontal padding.
 *
 * Alignment strategy
 * ------------------
 * Giving chips real width means overlay characters no longer sit on
 * top of the textarea's character columns, so the native caret would
 * drift off-screen from the visible text. We solve that by:
 *
 *   1. Painting the textarea's text transparent AND hiding its caret
 *      (`caret-color: transparent`).
 *   2. Tracking `selectionStart` via `onSelect` and passing it to this
 *      overlay as `caretPos`.
 *   3. Rendering our own blinking caret element at the right slot in
 *      the token stream — inserted *between* token spans so it
 *      inherits the overlay's actual layout (chip widths included).
 *
 * Because the caret is painted in the overlay's flow, it automatically
 * follows chips, line wraps, and padding without any pixel math.
 *
 * Snap-out behavior for chip interiors
 * ------------------------------------
 * If the user clicks mid-chip the composer's onSelect handler snaps
 * `selectionStart` to the closer chip edge before it reaches this
 * component, so we can treat chips as atomic: the caret never paints
 * inside a chip.
 */

/**
 * Mic button shown in the normal (non-dictating) composer row.
 *
 * `startDictation` is deferred to a microtask so the click event
 * finishes propagating BEFORE the state change happens. Without the
 * defer, React synchronously re-renders during the click, the
 * composer row swaps Normal → Dictation mid-click, and whatever
 * element lands at the old mic position can receive a secondary
 * click — exactly the race that kept auto-cancelling the session
 * before. `queueMicrotask` is bulletproof because JS's event loop
 * guarantees microtasks run only after the current sync task
 * (which includes the full click dispatch) is done.
 */
function MicButton({ label }: { label: string }): React.JSX.Element {
  const runtime = useComposerRuntime()
  const onClick = useCallback(() => {
    queueMicrotask(() => {
      runtime.startDictation()
    })
  }, [runtime])
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v4" />
        <path d="M8 22h8" />
      </svg>
    </button>
  )
}

/**
 * Dictation-mode row content — live waveform filling the input slot
 * plus a cancel (X) and a confirm (✓) button on the right.
 *
 * Lifecycle:
 *  - This component mounts the instant dictation starts. On mount,
 *    it snapshots the composer text via `useRef` so that cancelling
 *    can revert to the pre-dictation state. (The first render is
 *    always at dictation start, so `composer.text` at mount == the
 *    original user text before any chunk commit.)
 *  - Confirm (✓): stops the session. Any chunks already transcribed
 *    stay in the composer text, and when this component unmounts
 *    the Normal row's textarea rematerializes populated.
 *  - Cancel (X): stops the session, then resets composer text to
 *    the snapshot. Drops any committed chunks.
 *
 * Both actions defer their runtime calls to `queueMicrotask` so the
 * click event finishes propagating before React's dictation-state
 * change tears down this row — exactly the same defense the mic
 * button uses.
 */
function DictationActiveControls({
  cancelLabel,
  confirmLabel
}: {
  cancelLabel: string
  confirmLabel: string
}): React.JSX.Element {
  const runtime = useComposerRuntime()
  // Latched "finishing" state — flips on the first X / ✓ click and
  // stays on until this component unmounts (which happens once
  // stopDictation resolves). While finishing, both buttons render
  // as disabled so a second click can't queue a duplicate
  // stopDictation call (the adapter guards that as well, but the
  // visual feedback stops users from mashing the button during the
  // 1-3s transcribe wait).
  const [isFinishing, setIsFinishing] = useState(false)

  const onCancel = useCallback(() => {
    if (isFinishing) return
    setIsFinishing(true)
    // True cancel — bypass `runtime.stopDictation()` because that
    // path always flushes the tail audio through Gemini and commits
    // the transcript into the composer. We want to throw away the
    // recorded audio without touching the textarea.
    //
    // `cancelActiveDictation()` calls `session.cancel()` on the
    // adapter, which tears down immediately with no transcribe. The
    // composer runtime's internal 100ms status poll will notice
    // `session.status === 'ended'` a few frames later and fire
    // `_cleanupDictation`, which drops the `composer.dictation` flag
    // — at which point this component unmounts and the normal
    // textarea row rematerializes showing the pre-dictation text
    // unchanged. No setText needed because this single-shot adapter
    // never commits anything until `stop()`, so `_text` is still
    // whatever it was when startDictation ran.
    queueMicrotask(() => {
      cancelActiveDictation()
    })
  }, [isFinishing])

  const onConfirm = useCallback(() => {
    if (isFinishing) return
    setIsFinishing(true)
    queueMicrotask(() => {
      runtime.stopDictation()
    })
  }, [isFinishing, runtime])

  return (
    <>
      <div className="flex min-h-[24px] max-h-40 flex-1 items-center overflow-hidden">
        <DictationWaveform />
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={isFinishing}
        aria-label={cancelLabel}
        title={cancelLabel}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isFinishing}
        aria-label={confirmLabel}
        title={confirmLabel}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition hover:bg-foreground/90 disabled:cursor-wait"
      >
        {isFinishing ? (
          // Inline spinner while we wait for the tail transcribe to
          // land. Same animation Composer's attachments use
          // elsewhere — one stroke rotating around a dim ring.
          <svg
            className="size-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeOpacity="0.3"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </button>
    </>
  )
}

/* ───────────── Composer attachment chip ────────────────────── */

/**
 * Single attachment chip in the composer's attachment row.
 *
 * Renders a thumbnail for image attachments plus a filename label and
 * a remove button. The thumbnail is read via `FileReader.readAsDataURL`
 * (not `URL.createObjectURL`) because:
 *
 *   1. **StrictMode safety** — useMemo + createObjectURL + useEffect
 *      cleanup is inherently racy (the mount→unmount→mount cycle of
 *      dev-mode re-invocation can revoke the URL before the second
 *      mount uses it, even though the memoized string is reused).
 *
 *   2. **Electron wire semantics** — in Electron 33, a File dropped
 *      from an external app (Finder, CleanShot, Preview) can carry
 *      a lazily-materialized blob body. blob: URLs sometimes fail to
 *      decode in that scenario, giving the `<img>` a broken-image
 *      icon even though `file.size` and `file.type` look correct.
 *      FileReader reads through to the underlying bytes synchronously
 *      and always produces a valid data URL.
 *
 *   3. **Symmetry with send()** — the adapter's send() path also
 *      reads to data URL, so the chip preview now matches what the
 *      model will actually receive. No chance of "chip shows X,
 *      model gets Y".
 *
 * The data URL is held in component state and cleared on unmount.
 * Unlike blob URLs there's nothing to revoke — data URLs are plain
 * strings and are garbage-collected with the component.
 *
 * Layout: a compact pill with the thumb on the left, name truncated
 * in the middle, and a floating ×-button in the top-right corner that
 * calls through to the adapter's remove() via AttachmentPrimitive.Remove.
 */
function ComposerAttachmentChip({
  attachment
}: {
  attachment: Attachment
}): React.JSX.Element {
  // Pending attachments carry a `file` field we can preview from.
  // Complete attachments (briefly, between send() finishing and
  // onNew firing) also retain the file field. Guard on file presence
  // and type — non-image attachments render as a generic chip.
  const file =
    'file' in attachment && attachment.file instanceof File
      ? attachment.file
      : null

  const isImage = attachment.type === 'image'

  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    // Only images get a thumbnail preview. Reading a non-image file
    // (which could be hundreds of MB) into a data URL would waste
    // memory for a preview we never render — the file chip shows the
    // name + a generic glyph instead.
    if (!file || !isImage) {
      setPreviewURL(null)
      setPreviewError(null)
      return
    }

    let cancelled = false
    const reader = new FileReader()
    reader.onload = () => {
      if (cancelled) return
      if (typeof reader.result === 'string') {
        setPreviewURL(reader.result)
      } else {
        setPreviewError('FileReader returned non-string')
      }
    }
    reader.onerror = () => {
      if (cancelled) return
      setPreviewError(reader.error?.message ?? 'FileReader error')
    }
    reader.readAsDataURL(file)

    return () => {
      cancelled = true
      // FileReader.abort() is safe even if the read already completed.
      try {
        reader.abort()
      } catch {
        // abort can throw DOMException if already done — ignore
      }
    }
  }, [file, isImage])

  return (
    <AttachmentPrimitive.Root className="group/att relative flex items-center gap-2 rounded-lg border border-border bg-card/60 p-1.5 pr-6">
      {isImage && previewURL ? (
        <img
          src={previewURL}
          alt=""
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground/80"
          title={previewError ?? undefined}
        >
          {previewError ? (
            <span className="text-[10px] font-mono">!</span>
          ) : (
            // Per-type file glyph for non-image attachments. The file
            // name is shown to the right; the icon signals the file kind
            // (PDF / Word / code / …) without previewing unknown bytes.
            <FileTypeIcon pathOrName={attachment.name} size={22} />
          )}
        </div>
      )}
      <span className="max-w-[140px] truncate text-[11px] text-foreground/80">
        {attachment.name}
      </span>
      <AttachmentPrimitive.Remove
        className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-muted text-[10px] leading-none text-muted-foreground opacity-0 transition group-hover/att:opacity-100 hover:bg-secondary hover:text-foreground"
        aria-label="Remove attachment"
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}
