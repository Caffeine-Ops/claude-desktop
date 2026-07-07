import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { userInfo } from 'node:os'
import type {
  ChatEvent,
  LogEvent,
  PermissionRequest,
  PermissionResponse,
  QueuedMessage,
  SessionMeta
} from '../shared/types'
import {
  IPC_CHANNELS,
  type ChatAbortPayload,
  type ChatApi,
  type ChatEventPayload,
  type ChatQueueEditPayload,
  type ChatQueueListPayload,
  type ChatQueuePromotePayload,
  type ChatQueueRemovePayload,
  type ChatSendPayload,
  type ChatSendResult,
  type FileSuggestionsListPayload,
  type FileSuggestionsListResult,
  type LogEventPayload,
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
  type CliBackendSetPayload,
  type CliBackendState,
  type DesktopLogsApi,
  type RuntimeLogEntry,
  type PermissionModeChangedPayload,
  type PermissionModeGetResult,
  type PermissionModeSetPayload,
  type UiPermissionMode,
  type AppearanceGetResult,
  type AppearanceSetPayload,
  type AppearanceSetResult,
  type ShellMenuAction,
  type ShellMenuActionPayload,
  type TabApi,
  type TabDescriptor,
  type TabListResult,
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
  type ImageFileReadPayload,
  type ImageFileReadResult,
  type ModelListResult,
  type ModelSetPayload,
  type UpdaterState,
  type WorkspacePickResult,
  type WorkspaceSetPayload,
  type WorkspaceState,
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
  type ProposalImageApiConfig,
  type ProposalImageGeneratePayload,
  type ProposalImageEditPayload,
  type ProposalImageResult,
  type ProposalImageUploadPayload
} from '../shared/ipc-channels'
import type { ProposalMetricRecord } from '../shared/proposal'
import type { KbRemoteConfig } from '../shared/kbConfig'
import type { KbSyncStatus } from '../shared/kbSyncStatus'
import type { KbBuildStatus } from '../shared/kbBuildStatus'
import type {
  KbDocsListResult,
  KbToolingStatus,
  KbImportPayload,
  KbImportResultDto,
  KbMovePayload,
  KbCategoryPayload,
  KbCategoryRenamePayload
} from '../shared/kbAdmin'

// Visible in the Electron terminal if the preload actually loads.
console.log('[preload] loaded — exposing chatApi')

/**
 * Preload script — the security boundary between the Electron main process
 * and the renderer. Exposes a small, strictly-typed chatApi via the
 * contextBridge. Every procedure in the API maps to an IPC handler
 * registered in src/main/ipc/register.ts.
 *
 * Never expose ipcRenderer directly — that would give the renderer access
 * to every channel, including unintended ones.
 */
