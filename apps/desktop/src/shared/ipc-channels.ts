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
  /**
   * Main → renderer. Fires when main-side cancels a pending permission
   * request (signal aborted, window closing, session torn down, …).
   * Renderer drops the matching entry so the inline prompt disappears
   * instead of dangling forever.
   */
  PERMISSION_CANCELLED: 'permission:cancelled',
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
   * Renderer → main. Opens an ABSOLUTE file path in the OS default
   * handler (`shell.openPath`). Unlike WORKSPACE_FILE_OPEN (which only
   * accepts workspace-relative paths and re-joins them under the
   * workspace root), this accepts a full absolute path because the
   * files it targets — produced by the assistant this turn — frequently
   * live OUTSIDE the workspace (e.g. the user's Desktop). Main still
   * validates the path is absolute, exists, and is a regular file
   * before handing it to the OS. Used by the file cards rendered under
   * a completed assistant turn.
   */
  SHELL_OPEN_PATH: 'shell:open-path',
  /**
   * Renderer → main. Given a batch of candidate absolute paths scraped
   * from an assistant turn's text, return only those that exist on disk
   * AND are regular files. The renderer has no filesystem access, so it
   * can't tell a real generated file from a path the model merely
   * mentioned — main does the `statSync` filtering. Used to decide which
   * file cards to render under a completed assistant turn.
   */
  SHELL_STAT_FILES: 'shell:stat-files',
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
   * Renderer → main. Returns the set of session ids whose fusion-code
   * runtime is currently alive (i.e. a pump is running in the
   * background). The renderer uses this to render "still running"
   * badges in ThreadListSidebar and to decide which session ids it
   * needs a subscription on in the multi-runtime model.
   *
   * "Alive" means the runtime has a handle or queue — pure empty
   * slots from a never-sent lazy switch are excluded.
   */
  SESSION_LIST_ACTIVE_RUNTIMES: 'session:list-active-runtimes',
  /**
   * Renderer → main. Tear down a session's background runtime without
   * deleting its transcript. The cli process exits and the sessions
   * map entry is removed; the JSONL on disk is untouched, so a later
   * click on the row still resumes cleanly. Used by the "X" button
   * the sidebar shows on running rows.
   *
   * Safe to call on a session that's already dead — main treats it
   * as a no-op so the UI can fire-and-forget.
   */
  SESSION_CLOSE_RUNTIME: 'session:close-runtime',
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
  // (Legacy WINDOW_OPEN_WORKSPACE removed in the multi-tab refactor —
  // use TAB_NEW below.)
  /**
   * Shell renderer → main. Create a new tab. The new tab hosts its
   * own WebContentsView + ChatEngine bound to a null workspace; the
   * workspace renderer inside the view drives the first
   * `setWorkspace` through the gate. Used by the `+` button in the
   * tab bar and the `File → New Tab` menu item.
   */
  TAB_NEW: 'tab:new',
  /**
   * Shell renderer → main. Activate the tab with the given id. All
   * other tabs are hidden (view `setVisible(false)`) but their
   * engines keep running in the background.
   */
  TAB_SWITCH: 'tab:switch',
  /**
   * Shell renderer → main. Close the tab with the given id. The
   * engine is disposed (fusion-code children exited, permission
   * requests cancelled) before the view is removed from the shell
   * window. Closing the last tab closes the shell.
   */
  TAB_CLOSE: 'tab:close',
  /**
   * Shell renderer → main. One-shot pull of the current tab list so
   * the TabBar can hydrate its React state on mount. After mount the
   * TAB_LIST_CHANGED broadcast keeps it in sync.
   */
  TAB_LIST_GET: 'tab:list-get',
  /**
   * Main → shell renderer. Broadcast any time the tab list mutates
   * (new / closed / activated / title change). Payload is the full
   * `TabDescriptor[]`, not a diff — the TabBar is the source of
   * truth for rendering and just re-reads the latest list.
   */
  TAB_LIST_CHANGED: 'tab:list-changed',
  /**
   * Renderer → main. One-shot query for the shell window's current
   * fullscreen state, called once on renderer mount to hydrate the
   * `data-fullscreen` attribute on `<html>` before the CSS evaluates.
   * After mount the SHELL_FULLSCREEN_CHANGED broadcast keeps it live.
   */
  SHELL_FULLSCREEN_GET: 'shell:fullscreen-get',
  /**
   * Main → all tab renderers. Fired on enter/leave-full-screen on the
   * shell BrowserWindow. Payload is a single boolean. Renderers toggle
   * `document.documentElement.dataset.fullscreen` in response so
   * platform-conditional CSS (e.g. hiding the macOS traffic-light
   * gutter when fullscreen hides the window chrome) can react.
   */
  SHELL_FULLSCREEN_CHANGED: 'shell:fullscreen-changed',
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
  CLI_BACKEND_SET: 'cli-backend:set',
  /**
   * Renderer → main. Reads the engine's current UI permission mode.
   * Called once on renderer mount to hydrate the picker. The renderer
   * is actually the source of truth (persisted in localStorage) and
   * pushes its value back via PERMISSION_MODE_SET on mount — this
   * getter is a fallback for hot-reload scenarios.
   */
  PERMISSION_MODE_GET: 'permission-mode:get',
  /**
   * Renderer → main. Sets the engine's UI permission mode. The engine
   * updates its own field and also calls `query.setPermissionMode()`
   * on every live runtime so the change takes effect mid-session
   * without a restart. For bypass / plan modes the SDK handles tool
   * gating internally; for default / dontAsk / acceptEdits the engine's
   * canUseTool callback is still invoked for the cases the SDK doesn't
   * auto-resolve.
   */
  PERMISSION_MODE_SET: 'permission-mode:set',
  /**
   * Main → renderer. Broadcast whenever the engine's UI permission
   * mode changes from the *main* side rather than the renderer.
   *
   * The only current trigger is the ExitPlanMode auto-transition: when
   * the assistant calls `ExitPlanMode` and the user approves it via
   * the permission dialog, the SDK internally transitions out of
   * `plan` mode — we mirror that on our side by flipping the engine
   * field to `default` and broadcasting, so the picker and its
   * localStorage catch up without the user having to re-click.
   *
   * Renderer-initiated changes (user clicks the picker) do NOT
   * re-broadcast — there's no one to tell, the renderer already knows.
   */
  PERMISSION_MODE_CHANGED: 'permission-mode:changed',
  /**
   * Renderer → main. Reads the shared appearance prefs from the Open
   * Design daemon's `/api/app-config` so the desktop shell and the
   * embedded web tab render the same theme. Main reverse-proxies the
   * daemon over `net.fetch` (stripping Origin/Host so the daemon's
   * origin check treats it as a trusted non-browser request — the
   * renderer can't reach the daemon directly because its file:// /
   * dev origin isn't on the daemon allow-list). Returns the
   * `appearance` sub-object, or null when the daemon is offline /
   * hasn't stored any (the renderer then keeps its localStorage cache).
   */
  /**
   * Shell renderer → main (invoke). The settings menu now lives in the
   * shell's tab strip (ShellApp), but the things it triggers — the
   * SettingsView overlay, the LogsDialog, the i18n language toggle — are
   * all state owned by the *chat tab's* renderer, a separate webContents
   * the shell can't reach directly. So the shell fires this with a menu
   * action and main forwards it (via SHELL_MENU_ACTION) to whichever chat
   * tab is currently active. Web tabs are skipped — they own no such state.
   */
  TAB_TRIGGER_MENU_ACTION: 'tab:trigger-menu-action',
  /**
   * Shell renderer → main (invoke). Open the settings modal — a transparent
   * WebContentsView that main lays over the *whole* window (above the tab
   * strip and every tab), loading the renderer with `?settings=1`. Works
   * from any tab because the overlay lives in the shell's contentView tree,
   * not inside a tab. Idempotent (re-opening just refocuses).
   */
  SETTINGS_WINDOW_OPEN: 'settings-window:open',
  /**
   * Settings-overlay renderer → main (invoke). Close the settings modal —
   * main detaches and destroys the overlay view. Fired by the modal itself
   * on scrim click / Escape / the ✕ button.
   */
  SETTINGS_WINDOW_CLOSE: 'settings-window:close',
  /**
   * Settings-overlay renderer → main (invoke). Read the CLI backend state
   * (bundled fusion-code vs system claude) for the embedded web settings
   * page. Engine-free counterpart of CLI_BACKEND_GET: the overlay isn't
   * bound to any tab, so this reads the global app setting + runs detection
   * directly instead of resolving a per-tab ChatEngine.
   */
  SETTINGS_CLI_BACKEND_GET: 'settings:cli-backend-get',
  /**
   * Settings-overlay renderer → main (invoke). Persist the CLI backend
   * choice from the embedded web settings page. Engine-free counterpart of
   * CLI_BACKEND_SET — writes the global app setting; live engines pick the
   * new backend up on their next openSession.
   */
  SETTINGS_CLI_BACKEND_SET: 'settings:cli-backend-set',
  /**
   * Settings-overlay renderer → main (invoke). Pull the current runtime-log
   * ring buffer snapshot so the「日志分析」panel can paint its initial view.
   * Engine-free — reads the process-global logCollector directly.
   */
  LOGS_GET: 'settings:logs-get',
  /**
   * Settings-overlay renderer → main (invoke). Clear the in-memory log ring
   * (does not touch the on-disk log file). Returns nothing.
   */
  LOGS_CLEAR: 'settings:logs-clear',
  /**
   * Main → settings-overlay renderer (send). One runtime-log line, pushed
   * live as it is produced (main console / daemon child / renderer console).
   * The overlay subscribes via `electronSettings.onLog` and appends each
   * entry. Only fires while the overlay is registered as a log subscriber
   * (open); torn down on close so a destroyed view never receives sends.
   */
  LOGS_STREAM: 'settings:logs-stream',
  /**
   * Main → active chat tab renderer. The forwarded counterpart of
   * TAB_TRIGGER_MENU_ACTION. The chat renderer subscribes once on mount
   * and maps each action onto its local store (open settings / open logs /
   * toggle language). Only the active chat tab receives it.
   */
  SHELL_MENU_ACTION: 'shell:menu-action',
  APPEARANCE_GET: 'appearance:get',
  /**
   * Renderer → main. Patches the shared appearance prefs into the
   * daemon (PUT /api/app-config with `{ appearance: <patch> }`). The
   * daemon deep-merges the patch so a single-field change (e.g. just
   * `themeMode`) doesn't clobber the per-mode colors. Returns the
   * daemon's merged `appearance` on success, or null on failure — the
   * renderer treats the local store + localStorage as the durable copy
   * either way, so a failed write is non-fatal (best-effort sync).
   */
  APPEARANCE_SET: 'appearance:set',
  /**
   * Main → every renderer that can receive IPC (desktop chat renderers +
   * the settings overlay). Fired after a successful APPEARANCE_SET write to
   * the daemon so windows OTHER than the one that made the change re-pull
   * and re-apply the shared appearance at runtime — without it only the
   * writing webContents reflects the new theme until a reload.
   *
   * Carries no payload: receivers re-fetch the daemon copy themselves
   * (desktop via hydrateAppearanceFromDaemon, the overlay via /api/app-config)
   * so there's a single canonical read path and no risk of a partial patch
   * racing the merged daemon state.
   *
   * The web tab (?host=desktop) has NO preload and can't receive this — main
   * reaches it separately by injecting a `window` event via executeJavaScript
   * (see tabRegistry.broadcastAppearanceChanged).
   */
  APPEARANCE_CHANGED: 'appearance:changed',
  /**
   * Renderer → main. "I just wrote the shared appearance/config straight to
   * the daemon (via /api/app-config), please broadcast APPEARANCE_CHANGED to
   * the OTHER windows." Fired by the settings overlay's syncConfigToDaemon
   * after a successful PUT — that write bypasses the main process entirely
   * (it's an HTTP call proxied to the daemon, not an IPC), so main has no
   * other way to learn the theme changed. The handler calls
   * broadcastAppearanceChanged, skipping the caller (event.sender) since it
   * already applied the change locally. Distinct from APPEARANCE_SET, which
   * is the desktop renderer's own write-through-main path (also broadcasts).
   */
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  /**
   * Renderer → main. Returns the current KB root path (or null when
   * not yet configured) plus the fixed output directory for index
   * artefacts (`userData/kb-index`). Called by the settings page to
   * hydrate the KB path picker.
   */
  KB_PATH_GET: 'kb:path-get',
  /**
   * Renderer → main. Persists the user-picked KB root path to
   * `userData/kb-config.json`. Takes effect immediately — subsequent
   * KB_PATH_GET and KB_INDEX_READ calls reflect the new root.
   */
  KB_PATH_SET: 'kb:path-set',
  /**
   * Renderer → main. Reads `userData/kb-index/index.json` and
   * returns the parsed KbIndex, or null when the file doesn't
   * exist yet (index not yet built). The renderer uses this to
   * decide whether to show the "build index" CTA or the ready state.
   */
  KB_INDEX_READ: 'kb:index-read',
  /**
   * Renderer → main. Exports the proposal document via the OS native
   * save dialog. Main writes the file and returns the absolute path;
   * returns `{ path: null }` when the user cancelled the dialog.
   *
   * `format` is a closed union (`ExportFormat` in proposalExport.ts):
   * MVP only `'md'` is implemented. Word/PDF adapters go in the same
   * switch — no IPC changes needed when the union grows.
   */
  PROPOSAL_EXPORT: 'proposal:export',
  /**
   * Renderer → main. Renders the proposal markdown to a .docx binary
   * IN MEMORY (no save dialog, no disk write), so the renderer can paint a
   * docx-preview pagination view that matches the exported Word file
   * byte-for-byte — same `markdownToDocxBuffer` engine as PROPOSAL_EXPORT.
   */
  PROPOSAL_RENDER: 'proposal:render'
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

/**
 * Snapshot of one tab shown in the shell window's tab bar. Produced
 * by `tabRegistry.listTabs()` and broadcast on every mutation via
 * `TAB_LIST_CHANGED`. The shell renderer reads this list verbatim
 * and renders one pill per entry.
 */
export interface TabDescriptor {
  /** Stable id — matches the hosting WebContentsView's webContents.id. */
  id: number
  /** User-facing label; basename of the workspace, or "New Workspace". */
  title: string
  /** Absolute workspace path, or null before the gate has been passed. */
  workspacePath: string | null
  /** True for the single currently-visible tab. */
  active: boolean
  /**
   * Aggregate count of unresolved tool-permission requests currently
   * held by this tab's engine (sum across every session runtime in
   * that workspace). The shell TabBar paints an Apple-style red
   * notification badge carrying this number on any tab where it's
   * > 0, so a pending permission on a background session in
   * workspace A is visible even while the user is looking at
   * workspace B. Always 0 for a tab that has no pending tool calls.
   */
  pendingPermissionCount: number
}

export interface TabSwitchPayload {
  id: number
}

export interface TabClosePayload {
  id: number
}

export interface TabListResult {
  tabs: TabDescriptor[]
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
  /**
   * 方案写作模式开关。渲染层在 send 时透传 `useProposalStore.getState().active`。
   *
   * 为什么走 send payload 而不是单独一条 IPC：方案 append 是在 fusion-code 子进程
   * spawn 时（openSession）烘焙的，而本项目 lazy spawn——真正的冷启动延迟到首次
   * send()。把 flag 挂在 send 上，能保证「首次 send 触发 spawn」那一刻 engine 就读
   * 得到方案模式，append 与 additionalDirectories 才来得及生效。
   *
   * warm-spawn 处理：switchToSession 的后台 warmup 可能在用户选产品之前就 spawn 了
   * 子进程，那个进程的 append 不含方案纪律。engine.send() 检测到「本次 proposalMode=
   * true，但该 runtime 的活进程不带方案 append」（runtime.spawnedWithProposal !== true）
   * 时，会把方案纪律 + 镜像绝对路径注入到本次用户消息里（见 engine.send 的 warm-spawn
   * grounding）。比"杀掉重启该 session"稳——重启一个刚被 kill 的同 id 会话会让 claude
   * exit 1。fresh spawn 的 runtime 此刻 spawnedWithProposal 已为 true，不重复注入。
   */
  proposalMode?: boolean
  /**
   * 方案模式下识别到的产品集（{productLine, product}）。渲染层在 send 时用
   * matchProducts 对用户文本匹配后透传。main 据此把这些产品的镜像子目录加进
   * additionalDirectories 并在方案提示词里点名，收窄检索范围。
   * 缺省/空数组 = 未识别到 → main 退回整个镜像根目录由 AI 自行 Grep 定位。
   */
  proposalProducts?: readonly { productLine: string; product: string }[]
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

/**
 * Payload for SHELL_OPEN_PATH. `absPath` is an absolute on-disk path
 * (typically a file the assistant just wrote, which may live outside
 * the workspace). Main validates absolute + exists + is-a-file before
 * `shell.openPath`.
 */
export type ShellOpenPathPayload = { absPath: string }

/**
 * Result of SHELL_OPEN_PATH. `error` is '' on success, non-empty on
 * failure (validation rejection or shell.openPath error). Same contract
 * as WorkspaceFileOpenResult.
 */
export type ShellOpenPathResult = { error: string }

/**
 * Payload for SHELL_STAT_FILES. `paths` is a batch of candidate absolute
 * paths scraped from assistant text (deduped by the caller).
 */
export type ShellStatFilesPayload = { paths: readonly string[] }

/**
 * Result of SHELL_STAT_FILES. `files` is the subset of the input that
 * exists on disk AND is a regular file, in the same order as the input.
 * Non-absolute / missing / directory entries are dropped.
 */
export type ShellStatFilesResult = { files: readonly string[] }

/* ─────────────────── Session (thread) channels ─────────────────── */

export type SessionListResult = { threads: readonly ThreadSummary[] }

export type SessionLoadPayload = { sessionId: string }
export type SessionLoadResult = { messages: readonly ThreadMessageLike[] }

export type SessionNewResult = { sessionId: string }

export type SessionSwitchPayload = { sessionId: string; resume: boolean }
export type SessionSwitchResult = { sessionId: string }

export type SessionRenamePayload = { sessionId: string; title: string }
export type SessionRenameResult = { ok: true }

export type SessionCloseRuntimePayload = { sessionId: string }
export type SessionCloseRuntimeResult = { ok: true }

export type SessionListActiveRuntimesResult = { sessionIds: readonly string[] }

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
 * Origin of a runtime-log line shown in the「日志分析」panel.
 * - `main`     — this Electron main process's console.* (patched).
 * - `daemon`   — the spawned Open Design daemon child's stdout/stderr.
 * - `web`      — the dev-only web dev server (next dev) child's output.
 * - `renderer` — a tab/overlay renderer process's console-message.
 */
export type LogSource = 'main' | 'daemon' | 'web' | 'renderer'

/**
 * One line of runtime log. `seq` is a monotonically increasing id used as a
 * stable React key and to dedupe the initial snapshot against live-streamed
 * lines. `ts` is epoch ms. `text` is a single line (the collector splits
 * multi-line output before emitting), already ANSI-stripped and length-capped.
 */
export interface RuntimeLogEntry {
  seq: number
  ts: number
  source: LogSource
  level: 'info' | 'warn' | 'error' | 'debug'
  text: string
}

/**
 * UI-facing permission mode. Mirrors the Agent SDK's `PermissionMode`
 * type minus `'auto'` (which uses a model classifier and is out of
 * scope for the visible picker). The mapping to the SDK is identity —
 * engine casts `UiPermissionMode` directly to the SDK type when
 * calling `query()` or `setPermissionMode()`.
 *
 * Semantics (enforced by the SDK, not by our broker):
 * - `default`           — prompts on dangerous tools, via canUseTool.
 * - `plan`              — only read-only tools, assistant emits a plan
 *                         block and waits for the user to exit plan
 *                         mode before running anything.
 * - `acceptEdits`       — Edit / Write / NotebookEdit auto-allowed,
 *                         everything else still prompts.
 * - `bypassPermissions` — no prompts at all (requires the engine to
 *                         pass `allowDangerouslySkipPermissions: true`).
 * - `dontAsk`           — no prompts; anything that isn't pre-approved
 *                         is denied outright.
 */
export type UiPermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'

export type PermissionModeGetResult = { mode: UiPermissionMode }
export type PermissionModeSetPayload = { mode: UiPermissionMode }
export type PermissionModeChangedPayload = { mode: UiPermissionMode }

/**
 * One theme's color/contrast overrides as stored in the daemon. Mirror of
 * `@open-design/contracts` `ThemeOverridesPrefs` — desktop keeps its own copy
 * because the renderer / main / preload share this file but don't depend on
 * the contracts package. Colors are `#rrggbb` hex (the desktop applier turns
 * them into `"H S% L%"`). Keep in sync with the contracts type and with the
 * renderer's `ThemeOverrides` in `stores/appearance.ts`.
 */
export interface ThemeOverridesPrefs {
  presetName?: string
  accent?: string
  background?: string
  foreground?: string
  contrast?: number
  translucentSidebar?: boolean
}

/**
 * Shared appearance prefs persisted by the daemon and read/written by both
 * the desktop shell and the web tab. Mirror of the contracts `AppearancePrefs`.
 * All fields optional — a patch carries only what changed and an absent field
 * falls back to the local default.
 */
export interface AppearancePrefs {
  themeMode?: 'light' | 'dark' | 'system'
  light?: ThemeOverridesPrefs
  dark?: ThemeOverridesPrefs
  uiFontSize?: number
  codeFontSize?: number
  usePointerCursor?: boolean
}

/**
 * Actions the shell's tab-strip settings menu can trigger on the active
 * chat tab. `toggle-lang` flips zh↔en; the others open the corresponding
 * overlay/dialog. Kept as a small closed union so both ends stay in sync.
 */
export type ShellMenuAction = 'open-settings' | 'open-logs' | 'toggle-lang'

/** Payload for SHELL_MENU_ACTION / TAB_TRIGGER_MENU_ACTION. */
export type ShellMenuActionPayload = { action: ShellMenuAction }

/** Result of APPEARANCE_GET — null when the daemon is offline or empty. */
export type AppearanceGetResult = { appearance: AppearancePrefs | null }
/** Payload for APPEARANCE_SET — a partial patch the daemon deep-merges. */
export type AppearanceSetPayload = { patch: AppearancePrefs }
/** Result of APPEARANCE_SET — the daemon's merged appearance, or null on failure. */
export type AppearanceSetResult = { appearance: AppearancePrefs | null }

/**
 * Supported export formats for a proposal document. Defined here (shared)
 * so the renderer payload, the preload type, and the main-side
 * proposalExport.ts can all reference the same closed union without
 * circular imports. MVP is `'md'`; extend to `'docx' | 'pdf'` when those
 * adapters land — the IPC surface requires no changes.
 */
export type ProposalExportFormat = 'md' | 'docx' // 进阶可再加 'pdf'

/** Payload for PROPOSAL_EXPORT. */
export interface ProposalExportPayload {
  markdown: string
  format: ProposalExportFormat
}

/** Result of PROPOSAL_EXPORT. `path` is null when the user cancelled. */
export interface ProposalExportResult {
  path: string | null
}

/** Payload for PROPOSAL_RENDER. */
export interface ProposalRenderPayload {
  markdown: string
}

/**
 * Result of PROPOSAL_RENDER. `bytes` is the .docx binary — a Node `Buffer`
 * on the main side, which structured-clones across IPC as a `Uint8Array`.
 * The renderer wraps it in a `Blob` for docx-preview.
 */
export interface ProposalRenderResult {
  bytes: Uint8Array
}

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
   * Subscribe to tool-permission requests from main. The renderer's
   * permission store calls this once at mount and pushes every request
   * into a requestId-keyed Map. Multiple parallel requests can be in
   * flight when the assistant emits a tool_use block with several tool
   * calls — each gets its own inline prompt on its tool card, so the
   * subscriber must never collapse them.
   */
  onPermissionRequest(handler: (request: PermissionRequest) => void): () => void

  /**
   * Subscribe to cancellation notices from main. Fires when a pending
   * permission request is aborted from the main side (signal tripped,
   * window closing, cli torn down). Renderer removes the matching entry
   * so the inline prompt vanishes instead of leaving the user staring
   * at buttons that no longer do anything.
   */
  onPermissionCancelled(handler: (requestId: string) => void): () => void

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
   * Read the workspace state. The engine defaults to the OS Desktop, so
   * this returns a real path on cold start (`{ path: null }` only on an
   * unexpected engine error). App.tsx reads it to scope the runtime to
   * the bound workspace path before mounting.
   */
  getWorkspace(): Promise<WorkspaceState>

  /**
   * Set the workspace to an absolute directory path. Main re-validates
   * (absolute + stat + isDirectory) and resolves to the final state.
   * Subsequent calls with a different path after the workspace has been
   * bound reject — by design this is a one-shot per engine. Currently
   * unused from the renderer (the folder-picker UI was removed), but the
   * IPC is kept for a future "change folder" affordance.
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
   * Open an ABSOLUTE file path in the OS default handler. Used by the
   * file cards under a completed assistant turn — the assistant's
   * Write/Edit tool calls carry full absolute `file_path`s that often
   * sit outside the workspace, so unlike `openFile` this takes the
   * absolute path directly. Main validates + delegates to
   * `shell.openPath`. On error, `result.error` is non-empty.
   */
  openPath(payload: ShellOpenPathPayload): Promise<ShellOpenPathResult>

  /**
   * Filter a batch of candidate absolute paths down to those that exist
   * on disk and are regular files. Used by the assistant file cards to
   * decide which scraped paths are real generated files (vs. paths the
   * model merely mentioned). Returns the surviving subset in input order.
   */
  statFiles(payload: ShellStatFilesPayload): Promise<ShellStatFilesResult>

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
   * List session ids that currently have a live fusion-code runtime
   * in this tab's engine (i.e. a background agent task still
   * running). Polled by the sidebar alongside `onSessionListChanged`
   * to paint "running" badges on the relevant rows.
   */
  listActiveRuntimeIds(): Promise<SessionListActiveRuntimesResult>

  /**
   * Close a session's background runtime. Cli process exits, runtime
   * map entry is removed, and `sessionListChanged` is broadcast so
   * the sidebar drops the running badge. The JSONL transcript is
   * left on disk — the user can still click the row to resume.
   */
  closeSessionRuntime(
    payload: SessionCloseRuntimePayload
  ): Promise<SessionCloseRuntimeResult>

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
   * Open a fresh workspace tab in the shell window. The new tab hosts
   * its own WebContentsView + ChatEngine, which defaults its workspace
   * to the OS Desktop at construction — so the tab opens straight into a
   * usable chat UI. Used by the `+` button in the tab bar and the
   * `File → New Tab` menu item.
   */
  newWorkspaceTab(): Promise<void>

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

  /**
   * Read the engine's current UI permission mode. The renderer's
   * picker store calls this on mount as a fallback when localStorage
   * is empty (first launch / hot-reload). Renderer is still the
   * source of truth — on mount it pushes its persisted value back
   * via setPermissionMode so main catches up.
   */
  getPermissionMode(): Promise<PermissionModeGetResult>

  /**
   * Push a UI permission mode into the engine. Applies to every live
   * SDK runtime via `query.setPermissionMode()` so mid-session
   * switches work without tearing down. Resolves when main has
   * updated its field and forwarded the mode to the SDK.
   */
  setPermissionMode(payload: PermissionModeSetPayload): Promise<void>

  /**
   * Subscribe to main-initiated permission mode changes — currently
   * only the ExitPlanMode auto-transition fires this. Returns an
   * unsubscribe function. The handler MUST apply the new mode
   * directly to the store without re-pushing back to main, otherwise
   * the renderer would echo the broadcast into an infinite loop.
   */
  onPermissionModeChanged(
    handler: (mode: UiPermissionMode) => void
  ): () => void

  /**
   * Read the shared appearance prefs from the Open Design daemon. The
   * desktop appearance store calls this once on boot (after applying its
   * localStorage cache so there's no flash) and adopts the daemon copy as
   * the source of truth. Resolves `{ appearance: null }` when the daemon
   * is offline or has none stored yet — the renderer keeps its cache.
   */
  getAppearance(): Promise<AppearanceGetResult>

  /**
   * Push an appearance patch to the daemon. Fire-and-forget from the
   * renderer's perspective (the local store + localStorage are the durable
   * copy), so a rejected promise / `{ appearance: null }` just means the
   * daemon was unreachable and the next change will retry. The daemon
   * deep-merges the patch, so sending only the field that changed is safe.
   */
  setAppearance(payload: AppearanceSetPayload): Promise<AppearanceSetResult>

  /**
   * Subscribe to "the shared appearance changed in the daemon" pushes. Fired
   * by main after ANY window writes appearance, so this renderer re-pulls and
   * re-applies even though it wasn't the one that changed it. The handler
   * should just re-run the daemon hydrate (the change source is guarded
   * against echoing its own write back). Returns an unsubscribe.
   */
  onAppearanceChanged(handler: () => void): () => void

  /**
   * Subscribe to menu actions forwarded from the shell's tab-strip
   * settings menu (open settings / open logs / toggle language). Returns
   * an unsubscribe. The chat renderer maps each action onto its own store;
   * only the active chat tab receives these. Web tabs never see them.
   */
  onShellMenuAction(handler: (action: ShellMenuAction) => void): () => void

  /**
   * Close the settings modal overlay. Called by the settings overlay
   * renderer (`?settings=1`) on scrim click / Escape / the ✕ button.
   * Resolves once main has torn the overlay view down.
   */
  closeSettingsWindow(): Promise<void>

  /**
   * Read the current KB root path and the fixed output directory.
   * `kbRoot` is null when the user hasn't picked one yet.
   * `outDir` is always `userData/kb-index` (computed in main).
   */
  getKbPath(): Promise<{ kbRoot: string | null; outDir: string }>

  /**
   * Persist the user-picked KB root path. Main writes it to
   * `userData/kb-config.json`; subsequent getKbPath / readKbIndex
   * calls reflect the update immediately.
   */
  setKbPath(kbRoot: string): Promise<void>

  /**
   * Read the built knowledge-base index from `userData/kb-index/index.json`.
   * Returns null when the file doesn't exist yet (index not yet built).
   * The renderer uses this to decide whether to show the build CTA or
   * the ready state.
   */
  readKbIndex(): Promise<import('./kbIndex').KbIndex | null>

  /**
   * Export the proposal document via the OS native save dialog.
   * Main pops the dialog, writes the file, and returns the absolute
   * path on success. Returns `{ path: null }` when the user cancels.
   *
   * `format` drives the file-type filter and the write adapter — MVP
   * only `'md'` is wired; Word/PDF adapters extend the same channel
   * without any IPC surface changes.
   */
  exportProposal(payload: ProposalExportPayload): Promise<ProposalExportResult>
  /**
   * Render the proposal markdown to a .docx binary in-memory (no save
   * dialog, no disk write). The preview tab feeds the bytes to docx-preview
   * to paint paginated A4 that matches the exported Word exactly. Rejects
   * on render failure — the renderer shows an error state.
   */
  renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult>
}

