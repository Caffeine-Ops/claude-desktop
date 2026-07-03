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
 * Lift (or, on light themes, lower) the lightness of an `"h s% l%"` triplet
 * by `deltaL` percentage points, clamped to [0,100]. Used to derive the
 * floating card/popover surface from the user's chosen canvas color so the
 * two never collapse into one flat plane — mirrors how web's dark palette
 * puts `--bg-panel` (#222120) one shade above `--bg` (#1a1917). Hue and
 * saturation are preserved, so a warm canvas yields a warm card.
 */
function shiftLightness(hsl: string, deltaL: number): string {
  const m = /^(\d+)\s+(\d+)%\s+(\d+)%$/.exec(hsl.trim())
  if (!m) return hsl
  const h = m[1]
  const s = m[2]
  const l = Math.max(0, Math.min(100, Number(m[3]) + deltaL))
  return `${h} ${s}% ${l}%`
}

/**
 * Write a ThemeOverrides set to the root element. Hex colors are
 * converted to "h s% l%" so the existing `hsl(var(--token))` Tailwind
 * mapping keeps working. Contrast crossing 60 toggles the
 * `high-contrast` class which boosts borders / muted text in
 * `index.css`.
 *
 * The chosen `background` drives the canvas (`--background` / `--sidebar`,
 * which sit on the same plane as web's rail), while `--card` and `--popover`
 * are derived as TWO distinct elevation steps above it (lighter in dark,
 * darker in light) — instead of the old behavior that flattened all four to
 * a single hex and made the composer melt into the transcript. The `dark`
 * class is on `<html>` before this runs (apply() toggles it first), so we
 * read it to pick the lift direction.
 */
function applyThemeOverrides(
  root: HTMLElement,
  overrides: ThemeOverrides
): void {
  const accentHsl = hexToHslString(overrides.accent)
  const bgHsl = hexToHslString(overrides.background)
  const fgHsl = hexToHslString(overrides.foreground)
  const isDark = root.classList.contains('dark')
  // Two elevation steps above the canvas so floating surfaces read as
  // distinct planes instead of melting into the page:
  //   --card    : inline cards / message bubbles — one step up
  //   --popover : menus, dialogs AND the composer card (bg-popover/.9) —
  //               two steps up, so the composer clearly lifts off the chat
  //               transcript. On the warm-black canvas a 3% delta was too
  //               faint (the composer looked glued to the conversation); a
  //               6% delta on popover gives it a visible edge even through
  //               the .9 translucency + blur. Light mode goes the other way
  //               (floating surfaces a hair DARKER than the near-white page).
  const cardHsl = shiftLightness(bgHsl, isDark ? 3 : -2)
  const popoverHsl = shiftLightness(bgHsl, isDark ? 6 : -4)

  root.style.setProperty('--accent', accentHsl)
  root.style.setProperty('--primary', accentHsl)
  root.style.setProperty('--ring', accentHsl)
  root.style.setProperty('--background', bgHsl)
  root.style.setProperty('--card', cardHsl)
  root.style.setProperty('--popover', popoverHsl)
  root.style.setProperty('--sidebar', bgHsl)
  root.style.setProperty('--foreground', fgHsl)
  root.style.setProperty('--card-foreground', fgHsl)
  root.style.setProperty('--popover-foreground', fgHsl)
  root.style.setProperty('--sidebar-foreground', fgHsl)

  root.classList.toggle('high-contrast', overrides.contrast >= 60)
  root.classList.toggle('translucent-sidebar', overrides.translucentSidebar)
}