const chatApi: ChatApi = {
  send(payload: ChatSendPayload): Promise<ChatSendResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload) as Promise<ChatSendResult>
  },

  abort(payload: ChatAbortPayload): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT, payload) as Promise<void>
  },

  queueList(payload: ChatQueueListPayload): Promise<QueuedMessage[]> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.CHAT_QUEUE_LIST,
      payload
    ) as Promise<QueuedMessage[]>
  },

  queueRemove(payload: ChatQueueRemovePayload): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.CHAT_QUEUE_REMOVE,
      payload
    ) as Promise<boolean>
  },

  queueEdit(payload: ChatQueueEditPayload): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.CHAT_QUEUE_EDIT,
      payload
    ) as Promise<boolean>
  },

  queuePromote(payload: ChatQueuePromotePayload): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.CHAT_QUEUE_PROMOTE,
      payload
    ) as Promise<boolean>
  },

  onEvent(sessionId: string, handler: (event: ChatEvent) => void): () => void {
    const listener = (_e: unknown, payload: ChatEventPayload): void => {
      if (payload.sessionId !== sessionId) return
      handler(payload.event)
    }
    ipcRenderer.on(IPC_CHANNELS.CHAT_EVENT, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.CHAT_EVENT, listener)
    }
  },

  onPermissionRequest(
    handler: (request: PermissionRequest) => void
  ): () => void {
    const listener = (_e: unknown, payload: PermissionRequest): void => {
      handler(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_REQUEST, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.PERMISSION_REQUEST, listener)
    }
  },

  onPermissionCancelled(handler: (requestId: string) => void): () => void {
    const listener = (_e: unknown, requestId: string): void => {
      handler(requestId)
    }
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_CANCELLED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.PERMISSION_CANCELLED, listener)
    }
  },

  respondPermission(response: PermissionResponse): Promise<void> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PERMISSION_RESPOND,
      response
    ) as Promise<void>
  },

  getSessionMeta(): Promise<SessionMeta> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_META_GET) as Promise<SessionMeta>
  },

  listFileSuggestions(
    payload?: FileSuggestionsListPayload
  ): Promise<FileSuggestionsListResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.FILE_SUGGESTIONS_LIST,
      payload
    ) as Promise<FileSuggestionsListResult>
  },

  getWorkspace(): Promise<WorkspaceState> {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET) as Promise<WorkspaceState>
  },

  setWorkspace(payload: WorkspaceSetPayload): Promise<WorkspaceState> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_SET,
      payload
    ) as Promise<WorkspaceState>
  },

  pickWorkspace(): Promise<WorkspacePickResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_PICK
    ) as Promise<WorkspacePickResult>
  },

  /**
   * Resolve a File object to its disk path. `webUtils.getPathForFile`
   * is the Electron 33+ replacement for `File.path`, which is
   * deprecated and removed in contextIsolation-enabled renderers.
   *
   * The File object comes from a native DataTransfer on a drop event,
   * so it already carries the reference that `getPathForFile` needs.
   * Empty string on a synthetic / blob-backed File — the caller treats
   * that as invalid input.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch (err) {
      console.error('[preload] getPathForFile failed:', err)
      return ''
    }
  },

  openFile(
    payload: WorkspaceFileOpenPayload
  ): Promise<WorkspaceFileOpenResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.WORKSPACE_FILE_OPEN,
      payload
    ) as Promise<WorkspaceFileOpenResult>
  },

  openPath(payload: ShellOpenPathPayload): Promise<ShellOpenPathResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SHELL_OPEN_PATH,
      payload
    ) as Promise<ShellOpenPathResult>
  },

  statFiles(payload: ShellStatFilesPayload): Promise<ShellStatFilesResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SHELL_STAT_FILES,
      payload
    ) as Promise<ShellStatFilesResult>
  },

  revealPath(payload: ShellRevealPathPayload): Promise<ShellRevealPathResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SHELL_REVEAL_PATH,
      payload
    ) as Promise<ShellRevealPathResult>
  },

  readImageManifest(payload: ImageManifestReadPayload): Promise<ImageManifestReadResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.IMAGE_MANIFEST_READ,
      payload
    ) as Promise<ImageManifestReadResult>
  },

  readImageFile(payload: ImageFileReadPayload): Promise<ImageFileReadResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.IMAGE_FILE_READ,
      payload
    ) as Promise<ImageFileReadResult>
  },

  listModels(): Promise<ModelListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.MODEL_LIST) as Promise<ModelListResult>
  },

  setModel(model: string | null): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.MODEL_SET, {
      model
    } satisfies ModelSetPayload) as Promise<void>
  },

  listSessions(): Promise<SessionListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST) as Promise<SessionListResult>
  },

  searchSessions(payload: SessionSearchPayload): Promise<SessionSearchResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_SEARCH,
      payload
    ) as Promise<SessionSearchResult>
  },

  loadSession(payload: SessionLoadPayload): Promise<SessionLoadResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_LOAD,
      payload
    ) as Promise<SessionLoadResult>
  },

  newSession(): Promise<SessionNewResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_NEW) as Promise<SessionNewResult>
  },

  switchSession(payload: SessionSwitchPayload): Promise<SessionSwitchResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_SWITCH,
      payload
    ) as Promise<SessionSwitchResult>
  },

  renameSession(payload: SessionRenamePayload): Promise<SessionRenameResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_RENAME,
      payload
    ) as Promise<SessionRenameResult>
  },

  listActiveRuntimeIds(): Promise<SessionListActiveRuntimesResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_LIST_ACTIVE_RUNTIMES
    ) as Promise<SessionListActiveRuntimesResult>
  },

  closeSessionRuntime(
    payload: SessionCloseRuntimePayload
  ): Promise<SessionCloseRuntimeResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_CLOSE_RUNTIME,
      payload
    ) as Promise<SessionCloseRuntimeResult>
  },

  onSessionListChanged(handler: () => void): () => void {
    const listener = (): void => {
      handler()
    }
    ipcRenderer.on(IPC_CHANNELS.SESSION_LIST_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.SESSION_LIST_CHANGED, listener)
    }
  },

  onSessionMetaChanged(handler: () => void): () => void {
    const listener = (): void => {
      handler()
    }
    ipcRenderer.on(IPC_CHANNELS.SESSION_META_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.SESSION_META_CHANGED, listener)
    }
  },

  onLogEvent(handler: (event: LogEvent) => void): () => void {
    const listener = (_: unknown, payload: LogEventPayload): void => {
      handler(payload.event)
    }
    ipcRenderer.on(IPC_CHANNELS.LOG_EVENT, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.LOG_EVENT, listener)
    }
  },

  relaunchApp(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_RELAUNCH) as Promise<void>
  },

  newWorkspaceTab(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.TAB_NEW) as Promise<void>
  },

  openClaudeDir(): Promise<{ error: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_CLAUDE_DIR) as Promise<{
      error: string
    }>
  },

  openWorkspace(): Promise<{ error: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN) as Promise<{
      error: string
    }>
  },

  // Read once at preload load. `os.userInfo()` throws on some sandboxed
  // OS configs (rare) — fall back to an empty string and let the UI
  // render a generic placeholder rather than crashing the whole bridge.
  osUser: ((): string => {
    try {
      return userInfo().username || ''
    } catch {
      return ''
    }
  })(),

  setLang(lang: 'zh' | 'en'): void {
    ipcRenderer.send(IPC_CHANNELS.LANG_CHANGED, { lang })
  },

  transcribeAudio(
    payload: TranscribeAudioPayload
  ): Promise<TranscribeAudioResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.TRANSCRIBE_AUDIO,
      payload
    ) as Promise<TranscribeAudioResult>
  },

  getCliBackend(): Promise<CliBackendState> {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_BACKEND_GET) as Promise<CliBackendState>
  },

  setCliBackend(payload: CliBackendSetPayload): Promise<CliBackendState> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.CLI_BACKEND_SET,
      payload
    ) as Promise<CliBackendState>
  },

  getPermissionMode(): Promise<PermissionModeGetResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PERMISSION_MODE_GET
    ) as Promise<PermissionModeGetResult>
  },

  setPermissionMode(payload: PermissionModeSetPayload): Promise<void> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PERMISSION_MODE_SET,
      payload
    ) as Promise<void>
  },

  onPermissionModeChanged(
    handler: (mode: UiPermissionMode) => void
  ): () => void {
    const listener = (_e: unknown, payload: PermissionModeChangedPayload): void => {
      handler(payload.mode)
    }
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_MODE_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.PERMISSION_MODE_CHANGED, listener)
    }
  },

  getAppearance(): Promise<AppearanceGetResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.APPEARANCE_GET
    ) as Promise<AppearanceGetResult>
  },

  setAppearance(payload: AppearanceSetPayload): Promise<AppearanceSetResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.APPEARANCE_SET,
      payload
    ) as Promise<AppearanceSetResult>
  },

  onAppearanceChanged(handler: () => void): () => void {
    const listener = (): void => handler()
    ipcRenderer.on(IPC_CHANNELS.APPEARANCE_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.APPEARANCE_CHANGED, listener)
    }
  },

  onShellMenuAction(handler: (action: ShellMenuAction) => void): () => void {
    const listener = (_e: unknown, payload: ShellMenuActionPayload): void => {
      handler(payload.action)
    }
    ipcRenderer.on(IPC_CHANNELS.SHELL_MENU_ACTION, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.SHELL_MENU_ACTION, listener)
    }
  },

  onShellSessionSwitch(
    handler: (sessionId: string | null) => void
  ): () => void {
    const listener = (_e: unknown, payload: { sessionId: string | null }): void => {
      handler(payload?.sessionId ?? null)
    }
    ipcRenderer.on(IPC_CHANNELS.SHELL_SESSION_SWITCH, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.SHELL_SESSION_SWITCH, listener)
    }
  },

  closeSettingsWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE) as Promise<void>
  },

  getUpdaterState(): Promise<UpdaterState> {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATER_GET_STATE) as Promise<UpdaterState>
  },

  checkForUpdates(): Promise<UpdaterState> {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CHECK) as Promise<UpdaterState>
  },

  installUpdate(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATER_INSTALL) as Promise<void>
  },

  onUpdaterStateChanged(handler: (state: UpdaterState) => void): () => void {
    const listener = (_e: unknown, state: UpdaterState): void => handler(state)
    ipcRenderer.on(IPC_CHANNELS.UPDATER_STATE_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.UPDATER_STATE_CHANGED, listener)
    }
  },
  getKbPath(): Promise<{
    kbRoot: string | null
    outDir: string
    remote: KbRemoteConfig | null
    lastSync: { atMs: number; builtAtMs: number } | null
  }> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_PATH_GET) as Promise<{
      kbRoot: string | null
      outDir: string
      remote: KbRemoteConfig | null
      lastSync: { atMs: number; builtAtMs: number } | null
    }>
  },

  setKbPath(kbRoot: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_PATH_SET, kbRoot) as Promise<void>
  },

  setKbRemote(remote: KbRemoteConfig | null): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_REMOTE_SET, remote) as Promise<void>
  },

  kbSyncNow(): Promise<'started' | 'alreadyRunning' | 'noRemote'> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_SYNC_NOW) as Promise<'started' | 'alreadyRunning' | 'noRemote'>
  },

  pickKbRoot(): Promise<{ path: string | null }> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_ROOT_PICK) as Promise<{ path: string | null }>
  },

  onKbSyncStatus(cb: (s: KbSyncStatus) => void): () => void {
    const listener = (_e: unknown, payload: KbSyncStatus): void => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.KB_SYNC_STATUS, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.KB_SYNC_STATUS, listener)
    }
  },

  readKbIndex() {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_INDEX_READ)
  },

  exportProposal(payload: ProposalExportPayload): Promise<ProposalExportResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_EXPORT,
      payload
    ) as Promise<ProposalExportResult>
  },

  exportProposalPdf(payload: ProposalExportPdfPayload): Promise<ProposalExportPdfResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_EXPORT_PDF,
      payload
    ) as Promise<ProposalExportPdfResult>
  },

  renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_RENDER,
      payload
    ) as Promise<ProposalRenderResult>
  },
  verifyProposalCitations(payload: ProposalVerifyPayload): Promise<ProposalVerifyResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_VERIFY,
      payload
    ) as Promise<ProposalVerifyResult>
  },
  saveProposalDraft(record: ProposalDraftRecord): Promise<ProposalSaveDraftResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_SAVE_DRAFT,
      record
    ) as Promise<ProposalSaveDraftResult>
  },
  loadProposalDraft(
    payload: ProposalLoadDraftPayload
  ): Promise<ProposalDraftRecord | null> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_LOAD_DRAFT,
      payload
    ) as Promise<ProposalDraftRecord | null>
  },
  deleteProposalDraft(
    payload: ProposalDeleteDraftPayload
  ): Promise<ProposalDeleteDraftResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_DELETE_DRAFT,
      payload
    ) as Promise<ProposalDeleteDraftResult>
  },
  logProposalMetric(record: ProposalMetricRecord): Promise<ProposalMetricLogResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_METRIC_LOG,
      record
    ) as Promise<ProposalMetricLogResult>
  },
  peekProposalRetrieval(
    payload: ProposalPeekRetrievalPayload
  ): Promise<ProposalPeekRetrievalResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_PEEK_RETRIEVAL,
      payload
    ) as Promise<ProposalPeekRetrievalResult>
  },
  kbSemanticSearch(payload: KbSemanticSearchPayload): Promise<KbSemanticSearchResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.KB_SEMANTIC_SEARCH,
      payload
    ) as Promise<KbSemanticSearchResult>
  },

  // ── KB 托管仓库管理页（P2）──────────────────────────────────────
  kbDocsList(): Promise<KbDocsListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_DOCS_LIST) as Promise<KbDocsListResult>
  },
  kbToolingCheck(): Promise<KbToolingStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_TOOLING_CHECK) as Promise<KbToolingStatus>
  },
  kbPickImportFiles(): Promise<{ paths: string[] }> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_IMPORT_PICK) as Promise<{ paths: string[] }>
  },
  kbImport(payload: KbImportPayload): Promise<KbImportResultDto> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_IMPORT, payload) as Promise<KbImportResultDto>
  },
  kbDeleteDoc(relPath: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_DELETE, relPath) as Promise<void>
  },
  kbMoveDoc(payload: KbMovePayload): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_MOVE, payload) as Promise<string>
  },
  kbRetryDoc(relPath: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_RETRY, relPath) as Promise<void>
  },
  kbCreateCategory(payload: KbCategoryPayload): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_CATEGORY_CREATE, payload) as Promise<void>
  },
  kbRenameCategory(payload: KbCategoryRenamePayload): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_CATEGORY_RENAME, payload) as Promise<void>
  },
  kbDeleteCategory(prefix: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_CATEGORY_DELETE, prefix) as Promise<void>
  },
  kbDocOpenSource(relPath: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_OPEN_SOURCE, relPath) as Promise<void>
  },
  kbDocPreview(relPath: string): Promise<{ text: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_DOC_PREVIEW, relPath) as Promise<{ text: string }>
  },
  kbMigrateFromFolder(): Promise<{ imported: number } | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_MIGRATE_FROM_FOLDER) as Promise<{ imported: number } | null>
  },
  kbBuildStatusGet(): Promise<KbBuildStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_BUILD_STATUS_GET) as Promise<KbBuildStatus>
  },
  onKbBuildStatus(cb: (s: KbBuildStatus) => void): () => void {
    const listener = (_e: unknown, payload: KbBuildStatus): void => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.KB_BUILD_STATUS, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.KB_BUILD_STATUS, listener)
    }
  },

  proposalImageSettingsGet(): Promise<ProposalImageApiConfig | null> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_IMAGE_SETTINGS_GET
    ) as Promise<ProposalImageApiConfig | null>
  },
  proposalImageSettingsSet(cfg: ProposalImageApiConfig): Promise<void> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_IMAGE_SETTINGS_SET,
      cfg
    ) as Promise<void>
  },
  proposalImageGenerate(
    args: ProposalImageGeneratePayload
  ): Promise<ProposalImageResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_IMAGE_GENERATE,
      args
    ) as Promise<ProposalImageResult>
  },
  proposalImageEdit(args: ProposalImageEditPayload): Promise<ProposalImageResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_IMAGE_EDIT,
      args
    ) as Promise<ProposalImageResult>
  },
  proposalImageUpload(args: ProposalImageUploadPayload): Promise<ProposalImageResult | null> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_IMAGE_UPLOAD,
      args
    ) as Promise<ProposalImageResult | null>
  }
}

/**
 * Tab bar API for the shell renderer (query string ?shell=1). The
 * same preload serves both the shell and each tab's workspace
 * renderer, so we expose `tabApi` globally — workspace renderers
 * simply don't import it. Keeping one preload means one contextBridge
 * surface to review for security.
 */
