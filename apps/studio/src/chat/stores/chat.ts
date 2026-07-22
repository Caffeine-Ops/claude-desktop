import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { ThreadMessageLike } from '@assistant-ui/react'

import { sampleSpinnerVerb } from '../constants/spinnerVerbs'
import type { ChatEvent, WorkflowTask } from '@desktop-shared/types'

/**
 * Renderer-side chat state, shaped to feed assistant-ui's
 * `useExternalStoreRuntime` directly. Each entry in `messages` already
 * conforms to `ThreadMessageLike`, so the runtime needs no extra
 * `convertMessage` step — mutations we apply here are visible to the
 * Thread component on the next render.
 *
 * Multi-runtime model
 * -------------------
 * This store holds a per-session slot map (`perSession`), so multiple
 * background agent sessions can each accumulate their own messages
 * while only one is visible on screen at a time. The top-level
 * `messages` / `streaming` / `turn*` fields are a **mirror** of the
 * foreground session's slot — readers keep working unchanged
 * (`useChatStore(s => s.messages)` still returns the current thread).
 *
 * All streaming actions take an explicit `sessionId` as their first
 * argument so events from background runtimes can still write into
 * their own slot without clobbering what's on screen. FusionRuntimeProvider
 * subscribes to each live runtime by id and passes that id into every
 * action call inside the subscription handler.
 *
 * Streaming event flow (per session)
 * ----------------------------------
 *   1. User turn:
 *      appendUserMessage(sessionId, content)
 *   2. Assistant turn begins:
 *      startAssistantMessage(sessionId, messageId)
 *   3. Text deltas:
 *      appendAssistantDelta(sessionId, messageId, delta)
 *   4. Thinking / tool call deltas — analogous.
 *   5. Turn end:
 *      endAssistantMessage(sessionId)
 *
 * Type note
 * ---------
 * `ThreadMessageLike.content` is a discriminated-union array whose exact
 * shape varies per variant (text, tool-call, image, etc.). TypeScript
 * narrows aggressively when you spread it back, so we cast through
 * `any[]` at mutation sites. Runtime shape is validated by
 * `assistant-ui` itself when it reads the messages for rendering.
 */
type ContentPart = {
  type: string
  [key: string]: unknown
}

/**
 * Placeholder text inserted by `startReasoning` when a thinking
 * block opens. Must be non-empty after `.trim()` so assistant-ui's
 * `fromThreadMessageLike` doesn't filter the part out (see
 * @assistant-ui/core/.../thread-message-like.js:42). Zero-width
 * space is invisible when rendered and not considered whitespace
 * by `String.prototype.trim`, so it survives the filter without
 * leaving a visual artifact. `ReasoningCard` treats a text equal
 * to this constant as "no content yet" for the open/collapsed
 * decision.
 */
export const REASONING_PLACEHOLDER = '\u200B'

/**
 * All per-session streaming state. A slot is created lazily on first
 * write and persists until `reset()` or `dropSession(sid)` clears it.
 */
interface PerSessionState {
  messages: ThreadMessageLike[]
  streaming: boolean
  /**
   * Wall-clock timestamp (ms since epoch) when the current assistant
   * turn started, or null when no turn is in flight.
   */
  turnStartedAt: number | null
  /**
   * Random present-participle verb sampled once per turn (e.g.
   * "Cogitating", "Pondering"). Stays stable for the entire response
   * so the label doesn't flicker every frame.
   */
  turnVerb: string | null
  /**
   * True once the current turn has emitted at least one text chunk.
   * ThinkingSpinner hides itself when this flips true — the streaming
   * text itself replaces the placeholder.
   */
  turnHasText: boolean
  /**
   * Live snapshot of the SDK's transport-level auto-retry (`retry`
   * ChatEvent — see its doc comment in shared/types.ts), or null when no
   * retry is in flight. Only ever set before real content starts
   * streaming, so `ThinkingSpinner` — which only mounts in that same
   * pre-content gap — is the sole reader. Reset on both turn start and
   * turn end so it can't leak into the next turn.
   */
  retryInfo: Extract<ChatEvent, { type: 'retry' }> | null
  /**
   * Per-session accumulated usage, reported at the end of each turn.
   * `contextTokens` is the full prompt size fed into the model for
   * the latest turn (input + cache_read + cache_create) — i.e. the
   * value the sidebar badge uses for a "xk / 200k" indicator. The
   * three token buckets sum to `contextTokens` and back the context
   * usage breakdown popover above the composer.
   * `null` until the first turn completes for this session.
   */
  usage: {
    contextTokens: number
    outputTokens: number
    inputTokens: number
    cacheReadTokens: number
    cacheCreateTokens: number
  } | null
}

const EMPTY_SLOT: PerSessionState = {
  messages: [],
  streaming: false,
  turnStartedAt: null,
  turnVerb: null,
  turnHasText: false,
  retryInfo: null,
  usage: null
}

interface ChatState {
  /**
   * fusion-code UUID of the session currently on screen (foreground),
   * or null before one has been picked. "Foreground" in the
   * multi-runtime world — there may be many sessions with live
   * runtimes in the background; only this one has its slot mirrored
   * into the top-level fields below.
   */
  sessionId: string | null
  /**
   * True while the store is loading a different session's history or
   * waiting for main to finish spawning a new fusion-code child.
   * Foreground-scoped — a background session's spawn does NOT flip
   * this.
   */
  sessionLoading: boolean
  /**
   * True ONLY during the click → new-session-messages-mounted window of a
   * session switch (set by beginSessionSwitch, cleared by the setSession
   * that mounts the target transcript). Distinct from `sessionLoading`,
   * which stays true through the multi-second cli cold start — by then the
   * history is already on screen and must NOT be covered by switch chrome.
   * Drives the ThreadView switch skeleton: a cache-hit switch sets and
   * clears this within one synchronous batch, so subscribers never observe
   * `true` and fast switches show zero chrome.
   *
   * 只有 onSwitchToThread 置它（新建会话不置——无 transcript 可加载 = 无加载
   * 态可显，置了只会让骨架在注定空态的新会话上闪一下）。
   */
  sessionSwitching: boolean
  /**
   * Per-session state map. Each slot holds the messages + streaming
   * flags for a session that's been visited / has a live runtime.
   * Keys are fusion-code session UUIDs.
   */
  perSession: Record<string, PerSessionState>

  /**
   * Mirror of `perSession[sessionId ?? '']` for legacy readers. Every
   * slot mutation that targets the foreground session also refreshes
   * these top-level fields so `useChatStore(s => s.messages)` etc.
   * keep working unchanged.
   */
  messages: ThreadMessageLike[]
  /**
   * Tail-window cursor for the FOREGROUND transcript: indexes into
   * `messages`; rows before it exist in state but are NOT handed to the
   * thread runtime (FusionRuntimeProvider slices `messages.slice(start)`).
   *
   * Why: switching to a long session used to mount the ENTIRE history in
   * one synchronous commit — hundreds of messages × markdown parse ×
   * tool cards pinned the renderer main thread for hundreds of ms and
   * the switch entrance dropped frames. Chat reads bottom-up, so only
   * the last HISTORY_WINDOW_INITIAL rows mount on switch; earlier rows
   * are revealed on demand (EarlierMessagesGate in ThreadView).
   *
   * Index-based is safe because the transcript is append-only while
   * mounted: streaming grows the TAIL, so indices below the cursor never
   * shift. Only setSession/setForegroundSession replace the array — and
   * both recompute the cursor. Foreground-scoped like the mirrors above
   * (a background session's window resets on its next foregrounding,
   * which is the desired "re-collapse on revisit" behavior).
   */
  historyWindowStart: number
  streaming: boolean
  turnStartedAt: number | null
  turnVerb: string | null
  turnHasText: boolean
  retryInfo: Extract<ChatEvent, { type: 'retry' }> | null

  // User input ─────────────────────────────────────────────────────────
  /**
   * Push a user turn into the given session's slot. `content` is a
   * pre-built part array so the caller can mix text and image parts.
   */
  appendUserMessage: (sessionId: string, content: ContentPart[]) => void

  // Assistant streaming ────────────────────────────────────────────────
  startAssistantMessage: (sessionId: string, messageId: string) => void
  appendAssistantDelta: (
    sessionId: string,
    messageId: string,
    delta: string
  ) => void
  appendThinkingDelta: (
    sessionId: string,
    messageId: string,
    delta: string
  ) => void
  startReasoning: (sessionId: string, messageId: string) => void
  startToolCall: (
    sessionId: string,
    messageId: string,
    toolUseId: string,
    toolName: string
  ) => void
  appendToolCallArgsDelta: (
    sessionId: string,
    toolUseId: string,
    delta: string
  ) => void
  finalizeToolCall: (sessionId: string, toolUseId: string) => void
  addToolCall: (
    sessionId: string,
    messageId: string,
    toolUseId: string,
    toolName: string,
    args: unknown
  ) => void
  updateToolCallResult: (
    sessionId: string,
    toolUseId: string,
    result: unknown
  ) => void
  /**
   * Merge a workflow/Task subtask update (from the `task_update`
   * ChatEvent) into the spawning tool-call part's `tasks` list. Keyed by
   * the event's `toolUseId` when present; for `updated`-phase events that
   * omit it, falls back to scanning every tool-call part for one that
   * already tracks `ev.taskId`. No-op if neither locates a part.
   */
  updateToolCallTasks: (
    sessionId: string,
    ev: Extract<ChatEvent, { type: 'task_update' }>
  ) => void
  /**
   * Record (or clear) the SDK's transport-level retry snapshot for the
   * pre-content loading spinner. See `retryInfo` on `PerSessionState`.
   */
  setRetryInfo: (
    sessionId: string,
    ev: Extract<ChatEvent, { type: 'retry' }> | null
  ) => void
  setError: (sessionId: string, messageId: string, error: string) => void
  endAssistantMessage: (sessionId: string) => void
  /**
   * Store the context/output token counts reported at the end of an
   * assistant turn. Replaces the previous value (we only show the
   * *latest* per-turn prompt size, not a running sum).
   */
  setUsage: (
    sessionId: string,
    usage: {
      contextTokens: number
      outputTokens: number
      inputTokens: number
      cacheReadTokens: number
      cacheCreateTokens: number
    }
  ) => void

