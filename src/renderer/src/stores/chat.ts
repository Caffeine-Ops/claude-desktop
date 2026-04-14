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
 * Streaming model
 * ---------------
 *   1. User turn:
 *      appendUserMessage(text)
 *        → push { role: 'user', content: [{ type: 'text', text }] }
 *
 *   2. Assistant turn begins (main-process `start` event):
 *      startAssistantMessage(messageId)
 *        → push { role: 'assistant', content: [{ type: 'text', text: '' }] }
 *        → streaming = true
 *
 *   3. Text deltas (main-process `chunk` events):
 *      appendAssistantDelta(messageId, delta)
 *        → append into the trailing text part, or start a new text part
 *          if the previous part was a tool-call. This lets the same
 *          assistant turn contain `[text, tool-call, text, tool-call]`
 *          interleaved, matching how the model actually emitted them.
 *
 *   4. Tool calls (main-process `tool_use` / `tool_result` events):
 *      addToolCall(messageId, toolUseId, toolName, args)
 *      updateToolCallResult(toolUseId, result)
 *        → the runtime pairs tool-call with tool-result by toolCallId.
 *          We append a tool-call part to the current assistant message
 *          and later patch `result` onto it.
 *
 *   5. Error (main-process `error`):
 *      setError(messageId, error)
 *        → append a short error line as the last text part.
 *
 *   6. Turn end (main-process `end`):
 *      endAssistantMessage() → streaming = false
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

interface ChatState {
  /**
   * fusion-code UUID of the currently active session, or null before
   * one has been picked (fresh launch) / while switching is in flight.
   * Mirrors the `activeSessionId` that main process tracks — the IPC
   * layer guarantees these stay in sync via `chatApi.switchSession`.
   */
  sessionId: string | null
  /**
   * True while the chat store is loading a different session's
   * history or waiting for main to finish spawning a new fusion-code
   * child. The composer uses this to grey out its send button, and
   * the sidebar row shows a loading indicator.
   */
  sessionLoading: boolean
  messages: ThreadMessageLike[]
  streaming: boolean

  /**
   * Wall-clock timestamp (ms since epoch) when the current assistant
   * turn started, or null when no turn is in flight. Driven by the
   * main-process `start` event. Used by ThinkingSpinner to show
   * "(12s · esc to interrupt)" while the turn is thinking.
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

  // User input ─────────────────────────────────────────────────────────
  /**
   * Push a user turn into the store. `content` is a pre-built part
   * array so the caller can mix text and image parts — FusionRuntimeProvider
   * extracts text + image attachments from assistant-ui's AppendMessage
   * and passes both through here. Pass a single text part for text-only
   * turns (the common case).
   */
  appendUserMessage: (content: ContentPart[]) => void

  // Assistant streaming ────────────────────────────────────────────────
  startAssistantMessage: (messageId: string) => void
  appendAssistantDelta: (messageId: string, delta: string) => void
  /**
   * Append an extended-thinking text fragment to a `reasoning` part
   * on the active assistant message. Multiple thinking blocks in the
   * same turn roll into a single rolling reasoning part — separated
   * by a blank line if the engine opens a new block. The first
   * delta lazily creates the assistant message if it doesn't exist
   * yet, mirroring `appendAssistantDelta`'s lazy-create path.
   */
  appendThinkingDelta: (messageId: string, delta: string) => void
  /**
   * Pre-create an empty reasoning part on the current assistant message.
   * Called on `thinking_start` so the "正在思考…" indicator appears the
   * instant the SDK opens a thinking block, instead of waiting for the
   * first `thinking_delta` (which can lag several seconds while Claude
   * is actually reasoning). Idempotent: if the trailing part is already
   * a reasoning, this is a no-op so we don't double-insert when the
   * engine emits multiple thinking blocks back-to-back.
   */
  startReasoning: (messageId: string) => void
  /**
   * Create an empty tool-call part on the current assistant message.
   * Called on `tool_use_start` — the renderer card appears immediately
   * with the tool name but no args yet. The `argsText` field is the
   * streaming buffer that subsequent deltas append into.
   */
  startToolCall: (
    messageId: string,
    toolUseId: string,
    toolName: string
  ) => void
  /**
   * Append a raw JSON fragment to the streaming `argsText` buffer of
   * an existing tool-call part. The fragment is almost always partial
   * (half-open strings, missing brackets), so we NEVER try to JSON.parse
   * it here — that happens on finalize. Components that want to react
   * to partial state (e.g. the TodoWrite → right rail sync) run their
   * own lenient parse on the accumulating argsText string.
   */
  appendToolCallArgsDelta: (toolUseId: string, delta: string) => void
  /**
   * Mark a streaming tool-call as complete. Tries to JSON.parse the
   * accumulated argsText and, if successful, stores it as `args` for
   * pretty-printing. On parse failure the argsText stays as the
   * display source (better than dropping the content). Does not need
   * a toolName because the part already has it from start.
   */
  finalizeToolCall: (toolUseId: string) => void
  /**
   * Add a tool-call part in one shot with a fully-formed input. This
   * is the non-streaming path (when engine.ts emits a finalizing
   * `tool_use` event because the SDK skipped the stream_event fan-out).
   * If a streamed part with this toolUseId already exists — meaning
   * start/delta/end have already flowed through — the call becomes a
   * no-op to prevent double rendering.
   */
  addToolCall: (
    messageId: string,
    toolUseId: string,
    toolName: string,
    args: unknown
  ) => void
  updateToolCallResult: (toolUseId: string, result: unknown) => void
  setError: (messageId: string, error: string) => void
  endAssistantMessage: () => void