const tabApi: TabApi = {
  newTab(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.TAB_NEW) as Promise<void>
  },

  switchTab(id: number): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.TAB_SWITCH, { id }) as Promise<void>
  },

  closeTab(id: number): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.TAB_CLOSE, { id }) as Promise<void>
  },

  listTabs(): Promise<TabListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.TAB_LIST_GET) as Promise<TabListResult>
  },

  onTabListChanged(handler: (tabs: TabDescriptor[]) => void): () => void {
    const listener = (_e: unknown, payload: TabDescriptor[]): void => {
      handler(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.TAB_LIST_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.TAB_LIST_CHANGED, listener)
    }
  },

  triggerMenuAction(action: ShellMenuAction): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.TAB_TRIGGER_MENU_ACTION, {
      action
    }) as Promise<void>
  },

  openSettingsWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WINDOW_OPEN) as Promise<void>
  },

  getFullscreen(): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.SHELL_FULLSCREEN_GET) as Promise<boolean>
  },

  onFullscreenChanged(handler: (fullscreen: boolean) => void): () => void {
    const listener = (_e: unknown, payload: boolean): void => {
      handler(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.SHELL_FULLSCREEN_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.SHELL_FULLSCREEN_CHANGED, listener)
    }
  },

  listShellSessions(): Promise<SessionListResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SHELL_SESSION_LIST
    ) as Promise<SessionListResult>
  },

  switchShellSession(sessionId: string | null): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_SWITCH_REQUEST, {
      sessionId
    }) as Promise<void>
  },

  onShellSessionListChanged(handler: () => void): () => void {
    const listener = (): void => {
      handler()
    }
    ipcRenderer.on(IPC_CHANNELS.SHELL_SESSION_LIST_CHANGED, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.SHELL_SESSION_LIST_CHANGED, listener)
    }
  },

  renameShellSession(payload: SessionRenamePayload): Promise<void> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SHELL_SESSION_RENAME,
      payload
    ) as Promise<void>
  },

  deleteShellSession(payload: SessionDeletePayload): Promise<void> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SHELL_SESSION_DELETE,
      payload
    ) as Promise<void>
  }
}

