import { useEffect } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type {
  PermissionDecisionKind,
  PermissionRequest
} from '@desktop-shared/types'
import { interceptPrematureStageConfirm } from '../lib/proposalStageGate'

/**
 * Pending tool-permission store.
 *
 * Why a store instead of a modal
 * ------------------------------
 * The old `<PermissionDialog />` was a single-slot fullscreen modal that
 * held the "current" pending request in local `useState`. That lost
 * requests in two real races:
 *
 *   1. The assistant emits multiple `tool_use` blocks in one turn.
 *      The SDK can call `canUseTool` for each in parallel, so broker
 *      has >1 pending entries at once, but the modal only displays
 *      the last one. User responds → `setPending(null)` in finally
 *      clobbers the sibling request that had already arrived → UI
 *      clears, broker still hangs → both tools stick at `running`
 *      forever.
 *
 *   2. The main-side signal trips (user stop, window close) after
 *      the modal was shown. Broker already rejected the pending
 *      entry — the dialog doesn't know, keeps rendering buttons that
 *      silently no-op when clicked.
 *
 * Store fixes both by:
 *
 *   - Keying by `requestId`, never overwriting; the UI derives its
 *     list by iterating / looking up.
 *   - Listening for a dedicated `PERMISSION_CANCELLED` IPC event that
 *     drops the exact entry the main side gave up on.
 *
 * Lookup shape
 * ------------
 * The inline prompt renders inside each tool's `ToolCallCard`, which
 * only knows the `toolCallId` (= SDK's `toolUseId`). We keep the map
 * primary-keyed by `requestId` (the opaque id broker minted) but
 * selectors walk the values and match `toolUseId` — the O(n) cost is
 * fine because N is "how many tool calls are waiting on the user",
 * which is 1-3 in practice.
 *
 * Respond flow
 * ------------
 * The store also owns the IPC respond call so the UI layer just calls
 * `respond(requestId, decision)`. We optimistically remove the entry
 * BEFORE awaiting the main round-trip — the inline prompt vanishes
 * immediately, which matches the old modal feel. If the invoke throws
 * (network dev-mode hiccup, main crash), we log but don't re-insert:
 * main will either resolve or emit a cancel, both of which are
 * already handled, and re-inserting a stale request would surprise
 * the user more than it helps.
 */
interface PermissionStoreState {
  /** Primary storage, keyed by the opaque `requestId`. */
  requests: Map<string, PermissionRequest>
  /**
   * Push a new request into the map. Safe to call for the same id
   * twice (idempotent — later copy wins). Main never re-emits but
   * dev-mode HMR can fire `onPermissionRequest` twice if we don't
   * unsubscribe cleanly, so duplicates must not crash.
   */
  add: (req: PermissionRequest) => void
  /** Drop a request by its opaque id. Missing ids are silently ignored. */
  remove: (requestId: string) => void
  /** Drop every entry. Used on workspace / session switch. */
  clear: () => void
  /**
   * Send the user's decision to main and optimistically remove the
   * local entry. Callers don't need to await unless they want to
   * observe the IPC failure path.
   *
   * `denyMessage` is the optional typed reason from the floating card's
   * deny-with-feedback option — engine folds it into the SDK deny
   * message so the assistant hears why. Only meaningful with `'deny'`.
   */
  respond: (
    requestId: string,
    decision: PermissionDecisionKind,
    updatedInput?: unknown,
    denyMessage?: string
  ) => Promise<void>
}

export const usePermissionStore = create<PermissionStoreState>((set, get) => ({
  requests: new Map(),

  add: (req) => {
    set((state) => {
      const next = new Map(state.requests)
      next.set(req.requestId, req)
      return { requests: next }
    })
  },

  remove: (requestId) => {
    set((state) => {
      if (!state.requests.has(requestId)) return state
      const next = new Map(state.requests)
      next.delete(requestId)
      return { requests: next }
    })
  },

  clear: () => {
    set((state) => (state.requests.size === 0 ? state : { requests: new Map() }))
  },

  respond: async (requestId, decision, updatedInput, denyMessage) => {
    const req = get().requests.get(requestId)
    if (!req) return
    // Optimistic removal — if the user clicks twice in the tight
    // window before the invoke reply lands, the second click sees an
    // empty slot and bails out instead of double-firing.
    get().remove(requestId)
    // Trim + drop empty feedback here so main only ever sees a real
    // reason (validator caps at 4000; textarea maxLength already
    // matches, the slice is belt-and-braces for programmatic callers).
    const said = denyMessage?.trim().slice(0, 4000)
    try {
      await window.chatApi.respondPermission({
        requestId,
        decision,
        ...(updatedInput !== undefined ? { updatedInput } : {}),
        ...(said ? { denyMessage: said } : {})
      })
    } catch (err) {
      console.error('[permission] respond failed', err)
    }
  }
}))

/**
 * Subscribe the store to main-process permission events. Mounted once
 * at the root of the renderer (via `PermissionBridge` in App.tsx) so
 * every tool card downstream sees fresh data without each one touching
 * the IPC layer itself.
 *
 * Listens for:
 *   - `PERMISSION_REQUEST`   → `add` to the store
 *   - `PERMISSION_CANCELLED` → `remove` from the store
 *
 * Returns void; the component that calls this hook just gates it on
 * mount (the hook handles its own teardown on unmount).
 */
