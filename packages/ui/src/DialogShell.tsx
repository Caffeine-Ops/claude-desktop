import { useEffect, type ReactNode } from 'react'

/**
 * DialogShell
 * -----------
 * The modal chrome that apps/desktop's Mcp / Skills / Logs dialogs each
 * hand-rolled an identical copy of: a dimmed full-screen backdrop, a
 * centered rounded card, click-outside-to-close, and a global Escape
 * handler. Extracted here so the three (and any future dialog) share one
 * source of truth.
 *
 * The class names are a verbatim lift of the originals so the refactor is
 * a no-op visually. Per-dialog differences (card height/width) are props.
 *
 * Styling is pure Tailwind utilities resolved against the shared
 * design-tokens palette (`border`, `card`, `muted-foreground`). For these
 * classes to survive each app's Tailwind v4 purge, the app's `@source`
 * must include this package's `src` — see each app's src/index.css.
 *
 * Composition (not config): callers assemble
 *   <DialogShell …><DialogShell.Header …/>…<DialogShell.Footer …/></DialogShell>
 * so a dialog with a filter row or a custom body shape stays in control of
 * its own middle section.
 */
export interface DialogShellProps {
  /** Accessible label for the dialog (aria-label). */
  label: string
  /** Called on backdrop click and on Escape. */
  onClose: () => void
  /**
   * Tailwind width + max-height classes for the card. Defaults match the
   * Mcp/Skills sizing; Logs passes its own wider/taller set. Kept as a
   * className string (not numeric props) so callers can use any Tailwind
   * sizing utility without the shell needing to know the scale.
   */
  sizeClassName?: string
  children: ReactNode
}

const DEFAULT_SIZE =
  'h-[60vh] max-h-[560px] w-[560px] max-w-[calc(100vw-32px)]'

function DialogShellRoot({
  label,
  onClose,
  sizeClassName = DEFAULT_SIZE,
  children
}: DialogShellProps): React.JSX.Element {
  // Global Escape closes the dialog. Each dialog used to wire its own
  // listener; the shell now owns it so the behavior can't drift between
  // dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        // Click-outside-to-close: only when the backdrop itself is the
        // event target, never when a click bubbles up from the card.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={
          'flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.7)] ' +
          sizeClassName
        }
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Header — title + optional subtitle on the left, a close button on the
 * right. Verbatim from the originals.
 */
export interface DialogHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  closeLabel?: string
}

function DialogHeader({
  title,
  subtitle,
  onClose,
  closeLabel = 'Close'
}: DialogHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border px-5 py-3">
      <div>
        <div className="text-[14px] font-semibold text-foreground">{title}</div>
        {subtitle != null && (
          <div className="text-[11px] text-muted-foreground/80">{subtitle}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground/80 transition hover:bg-muted/80 hover:text-foreground"
      >
        ✕
      </button>
    </div>
  )
}

/**
 * Footer — a hairline-topped strip with an `Esc close` hint on the left
 * and an optional muted slot on the right (the originals put the session
 * model name there). Verbatim layout from the originals.
 */
export interface DialogFooterProps {
  /** Localized word after the Esc keycap, e.g. "close" / "关闭". */
  hint: ReactNode
  /** Optional right-aligned muted content (e.g. the model name). */
  trailing?: ReactNode
}

function DialogFooter({
  hint,
  trailing
}: DialogFooterProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-t border-border bg-background/60 px-5 py-2 text-[11px] text-muted-foreground/80">
      <span>
        <Kbd>Esc</Kbd> {hint}
      </span>
      {trailing != null && (
        <span className="truncate font-mono text-muted-foreground/60">
          {trailing}
        </span>
      )}
    </div>
  )
}

/**
 * Kbd — the keycap glyph the dialogs and the inline AskUserQuestion panel
 * each redefined locally. Exported standalone so non-dialog surfaces can
 * reuse it without pulling in the shell.
 */
export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  )
}

/**
 * Public component: the root with `.Header` / `.Footer` attached as static
 * members. Typed via Object.assign so the compound shape is inferred
 * without a hand-written interface that could drift from the parts.
 */
export const DialogShell = Object.assign(DialogShellRoot, {
  Header: DialogHeader,
  Footer: DialogFooter
})
