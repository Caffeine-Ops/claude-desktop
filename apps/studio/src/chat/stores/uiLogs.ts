import { create } from 'zustand'

/**
 * Renderer-side companion to `logsStore`. While `logsStore` mirrors
 * engine instrumentation pushed over IPC from main, this one captures
 * UI-side breadcrumbs that never cross the process boundary — the
 * stuff Electron's main-side log timeline can't see:
 *
 *   - context-menu opens
 *   - rename input submit / cancel
 *   - chatApi calls that returned an error
 *   - keyboard shortcut fires
 *   - …anything else worth tracing without spinning up DevTools
 *
 * Same shape as `LogEntry` so the LogsDialog can render both with one
 * timeline component, just sourced from a different store. Keeping two
 * stores instead of one tagged store means renderer pushes never have
 * to touch the IPC inflow path, and clearing the engine timeline doesn't
 * blow away the renderer-side trail (or vice versa).
 */
export interface UiLogEntry {
  /** Random key for React list rendering — not meaningful to the user. */
  id: string
  /** Epoch ms — captured at push time via `Date.now()`. */
  ts: number
  /** Dot/colon-separated label, e.g. `rename:click`, `rename:submit`. */
  label: string
  /** Free-form extras flattened to `k=v k=v` in the dialog row. */
  details?: Record<string, unknown>
}

interface UiLogsStore {
  entries: readonly UiLogEntry[]
  /** Append one entry, rolling the oldest out when over MAX_ENTRIES. */
  push: (label: string, details?: Record<string, unknown>) => void
  /** Wipe the buffer. Used by the dialog's "Clear" button. */
  clear: () => void
}

const MAX_ENTRIES = 500

export const useUiLogsStore = create<UiLogsStore>((set) => ({
  entries: [],
  push: (label, details) =>
    set((s) => {
      const entry: UiLogEntry = {
        id:
          (typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2)),
        ts: Date.now(),
        label,
        details
      }
      const next =
        s.entries.length >= MAX_ENTRIES
          ? s.entries.slice(s.entries.length - MAX_ENTRIES + 1)
          : s.entries
      return { entries: [...next, entry] }
    }),
  clear: () => set({ entries: [] })
}))

/**
 * Module-level convenience for places that don't want to take a hook
 * dependency just to push one breadcrumb. Reads the latest store API
 * via `getState()` so the call site stays a one-liner.
 */
export function pushUiLog(
  label: string,
  details?: Record<string, unknown>
): void {
  useUiLogsStore.getState().push(label, details)
}
