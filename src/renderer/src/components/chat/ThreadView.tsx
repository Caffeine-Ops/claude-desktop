import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  useAuiState,
  useComposerRuntime
} from '@assistant-ui/react'
import type { Attachment, Unstable_TriggerItem } from '@assistant-ui/core'
import { AnimatePresence, motion } from 'motion/react'

import type { SessionMeta } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useChatStore } from '../../stores/chat'
import { buildSlashAdapter, slashFormatter } from '../../composer/slashAdapter'
import {
  buildFileMentionAdapter,
  mentionFormatter
} from '../../composer/fileMentionAdapter'
import { ThinkingSpinner } from './ThinkingSpinner'
import { AssistantMarkdown } from './AssistantMarkdown'
import { DictationWaveform } from './DictationWaveform'
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
export function ThreadView(): React.JSX.Element {
  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 w-full flex-1 flex-col bg-transparent">
      {/* Scrollable message area. min-h-0 + flex-1 is the canonical
          flexbox pattern that lets the viewport shrink correctly inside
          another flex column. */}
      <ThreadPrimitive.Viewport
        autoScroll
        // Bottom mask fades the last ~56px of the scrollable viewport
        // into transparency so messages don't butt up hard against the
        // composer. The inner column carries matching `pb-20` so the
        // final message stays fully legible once you scroll all the
        // way down — only the padding gets eaten by the mask.
        className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-56px),transparent_100%)]"
      >
        {/* Inner column caps reading width and centers messages. The
            `min-h-full` lets the empty-state `flex-1` stretch so the
            hero text lands at the vertical center of the viewport even
            when there are no messages yet. */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-20 pt-8">
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

      <ScrollToBottomButton />

      {/* Composer dock — outside the scroll viewport so it's always
          pinned to the bottom of Root regardless of message count. */}
      <div className="shrink-0 border-t border-border/70 bg-background/95 px-6 py-4 backdrop-blur">
        <Composer />
      </div>
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
          // Composer dock height is roughly ~72-88px; 96px keeps the
          // button floating clearly above it without overlapping.
          'bottom-[96px] ' +
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

/* ───────────────────────── EmptyState ───────────────────────── */

function EmptyState(): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="mb-3 text-[28px] font-semibold text-foreground">
        {t('emptyStateTitle')}
      </div>
      <p className="max-w-md text-sm text-muted-foreground/80">
        {t('emptyStateHintBefore')}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[12.5px] font-mono text-foreground/80">
          {t('emptyStateExampleAsk')}
        </code>
        {t('emptyStateHintMiddle')}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[12.5px] font-mono text-foreground/80">
          /help
        </code>
        {t('emptyStateHintAfter')}
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
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-accent/90 px-4 py-2.5 text-[14px] leading-relaxed text-white empty:hidden">
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
        className="mt-[8px] block size-[6px] shrink-0 rounded-full bg-foreground/60"
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
      <div className="rounded-md border border-border bg-card/50 px-3 py-1.5 text-[11.5px] italic text-muted-foreground/80">
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

  return (
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className={
          'mt-[3px] shrink-0 select-none font-mono text-[13px] leading-relaxed ' +
          (running ? 'text-amber-400' : 'text-muted-foreground/60')
        }
      >
        ⎿
      </span>
      <div className="min-w-0 flex-1">
        <details open={running} className="group/tool">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
            <StatusDot running={running} />
            <span className="font-mono font-medium text-foreground">
              {toolName}
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
            <ToolPane label="Input" copyText={inputBody}>
              <JsonView text={inputBody} maxHeight />
              {running && hasArgsText && (
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-[1em] w-[0.5ch] animate-pulse bg-accent align-[-0.1em]"
                />
              )}
            </ToolPane>
            {result !== undefined &&
              (isCodeResult ? (
                <ToolPane label="Output" copyText={extractText(result)}>
                  <CodeFileView
                    text={extractText(result)}
                    language={codeLanguage}
                  />
                </ToolPane>
              ) : (
                <ToolPane label="Output" copyText={safeStringify(result)}>
                  <JsonView text={safeStringify(result)} maxHeight />
                </ToolPane>
              ))}
          </div>
        </details>
      </div>
    </div>
  )
}