  /** Wipe every session slot and foreground state. */
  reset: () => void

  /** Drop a single session's slot (e.g. on closeSessionRuntime). */
  dropSession: (sessionId: string) => void

  /**
   * Replace a session's messages with the given history and make it
   * the foreground. If the slot already exists with live state (e.g.
   * the user is switching back to a background-running session), the
   * existing slot is kept and the history is ignored — live state
   * takes precedence so we don't clobber streaming deltas with stale
   * JSONL.
   */
  setSession: (sessionId: string, messages: ThreadMessageLike[]) => void

  /**
   * Switch which session's slot is mirrored into top-level fields,
   * without touching its messages. Used for fast foreground swap
   * between sessions that both already have slots.
   */
  setForegroundSession: (sessionId: string | null) => void

  /** Flip the loading indicator on/off during a session switch. */
  setSessionLoading: (loading: boolean) => void

  /**
   * Mark the start of a session switch (see `sessionSwitching`). Cleared
   * automatically by the next setSession / setForegroundSession mount;
   * callers should also clear it in their error paths via
   * endSessionSwitch so a failed load can't strand the switch chrome.
   */
  beginSessionSwitch: () => void
  endSessionSwitch: () => void

  /**
   * Slide the tail window up by HISTORY_WINDOW_REVEAL_STEP (clamped to
   * 0), mounting older foreground messages. Caller (EarlierMessagesGate)
   * owns scroll-position preservation around the reveal.
   */
  revealEarlierMessages: () => void
}

/**
 * Tail-window sizing. INITIAL is what a switch mounts synchronously —
 * 30 rows ≈ several screens of scrollback, enough that the reveal gate
 * is out of sight until the user deliberately digs. REVEAL_STEP is per
 * click of the gate; bigger than INITIAL so digging through a long
 * transcript doesn't take a dozen clicks (each step is an incremental
 * mount of already-in-memory rows — far cheaper than the initial one).
 */
const HISTORY_WINDOW_INITIAL = 30
const HISTORY_WINDOW_REVEAL_STEP = 80

