import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { PermissionResponse, QueuedMessage } from '../../shared/types'
import {
  IPC_CHANNELS,
  type ChatAbortPayload,
  type ChatImagePayload,
  type ChatQueueEditPayload,
  type ChatQueueListPayload,
  type ChatQueuePromotePayload,
  type ChatQueueRemovePayload,
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
  type SessionDeletePayload,
  type SessionSearchPayload,
  type SessionSearchResult,
  type SessionRenameResult,
  type SessionSwitchPayload,
  type SessionSwitchResult,
  type SessionWorkspaceSetPayload,
  type SessionWorkspaceSetResult,
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
  type ShellRevealPathPayload,
  type ShellRevealPathResult,
  type ImageManifestReadPayload,
  type ImageManifestReadResult,
  type ImageManifestItem,
  type ImageFileReadPayload,
  type ImageFileReadResult,
  type SheetFileReadPayload,
  type SheetFileReadResult,
  type SheetFileStatPayload,
  type SheetFileStatResult,
  type ModelListResult,
  type ModelSetPayload,
  type WorkspaceKnownListResult,
  type WorkspacePickResult,
  type WorkspaceSetPayload,
  type WorkspaceState,
  type AppearanceGetResult,
  type AppearanceSetPayload,
  type AppearanceSetResult,
  type AppearancePrefs,
  type ShellMenuActionPayload,
  type UpdaterState,
  type AuthLoginPayload,
  type AuthLoginResult,
  type AuthState
} from '../../shared/ipc-channels'
import { getAppSettings, updateAppSettings } from '../core/appSettings'
import {
  PROPOSAL_IMAGE_API_KEY_MASK,
  type ProposalExportPayload,
  type ProposalExportResult,
  type ProposalExportPdfPayload,
  type ProposalExportPdfResult,
  type ProposalRenderPayload,
  type ProposalRenderResult,
  type ProposalVerifyPayload,
  type ProposalVerifyResult,
  type ProposalDraftRecord,
  type ProposalLoadDraftPayload,
  type ProposalDeleteDraftPayload,
  type ProposalSaveDraftResult,
  type ProposalDeleteDraftResult,
  type ProposalMetricLogResult,
  type ProposalPeekRetrievalPayload,
  type ProposalPeekRetrievalResult,
  type KbSemanticSearchPayload,
  type KbSemanticSearchResult,
  type LocalDocsScanPayload,
  type LocalDocsScanResult,
  type LocalDocsDirsResult,
  type LocalDocsDirSetPayload,
  type LocalDocsDirsPickResult,
  type KbCategoriesUpdatePayload,
  type KbCategoriesResult,
  type KbDomainPayload,
  type KbImageThumbsPayload,
  type KbImageThumbsResult,
  type ProposalImageApiConfig,
  type ProposalImageGeneratePayload,
  type ProposalImageEditPayload,
  type ProposalImageResult,
  type ProposalImageUploadPayload
} from '../../shared/ipc-channels'
import { setKbRoot, readKbIndex, kbOutDir, getKbConfig, setKbRemote } from '../core/kbIndexStore'
import { scanLocalDocs, listLocalDocsDirs, setLocalDocsDir } from '../core/localDocsScan'
import {
  readKbCatalog,
  rebuildKbCatalog,
  getKbCatalogStatus,
  readKbCategories,
  updateKbCategories
} from '../core/kbCatalogService'
import { triggerKbSyncNow, lastKbSyncInfo, invalidateKbSyncBaseline } from '../core/kbSyncScheduler'
import type { KbIndex } from '../../shared/kbIndex'
import type { KbRemoteConfig } from '../../shared/kbConfig'
import { exportProposal, isProposalExportFormat } from '../core/proposalExport'
import { exportProposalPdf } from '../core/proposalPdf'
import { markdownToDocxBuffer } from '../core/proposalDocx'
import { verifyCitations, collectUngroundedImagePaths } from '../core/proposalVerify'
import { retrievePassages } from '../core/proposalRetrieve'
import { buildProposalProductScopes } from '../core/proposalScopes'
import { kbSemanticSearch, resetEmbedWorker } from '../core/kbSemanticSearch'
import {
  saveProposalDraft,
  loadProposalDraft,
  deleteProposalDraft
} from '../core/proposalDraftStore'
import { appendProposalMetric } from '../core/proposalMetricsStore'
import { generateImage, editImage, sniffImageExt } from '../services/imageGenService'
import { writeProposalImage } from '../services/proposalImageWriter'
import { mimeForImagePath } from '../../shared/imageMime'
import { EMBEDDABLE_IMAGE_EXTS, type ProposalMetricRecord } from '../../shared/proposal'
import { readFile } from 'node:fs/promises'
import { detectSystemClaude, resolveBundledCliPath } from '../core/cliDetect'
import { checkForUpdates, getUpdaterState, installUpdate } from '../services/appUpdater'
import { getAuthState, login, logout } from '../services/authService'
import { DAEMON_PORT } from '../services/openDesignServices'
import type { ChatEngine } from '../core/engine'
import { listFileSuggestions } from '../core/fileSuggestions'
import {
  deleteSessionFromDisk,
  listAllSessions,
  loadSession,
  renameSession,
  searchSessionContent
} from '../core/sessionStore'
import { listKnownWorkspaces } from '../core/workspaceRegistry'
import { clearUnread, updateTrayLang } from '../tray'
import {
  broadcastAppearanceChanged,
  broadcastTabList,
  closeTab,
  describeSenderMismatch,
  dispatchMenuActionToActiveTab,
  dispatchSessionSwitchToActiveTab,
  getActiveChatEngine,
  getAllTabs,
  getContextForSender,
  getShellFullscreen,
  getShellWindow,
  listTabs,
  MAX_TABS,
  activateTab,
  syncShellBackgroundToTheme
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
import {
  addLogSubscriber,
  clearLogs,
  getLogFileTarget,
  getLogs,
  removeLogSubscriber
} from '../core/logCollector'

/**
 * MODEL_LIST cache: the catalog changes rarely, and the composer's 模型 chip
 * fetches on every dropdown open — one upstream hit per TTL window keeps
 * that instant. Module-level (not per-engine): the catalog is a property of
 * the backend, identical for every window. Keyed by CLI backend mode so a
 * Settings-page switch (bundled ↔ system) invalidates immediately instead
 * of serving the other backend's list for up to a TTL.
 */
let modelListCache: { key: string; models: string[]; at: number } | null = null
const MODEL_LIST_TTL_MS = 5 * 60 * 1000

/**
 * Fallback for the system-claude backend BEFORE its CLI is live (lazy spawn):
 * the stable alias set claude accepts for --model / setModel. Once a runtime
 * is up, the real `supportedModels` control-request list replaces this (and
 * only THAT gets cached, so the upgrade happens on the next dropdown open).
 */
const SYSTEM_CLAUDE_MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku', 'sonnet[1m]']

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
 * 出图/改图产物落盘前按魔数定真实扩展名（评审发现：不传 ext 一律落 .png，url 兜底下载
 * 的 jpeg/webp 字节会被错标——Chromium 预览嗅探能显示、Word 按扩展名解码直接裂图，
 * 预览/导出静默分歧）。webp/未知格式 docx 本就无法嵌入（EMBEDDABLE_IMAGE_EXTS 有意排除），
 * 在「先审后落地」之前报错让用户重试/换模型，胜过落盘后预览与导出各自降级的迷惑体验。
 */
function embeddableExtFor(bytes: Buffer): string {
  const ext = sniffImageExt(bytes)
  if (ext === null || ext === 'webp') {
    throw new Error('出图 API 返回了无法嵌入 Word 的图片格式（webp/未知），请重试或更换模型')
  }
  return ext
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
  ipcMain.removeHandler(IPC_CHANNELS.KB_PATH_GET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_PATH_SET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_INDEX_READ)
  ipcMain.removeHandler(IPC_CHANNELS.KB_REMOTE_SET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_SYNC_NOW)
  ipcMain.removeHandler(IPC_CHANNELS.KB_ROOT_PICK)
  ipcMain.removeHandler(IPC_CHANNELS.KB_SEMANTIC_SEARCH)
  ipcMain.removeHandler(IPC_CHANNELS.KB_LOCAL_DOCS_SCAN)
  ipcMain.removeHandler(IPC_CHANNELS.KB_LOCAL_DOCS_DIRS_GET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_LOCAL_DOCS_DIRS_SET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_LOCAL_DOCS_DIRS_PICK)
  ipcMain.removeHandler(IPC_CHANNELS.KB_CATALOG_GET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_CATALOG_REBUILD)
  ipcMain.removeHandler(IPC_CHANNELS.KB_CATEGORIES_GET)
  ipcMain.removeHandler(IPC_CHANNELS.KB_CATEGORIES_UPDATE)
  ipcMain.removeHandler(IPC_CHANNELS.KB_IMAGE_THUMBS)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_EXPORT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_EXPORT_PDF)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_RENDER)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_SAVE_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_LOAD_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_DELETE_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_VERIFY)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_METRIC_LOG)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_PEEK_RETRIEVAL)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_IMAGE_SETTINGS_GET)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_IMAGE_SETTINGS_SET)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_IMAGE_GENERATE)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_IMAGE_EDIT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_IMAGE_UPLOAD)
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_ABORT)
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_REMOVE)
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_EDIT)
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_PROMOTE)
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_RESPOND)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_META_GET)
  ipcMain.removeHandler(IPC_CHANNELS.FILE_SUGGESTIONS_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_GET)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_SET)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_PICK)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_KNOWN_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_FILE_OPEN)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_OPEN_PATH)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_STAT_FILES)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_REVEAL_PATH)
  ipcMain.removeHandler(IPC_CHANNELS.IMAGE_MANIFEST_READ)
  ipcMain.removeHandler(IPC_CHANNELS.IMAGE_FILE_READ)
  ipcMain.removeHandler(IPC_CHANNELS.SHEET_FILE_READ)
  ipcMain.removeHandler(IPC_CHANNELS.SHEET_FILE_STAT)
  ipcMain.removeHandler(IPC_CHANNELS.MODEL_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.MODEL_SET)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SEARCH)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_NEW)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SWITCH)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_RENAME)
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKSPACE_SET)
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
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_GET_STATE)
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_CHECK)
  ipcMain.removeHandler(IPC_CHANNELS.UPDATER_INSTALL)
  ipcMain.removeHandler(IPC_CHANNELS.AUTH_GET_STATE)
  ipcMain.removeHandler(IPC_CHANNELS.AUTH_LOGIN)
  ipcMain.removeHandler(IPC_CHANNELS.AUTH_LOGOUT)
  ipcMain.removeHandler(IPC_CHANNELS.TAB_TRIGGER_MENU_ACTION)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_SESSION_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_SESSION_SWITCH_REQUEST)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_SESSION_RENAME)
  ipcMain.removeHandler(IPC_CHANNELS.SHELL_SESSION_DELETE)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_WINDOW_OPEN)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_CLI_BACKEND_GET)
  ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_CLI_BACKEND_SET)
  ipcMain.removeHandler(IPC_CHANNELS.LOGS_GET)
  ipcMain.removeHandler(IPC_CHANNELS.LOGS_CLEAR)
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
        // 内容级召回开关：仅非封面回合为真，engine 据此对镜像原文做混合召回注入。
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

  // Message-queue panel commands. The engine validates the messageId
  // (unknown/already-promoted ids no-op to false), so here we only
  // shape-check the session id and, for edit, the replacement text.
  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUEUE_LIST,
    async (event, payload: ChatQueueListPayload): Promise<QueuedMessage[]> => {
      validateSessionId(payload?.sessionId)
      return resolveEngine(event).getQueue(payload.sessionId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUEUE_REMOVE,
    async (event, payload: ChatQueueRemovePayload): Promise<boolean> => {
      validateSessionId(payload?.sessionId)
      validateMessageId(payload?.messageId)
      return resolveEngine(event).removeQueued(payload.sessionId, payload.messageId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUEUE_EDIT,
    async (event, payload: ChatQueueEditPayload): Promise<boolean> => {
      validateSessionId(payload?.sessionId)
      validateMessageId(payload?.messageId)
      validateText(payload?.text)
      return resolveEngine(event).editQueued(
        payload.sessionId,
        payload.messageId,
        payload.text
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUEUE_PROMOTE,
    async (event, payload: ChatQueuePromotePayload): Promise<boolean> => {
      validateSessionId(payload?.sessionId)
      validateMessageId(payload?.messageId)
      return resolveEngine(event).promoteQueued(payload.sessionId, payload.messageId)
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
      //   1. engine.getActiveSessionCwd() — 前台会话自己的工作目录
      //      （统一会话管理：per-session cwd，composer 预选或 transcript
      //      解析）。多 runtime 下 sessionMeta.cwd 可能是后台会话最后一次
      //      system init 的 cwd，前台快照才是 `@path` 真正的解析基准。
      //   2. sessionMeta.cwd — captured from fusion-code's `system init`
      //      message（前台快照未解析时的过渡值）。
      //   3. engine.getWorkspace() — 默认工作区（桌面）。
      //   4. process.cwd() — last-ditch fallback, only hit when the
      //      renderer somehow fires this IPC before the workspace is
      //      set (the gate is supposed to prevent that).
      const engine = resolveEngine(event)
      const meta = engine.getSessionMeta()
      const cwd =
        engine.getActiveSessionCwd() ??
        (meta.cwd && meta.cwd.length > 0
          ? meta.cwd
          : (engine.getWorkspace() ?? process.cwd()))
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

  // 已知工作区列表（composer「选择工作目录」下拉）。engine-free：注册表
  // 是 main 全局状态，[0] 恒为默认工作区（桌面）。
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_KNOWN_LIST,
    async (): Promise<WorkspaceKnownListResult> => {
      return { workspaces: await listKnownWorkspaces() }
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
  // scrapes paths out of an assistant turn's text (which it CAN'T verify —
  // no fs access), then asks us which actually exist as regular files.
  // `~/`-prefixed paths are expanded here (the model reports deliverables
  // as `~/Desktop/…` about as often as fully absolute), and the EXPANDED
  // path is what's returned — the caller feeds these straight into
  // SHELL_OPEN_PATH / SHELL_REVEAL_PATH, which only take absolute paths.
  // We `statSync` each, keeping absolute + existing + is-file, preserving
  // input order. Capped so a pathological message full of `/`-strings
  // can't make us stat thousands of entries.
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
      for (const raw of input.slice(0, MAX_CANDIDATES)) {
        if (typeof raw !== 'string' || !raw) continue
        const p =
          raw === '~' || raw.startsWith('~/')
            ? join(homedir(), raw.slice(1))
            : raw
        if (!isAbsolute(p)) continue
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

  // Reveal a file in the OS file manager (Finder on macOS), selected. Same
  // validation contract as SHELL_OPEN_PATH: absolute, existing, regular
  // file. `showItemInFolder` never opens/executes the file — it only asks
  // the file manager to highlight it.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_REVEAL_PATH,
    async (
      _event,
      payload: ShellRevealPathPayload
    ): Promise<ShellRevealPathResult> => {
      const absPath =
        payload && typeof payload.absPath === 'string' ? payload.absPath : ''
      if (!absPath || !isAbsolute(absPath)) {
        return { error: 'Invalid path (expected an absolute path).' }
      }
      try {
        if (!statSync(absPath).isFile()) {
          return { error: 'Not a file.' }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: `File not found: ${msg}` }
      }
      shell.showItemInFolder(absPath)
      return { error: '' }
    }
  )

  // Read a ppt-master image worklist and surface each item's status + a
  // thumbnail for the ones on disk. Serves BOTH acquisition runners — they
  // share the `{ items: [{ filename, status, … }] }` shape:
  //   - image_gen.py --manifest  → image_prompts.json (status: Generated)
  //   - image_search.py --batch  → image_queries.json (status: Sourced)
  // The renderer polls this while a run is live to drive the 「图片」tab.
  //
  // Why main owns this: the renderer has no fs access, and CSP forbids `file:`
  // img sources, so the only way to preview the generated PNGs is to decode
  // them here (nativeImage, already a dep — see tray.ts) into small `data:`
  // URIs. The manifest itself is image_gen.py's source of truth — it rewrites
  // each item's status on completion (scripts/image_gen.py _run_manifest), so
  // a poll of this file reflects live progress.
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_MANIFEST_READ,
    async (
      _event,
      payload: ImageManifestReadPayload
    ): Promise<ImageManifestReadResult> => {
      const empty: ImageManifestReadResult = {
        ok: false,
        items: [],
        generatedCount: 0,
        total: 0
      }
      const manifestPath =
        payload && typeof payload.manifestPath === 'string'
          ? payload.manifestPath
          : ''
      const withThumbnails = payload?.withThumbnails !== false
      // Path guard: absolute + existing regular file only. No traversal — we
      // read exactly the file the caller names (a path scraped from the
      // running command), never walk directories.
      if (!manifestPath || !isAbsolute(manifestPath)) {
        return { ...empty, error: 'Invalid manifest path (expected absolute).' }
      }
      try {
        if (!statSync(manifestPath).isFile()) {
          return { ...empty, error: 'Manifest is not a file.' }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ...empty, error: `Manifest not found: ${msg}` }
      }

      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
          string,
          unknown
        >
      } catch (err) {
        // A read mid-write can yield truncated JSON — report, don't throw, so
        // the next poll (post-atomic-rename) succeeds cleanly.
        const msg = err instanceof Error ? err.message : String(err)
        return { ...empty, error: `Manifest parse failed: ${msg}` }
      }

      const dir = dirname(manifestPath)
      const rawItems = Array.isArray(manifest.items) ? manifest.items : []
      // Cap the decode fan-out — a normal deck has <20 images; 40 is a safe
      // ceiling that still keeps the main thread responsive.
      const MAX_ITEMS = 40
      const items: ImageManifestItem[] = []
      let generatedCount = 0
      for (const raw of rawItems.slice(0, MAX_ITEMS)) {
        if (!raw || typeof raw !== 'object') continue
        const r = raw as Record<string, unknown>
        const filename = typeof r.filename === 'string' ? r.filename : ''
        if (!filename) continue
        const rawStatus = typeof r.status === 'string' ? r.status : 'Pending'
        // Resolve the image next to the manifest; basename() strips any path
        // segment in filename so it can't escape the images dir.
        const absPath = join(dir, basename(filename))
        const exists = existsSync(absPath)
        // Display-layer normalization: `Needs-Manual` means "waiting for the
        // USER to generate this image externally and drop the file in" — the
        // user won't (and shouldn't) hand-edit the manifest afterwards, so the
        // file appearing on disk IS the completion signal. Surface it as
        // Generated so the gallery card flips green the moment they drop the
        // file, instead of showing 失败 forever. Deliberately NOT applied to
        // `Failed` (+leftover file): a failed generation's partial/stale file
        // is not trustworthy output. The manifest on disk is never modified.
        const status =
          rawStatus === 'Needs-Manual' && exists ? 'Generated' : rawStatus
        // Both runners' "done" flavors count toward the progress numbers.
        if (status === 'Generated' || status === 'Sourced') generatedCount += 1
        const item: ImageManifestItem = {
          filename,
          status,
          purpose: typeof r.purpose === 'string' ? r.purpose : undefined,
          // image_queries.json rows carry a `query` instead of `alt_text` —
          // it's the best human-readable description a web row has, so it
          // fills the same caption slot in the 图片 grid.
          altText:
            typeof r.alt_text === 'string'
              ? r.alt_text
              : typeof r.query === 'string'
                ? r.query
                : undefined,
          lastError: typeof r.last_error === 'string' ? r.last_error : undefined,
          exists,
          absPath
        }
        if (withThumbnails && exists) {
          try {
            const img = nativeImage.createFromPath(absPath)
            // A half-written PNG decodes to an empty image — skip its
            // thumbnail (item still returns with exists:true); the next poll
            // after the file finishes writing picks it up.
            if (!img.isEmpty()) {
              item.thumbnail = img.resize({ width: 320 }).toDataURL()
            }
          } catch {
            // Decode failure (corrupt / unsupported) — omit thumbnail only.
          }
        }
        items.push(item)
      }

      return {
        ok: true,
        project: typeof manifest.project === 'string' ? manifest.project : undefined,
        dir,
        items,
        generatedCount,
        total: items.length
      }
    }
  )

  // Read one image file as a full-resolution data URI for the 图片 tab's
  // in-app lightbox. Returns the ORIGINAL bytes with an extension-derived
  // mime — decoding through nativeImage and re-encoding would turn a 300KB
  // JPEG into a multi-MB PNG for no benefit. Guards: absolute path, regular
  // file, image extension, and a size cap so a mislabeled giant can't stall
  // the IPC channel.
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_FILE_READ,
    async (
      _event,
      payload: ImageFileReadPayload
    ): Promise<ImageFileReadResult> => {
      const absPath =
        payload && typeof payload.absPath === 'string' ? payload.absPath : ''
      if (!absPath || !isAbsolute(absPath)) {
        return { ok: false, error: 'Invalid path (expected absolute).' }
      }
      const MIME: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        svg: 'image/svg+xml'
      }
      const ext = absPath.includes('.')
        ? absPath.split('.').pop()!.toLowerCase()
        : ''
      const mime = MIME[ext]
      if (!mime) {
        return { ok: false, error: `Not an image file: .${ext}` }
      }
      const MAX_BYTES = 30 * 1024 * 1024
      try {
        const stat = statSync(absPath)
        if (!stat.isFile()) return { ok: false, error: 'Not a file.' }
        if (stat.size > MAX_BYTES) {
          return { ok: false, error: 'Image too large for in-app preview.' }
        }
        const dataUrl = `data:${mime};base64,${readFileSync(absPath).toString('base64')}`
        return { ok: true, dataUrl }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Read failed: ${msg}` }
      }
    }
  )

  // Spreadsheet bytes for the chat pane's in-app preview panel. Mirrors
  // IMAGE_FILE_READ's contract exactly (extension whitelist + size cap +
  // original bytes), just for sheet formats and without a data-URI wrapper —
  // SheetJS consumes plain base64. Parsing stays renderer-side so a corrupt
  // file can't take main down with it.
  ipcMain.handle(
    IPC_CHANNELS.SHEET_FILE_READ,
    async (
      _event,
      payload: SheetFileReadPayload
    ): Promise<SheetFileReadResult> => {
      const absPath =
        payload && typeof payload.absPath === 'string' ? payload.absPath : ''
      if (!absPath || !isAbsolute(absPath)) {
        return { ok: false, error: 'Invalid path (expected absolute).' }
      }
      const ext = absPath.includes('.')
        ? absPath.split('.').pop()!.toLowerCase()
        : ''
      if (ext !== 'xlsx' && ext !== 'xls' && ext !== 'csv') {
        return { ok: false, error: `Not a spreadsheet file: .${ext}` }
      }
      // 与 IMAGE_FILE_READ 同上限。base64 后 ~40MB 走一趟 IPC 可接受；
      // 再大的表格预览本身也会先卡在渲染上,让它走系统应用。
      const MAX_BYTES = 30 * 1024 * 1024
      try {
        const stat = statSync(absPath)
        if (!stat.isFile()) return { ok: false, error: 'Not a file.' }
        if (stat.size > MAX_BYTES) {
          return { ok: false, error: 'Spreadsheet too large for in-app preview.' }
        }
        return {
          ok: true,
          data: readFileSync(absPath).toString('base64'),
          // 变更检测基准:预览用它对比 SHEET_FILE_STAT 的轮询结果。
          mtimeMs: stat.mtimeMs,
          size: stat.size
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Read failed: ${msg}` }
      }
    }
  )

  // 表格文件的 mtime/size——预览面板每几秒轮询一次,发现盘上文件变了
  // 就浮「刷新」提示条。刻意用轮询不用 fs.watch:没有跨会话/多窗口的
  // watcher 生命周期要管,3s 对一个人眼提示条绰绰有余。
  ipcMain.handle(
    IPC_CHANNELS.SHEET_FILE_STAT,
    async (
      _event,
      payload: SheetFileStatPayload
    ): Promise<SheetFileStatResult> => {
      const absPath =
        payload && typeof payload.absPath === 'string' ? payload.absPath : ''
      if (!absPath || !isAbsolute(absPath)) {
        return { ok: false, error: 'Invalid path (expected absolute).' }
      }
      try {
        const stat = statSync(absPath)
        if (!stat.isFile()) return { ok: false, error: 'Not a file.' }
        return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Stat failed: ${msg}` }
      }
    }
  )

  // Model catalog for the composer's 模型 chip — source depends on the CLI
  // backend, because the two run against DIFFERENT model providers:
  //   - bundled (fusion-code) → the csdn gateway env.json points it at; its
  //     OpenAI-compatible /v1/models catalog is the source of truth for what
  //     the user can actually run. Non-chat entries (image / audio /
  //     realtime) are filtered so the dropdown only offers chat models.
  //   - system claude → runs on the user's own ~/.claude login (gateway env
  //     is stripped, see systemBackendEnv), so the gateway catalog is
  //     irrelevant. Ask the LIVE CLI itself via the SDK `supportedModels`
  //     control request; before the lazy spawn there is no CLI to ask, so
  //     fall back to claude's stable alias set.
  // Cached module-wide with a short TTL, keyed by backend; on failure the
  // last good same-backend list is returned (stale beats empty).
  ipcMain.handle(
    IPC_CHANNELS.MODEL_LIST,
    async (event): Promise<ModelListResult> => {
      const { cliBackend } = getAppSettings()
      const now = Date.now()
      if (
        modelListCache &&
        modelListCache.key === cliBackend &&
        now - modelListCache.at < MODEL_LIST_TTL_MS
      ) {
        return { ok: true, models: modelListCache.models }
      }
      const cachedSameBackend =
        modelListCache?.key === cliBackend ? modelListCache.models : []

      if (cliBackend === 'system') {
        const live = await resolveEngine(event).listSupportedModels()
        if (live) {
          modelListCache = { key: cliBackend, models: live, at: now }
          return { ok: true, models: live }
        }
        // No live runtime (or an old CLI): serve the alias fallback WITHOUT
        // caching it, so the real list takes over on the first open after a
        // runtime spawns.
        return { ok: true, models: SYSTEM_CLAUDE_MODEL_ALIASES }
      }

      const base = (
        process.env.ANTHROPIC_BASE_URL ??
        process.env.OPENAI_BASE_URL ??
        ''
      ).replace(/\/+$/, '')
      const token =
        process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.OPENAI_API_KEY ?? ''
      if (!base) {
        return {
          ok: false,
          models: cachedSameBackend,
          error: 'No gateway base URL configured (env.json).'
        }
      }
      try {
        // Electron's net.fetch: Chromium network stack, honors the system
        // proxy config the same way the rest of the app does.
        const res = await net.fetch(`${base}/v1/models`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
        const NON_CHAT_RE = /image|audio|realtime|embedding|whisper|tts/i
        const models = (Array.isArray(body.data) ? body.data : [])
          .map((m) => (typeof m.id === 'string' ? m.id : ''))
          .filter((id) => id && !NON_CHAT_RE.test(id))
          .sort()
        modelListCache = { key: cliBackend, models, at: now }
        return { ok: true, models }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, models: cachedSameBackend, error: msg }
      }
    }
  )

  // Model switch — engine-scoped (see ChatEngine.setModel for the live +
  // future-session application semantics).
  ipcMain.handle(
    IPC_CHANNELS.MODEL_SET,
    async (event, payload: ModelSetPayload): Promise<void> => {
      const model =
        payload && typeof payload.model === 'string' && payload.model.trim()
          ? payload.model.trim()
          : null
      await resolveEngine(event).setModel(model)
    }
  )

  // Session list / load / new / switch. 统一会话管理后列表不再取调用
  // tab 的 workspace —— 扫的是 workspaceRegistry 里全部已知工作区的并
  // 集，load 按 UUID 全局定位。engine 的 workspace 只决定「新会话默认
  // 落在哪」，与读侧解耦。
  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST,
    async (): Promise<SessionListResult> => {
      const threads = await listAllSessions(await listKnownWorkspaces())
      return { threads }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_LOAD,
    async (_event, payload: SessionLoadPayload): Promise<SessionLoadResult> => {
      validateSessionLoadPayload(payload)
      const messages = await loadSession(payload.sessionId)
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
      await renameSession(
        payload.sessionId,
        payload.title,
        await listKnownWorkspaces()
      )
      // Trigger sidebar refresh — the SDK reads customTitle on its
      // next listSessions scan, so rebroadcasting picks up the new
      // value without any in-memory state to invalidate.
      engine.emit('sessionListChanged')
      return { ok: true }
    }
  )

  // 会话工作目录（composer「选择工作目录」chip）。锁定校验（已有
  // transcript / 已 send 过 → reject）在 engine.setSessionWorkspace 里，
  // 这里只做 payload 形状检查——路径合法性（绝对/存在/目录）也归 engine，
  // 与 setWorkspace 同一套规则，不在 IPC 层重复。
  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKSPACE_SET,
    async (
      event,
      payload: SessionWorkspaceSetPayload
    ): Promise<SessionWorkspaceSetResult> => {
      validateSessionWorkspaceSetPayload(payload)
      await resolveEngine(event).setSessionWorkspace(
        payload.sessionId,
        payload.path
      )
      return { ok: true }
    }
  )

  // Session content search for the search dialog (标题 matching happens
  // renderer-side over listSessions; this is the transcript scan). 与
  // SESSION_LIST 同口径：扫全部已知工作区的并集 —— no payload validation
  // beyond the query being a string, since an odd query just returns [].
  ipcMain.handle(
    IPC_CHANNELS.SESSION_SEARCH,
    async (
      _event,
      payload: SessionSearchPayload
    ): Promise<SessionSearchResult> => {
      const query = typeof payload?.query === 'string' ? payload.query : ''
      const hits = await searchSessionContent(
        await listKnownWorkspaces(),
        query
      )
      return { hits }
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
  // TAB_NEW：legacy 多 tab 架构已物理下线（Phase 4，单视图唯一）。通道保留
  // 为 no-op——preload 仍暴露 tabApi.newTab，删 handler 会让 invoke reject。
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, async (): Promise<void> => {})

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
  // shell.openPath error verbatim on failure. 统一会话管理后优先开
  // 前台会话自己的工作目录（chip 显示什么就开什么），默认工作区兜底。
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_OPEN,
    async (event): Promise<{ error: string }> => {
      const engine = resolveEngine(event)
      const workspace = engine.getActiveSessionCwd() ?? engine.getWorkspace()
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
      // 窗口底色跟主题（compositor 空隙帧的最终兜底，见 tabRegistry 注释）。
      // chat 侧任何主题变化（含 canvas 入口经即时事件触发的 store 更新）
      // 都会 push 到这里，themeMode 在快照里必带。daemon 离线也照样同步——
      // 底色是纯窗口态，不依赖写入成功。
      if (typeof patch.themeMode === 'string') syncShellBackgroundToTheme(patch.themeMode)
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
    // 无 payload 的 ping——主题可能刚变，从 daemon 补读一次 themeMode 同步
    // 窗口底色（fire-and-forget，daemon 离线就跳过，底色留待下次机会）。
    void fetchDaemonAppearance()
      .then((a) => {
        if (a && typeof a.themeMode === 'string') syncShellBackgroundToTheme(a.themeMode)
      })
      .catch(() => {})
  })

  // ── 自动更新（electron-updater，状态机在 services/appUpdater.ts）──
  // 三个 handler 都是薄转发：状态归 main 单独持有，结论走
  // UPDATER_STATE_CHANGED 推送，invoke 的返回值只是即时快照。
  ipcMain.handle(IPC_CHANNELS.UPDATER_GET_STATE, async (): Promise<UpdaterState> => {
    return getUpdaterState()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, async (): Promise<UpdaterState> => {
    return checkForUpdates()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATER_INSTALL, async (): Promise<void> => {
    installUpdate()
  })

  // ── 登录/账号（状态机在 services/authService.ts）──
  // 同 updater 的薄转发纪律：状态归 main 单独持有，迁移走
  // AUTH_STATE_CHANGED 推送；AUTH_LOGIN 的 resolve 值让发起窗口免等广播。
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_STATE, async (): Promise<AuthState> => {
    return getAuthState()
  })

  ipcMain.handle(
    IPC_CHANNELS.AUTH_LOGIN,
    async (_event, payload: AuthLoginPayload): Promise<AuthLoginResult> => {
      // 结构防御：preload 只透传，恶意/异常 payload 在此归一成失败结论
      // 而不是让 authService 对 undefined 调 .trim() 抛栈。
      if (
        !payload ||
        typeof payload.email !== 'string' ||
        typeof payload.password !== 'string'
      ) {
        return { ok: false, error: '请输入邮箱和密码' }
      }
      return login(payload)
    }
  )

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (): Promise<void> => {
    logout()
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
        action !== 'toggle-lang' &&
        action !== 'open-search'
      ) {
        return
      }
      dispatchMenuActionToActiveTab(action)
    }
  )

  // Shell session list (shell renderer → main). The shell has no engine
  // of its own, so this bypasses resolveEngine. 统一会话管理后列表本身
  // 也不需要 engine —— 直接扫已知工作区并集。仍保留「无活跃 chat tab
  // → 空列表」的闸：点击行的 switch 请求要转发给活跃 tab 执行，没有
  // tab 时列表是一排点不动的死行，不如维持现状空列表。
  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_LIST,
    async (): Promise<SessionListResult> => {
      if (!getActiveChatEngine()) return { threads: [] }
      const threads = await listAllSessions(await listKnownWorkspaces())
      return { threads }
    }
  )

  // Shell session switch (shell renderer → main → active chat tab). Mirrors
  // TAB_TRIGGER_MENU_ACTION: main forwards the request to the active chat
  // tab's renderer, which runs its existing switch flow so all chat-store
  // sync happens there (a direct engine switch from the shell would leave
  // the Thread view stale). `sessionId` null = new chat.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_SWITCH_REQUEST,
    async (_event, payload: { sessionId: string | null }): Promise<void> => {
      dispatchSessionSwitchToActiveTab(payload?.sessionId ?? null)
    }
  )

  // Shell session rename (shell renderer → main). Engine-free like
  // SHELL_SESSION_LIST: resolve the active chat workspace and append the
  // custom-title line directly. The emit at the end is the whole refresh
  // story — tabRegistry relays this engine's `sessionListChanged` to the
  // shell, and the engine's own webContents bridge sends it to the chat
  // renderer, so both lists re-pull without shell-specific plumbing.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_RENAME,
    async (_event, payload: SessionRenamePayload): Promise<void> => {
      validateSessionRenamePayload(payload)
      await renameSession(
        payload.sessionId,
        payload.title,
        await listKnownWorkspaces()
      )
      getActiveChatEngine()?.emit('sessionListChanged')
    }
  )

  // Shell session delete (shell renderer → main). Order matters:
  //   1. closeSessionRuntime FIRST — if a fusion-code child is live on this
  //      session it would keep appending to (and holding open) the jsonl
  //      we're about to unlink. No-op when no runtime exists.
  //   2. deleteSessionFromDisk — removes jsonl + subagent dir; throws on a
  //      missing session so a stale row surfaces as an error instead of a
  //      silent fake success.
  //   3. emit sessionListChanged — same double fan-out as rename above.
  // The renderer owns the confirm UI and the switch-away-if-active logic
  // (it knows the neighbouring row; main doesn't track shell selection).
  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_DELETE,
    async (_event, payload: SessionDeletePayload): Promise<void> => {
      validateSessionCloseRuntimePayload(payload)
      const engine = getActiveChatEngine()
      await engine?.closeSessionRuntime(payload.sessionId)
      await deleteSessionFromDisk(payload.sessionId)
      engine?.emit('sessionListChanged')
    }
  )

  // SETTINGS_WINDOW_*：旧的全窗设置 overlay（加载 web ?settings=1）已随
  // apps/web 物理下线——设置迁入 studio 内（/?settings=1，见 AppRail）。
  // 通道保留为 no-op，理由同 TAB_NEW。
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_OPEN, async (): Promise<void> => {})
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE, async (): Promise<void> => {})

  // Runtime-log read/clear for the「日志分析」settings section. Engine-free —
  // they touch the process-global logCollector directly. Live streaming is a
  // separate `send` channel (LOGS_STREAM); since settings moved inside the
  // studio tab (URL state main can't observe — the old openSettingsView /
  // closeSettingsView hook points are gone), the panel registers itself as
  // a push subscriber via LOGS_SUBSCRIBE on mount and LOGS_UNSUBSCRIBE on
  // unmount. Destroyed webContents are cleaned up by logCollector itself.
  ipcMain.handle(IPC_CHANNELS.LOGS_GET, async (): Promise<RuntimeLogEntry[]> => {
    return getLogs()
  })
  ipcMain.handle(IPC_CHANNELS.LOGS_CLEAR, async (): Promise<void> => {
    clearLogs()
  })
  ipcMain.handle(IPC_CHANNELS.LOGS_SUBSCRIBE, async (event): Promise<void> => {
    addLogSubscriber(event.sender)
  })
  ipcMain.handle(IPC_CHANNELS.LOGS_UNSUBSCRIBE, async (event): Promise<void> => {
    removeLogSubscriber(event.sender)
  })
  // Reveal the on-disk runtime log in the OS file manager. Prefer selecting
  // today's file; fall back to opening the logs directory when no file has
  // been written yet (or it was just deleted by 清空). mkdir first so the
  // fallback never opens a non-existent path.
  ipcMain.handle(IPC_CHANNELS.LOGS_REVEAL, async (): Promise<void> => {
    const { file, dir } = getLogFileTarget()
    if (file && existsSync(file)) {
      shell.showItemInFolder(file)
      return
    }
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Directory creation failing here is non-fatal — openPath will report.
    }
    await shell.openPath(dir)
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
    async (): Promise<{
      kbRoot: string | null
      outDir: string
      remote: KbRemoteConfig | null
      lastSync: { atMs: number; builtAtMs: number } | null
    }> => {
      const cfg = getKbConfig()
      return { kbRoot: cfg.kbRoot, outDir: kbOutDir(), remote: cfg.remote, lastSync: lastKbSyncInfo() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.KB_PATH_SET,
    async (_e, kbRoot: string): Promise<void> => {
      setKbRoot(kbRoot)
      // 重选本地根 = 本地构建在即，磁盘很快会在同步引擎之外被改写；旧同步基准
      // 不再可信，作废让下一轮远程同步退回磁盘对账（见 invalidateKbSyncBaseline 注释）。
      invalidateKbSyncBaseline()
      // 旧 worker 端着旧内存表，不会自愈——kill 触发 exit 三态复位，下次搜索 fork 新进程
      // 用新 fingerprint 重校验（见 resetEmbedWorker 注释）。
      resetEmbedWorker()
    }
  )

  ipcMain.handle(IPC_CHANNELS.KB_REMOTE_SET, async (_e, remote: KbRemoteConfig | null): Promise<void> => {
    // 入参防御：renderer 被攻破时 main 是最后防线，形状不对宁可丢弃。
    if (remote !== null && (typeof remote?.baseUrl !== 'string' || typeof remote?.kbId !== 'string')) return
    setKbRemote(remote)
    if (remote) {
      // 写入即触发：用户填完 URL 不该还要再点一次同步（spec ④）。
      triggerKbSyncNow()
    } else {
      // 切回本地模式：用户接下来大概率会跑本地构建改写 kb-index/，同步引擎不再
      // 是磁盘唯一写方，旧基准的「磁盘=上次同步」断言失效——作废它（见
      // invalidateKbSyncBaseline 注释），逼下一轮远程同步做一次磁盘对账。
      invalidateKbSyncBaseline()
      // 旧 worker 端着旧内存表，不会自愈——kill 触发 exit 三态复位，下次搜索 fork 新进程
      // 用新 fingerprint 重校验（见 resetEmbedWorker 注释）。
      resetEmbedWorker()
    }
  })

  ipcMain.handle(IPC_CHANNELS.KB_SYNC_NOW, async (): Promise<'started' | 'alreadyRunning' | 'noRemote'> =>
    triggerKbSyncNow()
  )

  ipcMain.handle(IPC_CHANNELS.KB_ROOT_PICK, async (event): Promise<{ path: string | null }> => {
    // 不能复用 WORKSPACE_PICK：那条要 resolveEngine（per-tab），设置 overlay 没有 engine。
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { path: null }
    const result = await dialog.showOpenDialog(win, {
      title: '选择知识库目录',
      properties: ['openDirectory']
    })
    return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]! }
  })

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
      return exportProposal(win, markdown, format, payload?.style, payload?.mermaidImages)
    }
  )

  // 导出 PDF（P2-2）：renderer 已用 docx-preview 把 docx 渲成自包含 HTML，这里弹保存框 +
  // 隐藏窗口 printToPDF 落盘。html 非串 → 视为非法、返回取消语义（不抛，导出反馈走「已取消」）。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_EXPORT_PDF,
    async (event, payload: ProposalExportPdfPayload): Promise<ProposalExportPdfResult> => {
      const html = typeof payload?.html === 'string' ? payload.html : ''
      if (!html) return { path: null }
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { path: null }
      const defaultPath = typeof payload?.defaultPath === 'string' ? payload.defaultPath : undefined
      return exportProposalPdf(win, html, defaultPath)
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
      // 预览也过同一接地闸门（与导出共用 collectUngroundedImagePaths）：未接地图在 docx 预览里
      // 同样降级为占位，保证「预览=导出一致」——绝不出现预览有图、成品 Word 没图（评审 AL3）。
      const ungrounded = collectUngroundedImagePaths(markdown)
      const bytes = await markdownToDocxBuffer(markdown, payload?.style, ungrounded, payload?.mermaidImages)
      return { bytes }
    }
  )

  // 「召回预览」（方案三·只读）：给定关键词 + 产品集 → 知识库 top 召回片段。与生成时的内容级
  // 召回共用 buildProposalProductScopes + retrievePassages，但【只读、不注入提示词、不写盘】。
  // 全程防御式：空 query / 无产品 / 索引不可用 / 任意异常 → 空数组，绝不 reject（叠加信号）。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_PEEK_RETRIEVAL,
    async (_event, payload: ProposalPeekRetrievalPayload): Promise<ProposalPeekRetrievalResult> => {
      try {
        const query = typeof payload?.query === 'string' ? payload.query : ''
        const products = Array.isArray(payload?.products) ? payload.products : []
        if (!query.trim() || products.length === 0) return { passages: [], scannedFiles: 0 }
        const scopes = buildProposalProductScopes(products)
        // 诊断：当前产品集在索引里匹配到的资料文件总数。0 = 产品/索引对不上（没料可搜）。
        const scannedFiles = scopes.reduce((n, s) => n + s.files.length, 0)
        const passages = retrievePassages(query, scopes, { topK: 8 })
        return {
          passages: passages.map((p) => ({ title: p.title, text: p.text, score: p.score })),
          scannedFiles
        }
      } catch {
        return { passages: [], scannedFiles: 0 }
      }
    }
  )

  // 语义搜索面板（Task 8）：混合(向量+BM25)检索，复用已有的 kbSemanticSearch 包装。
  // kbSemanticSearch 内部全防御——模型缺失/超时/stale 均降级 BM25，绝不 reject。
  // 空 query 在 handler 层短路，避免向 kbSemanticSearch 传空串触发无意义 BM25 扫全库。
  ipcMain.handle(
    IPC_CHANNELS.KB_SEMANTIC_SEARCH,
    async (_event, p: KbSemanticSearchPayload): Promise<KbSemanticSearchResult> => {
      try {
        const query = typeof p?.query === 'string' ? p.query.trim() : ''
        const products = Array.isArray(p?.products) ? p.products : []
        // 空 query 短路与异常兜底都不是「BM25 顶替语义」——hits 本身为空，degraded=false。
        if (!query) return { hits: [], staleIndex: false, degraded: false }
        const scopes = buildProposalProductScopes(products)
        return kbSemanticSearch(query, scopes, 12)
      } catch {
        return { hits: [], staleIndex: false, degraded: false }
      }
    }
  )

  // 授权目录文档扫描（知识库页「全部文件」）。engine-free：用户目录是全局的。
  // scanLocalDocs 内部全防御（TCC 拒绝→deniedDirs、异常→ok:false），绝不 reject。
  ipcMain.handle(
    IPC_CHANNELS.KB_LOCAL_DOCS_SCAN,
    async (_event, payload: LocalDocsScanPayload): Promise<LocalDocsScanResult> => {
      return scanLocalDocs(payload?.force === true)
    }
  )

  // 扫描目录清单三件套（预设开关 + 自定义增删）。持久化在 kb-config.json，
  // 见 localDocsScan.ts 的目录管理注释。
  ipcMain.handle(
    IPC_CHANNELS.KB_LOCAL_DOCS_DIRS_GET,
    async (): Promise<LocalDocsDirsResult> => {
      return { dirs: listLocalDocsDirs() }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.KB_LOCAL_DOCS_DIRS_SET,
    async (_event, payload: LocalDocsDirSetPayload): Promise<LocalDocsDirsResult> => {
      const path =
        payload && typeof payload.path === 'string' ? payload.path : ''
      if (!path || !isAbsolute(path)) {
        // 形状不对直接原样返回清单——目录管理是幂等读改写，没有值得
        // reject 的失败模式（非法路径改不动任何配置）。
        return { dirs: listLocalDocsDirs() }
      }
      return { dirs: setLocalDocsDir(path, payload?.enabled === true) }
    }
  )

  // 添加自定义扫描目录：OS 原生文件夹选择器。macOS 上「用户主动选中」即
  // 授权（user-selected access），选完即可读——不会再弹 TCC 窗。
  ipcMain.handle(
    IPC_CHANNELS.KB_LOCAL_DOCS_DIRS_PICK,
    async (event): Promise<LocalDocsDirsPickResult> => {
      const window = resolveBrowserWindow(event)
      const result = await dialog.showOpenDialog(window, {
        title: '选择要扫描的文件夹',
        buttonLabel: '添加',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { dirs: listLocalDocsDirs(), added: null }
      }
      const picked = result.filePaths[0]!
      const before = listLocalDocsDirs()
      const already = before.find((d) => d.path === picked)
      const dirs = setLocalDocsDir(picked, true)
      // 「新加入」的语义：清单里原本没有，或原本是停用的预设被重新启用。
      const added = already && already.enabled ? null : picked
      return { dirs, added }
    }
  )

  // 知识库索引（文档/图片双域）：读取 + 触发全量重建。engine-free；重建是
  // 后台长任务，invoke 立即返回、进度走 KB_CATALOG_STATUS 广播（payload 带
  // domain）。domain 统一在这里收紧成合法值（缺省/非法一律 docs）。
  const kbDomain = (payload: KbDomainPayload): 'docs' | 'images' =>
    payload?.domain === 'images' ? 'images' : 'docs'

  ipcMain.handle(IPC_CHANNELS.KB_CATALOG_GET, async (_event, payload: KbDomainPayload) => {
    const domain = kbDomain(payload)
    return { catalog: readKbCatalog(domain), status: getKbCatalogStatus(domain) }
  })

  ipcMain.handle(
    IPC_CHANNELS.KB_CATALOG_REBUILD,
    async (_event, payload: KbDomainPayload): Promise<'started' | 'alreadyRunning'> => {
      return rebuildKbCatalog(kbDomain(payload))
    }
  )

  // 类别集合（分类管理页，双域）。UPDATE 的名字/结构校验统一在 service 侧做
  // （校验失败走 result.error 中文文案，不 reject）；这里只挡形状完全不对的
  // payload——直接原样返回现状清单。
  ipcMain.handle(
    IPC_CHANNELS.KB_CATEGORIES_GET,
    async (_event, payload: KbDomainPayload): Promise<KbCategoriesResult> => {
      return { categories: readKbCategories(kbDomain(payload)), migrated: 0 }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.KB_CATEGORIES_UPDATE,
    async (_event, payload: KbCategoriesUpdatePayload): Promise<KbCategoriesResult> => {
      const domain = kbDomain(payload)
      const action = payload?.action
      if (action !== 'add' && action !== 'rename' && action !== 'remove' && action !== 'move') {
        return { categories: readKbCategories(domain), migrated: 0, error: '非法操作' }
      }
      return updateKbCategories(domain, payload)
    }
  )

  // 图片缩略图批读（「图片识别」卡片行预览）。160px nativeImage 缩放；
  // 单次上限 60 张；损坏/非绝对路径/超上限的静默缺席——预览是装饰不是数据，
  // 任何单张失败都不该打断整批。
  ipcMain.handle(
    IPC_CHANNELS.KB_IMAGE_THUMBS,
    async (_event, payload: KbImageThumbsPayload): Promise<KbImageThumbsResult> => {
      const MAX_THUMBS = 60
      const thumbs: Record<string, string> = {}
      const paths = Array.isArray(payload?.paths) ? payload.paths.slice(0, MAX_THUMBS) : []
      for (const p of paths) {
        if (typeof p !== 'string' || !isAbsolute(p)) continue
        try {
          const img = nativeImage.createFromPath(p)
          // 半写/损坏的图片解码成空图——跳过（svg 等 nativeImage 不认的格式
          // 也走这条，UI 回落到文件图标占位）。
          if (img.isEmpty()) continue
          thumbs[p] = img.resize({ width: 160 }).toDataURL()
        } catch {
          continue
        }
      }
      return { thumbs }
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

  // ── 出图/改图/设置读写（编辑器内 P 图）───────────────────────────────────
  //
  // 出图 API 凭据脱敏占位符。GET 用它替换明文 key 回给渲染进程（渲染进程内存/devtools
  // 都是比 main 进程更大的泄漏面）；SET 收到这个占位符时代表用户没重新输入 key，只改了
  // baseURL/model，需与现存 key 合并而非覆盖——见下面 SETTINGS_SET handler。
  // 定义收口在 shared（评审发现：曾是 renderer/main 两份独立字面量，任一侧改动即静默毁 key）。
  const IMAGE_API_KEY_MASK = PROPOSAL_IMAGE_API_KEY_MASK

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_IMAGE_SETTINGS_GET,
    async (): Promise<ProposalImageApiConfig | null> => {
      const cfg = getAppSettings().imageApi
      if (!cfg) return null
      return { apiKey: cfg.apiKey ? IMAGE_API_KEY_MASK : '', baseURL: cfg.baseURL, model: cfg.model }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_IMAGE_SETTINGS_SET,
    async (_event, cfg: ProposalImageApiConfig): Promise<void> => {
      if (!cfg || typeof cfg !== 'object') return
      const cur = getAppSettings().imageApi
      const apiKey = cfg.apiKey === IMAGE_API_KEY_MASK ? (cur?.apiKey ?? '') : (cfg.apiKey ?? '')
      const merged: ProposalImageApiConfig = {
        apiKey,
        baseURL: typeof cfg.baseURL === 'string' ? cfg.baseURL : (cur?.baseURL ?? ''),
        model: typeof cfg.model === 'string' && cfg.model ? cfg.model : (cur?.model ?? 'gpt-image-2')
      }
      updateAppSettings({ imageApi: merged })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_IMAGE_GENERATE,
    async (_event, args: ProposalImageGeneratePayload): Promise<ProposalImageResult> => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (!sessionId || !prompt) throw new Error('缺少会话 id 或提示词')
      const cfg = getAppSettings().imageApi
      if (!cfg?.apiKey) throw new Error('未配置出图 API，请到设置里填写 key 与地址')
      const bytes = await generateImage(cfg, { prompt })
      const path = await writeProposalImage(sessionId, 'generated', bytes, embeddableExtFor(bytes))
      return { path }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_IMAGE_EDIT,
    async (_event, args: ProposalImageEditPayload): Promise<ProposalImageResult> => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      const sourcePath = typeof args?.sourcePath === 'string' ? args.sourcePath : ''
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (!sessionId || !sourcePath || !prompt) throw new Error('缺少会话 id / 原图路径 / 提示词')
      const cfg = getAppSettings().imageApi
      if (!cfg?.apiKey) throw new Error('未配置出图 API，请到设置里填写 key 与地址')
      const sourceBytes = await readFile(sourcePath)
      const bytes = await editImage(cfg, { prompt, sourceBytes, sourceMime: mimeForImagePath(sourcePath) })
      const path = await writeProposalImage(sessionId, 'edited', bytes, embeddableExtFor(bytes))
      return { path }
    }
  )

  // 上传本地图：与 GENERATE/EDIT 不同，不调出图 API（不受未配置 apiKey 限制），只是「选文件→
  // 落盘到草稿资产目录」。用原生文件选择框而非 <input type=file>——renderer 侧拿不到选中文件
  // 的绝对磁盘路径（浏览器安全模型），必须走 main 侧 dialog 才能后续 readFile。锚定 sender 所在
  // 的 BrowserWindow，同 WORKSPACE_PICK 的 resolveBrowserWindow 用法。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_IMAGE_UPLOAD,
    async (event, args: ProposalImageUploadPayload): Promise<ProposalImageResult | null> => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      if (!sessionId) throw new Error('缺少会话 id')
      const window = resolveBrowserWindow(event)
      // 扩展名列表从 EMBEDDABLE_IMAGE_EXTS 派生而非手写——曾手写含 webp，用户选了 webp
      // 落盘插入后预览/导出双双降级成文字占位符、且无 <img> 节点连删除都点不到（评审发现）。
      // docx 嵌不了的格式就不该让用户选进来，单一事实源杜绝再漂移。
      const result = await dialog.showOpenDialog(window, {
        title: '选择要插入的图片',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: EMBEDDABLE_IMAGE_EXTS.map((e) => e.slice(1)) }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const filePath = result.filePaths[0]!
      const bytes = await readFile(filePath)
      // ext 取自选中文件本身的扩展名（去掉前导点、小写），落盘文件名与源文件格式一致；
      // 用户不可能选出没有扩展名的图片（filters 已限定），但防御性兜底成 'png'。
      const ext = extname(filePath).slice(1).toLowerCase() || 'png'
      const path = await writeProposalImage(sessionId, 'uploaded', bytes, ext)
      return { path }
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

function validateMessageId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`Invalid messageId`)
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

function validateSessionWorkspaceSetPayload(
  value: unknown
): asserts value is SessionWorkspaceSetPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid session-workspace-set payload')
  }
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) {
    throw new Error('Invalid session-workspace-set sessionId (empty or missing)')
  }
  if (v.sessionId.length > 128) {
    throw new Error('Invalid session-workspace-set sessionId (too long)')
  }
  // 只做形状检查；绝对路径/存在/目录的语义校验在 engine.setSessionWorkspace。
  if (typeof v.path !== 'string' || v.path.length === 0) {
    throw new Error('Invalid session-workspace-set path (empty or missing)')
  }
  if (v.path.length > 4096) {
    throw new Error('Invalid session-workspace-set path (too long)')
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
  // denyMessage is optional free text that gets concatenated into the
  // SDK deny message verbatim. 4000 chars comfortably covers "tell it
  // what to do instead" while keeping a paste-bomb out of the transcript.
  if (v.denyMessage !== undefined) {
    if (typeof v.denyMessage !== 'string') {
      throw new Error('Invalid permission response: denyMessage must be a string')
    }
    if (v.denyMessage.length > 4000) {
      throw new Error('Invalid permission response: denyMessage too long (max 4000)')
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
