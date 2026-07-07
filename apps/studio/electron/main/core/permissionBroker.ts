import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import type {
  PermissionDecisionKind,
  PermissionRequest,
  PermissionResponse
} from '../../shared/types'

/**
 * PermissionBroker
 * ----------------
 * Bridges main-process `canUseTool` callbacks to renderer-side dialogs.
 *
 * Workflow (one tool call, one round-trip)
 * ----------------------------------------
 *   1. engine.ts's `canUseTool` callback calls `broker.request(payload, signal)`.
 *   2. Broker mints a `requestId`, stores a pending entry, and emits a
 *      `request` event carrying the full `PermissionRequest`.
 *   3. `register.ts` subscribes to `request` and forwards the payload to
 *      the active BrowserWindow via `IPC_CHANNELS.PERMISSION_REQUEST`.
 *   4. Renderer (PermissionDialog) shows the dialog. User clicks a button.
 *   5. Renderer invokes `IPC_CHANNELS.PERMISSION_RESPOND` with the decision.
 *   6. `register.ts` calls `broker.respond(response)`.
 *   7. Broker resolves the pending promise; engine.ts converts the
 *      decision into the SDK's `PermissionResult` shape.
 *
 * Concurrency
 * -----------
 * The Agent SDK calls `canUseTool` sequentially — it blocks the current
 * turn until the callback resolves, so in practice there is at most one
 * pending request per session. We still use a Map keyed by requestId so
 * that future multi-session support can overlap requests without extra
 * plumbing.
 *
 * Cancellation
 * ------------
 * The SDK passes an `AbortSignal` into `canUseTool`. The broker wires it
 * to the pending entry: if the signal fires (user hit the stop button,
 * session tore down, …), the broker rejects the pending promise with a
 * clear error. The caller in engine.ts catches that and returns
 * `{ behavior: 'deny' }` so the SDK doesn't hang.
 *
 * Hot-reload safety
 * -----------------
 * `cancelAll()` rejects every outstanding request. Call it whenever the
 * target window is about to go away (dev reload, quit) so the next run
 * starts clean.
 */
/**
 * The resolved shape of a permission request. Carries the decision plus
 * an optional `updatedInput` rewrite — the second field is what lets the
 * `AskUserQuestion` dialog thread its collected answers back through
 * the same broker channel as a normal allow/deny flow.
 */
export interface PermissionOutcome {
  decision: PermissionDecisionKind
  updatedInput?: unknown
  /** User's typed deny reason — engine folds it into the SDK deny message. */
  denyMessage?: string
}

class PermissionBroker extends EventEmitter {
  private pending = new Map<
    string,
    {
      resolve: (outcome: PermissionOutcome) => void
      reject: (err: Error) => void
      signal?: AbortSignal
      abortHandler?: () => void
    }
  >()

  /**
   * Current number of unresolved permission requests held in this
   * broker. Read by the tab registry to paint an aggregate-count
   * notification badge on each workspace's tab pill — one tab can
   * host many sessions, so the tab-level count is the sum across
   * every session in that engine, which conveniently is exactly
   * `pending.size` (the broker is engine-scoped, not session-scoped).
   */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Emit a `pendingChanged` event with the current count. Called
   * after every mutation (request / respond / cancelAll / abort-
   * handler removal) so subscribers don't have to stitch together
   * `request` + `cancel` streams to track a running total.
   */
  private emitPendingChanged(): void {
    this.emit('pendingChanged', this.pending.size)
  }

  /**
   * Ask the renderer to confirm a tool call. Returns a promise that
   * resolves with the user's choice (plus any input rewrite), or
   * rejects if the request was aborted / the broker was cancelled.
   *
   * `payload` MUST NOT include a `requestId` — the broker mints one.
   */
  request(
    payload: Omit<PermissionRequest, 'requestId'>,
    signal?: AbortSignal
  ): Promise<PermissionOutcome> {
    const requestId = randomUUID()
    const full: PermissionRequest = { ...payload, requestId }

    return new Promise<PermissionOutcome>((resolve, reject) => {
      // Fast-fail if the signal is already tripped when we're called.
      if (signal?.aborted) {
        reject(new Error('Permission request aborted before dispatch.'))
        return
      }

      const entry = {
        resolve,
        reject,
        signal,
        abortHandler: undefined as (() => void) | undefined
      }

      if (signal) {
        entry.abortHandler = () => {
          const stillPending = this.pending.get(requestId)
          if (!stillPending) return
          this.pending.delete(requestId)
          // Tell the renderer to drop its inline prompt — otherwise
          // the user is staring at buttons that will never do anything
          // because the engine has already moved on to deny.
          this.emit('cancel', requestId)
          this.emitPendingChanged()
          reject(new Error('Permission request aborted by signal.'))
        }
        signal.addEventListener('abort', entry.abortHandler, { once: true })
      }

      this.pending.set(requestId, entry)
      this.emit('request', full)
      this.emitPendingChanged()
    })
  }

  /** Deliver the renderer's response to the awaiting promise. */
  respond(response: PermissionResponse): void {
    const entry = this.pending.get(response.requestId)
    if (!entry) {
      console.warn(
        '[permissionBroker] response for unknown requestId — dropping',
        response.requestId
      )
      return
    }
    this.pending.delete(response.requestId)
    if (entry.abortHandler && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortHandler)
    }
    entry.resolve({
      decision: response.decision,
      updatedInput: response.updatedInput,
      denyMessage: response.denyMessage
    })
    this.emitPendingChanged()
  }

  /** Reject every pending request. Used at app shutdown / window close. */
  cancelAll(reason = 'Permission broker cancelled.'): void {
    const hadPending = this.pending.size > 0
    for (const [requestId, entry] of this.pending) {
      if (entry.abortHandler && entry.signal) {
        entry.signal.removeEventListener('abort', entry.abortHandler)
      }
      // Emit first so any renderer subscriber can clear its inline
      // prompt before we reject — the reject() itself only unblocks
      // the engine's handleCanUseTool callback.
      this.emit('cancel', requestId)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
    if (hadPending) this.emitPendingChanged()
  }
}

export { PermissionBroker }
