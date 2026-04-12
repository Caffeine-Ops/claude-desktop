import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  useAuiState
} from '@assistant-ui/react'
import type { Attachment, Unstable_TriggerItem } from '@assistant-ui/core'
import { motion } from 'motion/react'

import type { SessionMeta } from '../../../../shared/types'
import { useChatStore } from '../../stores/chat'
import { buildSlashAdapter, slashFormatter } from '../../composer/slashAdapter'
import {
  buildFileMentionAdapter,
  mentionFormatter
} from '../../composer/fileMentionAdapter'
import { ThinkingSpinner } from './ThinkingSpinner'
import { AssistantMarkdown } from './AssistantMarkdown'

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
export function ThreadView(): React.JSX.Element {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 w-full flex-1 flex-col bg-transparent">
      {/* Scrollable message area. min-h-0 + flex-1 is the canonical
          flexbox pattern that lets the viewport shrink correctly inside
          another flex column. */}
      <ThreadPrimitive.Viewport
        autoScroll
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {/* Inner column caps reading width and centers messages. The
            `min-h-full` lets the empty-state `flex-1` stretch so the
            hero text lands at the vertical center of the viewport even
            when there are no messages yet. */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-8 pt-8">
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

      {/* Composer dock — outside the scroll viewport so it's always
          pinned to the bottom of Root regardless of message count. */}
      <div className="shrink-0 border-t border-zinc-800/70 bg-[#0b0b0d]/95 px-6 py-4 backdrop-blur">
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  )
}

/* ───────────────────────── EmptyState ───────────────────────── */

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="mb-3 text-[28px] font-semibold text-zinc-100">
        Fusion Code Desktop
      </div>
      <p className="max-w-md text-sm text-zinc-500">
        Ask anything. Try{' '}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[12.5px] font-mono text-zinc-300">
          查看我电脑桌面有哪些文件夹
        </code>{' '}
        or{' '}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[12.5px] font-mono text-zinc-300">
          /help
        </code>
        .
      </p>
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
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-blue-600/90 px-4 py-2.5 text-[14px] leading-relaxed text-white empty:hidden">
        <MessagePrimitive.Parts
          unstable_showEmptyOnNonTextEnd={false}
          components={{
            // Within the bubble, skip image parts — they're already
            // rendered above. We provide a no-op Image component so
            // nothing appears here, and let Text render normally via
            // the default (string passthrough).
            Image: () => null
          }}
        />
      </div>
    </MessagePrimitive.Root>
  )
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
  const [open, setOpen] = useState(false)

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
        className="inline-block max-w-[80%] cursor-zoom-in overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/70 transition hover:border-zinc-500"
        title={filename ?? 'Attached image'}
      >
        <img
          src={image}
          alt={filename ?? 'Attached image'}
          className="max-h-[220px] max-w-full object-cover"
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={filename ?? 'Image preview'}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
        >
          <img
            src={image}
            alt={filename ?? 'Attached image'}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full cursor-zoom-out rounded-lg shadow-2xl"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close preview"
            className="fixed right-5 top-5 flex size-9 items-center justify-center rounded-full bg-zinc-900/80 text-zinc-200 backdrop-blur transition hover:bg-zinc-800"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
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
      <MessagePrimitive.Parts
        components={{
          Text: AssistantTextRow,
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
    </MessagePrimitive.Root>
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
        className="mt-[8px] block size-[6px] shrink-0 rounded-full bg-zinc-300"
      />
      <div className="min-w-0 flex-1">
        <AssistantMarkdown text={text} />
      </div>
    </div>
  )
}

/* ───────────────────── System message ──────────────────────── */

function SystemMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-4 flex w-full justify-center">
      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-[11.5px] italic text-zinc-500">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
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
  const { toolName, args, argsText, result, status } = props
  const running = status?.type === 'running' || status?.type === 'requires-action'

  // Input-pane display logic
  // ------------------------
  // While the tool input is still streaming (`argsText` is a half-open
  // JSON fragment), show the raw text with a blinking caret at the end
  // so the user sees the model "typing" the call. Once the block
  // finalizes and `args` is a real object, pretty-print it.
  //
  // Fallback order:
  //   1. running + argsText present → raw argsText + caret
  //   2. running + no argsText yet  → "…" placeholder
  //   3. complete                    → JSON.stringify(args, null, 2)
  //   4. complete + args parse fail  → argsText verbatim
  //
  // This mirrors how assistant-ui's own tools.Fallback passes both
  // fields through the `ToolFallbackProps` — we just chose to render
  // them ourselves so we can tune the streaming presentation.
  const hasArgsText = typeof argsText === 'string' && argsText.length > 0
  const inputBody = running
    ? hasArgsText
      ? argsText
      : '…'
    : safeStringify(args !== undefined ? args : argsText)

  return (
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className={
          'mt-[3px] shrink-0 select-none font-mono text-[13px] leading-relaxed ' +
          (running ? 'text-amber-400' : 'text-zinc-600')
        }
      >
        ⎿
      </span>
      <div className="min-w-0 flex-1">
        <details open={running} className="group/tool">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
            <span
              aria-hidden
              className={
                running
                  ? 'inline-block size-1.5 animate-pulse rounded-full bg-amber-400'
                  : 'inline-block size-1.5 rounded-full bg-emerald-500'
              }
            />
            <span className="font-mono font-medium text-zinc-200">{toolName}</span>
            <span className="font-mono text-[11.5px] text-zinc-500">
              {running ? 'running…' : 'done'}
            </span>
            <span
              aria-hidden
              className="ml-1 font-mono text-[10.5px] text-zinc-600 transition group-open/tool:rotate-90"
            >
              ▸
            </span>
          </summary>
          <div className="mt-2 space-y-2 border-l border-zinc-800 pl-3 text-[12px]">
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                Input
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-zinc-300">
                {inputBody}
                {running && hasArgsText && (
                  <span
                    aria-hidden
                    className="ml-0.5 inline-block h-[1em] w-[0.5ch] animate-pulse bg-amber-400 align-[-0.1em]"
                  />
                )}
              </pre>
            </div>
            {result !== undefined && (
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  Output
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-zinc-300">
                  {safeStringify(result)}
                </pre>
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

function safeStringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [files, setFiles] = useState<readonly string[]>([])
  const streaming = useChatStore((s) => s.streaming)
  // Caret tracking for the fake overlay cursor. The native textarea
  // caret is hidden via `caret-color: transparent` in the className
  // below, because once we let chips have real visual width the
  // native caret drifts off the apparent character positions. We
  // track `selectionStart` + focus state here and let the overlay
  // render its own blinking caret at the correct visual slot.
  const [caretPos, setCaretPos] = useState(0)
  const [isFocused, setIsFocused] = useState(false)

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

  // Shared snapshots of each TriggerPopoverRoot's latest React-rendered
  // context. We use these from a custom onKeyDown on ComposerPrimitive.Input
  // to work around a subtle stale-closure bug in assistant-ui's
  // `tapEffectEvent`: its handler is registered into the ComposerInput
  // plugin registry but captures the *previous-frame* `highlightedIndex`,
  // so pressing Enter right after an ArrowDown inserts the wrong slash /
  // mention item (click works fine because click passes the item object
  // directly). By handling Enter ourselves with live React state and
  // calling `e.preventDefault()`, we skip the library's buggy handler.
  const slashCtxRef = useRef<TriggerCtxSnapshot | null>(null)
  const mentionCtxRef = useRef<TriggerCtxSnapshot | null>(null)
  // Keep a handle to the actual textarea so we can reposition the DOM
  // cursor after a popover selection (see `advanceCursorToEnd`).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * After `selectItem` inserts a directive, assistant-ui rewrites the
   * composer text but does *not* advance its internal `cursorPosition`
   * state. Because `detectTrigger` re-runs on every state change, the
   * leftover cursor (still mid-`/sim`) sees the freshly-inserted `/skill`
   * and happily reports a new trigger — so the popover stays open and
   * even re-filters against "ski". The visible symptom is: "I clicked
   * /skill, the text now says /skill, but the popover is still there".
   *
   * Fix: move the actual textarea caret to end-of-text and fire a native
   * `select` event so the library's `onSelect` hook picks up the new
   * position, updates `cursorPosition`, and `trigger` drops to null —
   * closing the popover cleanly. Works for both keyboard (Enter) and
   * mouse (click) selection paths.
   */
  const advanceCursorToEnd = (): void => {
    const el = textareaRef.current
    if (!el) return
    const end = el.value.length
    // Re-focus first — click selection lands focus on the popover
    // button, so without this the user would have to click back into
    // the textarea before they could keep typing arguments.
    el.focus({ preventScroll: true })
    el.setSelectionRange(end, end)
    el.dispatchEvent(new Event('select', { bubbles: true }))
  }

  const handleComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // --- 1. Enter-to-select (popover insertion) -----------------------
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Prefer whichever popover is currently open. Only one can be
      // open at a time because `/` and `@` detect mutually exclusive
      // triggers.
      const snap = slashCtxRef.current?.open
        ? slashCtxRef.current
        : mentionCtxRef.current?.open
          ? mentionCtxRef.current
          : null
      if (!snap) return
      const item = snap.items[snap.highlightedIndex]
      if (!item) return
      e.preventDefault()
      snap.selectItem(item)
      requestAnimationFrame(advanceCursorToEnd)
      return
    }

    // --- 2. Atomic token deletion (Backspace / Delete) ---------------
    //
    // Even though the underlying input is a plain textarea, we make
    // slash commands and @mentions *feel* atomic: one Backspace at the
    // end of `/skill-creator` deletes the whole token (not just the
    // last `r`). Symmetrically, Delete at the start of a token wipes
    // the whole token forward. The visible chip in the overlay then
    // vanishes in one step, matching the user's mental model of a
    // single "tag" pill.
    //
    // We skip this path when there's a live text selection (let the
    // browser handle range delete normally) or when any modifier is
    // held (Option-Backspace deletes a word, Cmd-Backspace deletes
    // the line — both are fine as-is).
    const isAtomicDeleteKey = e.key === 'Backspace' || e.key === 'Delete'
    if (
      isAtomicDeleteKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      const el = e.currentTarget
      if (el.selectionStart !== el.selectionEnd) return
      const cursor = el.selectionStart ?? 0
      const text = el.value
      const hit =
        e.key === 'Backspace'
          ? findAtomicTokenEndingAt(text, cursor)
          : findAtomicTokenStartingAt(text, cursor)
      if (!hit) return
      e.preventDefault()
      const newText = text.slice(0, hit.start) + text.slice(hit.end)
      // Use the native value setter + synthetic input event so React's
      // controlled textarea picks up the change and flows it into
      // `aui.composer().setText(...)` via its onChange plugin — exactly
      // as if the user had typed the edit themselves. Assigning
      // `el.value = ...` directly would be overwritten on the next
      // React render.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set
      setter?.call(el, newText)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      // Place the caret where the token used to start and let the
      // library's onSelect hook sync its internal cursorPosition.
      el.setSelectionRange(hit.start, hit.start)
      el.dispatchEvent(new Event('select', { bubbles: true }))
      return
    }
  }

  // Click-path wrapper: the library's own click handler already calls
  // `selectItem` synchronously, so all we need is to close the popover
  // after the text-replacement commits. Passed down to TriggerPopoverList
  // as the onItemClick hook.
  const handleTriggerItemClick = (): void => {
    requestAnimationFrame(advanceCursorToEnd)
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Outer root: `/` slash commands. Its popover JSX lives
          *between* the two roots so `useTriggerPopoverContext()`
          inside SlashPopoverList resolves to this root. */}
      <ComposerPrimitive.Unstable_TriggerPopoverRoot
        trigger="/"
        adapter={slashAdapter}
        onSelect={{ type: 'insertDirective', formatter: slashFormatter }}
      >
        {/* Mirror the slash root's latest React context into our ref
            so handleTriggerEnter can read a fresh snapshot — see the
            stale-closure note near the ref declaration above. */}
        <TriggerCtxSync targetRef={slashCtxRef} />
        <div className="relative">
          {/* Slash popover — reads the outer root's context because
              it sits outside the inner `@` root in the tree. */}
          <ComposerPrimitive.Unstable_TriggerPopoverPopover className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-zinc-800 bg-[#0e0e11] py-1 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
            <ComposerPrimitive.Unstable_TriggerPopoverItems>
              {(items) => (
                <TriggerPopoverList
                  items={items}
                  emptyText="No matching commands"
                  onItemClick={handleTriggerItemClick}
                />
              )}
            </ComposerPrimitive.Unstable_TriggerPopoverItems>
          </ComposerPrimitive.Unstable_TriggerPopoverPopover>

          {/* Inner root: `@` file mentions. Nesting is intentional —
              both roots wrap the same ComposerPrimitive.Input below,
              and the multi-trigger support is documented on
              Unstable_TriggerPopoverRoot ("Multiple trigger roots
              can coexist around the same input."). */}
          <ComposerPrimitive.Unstable_TriggerPopoverRoot
            trigger="@"
            adapter={fileAdapter}
            onSelect={{ type: 'insertDirective', formatter: mentionFormatter }}
          >
            {/* Mirror the mention root's latest React context into its
                ref — twin of the slash <TriggerCtxSync> above. */}
            <TriggerCtxSync targetRef={mentionCtxRef} />
            {/* File popover — nested inside the inner root, so
                useTriggerPopoverContext() resolves to the `@` root.
                Absolute-positioned inside the same `relative` div
                as the slash popover, but only one can be open at
                a time so they never overlap visually. */}
            <ComposerPrimitive.Unstable_TriggerPopoverPopover className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-zinc-800 bg-[#0e0e11] py-1 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
              <ComposerPrimitive.Unstable_TriggerPopoverItems>
                {(items) => (
                  <TriggerPopoverList
                    items={items}
                    emptyText={
                      files.length === 0
                        ? 'Loading files…'
                        : 'No matching files'
                    }
                    onItemClick={handleTriggerItemClick}
                  />
                )}
              </ComposerPrimitive.Unstable_TriggerPopoverItems>
            </ComposerPrimitive.Unstable_TriggerPopoverPopover>

            {/* AttachmentDropzone is the outer "card" — it owns the
                border + background + rounded corners so drag-over can
                highlight the whole composer in one shot (not just the
                form). The primitive sets `data-dragging="true"` on
                its root div while files are being dragged over, which
                we style with Tailwind's `data-[dragging=true]:` modifier.
                Pasting images is handled by ComposerPrimitive.Input's
                built-in `addAttachmentOnPaste` (default true) and does
                NOT need the dropzone — the two mechanisms coexist. */}
            <ComposerPrimitive.AttachmentDropzone className="rounded-2xl border border-zinc-800 bg-zinc-900/80 shadow-lg transition-colors focus-within:border-zinc-700 data-[dragging=true]:border-blue-500 data-[dragging=true]:bg-blue-950/20">
              {/* Attachment chip row. assistant-ui's Attachments
                  primitive is fragment-shaped — it just fans out one
                  render-prop call per attachment without a container,
                  so we wrap it in a flex row here. `empty:hidden`
                  collapses the padding when no attachments exist:
                  React renders zero DOM nodes for an empty Attachments
                  list, which matches the :empty CSS pseudo-class (JSX
                  whitespace doesn't produce text nodes). */}
              <div className="flex flex-wrap gap-2 px-3 pt-3 empty:hidden">
                <ComposerPrimitive.Attachments>
                  {({ attachment }) => (
                    <ComposerAttachmentChip attachment={attachment} />
                  )}
                </ComposerPrimitive.Attachments>
              </div>

              <ComposerPrimitive.Root className="flex w-full items-end gap-2 px-3 py-2">
                {/* "+" button: opens the OS file picker filtered by
                    the adapter's `accept: "image/*"`. Sits flush with
                    the Input on the left; styled to match Send/Cancel
                    so the row reads as four evenly-sized circles. */}
                <ComposerPrimitive.AddAttachment
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-200"
                  aria-label="Attach image"
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
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </ComposerPrimitive.AddAttachment>
                {/* Highlight overlay wrapper. The overlay div renders
                    the same text content but with slash / mention
                    tokens wrapped in styled spans, while the textarea
                    on top has transparent text (caret still visible
                    via `caret-zinc-100`) so the overlay's highlights
                    read as "inline chips" to the user.
                    Both elements share identical typography and
                    padding so characters line up pixel-perfect. The
                    overlay uses `box-shadow` for chip borders instead
                    of `padding` to avoid shifting text positions. */}
                <div className="relative min-h-[24px] max-h-40 flex-1 overflow-hidden">
                  <ComposerHighlightOverlay
                    caretPos={caretPos}
                    isFocused={isFocused}
                  />
                  <ComposerPrimitive.Input
                    ref={textareaRef}
                    placeholder="Ask anything…   ↵ send · ⇧↵ newline · / commands · @ files"
                    rows={1}
                    onKeyDown={handleComposerKey}
                    onFocus={(e) => {
                      setIsFocused(true)
                      // Sync caret state on focus so re-entering the
                      // composer shows the caret at the actual DOM
                      // selection, not a stale zero position.
                      setCaretPos(e.currentTarget.selectionStart ?? 0)
                    }}
                    onBlur={() => setIsFocused(false)}
                    onSelect={(e) => {
                      const el = e.currentTarget
                      let start = el.selectionStart ?? 0
                      const end = el.selectionEnd ?? start
                      // Collapse-to-boundary: when the user's cursor
                      // lands strictly *inside* a slash/mention token
                      // (click, arrow, or programmatic), snap it to
                      // the closer chip edge so chips feel atomic.
                      // Only applies to collapsed selections — a
                      // drag-select over a chip stays as-is.
                      if (start === end) {
                        const hit = findAtomicTokenContaining(el.value, start)
                        if (hit) {
                          const snap =
                            start - hit.start < hit.end - start
                              ? hit.start
                              : hit.end
                          if (snap !== start) {
                            start = snap
                            el.setSelectionRange(snap, snap)
                          }
                        }
                      }
                      setCaretPos(start)
                    }}
                    className="relative z-[1] block min-h-[24px] max-h-40 w-full resize-none bg-transparent px-1 py-1.5 text-[14px] leading-relaxed text-transparent placeholder:text-zinc-600 focus:outline-none"
                    style={{ caretColor: 'transparent' }}
                  />
                </div>
                <ComposerPrimitive.Send className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500">
                  ↑
                </ComposerPrimitive.Send>
                <ComposerPrimitive.Cancel className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 transition hover:bg-zinc-700">
                  ■
                </ComposerPrimitive.Cancel>
              </ComposerPrimitive.Root>
            </ComposerPrimitive.AttachmentDropzone>
          </ComposerPrimitive.Unstable_TriggerPopoverRoot>
        </div>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </div>
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
function ComposerHighlightOverlay({
  caretPos,
  isFocused
}: {
  caretPos: number
  isFocused: boolean
}): React.JSX.Element {
  // `composer` is a dynamically-registered client on AssistantState,
  // so the mapped type exported from @assistant-ui/store doesn't
  // surface it statically. Cast through `any` at the selector
  // boundary — the runtime shape is fixed (composer.text is always
  // a string or undefined) and re-checking it here would require
  // pulling in assistant-ui's ClientSchemas.
  const text = useAuiState((s) => ((s as any).composer?.text as string | undefined) ?? '')
  const tokens = useMemo(() => tokenizeComposer(text), [text])

  // Walk tokens once, interleaving a <Caret /> at the position that
  // corresponds to the textarea's `selectionStart`. The caret element
  // is inserted into the same inline flow as tokens so it picks up
  // chip widths, text widths, and wrapping automatically.
  const rendered: React.ReactNode[] = []
  let caretInserted = false
  let offset = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const tokEnd = offset + tok.value.length
    const caretInRange = caretPos >= offset && caretPos < tokEnd

    if (!caretInserted && caretInRange) {
      if (tok.kind === 'text') {
        const split = caretPos - offset
        rendered.push(
          <span key={`t-${i}-a`}>{tok.value.slice(0, split)}</span>
        )
        if (isFocused) rendered.push(<Caret key={`caret-${i}`} />)
        rendered.push(
          <span key={`t-${i}-b`}>{tok.value.slice(split)}</span>
        )
        caretInserted = true
        offset = tokEnd
        continue
      }
      // Chip token: place caret *before* the chip (onSelect's
      // snap-out means we only land here when caretPos === offset).
      if (isFocused) rendered.push(<Caret key={`caret-${i}`} />)
      caretInserted = true
    }

    if (tok.kind === 'slash' || tok.kind === 'mention') {
      rendered.push(
        <Chip key={`chip-${i}`} variant={tok.kind}>
          {tok.value}
        </Chip>
      )
    } else {
      rendered.push(<span key={`t-${i}`}>{tok.value}</span>)
    }
    offset = tokEnd
  }
  // Tail case: cursor at end of full text.
  if (!caretInserted && isFocused && caretPos >= text.length) {
    rendered.push(<Caret key="caret-end" />)
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 whitespace-pre-wrap break-words px-1 py-1.5 text-[14px] leading-relaxed text-zinc-100"
    >
      {rendered}
    </div>
  )
}

/**
 * Blinking fake caret rendered inside the overlay. We use CSS keyframes
 * (`caret-blink` in main.css) so the blink continues smoothly even when
 * React isn't re-rendering.
 *
 * The caret is an `inline-block` zero-width element — it takes up a
 * 1px sliver on the line so it's visible without shifting neighbours.
 * `vertical-align: text-bottom` + `height: 1em` makes it span the
 * ascender/descender zone, matching the native textarea caret height.
 */
function Caret(): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: '1px',
        height: '1em',
        verticalAlign: 'text-bottom',
        background: '#e4e4e7', // zinc-200
        marginInline: '0',
        animation: 'caret-blink 1.1s step-end infinite'
      }}
    />
  )
}