/** Window start for a freshly-(re)mounted transcript: last N rows only. */
function initialWindowStart(messages: readonly ThreadMessageLike[]): number {
  return Math.max(0, messages.length - HISTORY_WINDOW_INITIAL)
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Fold one `task_update` event into a tool-call part's task list,
 * returning a NEW array (callers rely on referential change to trigger
 * re-render). Matches the existing task by `taskId`; inserts a fresh row
 * when unseen (so a `progress` that races ahead of `started` still
 * shows). Only non-empty event fields overwrite — later sparse patches
 * (e.g. an `updated` carrying just a status) must not blank out the
 * `description`/`summary` an earlier event established.
 */
function mergeWorkflowTask(
  existing: WorkflowTask[],
  ev: Extract<ChatEvent, { type: 'task_update' }>
): WorkflowTask[] {
  const prev = existing.find((t) => t.taskId === ev.taskId)
  const merged: WorkflowTask = {
    taskId: ev.taskId,
    status: ev.status ?? prev?.status ?? 'running',
    description: ev.description ?? prev?.description,
    summary: ev.summary ?? prev?.summary,
    subagentType: ev.subagentType ?? prev?.subagentType,
    workflowName: ev.workflowName ?? prev?.workflowName,
    error: ev.error ?? prev?.error,
    result: ev.result ?? prev?.result,
    outputFile: ev.outputFile ?? prev?.outputFile,
    tokens: ev.tokens ?? prev?.tokens,
    toolUses: ev.toolUses ?? prev?.toolUses,
    durationMs: ev.durationMs ?? prev?.durationMs,
    lastToolName: ev.lastToolName ?? prev?.lastToolName,
    // workflow_progress is a FULL snapshot when present (it lists every
    // agent spawned so far), so replace wholesale — merging per-agent
    // would resurrect rows a resumed run no longer has. Events without
    // one (most heartbeats) keep the previous snapshot.
    phases: ev.phases ?? prev?.phases,
    agents: ev.agents ?? prev?.agents
  }
  if (!prev) return [...existing, merged]
  return existing.map((t) => (t.taskId === ev.taskId ? merged : t))
}

/**
 * Apply an immutable update to a session's slot, and if that session
 * is the current foreground, sync the top-level mirror fields in the
 * same set() call. `updater` returning the same reference is the
 * "no change" signal and short-circuits the set().
 */
function updateSlot(
  state: ChatState,
  sessionId: string,
  updater: (slot: PerSessionState) => PerSessionState
): Partial<ChatState> | null {
  const prev = state.perSession[sessionId] ?? EMPTY_SLOT
  const next = updater(prev)
  if (next === prev) return null
  const perSession = { ...state.perSession, [sessionId]: next }
  if (sessionId === state.sessionId) {
    return {
      perSession,
      messages: next.messages,
      streaming: next.streaming,
      turnStartedAt: next.turnStartedAt,
      turnVerb: next.turnVerb,
      turnHasText: next.turnHasText,
      retryInfo: next.retryInfo
    }
  }
  return { perSession }
}

function mirrorFromSlot(slot: PerSessionState): Partial<ChatState> {
  return {
    messages: slot.messages,
    streaming: slot.streaming,
    turnStartedAt: slot.turnStartedAt,
    turnVerb: slot.turnVerb,
    turnHasText: slot.turnHasText,
    retryInfo: slot.retryInfo
  }
}

export const useChatStore = create<ChatState>((set) => ({
  sessionId: null,
  sessionLoading: false,
  sessionSwitching: false,
  perSession: {},
  historyWindowStart: 0,
  messages: [],
  streaming: false,
  turnStartedAt: null,
  turnVerb: null,
  turnHasText: false,
  retryInfo: null,

  appendUserMessage: (sessionId, content) => {
    // Guard: an empty content array would crash assistant-ui's
    // fromThreadMessageLike (it filters empty parts and the message
    // would end up with content: []). Fall back to a whitespace
    // placeholder so the user turn renders even if something upstream
    // passed nothing.
    const safeContent: ContentPart[] =
      content.length > 0 ? content : [{ type: 'text', text: ' ' }]
    const message: ThreadMessageLike = {
      id: randomId('usr'),
      role: 'user',
      content: safeContent as unknown as ThreadMessageLike['content']
    }
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => ({
        ...slot,
        messages: [...slot.messages, message]
      }))
      return patch ?? {}
    })
  },

  startAssistantMessage: (sessionId, _messageId) => {
    // Only flip the streaming flag. We deliberately DO NOT push a
    // placeholder assistant message here — assistant-ui's
    // `fromThreadMessageLike` filters out empty text parts
    // (`part.text.trim().length === 0 → null`), which would leave
    // the message with `content: []` and break runtime internals.
    //
    // Instead, the first real chunk / tool_use creates the message
    // lazily. Streaming state flips immediately so the composer
    // disables its send button.
    //
    // Idempotent: if `streaming` is already true, leave turn meta
    // alone so the spinner elapsed counter stays continuous.
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        if (slot.streaming) return slot
        return {
          ...slot,
          streaming: true,
          turnStartedAt: Date.now(),
          turnVerb: sampleSpinnerVerb(),
          turnHasText: false,
          retryInfo: null
        }
      })
      return patch ?? {}
    })
  },

  appendAssistantDelta: (sessionId, messageId, delta) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        const flipTurnHasText = !slot.turnHasText && delta.length > 0
        const existing = slot.messages.find((m) => m.id === messageId)
        if (!existing) {
          if (delta.length === 0) return slot
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [{ type: 'text', text: delta }]
          } as unknown as ThreadMessageLike
          return {
            ...slot,
            messages: [...slot.messages, newMessage],
            turnHasText: flipTurnHasText ? true : slot.turnHasText
          }
        }
        const messages = slot.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [...((m.content as unknown) as ContentPart[])]
          const last = parts[parts.length - 1]
          if (last && last.type === 'text') {
            parts[parts.length - 1] = {
              ...last,
              text: ((last.text as string) ?? '') + delta
            }
          } else {
            parts.push({ type: 'text', text: delta })
          }
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        return {
          ...slot,
          messages,
          turnHasText: flipTurnHasText ? true : slot.turnHasText
        }
      })
      return patch ?? {}
    })
  },

  startReasoning: (sessionId, messageId) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        // IMPORTANT: the placeholder must NOT be an empty string.
        // assistant-ui's `fromThreadMessageLike` filters out any
        // reasoning part whose `text.trim().length === 0`, so
        // `text: ''` would be silently dropped. `\u200B`
        // (zero-width space) is non-whitespace and invisible.
        const emptyReasoningPart: ContentPart = {
          type: 'reasoning',
          text: REASONING_PLACEHOLDER
        }
        const existing = slot.messages.find((m) => m.id === messageId)
        if (!existing) {
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [emptyReasoningPart]
          } as unknown as ThreadMessageLike
          return { ...slot, messages: [...slot.messages, newMessage] }
        }
        const messages = slot.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [...((m.content as unknown) as ContentPart[])]
          const last = parts[parts.length - 1]
          // Idempotent: if the trailing part is already a reasoning
          // part, don't push a duplicate placeholder. Next thinking
          // delta appends into it.
          if (last && last.type === 'reasoning') {
            return m
          }
          parts.push(emptyReasoningPart)
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  appendThinkingDelta: (sessionId, messageId, delta) => {
    if (!delta) return
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        const reasoningPart: ContentPart = { type: 'reasoning', text: delta }
        const existing = slot.messages.find((m) => m.id === messageId)
        if (!existing) {
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [reasoningPart]
          } as unknown as ThreadMessageLike
          return { ...slot, messages: [...slot.messages, newMessage] }
        }
        const messages = slot.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [...((m.content as unknown) as ContentPart[])]
          const last = parts[parts.length - 1]
          if (last && last.type === 'reasoning') {
            // Drop the ZWSP placeholder `startReasoning` inserted so
            // the final text doesn't carry an invisible stray char.
            const prev = ((last.text as string) ?? '').replace(
              REASONING_PLACEHOLDER,
              ''
            )
            parts[parts.length - 1] = { ...last, text: prev + delta }
          } else {
            parts.push(reasoningPart)
          }
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  startToolCall: (sessionId, messageId, toolUseId, toolName) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        const toolCallPart: ContentPart = {
          type: 'tool-call',
          toolCallId: toolUseId,
          toolName,
          argsText: '',
          // Wall-clock start for the per-tool elapsed timer shown in the
          // ToolCallCard header. Stamped here (streaming path) and in
          // addToolCall (non-streaming path); the matching endedAt is set
          // in updateToolCallResult. Rides the loose ContentPart bag like
          // tasks/argsComplete and survives assistant-ui's render.
          startedAt: Date.now()
        }
        const existing = slot.messages.find((m) => m.id === messageId)
        if (!existing) {
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [toolCallPart]
          } as unknown as ThreadMessageLike
          return { ...slot, messages: [...slot.messages, newMessage] }
        }
        // Duplicate guard: if a tool-call part with this id already
        // exists, the SDK re-delivered the block — leave it alone.
        const existingParts = (existing.content as unknown) as ContentPart[]
        if (
          existingParts.some(
            (p) => p.type === 'tool-call' && p.toolCallId === toolUseId
          )
        ) {
          return slot
        }
        const messages = slot.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [
            ...((m.content as unknown) as ContentPart[]),
            toolCallPart
          ]
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  appendToolCallArgsDelta: (sessionId, toolUseId, delta) => {
    if (!delta) return
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        let changed = false
        const messages = slot.messages.map((m) => {
          if (!Array.isArray(m.content)) return m
          const parts = ((m.content as unknown) as ContentPart[]).map((p) => {
            if (p.type === 'tool-call' && p.toolCallId === toolUseId) {
              changed = true
              const prev = typeof p.argsText === 'string' ? p.argsText : ''
              return { ...p, argsText: prev + delta }
            }
            return p
          })
          if (!changed) return m
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        if (!changed) return slot
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  finalizeToolCall: (sessionId, toolUseId) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        let changed = false
        const messages = slot.messages.map((m) => {
          if (!Array.isArray(m.content)) return m
          const parts = ((m.content as unknown) as ContentPart[]).map((p) => {
            if (p.type === 'tool-call' && p.toolCallId === toolUseId) {
              changed = true
              // Try to parse accumulated argsText. On success store
              // parsed object as `args`; on failure leave argsText
              // as display source.
              const text = typeof p.argsText === 'string' ? p.argsText : ''
              let parsed: unknown = undefined
              if (text.length > 0) {
                try {
                  parsed = JSON.parse(text)
                } catch {
                  // leave undefined; UI falls back on argsText
                }
              } else {
                parsed = {}
              }
              return {
                ...p,
                args: parsed ?? normalizeArgs(undefined),
                argsComplete: true
              }
            }
            return p
          })
          if (!changed) return m
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        if (!changed) return slot
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  addToolCall: (sessionId, messageId, toolUseId, toolName, args) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        const existing = slot.messages.find((m) => m.id === messageId)
        if (existing) {
          const existingParts = (existing.content as unknown) as ContentPart[]
          if (
            existingParts.some(
              (p) => p.type === 'tool-call' && p.toolCallId === toolUseId
            )
          ) {
            return slot
          }
        }
        const toolCallPart: ContentPart = {
          type: 'tool-call',
          toolCallId: toolUseId,
          toolName,
          args: normalizeArgs(args),
          argsComplete: true,
          // See startToolCall: per-tool elapsed-timer start (non-streaming path).
          startedAt: Date.now()
        }
        if (!existing) {
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [toolCallPart]
          } as unknown as ThreadMessageLike
          return { ...slot, messages: [...slot.messages, newMessage] }
        }
        const messages = slot.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [
            ...((m.content as unknown) as ContentPart[]),
            toolCallPart
          ]
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  updateToolCallResult: (sessionId, toolUseId, result) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        let changed = false
        const messages = slot.messages.map((m) => {
          if (!Array.isArray(m.content)) return m
          const parts = ((m.content as unknown) as ContentPart[]).map((p) => {
            if (p.type === 'tool-call' && p.toolCallId === toolUseId) {
              changed = true
              // Stamp endedAt once — the result can be re-delivered by the
              // SDK; keeping the first end time freezes the timer at the real
              // duration instead of stretching it on every re-push.
              const endedAt = typeof p.endedAt === 'number' ? p.endedAt : Date.now()
              return { ...p, result, endedAt }
            }
            return p
          })
          if (!changed) return m
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        if (!changed) return slot
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  updateToolCallTasks: (sessionId, ev) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        let changed = false
        const messages = slot.messages.map((m) => {
          if (!Array.isArray(m.content)) return m
          const parts = ((m.content as unknown) as ContentPart[]).map((p) => {
            if (p.type !== 'tool-call') return p
            // Route to the spawning part: by toolUseId when the event
            // carries one (started/progress/notification), else fall
            // back to "the part already tracking this taskId" (the
            // updated-phase patch omits tool_use_id).
            const byId = ev.toolUseId && p.toolCallId === ev.toolUseId
            const existing = Array.isArray(p.tasks)
              ? (p.tasks as WorkflowTask[])
              : []
            const tracksTask =
              !ev.toolUseId && existing.some((t) => t.taskId === ev.taskId)
            if (!byId && !tracksTask) return p

            changed = true
            const tasks = mergeWorkflowTask(existing, ev)
            return { ...p, tasks }
          })
          if (!changed) return m
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        if (!changed) return slot
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  setRetryInfo: (sessionId, ev) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) =>
        slot.retryInfo === ev ? slot : { ...slot, retryInfo: ev }
      )
      return patch ?? {}
    })
  },

  setError: (sessionId, messageId, error) => {
    set((s) => {
      // assistant-ui's native error channel: a message-level `status`
      // field, not a content part. Re-delivery of the same failure (e.g.
      // the SDK's own `assistant_error` plus a separately-failed `result`
      // for the same underlying gateway error) overwrites this single
      // field in place instead of stacking a second near-identical text
      // bubble — previously `setError` pushed a new `{type:'text', text:
      // '⚠️ ...'}` part every call, so two error signals for one failure
      // rendered as two plain-text rows (2026-07-22). Rendered via
      // `MessagePrimitive.Error` + `ErrorPrimitive.Message` in
      // AssistantErrorBanner, which gets its own styled card instead of
      // blending into the normal reply text.
      const status: NonNullable<ThreadMessageLike['status']> = {
        type: 'incomplete',
        reason: 'error',
        error
      }
      const patch = updateSlot(s, sessionId, (slot) => {
        const existing = slot.messages.find((m) => m.id === messageId)
        if (!existing) {
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [],
            status
          } as unknown as ThreadMessageLike
          return { ...slot, messages: [...slot.messages, newMessage] }
        }
        const messages = slot.messages.map((m) =>
          m.id === messageId ? { ...m, status } : m
        )
        return { ...slot, messages }
      })
      return patch ?? {}
    })
  },

  endAssistantMessage: (sessionId) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        // Settlement sweep — the turn is over, so any tool-call part still
        // missing a result was never finished (user hit Esc mid-tool, or
        // fusion-code died and fired 'error'). The normal finish paths
        // (updateToolCallResult stamps endedAt, finalizeToolCall sets
        // argsComplete) never ran for these, leaving them looking "still
        // running" to every transcript-wide hook: useTurnActivity would show
        // a bogus activity label + a runaway elapsed timer on later turns,
        // useImageFeeds' `generating` and usePendingAskTiming's live counter
        // would stay stuck, and a half-streamed AskUserQuestion would leave a
        // permanent ghost 问题 tab. Force-settle them here so those hooks read
        // them as done: backfill endedAt (freeze the timer at ~now, the best
        // estimate we have) and mark argsComplete + an `interrupted` flag the
        // cards can badge with ⊘.
        let touched = false
        const messages = slot.messages.map((m) => {
          if (!Array.isArray(m.content)) return m
          let partChanged = false
          const parts = ((m.content as unknown) as ContentPart[]).map((p) => {
            if (p.type !== 'tool-call') return p
            if (p.result !== undefined) return p
            partChanged = true
            return {
              ...p,
              endedAt: typeof p.endedAt === 'number' ? p.endedAt : Date.now(),
              argsComplete: true,
              interrupted: true
            }
          })
          if (!partChanged) return m
          touched = true
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
        return {
          ...slot,
          messages: touched ? messages : slot.messages,
          streaming: false,
          turnStartedAt: null,
          turnVerb: null,
          turnHasText: false,
          retryInfo: null
        }
      })
      return patch ?? {}
    })
  },

  setUsage: (sessionId, usage) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => {
        const prev = slot.usage
        if (
          prev &&
          prev.contextTokens === usage.contextTokens &&
          prev.outputTokens === usage.outputTokens
        ) {
          return slot
        }
        return { ...slot, usage: { ...usage } }
      })
      return patch ?? {}
    })
  },

  reset: () =>
    set({
      sessionId: null,
      sessionLoading: false,
      sessionSwitching: false,
      perSession: {},
      historyWindowStart: 0,
      ...EMPTY_SLOT
    }),

  dropSession: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.perSession)) return {}
      const { [sessionId]: _dropped, ...rest } = s.perSession
      const patch: Partial<ChatState> = { perSession: rest }
      if (s.sessionId === sessionId) {
        // The dropped session was the foreground — clear top-level
        // mirror so the thread view empties. Caller picks a new
        // foreground (or leaves it null to drop back to the empty
        // thread).
        patch.sessionId = null
        patch.historyWindowStart = 0
        Object.assign(patch, EMPTY_SLOT)
      }
      return patch
    }),

  setSession: (sessionId, messages) =>
    set((s) => {
      const existing = s.perSession[sessionId]
      // Live state takes precedence over freshly-loaded JSONL history.
      // A background-running session already has its streaming slot
      // accumulating deltas; re-loading history would clobber those
      // with stale JSONL contents from before the turn started.
      const slot: PerSessionState =
        existing && existing.messages.length > 0
          ? existing
          : {
              messages,
              streaming: false,
              turnStartedAt: null,
              turnVerb: null,
              turnHasText: false,
              retryInfo: null,
              usage: null
            }
      return {
        sessionId,
        // Mounting the target transcript ends the switch window — the
        // ThreadView entrance takes over from here.
        sessionSwitching: false,
        perSession: { ...s.perSession, [sessionId]: slot },
        // Tail window from the COMMITTED slot (may be the preserved live
        // slot, not the `messages` argument) so cursor and array agree.
        historyWindowStart: initialWindowStart(slot.messages),
        ...mirrorFromSlot(slot)
      }
    }),

  setForegroundSession: (sessionId) =>
    set((s) => {
      if (sessionId === null) {
        return {
          sessionId: null,
          sessionSwitching: false,
          historyWindowStart: 0,
          ...EMPTY_SLOT
        }
      }
      const slot = s.perSession[sessionId] ?? EMPTY_SLOT
      const perSession =
        sessionId in s.perSession
          ? s.perSession
          : { ...s.perSession, [sessionId]: slot }
      return {
        sessionId,
        sessionSwitching: false,
        perSession,
        historyWindowStart: initialWindowStart(slot.messages),
        ...mirrorFromSlot(slot)
      }
    }),

  setSessionLoading: (loading) => set({ sessionLoading: loading }),

  beginSessionSwitch: () => set({ sessionSwitching: true }),
  endSessionSwitch: () => set({ sessionSwitching: false }),

  revealEarlierMessages: () =>
    set((s) => ({
      historyWindowStart: Math.max(
        0,
        s.historyWindowStart - HISTORY_WINDOW_REVEAL_STEP
      )
    }))
}))

