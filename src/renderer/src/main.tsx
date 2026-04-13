import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Tailwind entrypoint — must come before assets/main.css so our own
// layer rules (window chrome, header) sit on top of Tailwind preflight.
import './index.css'
import './assets/main.css'
import './assets/highlight.css'

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
        root.style.setProperty('--background', bg)
        root.style.setProperty('--card', bg)
        root.style.setProperty('--popover', bg)
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
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
