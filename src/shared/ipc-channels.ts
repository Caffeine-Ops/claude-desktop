import type {
  ChatEvent,
  LogEvent,
  PermissionRequest,
  PermissionResponse,
  SessionMeta,
  ThreadSummary
} from './types'
import type { ThreadMessageLike } from '@assistant-ui/react'

/**
 * Central registry of IPC channel names. Main and renderer both import
 * these constants so a typo is caught at compile time, not runtime.
 */
export const IPC_CHANNELS = {
  /** Renderer → main. Sends a user message, returns { messageId }. */
  CHAT_SEND: 'chat:send',
  /** Renderer → main. Cancels the in-flight assistant response. */
  CHAT_ABORT: 'chat:abort',
  /** Main → renderer. Fires ChatEvents for a live assistant stream. */
  CHAT_EVENT: 'chat:event',
  /** Main → renderer. Asks the user to approve a pending tool call. */
  PERMISSION_REQUEST: 'permission:request',
  /** Renderer → main. Delivers the user's decision for a permission request. */
  PERMISSION_RESPOND: 'permission:respond',
  /** Renderer → main. Pulls the cached session meta (skills, mcp, …). */
  SESSION_META_GET: 'session-meta:get',
  /** Renderer → main. Lists files under the session cwd for @-mention. */
  FILE_SUGGESTIONS_LIST: 'file-suggestions:list',
  /** Renderer → main. Reads the current workspace path (or null). */
  WORKSPACE_GET: 'workspace:get',
  /** Renderer → main. Sets the workspace to a user-picked directory. */
  WORKSPACE_SET: 'workspace:set',
  /**
   * Renderer → main. Opens the OS native folder picker. Returns the
   * absolute path the user picked, or null if they cancelled. The
   * renderer follows up with `WORKSPACE_SET` to actually commit it —
   * keeping pick and set as separate calls means the renderer can
   * still surface a validation error from set() in the gate UI.
   */
  WORKSPACE_PICK: 'workspace:pick',
  /**
   * Renderer → main. Opens a workspace-relative file path in the OS
   * default handler (Finder's "open with default app"). Used by the
   * Files tree's double-click.
   */
  WORKSPACE_FILE_OPEN: 'workspace:file-open',
  /**
   * Renderer → main. Lists all sessions (JSONL transcripts) for the
   * current workspace, sorted by updatedAt desc. Backed by
   * `@anthropic-ai/claude-agent-sdk`'s `listSessions({ dir })`.
   */
  SESSION_LIST: 'session:list',
  /**
   * Renderer → main. Loads a session's full message history from its
   * JSONL file, mapped into assistant-ui's ThreadMessageLike shape so
   * the store can drop them in directly.
   */
  SESSION_LOAD: 'session:load',
  /**
   * Renderer → main. Mints a new session UUID (not yet written to
   * disk). The caller then calls SESSION_SWITCH with `resume: false`
   * to actually spawn the CLI on this id.
   */
  SESSION_NEW: 'session:new',
  /**
   * Renderer → main. Tears down the current fusion-code SDK Query
   * handle and reopens it on the given sessionId, optionally with
   * `resume: true` so the CLI reloads the transcript from its JSONL.
   */
  SESSION_SWITCH: 'session:switch',
  /**
   * Renderer → main. Sets a session's display title by appending a
   * `custom-title` line to its jsonl. Same on-disk shape that
   * fusion-code's `/rename` slash command writes, so the SDK reader
   * picks it up identically. After success main also broadcasts
   * SESSION_LIST_CHANGED so the sidebar re-pulls.
   */
  SESSION_RENAME: 'session:rename',
  /**
   * Main → renderer. Broadcast whenever the session list may have
   * changed (new session captured from system init, current session
   * title updated, etc). Renderer's ThreadListAdapter re-fetches on
   * receipt.
   */
  SESSION_LIST_CHANGED: 'session:list-changed',
  /**
   * Main → renderer. Broadcast whenever `engine.sessionMeta` changes —
   * typically on the fusion-code child's first `system init` message
   * (which carries skills / mcp servers / slash commands) or when the
   * cli reports a meta refresh mid-session. The renderer's Composer
   * subscribes so the `/` popover picks up the full slash-command list
   * the instant the cli finishes its ~30s cold start, instead of
   * waiting for the first turn to end (which used to be the only time
   * `getSessionMeta` was re-polled).
   */
  SESSION_META_CHANGED: 'session:meta-changed',
  /**
   * Main → renderer. Per-event instrumentation stream. One message
   * per engine lifecycle breadcrumb (switchToSession, ensureSessionReady,
   * systemInit received, turn:start / turn:firstChunk / turn:end, …).
   * The renderer's LogsDialog subscribes via `onLogEvent` and stores
   * entries in a rolling buffer so the user can see where the ~30s
   * first-turn latency is spent — cold start vs API TTFB vs turn
   * streaming. There's no "replay since start" semantics: events that
   * fire before the renderer subscribes are simply lost, which is
   * fine because the only interesting ones happen after the user
   * clicks something.
   */
  LOG_EVENT: 'log:event',
  /**
   * Renderer → main. Relaunches the Electron app. Used by the
   * "change workspace" flow — since the engine bakes the fusion-code
   * child's cwd at spawn time, swapping workspaces means restarting
   * the whole process so the gate shows again on cold start.
   */
  APP_RELAUNCH: 'app:relaunch',
  /**
   * Renderer → main. Opens `~/.claude` in the OS file manager via
   * `shell.openPath`. Used by the sidebar user-info menu so the user
   * can poke at their CLI config / project transcripts directly.
   */
  APP_OPEN_CLAUDE_DIR: 'app:open-claude-dir',
  /**
   * Renderer → main. Opens the current workspace directory in the OS
   * file manager via `shell.openPath`. Used by the Files panel header
   * chip — clicking the workspace path reveals the folder. Main reads
   * the workspace from the engine, so the renderer never sends a path
   * (and can't trick main into opening an arbitrary directory).
   */
  WORKSPACE_OPEN: 'workspace:open',
  /**
   * Renderer → main (fire-and-forget `send`). Notifies the main
   * process that the user flipped the UI language. Main uses it to
   * rebuild the tray context menu — renderer stores the choice in its
   * own zustand + localStorage and is the source of truth, main just
   * mirrors the current value for surfaces it owns (tray menu, and
   * eventually native menus / dialogs if we add any).
   *
   * Push cadence:
   *  - Once on renderer mount (App.tsx effect) so main catches up to
   *    the persisted value after a cold start, where main can't read
   *    the renderer's localStorage itself.
   *  - Every time `useI18n.setLang` runs.
   */
  LANG_CHANGED: 'lang:changed',
  /**
   * One-shot audio transcription via the OpenAI compatible
   * `/audio/transcriptions` endpoint. Renderer records a chunk via
   * MediaRecorder, ships the raw bytes + mime type through this
   * channel, main does the authenticated multipart POST against
   * `OPENAI_BASE_URL` using `OPENAI_API_KEY` from env.json, and
   * returns `{ text }` (or `{ error }` on any failure). Keeping
   * the HTTP call in main means the API key never lands in the
   * renderer — the window can't be snapshotted for the secret.
   */
  TRANSCRIBE_AUDIO: 'speech:transcribe',
  /**
   * Renderer → main. Reads the current CLI backend choice plus
   * detection info for the user's system `claude` binary. Called by
   * the settings page every time the CLI backend section opens so the
   * UI can grey out the "system" radio when no binary is installed.
   */
  CLI_BACKEND_GET: 'cli-backend:get',
  /**
   * Renderer → main. Persists the user's CLI backend choice. Takes
   * effect on the next `openSession` — no relaunch, but an in-flight
   * turn on the old backend is unaffected until it finishes.
   */
  CLI_BACKEND_SET: 'cli-backend:set'
} as const