/**
 * Tab bar API exposed via contextBridge to the shell renderer.
 * Surface is intentionally tiny — the shell only needs to list,
 * create, switch, and close tabs. Everything else (chat, workspace,
 * permissions) is handled by each tab's own renderer via `chatApi`.
 */
export interface TabApi {
  /** Create a fresh tab and activate it. */
  newTab(): Promise<void>
  /** Activate the tab with the given id. */
  switchTab(id: number): Promise<void>
  /** Close the tab with the given id (disposes its engine). */
  closeTab(id: number): Promise<void>
  /** One-shot pull of the current tab list. */
  listTabs(): Promise<TabListResult>
  /**
   * Subscribe to tab-list-changed broadcasts. The payload is the
   * full list; the shell renderer is the source of truth for
   * rendering and just re-reads the latest. Returns an unsubscribe.
   */
  onTabListChanged(handler: (tabs: TabDescriptor[]) => void): () => void
  /**
   * Trigger a settings-menu action on the active chat tab. The shell's
   * tab-strip menu can't reach the chat renderer's stores directly, so it
   * fires this and main forwards it to the active chat tab (web tabs are
   * skipped). Fire-and-forget — resolves once main has dispatched.
   */
  triggerMenuAction(action: ShellMenuAction): Promise<void>

  /**
   * Open the settings modal — a full-window transparent overlay that works
   * over any tab. Resolves once main has created/shown the overlay view.
   */
  openSettingsWindow(): Promise<void>

  /** One-shot query for the shell window's current fullscreen state. */
  getFullscreen(): Promise<boolean>
  /**
   * Subscribe to shell fullscreen enter/leave events. Returns an
   * unsubscribe. Used by the renderer to toggle a CSS hook that
   * hides the macOS traffic-light gutter when the window chrome is
   * gone in fullscreen.
   */
  onFullscreenChanged(handler: (fullscreen: boolean) => void): () => void
}