/**
 * How many onLog subscriptions are live in this webContents. main only
 * needs to know about the 0↔1 edges: it streams per-webContents, so a
 * second panel subscribing must NOT re-invoke LOGS_SUBSCRIBE (harmless)
 * but more importantly its unsubscribe must not tear down the stream the
 * first panel still relies on — hence refcount instead of subscribe/
 * unsubscribe per listener.
 */
let logStreamRefs = 0

/**
 * Runtime-log bridge for the「日志分析」settings section. Lives on its own
 * global (`window.desktopLogs`) rather than resurrecting the dead settings
 * overlay's `electronSettings` — App.tsx treats the ABSENCE of that name as
 * the unified-studio mode signal (see DesktopLogsApi's doc comment).
 */
const desktopLogs: DesktopLogsApi = {
  getLogs(): Promise<RuntimeLogEntry[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.LOGS_GET) as Promise<RuntimeLogEntry[]>
  },

  clearLogs(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.LOGS_CLEAR) as Promise<void>
  },

  revealLogFile(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.LOGS_REVEAL) as Promise<void>
  },

  onLog(handler: (entry: RuntimeLogEntry) => void): () => void {
    const listener = (_e: unknown, entry: RuntimeLogEntry): void => {
      handler(entry)
    }
    ipcRenderer.on(IPC_CHANNELS.LOGS_STREAM, listener)
    if (++logStreamRefs === 1) {
      void ipcRenderer.invoke(IPC_CHANNELS.LOGS_SUBSCRIBE)
    }
    let disposed = false
    return () => {
      // Idempotence guard: React strict-mode effects (and defensive callers)
      // may run an unsubscribe twice; a double decrement would wedge the
      // refcount below zero and break the next subscriber's 0→1 edge.
      if (disposed) return
      disposed = true
      ipcRenderer.off(IPC_CHANNELS.LOGS_STREAM, listener)
      if (--logStreamRefs === 0) {
        void ipcRenderer.invoke(IPC_CHANNELS.LOGS_UNSUBSCRIBE)
      }
    }
  }
}

const api = {
  version: '0.0.1'
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('chatApi', chatApi)
    contextBridge.exposeInMainWorld('tabApi', tabApi)
    contextBridge.exposeInMainWorld('desktopLogs', desktopLogs)
  } catch (error) {
    // ⚠️ 任何一个 expose 抛错都会让后续的**整体跳过**（chatApi/tabApi
    // 一起消失），页面侧表现为 HostGate 判定「浏览器直开」。带前缀打日志，
    // 排查「壳内却说未注入」这类问题时先搜这一条。
    console.error('[preload] exposeInMainWorld failed — chatApi/tabApi may be missing:', error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.chatApi = chatApi
  // @ts-ignore (define in dts)
  window.tabApi = tabApi
  // @ts-ignore (define in dts)
  window.desktopLogs = desktopLogs
}
