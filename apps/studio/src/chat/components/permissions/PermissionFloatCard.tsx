import { useEffect, useMemo, useRef, useState } from 'react'

import type { PermissionRequest } from '@desktop-shared/types'
import { useT, useTFormat, useToolLabel } from '../../i18n'
import { useChatStore } from '../../stores/chat'
import {
  usePendingFloatPermissions,
  usePermissionStore
} from '../../stores/permissions'
import { safeStringify } from '../chat/toolHelpers'

/**
 * PermissionFloatCard
 * -------------------
 * The Codex-desktop-style floating permission prompt: a card docked
 * directly ABOVE the composer (rendered by `PermissionFloatDock` inside
 * ThreadView's composer dock), replacing the old amber inline prompt
 * that lived inside each ToolCallCard.
 *
 * Why floating instead of inline
 * ------------------------------
 * The inline prompt sat wherever the tool card happened to be — often
 * scrolled out of view, so the user stared at a stalled spinner with
 * the actual question hidden above the fold. Docking the prompt onto
 * the composer puts it where the user's eyes already are (they were
 * about to type), styled as a QUESTION rather than a warning: no amber
 * alarm frame, just problem → command → numbered choices, in the same
 * 22px-radius shell language as the composer beneath it.
 *
 * The tool card keeps a lightweight "waiting for your approval" anchor
 * (see ToolCallCard) so the card ↔ prompt relationship stays legible.
 *
 * Queueing
 * --------
 * The permission store may hold several pending requests (parallel
 * tool_use blocks). The dock shows the OLDEST one plus an "N more
 * waiting" counter — answering pops the queue and the next request
 * slides in (keyed remount replays the entrance and resets local
 * state). Nothing is ever dropped: the store keeps every request until
 * it's answered or cancelled, which preserves the no-lost-siblings
 * invariant that killed the old single-slot modal.
 *
 * Two-step interaction (Codex model)
 * ----------------------------------
 * Clicking an option SELECTS it; Submit (or Enter) commits. Number
 * keys 1-3 select directly, ↑↓ move the highlight, clicking the
 * already-selected allow options commits immediately (second click =
 * confirm). Esc = skip = plain deny. The deny option expands a
 * feedback textarea — its text rides back to the engine as
 * `denyMessage` so the assistant hears WHY (Enter submits there too;
 * Shift+Enter inserts a newline).
 *
 * AskUserQuestion never renders here — `usePendingFloatPermissions`
 * filters it out; that tool keeps its questionnaire view inside the
 * tool card / canvas 问题 tab.
 */

type ChoiceKind = 'allow-once' | 'allow-session' | 'deny-feedback'

export function PermissionFloatDock(): React.JSX.Element | null {
  const sessionId = useChatStore((s) => s.sessionId)
  const pending = usePendingFloatPermissions(sessionId)
  if (pending.length === 0) return null
  const req = pending[0]
  // key = requestId: each request gets fresh local state (selection,
  // feedback draft) and replays the entrance animation.
  //
  // 外层容器与 Composer 根部（mx-auto w-full max-w-4xl）完全同参：卡片
  // 必须和它正下方的 composer 同宽同轴——非分栏时 dock 是全窗宽，裸卡
  // 会横跨整个聊天区（2026-07-07 用户实锤「太宽了」）；分栏窄列时
  // max-w 不触顶，自然退化为铺满窄列，两种布局一份代码。
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PermissionFloatCard
        key={req.requestId}
        request={req}
        queuedCount={pending.length - 1}
      />
    </div>
  )
}

