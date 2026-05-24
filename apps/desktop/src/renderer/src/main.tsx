import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ShellApp from './shell/ShellApp'
// Tailwind entrypoint — must come before assets/main.css so our own
// layer rules (window chrome, header) sit on top of Tailwind preflight.
import './index.css'
import './assets/main.css'
import './assets/highlight.css'

/**
 * The shell BrowserWindow loads this same renderer bundle with
 * `?shell=1` — it mounts an empty component just to keep the shell
 * webContents alive. The tab bar used to live in the shell but now
 * renders inline inside each tab's workspace header, so the shell
 * UI is intentionally blank.
 */
const search =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams()
const isShell = search.get('shell') === '1'
// Note: the settings modal is NOT a renderer-bundle route. It's the Open
// Design web app loaded with `?settings=1` inside a full-window overlay
// WebContentsView (see desktop tabRegistry.openSettingsView + apps/web
// App.tsx). So this bundle only ever renders the shell strip or a chat tab.

// FOUC prevention: read the persisted appearance state synchronously
// before React mounts, so the right `dark` class and per-theme color
// overrides are on `<html>` from the very first paint. The full
// applier (in stores/appearance.applier.ts) is the long-lived source
// of truth — this is just an early mirror of the same logic so the
// window doesn't flash dark before the React tree renders light (or
// vice versa).
;(function bootAppearance(): void {
  try {
    const raw = localStorage.getItem('claude-desktop:appearance')
    if (!raw) {
      // No persisted choice — default to system mode and let the
      // applier resolve once it mounts. Pre-set the class to match
      // current system to avoid a flash.
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.classList.toggle('dark', sysDark)
      return
    }
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> }
    const state = parsed.state ?? {}
    const themeMode = (state.themeMode as string) ?? 'system'
    const isDark =
      themeMode === 'dark' ||
      (themeMode === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    const root = document.documentElement
    root.classList.toggle('dark', isDark)

    const overrides = (isDark ? state.dark : state.light) as
      | Record<string, unknown>
      | undefined
    if (overrides && typeof overrides === 'object') {
      const accent = overrides.accent as string | undefined
      const background = overrides.background as string | undefined
      const foreground = overrides.foreground as string | undefined
      const contrast = overrides.contrast as number | undefined
      const translucent = overrides.translucentSidebar as boolean | undefined
      if (accent) {
        const a = hexToHsl(accent)
        root.style.setProperty('--accent', a)
        root.style.setProperty('--primary', a)
        root.style.setProperty('--ring', a)
      }
      if (background) {
        const bg = hexToHsl(background)
        // Mirror the applier: canvas = chosen bg; card one elevation step up,
        // popover (menus + the composer card) two steps up, so floating
        // surfaces read as distinct planes instead of flattening to one hex.
        const card = shiftL(bg, isDark ? 3 : -2)
        const popover = shiftL(bg, isDark ? 6 : -4)
        root.style.setProperty('--background', bg)
        root.style.setProperty('--card', card)
        root.style.setProperty('--popover', popover)
        root.style.setProperty('--sidebar', bg)
      }
      if (foreground) {
        const fg = hexToHsl(foreground)
        root.style.setProperty('--foreground', fg)
        root.style.setProperty('--card-foreground', fg)
        root.style.setProperty('--popover-foreground', fg)
        root.style.setProperty('--sidebar-foreground', fg)
      }
      if (typeof contrast === 'number') {
        root.classList.toggle('high-contrast', contrast >= 60)
      }
      if (typeof translucent === 'boolean') {
        root.classList.toggle('translucent-sidebar', translucent)
      }
    }

    const ui = state.uiFontSize as number | undefined
    const code = state.codeFontSize as number | undefined
    if (typeof ui === 'number') {
      root.style.setProperty('--ui-font-size', `${ui}px`)
    }
    if (typeof code === 'number') {
      root.style.setProperty('--code-font-size', `${code}px`)
    }
    if (state.usePointerCursor === true) {
      root.classList.add('pointer-cursor')
    }
  } catch (err) {
    // Boot must never throw — if the store is corrupt, fall through
    // to whatever defaults index.css declared.
    console.warn('[boot] appearance restore failed', err)
  }

  function hexToHsl(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return '0 0% 0%'
    const int = parseInt(m[1], 16)
    const r = ((int >> 16) & 0xff) / 255
    const g = ((int >> 8) & 0xff) / 255
    const b = (int & 0xff) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    let h = 0
    let s = 0
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 60
    }
    return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
  }

  // Lift/lower the lightness of an "h s% l%" triplet — mirror of the
  // applier's shiftLightness (boot is a standalone IIFE so it can't import).
  function shiftL(hsl: string, deltaL: number): string {
    const mm = /^(\d+)\s+(\d+)%\s+(\d+)%$/.exec(hsl.trim())
    if (!mm) return hsl
    const ll = Math.max(0, Math.min(100, Number(mm[3]) + deltaL))
    return `${mm[1]} ${mm[2]}% ${ll}%`
  }
})()

// Platform tag — so CSS can conditionally reserve the traffic-light
// gutter on macOS. `window.electron.process.platform` comes from
// @electron-toolkit/preload (see src/preload/index.ts). We mirror it
// onto `<html>` as a data attribute early — before React mounts — so
// the very first paint of .header already has the correct padding
// and doesn't shift after the first effect runs.
;(function bootPlatform(): void {
  try {
    const p = window.electron?.process?.platform
    if (p) document.documentElement.dataset.platform = p
  } catch (err) {
    console.warn('[boot] platform detection failed', err)
  }
})()

// Fullscreen hydration + live subscription. On macOS the traffic-light
// buttons slide out of the window chrome when the user fullscreens,
// so reserving 82px for them leaves a visible dead zone on the left.
// We flip `data-fullscreen` on <html> and let the CSS below collapse
// the gutter. Electron's own `display-mode: fullscreen` media query
// is unreliable for `BrowserWindow.setFullScreen` (Chromium only
// reports display-mode for `element.requestFullscreen`), so the
// source of truth is an IPC broadcast driven by the shell window's
// enter-/leave-full-screen events.
;(function bootFullscreen(): void {
  if (typeof window === 'undefined' || !window.tabApi) return
  const apply = (fullscreen: boolean): void => {
    if (fullscreen) {
      document.documentElement.dataset.fullscreen = 'true'
    } else {
      delete document.documentElement.dataset.fullscreen
    }
  }
  // Initial hydrate — the window might already be in fullscreen when
  // the tab was created (e.g. opening a new tab while the app is
  // fullscreened). This is a one-shot IPC and returns ~immediately.
  window.tabApi.getFullscreen().then(apply).catch((err) => {
    console.warn('[boot] getFullscreen failed', err)
  })
  // Live subscription — tabRegistry broadcasts on every enter/leave.
  // No unsubscribe needed; this listener lives for the process lifetime.
  window.tabApi.onFullscreenChanged(apply)
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isShell ? (
      <ShellApp />
    ) : (
      <App />
    )}
  </React.StrictMode>
)