/**
 * Tool args may arrive as `undefined` (before the model has emitted any
 * input_json_delta), as an already-parsed object (our engine parses JSON
 * strings into objects before emit), or occasionally as a raw string.
 * Normalize so the Thread tool-call renderer can always json-stringify.
 */
function normalizeArgs(args: unknown): unknown {
  if (args === undefined || args === null) return {}
  return args
}

/** Stable empty result so the selector doesn't allocate every render. */
const NO_TASKS: WorkflowTask[] = []

/**
 * Workflow/Task subtasks attached to the tool-call part with this
 * `toolUseId`, in the *foreground* session. Mirrors
 * `usePermissionForToolUseId` (stores/permissions.ts): the ToolCallCard
 * can't read the part's extra `tasks` field through assistant-ui's
 * Fallback props (those carry only the standard tool fields), so it
 * looks them up here by id instead. Returns the stable empty array when
 * the part has no subtasks, and uses `useShallow` so a card only
 * re-renders when ITS task list changes.
 */
export function useToolCallTasks(
  toolUseId: string | undefined
): WorkflowTask[] {
  return useChatStore(
    useShallow((s): WorkflowTask[] => {
      if (!toolUseId) return NO_TASKS
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of (m.content as unknown) as ContentPart[]) {
          if (
            p.type === 'tool-call' &&
            p.toolCallId === toolUseId &&
            Array.isArray(p.tasks) &&
            p.tasks.length > 0
          ) {
            return p.tasks as WorkflowTask[]
          }
        }
      }
      return NO_TASKS
    })
  )
}

/**
 * Per-tool elapsed-timer source: the `{ startedAt, endedAt }` stamped on the
 * tool-call part with this id (see startToolCall / addToolCall / updateToolCallResult).
 * `endedAt` is undefined while the tool is still running.
 *
 * Returns a PLAIN-SCALAR object so `useShallow` stays stable: both fields are
 * numbers (or undefined), so shallow-compare on values means the card only
 * re-renders when one of the two timestamps actually changes. (We deliberately
 * do NOT build a derived array/object out of fresh references here — that would
 * make useShallow see a "new" value every tick and loop forever. Scalars only.)
 */
export function useToolCallTiming(toolUseId: string | undefined): {
  startedAt: number | undefined
  endedAt: number | undefined
} {
  return useChatStore(
    useShallow((s) => {
      if (!toolUseId) return { startedAt: undefined, endedAt: undefined }
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of (m.content as unknown) as ContentPart[]) {
          if (p.type === 'tool-call' && p.toolCallId === toolUseId) {
            return {
              startedAt: typeof p.startedAt === 'number' ? p.startedAt : undefined,
              endedAt: typeof p.endedAt === 'number' ? p.endedAt : undefined
            }
          }
        }
      }
      return { startedAt: undefined, endedAt: undefined }
    })
  )
}

/**
 * Maps a tool name to the coarse "activity" the composer status bar names in
 * Chinese ("探索中…", "拆一下任务…", …). Returns a stable string KEY (not the
 * label) so the store stays UI-text-free and useShallow compares scalars.
 * Unknown / no tool → 'thinking' (the generic "思考中…").
 */
function toolActivityKey(toolName: string | undefined): string {
  switch (toolName) {
    case 'Task':
    case 'Workflow':
      return 'planning' // 拆一下任务…
    case 'Agent':
    case 'Explore':
      return 'exploring' // 探索中…
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'NotebookRead':
      return 'reading' // 查阅中…
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'writing' // 编写中…
    case 'Bash':
    case 'BashOutput':
      return 'running' // 执行中…
    case 'WebFetch':
    case 'WebSearch':
      return 'searching' // 上网查资料…（一个档覆盖搜索与按 URL 抓取两种）
    case 'AskUserQuestion':
      return 'asking' // 等待你回答…
    default:
      return toolName ? 'working' : 'thinking'
  }
}

/**
 * Drives the composer status bar (the "✻ 探索中… … 2.5s" strip above the
 * input). While the foreground session is streaming, returns:
 *   - active:    true → render the bar
 *   - startedAt: basis for the elapsed timer — the CURRENT STEP's start,
 *                not the turn's (see below)
 *   - activity:  coarse Chinese-activity KEY from the newest still-running
 *                tool, or 'thinking' when no tool is in flight yet
 *
 * Timer basis is per-STEP, not per-turn: the bar's label names the current
 * activity ("执行中…"), so the number next to it must be how long THAT
 * activity has been going — a running tool counts from its own startedAt, a
 * thinking gap counts from when the previous tool settled. A turn-total
 * ("104.7s" while the current command started 5s ago) reads as a lie next
 * to a per-activity label. Falls back to turnStartedAt when a part carries
 * no timestamp (and for the turn's opening thinking phase, where step start
 * IS turn start).
 *
 * All-scalar return for useShallow stability.
 */
export function useTurnActivity(): {
  active: boolean
  startedAt: number | undefined
  activity: string
} {
  return useChatStore(
    useShallow((s) => {
      if (!s.streaming || s.turnStartedAt === null) {
        return { active: false, startedAt: undefined, activity: 'thinking' }
      }
      // Walk all parts to find (a) the newest still-running tool-call and
      // its own start stamp, (b) the newest settled tool's end stamp (basis
      // for a mid-turn thinking gap), and (c) the very last part overall
      // (to know if we're mid-prose-output).
      let runningTool: string | undefined
      let runningToolStartedAt: number | undefined
      let lastSettledAt: number | undefined
      let lastPartType: string | undefined
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of (m.content as unknown) as ContentPart[]) {
          lastPartType = p.type
          if (p.type !== 'tool-call') continue
          // "Running" = no result AND not yet settled. endAssistantMessage's
          // settlement sweep backfills endedAt on any tool-call left
          // unfinished by an interrupt/error, so a still-undefined result with
          // an endedAt stamp is a settled-but-interrupted tool from a PAST
          // turn — treat it as done, not as a phantom still in flight (else its
          // stale toolName + startedAt would drive a bogus label and a runaway
          // timer on every later turn).
          if (
            p.result === undefined &&
            typeof p.endedAt !== 'number' &&
            typeof p.toolName === 'string'
          ) {
            runningTool = p.toolName
            runningToolStartedAt =
              typeof p.startedAt === 'number' ? p.startedAt : undefined
          } else if (typeof p.endedAt === 'number') {
            lastSettledAt = Math.max(lastSettledAt ?? 0, p.endedAt)
          }
        }
      }
      // While the assistant is streaming PROSE (the tail part is text and no
      // tool is in flight), hide the bar — the user asked to see it only for
      // thinking / tool work ("运行命令中"), not for plain text output. The
      // bar reappears when the next tool starts or a fresh thinking gap opens.
      if (runningTool === undefined && lastPartType === 'text') {
        return { active: false, startedAt: undefined, activity: 'thinking' }
      }
      // The walk spans the WHOLE thread, so lastSettledAt may belong to a
      // previous turn — only trust it as the thinking-gap basis when it's
      // inside the current turn; otherwise the gap started with the turn.
      const gapStartedAt =
        lastSettledAt !== undefined && lastSettledAt > s.turnStartedAt
          ? lastSettledAt
          : s.turnStartedAt
      return {
        active: true,
        startedAt:
          runningTool !== undefined
            ? (runningToolStartedAt ?? s.turnStartedAt)
            : gapStartedAt,
        activity: toolActivityKey(runningTool)
      }
    })
  )
}

