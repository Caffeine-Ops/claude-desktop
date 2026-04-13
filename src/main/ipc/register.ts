import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type {
  ChatEvent,
  LogEvent,
  PermissionRequest,
  PermissionResponse
} from '../../shared/types'
import {
  IPC_CHANNELS,
  type ChatAbortPayload,
  type ChatEventPayload,
  type ChatImagePayload,
  type ChatSendPayload,
  type ChatSendResult,
  type FileSuggestionsListPayload,
  type FileSuggestionsListResult,
  type LogEventPayload,
  type SessionListResult,
  type SessionLoadPayload,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionRenamePayload,
  type SessionRenameResult,
  type SessionSwitchPayload,
  type SessionSwitchResult,
  type WorkspaceFileOpenPayload,
  type WorkspaceFileOpenResult,
  type WorkspacePickResult,
  type WorkspaceSetPayload,
  type WorkspaceState
} from '../../shared/ipc-channels'
import { getChatEngine } from '../core/engine'
import { listFileSuggestions } from '../core/fileSuggestions'
import { getPermissionBroker } from '../core/permissionBroker'
import { listSessions, loadSession, renameSession } from '../core/sessionStore'
import { updateTrayLang } from '../tray'
import type { LangChangedPayload } from '../../shared/ipc-channels'

