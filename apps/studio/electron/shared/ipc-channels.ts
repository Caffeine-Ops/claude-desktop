import type {
  ChatEvent,
  LogEvent,
  PermissionRequest,
  PermissionResponse,
  QueuedMessage,
  SessionMeta,
  ThreadSummary
} from './types'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ProposalStyleConfig } from './proposalStyle'
import type {
  ProposalKind,
  ProposalMetricRecord,
  SectionVerification
} from './proposal'

/**
 * Central registry of IPC channel names. Main and renderer both import
 * these constants so a typo is caught at compile time, not runtime.
 */
export const IPC_CHANNELS = {
  /** Renderer → main. Sends a user message, returns { messageId }. */
  CHAT_SEND: 'chat:send',
  /** Renderer → main. Cancels the in-flight assistant response. */
  CHAT_ABORT: 'chat:abort',
  /**
   * Renderer → main. Returns the current message queue (turns waiting
   * behind the streaming one) for a session. Used to seed the panel on
   * mount; live updates arrive as `queue_changed` ChatEvents on
   * CHAT_EVENT, so there's no separate queue-changed channel.
   */
  CHAT_QUEUE_LIST: 'chat:queue:list',
  /** Renderer → main. Removes a queued turn by messageId before it runs. */
  CHAT_QUEUE_REMOVE: 'chat:queue:remove',
  /** Renderer → main. Rewrites a queued turn's text in place. */
  CHAT_QUEUE_EDIT: 'chat:queue:edit',
  /** Renderer → main. Moves a queued turn to the front of the queue. */
  CHAT_QUEUE_PROMOTE: 'chat:queue:promote',
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
   * Renderer → main. 已知工作区列表（workspaceRegistry 并集，[0] 恒为
   * 默认工作区/桌面）。composer「选择工作目录」下拉的数据源；engine-free
   * （注册表是 main 全局的，不属于任何 tab）。
   */
  WORKSPACE_KNOWN_LIST: 'workspace:known-list',
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
   * Reveal an absolute file path in the OS file manager (Finder), selected.
   * Companion to SHELL_OPEN_PATH for the deliverable file cards' 打开方式
   * menu — "show me where it is" vs "open it".
   */
  SHELL_REVEAL_PATH: 'shell:reveal-path',
  /**
   * Read one local image file as a data URI (original bytes, correct mime —
   * no re-encode). The 图片 tab's in-app lightbox needs the full-resolution
   * image; IMAGE_MANIFEST_READ only carries 320px thumbnails.
   */
  IMAGE_FILE_READ: 'image:file-read',
  /**
   * Read one local spreadsheet file (xlsx / xls / csv) as base64 bytes for
   * the chat pane's in-app spreadsheet preview (right-hand split panel).
   * Same shape as IMAGE_FILE_READ: extension-whitelisted, size-capped,
   * original bytes — parsing happens renderer-side (SheetJS), main only
   * ferries the file. Deliberately NOT a generic read-any-file channel:
   * the whitelist keeps the renderer's disk reach limited to what the
   * preview actually renders.
   */
  SHEET_FILE_READ: 'sheet:file-read',
  /**
   * Stat one spreadsheet file (mtime + size). The in-app preview polls this
   * every few seconds while open, to surface a "file changed — refresh"
   * banner when the AI (or the user, in Excel) rewrites the file on disk.
   * Deliberately a poll, not an fs.watch subscription: no watcher lifecycle
   * to leak across sessions/windows, and a 3s cadence is plenty for a
   * human-facing banner.
   */
  SHEET_FILE_STAT: 'sheet:file-stat',
  /**
   * Renderer → main. Reads a ppt-master image-generation manifest
   * (`images/image_prompts.json`) by absolute path and returns each item's
   * status plus a small thumbnail data-URI for the ones already on disk.
   * The renderer polls this while `image_gen.py --manifest` runs to drive
   * the 「图片」canvas tab: the manifest is the source of truth (image_gen.py
   * rewrites each item's status on completion), and main is the only side
   * that can read the local PNGs — the renderer has no filesystem access and
   * CSP forbids `file:` img sources, so thumbnails come back as `data:` URIs.
   */
  IMAGE_MANIFEST_READ: 'image-manifest:read',
  /**
   * Renderer → main. Lists chat-capable model ids from the backend
   * gateway's `/v1/models` catalog (see ModelListResult). Cached in main
   * with a short TTL — the composer's 模型 chip fetches on open.
   */
  MODEL_LIST: 'model:list',
  /**
   * Renderer → main. Switches the model for THIS window's engine (see
   * ModelSetPayload): applied live to the foreground runtime and to every
   * future session the engine opens. Per-engine, in-memory — a new window
   * starts back on the backend default.
   */
  MODEL_SET: 'model:set',
  /**
   * Renderer → main. Lists all sessions (JSONL transcripts) across every
   * known workspace (workspaceRegistry 的并集，统一会话管理), sorted by
   * updatedAt desc. Backed by `@anthropic-ai/claude-agent-sdk`'s
   * `listSessions({ dir })` per workspace; each ThreadSummary carries its
   * `workspacePath`.
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
   * Renderer → main. 给会话指定工作目录（composer 的「选择工作目录」
   * chip）。main 校验绝对路径/存在/目录后：无 transcript 的新会话写入
   * 引擎 pendingWorkspace（首次 send 烘焙进子进程 cwd）；已有记录的会
   * 话走**迁移**——teardown 活 runtime 后把 transcript 工件搬进新目录
   * 的 projects slug，历史无损、下次按新 cwd resume（实测验证，见
   * sessionStore.moveSessionToWorkspace）。唯一拒绝条件：本轮对话正在
   * 进行（active turn）。成功后目录进入 known-workspaces 注册表并广播
   * sessionListChanged。
   */
  SESSION_WORKSPACE_SET: 'session:workspace-set',
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
   * Chat renderer → main (invoke). Full-text search across every known
   * workspace's session transcripts (message content, not titles — title
   * matching is a cheap renderer-side filter over listSessions). main
   * scans the project dirs' jsonl files and returns per-session excerpt
   * hits (SessionSearchResult). The renderer debounces; main additionally
   * caps scanned bytes / returned sessions so a huge scan set can't
   * stall the IPC.
   */
  SESSION_SEARCH: 'session:search',
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
   * Settings-overlay renderer → main (invoke). Reveal the on-disk runtime
   * log in the OS file manager — the current day's file when it exists
   * (selected in Finder), otherwise the logs directory. Everything the
   * 「日志分析」panel shows is also appended there (plus process-level
   * errors), so this is the hand-off point for "send me the full log".
   */
  LOGS_REVEAL: 'settings:logs-reveal',
  /**
   * Main → renderer (send). One runtime-log line, pushed live as it is
   * produced (main console / daemon child / renderer console). The
   * 「日志分析」panel subscribes via `desktopLogs.onLog` and appends each
   * entry. Only fires while the panel's webContents is registered as a log
   * subscriber (LOGS_SUBSCRIBE), so a closed panel never receives sends.
   */
  LOGS_STREAM: 'settings:logs-stream',
  /**
   * Renderer → main (invoke). Register the calling webContents as a live
   * LOGS_STREAM push target. Historically main did this itself in
   * openSettingsView — the settings overlay was its own WebContentsView, so
   * main knew exactly when it opened. Settings now live INSIDE the studio
   * tab as URL state (/?settings=1), which main can't observe, so the
   * 「日志分析」panel announces itself on mount instead. Unregistration on
   * webContents destruction is automatic (logCollector hooks 'destroyed');
   * LOGS_UNSUBSCRIBE covers the ordinary "panel closed, tab lives on" case.
   *
   * Side effect to be aware of: while subscribed, the calling webContents'
   * own console-message output is NOT captured as a `renderer` log source
   * (see logCollector.attachRendererCapture) — that exclusion is what
   * prevents a feedback loop now that the panel shares a webContents with
   * the whole studio app.
   */
  LOGS_SUBSCRIBE: 'settings:logs-subscribe',
  /**
   * Renderer → main (invoke). Counterpart of LOGS_SUBSCRIBE — stop pushing
   * LOGS_STREAM to the calling webContents (panel unmounted). Idempotent.
   */
  LOGS_UNSUBSCRIBE: 'settings:logs-unsubscribe',
  /**
   * Main → active chat tab renderer. The forwarded counterpart of
   * TAB_TRIGGER_MENU_ACTION. The chat renderer subscribes once on mount
   * and maps each action onto its local store (open settings / open logs /
   * toggle language). Only the active chat tab receives it.
   */
  SHELL_MENU_ACTION: 'shell:menu-action',
  /**
   * Shell renderer → main (invoke). The session list now lives in the
   * shell's left nav rail (a single column with the nav above it). The
   * shell has no engine of its own, so it can't go through the per-tab
   * `resolveEngine` path — and since 统一会话管理 it doesn't need to:
   * the list is the stateless known-workspaces scan (same data as
   * SESSION_LIST), returning a SessionListResult. Still returns
   * `{ threads: [] }` when there is no active chat tab — row clicks are
   * forwarded to the active tab to execute, so a list without a tab
   * would be dead rows.
   */
  SHELL_SESSION_LIST: 'shell:session-list',
  /**
   * Shell renderer → main (invoke). Forwarded counterpart that mirrors
   * TAB_TRIGGER_MENU_ACTION: the shell asks main to switch the active chat
   * tab to a given sessionId (or to a brand-new session). main sends
   * SHELL_SESSION_SWITCH to the active chat tab's webContents; the chat
   * renderer runs its existing onSwitchToThread/onSwitchToNewThread so all
   * the chat-store sync (setSession / loadSession / sessionLoading) happens
   * correctly. Doing the switch in the chat renderer — not via a direct
   * engine call from the shell — is what keeps the Thread view in lockstep.
   */
  SHELL_SESSION_SWITCH_REQUEST: 'shell:session-switch-request',
  /**
   * Main → active chat tab renderer (send). The forwarded switch command
   * carrying `{ sessionId }` (null = new chat). The chat renderer subscribes
   * once and routes it into its runtime's switch handler.
   */
  SHELL_SESSION_SWITCH: 'shell:session-switch',
  /**
   * Main → shell renderer (send). Fired whenever the active chat tab's
   * session list changes (new session / rename / close / tab switch) so the
   * shell's session list re-pulls via SHELL_SESSION_LIST. This is the
   * fan-out the plain SESSION_LIST_CHANGED lacks — that one only reaches the
   * chat tab's own webContents, never the shell.
   */
  SHELL_SESSION_LIST_CHANGED: 'shell:session-list-changed',
  /**
   * Shell renderer → main (invoke). Rename a session by id — engine-free
   * like SHELL_SESSION_LIST: main probes the known workspaces for the
   * jsonl and appends the custom-title line via sessionStore.renameSession
   * (identical on-disk format to the chat tab's SESSION_RENAME). Refresh
   * fan-out rides the engine's `sessionListChanged` emit — tabRegistry
   * relays it to the shell, so both the shell list and the chat sidebar
   * re-pull.
   */
  SHELL_SESSION_RENAME: 'shell:session-rename',
  /**
   * Shell renderer → main (invoke). Delete a session by id: best-effort
   * close of any live runtime for that id first (a fusion-code child must
   * not keep appending to a file we're about to unlink), then remove the
   * jsonl + subagent dir via the SDK's deleteSession (UUID lookup across
   * project dirs). Irreversible — the renderer owns the confirm UI.
   * Rejects when the session file is missing.
   */
  SHELL_SESSION_DELETE: 'shell:session-delete',
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
   * Renderer → main. One-shot pull of the current updater state — the
   * settings「更新应用」section calls this on mount so it renders the real
   * phase (downloading / ready / …) even when it mounts mid-flight.
   * Always resolves; in dev / unpackaged builds the state's `supported`
   * is false and every phase stays 'idle'.
   */
  UPDATER_GET_STATE: 'updater:get-state',
  /**
   * Renderer → main. Manually trigger a check ("检查更新" button / menu
   * item). Resolves with the state snapshot taken right after the check
   * kicks off; the actual outcome (available / up-to-date / error) arrives
   * via UPDATER_STATE_CHANGED pushes. No-op (resolves current state) when
   * a check/download is already in flight — electron-updater does not
   * support concurrent checks.
   */
  UPDATER_CHECK: 'updater:check',
  /**
   * Renderer → main. Quit and install the downloaded update. Only
   * meaningful in phase 'ready'; otherwise resolves without doing
   * anything (the renderer's button is disabled outside 'ready', but a
   * stale click racing a state push must not crash).
   */
  UPDATER_INSTALL: 'updater:install',
  /**
   * Main → every renderer. Pushed on every updater phase transition
   * (checking → available → downloading(progress) → ready / none / error).
   * Carries the full UpdaterState so receivers just replace their copy —
   * no re-pull round-trip needed (unlike APPEARANCE_CHANGED, there is no
   * daemon copy to re-read; main IS the source of truth here).
   */
  UPDATER_STATE_CHANGED: 'updater:state-changed',
  /**
   * Renderer → main. One-shot pull of the current auth state — the
   * AuthGate calls this on mount to decide「放行 or 显示登录页」。
   * Always resolves（读 main 内存态，不做任何网络/磁盘 IO）。
   */
  AUTH_GET_STATE: 'auth:get-state',
  /**
   * Renderer → main. Attempts a credential login. Resolves with
   * `{ ok: true, state }`（已登录快照）or `{ ok: false, error }`（中文
   * 错误文案，登录表单直接展示）。成功路径同时把状态写盘
   * （userData/auth.json）并广播 AUTH_STATE_CHANGED——发起登录的窗口
   * 用 resolve 值即时更新，其余窗口靠广播跟上。
   */
  AUTH_LOGIN: 'auth:login',
  /**
   * Renderer → main. Signs out：清内存态 + 删盘上凭据 + 广播。
   * 幂等——未登录时调用是无害 no-op。
   */
  AUTH_LOGOUT: 'auth:logout',
  /**
   * Main → every renderer. Pushed on every auth transition（登录成功 /
   * 退出登录）。Carries the full AuthState so receivers just replace
   * their copy——同 UPDATER_STATE_CHANGED 的「整体替换不拼装」约定。
   */
  AUTH_STATE_CHANGED: 'auth:state-changed',
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
   * Main → renderer push. Knowledge-base remote sync progress/state.
   * Broadcast to shell + chat tabs (web tabs skipped — no preload there
   * and no KB UI either).
   */
  KB_SYNC_STATUS: 'kb:sync-status',
  /**
   * Renderer → main. Persists the remote sync config (`{ baseUrl, kbId }`,
   * or `null` to disconnect) to `userData/kb-config.json`. Writing a
   * non-null remote also kicks off `triggerKbSyncNow()` immediately — the
   * user filling in a URL shouldn't require a second click to start the
   * first sync.
   */
  KB_REMOTE_SET: 'kb:remote-set',
  /**
   * Renderer → main. Manually kicks off a remote KB sync (the settings
   * page "sync now" button). Returns `'started'` | `'alreadyRunning'`
   * (a sync — manual or the 30s/6h scheduler — is already in flight) |
   * `'noRemote'` (no remote configured yet). Progress is reported
   * separately via the `KB_SYNC_STATUS` broadcast, not this call's result.
   */
  KB_SYNC_NOW: 'kb:sync-now',
  /**
   * Renderer → main. Opens the OS native folder picker for choosing the
   * local KB root. Engine-free counterpart of WORKSPACE_PICK — the
   * settings overlay isn't bound to any tab/engine, so this can't reuse
   * `resolveEngine`. Returns `{ path: null }` on cancel.
   */
  KB_ROOT_PICK: 'kb:root-pick',
  /**
   * Renderer → main. Exports the proposal document via the OS native
   * save dialog. Main writes the file and returns the absolute path;
   * returns `{ path: null }` when the user cancelled the dialog.
   *
   * `format` is a closed union (`ExportFormat` in proposalExport.ts):
   * md 直写、docx 走 markdownToDocxBuffer。
   */
  PROPOSAL_EXPORT: 'proposal:export',
  /**
   * Renderer → main. Renders the proposal markdown to a .docx binary
   * IN MEMORY (no save dialog, no disk write), so the renderer can paint a
   * docx-preview pagination view that matches the exported Word file
   * byte-for-byte — same `markdownToDocxBuffer` engine as PROPOSAL_EXPORT.
   */
  PROPOSAL_RENDER: 'proposal:render',
  /**
   * Renderer → main. 导出 PDF。与 md/docx 不同：PDF 不是从 markdown 在 main 直接生成
   * bytes，而是 renderer 先用 docx-preview 把【同一份 docx buffer】渲成自包含 HTML（样式内联、
   * 图 base64），main 再用隐藏 BrowserWindow + webContents.printToPDF 打成 A4 PDF。故走独立通道、
   * 不挤进 ProposalExportFormat 联合（那条 switch 的产物是 markdown→bytes，结构上容不下 PDF）。
   * 选 Chromium printToPDF 而非外部 LibreOffice：开箱即用、零外部依赖、中文字体由 Chromium 处理、
   * 且 PDF 与预览同源（同一 docx-preview 渲染）逐像素一致。
   */
  PROPOSAL_EXPORT_PDF: 'proposal:export-pdf',
  /**
   * Renderer → main. 与 PROPOSAL_EXPORT_PDF 同源、同引擎（同一份自包含 HTML + 隐藏窗口
   * printToPDF），唯一区别是【不弹保存框、不落盘】——直接把 PDF 字节回给渲染层。预览标签用它
   * 拿到与导出【逐字节一致】的 PDF，塞进 <iframe> 显示：预览的分页 = 导出 PDF 的分页，从根上消除
   * docx-preview 屏显不做溢出重排、而 Chromium 打印做真分页导致的「预览一页装下、PDF 分两页」错位。
   */
  PROPOSAL_RENDER_PDF: 'proposal:render-pdf',
  /** Renderer → main. 写入/读出/删除某会话的持久化草稿（userData/proposal-drafts/<id>.json）。 */
  PROPOSAL_SAVE_DRAFT: 'proposal:save-draft',
  PROPOSAL_LOAD_DRAFT: 'proposal:load-draft',
  PROPOSAL_DELETE_DRAFT: 'proposal:delete-draft',
  /**
   * Renderer → main. 核对一节正文里的 `（据《X》）` 引用是否真出自所引镜像原文
   * （trigram 重叠），返回每条引用的 verdict + 覆盖度。校验须在主进程（要读 userData
   * 镜像文件）；renderer 仅取结果用于标红/覆盖度徽标。失败降级（degraded:true），绝不阻塞。
   */
  PROPOSAL_VERIFY: 'proposal:verify',
  /**
   * Renderer → main. M-0 埋点：每次导出成功后 append 一条聚合记录到
   * userData/proposal-metrics/metrics.jsonl（可交付率代理 + 引用准确度）。本地不外传，
   * 失败静默——埋点是旁路信号，绝不阻塞导出。
   */
  PROPOSAL_METRIC_LOG: 'proposal:metric-log',
  /**
   * Renderer → main. 「召回预览」（只读）：给定关键词 + 当前产品集，返回知识库 top
   * 召回片段，供用户随时探库、判断检索质量、决定要不要加产品。与生成时的内容级召回共用
   * retrievePassages，但【只读、不注入提示词、不写盘】。
   */
  PROPOSAL_PEEK_RETRIEVAL: 'proposal:peek-retrieval',
  /**
   * Renderer → main. 读出图 API 设置（baseURL/model + apiKey 是否已配置）。为什么不回明文
   * key：main 侧 getAppSettings() 落盘明文，但 IPC 结构化克隆会把它摆进渲染进程内存，增大
   * 泄漏面（devtools/渲染进程崩溃转储都可能读到）。UI 只需要「已配置」布尔态就能渲染表单，
   * 故 apiKey 脱敏为占位符 `••••`（未配置则空串），见 PROPOSAL_IMAGE_SETTINGS_SET 的合并约定。
   */
  PROPOSAL_IMAGE_SETTINGS_GET: 'proposal-image:settings-get',
  /**
   * Renderer → main. 写出图 API 设置。若 `apiKey` 等于脱敏占位符 `••••`（用户只改了
   * baseURL/model、没重新输入 key），main 合并保留现存明文 key，避免占位符覆盖真 key。
   */
  PROPOSAL_IMAGE_SETTINGS_SET: 'proposal-image:settings-set',
  /**
   * Renderer → main. 文生图：调用 imageGenService.generateImage 出图后落盘到该会话的
   * 草稿资产目录（writeProposalImage，来源标记 'generated'/gen- 前缀），返回绝对路径。
   * 未配置 apiKey 时抛出中文错误，UI 据此提示去设置页填写。
   */
  PROPOSAL_IMAGE_GENERATE: 'proposal-image:generate',
  /**
   * Renderer → main. 改图：读 `sourcePath` 的字节喂给 imageGenService.editImage，出图后
   * 落盘（来源标记 'edited'/edit- 前缀），返回绝对路径。同 GENERATE，缺 apiKey 抛中文错误。
   */
  PROPOSAL_IMAGE_EDIT: 'proposal-image:edit',
  /**
   * Renderer → main. 上传本地图：弹 OS 原生文件选择框（限图片格式，单选），用户取消返回
   * null；选中后读字节落盘到该会话草稿资产目录（writeProposalImage，来源标记
   * 'uploaded'/upload- 前缀，ext 取自选中文件的扩展名），返回绝对路径。与 GENERATE/EDIT
   * 不同：上传不调出图 API，不受未配置 apiKey 限制。
   */
  PROPOSAL_IMAGE_UPLOAD: 'proposal-image:upload',
  /**
   * Renderer → main. 语义检索：模糊自然语言 → 混合(向量+BM25)命中片段+出处。供写方案
   * 搜索面板主动用。embedding 在 utilityProcess、不冻 main；模型缺失/stale 降级 BM25。
   * staleIndex=true 时结果是 BM25 降级（有内容但非语义），面板顶部显「需重建索引」条。
   */
  KB_SEMANTIC_SEARCH: 'kb:semantic-search',
  /**
   * Renderer → main. 扫描系统授权目录（下载 + 桌面）里的文档文件，返回元数据清单
   * （名称/路径/扩展名/大小/mtime/来源），驱动知识库页「全部文件」的网格/列表视图。
   *
   * 为什么只扫这两个目录：它们是 macOS TCC 的标准授权单元——首次 readdir 会触发系统
   * 「允许访问下载/桌面文件夹？」弹窗，用户点允许即完成授权（这就是"扫描授权的目录"），
   * 拒绝则该来源被跳过并记进 deniedSources，UI 据此提示去系统设置里开权限。
   *
   * engine-free（用户目录是全局的，不属于任何 tab）；只返回元数据不返回内容——文件
   * 字节仍走 SHELL_OPEN_PATH 交系统应用，渲染层磁盘触达面不因此扩大。
   */
  KB_LOCAL_DOCS_SCAN: 'kb:local-docs-scan',
  /**
   * Renderer → main. 读「全部文件」扫描目录清单（预设 下载/桌面 + 用户自定义，
   * 含停用态）。管理弹层打开时拉取。
   */
  KB_LOCAL_DOCS_DIRS_GET: 'kb:local-docs-dirs-get',
  /**
   * Renderer → main. 设置某目录是否参与扫描（预设=开关、自定义 false=移除），
   * 持久化到 userData/kb-config.json 并返回新清单。移除/停用不撤销系统层授权
   * ——只是不再扫，TCC 授权归系统设置管。
   */
  KB_LOCAL_DOCS_DIRS_SET: 'kb:local-docs-dirs-set',
  /**
   * Renderer → main. 弹 OS 原生文件夹选择器添加自定义扫描目录。macOS 上
   * 「用户在系统选择器里主动选中」本身就是授权动作（user-selected access），
   * 任意目录选完即可读，无需再弹 TCC——这是「修改授权目录」的正统入口。
   * 取消返回 { dirs 原样, added: null }。
   */
  KB_LOCAL_DOCS_DIRS_PICK: 'kb:local-docs-dirs-pick',
  /**
   * Renderer → main. 读知识库索引（~/.cowork/KB-INDEX.json，结构化 JSON——
   * 取代早期 KB-INDEX.md）+ 当前重建任务状态。「文档识别」页 mount 时拉取；
   * catalog 为 null = 还没建过索引（UI 显示「更新知识库」CTA）。
   */
  KB_CATALOG_GET: 'kb:catalog-get',
  /**
   * Renderer → main. 触发「更新知识库」：扫授权目录 → SDK 无头（print 模式）
   * 分批归类 → 全量重写 KB-INDEX.json。立即返回 'started'|'alreadyRunning'，
   * 进度/结果走 KB_CATALOG_STATUS 广播（长任务不占 invoke）。
   */
  KB_CATALOG_REBUILD: 'kb:catalog-rebuild',
  /**
   * Main → renderer push. 重建任务状态机（scanning → classifying(done/total)
   * → success/error）。广播面同 KB_SYNC_STATUS（shell + chat tabs）。
   */
  KB_CATALOG_STATUS: 'kb:catalog-status',
  /**
   * Renderer → main. 读当前生效的文档类别集合（分类管理页 + 文档识别页的
   * 分组顺序数据源）。持久化在 ~/.cowork/KB-CATEGORIES.json——与索引同目录，
   * 对话里的 local-kb skill 也读它；缺失时返回出厂默认八类。
   */
  KB_CATEGORIES_GET: 'kb:categories-get',
  /**
   * Renderer → main. 分类管理操作（add / rename / remove / move）。校验失败
   * 经 result.error 返回中文文案（不 reject）；rename/remove 同步迁移
   * 该域索引存量条目（migrated 条数带回提示）。「其他」不可删改。
   */
  KB_CATEGORIES_UPDATE: 'kb:categories-update',
  /**
   * Renderer → main. 批量读图片缩略图（160px，nativeImage 缩放后的 data URL）。
   * 「图片识别」卡片行的预览用——IMAGE_FILE_READ 回原图字节，几百张会爆内存；
   * 这条只回小缩略图，单次上限 60 张，损坏/超限的路径静默缺席（调用方按
   * 「有就显示、没有就占位」消费）。
   */
  KB_IMAGE_THUMBS: 'kb:image-thumbs',
  // ── KB 托管仓库管理页（P2）──────────────────────────────────────
  KB_DOCS_LIST: 'kb:docs-list',
  KB_TOOLING_CHECK: 'kb:tooling-check',
  KB_IMPORT_PICK: 'kb:import-pick',
  KB_IMPORT: 'kb:import',
  KB_DOC_DELETE: 'kb:doc-delete',
  KB_DOC_MOVE: 'kb:doc-move',
  KB_DOC_RETRY: 'kb:doc-retry',
  KB_CATEGORY_CREATE: 'kb:category-create',
  KB_CATEGORY_RENAME: 'kb:category-rename',
  KB_CATEGORY_DELETE: 'kb:category-delete',
  KB_DOC_OPEN_SOURCE: 'kb:doc-open-source',
  KB_DOC_PREVIEW: 'kb:doc-preview',
  KB_MIGRATE_FROM_FOLDER: 'kb:migrate-from-folder',
  KB_SYNC_PREVIEW: 'kb:sync-preview',
  KB_SYNC_FROM_LOCAL: 'kb:sync-from-local',
  KB_BUILD_STATUS_GET: 'kb:build-status-get',
  KB_BUILD_STATUS: 'kb:build-status'
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
  /**
   * 内容级召回开关（#2）：封面阶段外（phase !== 'cover'，即目录+正文回合）由渲染层置 true。
   * 为真时 engine 用本回合文本对已限定产品的镜像原文做关键词召回，把命中的真实片段注入本
   * 回合上下文（与文件清单并存、增量），治「知识库有料却没引到」。
   *
   * 为什么是「非封面」而非「仅正文」：phase 只在点阶段按钮时前进，用户手敲推进语时 phase
   * 滞后会漏掉首个正文回合的召回（实测踩到）。放宽到非封面后手敲/点按钮都触发。封面回合
   * （首发播种、问客户名）不召回。缺省/false = 不召回，回落到「只给文件清单让 AI 自查」。
   */
  proposalRetrieve?: boolean
}
export type ChatSendResult = { messageId: string }
export type ChatAbortPayload = { sessionId: string }
export type ChatEventPayload = { sessionId: string; event: ChatEvent }