/**
 * The raw `argsText` of the foreground session's STILL-STREAMING
 * AskUserQuestion tool call, or null when none is mid-stream.
 *
 * Lets the canvas's 问题 tab render the questionnaire *as the input streams*
 * — before canUseTool fires and a permission request (with a requestId) even
 * exists. We find the tool-call part whose toolName is 'AskUserQuestion' and
 * which hasn't been finalized yet (`argsComplete !== true`); its `argsText`
 * is the half-open JSON the model is still writing. Callers run it through
 * parsePartialToolArgs for a best-effort preview (read-only — answering needs
 * the requestId, which only arrives once the tool actually calls canUseTool).
 * Returns the string itself so zustand's shallow compare re-renders only when
 * the streamed text grows. Mirrors useToolCallTasks's store-walk.
 */
/**
 * Set of session ids whose assistant turn is currently streaming — i.e.
 * has agent work in flight. Drives the running/loading spinner on each
 * rail session row (RailSessionList). Reads the authoritative
 * per-session `streaming` flag (flipped by start/end ChatEvents, which
 * FusionRuntimeProvider subscribes for every live runtime, foreground
 * AND background), so a backgrounded task shows its spinner too.
 *
 * The selector returns a sorted, comma-joined id STRING rather than a
 * fresh Set — a primitive that zustand compares with Object.is, so the
 * hook only re-renders when the *set of running sessions* changes, not
 * on every streaming delta (each delta rewrites the slot, but the id
 * list is unchanged). The component rebuilds the Set from the string
 * with a useMemo. This is the "subscribe to a stable primitive, derive
 * the object in the component" pattern that avoids the useShallow
 * new-object getSnapshot loop.
 */
export function useRunningSessionIdsKey(): string {
  return useChatStore((s) => {
    const running: string[] = []
    for (const [sid, slot] of Object.entries(s.perSession)) {
      if (slot.streaming) running.push(sid)
    }
    return running.sort().join(',')
  })
}

export function useStreamingAskArgsText(): string | null {
  return useChatStore((s): string | null => {
    // Take the LAST still-streaming AskUserQuestion, mirroring
    // usePendingAskTiming's "last wins" — a fresh question must supersede any
    // earlier one in the same thread. endAssistantMessage's settlement sweep
    // sets argsComplete on interrupted tool-calls so they drop out of this
    // filter, but "last wins" is a cheap belt-and-suspenders: even if a stale
    // match somehow survived, it can't mask the newly streaming question.
    let latest: string | null = null
    for (const m of s.messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (
          p.type === 'tool-call' &&
          p.toolName === 'AskUserQuestion' &&
          p.argsComplete !== true &&
          typeof p.argsText === 'string'
        ) {
          latest = p.argsText as string
        }
      }
    }
    return latest
  })
}

/**
 * The foreground session's STILL-STREAMING Workflow tool call, split into
 * two hooks with deliberately different re-render costs:
 *
 *   - useStreamingWorkflowCallId — 只返回 toolCallId（原始值，delta 期间
 *     恒定）。ThreadView 用它决定「要不要分栏」——它绝不能订阅流式文本，
 *     否则每个 delta 重渲染整棵聊天列。
 *   - useStreamingWorkflowArgsText — 返回半开 JSON 文本本体，每 delta 都
 *     变。只有 WorkflowScriptPanel 自己订阅（实时跟写正是它的工作）。
 *
 * Same store-walk & "last wins" semantics as useStreamingAskArgsText above;
 * 定稿（argsComplete）后双双回落 null，面板自动退出。
 */
export function useStreamingWorkflowCallId(): string | null {
  return useChatStore((s): string | null => {
    let id: string | null = null
    for (const m of s.messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (
          p.type === 'tool-call' &&
          p.toolName === 'Workflow' &&
          p.argsComplete !== true &&
          typeof p.argsText === 'string' &&
          typeof p.toolCallId === 'string'
        ) {
          id = p.toolCallId
        }
      }
    }
    return id
  })
}

export function useStreamingWorkflowArgsText(): string | null {
  return useChatStore((s): string | null => {
    let text: string | null = null
    for (const m of s.messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (
          p.type === 'tool-call' &&
          p.toolName === 'Workflow' &&
          p.argsComplete !== true &&
          typeof p.argsText === 'string'
        ) {
          text = p.argsText as string
        }
      }
    }
    return text
  })
}

/**
 * The foreground session's most recent Workflow tool call whose spawned
 * run is STILL IN FLIGHT (any task/agent not yet settled), or null. Keeps
 * the script panel open through the「跑任务」阶段：脚本定稿后流式信号消
 * 失，但 task_update 还在持续更新 part.tasks——面板切到任务树视图直到
 * 全部 agent 终态。判定单位与 WorkflowTaskList 的计数一致：带
 * workflow_progress 快照的 task 看它的 agents，普通 subtask 看自身。
 * Returns a primitive (the toolCallId)，task_update 每 tick 重算但值不
 * 变 → 订阅者不重渲染。
 */
export function useActiveWorkflowRunId(): string | null {
  return useChatStore((s): string | null => {
    let id: string | null = null
    for (const m of s.messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (
          p.type !== 'tool-call' ||
          p.toolName !== 'Workflow' ||
          typeof p.toolCallId !== 'string' ||
          !Array.isArray(p.tasks) ||
          p.tasks.length === 0
        ) {
          continue
        }
        const tasks = p.tasks as WorkflowTask[]
        const units = tasks.flatMap(
          (task): { status: WorkflowTask['status'] }[] =>
            task.agents && task.agents.length > 0 ? task.agents : [task]
        )
        const inFlight = units.some(
          (u) => u.status === 'running' || u.status === 'pending'
        )
        if (inFlight) id = p.toolCallId
      }
    }
    return id
  })
}

/**
 * Every subtask the foreground session's Task/Agent/Workflow tool calls
 * have ever spawned, flattened across ALL such tool calls (not just the
 * latest one) — active OR fully settled. Feeds the agent-team bar/detail
 * takeover: unlike `useActiveWorkflowRunId` (which the script panel uses to
 * know when to auto-collapse), the team bar's whole point is staying
 * visible so the user can revisit a finished run's members, so this
 * deliberately does NOT null out once every agent reaches a terminal state.
 *
 * `toolName` check mirrors the precedent in `useImageFeeds` above ('Task'
 * and 'Agent' both name the same plain-subagent tool call depending on SDK
 * version/build — see that selector's comment) plus `'Workflow'` for
 * script-driven runs. `p.tasks` is already deduplicated by `taskId` within
 * each tool-call part (see `mergeWorkflowTask`), and a given `taskId` can't
 * appear under two different tool calls, so a plain flatten is safe — no
 * cross-call dedup needed.
 */
export function useTeamMemberTasks(): WorkflowTask[] {
  return useChatStore(
    useShallow((s): WorkflowTask[] => {
      const out: WorkflowTask[] = []
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of (m.content as unknown) as ContentPart[]) {
          if (
            p.type === 'tool-call' &&
            (p.toolName === 'Task' ||
              p.toolName === 'Agent' ||
              p.toolName === 'Workflow') &&
            Array.isArray(p.tasks) &&
            p.tasks.length > 0
          ) {
            out.push(...(p.tasks as WorkflowTask[]))
          }
        }
      }
      return out
    })
  )
}

/**
 * The SETTLED script text of a Workflow tool call, looked up by id in the
 * foreground session's messages — feeds the script panel's manual-open path
 * (点击卡片里的脚本入口重新打开). Returns null while the call is still
 * streaming（那是 useStreamingWorkflowCall 的地盘）or when the args carry no
 * inline `script`（scriptPath / name 调用形态没有脚本文本可看）。Settled
 * args never mutate, so the returned string is referentially stable.
 */
export function useWorkflowScriptById(toolCallId: string | null): string | null {
  return useChatStore((s): string | null => {
    if (toolCallId === null) return null
    for (const m of s.messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (
          p.type === 'tool-call' &&
          p.toolCallId === toolCallId &&
          p.argsComplete === true
        ) {
          const args = p.args
          if (args && typeof args === 'object') {
            const script = (args as Record<string, unknown>).script
            if (typeof script === 'string' && script.length > 0) return script
          }
          return null
        }
      }
    }
    return null
  })
}

/**
 * Timing for the foreground session's current AskUserQuestion tool call —
 * used by the slides canvas 问题 tab, which hosts the questionnaire instead of
 * the inline ToolCallCard (the card is suppressed there, so its header timer
 * never shows). We surface the SAME {startedAt, endedAt} the card would have,
 * so the canvas header gets the live `166.5s` counter.
 *
 * Walks tool-call parts and returns the LAST AskUserQuestion part's stamps —
 * "last" so a fresh question supersedes a resolved earlier one in the same
 * thread. Plain-scalar return for useShallow stability (see useToolCallTiming).
 */
export function usePendingAskTiming(): {
  startedAt: number | undefined
  endedAt: number | undefined
} {
  return useChatStore(
    useShallow((s) => {
      let found: { startedAt: number | undefined; endedAt: number | undefined } | null =
        null
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of (m.content as unknown) as ContentPart[]) {
          if (p.type === 'tool-call' && p.toolName === 'AskUserQuestion') {
            found = {
              startedAt: typeof p.startedAt === 'number' ? p.startedAt : undefined,
              endedAt: typeof p.endedAt === 'number' ? p.endedAt : undefined
            }
          }
        }
      }
      return found ?? { startedAt: undefined, endedAt: undefined }
    })
  )
}

/* ───────────────── ppt-master in-app preview detection ──────────────── */

