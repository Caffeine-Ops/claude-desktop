import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { query, type PermissionResult, type Query } from '@anthropic-ai/claude-agent-sdk'
import type {
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam
} from '@anthropic-ai/sdk/resources'

import type { ChatImagePayload } from '../../shared/ipc-channels'
import type {
  ChatEvent,
  McpServerInfo,
  SessionMeta
} from '../../shared/types'
import { AsyncMessageQueue } from './asyncMessageQueue'
import { invalidateFileSuggestions } from './fileSuggestions'
import { getPermissionBroker } from './permissionBroker'
import { deriveScope } from './permissionScope'

/**
 * util.inspect options for SDK message dumps in the pump log.
 *
 *   depth: null           → expand every nested object (stream_event
 *                           deltas are two levels deep, result.usage
 *                           is nested too)
 *   maxStringLength: 2000 → truncate individual strings (e.g. a giant
 *                           text_delta) to keep the terminal usable
 *   compact: 3            → use the "smart" compact layout up to 3
 *                           breakpoints before switching to multi-line
 *   breakLength: 120      → wrap at ~terminal width
 *
 * Tuned for "give me everything that isn't actively user-hostile". If
 * you need zero truncation (e.g. diffing two runs), set
 * `maxStringLength: Infinity` temporarily.
 */
const SDK_INSPECT_OPTS = {
  depth: null,
  colors: false,
  maxStringLength: 2000,
  compact: 3 as const,
  breakLength: 120
}

/**
 * Session-level state kept in the main process for each logical chat.
 *
 * Milestone B (long-lived SDK session): a single `query({ prompt: iter })`
 * call stays alive for the whole chat. User messages are pushed into
 * `queue` and the SDK consumes them one turn at a time. `runPump()`
 * drains the assistant-side stream in parallel and fans SDK messages
 * out to ChatEvents for the renderer.
 *
 * The first `send()` pays the ~8s fusion-code cold-start. Every turn
 * after that only pays the API round-trip.
 *
 * Invariants:
 *  - `handle`, `queue`, and `pumpPromise` are created together by
 *    `openSession()` and torn down together in the pump's `finally`.
 *  - `active` may be non-null while `handle === null` only briefly:
 *    during the synchronous tail of `send()` before the auth check
 *    fails and clears it. Otherwise `active !== null` implies the
 *    pump is running.
 */
interface SessionRuntime {
  /** Historical messages — reserved for future session persistence. */
  messages: unknown[]
  /** The turn currently awaiting an assistant response, or null. */
  active: ActiveTurn | null
  /** User-message queue feeding the SDK's streaming prompt. */
  queue: AsyncMessageQueue<unknown> | null
  /** Long-lived SDK Query handle for the whole session. */
  handle: Query | null
  /** Promise of the background pump task; resolves when the SDK stream ends. */
  pumpPromise: Promise<void> | null
}

interface ActiveTurn {
  requestId: number
  messageId: string
  toolNameByUseId: Map<string, string>
  sawTextDelta: boolean
  sawTextContent: boolean
  /** SDK messages counted for this turn (used for log throttling). */
  sdkMessageCount: number
  /**
   * Per-content-block tracker populated by `handleStreamEvent` when the
   * SDK fans out `content_block_start` + `input_json_delta` events for
   * a tool_use block. `handleAssistantMessage` checks this map before
   * emitting a finalizing `tool_use` event — if the id is already here,
   * the streamed start/delta path has covered it and we only need to
   * emit `tool_use_end` (not the full-input `tool_use`) to avoid
   * double-rendering. Keyed by toolUseId, not block index, because the
   * renderer pairs tool-use with tool-result by toolUseId.
   */
  streamedToolUseIds: Set<string>
  /**
   * Active index → toolUseId lookup for the duration of a single block.
   * `content_block_start` gives us (index, id); `content_block_delta`
   * only gives us `index`, so we need this map to route delta fragments
   * back to the right toolUseId. Cleared on `content_block_stop`.
   */
  toolUseIdByBlockIndex: Map<number, string>
}

class ChatEngine extends EventEmitter {
  private sessions = new Map<string, SessionRuntime>()
  private nextRequestId = 1
  /**
   * Most recent SessionMeta captured from the fusion-code child's
   * `system init` SDK message. Populated lazily on the first turn
   * the user sends; before then it's empty arrays + undefined model.
   * Read by the renderer through `getSessionMeta()` IPC to power
   * client-side slash-command dialogs (`/skill`, `/mcp`).
   */
  private sessionMeta: SessionMeta = {
    skills: [],
    mcpServers: [],
    slashCommands: []
  }

  /**
   * User-selected workspace directory. Null until the renderer's
   * `WorkspaceGate` drops a folder on the window and calls
   * `setWorkspace()`. This is the *only* source of truth for the cwd
   * passed to `query()` — `send()` refuses to spawn the SDK until it
   * is set, so the fusion-code child is guaranteed to start inside
   * the directory the user picked.
   *
   * Not persisted across process restarts by design: the contract with
   * the UI is "first launch ⇒ pick a folder". Wire a `userData` file
   * if that turns out to be annoying.
   */
  private workspaceDir: string | null = null