/**
 * Image attached to a user turn. Carried inline as a data URL
 * (`data:image/<subtype>;base64,...`) because that's the natural output
 * of the renderer's ImageAttachmentAdapter — the main process splits
 * it into { media_type, data } when building the SDK user message.
 *
 * filename is optional (pasted clipboard images have none; drag-dropped
 * or file-picker images do). It's echoed to the Anthropic API so the
 * model sees a stable filename in the vision block.
 */
export interface ChatImagePayload {
  dataUrl: string
  filename?: string
}

export interface TranscribeAudioPayload {
  /** Raw audio bytes. MediaRecorder output; main treats them opaquely. */
  audio: Uint8Array
  /** MIME type of the audio blob, e.g. `audio/webm;codecs=opus`. */
  mimeType: string
  /** Optional ISO language hint (`zh` / `en`) forwarded to Whisper. */
  language?: string
}

export type TranscribeAudioResult =
  | { text: string; error?: undefined }
  | { text?: undefined; error: string }

export type ChatSendPayload = {
  sessionId: string
  text: string
  images?: readonly ChatImagePayload[]
}
export type ChatSendResult = { messageId: string }
export type ChatAbortPayload = { sessionId: string }
export type ChatEventPayload = { sessionId: string; event: ChatEvent }

/**
 * Wrapper for LOG_EVENT IPC payloads. Single field because the event
 * already carries its own timestamp + sessionId; keeping an envelope
 * around it leaves room for future metadata (e.g. an ordering seq
 * number) without breaking the subscription shape.
 */
