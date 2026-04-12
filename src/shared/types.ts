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
