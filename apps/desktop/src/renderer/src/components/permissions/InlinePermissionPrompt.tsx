import { useEffect, useRef } from 'react'

import type {
  PermissionDecisionKind,
  PermissionRequest
} from '../../../../shared/types'
import { useT, useTFormat } from '../../i18n'
import { usePermissionStore } from '../../stores/permissions'
import { AskUserQuestionView } from './AskUserQuestionView'

/**
 * InlinePermissionPrompt
 * ----------------------
 * Replaces the old fullscreen `PermissionDialog` modal with a prompt
 * that renders directly inside the target tool's `ToolCallCard`. Each
 * pending tool call shows its own prompt in its own card — which also
 * fixes the "two parallel Grep tools both stuck on RUNNING" freeze:
 * the old single-slot modal could only display one request at a time
 * and would lose siblings to a `setPending(null)` race, hanging the
 * engine forever.
 *
 * Branches
 * --------
 *   - `AskUserQuestion` → delegate to `AskUserQuestionView`, which
 *     renders the model's 1-4 clarifying questions and collects the
 *     user's picks into `updatedInput.answers`. Same shape the old
 *     modal produced, so the main-side `mergeUpdatedInput` path keeps
 *     working unchanged.
 *   - Everything else → three-decision row: Yes / Yes-session / No.
 *     Mirrors the fusion-code terminal prompt so the muscle memory
 *     carries over.
 *
 * Keyboard
 * --------
 * Each prompt auto-focuses its primary "Yes" button on mount; Enter
 * activates it natively (no global key handler needed, which avoids
 * the cross-card interference the old modal had to worry about).
 * Escape cancels the currently-focused prompt via a local listener
 * on the container ref — scoped to this card so two visible prompts
 * don't both claim the key.
 *
 * Note: we deliberately do NOT play a chime here. The old modal did,
 * but inline prompts appear IN the chat transcript next to the
 * running tool card, so the visual is already unmissable — a sound
 * effect on every tool call would be noise, not signal.
 */
type Props = {
  request: PermissionRequest
}

export function InlinePermissionPrompt({ request }: Props): React.JSX.Element {
  const t = useT()
  const tf = useTFormat()
  const respond = usePermissionStore((s) => s.respond)
  const containerRef = useRef<HTMLDivElement>(null)

  const isAskUserQuestion = request.toolName === 'AskUserQuestion'

  // Local keydown handler — only fires when the prompt (or anything
  // inside it) has focus, so parallel prompts don't fight over the
  // same keys. The default branch auto-focuses button 1 on mount, so
  // the container already owns focus by the time the user types.
  useEffect(() => {
    if (isAskUserQuestion) return
    const el = containerRef.current
    if (!el) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void respond(request.requestId, 'deny')
      }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [isAskUserQuestion, request.requestId, respond])

  if (isAskUserQuestion) {
    return (
      <div
        ref={containerRef}
        className="overflow-hidden rounded-2xl bg-muted/40 ring-1 ring-black/[0.06] dark:ring-white/[0.06]"
        aria-label={tf('permissionAriaLabel', { toolName: request.toolName })}
      >
        <AskUserQuestionView
          input={request.input}
          onSubmit={(updatedInput) =>
            void respond(request.requestId, 'allow-once', updatedInput)
          }
          onCancel={() => void respond(request.requestId, 'deny')}
        />
      </div>
    )
  }

  const onClick = (decision: PermissionDecisionKind): void => {
    void respond(request.requestId, decision)
  }

  return (
    <div
      ref={containerRef}
      className="rounded-md border border-amber-400/40 bg-amber-400/5 px-3 py-2.5"
      aria-label={tf('permissionAriaLabel', { toolName: request.toolName })}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block size-1.5 animate-pulse rounded-full bg-amber-400"
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-400">
          {t('permissionHeader')}
        </span>
        <span className="ml-auto truncate text-[11px] text-muted-foreground/70">
          {t('permissionPrompt')}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <DecisionButton
          index={1}
          label={t('permissionYes')}
          onClick={() => onClick('allow-once')}
          accent
          autoFocus
        />
        {request.scopeLabel && (
          <DecisionButton
            index={2}
            label={tf('permissionAllowSession', { scope: request.scopeLabel })}
            onClick={() => onClick('allow-session')}
          />
        )}
        <DecisionButton
          index={request.scopeLabel ? 3 : 2}
          label={t('permissionDeny')}
          onClick={() => onClick('deny')}
        />
      </div>
    </div>
  )
}

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
        'flex w-full items-center gap-3 rounded-md border px-3 py-1.5 text-left text-[12.5px] font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-0 ' +
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
