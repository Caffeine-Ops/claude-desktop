import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Appearance store — drives the Settings → Appearance panel.
 *
 * Single source of truth for theme mode, per-theme color overrides,
 * font sizes, contrast level, translucent sidebar, and the pointer
 * cursor toggle. DOM application lives in `appearance.applier.ts`,
 * not here, so the store stays a pure data container.
 *
 * Color values are stored as `hex` strings (#rrggbb) for two reasons:
 *   1. The native `<input type="color">` picker speaks hex.
 *   2. Hex round-trips cleanly to/from JSON for theme import/export.
 * The applier converts hex → "h s% l%" and writes it onto
 * `document.documentElement.style.--accent` etc., so the existing
 * shadcn-style `bg-accent` / `text-foreground` / `border-border`
 * utilities re-skin instantly without any component re-render.
 */

export type ThemeMode = 'light' | 'dark' | 'system'

const UI_MIN = 11
const UI_MAX = 18
const CODE_MIN = 10
const CODE_MAX = 18

export interface ThemeOverrides {
  presetName: string
  accent: string
  background: string
  foreground: string
  contrast: number
  translucentSidebar: boolean
}

const LIGHT_DEFAULTS: ThemeOverrides = {
  presetName: 'Codex',
  accent: '#3395ff',
  background: '#ffffff',
  foreground: '#1a1c1f',
  contrast: 45,
  translucentSidebar: true
}

const DARK_DEFAULTS: ThemeOverrides = {
  presetName: 'Dracula',
  accent: '#ff79c6',
  background: '#282a36',
  foreground: '#bfbfb2',
  contrast: 0,
  translucentSidebar: false
}

interface AppearanceState {
  themeMode: ThemeMode
  light: ThemeOverrides
  dark: ThemeOverrides
  uiFontSize: number
  codeFontSize: number
  usePointerCursor: boolean
  setThemeMode: (m: ThemeMode) => void
  setUiFontSize: (n: number) => void
  setCodeFontSize: (n: number) => void
  setUsePointerCursor: (v: boolean) => void
  patchTheme: (mode: 'light' | 'dark', patch: Partial<ThemeOverrides>) => void
  resetTheme: (mode: 'light' | 'dark') => void
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(n)))

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      themeMode: 'system',
      light: LIGHT_DEFAULTS,
      dark: DARK_DEFAULTS,
      uiFontSize: 13,
      codeFontSize: 12,
      usePointerCursor: false,
      setThemeMode: (m) => set({ themeMode: m }),
      setUiFontSize: (n) => set({ uiFontSize: clamp(n, UI_MIN, UI_MAX) }),
      setCodeFontSize: (n) =>
        set({ codeFontSize: clamp(n, CODE_MIN, CODE_MAX) }),
      setUsePointerCursor: (v) => set({ usePointerCursor: v }),
      patchTheme: (mode, patch) =>
        set((s) => ({
          [mode]: { ...s[mode], ...patch }
        })),
      resetTheme: (mode) =>
        set({ [mode]: mode === 'light' ? LIGHT_DEFAULTS : DARK_DEFAULTS })
    }),
    {
      name: 'claude-desktop:appearance',
      version: 2,
      // v1 only had themeMode/uiFontSize/codeFontSize/usePointerCursor.
      // Backfill the new theme objects so persisted v1 users don't crash
      // before they touch any color picker.
      migrate: (persisted: unknown, version: number): AppearanceState => {
        const base = (persisted ?? {}) as Partial<AppearanceState>
        if (version < 2) {
          return {
            themeMode: base.themeMode ?? 'system',
            light: LIGHT_DEFAULTS,
            dark: DARK_DEFAULTS,
            uiFontSize: base.uiFontSize ?? 13,
            codeFontSize: base.codeFontSize ?? 12,
            usePointerCursor: base.usePointerCursor ?? false
          } as AppearanceState
        }
        return base as AppearanceState
      }
    }
  )
)

export const APPEARANCE_LIMITS = {
  ui: { min: UI_MIN, max: UI_MAX },
  code: { min: CODE_MIN, max: CODE_MAX }
} as const

export const APPEARANCE_DEFAULTS = {
  light: LIGHT_DEFAULTS,
  dark: DARK_DEFAULTS
} as const