/**
 * ppt-master's confirm_ui and live-preview surfaces are file+IPC now — no
 * HTTP server, no port, no URL to parse. This hook's only job is to detect
 * that one of them is ACTIVE for the foreground session and hand the
 * renderer the ppt-master project's ABSOLUTE directory, which every IPC
 * these tabs call (CONFIRM_UI_READ, PPT_PREVIEW_LIST_SLIDES, …) keys off of:
 *   - `confirm_ui/confirm_wait.py <project> --stage {tier1,final} [--fresh]`
 *     — CanvasConfirm renders in the 「问题」canvas tab while a wait for this
 *     round is outstanding (see the stage-liveness rule on usePreviewServer).
 *   - `svg_editor/preview_open.py <project> [--live]` — LivePreviewEditor
 *     renders in the 「预览幻灯片」canvas tab once THIS COMMAND'S OWN STDOUT
 *     confirms the resolved project directory (never the raw argument text —
 *     preview_open.py resolves and prints it so the host never has to guess
 *     shell-variable expansion, same discipline the old URL-parsing version
 *     used for ports).
 * A legacy path also recognizes the OLD Flask launch commands
 * (`confirm_ui/server.py` / `svg_editor/server.py`) purely for their project
 * argument — those servers no longer exist (deleted along with their
 * `static/` pages), but a RESUMED session whose transcript still shows one of
 * those launches should light the same tab from the same on-disk files (the
 * SVGs/JSON are still there; only the HTTP layer is gone) instead of losing
 * the tab on old transcripts.
 */
const CONFIRM_WAIT_RE = /confirm_ui[/\\]confirm_wait\.py/
// The `["']?` before `\s+` is load-bearing, not decoration: real invocations
// quote the SCRIPT PATH itself (`"$SKILL_DIR/scripts/confirm_ui/confirm_wait.py"
// "$PROJECT" --stage …`), so the closing quote sits directly after `.py` with
// no whitespace before it. Without this, `\s+` right after `confirm_wait\.py`
// never matches, the regex returns null, and the 「问题」tab silently never
// lights up — confirm_wait.py still runs and blocks for real (recommendations
// + catalogs land on disk fine), but nothing renders for the user to submit
// through, so it just times out ~590s later. Caught from a real transcript
// where the AI wrote exactly that quoted-script-path form.
const CONFIRM_WAIT_ARG_RE = /confirm_wait\.py["']?\s+(?:"([^"]+)"|'([^']+)'|((?:\\ |\S)+))/
const CONFIRM_STAGE_RE = /--stage[=\s]+(tier1|final)/
// confirm_wait.py's own timeout log line — the ONE textual signal that a
// confirm round ended WITHOUT a result (as opposed to still running, or
// having ended WITH one). Matched verbatim against the script's `logger.error`
// phrasing (see confirm_wait.py's stderr message); Bash tool results merge
// stdout+stderr, so this is visible the same way stdout is.
const CONFIRM_WAIT_TIMEOUT_RE = /timed out waiting for (?:tier1|final) confirmation/

const PREVIEW_OPEN_RE = /svg_editor[/\\]preview_open\.py/
// preview_open.py prints exactly one line on success: "live preview ready:
// <absolute path>". Anchored on that exact phrase so a path merely mentioned
// in a doc comment or an unrelated log line is never mistaken for it.
const PREVIEW_OPEN_READY_RE = /live preview ready:\s*(.+)$/m

// Legacy (pre-refactor) Flask launch commands — recognized ONLY so an
// already-resumed session's tab stays lit on the same files. A fresh session
// never produces these anymore (SKILL.md no longer emits them); the project
// argument sits in the same position `--daemon`/`--wait-only`/plain launches
// all share, so no stdout URL is needed to resolve it.
const LEGACY_CONFIRM_SERVER_RE = /confirm_ui[/\\]server\.py/
const LEGACY_PREVIEW_SERVER_RE = /svg_editor[/\\]server\.py/
// Same quoted-script-path fix as CONFIRM_WAIT_ARG_RE above — a resumed old
// transcript can equally have quoted its server.py path.
const LEGACY_SERVER_ARG_RE = /server\.py["']?\s+(?:"([^"]+)"|'([^']+)'|((?:\\ |\S)+))/

/** Best-effort plain-text from a tool-result that may be string/array/object. */
function previewResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : typeof part === 'string'
            ? part
            : ''
      )
      .join('')
  }
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content)) return previewResultText(obj.content)
  }
  return ''
}

/** Pull the running command string out of a Bash tool-call part. */
function previewCommandText(part: ContentPart): string {
  const args = part.args
  if (args && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command
    if (typeof cmd === 'string' && cmd.length > 0) return cmd
  }
  // Falls back to the still-streaming raw JSON before args is parsed.
  return typeof part.argsText === 'string' ? part.argsText : ''
}

/** Which ppt-master surface is active + the project it's for. `confirm` →
 *  native render in 「问题」; `preview` → native render in 「预览幻灯片」.
 *  `projectDir` is always an ABSOLUTE path — the IPC these tabs call rejects
 *  relative ones. */
export type PreviewServer =
  | { kind: 'confirm'; projectDir: string }
  | { kind: 'preview'; projectDir: string }

/**
 * The foreground session's active ppt-master surface, or null when neither
 * is up. Scans every Bash tool-call part once, in transcript order — later
 * matches override earlier ones, so a confirm → live-preview handoff (or a
 * retry after a timeout) swaps which tab is driven, same rule the old
 * URL-based version used.
 *
 * Liveness rules — there is no server process to ask "are you still up", so
 * activity is inferred purely from which commands appear and how they ended:
 *   - `confirm_wait.py --stage tier1` succeeding or still running → active
 *     (tier1 completing does NOT end the confirm round; the AI immediately
 *     re-derives and waits on tier2 next — the panel stays up through
 *     CanvasConfirm's own "deriving" phase). Only a TIER1 TIMEOUT clears it —
 *     that's the AI abandoning to the AskUserQuestion chat fallback, which
 *     must not be shadowed by a stale confirm panel (`wantsQuestionsTab`
 *     already prioritizes questions over confirm; clearing here is what lets
 *     that priority actually take effect instead of confirm never yielding).
 *   - `confirm_wait.py --stage final` — active while still running; clears
 *     the instant it returns, confirmed OR timed out (the round is over
 *     either way).
 *   - `preview_open.py` — active once ITS OWN STDOUT prints the ready
 *     phrase; never the raw argument (mirrors the old code's refusal to
 *     guess a port before the server confirmed one).
 *   - legacy `server.py` commands — active as soon as recognized, except
 *     `--shutdown` (explicit teardown, clears) — there's no stdout contract
 *     to wait on since nothing runs these anymore; this path only serves
 *     already-resumed transcripts.
 *
 * Uses `useShallow` so the returned object is compared by value — callers
 * only re-render when the kind or projectDir actually changes.
 */
export function usePreviewServer(): PreviewServer | null {
  return useChatStore(
    useShallow((s): PreviewServer | null => {
      let result: PreviewServer | null = null
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of (m.content as unknown) as ContentPart[]) {
          if (p.type !== 'tool-call' || p.toolName !== 'Bash') continue
          const command = previewCommandText(p)

          if (CONFIRM_WAIT_RE.test(command)) {
            const stage = CONFIRM_STAGE_RE.exec(command)?.[1]
            const hasResult = p.result !== undefined
            const timedOut =
              hasResult && CONFIRM_WAIT_TIMEOUT_RE.test(previewResultText(p.result))
            if ((stage === 'final' && hasResult) || (stage === 'tier1' && timedOut)) {
              result = null
              continue
            }
            const argMatch = CONFIRM_WAIT_ARG_RE.exec(command)
            const rawPath = argMatch?.[1] ?? argMatch?.[2] ?? argMatch?.[3] ?? ''
            const projectDir = rawPath ? resolveCommandPath(rawPath, command) : ''
            if (projectDir) result = { kind: 'confirm', projectDir }
            continue
          }

          if (PREVIEW_OPEN_RE.test(command)) {
            const readyMatch = PREVIEW_OPEN_READY_RE.exec(previewResultText(p.result))
            if (readyMatch) {
              result = { kind: 'preview', projectDir: readyMatch[1].trim() }
            }
            // No ready line yet (still booting, or failed) — leave `result`
            // as-is. Same "don't guess" discipline the old code applied to
            // an unprinted port.
            continue
          }

          if (
            LEGACY_CONFIRM_SERVER_RE.test(command) ||
            LEGACY_PREVIEW_SERVER_RE.test(command)
          ) {
            if (/--shutdown\b/.test(command)) {
              result = null
              continue
            }
            const argMatch = LEGACY_SERVER_ARG_RE.exec(command)
            const rawPath = argMatch?.[1] ?? argMatch?.[2] ?? argMatch?.[3] ?? ''
            const projectDir = rawPath ? resolveCommandPath(rawPath, command) : ''
            if (!projectDir) continue
            result = {
              kind: LEGACY_CONFIRM_SERVER_RE.test(command) ? 'confirm' : 'preview',
              projectDir
            }
          }
        }
      }
      return result
    })
  )
}

/* ───────────────── ppt-master source pptx detection ──────────────── */

// An absolute path ending in .pptx/.ppt — matches both the composer's
// `@"<path>"` mention quoting (the quotes aren't part of the match, so a
// quoted or bare occurrence extracts the same path) and a plain path typed
// directly into the message.
const SOURCE_PPTX_RE = /\/[^\s"'<>|]*\.pptx?\b/i

/** Best-effort plain text from a message's content parts (text parts only —
 *  a user message never carries tool-call parts). */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((p) =>
      p && typeof p === 'object' && (p as ContentPart).type === 'text'
        ? String((p as ContentPart).text ?? '')
        : ''
    )
    .join('\n')
}

/**
 * The .pptx/.ppt path named in this session's FIRST user message, if any —
 * the signal that the user handed ppt-master an EXISTING deck to work from
 * (beautify/modify), which SlidesWorkspace uses to open a preview of that
 * source file (see PPT_SOURCE_PREVIEW / SourceDeckViewer) before the AI has
 * produced any output of its own. A path only in a LATER message doesn't
 * count — the affordance is "the user just handed us a file to start from",
 * not "a .pptx path was ever mentioned" (e.g. a follow-up asking to export
 * TO a specific .pptx name shouldn't re-open a stale source preview).
 */
