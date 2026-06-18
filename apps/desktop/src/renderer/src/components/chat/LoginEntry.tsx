import { useCallback } from 'react'

import { useAuthStore } from '../../stores/auth'
import { BrandAvatar, OutlineAvatar } from './AccountAvatars'

/**
 * LoginEntry
 * ----------
 * The single chrome entry at the far right of the shell tab strip. It's the
 * app's only chrome control (the standalone settings gear was removed), and
 * always opens the account menu (AccountMenu) — which holds Settings in both
 * states, plus Login (signed out) or account + Logout (signed in).
 *
 * Signed in it's a **compact chip**: brand avatar + nickname + caret — a
 * single line so the chrome shows *who* is signed in without a bare avatar
 * (the full phone lives in the account menu). Signed out it collapses to an
 * outline avatar + 登录. Identity comes from the auth store (kept in sync with
 * main via AUTH_CHANGED).
 *
 * It's a pure trigger: the 44px strip can't host a dropdown (the tab's native
 * WebContentsView covers everything below it), so clicking routes through
 * window.tabApi.triggerMenuAction('open-account') → main → onShellMenuAction
 * in the active chat tab, whose content view renders the menu right under this
 * chip.
 */
export function LoginEntry(): React.JSX.Element {
  const loggedIn = useAuthStore((s) => s.loggedIn)
  const nickname = useAuthStore((s) => s.nickname)

  const onClick = useCallback((): void => {
    void window.tabApi?.triggerMenuAction('open-account')
  }, [])

  return (
    <button
      type="button"
      onClick={onClick}
      title={loggedIn ? (nickname ?? '账户') : '账户 / 设置'}
      aria-label={loggedIn ? '账户' : '账户与设置'}
      aria-haspopup="menu"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="inline-flex h-8 max-w-[176px] shrink-0 items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      {loggedIn ? <BrandAvatar size={26} /> : <OutlineAvatar size={26} />}

      {loggedIn ? (
        <span className="max-w-[120px] truncate text-[13px] font-semibold text-foreground">
          {nickname ?? '账户'}
        </span>
      ) : (
        <span className="text-[13px] font-medium text-foreground">登录</span>
      )}

      <Caret />
    </button>
  )
}

function Caret(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted-foreground/70"
      aria-hidden
    >
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  )
}
