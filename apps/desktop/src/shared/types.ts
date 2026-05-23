/**
 * Cross-process types shared between main (Node) and renderer (browser).
 * Keep this file free of Node- or browser-specific imports so both sides
 * can consume it.
 */

/** A single chat message in a conversation. */
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** True while an assistant message is still streaming. */
  streaming?: boolean
  /** Optional model label (e.g. "claude-opus-4-6"). */
  model?: string
}

/**
 * Events emitted by the chat subscription as the assistant produces a
 * response. Renderer reduces these into the current assistant message.
 *
 * Tool-call lifecycle
 * -------------------
 * Tool calls arrive in three flavors so the renderer can stream their
 * arguments just like assistant text:
 *
 *   1. `tool_use_start`  — block announced, name known, args empty.
 *                          Renderer creates an empty tool-call card.
 *   2. `tool_use_delta`  — raw `input_json_delta.partial_json` fragment.
 *                          Renderer appends to `argsText` (a plain
 *                          string — partial JSON is not parseable yet).
 *   3. `tool_use`        — finalized: full `input` object is ready.
 *                          Renderer replaces `argsText` with the parsed
 *                          object for pretty-printing. Emitted ONLY when
 *                          the turn finalized without prior start/delta
 *                          events (e.g. tool_use blocks that came from
 *                          a non-streaming code path) — normal streamed
 *                          turns never fire this event, they just call
 *                          `tool_use_end`.
 *   4. `tool_use_end`    — matches `tool_use_start`. Signals the block
 *                          has closed; renderer may re-parse argsText
 *                          into an object for display.
 *
 * `tool_use*` and `tool_result` carry `toolUseId` so consumers can pair a
 * use with its later result without relying on tool name (which is
 * non-unique when the same tool is called multiple times in a turn).
 */
export type ChatEvent =
  | { type: 'start'; messageId: string }
  | { type: 'chunk'; messageId: string; delta: string }
  /**
   * Extended-thinking lifecycle. Mirrors the Anthropic API's
   * `content_block_start`/`thinking_delta`/`content_block_stop` events
   * for blocks of `type: 'thinking'`. The renderer accumulates the
   * deltas into a `reasoning` part on the active assistant message
   * and renders it as a collapsible "Thinking…" card. Thinking text
   * comes interleaved with `chunk` (text) and `tool_use*` events
   * inside the same turn — order is preserved as parts array order.
   */
  | { type: 'thinking_start'; messageId: string }
  | { type: 'thinking_delta'; messageId: string; delta: string }
  | { type: 'thinking_end'; messageId: string }
  | {
      type: 'tool_use_start'
      messageId: string
      toolUseId: string
      toolName: string
    }
  | {
      type: 'tool_use_delta'
      messageId: string
      toolUseId: string
      /** Raw JSON fragment — append to the current argsText buffer. */
      partialJson: string
    }
  | {
      type: 'tool_use_end'
      messageId: string
      toolUseId: string
    }
  | {
      type: 'tool_use'
      messageId: string
      toolUseId: string
      toolName: string
      input: unknown
    }
  | {
      type: 'tool_result'
      messageId: string
      toolUseId: string
      toolName: string
      output: unknown
    }
  | {
      /**
       * Emitted once at the end of each assistant turn with the
       * accumulated context size for the *session*. `contextTokens` is
       * the full prompt size fed into the model for this turn
       * (input_tokens + cache_read + cache_create), i.e. the number
       * the sidebar badge should show as "how much of the 200k
       * window am I using right now". `outputTokens` is this turn's
       * output only — not cumulative.
       */
      type: 'usage'
      messageId: string
      contextTokens: number
      outputTokens: number
    }
  | { type: 'end'; messageId: string }
  | { type: 'error'; messageId: string; error: string }