/**
 * Real pill chip for a slash command / file mention. Now that the
 * overlay no longer needs to pixel-align with the textarea (we draw
 * our own caret), chips can use real padding + an inline icon and
 * look just like the reference mock.
 *
 * The leading `/` or `@` is stripped before rendering — the icon
 * stands in for it visually while the raw character still lives in
 * the textarea's text (needed for the library's trigger detection
 * and for atomic backspace to work via `iterAtomicTokens`).
 */
function Chip({
  variant,
  children
}: {
  variant: 'slash' | 'mention'
  children: string
}): React.JSX.Element {
  const palette =
    variant === 'slash'
      ? {
          text: 'rgb(216, 180, 254)', // violet-200
          background: 'rgba(139, 92, 246, 0.18)',
          iconStroke: 'rgb(196, 181, 253)' // violet-300
        }
      : {
          text: 'rgb(167, 243, 208)', // emerald-200
          background: 'rgba(16, 185, 129, 0.18)',
          iconStroke: 'rgb(110, 231, 183)' // emerald-300
        }
  // Strip the leading `/` or `@` — the icon replaces it.
  const label = children.slice(1)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '1px 8px 1px 7px',
        background: palette.background,
        color: palette.text,
        fontWeight: 600,
        borderRadius: '9999px',
        verticalAlign: 'baseline',
        lineHeight: '1.35'
      }}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke={palette.iconStroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        {variant === 'slash' ? (
          <>
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="m3.27 6.96 8.73 5.05 8.73-5.05" />
            <path d="M12 22.08V12" />
          </>
        ) : (
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </>
        )}
      </svg>
      {label}
    </span>
  )
}

