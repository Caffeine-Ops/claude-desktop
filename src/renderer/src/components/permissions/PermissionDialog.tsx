import { useEffect, useRef, useState } from 'react'
import type {
  PermissionDecisionKind,
  PermissionRequest
} from '../../../../shared/types'
import { useT, useTFormat } from '../../i18n'
import { AskUserQuestionView } from './AskUserQuestionView'

/**
 * PermissionDialog
 * ----------------
 * Full-screen modal that mirrors the Claude Code terminal dialog. Two
 * modes, dispatched on `pending.toolName`:
 *
 *   1. **Default (allow/deny)** — all tools except AskUserQuestion.
 *      Shows a short parameter summary and three buttons (Yes / Yes
 *      for this session / No). The decision rides back through the
 *      broker as a plain `PermissionDecisionKind`.
 *
 *   2. **AskUserQuestion** — the model's "multiple choice" tool. The
 *      default allow/deny layout makes no sense here: there are no
 *      permissions to grant, just questions to answer. We switch to
 *      `AskUserQuestionView` which renders each question + options
 *      inline, lets the user pick an answer per question, then calls
 *      `respond('allow-once', { answers })`. The engine's
 *      mergeUpdatedInput layer folds `answers` into the original
 *      input before handing it to the SDK, so the tool sees the
 *      user's selections and returns them as its tool_result.
 *
 * Wiring
 * ------
 * Subscribes to `window.chatApi.onPermissionRequest` at mount. Stores
 * the latest request in local state. Only one can ever be pending at a
 * time because the SDK's `canUseTool` blocks the whole assistant turn
 * until we reply, so no queueing is needed.
 *
 * On click (or keyboard shortcut), calls `window.chatApi.respondPermission`
 * with the decision and clears the dialog. Main converts the decision
 * into the SDK's `PermissionResult` shape — see engine.ts.
 *
 * Keyboard (default branch)
 * -------------------------
 *   1 / Enter → allow-once          (highlighted default)
 *   2         → allow-session       (if scope provided)
 *   3         → deny
 *   Esc       → deny
 *
 * Keyboard (AskUserQuestion branch) lives inside AskUserQuestionView.
 */
