import { useEffect } from 'react'

import {
  hexToHslString,
  type ThemeOverrides,
  useAppearanceStore
} from './appearance'

/**
 * Single applier for the appearance store. Mounted once at the App
 * root, it owns every DOM mutation derived from the store: toggling
 * the `dark` / `pointer-cursor` / `high-contrast` / `translucent-sidebar`
 * classes on `<html>`, writing per-theme color overrides onto
 * `documentElement.style` (which `bg-accent` / `text-foreground` /
 * `border-border` etc. read through `hsl(var(--token))`), and the
 * `--ui-font-size` / `--code-font-size` CSS variables.
 *
 * Centralising side-effects here keeps components free of theming
 * effects and gives a single seam if we later route through Electron's
 * `nativeTheme` instead of `matchMedia`.
 */
export function useApplyAppearance(): void {
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const light = useAppearanceStore((s) => s.light)
  const dark = useAppearanceStore((s) => s.dark)
  const uiFontSize = useAppearanceStore((s) => s.uiFontSize)
  const codeFontSize = useAppearanceStore((s) => s.codeFontSize)
  const usePointerCursor = useAppearanceStore((s) => s.usePointerCursor)

  // Theme class — resolves 'system' against prefers-color-scheme and
  // re-resolves on OS changes only when the user is in 'system' mode.
  // After settling on the effective mode we apply that mode's color
  // overrides so accent / background / foreground / contrast /
  // translucent-sidebar pick up automatically.
  useEffect(() => {
    const apply = (isDark: boolean): void => {
      const root = document.documentElement
      root.classList.toggle('dark', isDark)
      applyThemeOverrides(root, isDark ? dark : light)
    }

    if (themeMode !== 'system') {
      apply(themeMode === 'dark')
      return
    }

    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    apply(mql.matches)
    const handler = (e: MediaQueryListEvent): void => apply(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [themeMode, light, dark])

  // Font size CSS variables. Tailwind absolute sizes still win on
  // pinned elements; this only moves body / unpinned text.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--ui-font-size',
      `${uiFontSize}px`
    )
  }, [uiFontSize])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--code-font-size',
      `${codeFontSize}px`
    )
  }, [codeFontSize])

  // Pointer-cursor mode — see index.css for the rules it gates.
  useEffect(() => {
    document.documentElement.classList.toggle(
      'pointer-cursor',
      usePointerCursor
    )
  }, [usePointerCursor])
}

/**
 * Write a ThemeOverrides set to the root element. Hex colors are
 * converted to "h s% l%" so the existing `hsl(var(--token))` Tailwind
 * mapping keeps working. Contrast crossing 60 toggles the
 * `high-contrast` class which boosts borders / muted text in
 * `index.css`.
 */
function applyThemeOverrides(
  root: HTMLElement,
  overrides: ThemeOverrides
): void {
  const accentHsl = hexToHslString(overrides.accent)
  const bgHsl = hexToHslString(overrides.background)
  const fgHsl = hexToHslString(overrides.foreground)

  root.style.setProperty('--accent', accentHsl)
  root.style.setProperty('--primary', accentHsl)
  root.style.setProperty('--ring', accentHsl)
  root.style.setProperty('--background', bgHsl)
  root.style.setProperty('--card', bgHsl)
  root.style.setProperty('--popover', bgHsl)
  root.style.setProperty('--sidebar', bgHsl)
  root.style.setProperty('--foreground', fgHsl)
  root.style.setProperty('--card-foreground', fgHsl)
  root.style.setProperty('--popover-foreground', fgHsl)
  root.style.setProperty('--sidebar-foreground', fgHsl)

  root.classList.toggle('high-contrast', overrides.contrast >= 60)
  root.classList.toggle('translucent-sidebar', overrides.translucentSidebar)
}