type ComposerToken =
  | { kind: 'text'; value: string }
  | { kind: 'slash'; value: string }
  | { kind: 'mention'; value: string }

/**
 * Split composer text into alternating plain / slash / mention runs.
 * A "slash" token is `/` followed by one or more word chars (letters,
 * digits, `_`, `-`), anchored to the start-of-string or whitespace so
 * URLs like `http://example.com` don't light up.
 * A "mention" token is `@` followed by any non-whitespace run, same
 * anchoring rule.
 *
 * This runs on every keystroke (memoized on `text`), so keep it cheap:
 * one regex sweep, no backtracking-heavy patterns.
 */
function tokenizeComposer(text: string): ComposerToken[] {
  if (!text) return [{ kind: 'text', value: '' }]
  const tokens: ComposerToken[] = []
  const re = /(^|\s)(\/[A-Za-z0-9_-]+|@\S+)/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + m[1].length
    if (tokenStart > lastIdx) {
      tokens.push({ kind: 'text', value: text.slice(lastIdx, tokenStart) })
    }
    const value = m[2]
    tokens.push({
      kind: value.startsWith('/') ? 'slash' : 'mention',
      value
    })
    lastIdx = tokenStart + value.length
  }
  if (lastIdx < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIdx) })
  }
  return tokens
}