function StatusDot({ running }: { running: boolean }): React.JSX.Element {
  if (running) {
    return (
      <span className="relative inline-flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/60" />
        <span className="relative inline-flex size-full rounded-full bg-accent" />
      </span>
    )
  }
  return (
    <span aria-hidden className="inline-block size-1.5 rounded-full bg-emerald-500" />
  )
}

function StatusPill({ running }: { running: boolean }): React.JSX.Element {
  return (
    <span
      className={
        'rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider ' +
        (running
          ? 'border-accent/40 bg-accent/15 text-accent'
          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500')
      }
    >
      {running ? 'running' : 'done'}
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
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card/40">
      <div className="flex items-center justify-between border-b border-border/70 bg-muted/30 px-2.5 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <CopyButton text={copyText} />
      </div>
      <div className="px-2.5 py-1.5">{children}</div>
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
    <pre
      className={
        'overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-foreground/85 ' +
        // When capped, mask-fade the bottom edge so overflowing
        // content melts into the pane frame instead of hitting a
        // hard cut. `pb-5` keeps the final line fully legible once
        // you scroll all the way down — only the padding is masked.
        (maxHeight
          ? 'max-h-80 pb-5 [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-28px),transparent_100%)]'
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

function safeStringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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
 * Unwrap the tool-result payload into a plain string we can feed to
 * the highlighter. Claude-Code-style tools return the file body as a
 * top-level string; newer SDKs wrap it in `{ content: [{type:'text',
 * text: '...'}] }`. Both shapes collapse to the same highlighted view.
 */
function extractText(result: unknown): string {
  if (result === undefined) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : typeof part === 'string'
            ? part
            : ''
      )
      .join('')
  }
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content)) return extractText(obj.content)
  }
  return safeStringify(result)
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
  // Read dictation state at the Composer level (single subscription)
  // and branch the composer row layout on it. When dictating, the
  // textarea is replaced by a live waveform, the send + mic slots
  // become a pair of X / ✓ controls — matching the mutually
  // exclusive UX in the design reference.
  const isDictating = useAuiState(
    (s) => (s as { composer?: { dictation?: unknown } }).composer?.dictation != null
  )
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
          <ComposerPrimitive.Unstable_TriggerPopoverPopover className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
            <ComposerPrimitive.Unstable_TriggerPopoverItems>
              {(items) => (
                <TriggerPopoverList
                  items={items}
                  emptyText={t('composerNoMatchingCommands')}
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
            <ComposerPrimitive.Unstable_TriggerPopoverPopover className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
              <ComposerPrimitive.Unstable_TriggerPopoverItems>
                {(items) => (
                  <TriggerPopoverList
                    items={items}
                    emptyText={
                      files.length === 0
                        ? t('composerLoadingFiles')
                        : t('composerNoMatchingFiles')
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
            <ComposerPrimitive.AttachmentDropzone className="rounded-2xl border border-border bg-card/80 shadow-lg transition-colors focus-within:border-input data-[dragging=true]:border-accent data-[dragging=true]:bg-accent/15">
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
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                  aria-label={t('composerAttachImage')}
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
                {isDictating ? (
                  /* ── Dictation mode row ────────────────────────────
                     Waveform replaces the textarea, X cancels and
                     reverts to the pre-dictation text, ✓ confirms
                     and inserts the committed transcript into the
                     textarea (which rematerializes when this branch
                     unmounts). */
                  <DictationActiveControls
                    cancelLabel={t('composerCancelDictation')}
                    confirmLabel={t('composerConfirmDictation')}
                  />
                ) : (
                  <>
                    {/* Highlight overlay wrapper. The overlay div
                        renders the same text content but with slash
                        / mention tokens wrapped in styled spans,
                        while the textarea on top has transparent
                        text (caret still visible via
                        `caret-foreground`) so the overlay's
                        highlights read as "inline chips" to the
                        user. Both elements share identical
                        typography and padding so characters line up
                        pixel-perfect. The overlay uses `box-shadow`
                        for chip borders instead of `padding` to
                        avoid shifting text positions. */}
                    <div className="relative min-h-[24px] max-h-40 flex-1 overflow-hidden">
                      <ComposerHighlightOverlay
                        caretPos={caretPos}
                        isFocused={isFocused}
                      />
                      <ComposerPrimitive.Input
                        ref={textareaRef}
                        placeholder={t('composerPlaceholder')}
                        rows={1}
                        onKeyDown={handleComposerKey}
                        onFocus={(e) => {
                          setIsFocused(true)
                          // Sync caret state on focus so re-entering
                          // the composer shows the caret at the
                          // actual DOM selection, not a stale zero
                          // position.
                          setCaretPos(e.currentTarget.selectionStart ?? 0)
                        }}
                        onBlur={() => setIsFocused(false)}
                        onSelect={(e) => {
                          const el = e.currentTarget
                          let start = el.selectionStart ?? 0
                          const end = el.selectionEnd ?? start
                          // Collapse-to-boundary: when the user's
                          // cursor lands strictly *inside* a slash /
                          // mention token (click, arrow, or
                          // programmatic), snap it to the closer
                          // chip edge so chips feel atomic. Only
                          // applies to collapsed selections — a
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
                        className="relative z-[1] block min-h-[24px] max-h-40 w-full resize-none bg-transparent px-1 py-1.5 text-[14px] leading-relaxed text-transparent placeholder:text-muted-foreground/60 focus:outline-none"
                        style={{ caretColor: 'transparent' }}
                      />
                    </div>
                    <MicButton label={t('composerDictate')} />
                    {/* Mutually exclusive Send / Stop slot — matches
                        the ChatGPT / Claude.ai pattern. While idle we
                        show `Send` (disabled when the textarea is
                        empty via primitive's own logic). Once a turn
                        is in flight, `ThreadPrimitive.If running`
                        swaps in `Cancel` so the user can interrupt
                        without having a stale stop button sitting
                        around between turns. */}
                    <ThreadPrimitive.If running={false}>
                      <ComposerPrimitive.Send className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/80">
                        ↑
                      </ComposerPrimitive.Send>
                    </ThreadPrimitive.If>
                    <ThreadPrimitive.If running>
                      <ComposerPrimitive.Cancel
                        aria-label="Stop generating"
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm transition hover:bg-foreground"
                      >
                        <span className="block size-2.5 rounded-[2px] bg-card" />
                      </ComposerPrimitive.Cancel>
                    </ThreadPrimitive.If>
                  </>
                )}
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
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-secondary hover:text-foreground"
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
  const currentText = useAuiState(
    (s) =>
      ((s as { composer?: { text?: string } }).composer?.text as string | undefined) ?? ''
  )
  // Snapshot-on-first-render: captures the composer text AT the
  // moment dictation starts. Subsequent renders with updated
  // committed text do NOT overwrite the ref.
  const preTextRef = useRef<string | null>(null)
  if (preTextRef.current === null) {
    preTextRef.current = currentText
  }
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
    const preText = preTextRef.current ?? ''
    queueMicrotask(() => {
      runtime.stopDictation()
      runtime.setText(preText)
    })
  }, [isFinishing, runtime])

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
      className="pointer-events-none absolute inset-0 z-0 whitespace-pre-wrap break-words px-1 py-1.5 text-[14px] leading-relaxed text-foreground"
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
        background: 'hsl(var(--foreground))',
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
  // Both palettes read from CSS variables so the chips re-skin with
  // the theme picker. Slash chips follow the user's accent token;
  // mention chips use a dedicated `--chip-mention` token (defined in
  // index.css for both light and dark) so files stay visually
  // distinct from commands without competing with the accent color.
  const palette =
    variant === 'slash'
      ? {
          text: 'hsl(var(--accent))',
          background: 'hsl(var(--accent) / 0.16)',
          iconStroke: 'hsl(var(--accent))'
        }
      : {
          text: 'hsl(var(--chip-mention))',
          background: 'hsl(var(--chip-mention) / 0.16)',
          iconStroke: 'hsl(var(--chip-mention))'
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
        className="px-4 py-3 text-[12px] text-muted-foreground/80"
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
            className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-muted/60 data-[highlighted]:bg-muted"
          >
            <span className="shrink-0 truncate font-mono text-foreground">
              {item.label}
            </span>
            {item.description && (
              <span className="truncate text-[12px] text-muted-foreground/80">
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
    <AttachmentPrimitive.Root className="group/att relative flex items-center gap-2 rounded-lg border border-border bg-card/60 p-1.5 pr-6">
      {isImage && previewURL ? (
        <img
          src={previewURL}
          alt=""
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-mono text-muted-foreground/80"
          title={previewError ?? undefined}
        >
          {previewError ? '!' : attachment.type?.slice(0, 3) ?? 'file'}
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