  /** Snapshot of the cached session meta. Returns a fresh object so
      the renderer cannot accidentally mutate main-process state. */
  getSessionMeta(): SessionMeta {
    return {
      skills: [...this.sessionMeta.skills],
      mcpServers: this.sessionMeta.mcpServers.map((s) => ({ ...s })),
      slashCommands: [...this.sessionMeta.slashCommands],
      model: this.sessionMeta.model,
      cwd: this.sessionMeta.cwd
    }
  }

  /** Current workspace path, or null before the user has picked one. */
  getWorkspace(): string | null {
    return this.workspaceDir
  }

  /**
   * Commit a user-picked workspace directory. Called exactly once per
   * process lifetime by the renderer's `WorkspaceGate` after a drop.
   * Throws on validation failure so the renderer can surface the error
   * in the gate UI; throws on a second call because the SDK child has
   * already baked its cwd at spawn time.
   *
   * Validation rules:
   *   - must be a non-empty string
   *   - must be an absolute path (renderer has no business sending
   *     relative paths; absolute is what `webUtils.getPathForFile`
   *     returns)
   *   - must exist on disk and be a directory
   *
   * On success, invalidate the file-suggestions cache so the first
   * `@`-mention popover after the gate reflects the new workspace
   * instead of stale process.cwd() entries.
   */
  setWorkspace(candidate: string): string {
    if (this.workspaceDir !== null) {
      throw new Error(
        'Workspace is already set for this session. Restart to change it.'
      )
    }
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error('Workspace path is required.')
    }
    if (!isAbsolute(candidate)) {
      throw new Error(`Workspace path must be absolute (got "${candidate}").`)
    }
    let stat
    try {
      stat = statSync(candidate)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Workspace path does not exist: ${msg}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${candidate}`)
    }
    this.workspaceDir = candidate
    invalidateFileSuggestions()
    console.log('[engine] workspace set', { path: candidate })
    return candidate
  }

  async send(
    sessionId: string,
    text: string,
    images?: readonly ChatImagePayload[]
  ): Promise<{ messageId: string }> {
    // Hard gate: the workspace must have been picked via the drag-drop
    // gate before we spawn anything. The renderer already refuses to
    // render the composer until getWorkspace() returns a non-null path,
    // but we re-check here so a buggy (or malicious) renderer can't
    // bypass the UI by directly invoking chatApi.send.
    if (this.workspaceDir === null) {
      throw new Error(
        'Workspace not set. Drop a folder on the window to pick one first.'
      )
    }

    const runtime = await this.getSession(sessionId)
    const messageId = randomUUID()
    const requestId = this.nextRequestId++

    // Open a long-lived SDK session on first send. openSession() spawns
    // the fusion-code child, starts the pump, and is the only thing that
    // pays the cold-start tax. All later sends reuse the same process.
    if (!runtime.queue || !runtime.handle) {
      try {
        this.openSession(sessionId, runtime)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[engine] openSession failed:', msg)
        this.emitEvent(sessionId, { type: 'start', messageId })
        this.emitEvent(sessionId, {
          type: 'error',
          messageId,
          error: msg
        })
        this.emitEvent(sessionId, { type: 'end', messageId })
        return { messageId }
      }
    }

    // Register this turn as the active one. The pump looks at
    // `runtime.active` to decide which messageId to emit ChatEvents for.
    runtime.active = {
      requestId,
      messageId,
      toolNameByUseId: new Map(),
      sawTextDelta: false,
      sawTextContent: false,
      sdkMessageCount: 0,
      streamedToolUseIds: new Set(),
      toolUseIdByBlockIndex: new Map()
    }
    this.emitEvent(sessionId, { type: 'start', messageId })

    // Build the SDK user message. Text-only turns keep the string
    // short-path (fusion-code expects this for slash commands and
    // zero-image prompts). Image turns switch to a ContentBlockParam[]
    // array with the text first and each image as an ImageBlockParam.
    //
    // Mirrors free-code's processTextPrompt.ts ordering: text on top,
    // images below. The Anthropic API doesn't care about order but
    // the model's chain-of-thought tends to reference images better
    // when they come after the prompt sentence describing them.
    const messageContent: MessageParam['content'] =
      images && images.length > 0
        ? this.buildMultimodalContent(text, images)
        : text

    const userMsg = {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: messageContent
      },
      parent_tool_use_id: null,
      session_id: sessionId
    }
    runtime.queue!.push(userMsg)
    console.log('[engine] send queued user turn', {
      sessionId,
      messageId,
      textLength: text.length,
      textPreview: text.slice(0, 120),
      imageCount: images?.length ?? 0,
      queueSize: runtime.queue!.size
    })

    return { messageId }
  }

  /**
   * Convert validated ChatImagePayload entries into Anthropic SDK
   * ContentBlockParam format, prepending the user's text block.
   *
   * The data URL was already shape-checked by validateImages() in the
   * IPC layer (see main/ipc/register.ts), so here we can trust:
   *   - prefix matches `data:image/<subtype>;base64,<body>`
   *   - subtype is one of the API-accepted media types
   *
   * We still do a defensive parse in case a future caller bypasses the
   * validator — a malformed entry just gets skipped with a warning
   * rather than corrupting the whole turn.
   */
  private buildMultimodalContent(
    text: string,
    images: readonly ChatImagePayload[]
  ): ContentBlockParam[] {
    const blocks: ContentBlockParam[] = []

    // Text block goes first even if empty — matching free-code's
    // processTextPrompt.ts, which always emits the text before images.
    // An empty string is a valid text block per the Anthropic SDK
    // types; we only skip if the user has no caption AND no whitespace.
    if (text.length > 0) {
      const textBlock: TextBlockParam = { type: 'text', text }
      blocks.push(textBlock)
    }

    for (const img of images) {
      const parsed = this.parseImageDataUrl(img.dataUrl)
      if (!parsed) {
        console.warn('[engine] skipping malformed image data URL')
        continue
      }
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType,
          data: parsed.data
        }
      }
      blocks.push(imageBlock)
    }

    // Edge case: all images were malformed and text was empty. Fall
    // back to a placeholder so we don't push an empty-content message
    // into the SDK, which some protocol versions reject.
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '(empty message)' })
    }

    return blocks
  }

  /**
   * Parse `data:image/<subtype>;base64,<body>` into the shape the SDK
   * expects. Returns null on any mismatch — caller treats null as
   * "skip this image".
   */
  private parseImageDataUrl(dataUrl: string): {
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    data: string
  } | null {
    const match = dataUrl.match(
      /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/
    )
    if (!match) return null
    // Normalize image/jpg → image/jpeg for the Base64ImageSource union
    // (Anthropic's type only accepts image/jpeg, not image/jpg).
    const mediaType = match[1]!.replace(
      'image/jpg',
      'image/jpeg'
    ) as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    return { mediaType, data: match[2]! }
  }

  abort(sessionId: string): void {
    const runtime = this.sessions.get(sessionId)
    const active = runtime?.active
    if (!runtime || !active) return

    console.log('[engine] abort called', {
      sessionId,
      messageId: active.messageId
    })

    // Ask the SDK to interrupt the current turn. This is a control
    // request that the CLI handles via the stream-json protocol; if the
    // SDK kills the whole query(), the pump's finally block will reset
    // the session and the next send() will spawn a fresh child.
    try {
      const p = runtime.handle?.interrupt()
      if (p && typeof (p as Promise<void>).catch === 'function') {
        void (p as Promise<void>).catch(() => {})
      }
    } catch {
      // ignore abort cleanup errors
    }

    this.emitEvent(sessionId, { type: 'end', messageId: active.messageId })
    runtime.active = null
  }

  subscribe(sessionId: string, handler: (e: ChatEvent) => void): () => void {
    const key = `chat:${sessionId}`
    this.on(key, handler)
    return () => this.off(key, handler)
  }

  /**
   * Spawn the long-lived fusion-code child process and wire up the
   * AsyncMessageQueue → query() → pump pipeline. Called once per
   * session, on the first send. The pump runs in the background until
   * the SDK stream ends; its `finally` resets `runtime.queue` /
   * `runtime.handle` / `runtime.pumpPromise` so the next send spawns
   * a fresh child.
   *
   * Throws if the CLI binary cannot be located. Send() catches and
   * surfaces the error to the UI.
   */
  private openSession(sessionId: string, runtime: SessionRuntime): void {
    const cliPath = this.resolveFusionCliPath()
    console.log('[engine] opening long-lived SDK session', {
      sessionId,
      cliPath,
      cwd: this.getWorkingDirectory(),
      env: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '(unset)',
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? '(set)' : '(unset)',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '(set)' : '(unset)',
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '(unset)',
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '(unset)',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '(unset)'
      }
    })

    const queue = new AsyncMessageQueue<unknown>()
    runtime.queue = queue

    // The cast on iterable() pins it to SDKUserMessage for the SDK type
    // signature. We don't import SDKUserMessage explicitly because the
    // shape we push (`{ type: 'user', message: { role, content } ... }`)
    // is intentionally minimal — adding typing here would force the
    // user-message construction in send() to drag in MessageParam.
    const handle = query({
      prompt: queue.iterable() as unknown as AsyncIterable<{
        type: 'user'
        message: { role: 'user'; content: string }
        parent_tool_use_id: string | null
        session_id: string
      }>,
      options: {
        // Spawn our local fusion-code binary instead of the SDK's
        // bundled upstream claude-code.
        pathToClaudeCodeExecutable: cliPath,
        cwd: this.getWorkingDirectory(),
        // Default permission mode + an Electron-native `canUseTool`
        // callback. The SDK will invoke our callback whenever a tool
        // call would otherwise need a terminal prompt; we bridge it
        // through permissionBroker → IPC → renderer's PermissionDialog.
        // Allow rules added via "allow during session" live in the
        // SDK's in-process `session` scope, so the dialog only fires
        // once per { toolName, scope } pair for the lifetime of the
        // fusion-code child process.
        permissionMode: 'default',
        canUseTool: (toolName, input, ctx) =>
          this.handleCanUseTool(sessionId, toolName, input, ctx),
        // Stream text deltas so the UI sees typewriter-style chunks.
        includePartialMessages: true,
        // env.json has already been merged into process.env during
        // bootstrap — forward everything so ANTHROPIC_BASE_URL / auth
        // tokens / model alias overrides reach the child CLI.
        env: process.env as Record<string, string>
      }
    })
    runtime.handle = handle

    // Launch the pump in the background. The pump owns the lifetime
    // of `runtime.handle` / `runtime.queue` — when it exits (cleanly
    // or via error), it nulls them out so the next send re-opens.
    runtime.pumpPromise = this.runPump(sessionId, runtime, handle)
  }

  /**
   * SDK `canUseTool` callback. Called by the Agent SDK for every tool
   * invocation the CLI would otherwise need to prompt on.
   *
   * Flow
   * ----
   *   1. Derive a user-facing scope (displayName, summary, scopeLabel,
   *      rules) from the tool name + raw input via `deriveScope`.
   *   2. Hand the request to `permissionBroker.request`, which mints a
   *      requestId, emits a `request` event (picked up by register.ts
   *      and forwarded to the renderer via IPC), and returns a promise
   *      that resolves once the renderer replies with a
   *      `PermissionResponse`.
   *   3. Translate the user's decision into an SDK `PermissionResult`.
   *      - `allow-once`    → `{ behavior: 'allow' }` (no rule added)
   *      - `allow-session` → `{ behavior: 'allow', updatedPermissions: [
   *                           addRules → destination: 'session' ] }`
   *        The SDK's in-process rule engine will then auto-approve any
   *        future tool call that matches a rule in this list, without
   *        calling us again.
   *      - `deny`          → `{ behavior: 'deny', message, interrupt: false }`
   *        `interrupt: false` lets the assistant keep going after a
   *        rejected tool — matching the free-code CLI experience.
   *   4. If the broker throws (user hit stop, window closed, signal
   *      aborted), fall back to `deny` so the SDK unblocks cleanly
   *      instead of hanging forever.
   *
   * NB: `options.toolUseID` is typed as `string | undefined` in the SDK
   * d.ts in case the CLI ever omits it; we default to '' so the
   * downstream payload shape stays stable.
   */
  private async handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      signal: AbortSignal
      toolUseID: string
      title?: string
      displayName?: string
      description?: string
    }
  ): Promise<PermissionResult> {
    const scope = deriveScope(toolName, input)
    const toolUseId = ctx.toolUseID ?? ''
    console.log('[engine] canUseTool', {
      sessionId,
      toolName,
      toolUseId,
      hasScope: !!scope.scopeLabel
    })

    try {
      const outcome = await getPermissionBroker().request(
        {
          sessionId,
          toolUseId,
          toolName,
          // Prefer the SDK-provided friendly label when it gives us one
          // (e.g. "Read file"), otherwise fall back to our own mapping.
          displayName: ctx.displayName ?? scope.displayName,
          summary: scope.summary,
          scopeLabel: scope.scopeLabel,
          input
        },
        ctx.signal
      )

      if (outcome.decision === 'deny') {
        return {
          behavior: 'deny',
          message: 'User declined this tool call.',
          interrupt: false,
          decisionClassification: 'user_reject'
        }
      }

      // `updatedInput` is typed as optional in @anthropic-ai/claude-agent-sdk's
      // sdk.d.ts (`updatedInput?: Record<string, unknown>`), but the runtime
      // Zod schema fusion-code's CLI uses for the stream-json protocol
      // validates it as **required** on the allow branch. If we omit it we
      // get a Zod invalid_union error that fusion-code folds back into
      // `tool_result.is_error = true`, which the assistant reads as "the
      // permission check failed" and keeps retrying with different args.
      //
      // For most tools we pass the original `input` unchanged. The
      // exception is AskUserQuestion, where the PermissionDialog
      // collects the user's answers into `updatedInput.answers` and
      // sends it back through broker.respond(). We merge the two so
      // fields the dialog didn't touch survive intact.
      const effectiveInput = this.mergeUpdatedInput(input, outcome.updatedInput)

      if (outcome.decision === 'allow-session' && scope.rules.length > 0) {
        return {
          behavior: 'allow',
          updatedInput: effectiveInput,
          updatedPermissions: [
            {
              type: 'addRules',
              rules: scope.rules,
              behavior: 'allow',
              destination: 'session'
            }
          ],
          decisionClassification: 'user_permanent'
        }
      }

      return {
        behavior: 'allow',
        updatedInput: effectiveInput,
        decisionClassification: 'user_temporary'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Permission request failed.'
      console.warn('[engine] canUseTool → deny (broker error):', msg)
      return {
        behavior: 'deny',
        message: msg,
        interrupt: false
      }
    }
  }

  /**
   * Background consumer of the SDK stream. Iterates a single long-lived
   * `Query` and fans messages out to the renderer via `handleSdkMessage`.
   *
   * Turn boundary detection
   * -----------------------
   * Each user turn is followed by exactly one `result` SDK message
   * (subtype 'success' | 'error_*'). When we see one, we emit `end`
   * for the active turn and clear `runtime.active`. Future SDK
   * messages without an active turn (e.g. the very first `system init`
   * before any user input, or stragglers after we cleared) are dropped.
   *
   * Error / shutdown
   * ----------------
   * If the SDK throws or the child process dies, we emit a final
   * error event for the active turn (if any) and reset the session
   * state in `finally`. The next `send()` will then call
   * `openSession()` again and pay another cold start.
   */
  private async runPump(
    sessionId: string,
    runtime: SessionRuntime,
    handle: Query
  ): Promise<void> {
    console.log('[engine] pump started', { sessionId })
    try {
      // Iterate as AsyncIterable<unknown> so downstream duck-typing
      // (handleSdkMessage) doesn't trip over the SDKMessage
      // discriminated-union narrowing — several variants (e.g.
      // SDKAssistantMessage) lack the `subtype` field we read.
      for await (const sdkMessage of handle as AsyncIterable<unknown>) {
        // Always cache SessionMeta from system init, regardless of
        // whether there's an active turn. This message arrives once
        // per session lifetime, on the first SDK warmup, and carries
        // skills/mcp_servers/slash_commands the renderer dialogs need.
        if (
          this.isRecord(sdkMessage) &&
          sdkMessage.type === 'system' &&
          sdkMessage.subtype === 'init'
        ) {
          this.updateSessionMeta(sdkMessage)
        }

        const active = runtime.active
        const msgType =
          this.isRecord(sdkMessage) && typeof sdkMessage.type === 'string'
            ? sdkMessage.type
            : 'unknown'
        const subtype =
          this.isRecord(sdkMessage) && typeof sdkMessage.subtype === 'string'
            ? sdkMessage.subtype
            : ''

        if (!active) {
          // Stragglers between turns — log the full message anyway so
          // we can see what the SDK emitted, then drop.
          console.log(
            `[engine] pump: no active turn, dropping ${msgType}${subtype ? ' ' + subtype : ''}`,
            inspect(sdkMessage, SDK_INSPECT_OPTS)
          )
          continue
        }

        active.sdkMessageCount++
        console.log(
          `[engine] sdkMsg #${active.sdkMessageCount} ${msgType}${subtype ? ' ' + subtype : ''}`,
          inspect(sdkMessage, SDK_INSPECT_OPTS)
        )

