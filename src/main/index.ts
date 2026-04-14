// MUST be the first import — populates process.env from env.json before
// any module that reads auth tokens / model overrides / base URLs runs.
import './bootstrap/loadEnv'

import { app, session, shell, BrowserWindow } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { registerIpcHandlers } from './ipc/register'
import { clearUnread, createTray, destroyTray } from './tray'
import appIcon from '../../resources/icon.png?asset'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1226,
    minHeight: 778,
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

  // The unread badge in the tray / Dock is the user's only signal that
  // an assistant reply landed while the window was hidden or unfocused.
  // The instant they're back on the window, the signal has done its
  // job — clear it from both `focus` and `show` so we cover (a) bringing
  // the window to the front from another app and (b) restoring it from
  // the tray's "Show / Hide" menu item.
  const onUserReturned = (): void => clearUnread()
  mainWindow.on('focus', onUserReturned)
  mainWindow.on('show', onUserReturned)

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

  // Electron's default permission policy denies every getUserMedia
  // call, which kills the dictation adapter before the first chunk.
  // Auto-approve `media` (mic + camera) for our own app origin —
  // this is a single-origin desktop app, there's no untrusted third
  // party whose requests would need gating. `setPermissionCheckHandler`
  // covers the synchronous `navigator.permissions.query` path and
  // `setPermissionRequestHandler` covers the async prompt path that
  // getUserMedia triggers on first use.
  //
  // `clipboard-sanitized-write` is the permission Chromium checks when
  // the renderer calls `navigator.clipboard.writeText`. Without it the
  // call silently rejects, which broke the workspace tree's copy-name
  // button and the assistant code-block copy. Same single-origin
  // reasoning as `media`: the renderer is our own UI, there is no
  // untrusted third party whose clipboard writes would need gating.
  const ses = session.defaultSession
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write'])
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission)
  })

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