/**
 * Walks through every tokenized slash/mention run in `text` and yields
 * their absolute `[start, end)` offsets. The tokenizer already knows
 * the exact rules (must be `/` or `@` at start-of-text or after
 * whitespace, etc), so we reuse it instead of re-deriving character
 * classes in two places.
 */
function* iterAtomicTokens(
  text: string
): Generator<{ start: number; end: number; value: string }> {
  const tokens = tokenizeComposer(text)
  let offset = 0
  for (const tok of tokens) {
    const end = offset + tok.value.length
    if (tok.kind === 'slash' || tok.kind === 'mention') {
      yield { start: offset, end, value: tok.value }
    }
    offset = end
  }
}

function findAtomicTokenEndingAt(
  text: string,
  cursor: number
): { start: number; end: number; value: string } | null {
  for (const hit of iterAtomicTokens(text)) {
    if (hit.end === cursor) return hit
    if (hit.start > cursor) break
  }
  return null
}

function findAtomicTokenStartingAt(
  text: string,
  cursor: number
): { start: number; end: number; value: string } | null {
  for (const hit of iterAtomicTokens(text)) {
    if (hit.start === cursor) return hit
    if (hit.start > cursor) break
  }
  return null
}

function findAtomicTokenContaining(
  text: string,
  cursor: number
): { start: number; end: number; value: string } | null {
  for (const hit of iterAtomicTokens(text)) {
    // Strictly inside — cursor === start or cursor === end is NOT
    // "inside", those are valid caret slots at the chip boundaries.
    if (cursor > hit.start && cursor < hit.end) return hit
    if (hit.start > cursor) break
  }
  return null
}