/** Renderer → main queue-panel command payloads. */
export type ChatQueueListPayload = { sessionId: string }
export type ChatQueueRemovePayload = { sessionId: string; messageId: string }
export type ChatQueueEditPayload = {
  sessionId: string
  messageId: string
  text: string
}
export type ChatQueuePromotePayload = { sessionId: string; messageId: string }

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
 * Payload for SHELL_STAT_FILES. `paths` is a batch of candidate paths
 * scraped from assistant text (deduped by the caller). Absolute paths and
 * `~/`-prefixed paths are accepted — the model reports deliverables both
 * ways — and `~` is expanded against the user's home dir main-side.
 */
export type ShellStatFilesPayload = { paths: readonly string[] }

/**
 * Result of SHELL_STAT_FILES. `files` is the subset of the input that
 * exists on disk AND is a regular file, in the same order as the input,
 * with any `~` prefix expanded to the absolute home path (so entries are
 * directly usable with SHELL_OPEN_PATH / SHELL_REVEAL_PATH).
 * Non-absolute / missing / directory entries are dropped.
 *
 * `infos` mirrors `files` 1:1（同序同长，main 侧同一次 statSync 双写）——
 * 给需要渲染「大小 · 时间」元信息的调用方（OutputsPanel 的行式元信息行）。
 * 单独加字段而不是改 `files` 的元素类型，是为了不动只消费路径数组的
 * 既有调用方（AssistantDeliverables）。
 */