        this.handleSdkMessage(sessionId, active, sdkMessage)

        // Authoritative turn boundary: a `result` message is the
        // SDK's per-turn closing record. Emit `end` and let the next
        // user turn install a fresh ActiveTurn.
        if (this.isRecord(sdkMessage) && sdkMessage.type === 'result') {
          console.log('[engine] turn ended', {
            messageId: active.messageId,
            sdkMessageCount: active.sdkMessageCount,
            sawTextContent: active.sawTextContent
          })
          if (!active.sawTextContent) {
            console.warn(
              '[engine] turn produced zero text content — UI will show empty assistant bubble'
            )
          }
          this.emitEvent(sessionId, {
            type: 'end',
            messageId: active.messageId
          })
          runtime.active = null
        }
      }
      console.log('[engine] pump exited gracefully', { sessionId })
    } catch (error) {
      console.error('[engine] pump threw:', error)
      if (error instanceof Error && error.stack) {
        console.error('[engine] stack:\n' + error.stack)
      }
      const active = runtime.active
      if (active) {
        const message = error instanceof Error ? error.message : String(error)
        this.emitEvent(sessionId, {
          type: 'error',
          messageId: active.messageId,
          error: message
        })
        this.emitEvent(sessionId, {
          type: 'end',
          messageId: active.messageId
        })
        runtime.active = null
      }
    } finally {
      // Pump exit means the SDK child process is gone — either it
      // ended cleanly (queue closed) or it crashed. Either way, reset
      // session state so the next send() opens a fresh session.
      if (runtime.queue) {
        runtime.queue.close()
        runtime.queue = null
      }
      runtime.handle = null
      runtime.pumpPromise = null
      console.log('[engine] session reset after pump exit', { sessionId })
    }
  }

  private handleSdkMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: unknown
  ): void {
    if (!this.isRecord(sdkMessage) || typeof sdkMessage.type !== 'string') return

    switch (sdkMessage.type) {
      case 'stream_event':
        this.handleStreamEvent(sessionId, active, sdkMessage.event)
        break
      case 'assistant':
        this.handleAssistantMessage(sessionId, active, sdkMessage)
        break
      case 'user':
        this.handleUserMessage(sessionId, active, sdkMessage)
        break
      case 'assistant_error':
        this.emitEvent(sessionId, {
          type: 'error',
          messageId: active.messageId,
          error:
            typeof sdkMessage.message === 'string'
              ? sdkMessage.message
              : 'Assistant returned an error.'
        })
        break
      case 'result':
        this.handleResultMessage(sessionId, active, sdkMessage)
        break
      default:
        break
    }
  }

  /**
   * Fan the SDK's raw `stream_event` messages into the narrower
   * `ChatEvent` shape the renderer consumes. The SDK passes through
   * Anthropic's content_block_start / content_block_delta /
   * content_block_stop events unchanged. We handle three of them:
   *
   *   - content_block_start with content_block.type === 'tool_use' or
   *     'server_tool_use' → emit `tool_use_start` so the renderer
   *     creates an empty tool-call card. Record the toolUseId so we
   *     can route subsequent deltas and suppress the finalize event.
   *   - content_block_delta with delta.type === 'text_delta' → emit
   *     `chunk` (unchanged from before — text streaming already worked).
   *   - content_block_delta with delta.type === 'input_json_delta' →
   *     look up the toolUseId for this block index and emit
   *     `tool_use_delta` with the partial_json fragment. The renderer
   *     appends it to the argsText buffer for that tool-call card.
   *   - content_block_stop → if this index is a streamed tool_use,
   *     emit `tool_use_end` and drop the index from the lookup.
   *
   * We intentionally do NOT try to parse partial_json here — it's
   * almost always a half-open JSON string that any strict parser would
   * reject. The renderer stores argsText raw and re-parses on
   * tool_use_end; components that care about partial state (e.g. the
   * TodoWrite → right rail sync) run a lenient parse on their side.
   */
  private handleStreamEvent(
    sessionId: string,
    active: ActiveTurn,
    event: unknown
  ): void {
    if (!this.isRecord(event) || typeof event.type !== 'string') return

    switch (event.type) {
      case 'content_block_start':
        this.handleContentBlockStart(sessionId, active, event)
        return
      case 'content_block_delta':
        this.handleContentBlockDelta(sessionId, active, event)
        return
      case 'content_block_stop':
        this.handleContentBlockStop(sessionId, active, event)
        return
      default:
        return
    }
  }

  private handleContentBlockStart(
    sessionId: string,
    active: ActiveTurn,
    event: Record<string, unknown>
  ): void {
    const index = typeof event.index === 'number' ? event.index : null
    const block = this.isRecord(event.content_block) ? event.content_block : null
    if (index === null || !block) return
    if (typeof block.type !== 'string') return

    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return
      active.toolUseIdByBlockIndex.set(index, block.id)
      active.toolNameByUseId.set(block.id, block.name)
      active.streamedToolUseIds.add(block.id)
      this.emitEvent(sessionId, {
        type: 'tool_use_start',
        messageId: active.messageId,
        toolUseId: block.id,
        toolName: block.name
      })
    }
    // text blocks don't need a start event — renderer still lazily
    // creates the assistant message on first `chunk` delta.
  }

  private handleContentBlockDelta(
    sessionId: string,
    active: ActiveTurn,
    event: Record<string, unknown>
  ): void {
    if (!this.isRecord(event.delta)) return
    const delta = event.delta
    const index = typeof event.index === 'number' ? event.index : null

    if (delta.type === 'text_delta') {
      if (typeof delta.text !== 'string' || delta.text.length === 0) return
      active.sawTextDelta = true
      active.sawTextContent = true
      this.emitEvent(sessionId, {
        type: 'chunk',
        messageId: active.messageId,
        delta: delta.text
      })
      return
    }

    if (delta.type === 'input_json_delta') {
      if (typeof delta.partial_json !== 'string' || delta.partial_json.length === 0) {
        return
      }
      if (index === null) return
      const toolUseId = active.toolUseIdByBlockIndex.get(index)
      // If we never saw a matching content_block_start, swallow the
      // delta silently — emitting without an id would strand the
      // fragment on the renderer side with nothing to attach to.
      if (!toolUseId) return
      this.emitEvent(sessionId, {
        type: 'tool_use_delta',
        messageId: active.messageId,
        toolUseId,
        partialJson: delta.partial_json
      })
    }
  }

  private handleContentBlockStop(
    sessionId: string,
    active: ActiveTurn,
    event: Record<string, unknown>
  ): void {
    const index = typeof event.index === 'number' ? event.index : null
    if (index === null) return
    const toolUseId = active.toolUseIdByBlockIndex.get(index)
    if (!toolUseId) return
    active.toolUseIdByBlockIndex.delete(index)
    this.emitEvent(sessionId, {
      type: 'tool_use_end',
      messageId: active.messageId,
      toolUseId
    })
  }

  private handleAssistantMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: Record<string, unknown>
  ): void {
    const content = this.getContentBlocks(sdkMessage)
    for (const block of content) {
      if (!this.isRecord(block) || typeof block.type !== 'string') continue

      if (
        (block.type === 'tool_use' || block.type === 'server_tool_use') &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        active.toolNameByUseId.set(block.id, block.name)
        // Two paths:
        //
        //   a) We already streamed this block via content_block_start +
        //      input_json_delta + content_block_stop. `tool_use_start`
        //      created the card, deltas filled argsText, `tool_use_end`
        //      closed the stream. The renderer already has everything
        //      it needs, so we DO NOT re-emit a full `tool_use` event —
        //      that would blow away the argsText with the parsed input
        //      and cause a visible flicker. (Same pattern as the
        //      sawTextDelta guard for text blocks below.)
        //
        //   b) The SDK skipped the fine-grained stream path and gave us
        //      the block only as part of the finalized `assistant`
        //      message. Emit a single `tool_use` with the full input so
        //      the renderer can render the card in one shot.
        if (active.streamedToolUseIds.has(block.id)) {
          continue
        }
        this.emitEvent(sessionId, {
          type: 'tool_use',
          messageId: active.messageId,
          toolUseId: block.id,
          toolName: block.name,
          input: this.normalizeToolInput(block.input)
        })
        continue
      }

      if (
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.length > 0 &&
        !active.sawTextDelta
      ) {
        active.sawTextContent = true
        this.emitEvent(sessionId, {
          type: 'chunk',
          messageId: active.messageId,
          delta: block.text
        })
      }
    }
  }

  private handleUserMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: Record<string, unknown>
  ): void {
    const content = this.getContentBlocks(sdkMessage)
    for (const block of content) {
      if (!this.isRecord(block) || block.type !== 'tool_result') continue

      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const toolName = active.toolNameByUseId.get(toolUseId) ?? 'UnknownTool'
      this.emitEvent(sessionId, {
        type: 'tool_result',
        messageId: active.messageId,
        toolUseId,
        toolName,
        output: block.content
      })
    }
  }

  private handleResultMessage(
    sessionId: string,
    active: ActiveTurn,
    sdkMessage: Record<string, unknown>
  ): void {
    const isSuccess = sdkMessage.subtype === 'success' && sdkMessage.is_error !== true

    if (!isSuccess) {
      this.emitEvent(sessionId, {
        type: 'error',
        messageId: active.messageId,
        error: this.getResultErrorText(sdkMessage)
      })
      return
    }

    if (!active.sawTextContent && typeof sdkMessage.result === 'string' && sdkMessage.result) {
      active.sawTextContent = true
      this.emitEvent(sessionId, {
        type: 'chunk',
        messageId: active.messageId,
        delta: sdkMessage.result
      })
    }
  }

  private async getSession(sessionId: string): Promise<SessionRuntime> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const runtime: SessionRuntime = {
      messages: [],
      active: null,
      queue: null,
      handle: null,
      pumpPromise: null
    }
    this.sessions.set(sessionId, runtime)
    return runtime
  }

  /**
   * Locate the fusion-code ./cli binary the agent SDK should spawn as
   * the child process. Resolution order:
   *
   *   1. `FUSION_CODE_CLI_PATH` env var — highest precedence; set it
   *      in env.json or the shell to pin an explicit path
   *   2. `<resourcesPath>/fusion-code-cli[.exe]` — packaged Electron
   *      app, the CLI is shipped via electron-builder extraResources
   *   3. `<cwd>/../free-code/cli` — typical `bun run dev` layout
   *      (cwd == claude-desktop/)
   *   4. `<importer>/../../../free-code/cli` — bundled main at
   *      `out/main/index.js`, three levels up lands at claude_code_01/
   *   5. `<importer>/../../../../free-code/cli` — extra fallback for
   *      dev when the importer is the source file not the bundle
   *
   * Throws with every candidate listed, so a misconfigured install is
   * easy to diagnose from the console error shown in the UI.
   */
  private resolveFusionCliPath(): string {
    const envOverride = process.env.FUSION_CODE_CLI_PATH
    if (envOverride) {
      if (!existsSync(envOverride)) {
        throw new Error(
          `FUSION_CODE_CLI_PATH is set to "${envOverride}" but that file does not exist.`
        )
      }
      return envOverride
    }

    const selfDir = dirname(fileURLToPath(import.meta.url))
    const bundledName = process.platform === 'win32' ? 'fusion-code-cli.exe' : 'fusion-code-cli'
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const candidates = [
      ...(resourcesPath ? [resolve(resourcesPath, bundledName)] : []),
      resolve(process.cwd(), '../free-code/cli'),
      resolve(selfDir, '../../../free-code/cli'),
      resolve(selfDir, '../../../../free-code/cli')
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    throw new Error(
      'Fusion Code CLI binary not found. Tried:\n' +
        candidates.map((c) => `  - ${c}`).join('\n') +
        '\nSet FUSION_CODE_CLI_PATH in env.json (or the shell) to override.'
    )
  }

  private getContentBlocks(sdkMessage: Record<string, unknown>): unknown[] {
    if (!this.isRecord(sdkMessage.message)) return []
    const { content } = sdkMessage.message
    return Array.isArray(content) ? content : []
  }

  private normalizeToolInput(input: unknown): unknown {
    if (typeof input !== 'string') return input
    try {
      return JSON.parse(input)
    } catch {
      return input
    }
  }

  /**
   * Merge a PermissionDialog-supplied `updatedInput` rewrite over the
   * original tool input, preserving fields the dialog didn't touch.
   *
   * Used by the AskUserQuestion branch: the dialog only knows how to
   * fill in `answers` / `annotations`, so we need to keep the original
   * `questions` array intact — otherwise the SDK would re-validate an
   * input with no questions and reject the tool call.
   *
   * If the original isn't an object (unlikely for tools routed through
   * canUseTool, which always produces a Record), or if the rewrite
   * isn't an object (e.g. the dialog chose not to rewrite), we fall
   * back to the rewrite-or-original rule rather than trying to merge.
   */
  private mergeUpdatedInput(
    original: Record<string, unknown>,
    rewrite: unknown
  ): Record<string, unknown> {
    if (!this.isRecord(rewrite)) return original
    return { ...original, ...rewrite }
  }

  private getResultErrorText(sdkMessage: Record<string, unknown>): string {
    const { errors, result, message } = sdkMessage
    if (Array.isArray(errors) && errors.every((item) => typeof item === 'string')) {
      return errors.join('\n')
    }
    if (typeof result === 'string' && result.length > 0) return result
    if (typeof message === 'string' && message.length > 0) return message
    return 'QueryEngine 执行失败。'
  }

  /**
   * Pulls the four interesting arrays out of fusion-code's `system init`
   * SDK message and stores them on `this.sessionMeta`. Defensively
   * filters every entry so a malformed payload from a future CLI
   * version can never crash the renderer dialogs.
   *
   * Shape we read (from the actual logs):
   *   {
   *     type: 'system',
   *     subtype: 'init',
   *     skills: string[],
   *     mcp_servers: [{ name: string, status: string }],
   *     slash_commands: string[],
   *     model: string,
   *     cwd: string,
   *     ...
   *   }
   */
  private updateSessionMeta(initMsg: Record<string, unknown>): void {
    const skills = Array.isArray(initMsg.skills)
      ? initMsg.skills.filter((s): s is string => typeof s === 'string')
      : []

    const mcpServers: McpServerInfo[] = Array.isArray(initMsg.mcp_servers)
      ? initMsg.mcp_servers
          .filter((s): s is Record<string, unknown> => this.isRecord(s))
          .map((s) => ({
            name: typeof s.name === 'string' ? s.name : 'unknown',
            status: this.normalizeMcpStatus(s.status)
          }))
      : []

    const slashCommands = Array.isArray(initMsg.slash_commands)
      ? initMsg.slash_commands.filter((s): s is string => typeof s === 'string')
      : []

    const model = typeof initMsg.model === 'string' ? initMsg.model : undefined
    const cwd = typeof initMsg.cwd === 'string' ? initMsg.cwd : undefined

    this.sessionMeta = { skills, mcpServers, slashCommands, model, cwd }
    console.log('[engine] sessionMeta cached', {
      skillCount: skills.length,
      serverCount: mcpServers.length,
      commandCount: slashCommands.length,
      model
    })
  }

  /** Coerce any string the CLI hands us into a known status union. */
  private normalizeMcpStatus(value: unknown): McpServerInfo['status'] {
    if (typeof value !== 'string') return 'unknown'
    const v = value.toLowerCase()
    if (v === 'connected') return 'connected'
    if (v === 'disconnected') return 'disconnected'
    if (v === 'pending' || v === 'connecting') return 'pending'
    if (v === 'error' || v === 'failed') return 'error'
    return 'unknown'
  }

  /**
   * Working directory handed to `query()` on SDK spawn. Always reads
   * the user-picked workspace — `send()` already guarantees this is
   * non-null by the time openSession() runs, but we throw if called
   * in some other code path to catch regressions loudly instead of
   * silently falling back to process.cwd() (which in a packaged .app
   * is `/`, the wrong answer).
   */
  private getWorkingDirectory(): string {
    if (this.workspaceDir === null) {
      throw new Error('getWorkingDirectory() called before workspace was set.')
    }
    return this.workspaceDir
  }

  private emitEvent(sessionId: string, event: ChatEvent): void {
    this.emit(`chat:${sessionId}`, event)
    this.emit('chat', sessionId, event)
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null
  }
}

let instance: ChatEngine | null = null
export function getChatEngine(): ChatEngine {
  if (!instance) instance = new ChatEngine()
  return instance
}
export type { ChatEngine }
