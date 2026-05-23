import React from 'react'

/**
 * Apple-style notification badge — rounded red pill carrying a
 * numeric count. Mimics the iOS / macOS unread-badge affordance:
 *
 * - Bright iOS red (approx `#ff3b30`) fill
 * - White, medium-weight tabular number (no font jitter between 1
 *   and 11 as the count changes)
 * - Min size 18×18 px so a single-digit count reads as a circle;
 *   larger counts stretch horizontally into a pill
 * - Numbers above 99 collapse to `"99+"` — same cap iOS uses
 * - Soft drop shadow + configurable outer ring (`ringClassName`)
 *   so callers can tint the hollow outline to the surface they're
 *   floating over (sidebar material, tab toolbar, etc.) — gives
 *   the "badge is lifted off the background" look from Settings.app
 *
 * Not interactive on its own (`pointer-events-none`): clicking the
 * underlying row still routes through whatever handler owns it.
 *
 * Used in:
 *   - ThreadListSidebar rows: per-session pending-permission count
 *   - TabBar pills: per-workspace aggregate count across all
 *     sessions in that tab's engine
 */
export function NotificationBadge({
  count,
  className,
  ringClassName
}: {
  count: number
  className?: string
  ringClassName?: string
}): React.JSX.Element {
  const label = count > 99 ? '99+' : String(count)
  return (
    <span
      aria-label={`${count} pending`}
      className={
        'pointer-events-none flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#ff3b30] px-1.5 text-[10.5px] font-semibold leading-none text-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] tabular-nums ring-2 ' +
        (ringClassName ?? 'ring-[hsl(var(--sidebar))]') +
        (className ? ' ' + className : '')
      }
    >
      {label}
    </span>
  )
}
