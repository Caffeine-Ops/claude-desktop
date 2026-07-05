import { create } from 'zustand'

/**
 * Unread-reply store — tracks sessions whose latest assistant turn
 * finished while the user wasn't looking at that session.
 *
 * Semantics
 * ---------
 *  - MARK unread: an assistant turn's `end` event arrives for a session
 *    that is NOT the foreground one (the user is elsewhere — another
 *    chat, the canvas, a different tab). FusionRuntimeProvider's event
 *    handler owns this call. A turn that finishes while its own session
 *    is in the foreground is considered already-read and never marked.
 *  - CLEAR unread: the user switches to / opens that session (they're
 *    now looking at the reply). RailSessionList clears on switch — both
 *    its own click path and the `onShellSessionSwitch` echo.
 *
 * The rail renders a small dot on any session id still in this set.
 * Keyed by sessionId; a plain Set is enough (no per-session payload).
 */
interface UnreadState {
  /** Session ids with an unseen finished reply. */
  unread: ReadonlySet<string>
  /** Mark a session's finished reply as unread. */
  markUnread: (sessionId: string) => void
  /** Clear a session's unread flag (user viewed it). */
  clearUnread: (sessionId: string) => void
}

export const useUnreadStore = create<UnreadState>((set) => ({
  unread: new Set(),

  markUnread: (sessionId) =>
    set((s) => {
      if (s.unread.has(sessionId)) return s
      const next = new Set(s.unread)
      next.add(sessionId)
      return { unread: next }
    }),

  clearUnread: (sessionId) =>
    set((s) => {
      if (!s.unread.has(sessionId)) return s
      const next = new Set(s.unread)
      next.delete(sessionId)
      return { unread: next }
    })
}))

/**
 * Stable comma-joined key of the unread set, for the rail to subscribe
 * without a fresh-Set getSnapshot loop (same pattern as the running
 * spinner's key selector). The component rebuilds the Set via useMemo.
 */
export function useUnreadIdsKey(): string {
  return useUnreadStore((s) => [...s.unread].sort().join(','))
}