/**
 * Registers all IPC handlers and wires the chat engine's event stream to
 * the renderer. Call once at app startup with the main window.
 *
 * IMPORTANT: keep the surface here minimal. Each exposed procedure is a
 * potential attack surface — validate every input.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Remove any stale handlers from previous dev reloads to avoid
  // "Attempted to register a second handler" errors.
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND)
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_ABORT)
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_RESPOND)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_META_GET)
  ipcMain.removeHandler(IPC_CHANNELS.FILE_SUGGESTIONS_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GET)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_PICK)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_FILE_OPEN)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_NEW)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SWITCH)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_RENAME)
  ipcMain.removeHandler(IPC_CHANNELS.APP_RELAUNCH)
  ipcMain.removeHandler(IPC_CHANNELS.APP_OPEN_CLAUDE_DIR)
  // LANG_CHANGED is a fire-and-forget `send` (not invoke), so cleanup
  // is via removeAllListeners rather than removeHandler. Important on
  // dev HMR reloads where this function runs more than once per
  // process lifetime — without it, each reload would stack another
  // listener and the tray menu would rebuild N times per language flip.
  ipcMain.removeAllListeners(IPC_CHANNELS.LANG_CHANGED)
  ipcMain.on(
    IPC_CHANNELS.LANG_CHANGED,
    (_event, payload: LangChangedPayload) => {
      const lang = payload?.lang
      if (lang !== 'zh' && lang !== 'en') return
      updateTrayLang(lang)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND,
    async (_event, payload: ChatSendPayload): Promise<ChatSendResult> => {
      validateSessionId(payload?.sessionId)
      validateText(payload?.text)
      const images = validateImages(payload?.images)
      const engine = getChatEngine()
      return await engine.send(payload.sessionId, payload.text, images)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_ABORT,
    async (_event, payload: ChatAbortPayload): Promise<void> => {
      validateSessionId(payload?.sessionId)
      getChatEngine().abort(payload.sessionId)
    }
  )

  // Permission responses from the renderer. PermissionBroker validates
  // the requestId (unknown ids are silently dropped and logged), so
  // here we only shape-check the payload surface.
  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RESPOND,
    async (_event, payload: PermissionResponse): Promise<void> => {
      validatePermissionResponse(payload)
      getPermissionBroker().respond(payload)
    }
  )

  // Session metadata pull. Backed by ChatEngine.sessionMeta which is
  // populated lazily from the first `system init` SDK message.
  // Returns empty arrays before fusion-code has been spawned.
  ipcMain.handle(IPC_CHANNELS.SESSION_META_GET, async () => {
    return getChatEngine().getSessionMeta()
  })

  // File suggestions list for the composer's `@`-mention popover. We
  // scan the session's working directory (the same cwd fusion-code is
  // spawned in) via git ls-files with a readdir fallback, cached in
  // main for 5 seconds so repeated mounts don't re-scan the tree.
  //
  // The renderer does synchronous fuzzy filtering on the returned list
  // because @assistant-ui/core's trigger adapter requires a sync
  // `search()` function — async data must be loaded into state first.
  ipcMain.handle(
    IPC_CHANNELS.FILE_SUGGESTIONS_LIST,
    async (
      _event,
      payload: FileSuggestionsListPayload
    ): Promise<FileSuggestionsListResult> => {
      // Resolve the cwd to scan in priority order:
      //   1. sessionMeta.cwd — captured from fusion-code's `system init`
      //      message, matches what the CLI will actually resolve `@path`
      //      against (respects `--worktree` mid-session chdirs).
      //   2. engine.getWorkspace() — the user-picked workspace, which is
      //      also what openSession() hands the SDK; the two are equal
      //      in the common path but sessionMeta lags by one round-trip.
      //   3. process.cwd() — last-ditch fallback, only hit when the
      //      renderer somehow fires this IPC before the workspace is
      //      set (the gate is supposed to prevent that).
      const engine = getChatEngine()
      const meta = engine.getSessionMeta()
      const cwd =
        meta.cwd && meta.cwd.length > 0
          ? meta.cwd
          : (engine.getWorkspace() ?? process.cwd())
      return await listFileSuggestions(cwd, payload?.force === true)
    }
  )

  // Workspace state. Reader is trivial; the setter re-validates the
  // path, then persists it on the engine. Both channels wrap the path
  // in the `WorkspaceState` shape so the renderer can treat them as
  // a single source of truth without a second round-trip.
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GET,
    async (): Promise<WorkspaceState> => {
      return { path: getChatEngine().getWorkspace() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SET,
    async (_event, payload: WorkspaceSetPayload): Promise<WorkspaceState> => {
      validateWorkspaceSetPayload(payload)
      const next = await getChatEngine().setWorkspace(payload.path)
      return { path: next }
    }
  )

  // Native folder picker. Anchored to the main window so the dialog
  // is treated as modal and inherits focus correctly on macOS. We
  // intentionally do NOT call setWorkspace here — the renderer follows
  // up with WORKSPACE_SET so any validation error surfaces in the gate
  // UI through the same code path the drag-drop flow uses.
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_PICK,
    async (): Promise<WorkspacePickResult> => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Pick a workspace',
        properties: ['openDirectory', 'createDirectory'],
        // Default to the current workspace when re-picking, otherwise
        // let the OS decide (Finder remembers per-app).
        defaultPath: getChatEngine().getWorkspace() ?? undefined
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null }
      }
      return { path: result.filePaths[0] }
    }
  )

  // Open a workspace-relative file in the OS default handler. The
  // renderer passes `relPath` because it doesn't have access to the
  // workspace root (and shouldn't — we want a single source of truth).
  // Main joins, re-validates, and delegates to Electron's `shell.openPath`,
  // which in turn asks the OS to hand the file to whichever app is
  // registered for that extension (Finder "Open With Default Application"
  // equivalent on macOS).
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_FILE_OPEN,
    async (
      _event,
      payload: WorkspaceFileOpenPayload
    ): Promise<WorkspaceFileOpenResult> => {
      validateFileOpenPayload(payload)
      const workspace = getChatEngine().getWorkspace()
      if (!workspace) {
        return { error: 'Workspace not set.' }
      }

      const absolute = join(workspace, payload.relPath)

      // Defense-in-depth path traversal check. `validateFileOpenPayload`
      // already rejects `..` segments and absolute inputs, but a
      // symlink or `..` smuggled through Unicode normalization could
      // still escape. `path.relative` gives us the canonical offset
      // from workspace → target; if it starts with `..` or is absolute
      // (on Windows where relative() may return a drive-qualified
      // path), we've walked out.
      const rel = relative(workspace, absolute)
      if (
        rel.length === 0 ||
        rel.startsWith('..') ||
        rel === '..' ||
        isAbsolute(rel) ||
        rel.split(sep).includes('..')
      ) {
        return { error: 'Path escapes workspace.' }
      }

      let stat
      try {
        stat = statSync(absolute)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: `File not found: ${msg}` }
      }
      if (!stat.isFile()) {
        return { error: 'Not a file.' }
      }

      // `shell.openPath` resolves to "" on success, non-empty on
      // failure. Its failure modes include "no handler for mime" and
      // "permission denied" — we surface them verbatim so the user
      // can see what went wrong.
      const shellError = await shell.openPath(absolute)
      if (shellError) {
        return { error: shellError }
      }
      return { error: '' }
    }
  )

  // Session list / load / new / switch. All guarded by the workspace
  // gate — listSessions() returns [] when workspace is null, and the
  // switch handler defers to engine.switchToSession() which throws if
  // the workspace is unset.
  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST,
    async (): Promise<SessionListResult> => {
      const workspace = getChatEngine().getWorkspace()
      const threads = await listSessions(workspace)
      return { threads }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_LOAD,
    async (_event, payload: SessionLoadPayload): Promise<SessionLoadResult> => {
      validateSessionLoadPayload(payload)
      const workspace = getChatEngine().getWorkspace()
      const messages = await loadSession(payload.sessionId, workspace)
      return { messages }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_NEW,
    async (): Promise<SessionNewResult> => {
      // Mint a fresh UUID but do NOT spawn the CLI yet — the renderer
      // follows up with SESSION_SWITCH so the spawn happens only once
      // and at a known point in the flow.
      return { sessionId: randomUUID() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_SWITCH,
    async (
      _event,
      payload: SessionSwitchPayload
    ): Promise<SessionSwitchResult> => {
      validateSessionSwitchPayload(payload)
      // `engine.switchToSession` returns the real session id the cli
      // ended up using, which may differ from payload.sessionId when
      // fusion-code silently forks on `--resume` (upstream
      // claude-code behavior). The renderer uses this id to
      // re-subscribe chat events under the correct key.
      const result = await getChatEngine().switchToSession(payload.sessionId, {
        resume: payload.resume
      })
      return { sessionId: result.sessionId }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_RENAME,
    async (
      _event,
      payload: SessionRenamePayload
    ): Promise<SessionRenameResult> => {
      validateSessionRenamePayload(payload)
      const engine = getChatEngine()
      await renameSession(payload.sessionId, payload.title, engine.getWorkspace())
      // Trigger sidebar refresh — the SDK reads customTitle on its
      // next listSessions scan, so rebroadcasting picks up the new
      // value without any in-memory state to invalidate.
      engine.emit('sessionListChanged')
      return { ok: true }
    }
  )

  // Relaunch the app. Used by the workspace switcher — swapping
  // workspaces means restarting so the fusion-code child respawns
  // with the new cwd and the gate reappears cold.
  ipcMain.handle(IPC_CHANNELS.APP_RELAUNCH, async (): Promise<void> => {
    app.relaunch()
    app.exit(0)
  })

  // Open `~/.claude` in the OS file manager. The directory is created
  // by fusion-code on first run, but on a fresh machine it may not
  // exist yet — `shell.openPath` returns "no such file" in that case,
  // which we surface verbatim so the user knows to run Claude once.
  ipcMain.handle(
    IPC_CHANNELS.APP_OPEN_CLAUDE_DIR,
    async (): Promise<{ error: string }> => {
      const target = join(homedir(), '.claude')
      const shellError = await shell.openPath(target)
      return { error: shellError }
    }
  )

  // Bridge engine events → renderer.
  const engine = getChatEngine()
  engine.on('chat', (sessionId: string, event: ChatEvent) => {
    if (mainWindow.isDestroyed()) return
    const eventPayload: ChatEventPayload = { sessionId, event }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, eventPayload)
  })

  // Bridge session-list-changed → renderer. Engine emits this from
  // switchToSession() and from updateSessionMeta() (first system init
  // of a brand-new session, which is when the jsonl is created).
  // removeAllListeners guards against double registration on dev reload.
  engine.removeAllListeners('sessionListChanged')
  engine.on('sessionListChanged', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC_CHANNELS.SESSION_LIST_CHANGED)
  })

  // Bridge session-meta-changed → renderer. Fires from
  // updateSessionMeta() on every fusion-code `system init`, which is
  // when skills / mcp_servers / slash_commands finally populate. The
  // renderer's Composer re-polls getSessionMeta() on receipt so the
  // `/` popover reflects the full cli command set instead of waiting
  // for the first turn to end.
  engine.removeAllListeners('sessionMetaChanged')
  engine.on('sessionMetaChanged', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC_CHANNELS.SESSION_META_CHANGED)
  })

  // Bridge log events → renderer. Each call is one instrumentation
  // breadcrumb (switchToSession:begin, systemInit:received,
  // turn:firstChunk, etc). The LogsDialog subscribes via
  // window.chatApi.onLogEvent and renders them on a timeline so the
  // user can see where first-turn latency is spent.
  engine.removeAllListeners('log')
  engine.on('log', (event: LogEvent) => {
    if (mainWindow.isDestroyed()) return
    const payload: LogEventPayload = { event }
    mainWindow.webContents.send(IPC_CHANNELS.LOG_EVENT, payload)
  })

  // Bridge permission requests → renderer. The broker emits one
  // `request` event per pending canUseTool call; we forward it to the
  // active BrowserWindow's webContents so PermissionDialog can pick it
  // up via the preload channel. removeAllListeners guards against
  // duplicate registrations on dev reload.
  const broker = getPermissionBroker()
  broker.removeAllListeners('request')
  broker.on('request', (request: PermissionRequest) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC_CHANNELS.PERMISSION_REQUEST, request)
  })

  // When the window is closed (quit, not just hidden), reject every
  // outstanding permission request so the SDK stops waiting on a
  // dialog that can never answer.
  mainWindow.once('closed', () => {
    broker.cancelAll('Main window closed.')
  })
}

function validateSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`Invalid sessionId`)
  }
}

function validateText(value: unknown): asserts value is string {
  // Images may travel with an empty text body (e.g. user pastes a
  // screenshot and hits Enter with no caption). Accept empty strings
  // here; validateImages decides whether at least one of text/images
  // is actually present.
  if (typeof value !== 'string' || value.length > 100_000) {
    throw new Error(`Invalid text (must be ≤ 100000 chars)`)
  }
}

/**
 * Shape-check the optional `images` array carried on a CHAT_SEND.
 *
 * Each entry must be `{ dataUrl: "data:image/<subtype>;base64,...", filename? }`.
 * We enforce:
 *  - array limit (5 images) — matches what the composer UI shows
 *  - data URL prefix must match an API-accepted media type
 *  - raw base64 body length ≤ 7.5MB (≈5.6MB binary, comfortably over the
 *    ~3.75MB budget we clamp to in the renderer, but below Electron's
 *    IPC structured clone size limits)
 *
 * Returns the validated array (or undefined when the caller sent none).
 * Throws with a user-visible message if any entry fails — the error
 * propagates back to the renderer's chatApi.send promise.
 */
