import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  IPC_CHANNELS,
  type CliBackendSetPayload,
  type CliBackendState,
  type RuntimeLogEntry
} from '../shared/ipc-channels'

/**
 * Minimal preload for the embedded settings overlay (the Open Design web
 * app loaded with `?settings=1` inside the full-window settings
 * WebContentsView — see tabRegistry.openSettingsView).
 *
 * Unlike the main preload, this exposes ONLY a single `electronSettings.close`
 * bridge — nothing else. The overlay loads the external-origin web bundle,
 * so it must not receive the full chatApi/tabApi surface. The web settings
 * page calls `window.electronSettings?.close?.()` when the user dismisses
 * the dialog (✕ / Escape / scrim), which tells main to tear the overlay
 * view down. In a plain browser the global is simply absent and the call
 * no-ops, so the same web code works in both environments.
 */
const electronSettings = {
  /** Ask main to close (destroy) the settings overlay view. */
  close(): void {
    void ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WINDOW_CLOSE)
  },

  /**
   * Read the CLI backend state (bundled fusion-code vs system claude) so the
   * embedded web settings page can render the desktop-only "CLI backend"
   * control. Engine-free path — see SETTINGS_CLI_BACKEND_GET in register.ts.
   */
  getCliBackend(): Promise<CliBackendState> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SETTINGS_CLI_BACKEND_GET
    ) as Promise<CliBackendState>
  },

  /** Persist the CLI backend choice. Returns the refreshed state. */
  setCliBackend(payload: CliBackendSetPayload): Promise<CliBackendState> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.SETTINGS_CLI_BACKEND_SET,
      payload
    ) as Promise<CliBackendState>
  },

  /**
   * Snapshot the current runtime-log ring buffer — the「日志分析」panel's
   * initial fill. Live lines after this point arrive via `onLog`.
   */
  getLogs(): Promise<RuntimeLogEntry[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.LOGS_GET) as Promise<RuntimeLogEntry[]>
  },

  /** Clear the in-memory log ring (the on-disk file is untouched). */
  clearLogs(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.LOGS_CLEAR) as Promise<void>
  },

  /**
   * Reveal the on-disk runtime log file in the OS file manager (today's
   * file selected in Finder; falls back to the logs directory). Everything
   * the panel shows — plus process-level errors — is persisted there.
   */
  revealLogFile(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.LOGS_REVEAL) as Promise<void>
  },

  /**
   * Subscribe to live runtime-log lines. Returns an unsubscribe function the
   * panel calls on unmount — without it, repeated open/close of the settings
   * overlay would stack duplicate listeners. main only sends while this view
   * is registered as a subscriber (open), so the listener is dormant
   * otherwise.
   */
  onLog(handler: (entry: RuntimeLogEntry) => void): () => void {
    const listener = (_event: IpcRendererEvent, entry: RuntimeLogEntry): void =>
      handler(entry)
    ipcRenderer.on(IPC_CHANNELS.LOGS_STREAM, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LOGS_STREAM, listener)
  },

  /**
   * Subscribe to "shared appearance changed in the daemon" pushes from main.
   * The overlay is its own webContents with its own React state, so when the
   * theme is changed elsewhere (a chat tab, or another surface) main fires
   * this and the embedded web app re-fetches /api/app-config to re-apply.
   * Returns an unsubscribe the web app calls on unmount. Dormant in a plain
   * browser (global absent → no-op).
   */
  onAppearanceChanged(handler: () => void): () => void {
    const listener = (): void => handler()
    ipcRenderer.on(IPC_CHANNELS.APPEARANCE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APPEARANCE_CHANGED, listener)
  },

  /**
   * Tell main the overlay just wrote appearance/config straight to the daemon
   * (its /api/app-config PUT bypasses main), so main broadcasts the change to
   * the other windows. Called from the web app's syncConfigToDaemon after a
   * successful PUT. Fire-and-forget.
   */
  notifyAppearanceChanged(): void {
    void ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_BROADCAST)
  }
}

export type ElectronSettingsApi = typeof electronSettings

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronSettings', electronSettings)
  } catch (err) {
    console.error('[settings-preload] exposeInMainWorld failed:', err)
  }
} else {
  // contextIsolation is on for the overlay (we set it when creating the
  // view), so this branch shouldn't run — kept for parity with the main
  // preload's fallback shape.
  // @ts-expect-error define on window for the non-isolated fallback
  window.electronSettings = electronSettings
}
