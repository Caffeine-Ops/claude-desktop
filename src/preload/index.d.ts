import { ElectronAPI } from '@electron-toolkit/preload'
import type { ChatApi, TabApi } from '../shared/ipc-channels'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      version: string
    }
    chatApi: ChatApi
    tabApi: TabApi
  }
}
