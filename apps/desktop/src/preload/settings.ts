import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  type CliBackendSetPayload,
  type CliBackendState
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