export function PermissionDialog(): React.JSX.Element | null {
  const t = useT()
  const tf = useTFormat()
  const [pending, setPending] = useState<PermissionRequest | null>(null)
  // Tracks whether a respond call is in-flight so a double-click can't
  // race the IPC round-trip and double-resolve.
  const respondingRef = useRef(false)

  // ── IPC subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!window.chatApi) return
    const unsub = window.chatApi.onPermissionRequest((req) => {
      respondingRef.current = false
      setPending(req)
    })
    return unsub
  }, [])

  const isAskUserQuestion = pending?.toolName === 'AskUserQuestion'

  // ── Keyboard shortcuts (default branch only) ────────────────────────
  // The AskUserQuestion branch installs its own keydown handler inside
  // AskUserQuestionView because its semantics are entirely different
  // (numeric select, arrow nav, per-question advance). We keep this
  // effect disabled for that branch so the two handlers don't fight
  // over the same keys (e.g. "1" means "select first option" there,
  // "allow-once" here).
  useEffect(() => {
    if (!pending || isAskUserQuestion) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void respond('deny')
        return
      }
      if (e.key === 'Enter' || e.key === '1') {
        e.preventDefault()
        void respond('allow-once')
        return
      }
      if (e.key === '2' && pending.scopeLabel) {
        e.preventDefault()
        void respond('allow-session')
        return
      }
      if ((e.key === '3' && pending.scopeLabel) || (e.key === '2' && !pending.scopeLabel)) {
        e.preventDefault()
        void respond('deny')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // We want a fresh handler whenever the pending request changes so
    // the closure over `pending` stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, isAskUserQuestion])

  const respond = async (
    decision: PermissionDecisionKind,
    updatedInput?: unknown
  ): Promise<void> => {
    if (!pending || respondingRef.current) return
    respondingRef.current = true
    try {
      await window.chatApi.respondPermission({
        requestId: pending.requestId,
        decision,
        ...(updatedInput !== undefined ? { updatedInput } : {})
      })
    } catch (err) {
      console.error('[permission] respond failed', err)
    } finally {
      setPending(null)
    }
  }

  if (!pending) return null

  // ── AskUserQuestion branch ──────────────────────────────────────────
  if (isAskUserQuestion) {
    return (
      <DialogShell
        headerLabel={t('permissionAskHeader')}
        ariaLabel={tf('permissionAriaLabel', { toolName: pending.toolName })}
        accent="blue"
      >
        <AskUserQuestionView
          input={pending.input}
          onSubmit={(updatedInput) => respond('allow-once', updatedInput)}
          onCancel={() => respond('deny')}
        />
      </DialogShell>
    )
  }

  // ── Default allow/deny branch ───────────────────────────────────────
  return (
    <DialogShell
      headerLabel={t('permissionHeader')}
      ariaLabel={tf('permissionAriaLabel', { toolName: pending.toolName })}
      accent="amber"
    >
      <div className="px-5 pb-4 pt-4">
        <div className="mb-2 text-[14px] font-semibold text-foreground">
          {pending.displayName}
        </div>
        <div className="mb-4 max-h-48 overflow-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/80">
          <pre className="whitespace-pre-wrap break-words">
            {pending.summary || t('permissionNoParams')}
          </pre>
        </div>
        <div className="mb-2 text-[13px] text-foreground/80">{t('permissionPrompt')}</div>
        <div className="flex flex-col gap-1">
          <DecisionButton
            index={1}
            label={t('permissionYes')}
            onClick={() => respond('allow-once')}
            accent
            autoFocus
          />
          {pending.scopeLabel && (
            <DecisionButton
              index={2}
              label={tf('permissionAllowSession', { scope: pending.scopeLabel })}
              onClick={() => respond('allow-session')}
            />
          )}
          <DecisionButton
            index={pending.scopeLabel ? 3 : 2}
            label={t('permissionDeny')}
            onClick={() => respond('deny')}
          />
        </div>
      </div>

      {/* Footer keyboard hints */}
      <div className="flex items-center justify-between border-t border-border bg-background/60 px-5 py-2 text-[11px] text-muted-foreground/80">
        <span>
          <Kbd>Esc</Kbd> {t('permissionFooterEsc')} · <Kbd>↵</Kbd> {t('permissionFooterEnter')}
        </span>
        <span className="truncate font-mono text-muted-foreground/60">{pending.toolName}</span>
      </div>
    </DialogShell>
  )
}

/* ─────────────────── Dialog shell ─────────────────── */

/**
 * Shared chrome for both branches — the overlay, the rounded card, and
 * the header strip. Each branch stuffs its own body inside `children`.
 * Pulled out so the QuestionView doesn't have to re-create the same
 * frame (and so color accents are centralized).
 */
function DialogShell({
  headerLabel,
  ariaLabel,
  accent,
  children
}: {
  headerLabel: string
  ariaLabel: string
  accent: 'amber' | 'blue'
  children: React.ReactNode
}): React.JSX.Element {
  const dotColor = accent === 'amber' ? 'bg-accent' : 'bg-accent'
  const textColor = accent === 'amber' ? 'text-amber-400' : 'text-accent'
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="flex max-h-[calc(100vh-32px)] w-[560px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <span className={`inline-block size-2 animate-pulse rounded-full ${dotColor}`} />
          <span className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${textColor}`}>
            {headerLabel}
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ─────────────────── Decision button ─────────────────── */

function DecisionButton({
  index,
  label,
  onClick,
  accent = false,
  autoFocus = false
}: {
  index: number
  label: React.ReactNode
  onClick: () => void
  accent?: boolean
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      autoFocus={autoFocus}
      className={
        'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-[13px] font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-0 ' +
        (accent
          ? 'border-accent/50 bg-accent/15 text-accent hover:border-accent hover:bg-accent/25 focus:ring-ring/60'
          : 'border-border bg-card/60 text-foreground hover:border-input hover:bg-muted focus:ring-ring/50')
      }
    >
      <span
        className={
          'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ' +
          (accent
            ? 'bg-accent text-accent-foreground'
            : 'bg-muted text-muted-foreground')
        }
      >
        {index}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}

export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  )
}