const ACCEPTED_IMAGE_DATAURL_PREFIX =
  /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/
const MAX_IMAGES_PER_TURN = 5
const MAX_DATAURL_BYTES = 7.5 * 1024 * 1024

function validateImages(
  value: unknown
): readonly ChatImagePayload[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) {
    throw new Error('Invalid images payload (expected array)')
  }
  if (value.length === 0) return undefined
  if (value.length > MAX_IMAGES_PER_TURN) {
    throw new Error(`Too many images (max ${MAX_IMAGES_PER_TURN} per turn)`)
  }
  const out: ChatImagePayload[] = []
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Invalid image at index ${i}`)
    }
    const rec = entry as Record<string, unknown>
    const dataUrl = rec.dataUrl
    if (typeof dataUrl !== 'string') {
      throw new Error(`Invalid image dataUrl at index ${i}`)
    }
    if (dataUrl.length > MAX_DATAURL_BYTES) {
      throw new Error(`Image ${i} is too large (>${MAX_DATAURL_BYTES} bytes)`)
    }
    if (!ACCEPTED_IMAGE_DATAURL_PREFIX.test(dataUrl)) {
      throw new Error(
        `Image ${i} has an unsupported media type (expected image/png|jpeg|gif|webp)`
      )
    }
    const filename = rec.filename
    if (filename !== undefined && typeof filename !== 'string') {
      throw new Error(`Invalid image filename at index ${i}`)
    }
    out.push({ dataUrl, filename: typeof filename === 'string' ? filename : undefined })
  }
  return out
}

/**
 * Shape-check a WORKSPACE_SET payload before it reaches the engine.
 *
 * The engine already re-validates (absolute path + exists + isDirectory)
 * with proper error messages, so this is just a first pass that rejects
 * obvious garbage before a filesystem syscall. We also cap the length —
 * real paths are never anywhere near 4096 chars, and anything bigger is
 * either a bug or an exploit attempt trying to burn memory on statSync.
 */
function validateWorkspaceSetPayload(
  value: unknown
): asserts value is WorkspaceSetPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid workspace payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.path !== 'string' || v.path.length === 0) {
    throw new Error('Invalid workspace path (empty or missing)')
  }
  if (v.path.length > 4096) {
    throw new Error(`Workspace path too long (${v.path.length} chars)`)
  }
}

/**
 * Shape-check a WORKSPACE_FILE_OPEN payload.
 *
 * The heavyweight validation (filesystem existence, workspace-relative
 * containment, symlink escape) lives in the handler — this only rejects
 * obvious garbage so we fail fast before even computing `join(workspace,
 * relPath)`.
 *
 * Rules:
 *  - must be a non-empty string, ≤ 4096 chars
 *  - must NOT be an absolute path (renderer has no business knowing
 *    the workspace root; the handler computes it)
 *  - must NOT contain `..` path segments (first-line traversal guard;
 *    the handler does a second pass via path.relative for symlinks etc.)
 */
function validateFileOpenPayload(
  value: unknown
): asserts value is WorkspaceFileOpenPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid file-open payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.relPath !== 'string' || v.relPath.length === 0) {
    throw new Error('Invalid relPath (empty or missing)')
  }
  if (v.relPath.length > 4096) {
    throw new Error(`relPath too long (${v.relPath.length} chars)`)
  }
  if (isAbsolute(v.relPath)) {
    throw new Error('relPath must be workspace-relative, not absolute')
  }
  // Normalize separators so both `..\foo` and `../foo` get rejected on
  // every platform. The split covers the common traversal pattern;
  // path.relative() in the handler catches the exotic cases.
  const segments = v.relPath.split(/[\\/]+/)
  if (segments.some((s) => s === '..')) {
    throw new Error('relPath contains parent-directory segments')
  }
}

function validateSessionLoadPayload(
  value: unknown
): asserts value is SessionLoadPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid session-load payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) {
    throw new Error('Invalid session-load sessionId (empty or missing)')
  }
  if (v.sessionId.length > 128) {
    throw new Error('Invalid session-load sessionId (too long)')
  }
}

function validateSessionSwitchPayload(
  value: unknown
): asserts value is SessionSwitchPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid session-switch payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) {
    throw new Error('Invalid session-switch sessionId (empty or missing)')
  }
  if (v.sessionId.length > 128) {
    throw new Error('Invalid session-switch sessionId (too long)')
  }
  if (typeof v.resume !== 'boolean') {
    throw new Error('Invalid session-switch resume (must be boolean)')
  }
}

function validateSessionRenamePayload(
  value: unknown
): asserts value is SessionRenamePayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid session-rename payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) {
    throw new Error('Invalid session-rename sessionId (empty or missing)')
  }
  if (v.sessionId.length > 128) {
    throw new Error('Invalid session-rename sessionId (too long)')
  }
  // Title cap: 200 chars matches the SDK's PROJECT_NAME_MAX_LEN and
  // gives the sidebar plenty of room without letting a paste-bomb
  // bloat the jsonl. Newlines would split the appended jsonl line, so
  // strip them up front rather than reject (less hostile UX).
  if (typeof v.title !== 'string') {
    throw new Error('Invalid session-rename title (must be string)')
  }
  const trimmed = v.title.replace(/[\r\n]+/g, ' ').trim()
  if (trimmed.length === 0) {
    throw new Error('Invalid session-rename title (empty)')
  }
  if (trimmed.length > 200) {
    throw new Error('Invalid session-rename title (too long)')
  }
  ;(v as { title: string }).title = trimmed
}

function validatePermissionResponse(
  value: unknown
): asserts value is PermissionResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid permission response')
  }
  const v = value as Record<string, unknown>
  if (typeof v.requestId !== 'string' || v.requestId.length === 0) {
    throw new Error('Invalid permission response: requestId')
  }
  if (
    v.decision !== 'allow-once' &&
    v.decision !== 'allow-session' &&
    v.decision !== 'deny'
  ) {
    throw new Error(`Invalid permission decision: ${String(v.decision)}`)
  }
  // updatedInput is optional. When present it must be a plain object
  // (so the engine-side mergeUpdatedInput can spread it over the
  // original input). Arrays / primitives / null are rejected — those
  // would corrupt the input shape when merged.
  if (v.updatedInput !== undefined) {
    if (
      typeof v.updatedInput !== 'object' ||
      v.updatedInput === null ||
      Array.isArray(v.updatedInput)
    ) {
      throw new Error('Invalid permission response: updatedInput must be an object')
    }
  }
}
