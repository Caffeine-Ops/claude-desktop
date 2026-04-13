import { create } from 'zustand'

/**
 * Timestamped log events pushed from the main-process ChatEngine over
 * IPC. Each event marks one discrete moment in the engine's lifecycle
 * — a cli spawn beginning, the first `system init` message arriving,
 * a turn ending, etc. — so the LogsDialog can render a timeline with
 * inter-event deltas and the user can see exactly where the ~30s
 * first-turn latency is spent.
 *
 * We deliberately keep this store minimal: one array, newest-appended,
 * capped at `MAX_ENTRIES`. No grouping, no sessionId filtering, no
 * derived stats. The dialog renders from the raw array and computes
 * deltas on the fly — if we ever want aggregated views we can build
 * them as memoized selectors rather than as a second store.
 */

/**
 * One log entry pushed from main. Mirrors `shared/types.LogEvent`
 * plus a client-minted `id` so React can key the list.
 */
export interface LogEntry {
  /** Random key for React list rendering — not meaningful to the user. */
  id: string
  /** Epoch ms (main process `Date.now()`). */
  ts: number
  /** Dot-separated path like `ensureSessionReady:fresh` or `turn:firstChunk`. */
  label: string
  /** Live `activeSessionId` when the event fired, or undefined before any session. */
  sessionId?: string
  /** Free-form extras (server counts, byte sizes, elapsed-so-far markers, ...). */
  details?: Record<string, unknown>
}

interface LogsStore {
  entries: readonly LogEntry[]
  /** Append one entry, dropping the oldest when over `MAX_ENTRIES`. */
  push: (e: LogEntry) => void
  /** Wipe the buffer. Used by the dialog's "Clear" button. */
  clear: () => void
}

/**
 * Hard cap on kept entries so the buffer doesn't grow without bound in
 * a long dev session. 500 is generous — a typical turn emits ~15
 * events so this is ~30 turns of history before we start rolling.
 */
const MAX_ENTRIES = 500

export const useLogsStore = create<LogsStore>((set) => ({
  entries: [],
  push: (e) =>
    set((s) => {
      const next = s.entries.length >= MAX_ENTRIES
        ? s.entries.slice(s.entries.length - MAX_ENTRIES + 1)
        : s.entries
      return { entries: [...next, e] }
    }),
  clear: () => set({ entries: [] })
}))
