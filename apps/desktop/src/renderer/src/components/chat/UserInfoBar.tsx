import { useCallback } from 'react'

import { useT } from '../../i18n'

/**
 * UserInfoBar
 * -----------
 * The settings entry point, mounted in the shell's tab strip (ShellApp) at
 * the far right of the tab row. It used to be a dropdown menu pinned to the
 * bottom-left of the chat sidebar; it's now a single gear button that opens
 * the settings *modal* directly.
 *
 * The modal is a full-window transparent overlay managed by main (see
 * tabRegistry.openSettingsView), so it works over any tab — chat or web —
 * and renders as a dimmed backdrop + centered card. The dropdown's old
 * items moved into the settings page: language lives under General; the
 * .claude folder / logs / version line were dropped from the chrome (the
 * settings page is now the single home for preferences).
 *
 * `window.tabApi` is available here because the shell window uses the
 * standard preload.
 */
export function UserInfoBar(): React.JSX.Element {
  const t = useT()

  const openSettings = useCallback((): void => {
    void window.tabApi?.openSettingsWindow()
  }, [])

  return (
    <button
      type="button"
      onClick={openSettings}
      title={t('settings')}
      aria-label={t('settings')}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <GearIcon className="size-[15px] shrink-0" />
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