export type LogEventPayload = { event: LogEvent }

/**
 * Payload for the file suggestions list IPC. The renderer passes
 * `force: true` when it wants to bypass the 5s TTL cache in main
 * (e.g. manual refresh). Default is a cached read.
 */
export type FileSuggestionsListPayload = { force?: boolean } | undefined

export interface FileSuggestionsListResult {
  /** Absolute cwd the list was scanned from. */
  cwd: string
  /** Repo-relative paths, forward-slash normalized. */
  files: readonly string[]
  /** True when the full set exceeded the main-side cap and was cut off. */
  truncated: boolean
}

/**
 * Payload for WORKSPACE_SET. `path` must be an absolute path that exists
 * on disk and points at a directory. Main re-validates before applying.
 */
export type WorkspaceSetPayload = { path: string }

/**
 * Result of WORKSPACE_PICK. `path` is null when the user cancelled the
 * native dialog; otherwise it's the absolute path they picked. The
 * renderer still has to call `setWorkspace({ path })` to commit it.
 */
export type WorkspacePickResult = { path: string | null }

/**
 * Result of WORKSPACE_GET / WORKSPACE_SET.
 *
 * `path` is null before the user has picked a workspace (cold start).
 * Once set, it stays fixed for the lifetime of the main process because
 * the fusion-code child process has its cwd baked in at spawn time and
 * the whole point of the gate is to make the first-turn spawn use the
 * user's directory.
 */
export type WorkspaceState = { path: string | null }

/**
 * Payload for WORKSPACE_FILE_OPEN. `relPath` must be a workspace-relative
 * POSIX-style path; main re-validates that it doesn't escape the
 * workspace root (no `..` segments, not absolute) before passing to
 * `shell.openPath`.
 */
export type WorkspaceFileOpenPayload = { relPath: string }

/**
 * Result of WORKSPACE_FILE_OPEN.
 *
 * `error` is the empty string on success; non-empty when `shell.openPath`
 * returns a failure (e.g. no handler registered for the mime type) or
 * validation rejects the path. Renderer treats empty as "opened fine".
 */
export type WorkspaceFileOpenResult = { error: string }

/* ─────────────────── Session (thread) channels ─────────────────── */

export type SessionListResult = { threads: readonly ThreadSummary[] }

export type SessionLoadPayload = { sessionId: string }
export type SessionLoadResult = { messages: readonly ThreadMessageLike[] }

export type SessionNewResult = { sessionId: string }

export type SessionSwitchPayload = { sessionId: string; resume: boolean }
export type SessionSwitchResult = { sessionId: string }

export type SessionRenamePayload = { sessionId: string; title: string }
export type SessionRenameResult = { ok: true }

/**
 * Payload for LANG_CHANGED. Must match the renderer's `Lang` type in
 * `src/renderer/src/i18n.ts` — keep in sync.
 */
export type LangChangedPayload = { lang: 'zh' | 'en' }

/**
 * Which CLI binary the engine spawns for the Agent SDK child.
 * - `bundled` — the fusion-code CLI shipped inside the Electron app.
 * - `system`  — the `claude` binary detected on the user's PATH.
 */
export type CliBackendMode = 'bundled' | 'system'

/**
 * Result of CLI_BACKEND_GET. Carries the current mode plus everything
 * the settings UI needs to render the picker in one round trip.
 *
 * - `bundledPath`: absolute path of the fusion-code binary the engine
 *   would spawn if mode were bundled. null when resolution failed
 *   (the settings UI shows a warning).
 * - `systemInfo`:  detection result for the user's system claude —
 *   `null` when nothing is installed, else `{path, version}`. The
 *   version may be `null` if `claude --version` failed to parse.
 */