/**
 * Snapshot of a TriggerPopoverRoot's React-rendered state that we care
 * about for manual Enter handling. See the stale-closure comment in
 * Composer for why this exists — tl;dr: assistant-ui's internal
 * `handleKeyDown` captures the wrong `highlightedIndex` in production
 * builds, so we bypass it and call `selectItem` ourselves with data
 * sourced from the live React context.
 */
type TriggerCtxSnapshot = {
  open: boolean
  items: readonly Unstable_TriggerItem[]
  highlightedIndex: number
  selectItem: (item: Unstable_TriggerItem) => void
}

/**
 * Writes a snapshot of the nearest `TriggerPopoverRoot`'s live context
 * into `targetRef` after every commit. Rendered as a zero-DOM sibling
 * inside each root so `useTriggerPopoverContext()` resolves to the
 * intended root (slash vs mention). The write is in `useLayoutEffect`
 * so the ref is already current before any subsequent keyboard event.
 */
function TriggerCtxSync({
  targetRef
}: {
  targetRef: React.MutableRefObject<TriggerCtxSnapshot | null>
}): null {
  const ctx = ComposerPrimitive.unstable_useTriggerPopoverContext()
  useLayoutEffect(() => {
    targetRef.current = {
      open: ctx.open,
      items: ctx.items,
      highlightedIndex: ctx.highlightedIndex,
      selectItem: ctx.selectItem
    }
  })
  return null
}

