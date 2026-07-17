import { create } from 'zustand'
import type { BackgroundThemeMeta } from '@desktop-shared/ipc-channels'
import { BACKGROUND_PRESETS } from '@/src/lib/backgroundArt/presets'

/**
 * Cache of user-imported background themes (bundled presets don't need one —
 * BACKGROUND_PRESETS is a build-time constant). Lives in src/stores rather
 * than chat/stores: both the chat applier (backgroundArt.applier.ts) and the
 * Settings appearance section (canvas side) need to resolve/list themes —
 * same cross-surface reasoning as rail.ts.
 *
 * No persist middleware: this is a live mirror of `<userData>/background-
 * themes/` — persisting it would just be a stale copy to invalidate. The
 * daemon/appearance store (not this one) is what remembers *which* themeId
 * is active.
 */
interface BackgroundArtState {
  userThemes: BackgroundThemeMeta[]
  refreshUserThemes: () => Promise<void>
}

export const useBackgroundArtStore = create<BackgroundArtState>((set) => ({
  userThemes: [],
  refreshUserThemes: async () => {
    const api = window.chatApi
    if (!api?.listBackgroundThemes) return
    try {
      const userThemes = await api.listBackgroundThemes()
      set({ userThemes })
    } catch {
      // Main unreachable — keep whatever list is already cached rather than
      // blanking the picker on a transient failure.
    }
  }
}))

/** Looks up a theme by id across both the static preset list and the live user-theme cache. Returns null for the off state (themeId null) or an unresolvable id (e.g. deleted mid-session). */
export function resolveBackgroundTheme(
  themeId: string | null | undefined
): BackgroundThemeMeta | null {
  if (!themeId) return null
  const preset = BACKGROUND_PRESETS.find((p) => p.id === themeId)
  if (preset) return preset
  return useBackgroundArtStore.getState().userThemes.find((t) => t.id === themeId) ?? null
}

/**
 * A `u-*` id is a user-imported theme (`file` is an absolute disk path,
 * needs `toBgAssetUrl()`); a `preset-*` id is bundled (`file` is already a
 * public/-relative URL). Single source of truth for that dispatch — the
 * applier and the Settings picker both need it.
 */
export function isUserBackgroundTheme(id: string): boolean {
  return id.startsWith('u-')
}
