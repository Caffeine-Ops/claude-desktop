// MUST be the first import — populates process.env from env.json before
// any module that reads auth tokens / model overrides / base URLs runs.
import './bootstrap/loadEnv'

import { app, shell, BrowserWindow } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { registerIpcHandlers } from './ipc/register'
import { createTray, destroyTray } from './tray'
import appIcon from '../../resources/icon.png?asset'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    icon: appIcon,
    webPreferences: {
      // electron-vite outputs preload as .mjs (ESM). Use the correct
      // extension — an incorrect path silently fails and leaves the
      // contextBridge-exposed globals (window.api, window.chatApi)
      // undefined in the renderer.
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.anthropic.claude-desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const mainWindow = createWindow()

  registerIpcHandlers(mainWindow)
  createTray(mainWindow)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  destroyTray()
})
