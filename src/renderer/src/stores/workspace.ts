import { create } from 'zustand'

import { useChatStore } from './chat'
import { useTodosStore } from './todos'
import { confirmStreamingInterrupt } from '../runtime/streamingGuard'

/**
 * Current workspace + recent-folder ring + inline switch action. Fed
 * by App.tsx on cold start and mutated by any UI that asks to switch
 * folders (WorkspacePill, sidebar row, global drop layer). Recent list
 * is persisted to localStorage so the composer popover can show "最近"
 * entries across restarts without a main-process round-trip.
 *
 * `switchTo` is the single commit path — it calls the engine's
 * setWorkspace IPC, wipes per-workspace renderer stores, pushes to
 * recent, and updates `current`. App.tsx subscribes to `current` and
 * mirrors it into the React tree so FusionRuntimeProvider's
 * `key={workspace}` remounts the runtime under the new cwd.
 */

const STORAGE_KEY = 'workspace.recent.v1'
const MAX_RECENT = 6

type WorkspaceStore = {
  current: string | null
  recent: string[]
  /**
   * In-flight commit target. Non-null while `switchTo` is awaiting
   * the main-process setWorkspace IPC + wiping renderer state.
   * Consumers (WorkspacePill, EmptyWorkspaceShell) read this to show
   * a clearly-visible loading indicator while the switch lands,
   * since the IPC can take several hundred ms and the subsequent
   * FusionRuntimeProvider remount can take a few seconds more on
   * the fusion-code cold start.
   */
  switching: string | null
  setCurrent: (path: string | null) => void
  pushRecent: (path: string) => void
  removeRecent: (path: string) => void
  /**
   * Commit a new workspace path through the engine and refresh all
   * per-workspace renderer state. Throws on main-side rejection so
   * callers can surface the error in their own UI (the pill shows it
   * inline in the popover, the drop layer swallows it silently).
   */
  switchTo: (path: string) => Promise<void>
}

function loadRecent(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

function saveRecent(recent: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recent))
  } catch {
    // localStorage is quota-limited but the worst case is losing the
    // recent list on restart, not breaking the UI.
  }
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  current: null,
  recent: loadRecent(),
  switching: null,

  setCurrent: (path) => set({ current: path }),

  pushRecent: (path) => {
    const existing = get().recent.filter((p) => p !== path)
    const next = [path, ...existing].slice(0, MAX_RECENT)
    saveRecent(next)
    set({ recent: next })
  },

  removeRecent: (path) => {
    const next = get().recent.filter((p) => p !== path)
    saveRecent(next)
    set({ recent: next })
  },

  switchTo: async (path) => {
    const api = window.chatApi
    if (!api) throw new Error('chatApi unavailable')
    // Mid-turn guard: if a chat is currently streaming, prompt the
    // user before tearing down the engine. Cold-start callers
    // (WorkspaceGate / EmptyWorkspaceShell) hit this with
    // streaming === false and pass through without a dialog.
    // Returning false silently aborts the switch — no error toast,
    // since the user just clicked "cancel".
    if (!(await confirmStreamingInterrupt())) return
    // Flip `switching` to the target path immediately so the UI can
    // show a loading state before the IPC round-trip starts. We
    // always clear it in the finally block, even on rejection, so a
    // failed switch doesn't leave a phantom spinner.
    set({ switching: path })
    try {
      const state = await api.setWorkspace({ path })
      if (!state.path) {
        throw new Error('main rejected workspace')
      }
      // Wipe per-workspace renderer state before flipping `current`.
      // FusionRuntimeProvider keys off App.tsx's workspace React
      // state (which tracks `current` via an effect subscription),
      // so the runtime subtree remounts after this set() lands.
      useChatStore.getState().reset()
      useTodosStore.setState({ todos: {} })
      const existing = get().recent.filter((p) => p !== state.path)
      const nextRecent = [state.path, ...existing].slice(0, MAX_RECENT)
      saveRecent(nextRecent)
      set({ current: state.path, recent: nextRecent })
    } finally {
      set({ switching: null })
    }
  }
}))