export type ShellStatFileInfo = {
  path: string
  size: number
  mtimeMs: number
}
export type ShellStatFilesResult = {
  files: readonly string[]
  infos: readonly ShellStatFileInfo[]
}

/**
 * SHELL_REVEAL_PATH reuses the open-path contract: absolute file path in,
 * `{ error: '' }` on success. Main validates the same way (absolute +
 * existing regular file) and calls `shell.showItemInFolder`.
 */
export type ShellRevealPathPayload = ShellOpenPathPayload
export type ShellRevealPathResult = ShellOpenPathResult

/**
 * Payload for IMAGE_MANIFEST_READ. `manifestPath` is the absolute path to a
 * ppt-master `image_prompts.json` (scraped from the running `image_gen.py
 * --manifest <path>` Bash command in the transcript). `withThumbnails` asks
 * main to also decode each already-written PNG into a small data-URI; the
 * 「图片」tab always wants them, but keeping the flag lets a future
 * metadata-only progress poll skip the decode cost.
 */
export type ImageManifestReadPayload = {
  manifestPath: string
  withThumbnails?: boolean
}

/**
 * One manifest item as surfaced to the 「图片」tab. `status` is image_gen.py's
 * lifecycle string (Pending → Generated / Failed / Needs-Manual); we keep it
 * as a widened union so an unknown value from a newer skill still renders.
 * `exists` is whether `<dir>/<filename>` is on disk yet; `absPath` is that
 * full path (for opening the full-res image via SHELL_OPEN_PATH); `thumbnail`
 * is a `data:image/png;base64,…` at ~320px wide, present only when the file
 * exists, decoded cleanly, and `withThumbnails` was set.
 */
