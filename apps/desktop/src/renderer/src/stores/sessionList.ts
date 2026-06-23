import { create } from 'zustand'

/**
 * UI state for the sidebar's session-list load — specifically the
 * *failure* path.
 *
 * Why a store rather than local state: the listSessions() call lives in
 * FusionRuntimeProvider's thread-list effect (`useThreadListAdapter`),
 * but the sidebar that needs to render the error + retry button
 * (ThreadListSidebar) is a sibling in the assistant-ui subtree, not a
 * descendant of that hook. There's no React context bridging the two, so
 * a tiny module-global store is the clean channel — the provider writes,
 * the sidebar reads.
 *
 * Without this, a failed listSessions() left `threads` at `[]`, which is
 * pixel-identical to "no chats yet": the user saw a blank rail with no
 * hint that anything broke and no way to retry short of reloading.
 */
interface SessionListUiState {
  /**
   * Non-null when the last listSessions() rejected. Holds the error
   * message (for the title tooltip); the sidebar shows a localized banner
   * + retry instead of a bare empty list. Cleared on a successful refresh,
   * on sign-out, and on unmount.
   */
  loadError: string | null
  /**
   * Re-runs the sidebar refresh. Registered by FusionRuntimeProvider's
   * thread-list effect (stable for that mount), null when unmounted. The
   * sidebar's retry button calls it; success clears `loadError`, another
   * failure re-sets it.
   */
  retry: (() => void) | null
  setLoadError: (msg: string | null) => void
  setRetry: (fn: (() => void) | null) => void
}

export const useSessionListStore = create<SessionListUiState>((set) => ({
  loadError: null,
  retry: null,
  setLoadError: (loadError) => set({ loadError }),
  setRetry: (retry) => set({ retry })
}))
