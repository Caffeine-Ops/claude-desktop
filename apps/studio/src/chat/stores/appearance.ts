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

// Background art (wallpaper). Sits alongside light/dark, not inside them —
// one image serves both modes; the applier derives veil opacity from the
// semantic --card/--sidebar tokens at apply time, so it repaints for free
// when themeMode flips. themeId null = feature off (default), which must
// render byte-identical to pre-feature output.
export interface BackgroundThemeState {
  themeId: string | null
  /** Veil strength, 0-100. */
  scrim: number
  /** 0-1 focal point override; unset falls back to the theme's analyzed focus. */
  focusX?: number
  focusY?: number
}

const BACKGROUND_DEFAULTS: BackgroundThemeState = {
  themeId: null,
  scrim: 55
}

// Light defaults aligned 1:1 with the shared design tokens
// (packages/design-tokens/tokens.css): canvas `--background` #f5f5f7
// (Apple's signature off-white gray), foreground #1d1d1f, accent Apple
// Blue #0071e3. The OLD default was a pure-white canvas (#ffffff) — the
// applier then had nowhere brighter to lift card/popover, so it pushed
// them DARKER, inverting the token design (gray page, white floating
// cards) into "white page, gray cards": the rail lost its tint and the
// chat card lost its float. Persist v4 migrates the stale default.
const LIGHT_DEFAULTS: ThemeOverrides = {
  presetName: 'Apple Light',
  accent: '#0071e3',
  background: '#f5f5f7',
  foreground: '#1d1d1f',
  contrast: 45,
  translucentSidebar: true
}

// Dark defaults aligned 1:1 with the web app's dark palette
// (apps/web/src/index.css `[data-theme="dark"]`): warm-black canvas
// `--bg` #1a1917, warm off-white text `--text` #e8e4dc, and the Apple
// Bright Blue dark accent #2997ff (web's `--accent: hsl(210 100% 58%)`).
// The applier derives the lifted card/popover surfaces from `background`
// (one shade warmer), so picking this canvas reproduces web's
// background↔card hierarchy without storing every surface here.
const DARK_DEFAULTS: ThemeOverrides = {
  presetName: 'Warm Black',
  accent: '#2997ff',
  background: '#1a1917',
  foreground: '#e8e4dc',
  contrast: 0,
  translucentSidebar: false
}

// Fingerprint of the pre-v3 cool "Dracula" dark default. Used both by the
// persist migration and the daemon hydrate to replace ONLY the stale default
// with the new warm-black one — a user who picked some other custom dark
// color won't match this and is left untouched.
function isStaleDarkDefault(d: Partial<ThemeOverrides> | undefined): boolean {
  if (!d) return false
  return (
    d.presetName === 'Dracula' ||
    d.background?.toLowerCase() === '#282a36' ||
    d.accent?.toLowerCase() === '#ff79c6'
  )
}

// Fingerprint of the pre-v4 pure-white light default ("Codex", #ffffff
// canvas). Same replace-only-the-stale-default contract as the dark
// fingerprint above: a user who picked their own light background won't
// match and is left untouched.
function isStaleLightDefault(d: Partial<ThemeOverrides> | undefined): boolean {
  if (!d) return false
  return (
    d.presetName === 'Codex' ||
    (d.background?.toLowerCase() === '#ffffff' &&
      d.accent?.toLowerCase() === '#3395ff')
  )
}