export function usePermissionBridge(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    const { add, remove } = usePermissionStore.getState()
    const unsubRequest = window.chatApi.onPermissionRequest((req) => {
      // 方案阶段确认硬门：模型空口发「封面/目录确认」（对应节根本没输出）时不渲染确认卡，
      // 直接自动作答纠偏文本打回，让它先补哨兵块（见 proposalStageGate 顶注）。
      // 直接走 chatApi 而非 store.respond——请求从未入 map，respond 的存在性检查会把它拦下。
      const auto = interceptPrematureStageConfirm(req)
      if (auto) {
        console.warn(
          '[proposal-stage-gate] 阶段确认被拦截：对应节尚未产出，已自动打回',
          { requestId: req.requestId, sessionId: req.sessionId }
        )
        void window.chatApi
          .respondPermission({
            requestId: req.requestId,
            decision: 'allow-once',
            updatedInput: auto
          })
          .catch((err) =>
            console.error('[proposal-stage-gate] 自动应答失败', err)
          )
        return
      }
      add(req)
    })
    const unsubCancel = window.chatApi.onPermissionCancelled((requestId) => {
      remove(requestId)
    })
    return () => {
      unsubRequest()
      unsubCancel()
    }
  }, [])
}

/**
 * Return a map of { sessionId → number of pending permission
 * requests } — used by the sidebar to render Apple-style red
 * notification badges on session rows whose background agent
 * task blocked on a tool approval the user hasn't answered yet.
 *
 * Returned as a plain Record (not a Map) so `useShallow` can do
 * its standard key/value shallow diff: consumers only re-render
 * when the count changes on some session, not on every unrelated
 * permission traffic.
 */
export function usePendingPermissionCountsBySession(): Readonly<
  Record<string, number>
> {
  return usePermissionStore(
    useShallow((state): Record<string, number> => {
      const counts: Record<string, number> = {}
      for (const req of state.requests.values()) {
        counts[req.sessionId] = (counts[req.sessionId] ?? 0) + 1
      }
      return counts
    })
  )
}

/**
 * Look up the pending permission request for a given tool_use id.
 * Returns `null` when no request is attached to this tool.
 *
 * Uses `useShallow` so the component only re-renders when the specific
 * matching entry changes — unrelated permission traffic for OTHER
 * tool cards won't wake this one up.
 */
export function usePermissionForToolUseId(
  toolUseId: string | undefined
): PermissionRequest | null {
  return usePermissionStore(
    useShallow((state): PermissionRequest | null => {
      if (!toolUseId) return null
      for (const req of state.requests.values()) {
        if (req.toolUseId === toolUseId) return req
      }
      return null
    })
  )
}

/**
 * The pending non-AskUserQuestion permission requests for a session,
 * oldest first — the queue the floating permission card renders.
 *
 * Why oldest-first: the SDK's `canUseTool` calls resolve independently,
 * but the user should answer in arrival order so a long-parked request
 * can't starve behind a stream of newer ones. `Map` iteration follows
 * insertion order, so a simple walk gives us exactly that.
 *
 * AskUserQuestion is excluded: its questionnaire keeps rendering inside
 * the tool card / canvas 问题 tab (see InlinePermissionPrompt), not in
 * the floating dock.
 *
 * `useShallow` note: the returned array is rebuilt per run but its
 * ELEMENTS are the store's own stable request objects, so the shallow
 * compare only fails when membership/order actually changes — no
 * getSnapshot loop (2026-06-29 lesson: never map into fresh objects
 * inside a useShallow selector).
 */
export function usePendingFloatPermissions(
  sessionId: string | null
): readonly PermissionRequest[] {
  return usePermissionStore(
    useShallow((state): PermissionRequest[] => {
      const list: PermissionRequest[] = []
      if (!sessionId) return list
      for (const req of state.requests.values()) {
        if (req.sessionId === sessionId && req.toolName !== 'AskUserQuestion') {
          list.push(req)
        }
      }
      return list
    })
  )
}

/**
 * Per-session "what is the assistant waiting on" kind, for the sidebar
 * pills: 'approval' = a real tool gate (权限批准), 'question' = an
 * AskUserQuestion (回答问题). When BOTH are pending in one session,
 * approval wins — the permission gate is the hard blocker (the model
 * cannot proceed at all), whereas a question merely wants input.
 */
export function usePendingPermissionKindsBySession(): Readonly<
  Record<string, 'approval' | 'question'>
> {
  return usePermissionStore(
    useShallow((state): Record<string, 'approval' | 'question'> => {
      const kinds: Record<string, 'approval' | 'question'> = {}
      for (const req of state.requests.values()) {
        if (req.toolName === 'AskUserQuestion') {
          kinds[req.sessionId] ??= 'question'
        } else {
          kinds[req.sessionId] = 'approval'
        }
      }
      return kinds
    })
  )
}

/**
 * The pending AskUserQuestion request for a given session, or null.
 *
 * Used by the canvas's「问题」tab to render the questionnaire there instead of
 * inline in the chat stream. AskUserQuestion rides the SAME permission-broker
 * flow as any other tool gate (see InlinePermissionPrompt) — so the pending
 * request, with its `input` (the questions) and `requestId` (needed to answer
 * via `respond`), already lives in this store. We just filter to this
 * session's AskUserQuestion entries and return the first (a session shows one
 * questionnaire at a time). `useShallow` keeps consumers from re-rendering on
 * unrelated permission traffic.
 */
export function usePendingAskUserQuestion(
  sessionId: string | null
): PermissionRequest | null {
  return usePermissionStore(
    useShallow((state): PermissionRequest | null => {
      if (!sessionId) return null
      for (const req of state.requests.values()) {
        if (req.sessionId === sessionId && req.toolName === 'AskUserQuestion') {
          return req
        }
      }
      return null
    })
  )
}