export function useSourcePptx(): { path: string } | null {
  return useChatStore(
    useShallow((s): { path: string } | null => {
      const first = s.messages.find((m) => m.role === 'user')
      if (!first) return null
      const match = SOURCE_PPTX_RE.exec(messageText(first.content))
      return match ? { path: match[0] } : null
    })
  )
}

/* ───────────────── ppt-master image acquisition feed ──────────────── */

// Match the worklist path off a running `image_gen.py --manifest <path>`
// command (AI generation) or its web sister `image_search.py --batch <path>`
// (licensed-image download; both rewrite per-item status into that JSON as
// they go). The path may be quoted (spaces) or bare. Anchored on the script
// name so an unrelated `--manifest`/`--batch` elsewhere can't match. Mirrors
// usePreviewServer's "read the real value out of the command text" approach.
// The bare (unquoted) alternative accepts backslash-escaped spaces — the app
// lives at `/Applications/Claude Desktop.app/…`, so an unquoted `cd` target
// or manifest arg legitimately looks like `Claude\ Desktop.app`. Matched
// escapes are undone by unescapeBareArg below.
const IMAGE_MANIFEST_RE =
  /image_gen\.py[^\n]*?--manifest[=\s]+(?:"([^"]+)"|'([^']+)'|((?:\\ |\S)+))/
const IMAGE_BATCH_RE =
  /image_search\.py[^\n]*?--batch[=\s]+(?:"([^"]+)"|'([^']+)'|((?:\\ |\S)+))/
// The manifest path in the real command is RELATIVE ("projects/<name>/images/
// image_prompts.json"), because the ppt-master image step runs
// `cd ${SKILL_DIR} && python scripts/image_gen.py --manifest projects/…`. Pull
// the `cd <dir>` target out of the same command so we can resolve the relative
// manifest against it — the main-process IPC only accepts absolute paths.
const CD_DIR_RE = /\bcd\s+(?:"([^"]+)"|'([^']+)'|((?:\\ |\S)+))/

/** Undo `\ ` escapes in a bare (unquoted) shell word captured by the regexes
 *  above. Quoted captures never contain the escape, so this is safe to apply
 *  to whichever alternative matched. */
function unescapeBareArg(s: string): string {
  return s.replace(/\\ /g, ' ')
}

/**
 * Expand `$VAR` / `${VAR}` occurrences in `raw` against `VAR=value`
 * assignments found in the SAME command text. Real ppt-master launches are
 * self-contained one-liners — `SKILL_DIR="/Applications/…" && cd "$SKILL_DIR"
 * && python3 scripts/image_gen.py --manifest projects/…` — so the assignment
 * for every variable a path references sits earlier on the command line
 * (each Bash call is a fresh shell; env doesn't persist across calls, and
 * the model knows it). Same trick as extractServerProject's `$PROJ`
 * resolution, generalized to whole paths. Iterates a few passes so chained
 * assignments (`PROJ="$SKILL_DIR/projects/x"`) resolve too; variables with
 * no visible assignment stay as-is, and the absolute-path check downstream
 * rejects them (best-effort skip, never a wrong path).
 */
function expandShellVars(raw: string, command: string): string {
  let out = raw
  for (let pass = 0; pass < 3 && out.includes('$'); pass++) {
    const next = out.replace(/\$\{?(\w+)\}?/g, (whole, name: string) => {
      const assign = new RegExp(
        `(?:^|[\\s;&(])(?:export\\s+)?${name}=(?:"([^"]+)"|'([^']+)'|(\\S+))`
      ).exec(command)
      return assign ? (assign[1] ?? assign[2] ?? assign[3] ?? whole) : whole
    })
    if (next === out) break
    out = next
  }
  return out
}

/** True for a POSIX-absolute path. Renderer runs on macOS/Linux; the manifest
 *  paths are always POSIX, so a leading "/" is the only case to accept. */
function isAbsolutePosix(p: string): boolean {
  return p.startsWith('/')
}

/**
 * Resolve a (possibly relative) command-argument path against the command's
 * `cd` target. Handles `.`/`..` segments so `cd /a/b && … --manifest c/d.json`
 * yields `/a/b/c/d.json`. Returns '' when it can't produce an absolute path
 * (relative path with no `cd` to anchor it) — the caller skips those. Shared
 * by every "read a real value out of the command text" detector in this
 * file — originally written for the image manifest path, now also used to
 * resolve ppt-master project directories (usePreviewServer).
 */
function resolveCommandPath(rawPath: string, command: string): string {
  // Both the argument and the `cd` target routinely arrive as shell
  // variables (`"$SKILL_DIR"`, `"${PROJ}/images/…"`) — expand them against
  // the command's own assignments before judging absoluteness. This exact
  // shape is what silently killed the 图片 tab once the model started
  // prefixing commands with `SKILL_DIR="…" &&` instead of inlining paths.
  const path = expandShellVars(unescapeBareArg(rawPath), command)
  if (isAbsolutePosix(path)) return path
  const cd = CD_DIR_RE.exec(command)
  const base = cd
    ? expandShellVars(unescapeBareArg(cd[1] ?? cd[2] ?? cd[3] ?? ''), command)
    : ''
  if (!base || !isAbsolutePosix(base)) return ''
  const segments = `${base}/${path}`.split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

/**
 * One image-acquisition run the foreground session has launched (or is
 * running): AI generation (`image_gen.py --manifest`) or web download
 * (`image_search.py --batch`). `manifestPath` is the ABSOLUTE worklist JSON
 * that run rewrites as it progresses — resolved from the command's (possibly
 * relative, possibly `$VAR`-indirected) arg, since the IPC reader only
 * accepts absolute paths.
 */
export type ImageFeed = {
  manifestPath: string
  generating: boolean
  /** Which runner owns the worklist — drives the tab's copy (画 vs 找). */
  kind: 'gen' | 'search'
}

/**
 * Every image-acquisition run of the foreground session, in transcript order.
 * A deck routinely runs BOTH kinds (ai rows via image_gen.py, web rows via
 * image_search.py --batch), so this returns a list, deduped by manifest path
 * with the LAST matching launch winning — a per-image retry re-runs the same
 * worklist and we want the newest run's liveness (same rule as
 * usePreviewServer).
 *
 * Where the command text comes from, per tool-call part:
 *   - Bash: the command itself. `generating` is normally "no `endedAt`
 *     stamped yet", BUT a `run_in_background` Bash returns its result (and
 *     gets its endedAt) immediately while the real work keeps going — that
 *     work reports through the task_update feed instead, folded onto this
 *     part's `tasks` array. So when tasks exist they are the liveness
 *     signal: any running/pending row means the run is still in flight.
 *   - Task/Agent: the model sometimes delegates the whole generation step to
 *     a subagent; the command then only appears inside the prompt arg. The
 *     subagent's own Bash calls never reach this transcript, so scanning the
 *     prompt is the ONLY way a delegated run still opens the 图片 tab.
 *
 * Derivation shape copies useWrittenFiles deliberately: subscribe to the
 * stable `messages` reference and derive in a `useMemo` — NOT inside a
 * `useShallow` selector returning a fresh array each call, which trips
 * React's "getSnapshot should be cached" infinite loop (see the note on
 * useWrittenFiles).
 */
// A Write to the worklist JSON itself — the earliest, path-independent signal
// that an image acquisition run is coming. Matters most for Path B (the agent
// drives the HOST's native image tool: no image_gen.py command ever appears
// in the transcript) and Offline Manual mode — without this source those two
// paths never open the 图片 tab at all.
const IMAGE_WORKLIST_WRITE_RE =
  /[/\\]images[/\\](image_prompts|image_queries)\.json$/

export function useImageFeeds(): ImageFeed[] {
  const messages = useChatStore((s) => s.messages)
  return useMemo(() => {
    const feeds = new Map<string, ImageFeed>()
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (p.type !== 'tool-call') continue
        // Source 1 — the Write that creates the worklist itself. Weakest
        // liveness signal (writing the list ≠ the run started), so it's
        // registered optimistically as generating and the data-side check
        // (useImageFeedsLive / manifestDataDone in ThreadView) is what turns
        // it off. A later command-source match for the same manifest path
        // overwrites this entry with its sharper command-level signal (the
        // real flow always writes the manifest BEFORE launching the run, so
        // transcript order guarantees the command wins the Map.set).
        if (p.toolName === 'Write') {
          const args = p.args as Record<string, unknown> | undefined
          const filePath =
            typeof args?.file_path === 'string' ? args.file_path : ''
          const wlMatch = IMAGE_WORKLIST_WRITE_RE.exec(filePath)
          if (wlMatch && isAbsolutePosix(filePath)) {
            feeds.set(filePath, {
              manifestPath: filePath,
              generating: true,
              kind: wlMatch[1] === 'image_queries' ? 'search' : 'gen'
            })
          }
          continue
        }
        // Sources 2/3 — the launch command, in a Bash call or inside a
        // delegated Task/Agent prompt.
        let text = ''
        if (p.toolName === 'Bash') {
          text = previewCommandText(p)
        } else if (p.toolName === 'Task' || p.toolName === 'Agent') {
          const args = p.args as Record<string, unknown> | undefined
          text =
            typeof args?.prompt === 'string'
              ? args.prompt
              : typeof p.argsText === 'string'
                ? p.argsText
                : ''
        }
        if (!text) continue
        for (const [kind, re] of [
          ['gen', IMAGE_MANIFEST_RE],
          ['search', IMAGE_BATCH_RE]
        ] as const) {
          const match = re.exec(text)
          if (!match) continue
          const rawPath = match[1] ?? match[2] ?? match[3] ?? ''
          if (!rawPath) continue
          const manifestPath = resolveCommandPath(rawPath, text)
          if (!manifestPath) continue
          const tasks = Array.isArray(p.tasks)
            ? (p.tasks as WorkflowTask[])
            : []
          const generating =
            tasks.length > 0
              ? tasks.some(
                  (t) => t.status === 'running' || t.status === 'pending'
                )
              : typeof p.endedAt !== 'number'
          feeds.set(manifestPath, { manifestPath, generating, kind })
        }
      }
    }
    return [...feeds.values()]
  }, [messages])
}