export type ImageManifestItem = {
  filename: string
  status: 'Pending' | 'Generated' | 'Failed' | 'Needs-Manual' | (string & {})
  purpose?: string
  altText?: string
  lastError?: string
  exists: boolean
  absPath: string
  thumbnail?: string
}

/**
 * Result of IMAGE_MANIFEST_READ. `ok` false (+ `error`) covers a missing /
 * unreadable / malformed manifest — the tab shows an error rather than the
 * whole poll rejecting. `generatedCount` / `total` drive the progress bar.
 */
export type ImageManifestReadResult = {
  ok: boolean
  error?: string
  project?: string
  dir?: string
  items: ImageManifestItem[]
  generatedCount: number
  total: number
}

/**
 * Payload for IMAGE_FILE_READ. `absPath` is the absolute image path (the
 * `absPath` field of an ImageManifestItem — already resolved and confined
 * next to the manifest by IMAGE_MANIFEST_READ).
 */
export type ImageFileReadPayload = { absPath: string }

/**
 * Result of IMAGE_FILE_READ. `dataUrl` carries the ORIGINAL file bytes
 * base64-wrapped with the extension's mime type — no decode/re-encode, so
 * a JPEG stays a JPEG (nativeImage.toDataURL would balloon it into PNG).
 */
export type ImageFileReadResult = {
  ok: boolean
  dataUrl?: string
  error?: string
}

/**
 * Payload for SHEET_FILE_READ. `absPath` is an absolute path to a
 * spreadsheet file (typically the path behind a deliverable file card —
 * already verified on disk via SHELL_STAT_FILES).
 */
export type SheetFileReadPayload = { absPath: string }

/**
 * Result of SHEET_FILE_READ. `data` is the file's ORIGINAL bytes as plain
 * base64 (no data-URI prefix — SheetJS takes base64 directly). `error`
 * covers validation rejections (not absolute / not a spreadsheet extension /
 * too large) and read failures. `mtimeMs`/`size` stamp the version that was
 * read — the preview's change-detection baseline (see SHEET_FILE_STAT).
 */
export type SheetFileReadResult = {
  ok: boolean
  data?: string
  mtimeMs?: number
  size?: number
  error?: string
}

/** Payload for SHEET_FILE_STAT — same contract as SHEET_FILE_READ. */
export type SheetFileStatPayload = { absPath: string }

/**
 * Result of SHEET_FILE_STAT. `mtimeMs`/`size` of the file right now;
 * compare against the read stamp to detect on-disk changes.
 */
export type SheetFileStatResult = {
  ok: boolean
  mtimeMs?: number
  size?: number
  error?: string
}

/* ───────────────────────── Model switching ─────────────────────── */

/**
 * Result of MODEL_LIST: chat-capable model ids from the backend gateway's
 * OpenAI-compatible `/v1/models` catalog (image / audio / realtime entries
 * filtered out in main). `ok` false (+ `error`) covers gateway-unreachable;
 * main still returns its last good list in that case (stale beats empty for
 * a dropdown), so check `models.length`, not just `ok`.
 */
export type ModelListResult = {
  ok: boolean
  models: string[]
  error?: string
}

/**
 * Payload for MODEL_SET. `model` is the raw id passed through to the CLI
 * (the gateway resolves it); `null` clears the override so the backend's
 * default alias routing applies again. Engine-scoped: applies live to the
 * foreground runtime via the SDK's `setModel` control request AND becomes
 * the `model` option for every future `query()` this engine spawns.
 */
export type ModelSetPayload = { model: string | null }

/* ─────────────────── Session (thread) channels ─────────────────── */

export type SessionListResult = { threads: readonly ThreadSummary[] }

export type SessionLoadPayload = { sessionId: string }
export type SessionLoadResult = { messages: readonly ThreadMessageLike[] }

export type SessionNewResult = { sessionId: string }

export type SessionSwitchPayload = { sessionId: string; resume: boolean }
export type SessionSwitchResult = { sessionId: string }

export type SessionRenamePayload = { sessionId: string; title: string }
export type SessionRenameResult = { ok: true }

/** Payload for SESSION_WORKSPACE_SET. `path` must be an absolute dir. */
export type SessionWorkspaceSetPayload = { sessionId: string; path: string }
export type SessionWorkspaceSetResult = { ok: true }

/**
 * Result of WORKSPACE_KNOWN_LIST. `workspaces[0]` is always the default
 * workspace (OS 桌面)；其余按最近添加序。
 */
export type WorkspaceKnownListResult = { workspaces: string[] }

export type SessionCloseRuntimePayload = { sessionId: string }
export type SessionCloseRuntimeResult = { ok: true }

export type SessionDeletePayload = { sessionId: string }

export type SessionSearchPayload = { query: string }
/**
 * One session's content-search result. `snippet` is a pre-windowed
 * excerpt around the FIRST hit (main truncates so a hit inside a huge
 * assistant message doesn't ship the whole message over IPC); the
 * renderer only needs to highlight the query inside it.
 */
export type SessionContentHit = {
  sessionId: string
  /** Excerpt around the first matching message, ellipsised both ends. */
  snippet: string
  /** Which side said the matching message (renders as 你：/ AI： prefix). */
  who: 'user' | 'assistant'
  /** Total matching messages in this session (for the "共 N 条命中" meta). */
  hitCount: number
}
export type SessionSearchResult = { hits: readonly SessionContentHit[] }

export type SessionListActiveRuntimesResult = { sessionIds: readonly string[] }

/**
 * Payload for LANG_CHANGED. Must match the `Lang` type in
 * `apps/studio/src/chat/i18n.ts` — keep in sync.
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
 * - `studio`   — the dev-only studio dev server (apps/studio, next dev) child's output.
 * - `renderer` — a tab/overlay renderer process's console-message.
 */
export type LogSource = 'main' | 'daemon' | 'web' | 'studio' | 'renderer'

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
export type ShellMenuAction =
  | 'open-settings'
  | 'open-logs'
  | 'toggle-lang'
  // 打开会话搜索弹窗。入口在 shell rail（设置下方的「搜索对话」行 + ⌘K），
  // 但弹窗 UI 渲染在 active chat tab 里 —— shell 可见区只有 220px 的 rail，
  // 一个 580px 的 Spotlight 弹窗只能住在 chat renderer（它覆盖整个内容区）。
  | 'open-search'

/** Payload for SHELL_MENU_ACTION / TAB_TRIGGER_MENU_ACTION. */
export type ShellMenuActionPayload = { action: ShellMenuAction }

/** Result of APPEARANCE_GET — null when the daemon is offline or empty. */
export type AppearanceGetResult = { appearance: AppearancePrefs | null }
/** Payload for APPEARANCE_SET — a partial patch the daemon deep-merges. */
export type AppearanceSetPayload = { patch: AppearancePrefs }
/** Result of APPEARANCE_SET — the daemon's merged appearance, or null on failure. */
export type AppearanceSetResult = { appearance: AppearancePrefs | null }

/**
 * Auto-update lifecycle phase, owned by main's appUpdater service
 * (electron-updater over the public GitHub releases repo).
 *
 *   idle ─ check ─→ checking ─→ available ─→ downloading ─→ ready
 *                        │                                    │
 *                        ├─→ none (already latest)            └─ install → quit
 *                        └─→ error
 *
 * 'downloading' is entered implicitly (autoDownload=true): 'available' is a
 * transient phase the renderer may never observe between two pushes — treat
 * available/downloading the same visually. 'error' keeps the app usable; the
 * next manual check resets to 'checking'.
 */
export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error'

/**
 * Full updater snapshot. Main pushes it on every transition
 * (UPDATER_STATE_CHANGED) and returns it from UPDATER_GET_STATE /
 * UPDATER_CHECK, so the renderer never assembles state from event crumbs.
 */
