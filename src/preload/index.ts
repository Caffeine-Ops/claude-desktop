import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ChatEvent,
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
  type SessionListResult,
  type SessionLoadPayload,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionSwitchPayload,
  type SessionSwitchResult,
  type WorkspaceFileOpenPayload,
  type WorkspaceFileOpenResult,
  type WorkspaceSetPayload,
  type WorkspaceState
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

  relaunchApp(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_RELAUNCH) as Promise<void>
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
}
