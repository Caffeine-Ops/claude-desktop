import { useEffect, useState } from 'react'

import { useChatStore } from '../../stores/chat'
import { useI18n } from '../../i18n'
import { zhSpinnerVerb } from '../../constants/spinnerVerbs'

/**
 * ThinkingSpinner
 * ---------------
 * DOM port of the fusion-code CLI's "assistant is thinking" animation
 * from `free-code/src/components/Spinner/*`.
 *
 * Mount strategy
 * --------------
 * Wired into `MessagePrimitive.Parts` as the `Empty` component slot.
 * That slot fires whenever the current assistant message has zero
 * renderable parts — which is exactly what `useExternalStoreRuntime`
 * gives us for free: when `isRunning === true` and the last message
 * isn't an assistant yet, the runtime injects an "optimistic
 * assistant placeholder" with `content: []`. Our `Empty` component
 * gets mounted inside that placeholder.
 *
 * Lifecycle handled for us:
 *   - Mount: runtime injected the optimistic placeholder
 *   - Unmount: first text/tool part lands, content !== [] anymore,
 *              `Empty` is replaced by the real Parts renderer
 *
 * That's why this component does NOT consult `streaming`, `messages`,
 * or `lastIsAssistant` — assistant-ui already gates its mount on the
 * exact "no content yet" condition we want.
 *
 * Visual anatomy (matches the terminal, reading left-to-right):
 *
 *     ✻  Cogitating…  (12s · esc to interrupt)
 *     │  │            │    │
 *     │  │            │    └── interrupt hint
 *     │  │            └── elapsed seconds from turn start
 *     │  └── verb, sampled once per turn from SPINNER_VERBS
 *     └── animated spinner glyph, 12-frame bidirectional cycle
 *
 * Animation
 * ---------
 * `setInterval` ticks every 80ms; on each tick we re-render and read
 * `Date.now() - startedAt` to derive the spinner frame and elapsed
 * seconds. We use `setInterval` not `requestAnimationFrame` so the
 * clock keeps ticking even when the window is backgrounded (rAF gets
 * throttled there).
 *
 * Start time fallback
 * -------------------
 * Normally `turnStartedAt` is set in the store the moment the `start`
 * ChatEvent lands (well before the runtime gets around to injecting
 * the optimistic placeholder), so by the time we mount it's already
 * a real timestamp. As a defensive fallback we capture our own
 * `mountedAt` and use it if the store value is still null — this
 * keeps the spinner showing a sensible elapsed counter even in the
 * unlikely race where Empty mounts before `start` is processed.
 *
 * ESC-to-interrupt
 * ----------------
 * While mounted, Esc calls `window.chatApi.abort` for the current
 * session. This makes the printed "esc to interrupt" hint actually
 * functional, mirroring the terminal experience.
 */

/**
 * Glyph animation note: the old terminal-style cycling spinner
 * (`·✢✳✶✻✽`, 120ms per frame) was dropped because its 120ms
 * setInterval re-render churn read as jittery. The single star now
 * animates via PURE CSS instead (`.tc-star`, main.css: slow rotation +
 * opacity breathe) — smooth motion, zero JS re-renders, so it restores
 * the "alive" feel without the original noise.
 */
const SPINNER_GLYPH = '✻'

export function ThinkingSpinner(): React.JSX.Element | null {
  const turnStartedAt = useChatStore((s) => s.turnStartedAt)
  const streaming = useChatStore((s) => s.streaming)
  const turnVerb = useChatStore((s) => s.turnVerb)
  const sessionId = useChatStore((s) => s.sessionId)
  const lang = useI18n((s) => s.lang)

  // Elapsed-seconds ticker. Re-renders every 1000ms only (was 80ms
  // for the frame-cycle animation, now unnecessary since the glyph
  // is static). Pauses when no turn is in flight so a stale row
  // can't keep ticking after `endAssistantMessage`.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (turnStartedAt === null) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [turnStartedAt])

  // ESC interrupts the current turn. Active for the lifetime of the
  // spinner — i.e. exactly while the assistant is in the pre-content
  // gap, which is when interrupting feels most natural. No-op when no
  // session is active (the spinner shouldn't be visible in that case
  // anyway, but TypeScript needs the narrowing).
  useEffect(() => {
    if (sessionId === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      void window.chatApi.abort({ sessionId })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId])

  // No live turn ⇒ no spinner. Previously this had a `mountedAt`
  // fallback that kept the timer running forever after `endAssistantMessage`
  // cleared `turnStartedAt`, so a turn that ended on a tool-call would
  // leave a stuck "Thinking… Ns · esc to interrupt" row in the thread.
  // Placed AFTER all hooks so the early return doesn't violate the
  // Rules of Hooks.
  if (!streaming || turnStartedAt === null) return null

  const elapsedMs = Math.max(0, Date.now() - turnStartedAt)
  const elapsedSec = Math.floor(elapsedMs / 1000)
  // Display verb follows the UI language: the store samples an English
  // verb once per turn (turnVerb); Chinese UIs map it deterministically
  // onto the Chinese list so the label stays stable for the whole turn.
  const enVerb = turnVerb ?? 'Thinking'
  const verbLabel = lang === 'zh' ? zhSpinnerVerb(enVerb) : enVerb
  const hint = lang === 'zh' ? ' · esc 中断)' : ' · esc to interrupt)'

  return (
    <div
      className="flex min-w-0 items-baseline gap-3 font-mono text-[13px] leading-relaxed text-foreground/80"
      role="status"
      aria-live="polite"
      aria-label={`${verbLabel}, ${elapsedSec} seconds elapsed`}
    >
      {/* Gutter glyph — same column as ● / ⎿ on adjacent assistant rows
          so the visual tree down the left edge stays aligned no matter
          what the row type is. tc-star = CSS-only rotation + breathe. */}
      <span aria-hidden className="tc-star w-[1ch] shrink-0 text-emerald-500">
        {SPINNER_GLYPH}
      </span>
      <span className="shimmer-text">{verbLabel}…</span>
      <span className="truncate text-muted-foreground/80">
        <span className="tabular-nums">({elapsedSec}s</span>
        {hint}
      </span>
    </div>
  )
}