export interface UpdaterState {
  phase: UpdaterPhase
  /** app.getVersion() — the running build. */
  currentVersion: string
  /** Target version once known (phase available/downloading/ready). */
  availableVersion: string | null
  /** 0-100 while downloading, null otherwise. */
  downloadPercent: number | null
  /** Human-readable failure while phase === 'error', null otherwise. */
  errorMessage: string | null
  /**
   * false in dev / unpackaged runs (electron-updater has no app-update.yml
   * to read) — the settings UI shows a "开发模式不可用" hint instead of the
   * check button.
   */
  supported: boolean
}

/* ───────────────────────── Auth（登录/账号）───────────────────────── */

/**
 * 已登录用户的最小画像。plan 先随用户体系一起定义（套餐系统是同一条
 * 开发线）：`expiresAt` 为 epoch ms，null = 永久（无到期日）——与账户
 * 菜单套餐区的「永久」占位语义对齐。真实后端接入后字段只增不改。
 */
export interface AuthUser {
  /** 稳定用户标识（占位实现 = email；接后端后换成服务端 id）。 */
  id: string
  email: string
  /** 展示名（占位实现 = email 的 @ 前段）。 */
  name: string
  plan: {
    /** 套餐名，如「免费版」「专业版」；占位实现固定「基础版」。 */
    name: string
    /** 到期时间 epoch ms；null = 永久。 */
    expiresAt: number | null
  }
}

/**
 * Full auth snapshot. Main pushes it on every transition
 * (AUTH_STATE_CHANGED) and returns it from AUTH_GET_STATE / AUTH_LOGIN,
 * so the renderer never assembles state from event crumbs（同 UpdaterState
 * 约定）。`status` 是闭合二值——「未知/加载中」只存在于 renderer 侧
 * （AuthGate 在首次 getAuthState resolve 前的本地态），main 侧任何时刻
 * 都有明确结论。
 */
export interface AuthState {
  status: 'signedOut' | 'signedIn'
  /** 已登录时的用户画像；signedOut 时恒为 null。 */
  user: AuthUser | null
}

export interface AuthLoginPayload {
  email: string
  password: string
}

/**
 * AUTH_LOGIN 的结论。失败时 `error` 是给登录表单直接展示的中文文案
 * （main 侧生成，renderer 不做错误码翻译——同 TranscribeAudioResult
 * 的「main 说人话」约定）。
 */
export type AuthLoginResult =
  | { ok: true; state: AuthState }
  | { ok: false; error: string }

/**
 * Supported export formats for a proposal document. Defined here (shared)
 * so the renderer payload, the preload type, and the main-side
 * proposalExport.ts can all reference the same closed union without
 * circular imports. MVP is `'md'`; extend to `'docx' | 'pdf'` when those
 * adapters land — the IPC surface requires no changes.
 */
// md/docx 都是「markdown → bytes 在 main 直出」的格式。PDF 不在此列：它要 renderer 先 docx-preview
// 渲成 HTML、main 再 printToPDF（main 无 DOM），结构不同，走独立的 PROPOSAL_EXPORT_PDF 通道。
export type ProposalExportFormat = 'md' | 'docx'

/**
 * 一张预渲的 mermaid 图：renderer 把 mermaid 渲成 SVG，再用 canvas 栅格成 PNG（base64，无
 * `data:` 前缀），连同像素尺寸传给 main 直接 ImageRun 嵌入。为什么栅格化放 renderer 而非 main：
 * ① 不必引入 sharp 等原生依赖；② Chromium 用与屏幕预览同一套字体栅格，导出位图里的中文绝不
 * 缺字（main 侧若用 librsvg 渲 SVG，依赖系统字体，中文易变方框）。
 */
export interface MermaidImage {
  /** PNG 字节的 base64（不含 `data:image/png;base64,` 前缀）。main 端 Buffer.from(png,'base64') 还原后 ImageRun。 */
  png: string
  width: number
  height: number
}

/** Payload for PROPOSAL_EXPORT. */
export interface ProposalExportPayload {
  markdown: string
  format: ProposalExportFormat
  /**
   * 选中的 Word 样式模板配置（字体/字号/对齐/缩进/行距/页边距/列表符号）。纯数据，
   * 结构化克隆安全。仅 `'docx'` 用得到（驱动 markdownToDocxBuffer 的样式）；`'md'`
   * 是纯文本无样式，忽略此字段。省略时 main 端回退默认模板（经典正式）。
   */
  style?: ProposalStyleConfig
  /**
   * 预渲的 mermaid 图（mermaid 源码 trim → {@link MermaidImage}）。mermaid 只能在 renderer 渲成
   * 图，main 直接嵌入其 PNG（见 proposalDocx）。仅 `'docx'` 用；省略 → mermaid 块降级文字占位。
   * key = mermaid 源码（trim 后），与 main 侧 mdast code 节点 node.value.trim() 对齐。
   */
  mermaidImages?: Record<string, MermaidImage>
}

/** Result of PROPOSAL_EXPORT. `path` is null when the user cancelled. */
export interface ProposalExportResult {
  path: string | null
}

/**
 * Payload for PROPOSAL_EXPORT_PDF（P2-2）。`html` 是 renderer 用 docx-preview 渲好的【自包含】
 * HTML 文档串（docx-preview 注入的 `<style>` + base64 内联图 + 打印用 @page A4 复位 CSS），main
 * 不再依赖任何外部资源即可在隐藏窗口直接 printToPDF。`defaultPath` 是保存对话框默认文件名。
 */
export interface ProposalExportPdfPayload {
  html: string
  defaultPath?: string
}

/** Result of PROPOSAL_EXPORT_PDF. `path` is null when the user cancelled the save dialog. */
export interface ProposalExportPdfResult {
  path: string | null
}

/**
 * Payload for PROPOSAL_RENDER_PDF。`html` 与 PROPOSAL_EXPORT_PDF 完全同构（renderer 用
 * docx-preview 渲好的自包含 HTML，含 @page A4 打印复位 CSS + base64 内联图），main 隐藏窗口
 * printToPDF 后【回字节而非落盘】，供预览标签直接显示。
 */
export interface ProposalRenderPdfPayload {
  html: string
}

/**
 * Result of PROPOSAL_RENDER_PDF. `bytes` 是 PDF 二进制（main 侧 Node `Buffer`，经 IPC
 * 结构化克隆到渲染层为 `Uint8Array`）。渲染层包成 `application/pdf` Blob → objectURL → <iframe>。
 */
export interface ProposalRenderPdfResult {
  bytes: Uint8Array
}

