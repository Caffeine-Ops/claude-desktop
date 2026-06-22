import { useEffect, useRef, useState } from 'react'

import { useDialogStore } from '../../stores/dialogs'
import { useAuthStore } from '../../stores/auth'
import { BrandAvatar, OutlineAvatar } from './AccountAvatars'

/**
 * AccountMenu
 * -----------
 * The top-right chrome menu, opened by the shell chip (LoginEntry) via the
 * `open-account` shell-menu action. It's the app's single chrome entry point
 * now that the standalone settings gear is gone, so it carries Settings in
 * BOTH states:
 *
 *  - **signed out** → 登录 / 设置
 *  - **signed in**  → identity header (avatar · nickname · phone · 已登录) with
 *    inline nickname editing, then 账户设置 / 退出登录
 *
 * Why it lives in the chat renderer (not the shell): the shell tab strip is
 * 44px tall and the active tab's native WebContentsView covers everything
 * below it, so a dropdown in the shell DOM is clipped. This renderer's content
 * view fills the area under the strip, so a popover pinned to its top-right
 * corner appears right under the chip. A transparent (undimmed) backdrop
 * catches the outside click so it dismisses like a dropdown.
 */
export function AccountMenu(): React.JSX.Element | null {
  const open = useDialogStore((s) => s.open === 'account')
  const close = useDialogStore((s) => s.closeDialog)
  const openDialog = useDialogStore((s) => s.openDialog)
  const phone = useAuthStore((s) => s.phone)
  const nickname = useAuthStore((s) => s.nickname)
  const loggedIn = useAuthStore((s) => s.loggedIn)
  const logout = useAuthStore((s) => s.logout)
  const setNickname = useAuthStore((s) => s.setNickname)

  const [editing, setEditing] = useState(false)
  // 退出登录是 destructive 且不可一键撤销，但入口是个 dropdown——弹独立全屏
  // modal 会脱离 dropdown 语境、显得突兀，所以改为「菜单内就地二次确认」：
  // 点「退出登录」先切到确认视图（取消/确认），确认后才真正 logout。
  const [confirmingLogout, setConfirmingLogout] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards the commit/cancel path: leaving edit mode (Enter / Escape) unmounts
  // the input, which fires onBlur — without this flag that blur would re-run
  // commitEdit (double setNickname / double backend write), and an Escape would
  // *commit* the draft via blur instead of discarding it. First settle wins.
  const settledRef = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || editing) return
      // Escape 优先收起确认视图（退一步），没有确认时才关菜单。
      if (confirmingLogout) setConfirmingLogout(false)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, editing, confirmingLogout])

  // Reset transient affordances whenever the menu closes.
  useEffect(() => {
    if (!open) {
      setEditing(false)
      setConfirmingLogout(false)
    }
  }, [open])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  if (!open) return null

  const startEdit = (): void => {
    settledRef.current = false
    setDraft(nickname ?? '')
    setEditing(true)
  }
  const commitEdit = (): void => {
    if (settledRef.current) return // already settled (Enter/Escape) — ignore blur echo
    settledRef.current = true
    setNickname(draft)
    setEditing(false)
  }
  // Discard the draft and leave edit mode. The follow-up onBlur sees the guard
  // set and no-ops, so Escape truly cancels instead of committing via blur.
  const cancelEdit = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    setEditing(false)
  }

  return (
    // Transparent backdrop — undimmed so it reads as a dropdown, not a modal.
    <div
      className="fixed inset-0 z-[70]"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="menu"
        className="absolute right-3 top-2 w-64 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-[0_18px_50px_-20px_rgba(0,0,0,0.5),0_6px_16px_-10px_rgba(0,0,0,0.35)] [animation:account-pop_.16s_cubic-bezier(.16,1,.3,1)_both]"
      >
        {/* header */}
        <div className="relative flex items-center gap-3 px-4 pb-3.5 pt-4">
          {/* faint brand wash behind the identity, signed-in only */}
          {loggedIn && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(130px 70px at 16% 0%, hsl(var(--chip-mention) / 0.07), transparent 70%)'
              }}
            />
          )}
          {loggedIn ? <BrandAvatar size={42} /> : <OutlineAvatar size={42} />}

          <div className="relative flex min-w-0 flex-col gap-1">
            {loggedIn ? (
              editing ? (
                <input
                  ref={inputRef}
                  value={draft}
                  maxLength={24}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      cancelEdit()
                    }
                  }}
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-[14px] font-semibold text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                  placeholder="输入昵称"
                />
              ) : (
                <button
                  type="button"
                  onClick={startEdit}
                  title="点击修改昵称"
                  className="group flex items-center gap-1.5 text-left"
                >
                  <span className="truncate text-[14.5px] font-semibold text-foreground">
                    {nickname ?? '账户'}
                  </span>
                  <PencilIcon className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                </button>
              )
            ) : (
              <span className="text-[14.5px] font-semibold text-foreground">
                未登录
              </span>
            )}

            <span className="truncate text-[12px] tabular-nums text-muted-foreground">
              {loggedIn ? `+86 ${phone ?? ''}` : '登录以同步账户'}
            </span>

            {loggedIn && (
              <span
                className="mt-0.5 inline-flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                style={{
                  color: 'hsl(var(--chip-mention))',
                  background: 'hsl(var(--chip-mention) / 0.12)'
                }}
              >
                <span
                  className="size-[5px] rounded-full"
                  style={{ background: 'hsl(var(--chip-mention))' }}
                />
                已登录
              </span>
            )}
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* items */}
        <div className="p-1.5">
          {loggedIn ? (
            confirmingLogout ? (
              <div className="px-2 pb-1 pt-1.5">
                <p className="text-[13px] font-medium text-foreground">
                  确定要退出登录吗？
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  退出后需要重新登录才能继续同步账户。
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingLogout(false)}
                    className="flex-1 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06]"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    autoFocus
                    onClick={() => {
                      close()
                      logout()
                    }}
                    className="flex-1 rounded-lg bg-destructive px-3 py-1.5 text-[13px] font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90"
                  >
                    退出登录
                  </button>
                </div>
              </div>
            ) : (
              <>
                <MenuItem
                  icon={<GearIcon />}
                  label="账户设置"
                  onClick={() => {
                    close()
                    void window.tabApi?.openSettingsWindow()
                  }}
                />
                <MenuItem
                  icon={<LogoutIcon />}
                  label="退出登录"
                  destructive
                  onClick={() => setConfirmingLogout(true)}
                />
              </>
            )
          ) : (
            <>
              <MenuItem
                icon={<LoginIcon />}
                label="登录"
                onClick={() => openDialog('login')}
              />
              <MenuItem
                icon={<GearIcon />}
                label="设置"
                onClick={() => {
                  close()
                  void window.tabApi?.openSettingsWindow()
                }}
              />
            </>
          )}
        </div>
      </div>

      {/* tiny pop-in keyframe, scoped via a style tag so it ships with the
          component (Tailwind has no built-in for this exact curve). */}
      <style>{`@keyframes account-pop{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}`}</style>
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ' +
        (destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-foreground/[0.06]')
      }
    >
      <span className="shrink-0 opacity-75">{icon}</span>
      {label}
    </button>
  )
}

function iconProps(): React.SVGProps<SVGSVGElement> {
  return {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }
}

function PencilIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg {...iconProps()} aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function LogoutIcon(): React.JSX.Element {
  return (
    <svg {...iconProps()} aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function LoginIcon(): React.JSX.Element {
  return (
    <svg {...iconProps()} aria-hidden>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  )
}