/**
 * Shared render-prop for both the `/` and `@` trigger popovers.
 *
 * Two subtle correctness / polish details worth calling out:
 *
 * 1. **No explicit `index` prop.** assistant-ui's
 *    `Unstable_TriggerPopoverItem` accepts an optional `index`, and if
 *    omitted it computes the item's position via
 *    `ctx.items.findIndex(i => i.id === item.id)` at render time. Passing
 *    our own loop index `i` was risky: if the render-prop `items` array
 *    was ever out of sync with `ctx.items` (even for one frame during
 *    filter updates), the visually-highlighted row could drift away
 *    from the row the library's keyboard handler would pick on Enter
 *    — the classic "I pressed Enter on /skill but it inserted /mcp"
 *    symptom. Letting the library derive the index from item.id means
 *    both the visual `data-highlighted` marker and the Enter-to-select
 *    path resolve the same row through the same lookup.
 *
 * 2. **Scroll-to-highlight** uses `ctx.highlightedIndex` + a direct
 *    child lookup on the `<ul>` rather than a `querySelector` for
 *    `[data-highlighted]`. With `motion` animating list entries, the
 *    `data-highlighted` attribute is painted mid-animation and can
 *    briefly land on the wrong element; indexing into `listRef.children`
 *    is immune to that.
 *
 * `emptyText` is parameterized so the slash popover can show
 * "No matching commands" while the file popover can show
 * "No matching files" (or "Loading files…" on cold start).
 */