/** Payload for PROPOSAL_RENDER. */
export interface ProposalRenderPayload {
  markdown: string
  /**
   * 实时预览用的样式模板配置——与 PROPOSAL_EXPORT 的 style 同源同义，保证「预览=导出
   * 逐像素一致」。省略时回退默认模板（经典正式）。
   */
  style?: ProposalStyleConfig
  /** 预渲的 mermaid 图（code→{@link MermaidImage}）。与 PROPOSAL_EXPORT 同义，保证「预览=导出一致」。 */
  mermaidImages?: Record<string, MermaidImage>
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
 * 一份持久化的方案草稿记录（v1）。写入 userData/proposal-drafts/<sessionId>.json。
 * sections/products 结构与 renderer 的 ProposalSection/ProposalProduct 同构——本文件是
 * shared、不能 import renderer 类型，故在此内联其结构（字段须与 renderer 保持一致）。
 * consumedDraftIds/viewMode/workspaceOpen 刻意不持久化（见设计 spec「数据模型」）。
 */
export interface ProposalDraftRecord {
  version: 1
  sessionId: string
  sections: Array<{
    id: string
    markdown: string
    kind: ProposalKind
    truncated?: boolean
  }>
  products: Array<{ productLine: string; product: string }>
  phase: ProposalKind
  updatedAt: number
}

/** Payload for PROPOSAL_VERIFY：待核对的一节正文 markdown（含 `（据《X》）` 引用）。 */
export interface ProposalVerifyPayload {
  markdown: string
}
/** Result of PROPOSAL_VERIFY：引用核对汇总（见 shared/proposal.ts 的 SectionVerification）。 */
export type ProposalVerifyResult = SectionVerification

/** 「召回预览」一条片段（方案三·只读，UI 展示用最小形：来源文件名 + 片段文本 + BM25 分）。 */
export interface ProposalRetrievedPassage {
  title: string
  text: string
  score: number
}
/** Payload for PROPOSAL_PEEK_RETRIEVAL：关键词 + 当前产品集（收窄检索范围）。 */
export interface ProposalPeekRetrievalPayload {
  query: string
  products: ReadonlyArray<{ productLine: string; product: string }>
}
/** Result of PROPOSAL_PEEK_RETRIEVAL：top 召回片段；空 query / 无产品 / 索引不可用 → 空数组。 */
export interface ProposalPeekRetrievalResult {
  passages: ProposalRetrievedPassage[]
  /**
   * 诊断（方案三）：本次扫描到的【产品资料文件数】（= 当前产品集在知识库索引里匹配到的 ok 文件数）。
   * 0 = 产品与索引对不上 / 索引为空（根本没料可搜，不是检索没命中）；>0 但 passages 空 = 有料但关键词
   * 词面没匹配上（BM25 按词面）。UI 据此给不同的空态文案，便于用户与排障判断到底卡在哪。
   */
  scannedFiles: number
}

/** Payload for KB_SEMANTIC_SEARCH：自然语言检索词 + 要搜的产品集（空集→空结果）。 */
export interface KbSemanticSearchPayload {
  query: string
  products: ReadonlyArray<{ productLine: string; product: string }>
}
/**
 * Result of KB_SEMANTIC_SEARCH：混合(向量+BM25)命中片段列表 + stale 旗标 + 降级旗标。
 * staleIndex=true 表示向量索引过期、本次结果来自 BM25 降级，面板顶部提示「需重建索引」。
 * degraded=true 表示命中因【基础设施状态】只来自 BM25（worker 未就绪/stale/超时/error）——
 * 面板给弱提示「词面匹配」；空产品集短路是设计使然的 no-op，不置 true。
 */
export interface KbSemanticSearchResult {
  hits: import('./kbIndex').SemanticHit[]
  staleIndex: boolean
  degraded: boolean
}

/**
 * 预设扫描目录标识。路径不落盘、恒用 Electron 的 `app.getPath('downloads'|
 * 'desktop')` 动态解析（跟随系统本地化改名）；用户停用只记 key（见 KbConfig）。
 */
export type LocalDocsPreset = 'downloads' | 'desktop'

/**
 * 一个参与「全部文件」扫描的目录。`path` 兼作来源 id——文件条目的 `source`、
 * 筛选「按来源」、denied 上报全按它对齐。
 */
export interface LocalDocsDir {
  /** 绝对路径（来源 id）。 */
  path: string
  /** 展示名：预设目录固定「下载」「桌面」，自定义目录用 basename。 */
  label: string
  /** 预设目录带 key；用户添加的自定义目录为 null。 */
  preset: LocalDocsPreset | null
  /**
   * 是否参与扫描。预设目录可停用（enabled:false 仍留在清单里供再启用）；
   * 自定义目录关掉即从清单移除，所以列表里的 custom 恒为 true。
   */
  enabled: boolean
}

/** Result of KB_LOCAL_DOCS_DIRS_GET / _SET（全量清单，含停用的预设）。 */
export interface LocalDocsDirsResult {
  dirs: LocalDocsDir[]
}

/**
 * Payload for KB_LOCAL_DOCS_DIRS_SET：把某目录设为 参与/不参与 扫描。
 * 预设目录 → 开关（写 disabledPresets）；自定义目录 enabled:false → 移除。
 */
export type LocalDocsDirSetPayload = { path: string; enabled: boolean }

/**
 * Result of KB_LOCAL_DOCS_DIRS_PICK。`added` 是本次新加入清单的目录路径
 * （用户取消选择器 / 选了已在清单里的目录 → null，dirs 原样返回）。
 */
export interface LocalDocsDirsPickResult {
  dirs: LocalDocsDir[]
  added: string | null
}

/**
 * KB catalog 系通道的域选择 payload（缺省 'docs' 向后兼容）。
 * KB_CATALOG_GET / KB_CATALOG_REBUILD / KB_CATEGORIES_GET 共用。
 */
export type KbDomainPayload = { domain?: import('./kbCatalog').KbCatalogDomain } | undefined

/** KB_CATALOG_STATUS 的 push payload：文档/图片两域任务可并行，订阅方按域路由。 */
export interface KbCatalogStatusPayload {
  domain: import('./kbCatalog').KbCatalogDomain
  status: import('./kbCatalog').KbCatalogStatus
}

/**
 * Payload for KB_CATEGORIES_UPDATE。判别式四操作；名字校验（非空/长度/重名/
 * 数量上限）在 main 侧统一做，UI 只透传。`domain` 缺省 docs。
 */
export type KbCategoriesUpdatePayload = {
  domain?: import('./kbCatalog').KbCatalogDomain
} & (
  | { action: 'add'; name: string }
  | { action: 'rename'; from: string; to: string }
  | { action: 'remove'; name: string }
  | { action: 'move'; name: string; dir: 'up' | 'down' }
)

/** Payload for KB_IMAGE_THUMBS。paths 上限 60/次，超出部分静默丢弃。 */
export type KbImageThumbsPayload = { paths: readonly string[] }

/** Result of KB_IMAGE_THUMBS。键 = 输入路径；读不出/损坏的路径缺席。 */
export interface KbImageThumbsResult {
  thumbs: Record<string, string>
}

/**
 * Result of KB_CATEGORIES_GET / _UPDATE。`migrated` = 本次操作迁移的索引条目数
 * （仅 rename/remove 非零）；`error` 非空 = 操作被拒（categories 为未变的现状）。
 */
export interface KbCategoriesResult {
  categories: string[]
  migrated: number
  error?: string
}

/** 一条被扫到的文档文件（只有元数据，没有内容——见 KB_LOCAL_DOCS_SCAN 通道注释）。 */
export interface LocalDocEntry {
  /** 文件名（含扩展名）。 */
  name: string
  /** 绝对路径——直接可喂 SHELL_OPEN_PATH / SHELL_REVEAL_PATH。 */
  absPath: string
  /** 小写扩展名（不带点），恒在 LOCAL_DOC_EXTS 白名单内。 */
  ext: string
  size: number
  mtimeMs: number
  /** 所属扫描目录的绝对路径（LocalDocsDir.path，来源筛选/标签按它查）。 */
  source: string
}

/** Payload for KB_LOCAL_DOCS_SCAN。`force` 绕过 main 侧的短 TTL 缓存（手动刷新按钮）。 */
export type LocalDocsScanPayload = { force?: boolean } | undefined

/**
 * Result of KB_LOCAL_DOCS_SCAN。`files` 已按 mtime 降序、截断到 main 侧上限；
 * `total` 是截断前的命中总数（`truncated` = total > files.length）。
 * `dirs` 是本次参与扫描的目录清单（enabled 的那部分）——来源筛选选项与来源
 * 标签的数据源，随扫描结果一起回避免第二趟 IPC。
 * `deniedDirs` 是因系统权限（macOS TCC 拒绝）没扫成的目录路径——UI 据此提示
 * 去「系统设置 → 隐私与安全性」开权限，而不是显示一个假空态。
 */
export interface LocalDocsScanResult {
  ok: boolean
  files: LocalDocEntry[]
  total: number
  truncated: boolean
  dirs: LocalDocsDir[]
  deniedDirs: string[]
  /** 本次结果的扫描时间戳（缓存命中时是缓存那次的时间）。 */
  scannedAt: number
  error?: string
}

export interface ProposalLoadDraftPayload {
  sessionId: string
}
export interface ProposalDeleteDraftPayload {
  sessionId: string
}
export interface ProposalSaveDraftResult {
  ok: boolean
}
/** Result of PROPOSAL_METRIC_LOG。payload 直接是 ProposalMetricRecord（见 shared/proposal.ts）。 */
export interface ProposalMetricLogResult {
  ok: boolean
}
export interface ProposalDeleteDraftResult {
  ok: boolean
}

/**
 * 出图 API 凭据配置。唯一定义在 shared：renderer/preload 不能 import main-only 文件，
 * 而 main 可以 import shared——imageGenService.ts 的 `ImageApiConfig` 是本类型的别名
 * （评审发现：曾是两份靠人肉同步的结构双胞胎，单侧加字段编译照过、字段却静默丢失）。
 *
 * `apiKey` 在 PROPOSAL_IMAGE_SETTINGS_GET 的返回里是脱敏值（`''` 未配置 / `'••••'` 已配置），
 * 在 PROPOSAL_IMAGE_SETTINGS_SET 的入参里可能是真实 key 或该脱敏占位符（占位符触发 main 侧
 * 合并保留现存 key，见通道注释）。
 */
export interface ProposalImageApiConfig {
  apiKey: string
  baseURL: string
  model: string
}

/**
 * apiKey 脱敏占位符——跨进程线协议哨兵，不是 UI 文案：GET 用它替换明文 key 回给渲染进程；
 * SET 收到它表示「保留现存 key」。两端必须字节一致，否则渲染进程发来的字面圆点会被当成
 * 真 key 存掉（静默毁 key，评审发现曾是三处独立字面量）。唯一定义在此，renderer/main 都
 * 从这里 import；i18n 里同形的 placeholder 只是展示文案、与本协议无关。
 */
export const PROPOSAL_IMAGE_API_KEY_MASK = '••••'

/** Payload for PROPOSAL_IMAGE_GENERATE。 */
export interface ProposalImageGeneratePayload {
  sessionId: string
  prompt: string
}

/** Payload for PROPOSAL_IMAGE_EDIT。`sourcePath` 是待改图片的绝对路径（main 侧读字节）。 */
export interface ProposalImageEditPayload {
  sessionId: string
  sourcePath: string
  prompt: string
}

/** Result of PROPOSAL_IMAGE_GENERATE / PROPOSAL_IMAGE_EDIT。`path` 是落盘后的绝对路径。 */
export interface ProposalImageResult {
  path: string
}

/** Payload for PROPOSAL_IMAGE_UPLOAD。 */
export interface ProposalImageUploadPayload {
  sessionId: string
}


/**
 * The exact shape of the preload-exposed `window.chatApi`. Matches this
 * interface on both sides via the shared type.
 */
export interface ChatApi {
  send(payload: ChatSendPayload): Promise<ChatSendResult>
  abort(payload: ChatAbortPayload): Promise<void>
  /**
   * Message-queue panel commands. `queueList` seeds the panel on mount;
   * live changes then arrive as `queue_changed` events via `onEvent`.
   * remove/edit/promote resolve to `true` when the target turn was
   * still queued (id may have already been promoted into the active
   * slot, in which case they no-op to `false`).
   */
  queueList(payload: ChatQueueListPayload): Promise<QueuedMessage[]>
  queueRemove(payload: ChatQueueRemovePayload): Promise<boolean>
  queueEdit(payload: ChatQueueEditPayload): Promise<boolean>
  queuePromote(payload: ChatQueuePromotePayload): Promise<boolean>
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
   * 已知工作区列表（[0] 恒为默认工作区/桌面）。composer「选择工作
   * 目录」下拉的数据源。
   */
  listKnownWorkspaces(): Promise<WorkspaceKnownListResult>

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
   * Reveal an absolute file path in the OS file manager (Finder), with the
   * file selected. The deliverable file cards' 打开方式 menu offers this
   * alongside plain opening. On error, `result.error` is non-empty.
   */
  revealPath(payload: ShellRevealPathPayload): Promise<ShellRevealPathResult>

