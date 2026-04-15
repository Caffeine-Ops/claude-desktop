import { create } from 'zustand'
import type { ThreadMessageLike } from '@assistant-ui/react'

import { sampleSpinnerVerb } from '../constants/spinnerVerbs'

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
   * Per-session accumulated usage, reported at the end of each turn.
   * `contextTokens` is the full prompt size fed into the model for
   * the latest turn (input + cache_read + cache_create) — i.e. the
   * value the sidebar badge uses for a "xk / 200k" indicator.
   * `null` until the first turn completes for this session.
   */
  usage: { contextTokens: number; outputTokens: number } | null
}

const EMPTY_SLOT: PerSessionState = {
  messages: [],
  streaming: false,
  turnStartedAt: null,
  turnVerb: null,
  turnHasText: false,
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
  streaming: boolean
  turnStartedAt: number | null
  turnVerb: string | null
  turnHasText: boolean

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
  setError: (sessionId: string, messageId: string, error: string) => void
  endAssistantMessage: (sessionId: string) => void
  /**
   * Store the context/output token counts reported at the end of an
   * assistant turn. Replaces the previous value (we only show the
   * *latest* per-turn prompt size, not a running sum).
   */
  setUsage: (
    sessionId: string,
    usage: { contextTokens: number; outputTokens: number }
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
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
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
      turnHasText: next.turnHasText
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
    turnHasText: slot.turnHasText
  }
}

export const useChatStore = create<ChatState>((set) => ({
  sessionId: null,
  sessionLoading: false,
  perSession: {},
  messages: [],
  streaming: false,
  turnStartedAt: null,
  turnVerb: null,
  turnHasText: false,

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
          turnHasText: false
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
          argsText: ''
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
          argsComplete: true
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
              return { ...p, result }
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

  setError: (sessionId, messageId, error) => {
    set((s) => {
      const errorText = `⚠️ ${error}`
      const patch = updateSlot(s, sessionId, (slot) => {
        const existing = slot.messages.find((m) => m.id === messageId)
        if (!existing) {
          const newMessage = {
            id: messageId,
            role: 'assistant',
            content: [{ type: 'text', text: errorText }]
          } as unknown as ThreadMessageLike
          return { ...slot, messages: [...slot.messages, newMessage] }
        }
        const messages = slot.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [
            ...((m.content as unknown) as ContentPart[]),
            { type: 'text', text: `\n\n${errorText}` }
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

  endAssistantMessage: (sessionId) => {
    set((s) => {
      const patch = updateSlot(s, sessionId, (slot) => ({
        ...slot,
        streaming: false,
        turnStartedAt: null,
        turnVerb: null,
        turnHasText: false
      }))
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
      perSession: {},
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
              usage: null
            }
      return {
        sessionId,
        perSession: { ...s.perSession, [sessionId]: slot },
        ...mirrorFromSlot(slot)
      }
    }),

  setForegroundSession: (sessionId) =>
    set((s) => {
      if (sessionId === null) {
        return { sessionId: null, ...EMPTY_SLOT }
      }
      const slot = s.perSession[sessionId] ?? EMPTY_SLOT
      const perSession =
        sessionId in s.perSession
          ? s.perSession
          : { ...s.perSession, [sessionId]: slot }
      return { sessionId, perSession, ...mirrorFromSlot(slot) }
    }),

  setSessionLoading: (loading) => set({ sessionLoading: loading })
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
