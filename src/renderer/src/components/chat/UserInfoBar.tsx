import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n, useT, useTFormat } from '../../i18n'
import { useDialogStore } from '../../stores/dialogs'
import { useSettingsStore } from '../../stores/settings'

/**
 * UserInfoBar
 * -----------
 * Bottom rail of the chat sidebar. Two modes:
 *
 *   - Collapsed (default): a single row showing a gear icon + "设置".
 *     The whole row is the click target; pressing it toggles the menu.
 *
 *   - Open: a popup menu floats above the row with a small profile
 *     header (OS username + "本机用户"), a divider, and the actionable
 *     items. The version line lives in the footer of the menu.
 *
 * No real auth: the app talks to Anthropic via whatever credentials
 * the spawned fusion-code child has. The username comes from the
 * preload's `osUser` field which is read once via `os.userInfo()`.
 */
export function UserInfoBar(): React.JSX.Element {
  const t = useT()
  const tf = useTFormat()
  const lang = useI18n((s) => s.lang)
  const setLang = useI18n((s) => s.setLang)
  const openSettings = useSettingsStore((s) => s.openSettings)
  const openDialog = useDialogStore((s) => s.openDialog)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const username =
    typeof window !== 'undefined' && window.chatApi?.osUser
      ? window.chatApi.osUser
      : 'User'
  const version =
    typeof window !== 'undefined' && window.api ? window.api.version : '–'

  // Outside-click + Escape close. Only mounted while the menu is open
  // so we don't pay event-listener cost on idle sidebars.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target || !wrapperRef.current) return
      if (!wrapperRef.current.contains(target)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleOpenTheme = useCallback(() => {
    setOpen(false)
    openSettings()
  }, [openSettings])

  const handleOpenClaudeDir = useCallback(() => {
    setOpen(false)
    window.chatApi.openClaudeDir().then((result) => {
      if (result.error) {
        console.warn('[user-bar] openClaudeDir failed:', result.error)
      }
    })
  }, [])

  const handleOpenLogs = useCallback(() => {
    setOpen(false)
    openDialog('logs')
  }, [openDialog])

  return (
    <div
      ref={wrapperRef}
      className="relative shrink-0 bg-background"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          'flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13px] font-medium text-foreground transition-colors ' +
          (open ? 'bg-muted/70' : 'hover:bg-muted/50')
        }
      >
        <GearIcon className="size-[15px] shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">{t('settings')}</span>
      </button>

      {/* Popup menu — anchored above the bar so it grows up into the
          sidebar instead of clipping under the OS dock. Right edge
          slightly outside the sidebar (translate-x) so the panel
          visually lifts off the rail like the reference design. */}
      {open && (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+6px)] left-2 right-2 z-30 overflow-hidden rounded-2xl border border-border bg-popover py-2 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
        >
          {/* Header — avatar + username + role label. The username
              substitutes for an account email since the app has no
              auth concept. */}
          <div className="flex items-center gap-3 px-3 pb-2 pt-1.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-input text-foreground/80">
              <PersonIcon className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">
                {username || 'User'}
              </div>
              <div className="truncate text-[11px] text-muted-foreground/80">
                {t('localUser')}
              </div>
            </div>
          </div>

          <div className="my-1 h-px bg-muted" />

          {/* Language row — looks like a normal menu item, current
              value sits on the right next to a swap glyph. Clicking
              the whole row toggles between the two languages, since
              with a binary choice that's the fewest taps possible. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            className="group/lang flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted/80"
          >
            <GlobeIcon className="size-[15px] shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{t('language')}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
              <span className="tabular-nums">
                {lang === 'zh' ? '中文' : 'English'}
              </span>
              <SwapIcon className="size-3 text-muted-foreground/80 transition-colors group-hover/lang:text-foreground/80" />
            </span>
          </button>

          <div className="my-1 h-px bg-muted" />

          <MenuItem
            label={t('settings')}
            onSelect={handleOpenTheme}
            icon={<PaletteIcon className="size-[15px]" />}
          />
          <MenuItem
            label={t('openClaudeDir')}
            onSelect={handleOpenClaudeDir}
            icon={<FolderIcon className="size-[15px]" />}
          />
          <MenuItem
            label={t('openLogs')}
            onSelect={handleOpenLogs}
            icon={<LogsIcon className="size-[15px]" />}
          />

          <div className="my-1 h-px bg-muted" />

          <div className="px-3 pb-1 pt-1 text-[11px] text-muted-foreground/80">
            {tf('versionLabel', { version })}
          </div>
        </div>
      )}
    </div>
  )
}

function SwapIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M7 4 3 8l4 4" />
      <path d="M3 8h13" />
      <path d="m17 20 4-4-4-4" />
      <path d="M21 16H8" />
    </svg>
  )
}

function MenuItem({
  label,
  onSelect,
  icon
}: {
  label: string
  onSelect: () => void
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted/80"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}

function GearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function PersonIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function GlobeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function PaletteIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.55 0 1-.45 1-1 0-.27-.11-.52-.29-.71a.99.99 0 0 1-.29-.7c0-.55.45-1 1-1H15a5 5 0 0 0 5-5c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function FolderIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  )
}

function LogsIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="13" y2="16" />
    </svg>
  )
}
