import type { ElectronAPI } from '@electron-toolkit/preload'
import type { ChatApi, DesktopLogsApi, TabApi } from '../shared/ipc-channels'

/**
 * Global `Window` augmentation for the five objects the preload exposes
 * via `contextBridge.exposeInMainWorld` (see preload/index.ts). Without
 * this, every `window.chatApi.*` / `window.tabApi.*` call in the renderer
 * fails typecheck with TS2339. The preload's non-isolated fallback branch
 * even carries `// @ts-ignore (define in dts)` comments pointing here —
 * this file is that promised definition.
 *
 * `api` mirrors the local `const api = { version }` literal in
 * preload/index.ts; keep it in sync if more fields are added there.
 */
declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      version: string
    }
    chatApi: ChatApi
    tabApi: TabApi
    desktopLogs: DesktopLogsApi
  }
}

export {}
