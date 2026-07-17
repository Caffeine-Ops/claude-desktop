import { create } from 'zustand'

/**
 * Which route-aware background-scrim tier the chat face currently wants:
 * 'ambient' (empty/first-run — pull the wallpaper forward) or 'focus' (an
 * active conversation — the veil goes near-solid so transcript text stays
 * readable). Reported by BgZoneReporter, mounted in ThreadView's two
 * ThreadPrimitive.If branches (only one is ever in the tree, so this is a
 * plain last-write, not a race between siblings).
 *
 * Lives in src/stores, not chat/stores: SurfaceHost (root layout, outlives
 * both faces) is the sole writer of the documentElement `data-bg-zone`
 * attribute and combines this with "which face is visible" — canvas has no
 * zone concept yet (v1 is hard-coded 'focus' for that face in SurfaceHost
 * itself), so this store only ever describes the chat face. Same
 * cross-surface reasoning as rail.ts.
 */
interface BackgroundZoneState {
  chatZone: 'ambient' | 'focus'
  setChatZone: (zone: 'ambient' | 'focus') => void
}

export const useBackgroundZoneStore = create<BackgroundZoneState>((set) => ({
  chatZone: 'ambient',
  setChatZone: (zone) => set((s) => (s.chatZone === zone ? s : { chatZone: zone }))
}))
