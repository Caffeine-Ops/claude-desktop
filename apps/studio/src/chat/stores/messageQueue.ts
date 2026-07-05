import { create } from 'zustand'

import type { QueuedMessage } from '@desktop-shared/types'

/**
 * Message-queue store — mirrors the engine's per-runtime `pendingTurns`.
 *
 * When the user submits a message while a turn is already streaming, the
 * engine refuses to clobber the active turn (that used to strand the
 * running reply and silently drop the new one — audit finding; see
 * docs/ui-prototype-message-queue.html). It appends the turn to a queue
 * instead and drains the head into the active slot after each `result`.
 *
 * This store is the renderer-side mirror of that queue, keyed by
 * sessionId. The QueuePanel renders it above the composer; row actions
 * (remove / edit / move-to-top) call back through `window.chatApi.queue*`
 * which mutate the authoritative queue in main and echo a fresh snapshot
 * back via a `queue_changed` ChatEvent → `setQueue`.
 *
 * Authoritative source is main. This store is a projection:
 *  - `setQueue` overwrites wholesale from a `queue_changed` event (or the
 *    `queueList` seed on mount / after a session switch).
 *  - `optimisticEnqueue` appends one row locally the instant the user
 *    hits send, so the panel updates without waiting for the IPC round
 *    trip. The matching `queue_changed` (keyed by the same messageId,
 *    minted in the renderer and passed to send) reconciles it — same id,
 *    so no duplicate row.
 */
interface MessageQueueState {
  /** sessionId → queued turns (FIFO; head runs next). */
  queues: Record<string, QueuedMessage[]>
  /** Overwrite a session's queue from an authoritative snapshot. */
  setQueue: (sessionId: string, queue: QueuedMessage[]) => void
  /** Append a row locally ahead of the IPC echo (dedup by messageId). */
  optimisticEnqueue: (sessionId: string, item: QueuedMessage) => void
  /** Drop a session's queue entirely (e.g. on runtime teardown). */
  clearQueue: (sessionId: string) => void
}

export const useMessageQueueStore = create<MessageQueueState>((set) => ({
  queues: {},

  setQueue: (sessionId, queue) =>
    set((s) => ({ queues: { ...s.queues, [sessionId]: queue } })),

  optimisticEnqueue: (sessionId, item) =>
    set((s) => {
      const existing = s.queues[sessionId] ?? []
      // Guard against a double-add if the queue_changed echo already
      // landed (races are possible since both paths are async).
      if (existing.some((q) => q.messageId === item.messageId)) return s
      return { queues: { ...s.queues, [sessionId]: [...existing, item] } }
    }),

  clearQueue: (sessionId) =>
    set((s) => {
      if (!s.queues[sessionId]) return s
      const next = { ...s.queues }
      delete next[sessionId]
      return { queues: next }
    })
}))

/**
 * Selector hook for a single session's queue. Returns a stable empty
 * array reference for sessions with nothing queued so consumers don't
 * re-render on unrelated sessions' updates or churn a fresh `[]` each
 * call (which would defeat memoization / trip useShallow — see the
 * zustand selector pitfalls in errors/).
 */
const EMPTY: QueuedMessage[] = []
export function useSessionQueue(sessionId: string | null): QueuedMessage[] {
  return useMessageQueueStore((s) =>
    sessionId ? s.queues[sessionId] ?? EMPTY : EMPTY
  )
}
