import { app, BrowserWindow, dialog, ipcMain, net, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { PermissionResponse } from '../../shared/types'
import {
  IPC_CHANNELS,
  type ChatAbortPayload,
  type ChatImagePayload,
  type ChatSendPayload,
  type ChatSendResult,
  type FileSuggestionsListPayload,
  type FileSuggestionsListResult,
  type SessionCloseRuntimePayload,
  type SessionCloseRuntimeResult,
  type SessionListActiveRuntimesResult,
  type SessionListResult,
  type SessionLoadPayload,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionRenamePayload,
  type SessionRenameResult,
  type SessionSwitchPayload,
  type SessionSwitchResult,
  type TabClosePayload,
  type TabListResult,
  type TabSwitchPayload,
  type TranscribeAudioPayload,
  type TranscribeAudioResult,
  type WorkspaceFileOpenPayload,
  type WorkspaceFileOpenResult,
  type ShellOpenPathPayload,
  type ShellOpenPathResult,
  type ShellStatFilesPayload,
  type ShellStatFilesResult,
  type WorkspacePickResult,
  type WorkspaceSetPayload,
  type WorkspaceState,
  type AppearanceGetResult,
  type AppearanceSetPayload,
  type AppearanceSetResult,
  type AppearancePrefs,
  type ShellMenuActionPayload
} from '../../shared/ipc-channels'
import { getAppSettings, updateAppSettings } from '../core/appSettings'
import { detectSystemClaude, resolveBundledCliPath } from '../core/cliDetect'
import { DAEMON_PORT } from '../services/openDesignServices'
import type { ChatEngine } from '../core/engine'
import { listFileSuggestions } from '../core/fileSuggestions'
import { listSessions, loadSession, renameSession } from '../core/sessionStore'
import { clearUnread, updateTrayLang } from '../tray'
import {
  broadcastAppearanceChanged,
  broadcastTabList,
  canAddTab,
  closeTab,
  closeSettingsView,
  describeSenderMismatch,
  dispatchMenuActionToActiveTab,
  getAllTabs,
  getContextForSender,
  getShellFullscreen,
  getShellWindow,
  listTabs,
  MAX_TABS,
  newTab,
  openSettingsView,
  activateTab
} from '../tabRegistry'
import type {
  CliBackendSetPayload,
  CliBackendState,
  LangChangedPayload,
  PermissionModeGetResult,
  PermissionModeSetPayload,
  RuntimeLogEntry,
  UiPermissionMode
} from '../../shared/ipc-channels'
import { clearLogs, getLogs } from '../core/logCollector'
import { getKbRoot, setKbRoot, readKbIndex, kbOutDir } from '../core/kbIndexStore'
import type { KbIndex } from '../../shared/kbIndex'
import { exportProposal, isProposalExportFormat } from '../core/proposalExport'
import { markdownToDocxBuffer } from '../core/proposalDocx'
import { verifyCitations } from '../core/proposalVerify'
import {
  saveProposalDraft,
  loadProposalDraft,
  deleteProposalDraft
} from '../core/proposalDraftStore'
import { appendProposalMetric } from '../core/proposalMetricsStore'
import type {
  ProposalExportPayload,
  ProposalExportResult,
  ProposalRenderPayload,
  ProposalRenderResult,
  ProposalVerifyPayload,
  ProposalVerifyResult,
  ProposalDraftRecord,
  ProposalLoadDraftPayload,
  ProposalDeleteDraftPayload,
  ProposalSaveDraftResult,
  ProposalDeleteDraftResult,
  ProposalMetricLogResult
} from '../../shared/ipc-channels'
import type { ProposalMetricRecord } from '../../shared/proposal'

/**
 * Resolve the ChatEngine for the window that sent this IPC event.
 * Every chat/session/workspace handler routes through this so the
 * right per-window engine handles the request — a `send` from window
 * A can never touch window B's session map.
 *
 * Throws when the sender isn't a registered workspace window
 * (shouldn't happen with our preload gate, but a clean error beats a
 * silent wrong-window write if it does).
 */
function resolveEngine(event: IpcMainInvokeEvent): ChatEngine {
  const ctx = getContextForSender(event)
  if (!ctx) {
    throw new Error(`IPC received from an unknown tab (${describeSenderMismatch(event)}).`)
  }
  // web tab（Open Design web UI）没有 ChatEngine —— 它加载外部 origin，不挂
  // chatApi preload，本不该调用任何需要 engine 的 IPC。若真有调用到达（异常路径），
  // 抛明确错误而不是让 null 流下去崩在更深处。
  if (!ctx.engine) {
    throw new Error(
      `IPC requiring a ChatEngine arrived from a web tab (id=${event.sender.id}), which has none.`
    )
  }
  return ctx.engine
}

/**
 * Recycle every open tab's live runtimes so the next turn re-spawns
 * under the freshly-saved `cliBackend`. Shared by BOTH backend-set
 * paths:
 *
 *   - CLI_BACKEND_SET (engine-bound, fired from a tab's own settings),
 *   - SETTINGS_CLI_BACKEND_SET (engine-free overlay path).
 *
 * The overlay path has no engine reference at all, and even the
 * engine-bound path only knows the SENDER's engine — but a backend flip
 * is a global app setting, so EVERY tab's engine must recycle, not just
 * the one that happened to send the IPC. We iterate all tabs (web tabs
 * have no engine → skipped) and let each engine decide which of its
 * runtimes are safe to recycle (in-flight turns are preserved inside
 * restartRuntimesForBackendChange). Best-effort: one engine throwing
 * must not block the rest, and the setting is already persisted, so a
 * failed recycle just degrades to the old "restart to apply" behavior
 * for that one tab rather than losing the change.
 */
async function recycleAllEnginesForBackendChange(): Promise<void> {
  const engines = getAllTabs()
    .map((ctx) => ctx.engine)
    .filter((e): e is ChatEngine => e !== null)
  await Promise.all(
    engines.map((eng) =>
      eng.restartRuntimesForBackendChange().catch((err) => {
        console.warn('[cli-backend] runtime recycle failed for a tab:', err)
        return 0
      })
    )
  )
}

function resolveBrowserWindow(event: IpcMainInvokeEvent): BrowserWindow {
  // Native dialogs need a BrowserWindow reference — the folder
  // picker is modal to the shell window. WebContentsView senders
  // don't have a direct `BrowserWindow.fromWebContents` mapping
  // because the views are child content, not top-level windows, so
  // we fall back to `BrowserWindow.fromWebContents(event.sender)`
  // and return the first result (it's the shell).
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (parent) return parent
  // Fallback: any focused window. This only triggers for the shell
  // webContents itself, which does produce a BrowserWindow from
  // fromWebContents, so in practice we never hit this branch.
  const all = BrowserWindow.getAllWindows()
  if (all.length > 0) return all[0]!
  throw new Error('No window available for dialog anchoring.')
}

/**
 * Registers all IPC handlers. Call once at app startup — handlers use
 * `event.sender` to resolve the target ChatEngine from the window
 * registry on every invoke, so this function is window-agnostic and
 * doesn't need to be re-run when a new workspace window opens.
 *
 * Engine-to-renderer event forwarding (chat events, log events,
 * session list changes, permission requests) is wired inside the
 * ChatEngine constructor, not here — each engine bridges its own
 * events to its own bound window's webContents.
 *
 * IMPORTANT: keep the surface here minimal. Each exposed procedure is a
 * potential attack surface — validate every input.
 */
export function registerIpcHandlers(): void {
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
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_OPEN_PATH)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_STAT_FILES)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_NEW)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SWITCH)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_RENAME)
  ipcMain.removeHandler(IPC_CHANNELS.APP_RELAUNCH)
  ipcMain.removeHandler(IPC_CHANNELS.TAB_NEW)
  ipcMain.removeHandler(IPC_CHANNELS.TAB_SWITCH)
  ipcMain.removeHandler(IPC_CHANNELS.TAB_CLOSE)
  ipcMain.removeHandler(IPC_CHANNELS.TAB_LIST_GET)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_FULLSCREEN_GET)
  ipcMain.removeHandler(IPC_CHANNELS.APP_OPEN_CLAUDE_DIR)
  ipcMain.removeHandler(IPC_CHANNELS.CLI_BACKEND_GET)
  ipcMain.removeHandler(IPC_CHANNELS.CLI_BACKEND_SET)
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_MODE_GET)
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_MODE_SET)
  ipcMain.removeHandler(IPC_CHANNELS.APPEARANCE_GET)
  ipcMain.removeHandler(IPC_CHANNELS.APPEARANCE_SET)
  ipcMain.removeHandler(IPC_CHANNELS.APPEARANCE_BROADCAST)
  ipcMain.removeHandler(IPC_CHANNELS.TAB_TRIGGER_MENU_ACTION)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_WINDOW_OPEN)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_CLI_BACKEND_GET)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_CLI_BACKEND_SET)
  ipcMain.removeHandler(IPC_CHANNELS.LOGS_GET)
  ipcMain.removeHandler(IPC_CHANNELS.LOGS_CLEAR)
  ipcMain.removeHandler(IPC_CHANNELS.KB_PATH_GET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_PATH_SET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_INDEX_READ)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_EXPORT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_RENDER)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_SAVE_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_LOAD_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_DELETE_DRAFT)
  // VERIFY 此前漏登记清理——dev HMR 重跑本函数时会因 handler 已存在而 throw「second handler」。补上。
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_VERIFY)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_METRIC_LOG)
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
    async (event, payload: ChatSendPayload): Promise<ChatSendResult> => {
      validateSessionId(payload?.sessionId)
      validateText(payload?.text)
      const images = validateImages(payload?.images)
      const engine = resolveEngine(event)
      // proposalMode is a plain boolean flag; coerce defensively so a
      // malformed renderer payload can't smuggle a non-bool through.
      return await engine.send(
        payload.sessionId,
        payload.text,
        images,
        payload?.proposalMode === true,
        // 防御：只接受数组形状，过滤畸形 renderer payload。
        Array.isArray(payload?.proposalProducts) ? payload.proposalProducts : undefined,
        // 内容级召回开关（#2）：仅正文回合为真，engine 据此对镜像原文做关键词召回注入。
        payload?.proposalRetrieve === true
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_ABORT,
    async (event, payload: ChatAbortPayload): Promise<void> => {
      validateSessionId(payload?.sessionId)
      resolveEngine(event).abort(payload.sessionId)
    }
  )

  // Permission responses from the renderer. PermissionBroker validates
  // the requestId (unknown ids are silently dropped and logged), so
  // here we only shape-check the payload surface.
  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RESPOND,
    async (event, payload: PermissionResponse): Promise<void> => {
      validatePermissionResponse(payload)
      resolveEngine(event).permissionBroker.respond(payload)
      // The user has clearly noticed the dialog (they just answered
      // it), so the unread badge has done its job — clear it even if
      // the window is somehow still in the background.
      clearUnread()
    }
  )

  // Session metadata pull. Backed by ChatEngine.sessionMeta which is
  // populated lazily from the first `system init` SDK message.
  // Returns empty arrays before fusion-code has been spawned.
  ipcMain.handle(IPC_CHANNELS.SESSION_META_GET, async (event) => {
    return resolveEngine(event).getSessionMeta()
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
      event,
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
      const engine = resolveEngine(event)
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
    async (event): Promise<WorkspaceState> => {
      return { path: resolveEngine(event).getWorkspace() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_SET,
    async (event, payload: WorkspaceSetPayload): Promise<WorkspaceState> => {
      validateWorkspaceSetPayload(payload)
      const next = await resolveEngine(event).setWorkspace(payload.path)
      // Refresh the shell's tab strip so the title pill picks up the
      // new folder's basename immediately. Without this, the tab keeps
      // showing "New Workspace" until some unrelated event (tab click,
      // did-finish-load) re-triggers a broadcast.
      broadcastTabList()
      return { path: next }
    }
  )

  // Native folder picker. Anchored to the sender window so the dialog
  // is treated as modal to that window and inherits focus correctly on
  // macOS. We intentionally do NOT call setWorkspace here — the
  // renderer follows up with WORKSPACE_SET so any validation error
  // surfaces in the gate UI through the same code path the drag-drop
  // flow uses.
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_PICK,
    async (event): Promise<WorkspacePickResult> => {
      const window = resolveBrowserWindow(event)
      const engine = resolveEngine(event)
      const result = await dialog.showOpenDialog(window, {
        title: 'Pick a workspace',
        properties: ['openDirectory', 'createDirectory'],
        // Default to the current workspace when re-picking, otherwise
        // let the OS decide (Finder remembers per-app).
        defaultPath: engine.getWorkspace() ?? undefined
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
      event,
      payload: WorkspaceFileOpenPayload
    ): Promise<WorkspaceFileOpenResult> => {
      validateFileOpenPayload(payload)
      const workspace = resolveEngine(event).getWorkspace()
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

  // Open an ABSOLUTE path in the OS default handler. Targets files the
  // assistant just wrote (Write/Edit tool calls), which routinely live
  // outside the workspace (Desktop, /tmp, …) — so unlike
  // WORKSPACE_FILE_OPEN we accept the absolute path directly. We still
  // gate on: must be absolute (no relative smuggling), must exist, must
  // be a regular file (not a dir/socket). We deliberately do NOT confine
  // it to the workspace — the whole point is opening files elsewhere —
  // but `shell.openPath` only ever hands the file to its registered app;
  // it never executes it, so an absolute path here can't run code.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_PATH,
    async (
      _event,
      payload: ShellOpenPathPayload
    ): Promise<ShellOpenPathResult> => {
      const absPath =
        payload && typeof payload.absPath === 'string' ? payload.absPath : ''
      if (!absPath || !isAbsolute(absPath)) {
        return { error: 'Invalid path (expected an absolute path).' }
      }

      let stat
      try {
        stat = statSync(absPath)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: `File not found: ${msg}` }
      }
      if (!stat.isFile()) {
        return { error: 'Not a file.' }
      }

      const shellError = await shell.openPath(absPath)
      if (shellError) {
        return { error: shellError }
      }
      return { error: '' }
    }
  )

  // Filter scraped candidate paths down to real files. The renderer
  // scrapes absolute paths out of an assistant turn's text (which it
  // CAN'T verify — no fs access), then asks us which actually exist as
  // regular files. We `statSync` each, keeping absolute + existing +
  // is-file, preserving input order. Capped so a pathological message
  // full of `/`-strings can't make us stat thousands of entries.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_STAT_FILES,
    async (
      _event,
      payload: ShellStatFilesPayload
    ): Promise<ShellStatFilesResult> => {
      const input = Array.isArray(payload?.paths) ? payload.paths : []
      const MAX_CANDIDATES = 50
      const files: string[] = []
      const seen = new Set<string>()
      for (const p of input.slice(0, MAX_CANDIDATES)) {
        if (typeof p !== 'string' || !p || !isAbsolute(p)) continue
        if (seen.has(p)) continue
        seen.add(p)
        try {
          if (statSync(p).isFile()) files.push(p)
        } catch {
          // ENOENT / EACCES / etc. — not a usable file, drop silently.
        }
      }
      return { files }
    }
  )

  // Session list / load / new / switch. All guarded by the workspace
  // gate — listSessions() returns [] when workspace is null, and the
  // switch handler defers to engine.switchToSession() which throws if
  // the workspace is unset.
  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST,
    async (event): Promise<SessionListResult> => {
      const workspace = resolveEngine(event).getWorkspace()
      const threads = await listSessions(workspace)
      return { threads }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_LOAD,
    async (event, payload: SessionLoadPayload): Promise<SessionLoadResult> => {
      validateSessionLoadPayload(payload)
      const workspace = resolveEngine(event).getWorkspace()
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
      event,
      payload: SessionSwitchPayload
    ): Promise<SessionSwitchResult> => {
      validateSessionSwitchPayload(payload)
      // `engine.switchToSession` returns the real session id the cli
      // ended up using, which may differ from payload.sessionId when
      // fusion-code silently forks on `--resume` (upstream
      // claude-code behavior). The renderer uses this id to
      // re-subscribe chat events under the correct key.
      const result = await resolveEngine(event).switchToSession(payload.sessionId, {
        resume: payload.resume
      })
      return { sessionId: result.sessionId }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_RENAME,
    async (
      event,
      payload: SessionRenamePayload
    ): Promise<SessionRenameResult> => {
      validateSessionRenamePayload(payload)
      const engine = resolveEngine(event)
      await renameSession(payload.sessionId, payload.title, engine.getWorkspace())
      // Trigger sidebar refresh — the SDK reads customTitle on its
      // next listSessions scan, so rebroadcasting picks up the new
      // value without any in-memory state to invalidate.
      engine.emit('sessionListChanged')
      return { ok: true }
    }
  )

  // Multi-runtime support. Returns the set of sessions currently
  // backed by a live fusion-code process in this tab's engine, so
  // the sidebar can paint "still running" badges on the matching
  // rows and the renderer's ChatEvent bridge knows which ids it
  // needs a subscription on (background runtimes emit events even
  // when they aren't the foreground session).
  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST_ACTIVE_RUNTIMES,
    async (event): Promise<SessionListActiveRuntimesResult> => {
      return { sessionIds: resolveEngine(event).listActiveRuntimeIds() }
    }
  )

  // Explicit "close this background session" handler. Tears down
  // the runtime (cli exits) but leaves the JSONL on disk so the
  // row can still be reopened from the sidebar. Fires
  // sessionListChanged so the renderer drops the running badge.
  ipcMain.handle(
    IPC_CHANNELS.SESSION_CLOSE_RUNTIME,
    async (
      event,
      payload: SessionCloseRuntimePayload
    ): Promise<SessionCloseRuntimeResult> => {
      validateSessionCloseRuntimePayload(payload)
      await resolveEngine(event).closeSessionRuntime(payload.sessionId)
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

  // Tab management. `newTab` creates a fresh WebContentsView, its
  // own engine, and activates it. `switchTab` brings a tab to the
  // foreground. `closeTab` disposes the engine and removes the view.
  // `listTabs` is a one-shot hydrate for the shell TabBar on mount;
  // after that it reads updates off the TAB_LIST_CHANGED broadcast
  // that tabRegistry emits on every mutation.
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, async (): Promise<void> => {
    if (!canAddTab()) {
      await showMaxTabsDialog()
      return
    }
    newTab()
  })

  ipcMain.handle(
    IPC_CHANNELS.TAB_SWITCH,
    async (_event, payload: TabSwitchPayload): Promise<void> => {
      validateTabId(payload?.id)
      activateTab(payload.id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TAB_CLOSE,
    async (_event, payload: TabClosePayload): Promise<void> => {
      validateTabId(payload?.id)
      await closeTab(payload.id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TAB_LIST_GET,
    async (): Promise<TabListResult> => {
      return { tabs: listTabs() }
    }
  )

  // One-shot hydrate for the shell window's fullscreen state. The
  // renderer calls this on mount to set `data-fullscreen` on <html>
  // before the CSS evaluates; SHELL_FULLSCREEN_CHANGED broadcasts
  // keep it live after that.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_FULLSCREEN_GET,
    async (): Promise<boolean> => {
      return getShellFullscreen()
    }
  )

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

  // Open the current workspace directory in the OS file manager. The
  // path comes from the engine — never the renderer — so the user can
  // never coax this into opening an arbitrary directory. Returns the
  // shell.openPath error verbatim on failure.
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_OPEN,
    async (event): Promise<{ error: string }> => {
      const workspace = resolveEngine(event).getWorkspace()
      if (!workspace) {
        return { error: 'Workspace not set.' }
      }
      const shellError = await shell.openPath(workspace)
      return { error: shellError }
    }
  )

  // OpenAI-compatible audio transcription proxy.
  //
  // Routes audio through the Chat Completions endpoint using an
  // `input_audio` message part. This works with any OpenAI-compatible
  // provider that offers `gpt-4o-audio-preview` (or equivalent audio
  // chat model) — including csdn.cloud, which doesn't expose the
  // dedicated `/audio/transcriptions` + whisper endpoint.
  //
  // Renderer records raw PCM via AudioWorklet, encodes it as a 16-bit
  // mono WAV file, ships the bytes here as a Uint8Array, and main
  // base64-encodes them into the chat request's `input_audio.data`
  // field. The system prompt instructs the model to return ONLY the
  // verbatim transcript with no commentary or quoting, which is the
  // same contract whisper would give us.
  //
  // Env is read per-call so editing env.json takes effect without a
  // relaunch. Errors are caught and returned as `{ error }` so the
  // dictation adapter can surface them as a log entry instead of
  // crashing the IPC.
  ipcMain.handle(
    IPC_CHANNELS.TRANSCRIBE_AUDIO,
    async (
      _event,
      payload: TranscribeAudioPayload
    ): Promise<TranscribeAudioResult> => {
      console.log('[transcribe] handler invoked', {
        bytes: payload?.audio?.byteLength ?? 0,
        mimeType: payload?.mimeType,
        language: payload?.language
      })
      if (!payload?.audio || payload.audio.byteLength === 0) {
        console.log('[transcribe] rejected: empty audio payload')
        return { error: 'empty audio payload' }
      }
      // Provider selection: Gemini wins when its key is set, otherwise
      // fall back to the OpenAI-compatible path. Lets users swap
      // providers by just editing env.json (no code changes, no
      // relaunch) and keeps both routes on the same IPC surface.
      if (process.env.GEMINI_API_KEY) {
        return transcribeViaGemini(payload)
      }
      if (process.env.OPENAI_API_KEY) {
        return transcribeViaOpenAIChat(payload)
      }
      console.log('[transcribe] rejected: no STT API key configured')
      return {
        error:
          'No STT API key configured — set GEMINI_API_KEY or OPENAI_API_KEY in env.json.'
      }
    }
  )

  // CLI backend — get/set the choice between bundled fusion-code and
  // the user's system claude. Detection is refreshed through the
  // engine on every GET so the settings page always sees fresh info
  // without the caller doing an extra subprocess spawn round.
  ipcMain.handle(
    IPC_CHANNELS.CLI_BACKEND_GET,
    async (event): Promise<CliBackendState> => {
      const eng = resolveEngine(event)
      const [{ cliBackend }, detection] = await Promise.all([
        Promise.resolve(getAppSettings()),
        eng.refreshSystemClaudeDetection()
      ])
      let bundledPath: string | null = null
      try {
        bundledPath = eng.getBundledCliPath()
      } catch (err) {
        console.warn('[cli-backend] bundled cli not found', {
          message: err instanceof Error ? err.message : String(err)
        })
      }
      return {
        mode: cliBackend,
        bundledPath,
        systemInfo: detection.path
          ? { path: detection.path, version: detection.version }
          : null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CLI_BACKEND_SET,
    async (
      event,
      payload: CliBackendSetPayload
    ): Promise<CliBackendState> => {
      const mode = payload?.mode
      if (mode !== 'bundled' && mode !== 'system') {
        throw new Error(`Invalid cli backend mode: ${String(mode)}`)
      }
      updateAppSettings({ cliBackend: mode })
      // Apply NOW instead of "on the next app restart": recycle every
      // tab's live runtimes so the next turn cold-starts on the new
      // backend. In-flight turns keep their current backend (see
      // ChatEngine.restartRuntimesForBackendChange).
      await recycleAllEnginesForBackendChange()
      const eng = resolveEngine(event)
      const detection = await eng.refreshSystemClaudeDetection()
      let bundledPath: string | null = null
      try {
        bundledPath = eng.getBundledCliPath()
      } catch {
        /* bundled resolution failure is non-fatal here — surface null */
      }
      return {
        mode,
        bundledPath,
        systemInfo: detection.path
          ? { path: detection.path, version: detection.version }
          : null
      }
    }
  )

  // Permission-mode picker: get / set the engine's current UI
  // permission mode. The renderer's picker store is the source of
  // truth (persisted in localStorage) — on mount it reads its own
  // localStorage, calls setPermissionMode to push it to main, and
  // uses the getter only as a fallback after hot-reload.
  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_MODE_GET,
    async (event): Promise<PermissionModeGetResult> => {
      return { mode: resolveEngine(event).getPermissionMode() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_MODE_SET,
    async (event, payload: PermissionModeSetPayload): Promise<void> => {
      const mode = payload?.mode
      if (!isValidPermissionMode(mode)) {
        throw new Error(`Invalid permission mode: ${String(mode)}`)
      }
      await resolveEngine(event).setPermissionMode(mode)
    }
  )

  // ── Appearance: reverse-proxy the daemon's /api/app-config ──────────
  //
  // The desktop renderer can't fetch the daemon (127.0.0.1:7456) directly:
  // its file:// (prod) / dev origin isn't on the daemon's origin allow-list,
  // so a direct request 403s (see services/openDesignServices.ts and the
  // daemon's origin-validation.ts). We forward over net.fetch from main,
  // deleting the Origin/Host headers so the daemon's origin check treats it
  // as a trusted non-browser request (`origin == null` → loopback host →
  // allowed). Same technique appProtocol.ts uses for the web tab's /api/*.
  // These two handlers don't touch any ChatEngine — they're window-agnostic.
  ipcMain.handle(
    IPC_CHANNELS.APPEARANCE_GET,
    async (): Promise<AppearanceGetResult> => {
      return { appearance: await fetchDaemonAppearance() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.APPEARANCE_SET,
    async (event, payload: AppearanceSetPayload): Promise<AppearanceSetResult> => {
      const patch = payload?.patch
      if (!patch || typeof patch !== 'object') {
        return { appearance: null }
      }
      const appearance = await writeDaemonAppearance(patch)
      // Only broadcast on a real daemon write (null = daemon offline, nothing
      // changed). Pass the writer's webContents so it's skipped — it already
      // applied the change locally and re-pulling would be a wasteful echo
      // (and the desktop store's isHydrating guard relies on us not feeding
      // it back what it just pushed). web tabs have no preload, so the
      // broadcaster reaches them via executeJavaScript instead.
      if (appearance) broadcastAppearanceChanged(event.sender.id)
      return { appearance }
    }
  )

  // Appearance written straight to the daemon by a renderer (the settings
  // overlay's /api/app-config PUT), bypassing the main process. The renderer
  // pings this so main can broadcast to the OTHER windows — without it the
  // change only landed in the writer until a reload (see APPEARANCE_BROADCAST
  // doc in ipc-channels). We skip the caller for the same skip-the-writer
  // reason as APPEARANCE_SET above.
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_BROADCAST, async (event): Promise<void> => {
    broadcastAppearanceChanged(event.sender.id)
  })

  // Shell tab-strip settings menu → active chat tab. The shell renderer
  // can't reach the chat renderer's stores directly, so it fires this and
  // we forward the action to whichever chat tab is active (web tabs and the
  // no-tab edge case are silently skipped inside the dispatcher).
  ipcMain.handle(
    IPC_CHANNELS.TAB_TRIGGER_MENU_ACTION,
    async (_event, payload: ShellMenuActionPayload): Promise<void> => {
      const action = payload?.action
      if (
        action !== 'open-settings' &&
        action !== 'open-logs' &&
        action !== 'toggle-lang'
      ) {
        return
      }
      dispatchMenuActionToActiveTab(action)
    }
  )

  // Settings modal — a full-window transparent overlay managed by
  // tabRegistry. Open from the shell's gear (works over any tab); close
  // from the overlay itself (scrim / Escape / ✕). Both are window-agnostic.
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_OPEN, async (): Promise<void> => {
    openSettingsView()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE, async (): Promise<void> => {
    closeSettingsView()
  })

  // Runtime-log read/clear for the「日志分析」settings section. Engine-free —
  // they touch the process-global logCollector directly. Live streaming is a
  // separate `send` channel (LOGS_STREAM); the overlay registers as a push
  // subscriber in openSettingsView and unregisters in closeSettingsView.
  ipcMain.handle(IPC_CHANNELS.LOGS_GET, async (): Promise<RuntimeLogEntry[]> => {
    return getLogs()
  })
  ipcMain.handle(IPC_CHANNELS.LOGS_CLEAR, async (): Promise<void> => {
    clearLogs()
  })

  // Engine-free CLI backend read/write for the embedded web settings page.
  // The settings overlay isn't bound to any tab (no ChatEngine), so unlike
  // CLI_BACKEND_GET/SET these resolve the global app setting + run detection
  // directly via cliDetect. On SET we still recycle every tab's runtimes
  // (via recycleAllEnginesForBackendChange) so the flip applies on the next
  // turn — `backend` is only read at spawn time, so a reused runtime would
  // otherwise keep the old backend until an app restart.
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_CLI_BACKEND_GET,
    async (): Promise<CliBackendState> => {
      const { cliBackend } = getAppSettings()
      const info = await detectSystemClaude()
      let bundledPath: string | null = null
      try {
        bundledPath = resolveBundledCliPath()
      } catch (err) {
        console.warn('[settings-cli-backend] bundled cli not found', {
          message: err instanceof Error ? err.message : String(err)
        })
      }
      return {
        mode: cliBackend,
        bundledPath,
        systemInfo: info?.path
          ? { path: info.path, version: info.version ?? null }
          : null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_CLI_BACKEND_SET,
    async (_event, payload: CliBackendSetPayload): Promise<CliBackendState> => {
      const mode = payload?.mode
      if (mode !== 'bundled' && mode !== 'system') {
        throw new Error(`Invalid CLI backend mode: ${String(mode)}`)
      }
      updateAppSettings({ cliBackend: mode })
      // Same as CLI_BACKEND_SET: apply immediately by recycling live
      // runtimes across all tabs (the overlay has no engine of its own).
      await recycleAllEnginesForBackendChange()
      const info = await detectSystemClaude()
      let bundledPath: string | null = null
      try {
        bundledPath = resolveBundledCliPath()
      } catch {
        bundledPath = null
      }
      return {
        mode,
        bundledPath,
        systemInfo: info?.path
          ? { path: info.path, version: info.version ?? null }
          : null
      }
    }
  )

  // ── Knowledge-base path configuration and index reading ─────────────
  //
  // Engine-free: these handlers touch only the app-global userData
  // directory, not any per-tab ChatEngine. The KB root path is written
  // to `userData/kb-config.json` by KB_PATH_SET and re-read by
  // KB_PATH_GET alongside the fixed `outDir` so the renderer can
  // populate its settings UI in a single round-trip. KB_INDEX_READ
  // loads the Phase-A build output from `outDir/index.json` and
  // returns null when it doesn't exist yet — the renderer treats null
  // as "not ready" and shows the build CTA.
  ipcMain.handle(
    IPC_CHANNELS.KB_PATH_GET,
    async (): Promise<{ kbRoot: string | null; outDir: string }> => ({
      kbRoot: getKbRoot(),
      outDir: kbOutDir()
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.KB_PATH_SET,
    async (_e, kbRoot: string): Promise<void> => {
      setKbRoot(kbRoot)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.KB_INDEX_READ,
    async (): Promise<KbIndex | null> => readKbIndex()
  )

  // ── Proposal document export ─────────────────────────────────────────
  //
  // Engine-free: the renderer ships the full markdown string, main pops
  // the OS native save dialog anchored to the sender's BrowserWindow
  // (modal on macOS), writes the file via proposalExport.ts, and returns
  // the path. `{ path: null }` signals user cancellation. The format
  // field is a closed union (`'md'` | `'docx'`). Extending to a new format
  // is driven entirely from proposalExport.ts: add a FORMAT_META key (dialog
  // filters/defaultPath + this IPC guard's whitelist both derive from it) and
  // a write-switch case (its `never` default flags the omission). This IPC
  // guard auto-follows, so nothing here needs touching.
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_EXPORT,
    async (event, payload: ProposalExportPayload): Promise<ProposalExportResult> => {
      const markdown =
        typeof payload?.markdown === 'string' ? payload.markdown : ''
      // 校验 format 落在已支持联合内，挡掉意外值流入写路径。白名单由 FORMAT_META
      // 派生（单一真相源，见 proposalExport.ts），加新格式时无需同步改这里。
      const format = payload?.format
      if (!isProposalExportFormat(format)) {
        return { path: null }
      }
      // Runtime guard: BrowserWindow may be null if the window was closed
      // between IPC message send and handler execution.
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { path: null }
      // style 是纯数据（字体/字号/缩进…），仅 docx 用得到；undefined 时 markdownToDocxBuffer
      // 回退默认模板（经典正式）。
      return exportProposal(win, markdown, format, payload?.style)
    }
  )

  // 预览专用：复用与「导出 Word」完全相同的引擎（markdownToDocxBuffer），
  // 保证 docx-preview 渲染出的分页 = 导出成品逐像素一致。不弹保存框、不落盘——
  // 只把 .docx 字节回给渲染层喂给 docx-preview。生成异常直接抛出（reject），
  // 渲染层 try/catch 后显示错误态，而不是静默吞掉。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_RENDER,
    async (_event, payload: ProposalRenderPayload): Promise<ProposalRenderResult> => {
      const markdown = typeof payload?.markdown === 'string' ? payload.markdown : ''
      const bytes = await markdownToDocxBuffer(markdown, payload?.style)
      return { bytes }
    }
  )

  // 引用落地校验（#1）：核对一节正文的 `（据《X》）` 是否真出自镜像原文。verifyCitations
  // 内部全程防御式（索引缺失/读失败/异常 → degraded），这里再兜一道 catch 保证绝不 reject——
  // 校验是叠加信号，任何失败都只降级为「未校验」，绝不阻塞正文生成或导出。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_VERIFY,
    async (_event, payload: ProposalVerifyPayload): Promise<ProposalVerifyResult> => {
      const markdown = typeof payload?.markdown === 'string' ? payload.markdown : ''
      try {
        return verifyCitations(markdown)
      } catch (err) {
        console.warn('[ipc] verifyProposalCitations failed:', err)
        return { verdicts: [], citedFileCount: 0, degraded: true }
      }
    }
  )

  // 草稿持久化三件套。全部防御式：非法载荷直接 ok:false/null，I/O 异常 catch 后同样
  // 降级返回——持久化是尽力而为，绝不让 reject 阻塞渲染层的会话切换。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_SAVE_DRAFT,
    async (_event, record: ProposalDraftRecord): Promise<ProposalSaveDraftResult> => {
      if (
        !record ||
        record.version !== 1 ||
        typeof record.sessionId !== 'string' ||
        !record.sessionId ||
        !Array.isArray(record.sections)
      ) {
        return { ok: false }
      }
      try {
        await saveProposalDraft(record)
        return { ok: true }
      } catch (err) {
        console.warn('[ipc] saveProposalDraft failed:', err)
        return { ok: false }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_LOAD_DRAFT,
    async (_event, payload: ProposalLoadDraftPayload): Promise<ProposalDraftRecord | null> => {
      const sid = payload?.sessionId
      if (typeof sid !== 'string' || !sid) return null
      // 与 save/delete 一致：handler 层兜一道 catch。loadProposalDraft 内部已对
      // readFile/JSON.parse 防御，但 existsSync/draftPath 在内部 try 之外——OS 级异常
      // 逃逸会让本 handler reject，违反「绝不阻塞会话切换」契约。降级返回 null。
      try {
        return await loadProposalDraft(sid)
      } catch (err) {
        console.warn('[ipc] loadProposalDraft failed:', err)
        return null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_DELETE_DRAFT,
    async (_event, payload: ProposalDeleteDraftPayload): Promise<ProposalDeleteDraftResult> => {
      const sid = payload?.sessionId
      if (typeof sid !== 'string' || !sid) return { ok: false }
      try {
        await deleteProposalDraft(sid)
        return { ok: true }
      } catch (err) {
        console.warn('[ipc] deleteProposalDraft failed:', err)
        return { ok: false }
      }
    }
  )

  // M-0 埋点（backlog 度量层）：每次导出成功后落一条聚合记录到 userData/proposal-metrics/。
  // 防御式：非法载荷直接 ok:false，append 失败 catch 后降级——埋点是旁路信号，绝不阻塞导出。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_METRIC_LOG,
    async (_event, record: ProposalMetricRecord): Promise<ProposalMetricLogResult> => {
      if (!record || record.version !== 1 || typeof record.sessionId !== 'string') {
        return { ok: false }
      }
      try {
        await appendProposalMetric(record)
        return { ok: true }
      } catch (err) {
        console.warn('[ipc] logProposalMetric failed:', err)
        return { ok: false }
      }
    }
  )

  // Engine-to-renderer event forwarding lives in the ChatEngine
  // constructor (see engine.ts `wireWindowBridges`) — each per-window
  // engine ships its own chat/log/session/permission events to its
  // own bound webContents. Engine dispose() on window close cancels
  // in-flight permission requests and removes listeners, so there's
  // nothing to wire here anymore.
}

/** Daemon base URL. Port matches openDesignServices.DAEMON_PORT (= cli default). */
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`

/**
 * GET the daemon's app-config and return its `appearance` sub-object, or null
 * when the daemon is offline / hasn't stored any. Origin/Host headers aren't
 * set by net.fetch for a bare URL, so this lands on the daemon as a trusted
 * non-browser request — exactly what the origin check wants.
 */
async function fetchDaemonAppearance(): Promise<AppearancePrefs | null> {
  try {
    const res = await net.fetch(`${DAEMON_BASE}/api/app-config`)
    if (!res.ok) return null
    const data = (await res.json()) as { config?: { appearance?: AppearancePrefs } }
    return data?.config?.appearance ?? null
  } catch {
    return null
  }
}

/**
 * PUT an appearance patch to the daemon (it deep-merges, so a partial patch is
 * safe) and return the merged `appearance`. Best-effort: returns null on any
 * failure so the renderer's local store / localStorage remain the durable copy.
 */
async function writeDaemonAppearance(
  patch: AppearancePrefs
): Promise<AppearancePrefs | null> {
  try {
    const res = await net.fetch(`${DAEMON_BASE}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appearance: patch })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { config?: { appearance?: AppearancePrefs } }
    return data?.config?.appearance ?? null
  } catch {
    return null
  }
}

const VALID_PERMISSION_MODES: readonly UiPermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk'
]

function isValidPermissionMode(value: unknown): value is UiPermissionMode {
  return (
    typeof value === 'string' &&
    (VALID_PERMISSION_MODES as readonly string[]).includes(value)
  )
}

function validateSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`Invalid sessionId`)
  }
}

function validateTabId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid tab id`)
  }
}

/**
 * Shared "tab cap reached" dialog. Shown from both the IPC
 * handler (clicking the `+` button in any tab's TabBar) and the
 * menu accelerator (⌘T) so the user always sees the same
 * message regardless of how they tried to open the tab. Anchored
 * to the shell window so it's treated as modal on macOS.
 */
export async function showMaxTabsDialog(): Promise<void> {
  const shell = getShellWindow()
  const opts = {
    type: 'info' as const,
    title: 'Maximum tabs reached',
    message: `You can open up to ${MAX_TABS} workspace tabs at once.`,
    detail:
      'Close an existing tab before opening a new workspace so the host stays responsive.',
    buttons: ['OK'],
    defaultId: 0,
    noLink: true
  }
  try {
    if (shell && !shell.isDestroyed()) {
      await dialog.showMessageBox(shell, opts)
    } else {
      await dialog.showMessageBox(opts)
    }
  } catch (err) {
    console.warn('[ipc] max-tabs dialog failed:', err)
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

function validateSessionCloseRuntimePayload(
  value: unknown
): asserts value is SessionCloseRuntimePayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid session-close-runtime payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) {
    throw new Error('Invalid session-close-runtime sessionId (empty or missing)')
  }
  if (v.sessionId.length > 128) {
    throw new Error('Invalid session-close-runtime sessionId (too long)')
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

/**
 * Map a MIME type to the `format` string expected by
 * `input_audio` in the OpenAI chat completions API. Only `wav` and
 * `mp3` are officially supported; everything else falls back to
 * `wav` since our adapter explicitly encodes WAV via AudioWorklet
 * before sending.
 */
function wavOrMp3FormatHint(mime: string | undefined): 'wav' | 'mp3' {
  const head = (mime ?? '').split(';')[0]!.trim().toLowerCase()
  if (head === 'audio/mpeg' || head === 'audio/mp3') return 'mp3'
  return 'wav'
}

/**
 * Gemini (Google AI Studio) transcription path. Uses the generative
 * language API's `generateContent` endpoint with the audio embedded
 * as an `inline_data` content part — the same mental model as the
 * OpenAI chat-audio route but Google's proxy actually forwards the
 * bytes to the model instead of silently dropping them.
 *
 * Auth goes in the `?key=` query string (legacy but still the AI
 * Studio style). The response text lives at
 * `candidates[0].content.parts[0].text`.
 */
async function transcribeViaGemini(
  payload: TranscribeAudioPayload
): Promise<TranscribeAudioResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { error: 'GEMINI_API_KEY missing' }
  const baseUrlRaw =
    process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta'
  const model = process.env.GEMINI_TRANSCRIBE_MODEL ?? 'gemini-2.5-flash'
  const baseUrl = baseUrlRaw.replace(/\/+$/, '')
  const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`
  console.log('[transcribe:gemini] posting', {
    url: url.replace(/key=[^&]+/, 'key=***'),
    model,
    keyLen: apiKey.length
  })
  try {
    const audioBase64 = Buffer.from(payload.audio).toString('base64')
    const mimeType = (payload.mimeType || 'audio/wav').split(';')[0]!.trim()

    // Prompt follows Google's canonical audio-understanding example
    // ("Generate a transcript of the speech.") with a short
    // appendage that pins the output to the bare transcript. The
    // docs specifically call this phrasing out as the reference
    // prompt for verbatim transcription, and in practice it
    // produces noticeably cleaner output than longer instructions.
    // Language hint is included when set so Chinese dictation
    // doesn't get pinyin / English rewrites.
    const langHint =
      payload.language === 'zh'
        ? ' The speech is in Mandarin Chinese; output the transcript in simplified Chinese characters.'
        : payload.language
          ? ` The speech is in ${payload.language}.`
          : ''
    const promptText =
      `Generate a transcript of the speech.${langHint} Output only the transcript text — no commentary, no quotes, no markdown, no translation. If the audio is silent or unintelligible, return an empty string.`

    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: promptText },
            {
              inline_data: {
                mime_type: mimeType,
                data: audioBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        // Upper bound for whole-utterance transcripts. A minute of
        // fast Mandarin is ~250 characters ≈ 400 tokens; we size
        // generously for multi-minute sessions without letting a
        // hallucination run forever.
        maxOutputTokens: 4096
      }
    }
    const bodyJson = JSON.stringify(body)
    console.log('[transcribe:gemini] body size', bodyJson.length)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyJson
    })
    console.log('[transcribe:gemini] status', res.status)
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.log('[transcribe:gemini] error body', errBody.slice(0, 500))
      return {
        error: `gemini ${res.status}: ${errBody.slice(0, 300) || res.statusText}`
      }
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: unknown }> }
      }>
      promptFeedback?: { blockReason?: unknown }
    }
    if (data.promptFeedback?.blockReason) {
      return {
        error: `gemini blocked: ${String(data.promptFeedback.blockReason)}`
      }
    }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const raw = parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
    if (!raw) {
      console.log(
        '[transcribe:gemini] response shape unexpected',
        JSON.stringify(data).slice(0, 300)
      )
      return { error: 'gemini response missing text' }
    }
    const text = raw.trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim()
    console.log('[transcribe:gemini] ok', { len: text.length })
    return { text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log('[transcribe:gemini] threw', msg)
    return { error: `gemini transcription failed: ${msg}` }
  }
}