/* ──────────────────── Daemon sync (shared theme) ────────────────────
 *
 * The Open Design daemon is the single source of truth for theme so the
 * desktop shell and the embedded web tab stay in lockstep. The zustand
 * `persist` above is kept purely as an offline cache: on boot the applier
 * renders the cached value immediately (no flash), then `hydrateAppearance
 * FromDaemon()` overwrites it with the daemon copy if the daemon is up.
 * Every subsequent change is pushed back to the daemon (best-effort).
 *
 * The renderer can't reach the daemon directly (its origin isn't on the
 * daemon allow-list), so both directions go through the main-process
 * reverse-proxy IPC: `window.chatApi.getAppearance` / `setAppearance`.
 */

// The shape the daemon stores. Partial mirror of the contracts AppearancePrefs;
// we only declare what we read/write here to avoid coupling to that package.
interface DaemonAppearance {
  themeMode?: ThemeMode
  light?: Partial<ThemeOverrides>
  dark?: Partial<ThemeOverrides>
  uiFontSize?: number
  codeFontSize?: number
  usePointerCursor?: boolean
}

// Guards the subscribe-push below from firing while we're applying the
// daemon's own values back into the store (which would echo them straight
// back to the daemon — harmless but wasteful, and it would race a
// concurrent web-tab edit).
let isHydrating = false

/** Serialize the persisted slice of the store into the daemon shape. */
function snapshotForDaemon(s: AppearanceState): DaemonAppearance {
  return {
    themeMode: s.themeMode,
    light: s.light,
    dark: s.dark,
    uiFontSize: s.uiFontSize,
    codeFontSize: s.codeFontSize,
    usePointerCursor: s.usePointerCursor
  }
}

/**
 * Pull the daemon's appearance and adopt it as the source of truth. Called
 * once from the App root after mount. No-op (keeps the localStorage cache)
 * when the daemon is offline or has nothing stored. Merges per-mode overrides
 * onto the local defaults so a daemon copy missing a field (e.g. written by
 * the web tab, which only sets `accent`) still yields a complete ThemeOverrides.
 */
export async function hydrateAppearanceFromDaemon(): Promise<void> {
  const api = window.chatApi
  if (!api?.getAppearance) return
  let remote: DaemonAppearance | null = null
  try {
    const res = await api.getAppearance()
    remote = res?.appearance ?? null
  } catch {
    remote = null
  }
  if (!remote) return

  isHydrating = true
  try {
    useAppearanceStore.setState((s) => ({
      themeMode: remote.themeMode ?? s.themeMode,
      light: { ...s.light, ...remote.light },
      dark: { ...s.dark, ...remote.dark },
      uiFontSize:
        typeof remote.uiFontSize === 'number'
          ? clamp(remote.uiFontSize, UI_MIN, UI_MAX)
          : s.uiFontSize,
      codeFontSize:
        typeof remote.codeFontSize === 'number'
          ? clamp(remote.codeFontSize, CODE_MIN, CODE_MAX)
          : s.codeFontSize,
      usePointerCursor: remote.usePointerCursor ?? s.usePointerCursor
    }))
  } finally {
    isHydrating = false
  }
}

/**
 * Push the full persisted slice to the daemon. Fire-and-forget — the local
 * store + localStorage are the durable copy, so a failed write just means the
 * daemon was down and the next change retries. We send the whole slice (not a
 * diff) because the store actions don't tell us which field changed; the
 * daemon deep-merges, so a full snapshot is also a safe partial.
 */
function pushAppearanceToDaemon(): void {
  const api = window.chatApi
  if (!api?.setAppearance) return
  const patch = snapshotForDaemon(useAppearanceStore.getState())
  void api.setAppearance({ patch }).catch(() => {
    // Daemon offline; localStorage holds the user's copy for the next push.
  })
}

// Push on every change to a persisted theme field. The applier already reacts
// to the same store for the DOM side; this is the persistence side. Skips the
// echo while hydrating. zustand fires this synchronously after each set().
useAppearanceStore.subscribe(() => {
  if (isHydrating) return
  pushAppearanceToDaemon()
})

/**
 * Convert `#rrggbb` to the `"H S% L%"` string format that CSS variables
 * defined as `hsl(var(--token))` consume. Exported so the applier and
 * boot script can share the same conversion.
 */
export function hexToHslString(hex: string): string {
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
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h *= 60
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}
