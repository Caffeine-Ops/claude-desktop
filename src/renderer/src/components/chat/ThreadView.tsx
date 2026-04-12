import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive
} from '@assistant-ui/react'
import type { Attachment, Unstable_TriggerItem } from '@assistant-ui/core'

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
      <span
        aria-hidden
        className="mt-[3px] shrink-0 select-none font-mono text-[13px] leading-relaxed text-zinc-300"
      >
        ●
      </span>
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
        <div className="relative">
          {/* Slash popover — reads the outer root's context because
              it sits outside the inner `@` root in the tree. */}
          <ComposerPrimitive.Unstable_TriggerPopoverPopover className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-zinc-800 bg-[#0e0e11] py-1 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
            <ComposerPrimitive.Unstable_TriggerPopoverItems>
              {(items) => (
                <TriggerPopoverList
                  items={items}
                  emptyText="No matching commands"
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
                <ComposerPrimitive.Input
                  placeholder="Ask anything…   ↵ send · ⇧↵ newline · / commands · @ files"
                  rows={1}
                  className="min-h-[24px] max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-[14px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                />
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
 * Shared render-prop for both the `/` and `@` trigger popovers.
 * Lives in a separate component so it can call
 * `unstable_useTriggerPopoverContext()` (which only works inside a
 * TriggerPopoverRoot) and use it to drive a `scrollIntoView` effect
 * on every keyboard navigation step.
 *
 * The popover container has `max-h-72 overflow-y-auto`, so when the
 * filtered list is longer than the visible area we need to actively
 * scroll to keep the highlighted row in view. assistant-ui adds
 * `data-highlighted=""` to the currently focused button — we just
 * query for it and call `scrollIntoView({ block: 'nearest' })` to
 * do the minimal scroll needed.
 *
 * `emptyText` is parameterized so the slash popover can show
 * "No matching commands" while the file popover can show
 * "No matching files" (or "Loading files…" on cold start).
 */
function TriggerPopoverList({
  items,
  emptyText
}: {
  items: readonly Unstable_TriggerItem[]
  emptyText: string
}): React.JSX.Element {
  const ctx = ComposerPrimitive.unstable_useTriggerPopoverContext()
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const highlighted = listRef.current?.querySelector(
      '[data-highlighted]'
    ) as HTMLElement | null
    highlighted?.scrollIntoView({ block: 'nearest' })
  }, [ctx.highlightedIndex, ctx.items])

  if (items.length === 0) {
    return (
      <div className="px-4 py-3 text-[12px] text-zinc-500">{emptyText}</div>
    )
  }

  return (
    <ul ref={listRef} className="space-y-0.5 px-1">
      {items.map((item, i) => (
        <li key={item.id}>
          <ComposerPrimitive.Unstable_TriggerPopoverItem
            item={item}
            index={i}
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] outline-none transition hover:bg-zinc-800/60 data-[highlighted]:bg-zinc-800"
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
        </li>
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