export interface CliBackendState {
  mode: CliBackendMode
  bundledPath: string | null
  systemInfo: { path: string; version: string | null } | null
}

export type CliBackendSetPayload = { mode: CliBackendMode }

/**
 * The exact shape of the preload-exposed `window.chatApi`. Matches this
 * interface on both sides via the shared type.
 */
export interface ChatApi {
  send(payload: ChatSendPayload): Promise<ChatSendResult>
  abort(payload: ChatAbortPayload): Promise<void>
  /**
   * Subscribe to chat events for a given session. Returns an unsubscribe
   * function. Called from the renderer's subscription hook.
   */
  onEvent(sessionId: string, handler: (event: ChatEvent) => void): () => void

  /**
   * Subscribe to tool-permission requests from main. The dialog layer
   * calls this once at mount and returns its teardown. Only one request
   * is ever in-flight at a time — the SDK's `canUseTool` blocks the
   * current turn until we respond, so there's no need to queue.
   */
  onPermissionRequest(handler: (request: PermissionRequest) => void): () => void

  /** Reply to an open permission request. */
  respondPermission(response: PermissionResponse): Promise<void>

  /**
   * Pull the most recent session metadata cached in main. Used by the
   * `/skill` and `/mcp` dialogs to populate their lists. Returns empty
   * arrays before fusion-code has been spawned for the first time.
   */
  getSessionMeta(): Promise<SessionMeta>

  /**
   * Pull the cached file list under the session cwd, used to power the
   * composer's `@`-mention popover. Main scans via `git ls-files` (or
   * a readdir fallback) and caches the result for 5 seconds. The
   * renderer does synchronous fuzzy filtering on the returned list.
   *
   * Pass `{ force: true }` to bypass the TTL cache.
   */
  listFileSuggestions(
    payload?: FileSuggestionsListPayload
  ): Promise<FileSuggestionsListResult>

  /**
   * Read the workspace state. Returns `{ path: null }` before the user
   * has picked a folder via the first-run drag-drop gate. App.tsx uses
   * this to decide whether to render `<WorkspaceGate>` or the chat UI.
   */
  getWorkspace(): Promise<WorkspaceState>

  /**
   * Set the workspace to an absolute directory path. Called by
   * `WorkspaceGate` after the user drops a folder on the window. Main
   * re-validates (absolute + stat + isDirectory) and resolves to the
   * final state. Subsequent calls after the workspace has been set
   * reject — by design this is a one-shot in the current session.
   */
  setWorkspace(payload: WorkspaceSetPayload): Promise<WorkspaceState>

  /**
   * Open the OS native folder picker and resolve to the user's choice.
   * Returns `{ path: null }` on cancel. The caller is responsible for
   * the follow-up `setWorkspace({ path })` IPC — separating pick and
   * set keeps gate-side error surfacing centralized.
   */
  pickWorkspace(): Promise<WorkspacePickResult>

  /**
   * Resolve a File object dropped on the window to its absolute path.
   * Backed by Electron 33's `webUtils.getPathForFile` (the successor to
   * the deprecated `File.path`). The `File` type is not structured-clone
   * safe, but the preload → renderer contextBridge call runs in-process
   * so it can marshal it unchanged.
   *
   * Returns the empty string when the file is not backed by a disk path
   * (e.g. a synthetic blob). Callers should treat "" as invalid.
   */
  pathForFile(file: File): string

  /**
   * Open a workspace-relative file in the OS default handler. Used by
   * the Files tree's double-click: the renderer doesn't know the
   * workspace root, so we pass the relative path and let main resolve
   * and validate it. On error, `result.error` is non-empty.
   */
  openFile(payload: WorkspaceFileOpenPayload): Promise<WorkspaceFileOpenResult>

  /**
   * List all sessions under the current workspace, newest first.
   * Returns an empty array before the workspace is set or when the
   * workspace has no prior fusion-code transcripts.
   */
  listSessions(): Promise<SessionListResult>

