import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Composer mode store.
 *
 * Two things live here:
 *
 *  1. `mode` — the option picked in the composer's "写作 Beta ⌄" pill
 *     (通用 / 设计 / 幻灯片 / 写作 / 写方案 / 处理表格 / 制作视频). This is the GLOBAL current
 *     selection. FRONTEND-ONLY: it doesn't change what gets sent to the
 *     model yet.
 *
 *  2. `slidesSessions` — the set of session ids that are "slides sessions".
 *     A session becomes one when the user sends their first message while
 *     the global `mode` is `slides` (see markSlidesSession, called from the
 *     composer send path). The two-pane slides layout in ThreadView is
 *     gated on THIS per-session flag, NOT on the live global `mode` — so
 *     only a session that was *started* in slides mode shows the right-hand
 *     workspace, and it keeps showing it regardless of what the picker is
 *     set to later. Other sessions stay single-column. Switching sessions
 *     therefore flips single/two-pane based on each session's own flag.
 *
 * Stored as a `Record<id, true>` (not a Set) so zustand `persist` can
 * JSON-serialise it without a custom replacer. Persisted to localStorage
 * so the binding survives reloads.
 */
export type ComposerModeId =
  | 'general'
  | 'design'
  | 'slides'
  | 'writing'
  | 'proposal'
  | 'spreadsheet'
  | 'video'

interface ComposerModeState {
  mode: ComposerModeId
  setMode: (mode: ComposerModeId) => void
  /** Session ids that were started in slides mode. */
  slidesSessions: Record<string, true>
  /** Mark a session as a slides session (idempotent). */
  markSlidesSession: (sessionId: string) => void
  /** Whether a given session id is a slides session. */
  isSlidesSession: (sessionId: string | null | undefined) => boolean
}

export const useComposerModeStore = create<ComposerModeState>()(
  persist(
    (set, get) => ({
      mode: 'writing',
      setMode: (mode) => set({ mode }),
      slidesSessions: {},
      markSlidesSession: (sessionId) => {
        if (!sessionId) return
        if (get().slidesSessions[sessionId]) return
        set((s) => ({
          slidesSessions: { ...s.slidesSessions, [sessionId]: true }
        }))
      },
      isSlidesSession: (sessionId) =>
        sessionId ? get().slidesSessions[sessionId] === true : false
    }),
    {
      name: 'claude-desktop:composer-mode',
      // Only persist the durable fields, not the function refs (zustand
      // handles that, but being explicit keeps the storage shape clean).
      partialize: (s) => ({ mode: s.mode, slidesSessions: s.slidesSessions })
    }
  )
)