/** Simple conversation container. */
export interface Session {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

/**
 * One row in the sidebar session list. Distilled from fusion-code's
 * JSONL transcript (read via `@anthropic-ai/claude-agent-sdk`'s
 * `listSessions` / `getSessionInfo`) so the renderer can render it
 * directly without knowing about the SDK's richer SDKSessionInfo shape.
 *
 * The id is fusion-code's session UUID (same string that names the
 * `.jsonl` file). Main uses it as the `resume` argument to `query()`
 * when the user clicks the row.
 */
export interface ThreadSummary {
  id: string
  /**
   * Prefer an explicit title (`custom-title` / `ai-title` entry in the
   * JSONL). Falls back to a truncated `firstPrompt` when neither is
   * present, and finally to a literal `"New chat"` on a brand-new
   * session file with no user turn yet.
   */
  title: string
  /** ms-since-epoch of the last transcript entry. */
  updatedAt: number
  /** First user prompt, truncated, for preview rendering. */
  firstPrompt?: string
  /** Turn count (user message count), useful for "N messages" meta. */
  turnCount: number
}

/**
 * Tool-permission request sent from main → renderer. Mirrors the info
 * Claude Code's terminal dialog shows:
 *
 *   [displayName]               e.g. "Read file"
 *     [summary]                 e.g. "~/.zshrc · pages 1"
 *   Do you want to proceed?
 *     1. Yes                              → allow-once
 *     2. Yes, allow <scopeLabel>          → allow-session
 *        during this session
 *     3. No                               → deny
 *
 * The "allow during this session" option is optional: when `scopeLabel`
 * is undefined the dialog should omit option 2 entirely (e.g. for tools
 * we don't know how to scope safely).
 */
export interface PermissionRequest {
  /** Opaque id echoed back in the response so main can resolve the pending promise. */
  requestId: string
  sessionId: string
  toolUseId: string
  toolName: string
  /** User-facing label, e.g. "Read file". */
  displayName: string
  /** Short parameter summary rendered as a code-block in the dialog. */
  summary: string
  /** Full raw input — the dialog may fall back on this when summary is empty. */
  input: unknown
  /**
   * Human label for the "allow during this session" option, e.g.
   * "reading from Downloads/". Undefined ⇒ dialog skips option 2.
   */
  scopeLabel?: string
}

/** Which button the user clicked in the permission dialog. */
export type PermissionDecisionKind = 'allow-once' | 'allow-session' | 'deny'

/** Renderer → main response for a PermissionRequest. */
export interface PermissionResponse {
  requestId: string
  decision: PermissionDecisionKind
  /**
   * Optional input rewrite. When present, engine's `canUseTool` passes
   * this to the SDK as `updatedInput` instead of the original input.
   *
   * Used by the `AskUserQuestion` branch of PermissionDialog: the
   * dialog presents each question's options, collects the user's
   * selection into `input.answers`, then resolves the promise with
   * `decision: 'allow-once'` + `updatedInput: { ...originalInput,
   * answers: { <questionText>: <selectedLabel> } }`. The SDK hands that
   * input to the tool, which returns the answers as its tool_result —
   * which is how the assistant "hears" what the user chose.
   *
   * Not set (undefined) for normal allow/deny flows. Main merges it
   * over the original input so partial rewrites are safe.
   */
  updatedInput?: unknown
}

/**
 * Status of one MCP server attached to the active fusion-code session.
 * Mirrors the shape fusion-code emits in its `system init` SDK message,
 * normalized to a stable union we can switch on in the renderer.
 */
export interface McpServerInfo {
  name: string
  status: 'connected' | 'disconnected' | 'pending' | 'error' | 'unknown'
}

/**
 * Session-wide metadata captured from fusion-code's first `system init`
 * SDK message. Used by client-side slash command dialogs (`/skill`,
 * `/mcp`) to populate their list contents without making the renderer
 * parse SDK messages itself. Lives in main, exposed via IPC.
 *
 * Empty defaults are returned before fusion-code has been spawned for
 * the first time. The renderer should treat empty arrays as a "not
 * loaded yet" state and prompt the user to send a message first.
 */
export interface SessionMeta {
  /** All skills available to the model in this session. */
  skills: string[]
  /** All MCP servers attached + their connection state. */
  mcpServers: McpServerInfo[]
  /** All slash commands fusion-code knows about (used for autocomplete). */
  slashCommands: string[]
  /** Current model id, e.g. "gpt-5.4[1m]". */
  model?: string
  /** Working directory the session was opened in. */
  cwd?: string
}

/**
 * One instrumentation breadcrumb pushed from the main-process engine
 * to the renderer over IPC. The LogsDialog renders these as a timeline
 * so the user can see exactly where the ~30s first-turn latency goes
 * — cli spawn, first `system init` arrival, first chunk, turn end, etc.
 *
 * Fields are kept deliberately minimal so the shape is stable across
 * process boundaries: a monotonic epoch timestamp, a human-readable
 * label (dot/colon separated path, e.g. `switchToSession:begin` or
 * `turn:firstChunk`), the current active session id for correlation,
 * and an optional bag of extras. No enums — labels are pure strings
 * so new events don't require a shared type update.
 */
export interface LogEvent {
  /** Epoch milliseconds from `Date.now()` in main. */
  ts: number
  /** Human-readable event identifier, e.g. `ensureSessionReady:begin`. */
  label: string
  /** Current active session id when the event fired, if any. */
  sessionId?: string
  /**
   * Free-form extras (counts, durations, flags). Must be JSON-serializable
   * since it crosses the Electron IPC boundary via structured clone.
   */
  details?: Record<string, unknown>
}