  /**
   * Load a session's full message history. Used by ThreadListAdapter
   * when the user clicks a row in the sidebar — the result is handed
   * straight to the chat store's `setSession` action.
   */
  loadSession(payload: SessionLoadPayload): Promise<SessionLoadResult>

  /**
   * Mint a new session UUID. Does not spawn the CLI; the caller
   * follows up with `switchSession({ sessionId, resume: false })`.
   */
  newSession(): Promise<SessionNewResult>

  /**
   * Tear down the current SDK query handle and reopen it on the given
   * sessionId. When `resume: true`, the fusion-code CLI reloads the
   * transcript from JSONL so the model sees the full history.
   */
  switchSession(payload: SessionSwitchPayload): Promise<SessionSwitchResult>

  /**
   * Set a session's display title. Appends a `custom-title` line to
   * the jsonl on disk (same shape fusion-code's `/rename` writes).
   * Main re-broadcasts `sessionListChanged` after a successful write
   * so the sidebar refreshes without a manual reload.
   */
  renameSession(payload: SessionRenamePayload): Promise<SessionRenameResult>

  /**
   * Subscribe to session-list-changed broadcasts from main. Returns an
   * unsubscribe function. Emitted whenever a session is created,
   * updated, or the active session changes — the adapter should
   * re-fetch the list on every invocation.
   */
  onSessionListChanged(handler: () => void): () => void

  /**
   * Subscribe to session-meta-changed broadcasts from main. Returns
   * an unsubscribe function. Emitted whenever the cached sessionMeta
   * updates — typically on fusion-code's first `system init` message,
   * which is when skills / mcp servers / slash commands finally
   * arrive. The Composer calls `getSessionMeta()` again on receipt
   * so the `/` popover instantly reflects the cli's full command set.
   */
  onSessionMetaChanged(handler: () => void): () => void

  /**
   * Subscribe to engine instrumentation events. Returns an unsubscribe
   * function. Each call to `handler` delivers one `LogEvent` — a
   * timestamped breadcrumb marking a discrete lifecycle moment
   * (switch begin, spawn begin, system init received, turn first
   * chunk, ...). The LogsDialog uses these to render a timeline with
   * per-event deltas.
   */
  onLogEvent(handler: (event: LogEvent) => void): () => void

  /**
   * Relaunch the Electron app. Fire-and-forget — the main process
   * calls `app.relaunch()` then `app.exit(0)`, so this promise never
   * resolves in practice (the renderer dies mid-await). Used by the
   * workspace switcher in the sidebar.
   */
  relaunchApp(): Promise<void>

  /**
   * Open `~/.claude` (the fusion-code config + transcript root) in
   * Finder / Explorer. Resolves with `{ error: '' }` on success or a
   * non-empty error string when `shell.openPath` fails.
   */
  openClaudeDir(): Promise<{ error: string }>

  /**
   * Open the current workspace directory in the OS file manager.
   * Main reads the path from the engine, so no payload is needed.
   * Resolves with `{ error: '' }` on success.
   */
  openWorkspace(): Promise<{ error: string }>

  /** OS username, read once at preload-load time via `os.userInfo()`. */
  osUser: string

  /**
   * Push the user's current UI language to the main process so the
   * tray context menu (built in the main process) can rebuild its
   * labels in sync with the renderer. Fire-and-forget — main has no
   * meaningful reply beyond "received".
   */
  setLang(lang: 'zh' | 'en'): void

  /**
   * Transcribe an audio chunk via the OpenAI compatible Whisper
   * endpoint. Main reads `OPENAI_BASE_URL` / `OPENAI_API_KEY` /
   * `OPENAI_TRANSCRIBE_MODEL` from env.json on each call — env
   * edits are picked up without a relaunch. Returns the recognized
   * text or a friendly error string the composer surfaces as a log.
   */
  transcribeAudio(
    payload: TranscribeAudioPayload
  ): Promise<TranscribeAudioResult>

  /**
   * Read the current CLI backend setting plus fresh detection info
   * for the user's system `claude` binary. Called by the settings
   * page each time its CLI-backend section opens.
   */
  getCliBackend(): Promise<CliBackendState>

  /**
   * Persist the user's CLI backend choice. Resolves to the updated
   * state (same shape as getCliBackend) so the settings UI can
   * refresh without a second round-trip.
   */
  setCliBackend(payload: CliBackendSetPayload): Promise<CliBackendState>
}