  /**
   * Read a ppt-master image-generation manifest by absolute path, returning
   * each item's status and (for already-written PNGs) a small thumbnail
   * data-URI. The 「图片」canvas tab polls this while `image_gen.py --manifest`
   * runs, to show generation progress and previews.
   */
  readImageManifest(payload: ImageManifestReadPayload): Promise<ImageManifestReadResult>

  /**
   * Read one local image file as a full-resolution data URI for the 图片
   * tab's in-app lightbox. Original bytes, extension-derived mime.
   */
  readImageFile(payload: ImageFileReadPayload): Promise<ImageFileReadResult>

  /**
   * Read one local spreadsheet file (xlsx / xls / csv) as base64 bytes for
   * the in-app spreadsheet preview panel. Extension-whitelisted and
   * size-capped main-side; parsing is the renderer's job (SheetJS).
   */
  readSheetFile(payload: SheetFileReadPayload): Promise<SheetFileReadResult>

  /**
   * Stat one spreadsheet file (mtime + size) for the preview's on-disk
   * change detection. See SHEET_FILE_STAT.
   */
  statSheetFile(payload: SheetFileStatPayload): Promise<SheetFileStatResult>

  /**
   * List chat-capable model ids from the backend gateway (main-side cached).
   * The composer's 模型 chip calls this when its dropdown opens.
   */
  listModels(): Promise<ModelListResult>

  /**
   * Switch the model for this window's engine — live for the foreground
   * session, and the default for future sessions here. `null` restores the
   * backend default. The engine reflects the pick into SessionMeta.model and
   * fires `onSessionMetaChanged`, so the chip label updates via the normal
   * meta refresh path.
   */
  setModel(model: string | null): Promise<void>

  /**
   * List all sessions across every known workspace, newest first
   * (统一会话管理 — each ThreadSummary carries its `workspacePath`).
   * Returns an empty array when no workspace has prior fusion-code
   * transcripts.
   */
  listSessions(): Promise<SessionListResult>

  /**
   * Full-text search across every known workspace's session transcripts
   * (message content only — the search dialog filters titles locally
   * from listSessions). Returns per-session excerpt hits; see
   * SESSION_SEARCH for the scan/caps story.
   */
  searchSessions(payload: SessionSearchPayload): Promise<SessionSearchResult>

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
   * 给会话指定工作目录（composer chip）。新会话记预选；已有记录的会话
   * 迁移 transcript 到新目录（历史无损）。本轮对话进行中会被 main 拒绝
   * （Promise reject）——调用方应在 streaming 时把 chip 渲染成只读态，
   * 而不是靠 catch 兜底。
   */
  setSessionWorkspace(
    payload: SessionWorkspaceSetPayload
  ): Promise<SessionWorkspaceSetResult>

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
   * Subscribe to session-switch commands forwarded from the shell's
   * session list. `sessionId` null = new chat. The chat renderer routes it
   * into its runtime's existing switch flow so all chat-store sync happens
   * there. Only the active chat tab receives these. Returns an unsubscribe.
   */
  onShellSessionSwitch(handler: (sessionId: string | null) => void): () => void

  /**
   * Close the settings modal overlay. Called by the settings overlay
   * renderer (`?settings=1`) on scrim click / Escape / the ✕ button.
   * Resolves once main has torn the overlay view down.
   */
  closeSettingsWindow(): Promise<void>

  /** One-shot pull of the auto-updater state (see UPDATER_GET_STATE). */
  getUpdaterState(): Promise<UpdaterState>

  /**
   * Manually trigger an update check (see UPDATER_CHECK). Outcome arrives
   * via onUpdaterStateChanged; the resolved snapshot only reflects the
   * kick-off ('checking', or unchanged when unsupported/in-flight).
   */
  checkForUpdates(): Promise<UpdaterState>

  /**
   * Quit and install the downloaded update (see UPDATER_INSTALL). Resolves
   * before the app actually quits; callers should not await-then-act.
   */
  installUpdate(): Promise<void>

  /**
   * Subscribe to updater phase pushes. The handler receives the full
   * UpdaterState — replace, don't merge. Returns an unsubscribe.
   */
  onUpdaterStateChanged(handler: (state: UpdaterState) => void): () => void

  /**
   * One-shot pull of the current auth state (see AUTH_GET_STATE)。
   * AuthGate 挂载时调用，决定放行还是显示登录页。
   */
  getAuthState(): Promise<AuthState>

  /**
   * Credential login (see AUTH_LOGIN)。resolve 即结论：ok=false 时
   * `error` 直接展示；ok=true 时携带已登录快照，发起窗口无需等广播。
   */
  login(payload: AuthLoginPayload): Promise<AuthLoginResult>

  /** Sign out (see AUTH_LOGOUT)。幂等；结果走 AUTH_STATE_CHANGED 广播。 */
  logout(): Promise<void>

  /**
   * Subscribe to auth transition pushes. The handler receives the full
   * AuthState — replace, don't merge. Returns an unsubscribe.
   */
  onAuthStateChanged(handler: (state: AuthState) => void): () => void

  /**
   * Read the current KB root path, the fixed output directory, the
   * remote sync config (`null` when not connected), and the last
   * successful sync's timing (`null` when never synced).
   * `kbRoot` is null when the user hasn't picked one yet.
   * `outDir` is always `userData/kb-index` (computed in main).
   */
  getKbPath(): Promise<{
    kbRoot: string | null
    outDir: string
    remote: import('./kbConfig').KbRemoteConfig | null
    lastSync: { atMs: number; builtAtMs: number } | null
  }>

  /**
   * Persist the user-picked KB root path. Main writes it to
   * `userData/kb-config.json`; subsequent getKbPath / readKbIndex
   * calls reflect the update immediately.
   */
  setKbPath(kbRoot: string): Promise<void>

  /**
   * Persist the remote sync config (or `null` to disconnect). Writing a
   * non-null remote also triggers an immediate sync — no separate
   * "sync now" click needed right after connecting.
   */
  setKbRemote(remote: import('./kbConfig').KbRemoteConfig | null): Promise<void>

  /**
   * Manually kick off a remote KB sync. Returns `'started'` |
   * `'alreadyRunning'` | `'noRemote'`; progress/result is reported
   * separately via `onKbSyncStatus`.
   */
  kbSyncNow(): Promise<'started' | 'alreadyRunning' | 'noRemote'>

  /**
   * Open the OS native folder picker for the local KB root. Engine-free
   * (the settings overlay has no bound tab/engine). Returns
   * `{ path: null }` on cancel.
   */
  pickKbRoot(): Promise<{ path: string | null }>

  /**
   * Subscribe to KB remote sync status pushes (idle/syncing/success/error).
   * Returns an unsubscribe, mirroring the on/off pattern of `onEvent`.
   */
  onKbSyncStatus(handler: (status: import('./kbSyncStatus').KbSyncStatus) => void): () => void

  /**
   * Read the built knowledge-base index from `userData/kb-index/index.json`.
   * Returns null when the file doesn't exist yet (index not yet built).
   * The renderer uses this to decide whether to show the build CTA or
   * the ready state.
   */
  readKbIndex(): Promise<import('./kbIndex').KbIndex | null>

  /**
   * 「召回预览」（方案三·只读）：给定关键词 + 当前产品集，返回知识库 top 召回片段。让用户
   * 随时探库、判断检索质量、决定要不要加产品。绝不写盘、绝不注入提示词。
   */
  peekProposalRetrieval(
    payload: ProposalPeekRetrievalPayload
  ): Promise<ProposalPeekRetrievalResult>

  /**
   * 语义搜索面板：混合(向量+BM25)检索，返回 SemanticHit 列表 + staleIndex 旗标。
   * staleIndex=true → 向量索引已过期、结果为 BM25 降级，面板顶部显「需重建」提示条。
   * 绝不 reject（全防御式）——空 query 立即返回 { hits:[], staleIndex:false }。
   */
  kbSemanticSearch(payload: KbSemanticSearchPayload): Promise<KbSemanticSearchResult>

  // ── KB 托管仓库管理页（P2）。renderer 只传相对路径，绝对路径还原在 main 完成防越权。──
  kbDocsList(): Promise<import('./kbAdmin').KbDocsListResult>
  kbToolingCheck(): Promise<import('./kbAdmin').KbToolingStatus>
  kbPickImportFiles(): Promise<{ paths: string[] }>
  kbImport(payload: import('./kbAdmin').KbImportPayload): Promise<import('./kbAdmin').KbImportResultDto>
  kbDeleteDoc(relPath: string): Promise<void>
  kbMoveDoc(payload: import('./kbAdmin').KbMovePayload): Promise<string>
  kbRetryDoc(relPath: string): Promise<void>
  kbCreateCategory(payload: import('./kbAdmin').KbCategoryPayload): Promise<void>
  kbRenameCategory(payload: import('./kbAdmin').KbCategoryRenamePayload): Promise<void>
  kbDeleteCategory(prefix: string): Promise<void>
  kbDocOpenSource(relPath: string): Promise<void>
  kbDocPreview(relPath: string): Promise<{ text: string }>
  /** 内部弹目录选择器迁移旧资料；用户取消返回 null。 */
  kbMigrateFromFolder(): Promise<{ imported: number } | null>
  /** 预览同步计划（不写盘），供 UI 在真删文件前弹确认；无记住的源返回 null。 */
  kbSyncPreview(): Promise<import('./kbAdmin').KbSyncPreview | null>
  /** 从记住的本地源文件夹增量同步（增/删/改）；首次无源则弹目录选择器，取消返回 null。 */
  kbSyncFromLocal(): Promise<import('./kbAdmin').KbLocalSyncResult | null>
  kbBuildStatusGet(): Promise<import('./kbBuildStatus').KbBuildStatus>
  /** 订阅构建进度广播（管理页进度条）。返回取消订阅函数。 */
  onKbBuildStatus(handler: (s: import('./kbBuildStatus').KbBuildStatus) => void): () => void