interface AppearanceState {
  themeMode: ThemeMode
  light: ThemeOverrides
  dark: ThemeOverrides
  uiFontSize: number
  codeFontSize: number
  usePointerCursor: boolean
  background: BackgroundThemeState
  setThemeMode: (m: ThemeMode) => void
  setUiFontSize: (n: number) => void
  setCodeFontSize: (n: number) => void
  setUsePointerCursor: (v: boolean) => void
  patchTheme: (mode: 'light' | 'dark', patch: Partial<ThemeOverrides>) => void
  resetTheme: (mode: 'light' | 'dark') => void
  /** Switching themes clears any focus override — it belonged to the old image. */
  setBackgroundTheme: (themeId: string | null) => void
  setBackgroundScrim: (n: number) => void
  setBackgroundFocus: (focus: { x: number; y: number } | null) => void
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
      background: BACKGROUND_DEFAULTS,
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
        set({ [mode]: mode === 'light' ? LIGHT_DEFAULTS : DARK_DEFAULTS }),
      setBackgroundTheme: (themeId) =>
        set((s) => ({
          background: { ...s.background, themeId, focusX: undefined, focusY: undefined }
        })),
      setBackgroundScrim: (n) =>
        set((s) => ({ background: { ...s.background, scrim: clamp(n, 0, 100) } })),
      setBackgroundFocus: (focus) =>
        set((s) => ({
          background: { ...s.background, focusX: focus?.x, focusY: focus?.y }
        }))
    }),
    {
      name: 'claude-desktop:appearance',
      version: 5,
      // v1 only had themeMode/uiFontSize/codeFontSize/usePointerCursor.
      // Backfill the new theme objects so persisted v1 users don't crash
      // before they touch any color picker.
      //
      // v3: the dark default flipped from the old cool "Dracula" palette
      // (#282a36 canvas, pink accent) to the warm-black palette shared with
      // the web app. Anyone still on the OLD dark default must be reset to
      // the new one so desktop matches web; users who deliberately picked a
      // custom dark color are left alone (only the stale default is replaced).
      //
      // v4: the light default flipped from the pure-white "Codex" canvas to
      // the token-aligned Apple off-white (#f5f5f7) so the gray-page /
      // white-floating-card hierarchy from design-tokens actually renders.
      // Same stale-fingerprint contract as v3.
      //
      // v5: added `background` (wallpaper). Not strictly required for
      // zustand's default merge (spreading the initial-state default over a
      // persisted object missing the key is already a no-op preserving the
      // default) — bumped anyway to leave an explicit trail matching v1-v4,
      // and because the version<2 branch below constructs a full object by
      // hand and would otherwise silently omit the field.
      migrate: (persisted: unknown, version: number): AppearanceState => {
        const base = (persisted ?? {}) as Partial<AppearanceState>
        if (version < 2) {
          return {
            themeMode: base.themeMode ?? 'system',
            light: LIGHT_DEFAULTS,
            dark: DARK_DEFAULTS,
            uiFontSize: base.uiFontSize ?? 13,
            codeFontSize: base.codeFontSize ?? 12,
            usePointerCursor: base.usePointerCursor ?? false,
            background: BACKGROUND_DEFAULTS
          } as AppearanceState
        }
        let next = base
        if (version < 3 && isStaleDarkDefault(next.dark)) {
          next = { ...next, dark: DARK_DEFAULTS }
        }
        if (version < 4 && isStaleLightDefault(next.light)) {
          next = { ...next, light: LIGHT_DEFAULTS }
        }
        if (version < 5 && !next.background) {
          next = { ...next, background: BACKGROUND_DEFAULTS }
        }
        return next as AppearanceState
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
  background?: Partial<BackgroundThemeState>
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
    usePointerCursor: s.usePointerCursor,
    background: s.background
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

  // The daemon may still hold a pre-migration default (the local persist
  // migration only fixes localStorage, not the daemon copy that gets adopted
  // here): the pre-v3 cool "Dracula" dark, or the pre-v4 pure-white light.
  // If so, drop that remote slice and keep our new default, then push it back
  // so the daemon — and every surface that shares it — converge. Only stale
  // defaults are overridden; a genuinely custom color won't match either
  // fingerprint.
  const remoteDarkIsStale = isStaleDarkDefault(remote.dark)
  const remoteLightIsStale = isStaleLightDefault(remote.light)

  isHydrating = true
  try {
    useAppearanceStore.setState((s) => ({
      themeMode: remote.themeMode ?? s.themeMode,
      light: remoteLightIsStale ? LIGHT_DEFAULTS : { ...s.light, ...remote.light },
      dark: remoteDarkIsStale ? DARK_DEFAULTS : { ...s.dark, ...remote.dark },
      uiFontSize:
        typeof remote.uiFontSize === 'number'
          ? clamp(remote.uiFontSize, UI_MIN, UI_MAX)
          : s.uiFontSize,
      codeFontSize:
        typeof remote.codeFontSize === 'number'
          ? clamp(remote.codeFontSize, CODE_MIN, CODE_MAX)
          : s.codeFontSize,
      usePointerCursor: remote.usePointerCursor ?? s.usePointerCursor,
      background: remote.background ? { ...s.background, ...remote.background } : s.background
    }))
  } finally {
    isHydrating = false
  }

  // If we just replaced a stale daemon default, persist the new one back so
  // the daemon stops serving the old palette on the next boot. Done outside
  // the isHydrating guard so the push actually fires.
  if (remoteDarkIsStale || remoteLightIsStale) pushAppearanceToDaemon()
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
  void api.setAppearance({ patch })
    .then(() => {
      // 反向同 document 桥：chat 入口改了主题也要告诉同 webContents 的
      // canvas 面——main 的 APPEARANCE_CHANGED 广播按 skip-sender 跳过本
      // webContents，「同屋对面」收不到 IPC（正向坑见 canvas/state/
      // config.ts syncConfigToDaemon 的注释，2026-07-04 暗色花斑事故）。
      // canvas 的既有 repull 监听（canvas/App.tsx）收到后 fetchDaemonConfig
      // 采纳 themeMode——否则 canvas config.theme 停旧值，之后任何 canvas
      // 侧 re-apply（设置页关闭回滚等）会把双标记打回旧主题，反向花斑。
      // 只在写入真正成功后 dispatch；repull merge 无变化即 no-op，无回声。
      window.dispatchEvent(new CustomEvent('od:appearance-changed'))
    })
    .catch(() => {
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
