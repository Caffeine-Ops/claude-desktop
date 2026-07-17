import { useEffect } from 'react'

import {
  useBackgroundArtStore,
  resolveBackgroundTheme,
  isUserBackgroundTheme
} from '@/src/stores/backgroundArt'
import { useAppearanceStore } from './appearance'
import { toBgAssetUrl } from '../lib/bgAssetUrl'

/** Read by the boot script (app/layout.tsx) to repaint the wallpaper before
 * React mounts — same "cache the resolved CSS values, not the raw prefs"
 * contract as THEME_BOOT_SCRIPT's `claude-desktop:appearance` cache. */
const CACHE_KEY = 'claude-desktop:bg-art'

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

interface BgArtCache {
  id: string
  url: string
  posX: number
  posY: number
  weak: number
  mid: number
  strong: number
}

function writeCache(cache: BgArtCache | null): void {
  try {
    if (cache) localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
    else localStorage.removeItem(CACHE_KEY)
  } catch {
    // Storage unavailable/full — boot just won't replay a wallpaper next
    // launch; this session's applier still renders correctly regardless.
  }
}

const BG_ART_VARS = [
  '--bg-art-url',
  '--bg-art-pos-x',
  '--bg-art-pos-y',
  '--bg-art-veil-weak',
  '--bg-art-veil-mid',
  '--bg-art-veil-strong'
]

function clearBackgroundArt(): void {
  const root = document.documentElement
  root.removeAttribute('data-bg-art')
  for (const name of BG_ART_VARS) root.style.removeProperty(name)
  writeCache(null)
}

/**
 * Zero-DOM writer for the background-art (wallpaper) feature — same
 * "documentElement inline token" pattern as appearance.applier.ts, mounted
 * alongside it in AppearanceBridge (SurfaceHost, keep-alive immune). Resolves
 * `background.themeId` to a BackgroundThemeMeta (presets are a static
 * import; user themes need the async listBackgroundThemes() pull, hence the
 * separate refresh effect below), derives the wallpaper URL + focus point +
 * three veil-alpha tiers, and writes them as `data-bg-art` + `--bg-art-*`.
 * `background-art.css` is entirely gated on `[data-bg-art]`'s presence, so
 * `themeId: null` (the default) clears every trace and renders
 * byte-identical to a build without this feature.
 */
export function useApplyBackgroundArt(): void {
  const background = useAppearanceStore((s) => s.background)
  const userThemes = useBackgroundArtStore((s) => s.userThemes)

  // Presets resolve instantly (static import); a `u-*` themeId needs this
  // list loaded at least once. Fired on every mount of AppearanceBridge —
  // cheap (local IPC, no network) and keeps the picker in Settings fresh
  // too since both read the same store.
  useEffect(() => {
    void useBackgroundArtStore.getState().refreshUserThemes()
  }, [])

  useEffect(() => {
    const { themeId, scrim, focusX, focusY } = background
    if (!themeId) {
      clearBackgroundArt()
      return
    }
    const meta = resolveBackgroundTheme(themeId)
    if (!meta) {
      // Not resolvable yet (user-theme list still loading) or it was
      // deleted mid-session — render nothing rather than a broken
      // background-image url(). The userThemes dependency below re-runs
      // this once the list lands.
      clearBackgroundArt()
      return
    }

    const rawUrl = isUserBackgroundTheme(meta.id) ? toBgAssetUrl(meta.file) : meta.file
    const cssUrl = `url("${rawUrl}")`

    // Luminance only nudges the veil baseline — never the theme mode itself
    // (that stays whatever appearance.applier.ts already resolved). A bright
    // photo needs a touch more coverage to keep foreground text legible; a
    // dark one can show through more without help.
    //
    // Coefficients must all stay <=1 (2026-07-17 fix): the first cut used
    // 0.8/1.25/1.45 with a 0.82 floor on `strong`, which saturated `mid` and
    // `strong` to a fully-opaque 1.0 well before the scrim slider reached
    // its own max (real device test: scrim=83 already produced weak=.744,
    // mid=1, strong=1 — the wallpaper was completely hidden, not just
    // dimmed). `mid`/`strong` coefficients >1 mean `base*coef` can exceed 1
    // long before `base` (scrim/100) does, silently killing the top ~20-30%
    // of the slider's range and making the default (scrim=55) already too
    // opaque. Keeping every coefficient <=1 guarantees the photo stays at
    // least partially visible across the whole 0-100 range; only an
    // intentional scrim=100 + a bright photo pushes `strong` close to fully
    // opaque.
    const base = clamp01(scrim / 100)
    const nudge = meta.luminance > 0.6 ? 0.08 : meta.luminance < 0.3 ? -0.04 : 0
    const weak = clamp01(base * 0.5 + nudge)
    const mid = clamp01(base * 0.75 + nudge)
    const strong = clamp01(Math.max(0.5, base * 0.85 + nudge))
    const posX = clamp01(focusX ?? meta.focus.x) * 100
    const posY = clamp01(focusY ?? meta.focus.y) * 100

    const commit = (): void => {
      const root = document.documentElement
      root.setAttribute('data-bg-art', meta.id)
      root.style.setProperty('--bg-art-url', cssUrl)
      root.style.setProperty('--bg-art-pos-x', `${posX}%`)
      root.style.setProperty('--bg-art-pos-y', `${posY}%`)
      root.style.setProperty('--bg-art-veil-weak', String(weak))
      root.style.setProperty('--bg-art-veil-mid', String(mid))
      root.style.setProperty('--bg-art-veil-strong', String(strong))
      writeCache({ id: meta.id, url: cssUrl, posX, posY, weak, mid, strong })
    }

    // Pre-decode before the first paint of a NEW image so switching themes
    // doesn't show a half-loaded/blank rect for a frame — decode() failure
    // (corrupt file, unsupported format slipped past import) still commits;
    // the CSS background-image then just paints nothing, no worse than not
    // trying.
    let cancelled = false
    const probe = new Image()
    probe.src = rawUrl
    const settle = (): void => {
      if (!cancelled) commit()
    }
    if (typeof probe.decode === 'function') {
      probe.decode().then(settle).catch(settle)
    } else {
      settle()
    }
    return () => {
      cancelled = true
    }
  }, [background, userThemes])
}
