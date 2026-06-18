/**
 * AccountAvatars
 * --------------
 * The two account marks, shared so the brand glyph/colors live in ONE place
 * and the shell login chip (LoginEntry) and the account-menu header
 * (AccountMenu) can't drift:
 *
 *  - <BrandAvatar>  — deep-ink disc + terracotta cross, the signed-in mark.
 *  - <OutlineAvatar> — neutral person glyph, the signed-out mark.
 *
 * `size` drives the disc; the inner SVG scales from it. The cross's stroke is
 * in viewBox units, so it stays proportional across sizes automatically. The
 * brand disc carries `relative` so it can stack above an absolutely-positioned
 * sibling wash (see AccountMenu's header) — harmless where there's no wash.
 */

/** Deep-ink disc carrying the brand terracotta cross — the signed-in mark. */
export function BrandAvatar({
  size = 32,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={'relative grid shrink-0 place-items-center rounded-full ' + className}
      style={{
        width: size,
        height: size,
        background: 'linear-gradient(150deg, #2a2520, #15110d)'
      }}
    >
      <svg
        width={size * 0.55}
        height={size * 0.55}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#db6a38"
        strokeWidth="2.3"
        strokeLinecap="round"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
        <line x1="7.05" y1="7.05" x2="16.95" y2="16.95" />
        <line x1="16.95" y1="7.05" x2="7.05" y2="16.95" />
      </svg>
    </span>
  )
}

/** Neutral outline avatar (person glyph) — the signed-out mark. */
export function OutlineAvatar({
  size = 32,
  className = ''
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={
        'grid shrink-0 place-items-center rounded-full border border-border bg-muted text-muted-foreground ' +
        className
      }
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.58}
        height={size * 0.58}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </svg>
    </span>
  )
}
