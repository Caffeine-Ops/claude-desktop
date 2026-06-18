import { create } from 'zustand'

import { useChatStore } from './chat'
import { useTodosStore } from './todos'
import { confirmStreamingInterrupt } from '../runtime/streamingGuard'
import { tenantKey } from '../lib/tenantKey'

/**
 * Current workspace path + recent-folder ring + commit action.
 *
 * `current` is the renderer-side mirror of the engine's workspace path
 * (defaulted to the OS Desktop in main). App.tsx seeds it from
 * `getWorkspace()` on mount; WorkspaceTreePanel reads it to scope its
 * file scan. Recent list is persisted to localStorage.
 *
 * `switchTo` remains as the single commit path that calls the engine's
 * setWorkspace IPC, wipes per-workspace renderer stores, and updates
 * `current`. With the folder-picker UI removed it currently has no live
 * caller, but is kept so a future "change folder" affordance can reuse
 * it: App.tsx subscribes to `current` and mirrors it into the React tree
 * so FusionRuntimeProvider's `key={workspace}` remounts under the new cwd.
 */

const STORAGE_KEY = tenantKey('workspace.recent.v1')
const MAX_RECENT = 6

type WorkspaceStore = {
  current: string | null
  recent: string[]
  /**
   * In-flight commit target. Non-null while `switchTo` is awaiting
   * the main-process setWorkspace IPC + wiping renderer state. A future
   * "change folder" affordance can read this to show a loading
   * indicator while the switch lands, since the IPC can take several
   * hundred ms and the subsequent FusionRuntimeProvider remount can take
   * a few seconds more on the fusion-code cold start.
   */
  switching: string | null
  setCurrent: (path: string | null) => void
  pushRecent: (path: string) => void
  removeRecent: (path: string) => void
  /**
   * Commit a new workspace path through the engine and refresh all
   * per-workspace renderer state. Throws on main-side rejection so a
   * future caller can surface the error in its own UI.
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
    // user before tearing down the engine. A first-commit caller hits
    // this with streaming === false and passes through without a dialog.
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
