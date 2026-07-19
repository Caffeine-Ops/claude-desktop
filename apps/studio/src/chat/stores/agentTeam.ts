import { create } from 'zustand'

/**
 * Which team member (a `WfRow.id`) the user has taken over the thread
 * view to inspect — see `AgentTeamBar` (sets it) / `AgentTeamDetail`
 * (reads it, clears it on "返回主会话") / `ThreadView` (swaps the message
 * viewport for the detail takeover while this is non-null). A tiny
 * standalone store rather than component state so the bar (docked above
 * the composer) and the detail view (replacing the message viewport, a
 * sibling far up the tree) don't need a prop bridge through ThreadView.
 *
 * Deliberately NOT keyed per-session: switching sessions already remounts
 * this whole subtree (see ThreadView's `key`), which resets this to null
 * for free — no stale selection can leak across a session switch.
 */
interface AgentTeamState {
  selectedRowId: string | null
  select: (rowId: string) => void
  clear: () => void
  /** Team bar collapsed to a single compact badge (avatar stack + count)
   * instead of the full pill row. Local UI state, not session-derived —
   * same "reset for free on session switch" reasoning as selectedRowId. */
  collapsed: boolean
  toggleCollapsed: () => void
}

export const useAgentTeamStore = create<AgentTeamState>((set) => ({
  selectedRowId: null,
  select: (rowId) => set({ selectedRowId: rowId }),
  clear: () => set({ selectedRowId: null }),
  collapsed: false,
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed }))
}))