/* ───────────────── ppt-master written-file canvas feed ──────────────── */

/** One file written by a Write tool call, surfaced into the 文件 canvas tab. */
export type WrittenFile = {
  /** Absolute path from the Write call's `file_path` arg. */
  path: string
  /** Bare filename (last path segment) for the tab's file list. */
  name: string
  /** Full file contents from the Write call's `content` arg. */
  content: string
  /** True while the tool is still streaming its args (content may be partial). */
  streaming: boolean
}

/**
 * Minimal JSON-string unescape for fields pulled out of half-streamed argsText
 * (before `args` is parsed). Mirrors `formatWrite`'s inline preview logic in
 * ToolFormatters so the canvas shows real characters, not backslash noise.
 */
function unescapeWriteFragment(src: string): string {
  return src.replace(/\\([nrtbf"\\/]|u[0-9a-fA-F]{4})/g, (_, esc: string) => {
    if (esc === 'n') return '\n'
    if (esc === 'r') return '\r'
    if (esc === 't') return '\t'
    if (esc === 'b') return '\b'
    if (esc === 'f') return '\f'
    if (esc === '"') return '"'
    if (esc === '\\') return '\\'
    if (esc === '/') return '/'
    if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    return esc
  })
}

/** Last path segment (handles both / and \ separators). */
function baseFileName(p: string): string {
  const seg = p.split(/[/\\]/).filter(Boolean)
  return seg[seg.length - 1] ?? p
}

/**
 * Best-effort `{ file_path, content }` from a Write tool-call part. Prefers the
 * parsed `args`; while the call is still streaming (`args` undefined) it regexes
 * both fields out of the half-open JSON in `argsText`, exactly like the inline
 * `formatWrite` preview — so the canvas tab fills in live as the model writes.
 */
function writeFieldsFromPart(
  part: ContentPart
): { path: string; content: string } | null {
  let path: string | undefined
  let content: string | undefined
  const args = part.args
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>
    if (typeof a.file_path === 'string') path = a.file_path
    if (typeof a.content === 'string') content = a.content
  }
  if ((path === undefined || content === undefined) && typeof part.argsText === 'string') {
    const txt = part.argsText
    if (path === undefined) {
      const m = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(txt)
      if (m) path = unescapeWriteFragment(m[1]!)
    }
    if (content === undefined) {
      // Content may still be mid-stream (no closing quote yet): capture up to
      // an unescaped closing quote OR the end of the buffer.
      const m = /"content"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|$)/.exec(txt)
      if (m) content = unescapeWriteFragment(m[1]!)
    }
  }
  if (path === undefined) return null
  return { path, content: content ?? '' }
}

/**
 * Every file the foreground session has written via the `Write` tool, in
 * first-write order, deduped by path (a later write to the same path replaces
 * the earlier entry's content but keeps its original position so the list
 * doesn't reshuffle under the user). Drives the 文件 canvas tab in slides mode.
 *
 * Same scan shape as `usePreviewServer`: walk every tool-call part once. The
 * still-streaming write (if any) is included with `streaming: true` so the tab
 * fills in live; callers use that flag to auto-follow the active write.
 *
 * NOTE: we subscribe to `messages` and derive in a `useMemo` rather than doing
 * the scan inside the zustand selector. A selector that builds fresh
 * `WrittenFile` objects every call returns a brand-new array each time —
 * `useShallow` then compares element REFERENCES (all new) and never settles,
 * tripping React's "getSnapshot should be cached" infinite loop. Deriving in a
 * `useMemo` keyed on the (stable-until-changed) `messages` reference avoids the
 * snapshot-identity trap entirely: it only recomputes when messages actually
 * change, and never calls setState, so there's no loop.
 */
export function useWrittenFiles(): WrittenFile[] {
  const messages = useChatStore((s) => s.messages)
  return useMemo(() => {
    const byPath = new Map<string, WrittenFile>()
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (p.type !== 'tool-call' || p.toolName !== 'Write') continue
        const fields = writeFieldsFromPart(p)
        if (!fields) continue
        const streaming = p.argsComplete !== true
        byPath.set(fields.path, {
          path: fields.path,
          name: baseFileName(fields.path),
          content: fields.content,
          streaming
        })
      }
    }
    return Array.from(byPath.values())
  }, [messages])
}

/* ───────────────── ppt-master SVG-edit-in-flight feed ──────────────── */

/** The deck page (.svg) the assistant is modifying RIGHT NOW, or null. */
export type EditingSvgFile = {
  /** Absolute path from the tool call's `file_path` arg. */
  path: string
  /** Bare filename — matches the svg_editor server's slide `name`. */
  name: string
}

/**
 * Best-effort `file_path` off any file tool-call part (Edit / MultiEdit /
 * Write). Prefers parsed `args`; while args are still streaming it regexes the
 * half-open JSON, same as writeFieldsFromPart — file_path is the FIRST field
 * the model emits, so the live feed below knows the target page within the
 * first few tokens of the call.
 */
function filePathFromToolPart(part: ContentPart): string | null {
  const args = part.args
  if (args && typeof args === 'object') {
    const p = (args as Record<string, unknown>).file_path
    if (typeof p === 'string') return p
  }
  if (typeof part.argsText === 'string') {
    const m = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(part.argsText)
    if (m) return unescapeWriteFragment(m[1]!)
  }
  return null
}

/**
 * The `.svg` file the foreground session is editing at THIS moment — the last
 * Edit/MultiEdit/Write tool call targeting an .svg that hasn't settled yet —
 * or null when no such call is in flight. Drives the live-preview editor's
 * "follow the AI" behavior: jump to the page being modified + skeleton overlay
 * while the modification runs (LivePreviewEditor), and the 幻灯片 tab's busy
 * dot (SlidesWorkspace).
 *
 * "In flight" uses useTurnActivity's settled-tool predicate: `result` still
 * undefined AND no `endedAt` stamp — endAssistantMessage's settlement sweep
 * backfills endedAt on interrupted calls, so an Esc'd edit drops out instead
 * of pinning the skeleton forever. The whole feed is additionally gated on the
 * session's `streaming` flag: a restored transcript can't claim an edit is
 * live, whatever shape its parts survived in.
 *
 * Same derive-in-useMemo shape as useWrittenFiles (and same reason — a
 * selector building a fresh object every call trips the getSnapshot loop).
 */
export function useEditingSvgFile(): EditingSvgFile | null {
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  return useMemo(() => {
    if (!streaming) return null
    let latest: EditingSvgFile | null = null
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue
      for (const p of (m.content as unknown) as ContentPart[]) {
        if (p.type !== 'tool-call') continue
        if (
          p.toolName !== 'Edit' &&
          p.toolName !== 'MultiEdit' &&
          p.toolName !== 'Write'
        ) {
          continue
        }
        if (p.result !== undefined || typeof p.endedAt === 'number') continue
        const path = filePathFromToolPart(p)
        if (!path || !/\.svg$/i.test(path)) continue
        // Last in-flight match wins (mirrors useStreamingAskArgsText): a fresh
        // edit supersedes any stale unsettled part earlier in the thread.
        latest = { path, name: baseFileName(path) }
      }
    }
    return latest
  }, [messages, streaming])
}

/**
 * Debounced view of `sessionLoading` for *visual* loading affordances.
 * Returns `true` only if the raw `sessionLoading` flag has been
 * continuously true for at least `delayMs`, and resets to `false` the
 * instant the flag clears.
 *
 * 现存唯一消费者是 ThreadListSidebar 的整列调暗（2026-07-17 起）：原先的另
 * 一个消费者 ThreadView 顶部进度条已删，切换加载态改由骨架屏承担——骨架订
 * 阅的是 `sessionSwitching` 而非本 hook，两者别混（见 sessionSwitching 注释）。
 *
 * Why this exists
 * ---------------
 * A switch to a recently-visited session now resolves almost instantly:
 * the history-cache hit (FusionRuntimeProvider) mounts the transcript
 * synchronously and the lazy engine returns from `switchToSession` in a
 * single microtask. In that common case `sessionLoading` flips
 * true→false within a frame or two — yet the old code lit the progress
 * bar / dimmed the sidebar immediately, producing a visible flicker that
 * read as "the app is always busy".
 *
 * Gating the *visual* signal (NOT the functional one) behind a short
 * delay means a fast switch shows no loading chrome at all, while a real
 * cold start (~3-8s) still surfaces the bar after the threshold. The
 * composer-disable path keeps reading the RAW flag via
 * `useExternalStoreRuntime.isLoading`, so input is still correctly gated
 * during the sub-threshold window — we only suppress the *decoration*,
 * never the interaction guard.
 *
 * Default `delayMs` of 200ms sits just above a cache-hit switch (a few
 * frames) and just below the point a human reads a blank wait as "stuck".
 */
export function useDelayedSessionLoading(delayMs = 200): boolean {
  const loading = useChatStore((s) => s.sessionLoading)
  const [shown, setShown] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (loading) {
      // Arm a timer; only flip `shown` true if we're still loading when
      // it fires. A fast switch clears `loading` first and the cleanup
      // below cancels the timer, so `shown` never turns on.
      timerRef.current = window.setTimeout(() => {
        setShown(true)
      }, delayMs)
      return () => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    }
    // Not loading → hide immediately (no trailing delay on the way out,
    // so the bar disappears the moment the session is ready).
    setShown(false)
    return undefined
  }, [loading, delayMs])

  return shown
}