/**
 * OpenAI-compatible chat-completions transcription path (legacy
 * fallback). Kept around for users who have an OpenAI-style key
 * without a Gemini one; known NOT to work with proxies that drop
 * `input_audio` content blocks (e.g. csdn.cloud).
 */
async function transcribeViaOpenAIChat(
  payload: TranscribeAudioPayload
): Promise<TranscribeAudioResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return { error: 'OPENAI_API_KEY missing' }
  const baseUrlRaw =
    process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const model = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-audio-preview'
  const baseUrl = baseUrlRaw.replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  console.log('[transcribe:openai] posting', { url, model, keyLen: apiKey.length })
  try {
    const audioBase64 = Buffer.from(payload.audio).toString('base64')
    const format = wavOrMp3FormatHint(payload.mimeType)
    const systemPrompt =
      'You are a speech-to-text transcriber. Transcribe the audio verbatim. ' +
      'Output ONLY the transcript, with no commentary, no quoting, no ' +
      'markdown, no labels, and no trailing punctuation beyond what was ' +
      'spoken. If the audio is silent or unintelligible, return an ' +
      'empty string.'
    const userText =
      payload.language === 'zh'
        ? '请把下面这段音频转成文字。'
        : 'Transcribe the audio.'
    const body = {
      model,
      modalities: ['text'],
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            {
              type: 'input_audio',
              input_audio: { data: audioBase64, format }
            }
          ]
        }
      ]
    }
    const bodyJson = JSON.stringify(body)
    console.log('[transcribe:openai] body size', bodyJson.length)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: bodyJson
    })
    console.log('[transcribe:openai] status', res.status)
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.log('[transcribe:openai] error body', errBody.slice(0, 500))
      return {
        error: `openai ${res.status}: ${errBody.slice(0, 300) || res.statusText}`
      }
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const raw = data.choices?.[0]?.message?.content
    if (typeof raw !== 'string') {
      console.log(
        '[transcribe:openai] response shape unexpected',
        JSON.stringify(data).slice(0, 300)
      )
      return { error: 'openai response missing `choices[0].message.content`' }
    }
    const text = raw.trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim()
    console.log('[transcribe:openai] ok', { len: text.length })
    return { text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log('[transcribe:openai] threw', msg)
    return { error: `openai transcription failed: ${msg}` }
  }
}
