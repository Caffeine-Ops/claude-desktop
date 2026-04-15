// MUST be the first import — populates process.env from env.json before
// any module that reads auth tokens / model overrides / base URLs runs.
import './bootstrap/loadEnv'

import { app, BrowserWindow, Menu, session, type MenuItemConstructorOptions } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'

import { registerIpcHandlers, showMaxTabsDialog } from './ipc/register'
import { createTray, destroyTray } from './tray'
import {
  canAddTab,
  createShellWindow,
  getShellWindow,
  newTab
} from './tabRegistry'

/**
 * Build the application menu. The tab-bar entry point is "File →
 * New Tab" (⌘T), matching how every browser handles it. Everything
 * else is pulled from Electron's built-in roles so keyboard
 * shortcuts (copy/paste/devtools/…) keep working without us
 * re-implementing them.
 */
function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: '&File',
    submenu: [
      {
        label: 'New Tab',
        accelerator: 'CmdOrCtrl+T',
        click: () => {
          // Same gate the TAB_NEW IPC handler uses: show the
          // user a native dialog instead of silently refusing
          // when the cap is reached. `newTab()` itself also
          // throws on cap, so we belt-and-suspenders the check
          // to keep the menu click from landing on a pump that
          // throws into the void.
          if (!canAddTab()) {
            void showMaxTabsDialog()
            return
          }
          try {
            newTab()
          } catch (err) {
            console.warn('[main] newTab from menu failed:', err)
          }
        }
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    fileMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  return Menu.buildFromTemplate(template)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.anthropic.claude-desktop')

  // Electron's default permission policy denies every getUserMedia
  // call, which kills the dictation adapter before the first chunk.
  // Auto-approve `media` (mic + camera) for our own app origin —
  // this is a single-origin desktop app, there's no untrusted third
  // party whose requests would need gating. Same reasoning for
  // `clipboard-sanitized-write` (code-block copy / file-tree copy).
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

  Menu.setApplicationMenu(buildMenu())

  // IPC handlers route to the target engine via event.sender.id ↔
  // tabRegistry, so we register them exactly once at startup —
  // there's no per-tab wiring to refresh.
  registerIpcHandlers()

  // Boot the single shell window (tab bar) then open the first tab
  // so the user lands directly in a workspace gate rather than an
  // empty chrome. Both calls are idempotent: createShellWindow
  // returns the existing window on re-entry, and the first newTab
  // is what the user would've done via ⌘T anyway.
  createShellWindow()
  newTab()

  createTray(() => getShellWindow())

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createShellWindow()
      newTab()
    }
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