  reset: () => void

  /**
   * Replace the whole thread with the given session id and history.
   * Called by the ThreadListAdapter after a sidebar click — the
   * history comes from `chatApi.loadSession`, already mapped to
   * ThreadMessageLike[] on the main side.
   */
  setSession: (sessionId: string, messages: ThreadMessageLike[]) => void

  /** Flip the loading indicator on/off during a session switch. */
  setSessionLoading: (loading: boolean) => void
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export const useChatStore = create<ChatState>((set) => ({
  sessionId: null,
  sessionLoading: false,
  messages: [],
  streaming: false,
  turnStartedAt: null,
  turnVerb: null,
  turnHasText: false,

  appendUserMessage: (content) => {
    // Guard: an empty content array would crash assistant-ui's
    // fromThreadMessageLike (it filters empty parts and the message
    // would end up with content: [], same problem as startAssistantMessage).
    // Fall back to a whitespace placeholder so the user turn renders
    // even if something upstream passed nothing.
    const safeContent: ContentPart[] =
      content.length > 0 ? content : [{ type: 'text', text: ' ' }]
    const message: ThreadMessageLike = {
      id: randomId('usr'),
      role: 'user',
      content: safeContent as unknown as ThreadMessageLike['content']
    }
    set((s) => ({ messages: [...s.messages, message] }))
  },

  startAssistantMessage: (_messageId) => {
    // Only flip the streaming flag. We deliberately DO NOT push a
    // placeholder assistant message here — assistant-ui's
    // `fromThreadMessageLike` filters out empty text parts
    // (`part.text.trim().length === 0 → null`), which would leave
    // the message with `content: []` and break runtime internals
    // (`getState()` returns undefined → `_getMessageRuntime` crashes
    // on `undefined.submittedFeedback`).
    //
    // Instead, the first real chunk / tool_use creates the message
    // lazily via the helper below. Streaming state still flips
    // immediately so the composer disables its send button.
    //
    // We also mint fresh turn meta (start timestamp + a random verb)
    // so ThinkingSpinner has a stable anchor for its elapsed-seconds
    // counter and the "Cogitating…" label.
    //
    // Idempotent — if `streaming` is already true (the renderer
    // pre-flipped it on send() entry so the user sees feedback
    // through the ~3-8s lazy fusion-code cold start), we leave
    // turnStartedAt / turnVerb alone so the spinner's elapsed
    // counter stays continuous and the random verb doesn't
    // change mid-turn. The incoming main-process `start` event
    // is effectively a no-op when it arrives second.
    set((s) => {
      if (s.streaming) return s
      return {
        streaming: true,
        turnStartedAt: Date.now(),
        turnVerb: sampleSpinnerVerb(),
        turnHasText: false
      }
    })
  },

  appendAssistantDelta: (messageId, delta) => {
    set((s) => {
      // First non-empty delta of this turn ⇒ tell the spinner to hide.
      const flipTurnHasText = !s.turnHasText && delta.length > 0
      const existing = s.messages.find((m) => m.id === messageId)
      if (!existing) {
        // First chunk — create the assistant message with this delta
        // as its initial text part. `delta` is the SDK's raw output,
        // which may legitimately start with whitespace; if every
        // chunk is whitespace-only we still don't push (would be
        // filtered by fromThreadMessageLike anyway).
        if (delta.length === 0) return s
        const newMessage = {
          id: messageId,
          role: 'assistant',
          content: [{ type: 'text', text: delta }]
        } as unknown as ThreadMessageLike
        return {
          messages: [...s.messages, newMessage],
          ...(flipTurnHasText ? { turnHasText: true } : {})
        }
      }
      return {
        messages: s.messages.map((m) => {
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
        }),
        ...(flipTurnHasText ? { turnHasText: true } : {})
      }
    })
  },

  startReasoning: (messageId) => {
    set((s) => {
      const existing = s.messages.find((m) => m.id === messageId)
      const emptyReasoningPart: ContentPart = {
        type: 'reasoning',
        text: ''
      }
      // Lazy assistant message create — same shape as
      // appendAssistantDelta / appendThinkingDelta. The thinking
      // block can open before `start` has had a chance to land, or
      // before any other content, so the message may not exist yet.
      if (!existing) {
        const newMessage = {
          id: messageId,
          role: 'assistant',
          content: [emptyReasoningPart]
        } as unknown as ThreadMessageLike
        return { messages: [...s.messages, newMessage] }
      }
      return {
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [...((m.content as unknown) as ContentPart[])]
          const last = parts[parts.length - 1]
          // Idempotent: if the last part is already a reasoning
          // (either an empty one we just opened, or a streaming one
          // that's already accumulating deltas), don't add a second
          // empty placeholder. The next thinking_delta will still
          // append into the existing trailing reasoning part.
          if (last && last.type === 'reasoning') {
            return m
          }
          parts.push(emptyReasoningPart)
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
      }
    })
  },

  appendThinkingDelta: (messageId, delta) => {
    if (!delta) return
    set((s) => {
      const existing = s.messages.find((m) => m.id === messageId)
      // Lazy assistant message create — same shape as
      // appendAssistantDelta. A turn can open with a thinking block
      // before any text or tool_use, so the message may not exist
      // yet on the first thinking delta.
      const reasoningPart: ContentPart = {
        type: 'reasoning',
        text: delta
      }
      if (!existing) {
        const newMessage = {
          id: messageId,
          role: 'assistant',
          content: [reasoningPart]
        } as unknown as ThreadMessageLike
        return { messages: [...s.messages, newMessage] }
      }
      return {
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [...((m.content as unknown) as ContentPart[])]
          const last = parts[parts.length - 1]
          if (last && last.type === 'reasoning') {
            // Same trailing-reasoning part — append into it.
            parts[parts.length - 1] = {
              ...last,
              text: ((last.text as string) ?? '') + delta
            }
          } else {
            // The model interleaved a text or tool_use block between
            // two thinking blocks. Start a new reasoning part rather
            // than reaching back into the previous one — that would
            // re-order the visible parts and break the chronology
            // ("model thought, then said X, then thought again" is
            // a meaningfully different story from "model thought
            // twice and then said X").
            parts.push(reasoningPart)
          }
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
      }
    })
  },

  startToolCall: (messageId, toolUseId, toolName) => {
    set((s) => {
      // Lazy message creation — matches addToolCall / appendAssistantDelta.
      // A turn can start directly with a tool call and no text, and
      // the assistant message needs to exist before the tool-call part
      // can hang off it.
      const existing = s.messages.find((m) => m.id === messageId)
      // Build a tool-call part with an empty `argsText` buffer. We
      // intentionally omit `args` until finalize — ToolCallCard reads
      // argsText first when running, args second when complete, so
      // leaving args undefined at start prevents a stale "{}" flash.
      const toolCallPart: ContentPart = {
        type: 'tool-call',
        toolCallId: toolUseId,
        toolName,
        argsText: ''
      }
      if (!existing) {
        const newMessage = {
          id: messageId,
          role: 'assistant',
          content: [toolCallPart]
        } as unknown as ThreadMessageLike
        return { messages: [...s.messages, newMessage] }
      }
      // Guard against duplicate start (can happen if the SDK re-delivers
      // a block). Leave the existing part untouched.
      const existingParts = (existing.content as unknown) as ContentPart[]
      if (
        existingParts.some(
          (p) => p.type === 'tool-call' && p.toolCallId === toolUseId
        )
      ) {
        return s
      }
      return {
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m
          const parts = [...((m.content as unknown) as ContentPart[]), toolCallPart]
          return {
            ...m,
            content: parts as unknown as ThreadMessageLike['content']
          }
        })
      }
    })
  },

  appendToolCallArgsDelta: (toolUseId, delta) => {
    if (!delta) return
    set((s) => {
      let changed = false
      const messages = s.messages.map((m) => {
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
        return { ...m, content: parts as unknown as ThreadMessageLike['content'] }
      })
      if (!changed) return s
      return { messages }
    })
  },

  finalizeToolCall: (toolUseId) => {
    set((s) => {
      let changed = false
      const messages = s.messages.map((m) => {
        if (!Array.isArray(m.content)) return m
        const parts = ((m.content as unknown) as ContentPart[]).map((p) => {
          if (p.type === 'tool-call' && p.toolCallId === toolUseId) {
            changed = true
            // Try to parse the accumulated argsText. On success store
            // the parsed object as `args`; on failure leave argsText
            // as the display source. Either way we mark `argsComplete`
            // so ToolCallCard can flip its presentation from
            // "streaming raw" to "parsed pretty".
            const text = typeof p.argsText === 'string' ? p.argsText : ''
            let parsed: unknown = undefined
            if (text.length > 0) {
              try {
                parsed = JSON.parse(text)
              } catch {
                // leave parsed undefined; UI falls back on argsText
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
        return { ...m, content: parts as unknown as ThreadMessageLike['content'] }
      })
      if (!changed) return s
      return { messages }
    })
  },

  addToolCall: (messageId, toolUseId, toolName, args) => {
    set((s) => {
      const existing = s.messages.find((m) => m.id === messageId)
      // If a streamed tool-call part with this id already exists,
      // start/delta/end already covered it — avoid appending a
      // duplicate card. (Engine.ts suppresses the finalize tool_use
      // in the same situation, but we guard here as a belt-and-braces
      // defense against out-of-order events.)
      if (existing) {
        const existingParts = (existing.content as unknown) as ContentPart[]
        if (
          existingParts.some(
            (p) => p.type === 'tool-call' && p.toolCallId === toolUseId
          )
        ) {
          return s
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
        // Turn opened directly with a tool call (no text first).
        // Creating the assistant message with just the tool-call part
        // is fine — fromThreadMessageLike keeps tool-call parts.
        const newMessage = {
          id: messageId,
          role: 'assistant',
          content: [toolCallPart]
        } as unknown as ThreadMessageLike
        return {
          messages: [...s.messages, newMessage]
        }
      }
      return {
        messages: s.messages.map((m) => {
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
      }
    })
  },

  updateToolCallResult: (toolUseId, result) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (!Array.isArray(m.content)) return m
        let changed = false
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
    }))
  },

  setError: (messageId, error) => {
    set((s) => {
      const existing = s.messages.find((m) => m.id === messageId)
      const errorText = `⚠️ ${error}`
      if (!existing) {
        // Turn errored before any text or tool call was emitted. Show
        // the error as a standalone assistant message so the user
        // actually sees what went wrong.
        const newMessage = {
          id: messageId,
          role: 'assistant',
          content: [{ type: 'text', text: errorText }]
        } as unknown as ThreadMessageLike
        return {
          messages: [...s.messages, newMessage]
        }
      }
      return {
        messages: s.messages.map((m) => {
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
      }
    })
  },

  endAssistantMessage: () =>
    set({
      streaming: false,
      turnStartedAt: null,
      turnVerb: null,
      turnHasText: false
    }),

  reset: () =>
    set({
      sessionId: null,
      sessionLoading: false,
      messages: [],
      streaming: false,
      turnStartedAt: null,
      turnVerb: null,
      turnHasText: false
    }),

  setSession: (sessionId, messages) =>
    set({
      sessionId,
      messages,
      // Any in-flight turn was on the previous session — clear so a
      // stale `streaming: true` doesn't lock the composer on the newly
      // loaded thread.
      streaming: false,
      turnStartedAt: null,
      turnVerb: null,
      turnHasText: false
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