function PermissionFloatCard({
  request,
  queuedCount
}: {
  request: PermissionRequest
  queuedCount: number
}): React.JSX.Element {
  const t = useT()
  const tf = useTFormat()
  const toolLabel = useToolLabel()
  const respond = usePermissionStore((s) => s.respond)

  // Choice list — option 2 only exists when the request is scopeable
  // (same rule as the old inline prompt / the terminal CLI).
  const choices = useMemo<ChoiceKind[]>(
    () =>
      request.scopeLabel
        ? ['allow-once', 'allow-session', 'deny-feedback']
        : ['allow-once', 'deny-feedback'],
    [request.scopeLabel]
  )
  const [selected, setSelected] = useState(0)
  const [feedback, setFeedback] = useState('')
  const feedbackOpen = choices[selected] === 'deny-feedback'

  const submitRef = useRef<HTMLButtonElement>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  // Own the keyboard from mount: Enter submits, numbers select — the
  // same auto-focus contract the old inline prompt had.
  useEffect(() => {
    submitRef.current?.focus()
  }, [])
  // Selecting the deny option moves focus into the textarea so the
  // user can start typing the reason immediately.
  useEffect(() => {
    if (feedbackOpen) feedbackRef.current?.focus()
  }, [feedbackOpen])

  const submit = (): void => {
    const kind = choices[selected]
    if (kind === 'deny-feedback') {
      void respond(request.requestId, 'deny', undefined, feedback)
    } else {
      void respond(request.requestId, kind)
    }
  }
  const skip = (): void => {
    void respond(request.requestId, 'deny')
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const inTextarea = e.target === feedbackRef.current
    if (e.key === 'Escape') {
      e.preventDefault()
      skip()
      return
    }
    if (e.key === 'Enter') {
      // Shift+Enter in the feedback box inserts a newline; plain Enter
      // submits from anywhere (preventDefault stops a focused option
      // button from re-firing its select click).
      if (inTextarea && e.shiftKey) return
      e.preventDefault()
      submit()
      return
    }
    // Typing digits / moving the caret inside the textarea must not
    // hijack the selection.
    if (inTextarea) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, choices.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else {
      const num = Number.parseInt(e.key, 10)
      if (num >= 1 && num <= choices.length) {
        e.preventDefault()
        setSelected(num - 1)
      }
    }
  }

  // Command / parameter preview. `summary` is the broker's short
  // human-readable line (file path, command, …); raw input is the
  // fallback so the user is never asked to approve a blind call.
  const detail =
    request.summary && request.summary.trim().length > 0
      ? request.summary
      : request.input !== undefined && request.input !== null
        ? safeStringify(request.input)
        : t('permissionNoParams')

  const optionLabel = (kind: ChoiceKind): React.ReactNode => {
    switch (kind) {
      case 'allow-once':
        return t('permissionYes')
      case 'allow-session':
        return (
          <>
            {t('permissionFloatAllowSession')}
            <span className="ml-1.5 inline-block max-w-64 truncate rounded-md bg-muted px-1.5 py-px align-[1px] font-mono text-[11px] text-muted-foreground">
              {request.scopeLabel}
            </span>
          </>
        )
      case 'deny-feedback':
        return t('permissionFloatDenyFeedback')
    }
  }

  return (
    <div
      className="perm-float-in mb-2.5 rounded-[22px] bg-popover px-5 pb-3.5 pt-5 ring-1 ring-black/[0.08] shadow-[0_24px_60px_-18px_rgba(0,0,0,0.28),0_2px_8px_-2px_rgba(0,0,0,0.1)] dark:ring-white/[0.08]"
      role="group"
      aria-label={tf('permissionAriaLabel', { toolName: request.toolName })}
      onKeyDown={onKeyDown}
    >
      {/* Question line — the request phrased as a plain question, not an
          alarm. `toolLabel` gives the tool the SAME localized name the
          tool card header uses (写入文件 / 运行命令 …) — broker's
          displayName is the raw English tool name in zh contexts. */}
      <div className="flex items-start gap-3">
        <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
          {tf('permissionFloatTitle', { tool: toolLabel(request.toolName) })}
        </h3>
        {queuedCount > 0 && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {tf('permissionFloatQueued', { count: String(queuedCount) })}
          </span>
        )}
      </div>

      {/* Command / parameter block */}
      <div className="mt-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-all rounded-xl border border-border/70 bg-muted/50 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
        {detail}
      </div>

      {/* Numbered choices */}
      <div className="mt-3.5 flex flex-col gap-0.5">
        {choices.map((kind, i) => {
          const isSelected = i === selected
          const isDeny = kind === 'deny-feedback'
          return (
            <button
              key={kind}
              type="button"
              onClick={() => {
                // Second click on an already-selected allow option =
                // confirm. The deny row never commits by click — its
                // confirmation is the Submit button, after typing.
                if (isSelected && !isDeny) submit()
                else setSelected(i)
              }}
              className={
                'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[13.5px] leading-snug transition-colors duration-100 ' +
                (isSelected
                  ? 'bg-brand/[0.09]'
                  : 'hover:bg-foreground/[0.04]')
              }
            >
              <span
                className={
                  'inline-flex size-[21px] shrink-0 items-center justify-center rounded-full transition-colors duration-100 ' +
                  (isSelected
                    ? 'bg-brand text-brand-foreground'
                    : 'bg-muted text-muted-foreground')
                }
              >
                {isDeny ? (
                  <PencilIcon />
                ) : (
                  <span className="font-mono text-[11.5px] font-semibold">
                    {i + 1}
                  </span>
                )}
              </span>
              <span
                className={
                  'min-w-0 flex-1 ' +
                  (isDeny && !isSelected ? 'text-muted-foreground' : 'text-foreground')
                }
              >
                {optionLabel(kind)}
              </span>
              {isSelected && (
                <span className="flex shrink-0 gap-1" aria-hidden>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </span>
              )}
            </button>
          )
        })}

        {/* Deny-with-reason input, expanded under the deny row */}
        {feedbackOpen && (
          <div className="pb-1 pl-[42px] pr-2.5 pt-1">
            <textarea
              ref={feedbackRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={t('permissionFloatFeedbackPlaceholder')}
              rows={2}
              maxLength={4000}
              className="w-full resize-y rounded-[10px] border border-input bg-card px-2.5 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-brand/55 focus:outline-none focus:ring-[3px] focus:ring-brand/[0.12]"
            />
          </div>
        )}
      </div>

      {/* Footer: hint · skip · submit */}
      <div className="mt-2.5 flex items-center gap-2.5 border-t border-border/60 pt-3">
        <span className="hidden items-center gap-1 text-[11.5px] text-muted-foreground sm:flex">
          {t('permissionFloatHint')}
        </span>
        <button
          type="button"
          onClick={skip}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          {t('permissionFloatSkip')}
          <Kbd>Esc</Kbd>
        </button>
        <button
          ref={submitRef}
          type="button"
          onClick={submit}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-[13px] font-semibold text-brand-foreground shadow-[0_1px_2px_rgba(0,0,0,0.1),0_2px_8px_-2px_rgba(0,0,0,0.18)] transition-all hover:brightness-[1.08] active:scale-[0.97]"
        >
          {t('permissionFloatSubmit')}
          <span className="rounded-[5px] bg-brand-foreground/20 px-1 font-mono text-[10px] leading-[16px]">
            ⏎
          </span>
        </button>
      </div>
    </div>
  )
}

/**
 * PermissionWaitAnchor
 * --------------------
 * The lightweight marker rendered INSIDE the waiting tool's card where
 * the old inline prompt used to be. The actual decision UI now lives in
 * the floating card above the composer — this row keeps the tool ↔
 * prompt relationship legible ("this spinner is waiting on the question
 * below") without duplicating the choices.
 */
export function PermissionWaitAnchor(): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-2 rounded-[10px] bg-brand/[0.07] px-3 py-2 text-[12.5px] font-medium text-brand">
      <span aria-hidden className="perm-wait-dot size-1.5 shrink-0 rounded-full bg-brand" />
      {t('permissionWaitAnchor')}
      <span className="ml-auto shrink-0 text-[12px] opacity-80" aria-hidden>
        {t('permissionWaitAnchorHint')}
      </span>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
      {children}
    </span>
  )
}

function PencilIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[11px]"
      aria-hidden
    >
      <path d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5z" />
    </svg>
  )
}
