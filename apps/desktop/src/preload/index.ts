import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { userInfo } from 'node:os'
import type {
  ChatEvent,
  LogEvent,
  PermissionRequest,
  PermissionResponse,
  SessionMeta
} from '../shared/types'
import {
  IPC_CHANNELS,
  type ChatAbortPayload,
  type ChatApi,
  type ChatEventPayload,
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
  type SessionRenameResult,
  type SessionSwitchPayload,
  type SessionSwitchResult,
  type CliBackendSetPayload,
  type CliBackendState,
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
  type WorkspacePickResult,
  type WorkspaceSetPayload,
  type WorkspaceState,
  type ProposalExportPayload,
  type ProposalExportResult
} from '../shared/ipc-channels'

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

  listSessions(): Promise<SessionListResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST) as Promise<SessionListResult>
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

  closeSettingsWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE) as Promise<void>
  },

  getKbPath(): Promise<{ kbRoot: string | null; outDir: string }> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_PATH_GET) as Promise<{
      kbRoot: string | null
      outDir: string
    }>
  },

  setKbPath(kbRoot: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_PATH_SET, kbRoot) as Promise<void>
  },

  readKbIndex() {
    return ipcRenderer.invoke(IPC_CHANNELS.KB_INDEX_READ)
  },

  exportProposal(payload: ProposalExportPayload): Promise<ProposalExportResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_EXPORT,
      payload
    ) as Promise<ProposalExportResult>
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
  } catch (error) {
    console.error(error)
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
}