  /**
   * 扫描授权目录（下载 + 桌面）里的文档文件，返回元数据清单（mtime 降序、
   * main 侧截断）。知识库页「全部文件」的数据源；`{ force: true }` 绕过
   * main 的短 TTL 缓存（手动刷新）。永不 reject——扫描失败落在 result.error。
   */
  scanLocalDocs(payload?: LocalDocsScanPayload): Promise<LocalDocsScanResult>

  /** 读「全部文件」扫描目录全量清单（含停用的预设）。管理弹层数据源。 */
  getLocalDocsDirs(): Promise<LocalDocsDirsResult>

  /**
   * 设置某扫描目录是否启用（预设=开关、自定义 false=移除）。返回新清单；
   * 调用方随后应 force 重扫（清单变化即视图数据源变化）。
   */
  setLocalDocsDir(payload: LocalDocsDirSetPayload): Promise<LocalDocsDirsResult>

  /** 弹系统文件夹选择器添加自定义扫描目录（选中即授权）。取消 → added:null。 */
  pickLocalDocsDir(): Promise<LocalDocsDirsPickResult>

  /**
   * 读某域知识库索引与当前重建任务状态（domain 缺省 docs）。catalog 为
   * null = 索引还没建过/文件损坏——「文档/图片识别」页据此显示 CTA。
   */
  getKbCatalog(payload?: KbDomainPayload): Promise<{
    catalog: import('./kbCatalog').KbCatalog | null
    status: import('./kbCatalog').KbCatalogStatus
  }>

  /**
   * 触发某域「更新知识库」（后台 SDK 无头归类，全量重建该域索引）。
   * 立即返回；进度/结果订阅 onKbCatalogStatus（按 payload.domain 过滤）。
   */
  rebuildKbCatalog(payload?: KbDomainPayload): Promise<'started' | 'alreadyRunning'>

  /** 订阅重建任务状态推送（含 domain）。返回退订函数，镜像 onKbSyncStatus 模式。 */
  onKbCatalogStatus(handler: (payload: KbCatalogStatusPayload) => void): () => void

  /** 读某域当前生效的类别集合（缺省 = 该域出厂默认，末位恒「其他」）。 */
  getKbCategories(payload?: KbDomainPayload): Promise<KbCategoriesResult>

  /**
   * 分类管理操作（add/rename/remove/move，payload.domain 选域）。校验失败经
   * result.error 返回，永不 reject；rename/remove 会同步迁移该域索引存量条目。
   */
  updateKbCategories(payload: KbCategoriesUpdatePayload): Promise<KbCategoriesResult>

  /** 批量读图片缩略图（160px data URL）。读不出的路径在结果里缺席。 */
  getKbImageThumbs(payload: KbImageThumbsPayload): Promise<KbImageThumbsResult>

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
   * 导出 PDF（P2-2）。renderer 传入用 docx-preview 渲好的自包含 HTML，main 弹保存对话框、用隐藏
   * BrowserWindow + printToPDF 打成 A4 PDF 落盘。取消返回 `{ path: null }`。与 exportProposal 分流
   * 是因为 PDF 的产物来自 renderer 渲染（main 无 DOM），不能从 markdown 直接生成——见通道注释。
   */
  exportProposalPdf(payload: ProposalExportPdfPayload): Promise<ProposalExportPdfResult>
  /**
   * 与 exportProposalPdf 同引擎，但不弹保存框、不落盘——直接回 PDF 字节。预览标签用它拿到与
   * 导出逐字节一致的 PDF，塞进 <iframe> 显示，保证「预览分页 = 导出 PDF 分页」。渲染失败时
   * reject，渲染层显示错误态。
   */
  renderProposalPdf(payload: ProposalRenderPdfPayload): Promise<ProposalRenderPdfResult>
  /**
   * Render the proposal markdown to a .docx binary in-memory (no save
   * dialog, no disk write). The preview tab feeds the bytes to docx-preview
   * to paint paginated A4 that matches the exported Word exactly. Rejects
   * on render failure — the renderer shows an error state.
   */
  renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult>

  /**
   * 核对一节正文的引用是否真出自所引镜像原文。renderer 在每段正文生成后异步调用，
   * 拿结果给 ProposalPaper 标红/打覆盖度徽标。失败返回 degraded:true（UI 显示「未校验」）。
   */
  verifyProposalCitations(payload: ProposalVerifyPayload): Promise<ProposalVerifyResult>

  /**
   * 持久化草稿三件套。saveProposalDraft 写盘并跑 LRU；loadProposalDraft 不存在返回 null；
   * deleteProposalDraft 删除该会话草稿文件（「清空草稿」用）。失败一律返回 ok:false / null，
   * 绝不抛——持久化是「尽力而为」，不得阻塞会话切换。
   */
  saveProposalDraft(record: ProposalDraftRecord): Promise<ProposalSaveDraftResult>
  loadProposalDraft(payload: ProposalLoadDraftPayload): Promise<ProposalDraftRecord | null>
  deleteProposalDraft(payload: ProposalDeleteDraftPayload): Promise<ProposalDeleteDraftResult>

  /**
   * M-0 埋点：每次导出成功后 append 一条聚合记录（可交付率代理 + 引用准确度）到本地
   * jsonl。本地不外传，失败返回 ok:false（绝不抛）——埋点是旁路信号，不阻塞导出。
   */
  logProposalMetric(record: ProposalMetricRecord): Promise<ProposalMetricLogResult>

  /**
   * 读出图 API 设置。`apiKey` 已脱敏（`''` 未配置 / `'••••'` 已配置），未配置过 imageApi
   * 时返回 null（UI 显示「未配置」空态）。
   */
  proposalImageSettingsGet(): Promise<ProposalImageApiConfig | null>
  /**
   * 写出图 API 设置。传入脱敏占位符 `'••••'` 作为 apiKey 时 main 侧合并保留现存明文 key
   * （用户只改了 baseURL/model 的场景），不会被占位符覆盖。
   */
  proposalImageSettingsSet(cfg: ProposalImageApiConfig): Promise<void>
  /**
   * 文生图。main 读设置里的 imageApi 出图后落盘到该会话草稿资产目录，返回绝对路径。
   * 未配置 apiKey 时 reject 一条中文错误，UI 提示去设置页填写。
   */
  proposalImageGenerate(args: ProposalImageGeneratePayload): Promise<ProposalImageResult>
  /**
   * 改图。main 读 `sourcePath` 的字节喂给出图 service，出图后落盘（来源标记为
   * edited），返回绝对路径。同 generate，缺 apiKey 时 reject 中文错误。
   */
  proposalImageEdit(args: ProposalImageEditPayload): Promise<ProposalImageResult>
  /**
   * 上传本地图。main 弹原生文件选择框（限 png/jpg/jpeg/gif/webp，单选），用户取消返回
   * null；选中后落盘到该会话草稿资产目录（来源标记为 uploaded），返回绝对路径。不调出图
   * API，不受 apiKey 是否配置影响。
   */
  proposalImageUpload(args: ProposalImageUploadPayload): Promise<ProposalImageResult | null>
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

  /**
   * One-shot pull of the ACTIVE chat tab's session list. main reads the
   * active chat tab's workspace and scans it off disk — the shell has no
   * engine of its own, so this bypasses the per-tab resolveEngine path.
   * Resolves `{ threads: [] }` when no chat tab is active.
   */
  listShellSessions(): Promise<SessionListResult>
  /**
   * Ask main to switch the active chat tab to `sessionId` (or to a fresh
   * chat when `sessionId` is null). main forwards it to the active chat
   * tab's renderer, which runs its existing switch flow so all chat-store
   * sync happens there. Fire-and-forget.
   */
  switchShellSession(sessionId: string | null): Promise<void>
  /**
   * Subscribe to "active chat tab's session list changed" so the shell can
   * re-pull via listShellSessions. Returns an unsubscribe.
   */
  onShellSessionListChanged(handler: () => void): () => void

  /**
   * Rename a session of the active chat tab's workspace. Engine-free path
   * (mirrors listShellSessions): main appends the custom-title line and the
   * engine's sessionListChanged fan-out refreshes both the shell list and
   * the chat sidebar. Rejects when no chat tab is active.
   */
  renameShellSession(payload: SessionRenamePayload): Promise<void>
  /**
   * Delete a session of the active chat tab's workspace — closes any live
   * runtime for that id, then removes its jsonl + subagent dir from disk.
   * IRREVERSIBLE; the caller owns the confirm UI. Rejects when no chat tab
   * is active or the session doesn't exist on disk.
   */
  deleteShellSession(payload: SessionDeletePayload): Promise<void>
}

/**
 * Runtime-log bridge for the「日志分析」settings section, exposed by the
 * preload as `window.desktopLogs`. This replaces the log half of the dead
 * settings-overlay preload's `electronSettings` — deliberately under a NEW
 * global name: App.tsx still uses the ABSENCE of `window.electronSettings`
 * to detect the unified-studio mode (settings-as-URL-state close behaviour),
 * so resurrecting that name would silently flip it back into overlay mode.
 */
export interface DesktopLogsApi {
  /** Ring-buffer snapshot for the panel's initial fill (invoke LOGS_GET). */
  getLogs(): Promise<RuntimeLogEntry[]>
  /** Clear the in-memory ring + on-disk log files (invoke LOGS_CLEAR). */
  clearLogs(): Promise<void>
  /** Reveal the persisted log file in the OS file manager (invoke LOGS_REVEAL). */
  revealLogFile(): Promise<void>
  /**
   * Subscribe to live log lines. The preload refcounts subscribers within
   * this webContents and drives LOGS_SUBSCRIBE / LOGS_UNSUBSCRIBE on the
   * 0↔1 edges, so main only streams while at least one panel is mounted.
   * Returns an unsubscribe fn (idempotent).
   */
  onLog(handler: (entry: RuntimeLogEntry) => void): () => void
}
