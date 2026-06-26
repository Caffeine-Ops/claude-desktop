import { create } from 'zustand'

/**
 * Current foreground session's display title.
 *
 * Why a dedicated store: the title (a session's customTitle / summary /
 * firstPrompt) lives in the ThreadSummary[] held by useThreadListAdapter
 * (FusionRuntimeProvider), keyed off the chat store's `sessionId`. The chat
 * header in ThreadView needs to render it, but ThreadView is a sibling under
 * the runtime provider — not a child it can receive props from — and the chat
 * store deliberately doesn't carry titles (it owns per-session message/stream
 * state under multi-runtime invariants; bolting a title field onto it would
 * blur that responsibility). assistant-ui's `s.threadListItem.title` only
 * resolves inside a thread-list-item render context, not in the active
 * thread's view. So this tiny store is the clean seam: the adapter computes
 * "title for the current sessionId" and pushes it here; the header subscribes.
 *
 * Frontend-only, not persisted — it's a derived mirror of on-disk session
 * metadata that the adapter already re-derives on every list change.
 */
interface SessionTitleState {
  /** Display title of the foreground session, or null when none/unknown. */
  title: string | null
  setTitle: (title: string | null) => void
}

export const useSessionTitleStore = create<SessionTitleState>((set) => ({
  title: null,
  setTitle: (title) => set((s) => (s.title === title ? s : { title }))
}))