function TriggerPopoverList({
  items,
  emptyText,
  onItemClick
}: {
  items: readonly Unstable_TriggerItem[]
  emptyText: string
  onItemClick?: () => void
}): React.JSX.Element {
  const ctx = ComposerPrimitive.unstable_useTriggerPopoverContext()
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const li = listRef.current?.children[ctx.highlightedIndex] as
      | HTMLElement
      | undefined
    li?.scrollIntoView({ block: 'nearest' })
  }, [ctx.highlightedIndex, items])

  if (items.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12 }}
        className="px-4 py-3 text-[12px] text-zinc-500"
      >
        {emptyText}
      </motion.div>
    )
  }

  return (
    <ul ref={listRef} className="space-y-0.5 px-1">
      {items.map((item) => (
        <motion.li
          key={item.id}
          layout="position"
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
        >
          <ComposerPrimitive.Unstable_TriggerPopoverItem
            item={item}
            onClick={onItemClick}
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-zinc-800/60 data-[highlighted]:bg-zinc-800"
          >
            <span className="shrink-0 truncate font-mono text-zinc-100">
              {item.label}
            </span>
            {item.description && (
              <span className="truncate text-[12px] text-zinc-500">
                {item.description}
              </span>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItem>
        </motion.li>
      ))}
    </ul>
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

  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
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
  }, [file])

  const isImage = attachment.type === 'image'

  return (
    <AttachmentPrimitive.Root className="group/att relative flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1.5 pr-6">
      {isImage && previewURL ? (
        <img
          src={previewURL}
          alt=""
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-zinc-800 text-[10px] font-mono text-zinc-500"
          title={previewError ?? undefined}
        >
          {previewError ? '!' : attachment.type?.slice(0, 3) ?? 'file'}
        </div>
      )}
      <span className="max-w-[140px] truncate text-[11px] text-zinc-300">
        {attachment.name}
      </span>
      <AttachmentPrimitive.Remove
        className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-zinc-800 text-[10px] leading-none text-zinc-400 opacity-0 transition group-hover/att:opacity-100 hover:bg-zinc-700 hover:text-zinc-100"
        aria-label="Remove attachment"
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}
