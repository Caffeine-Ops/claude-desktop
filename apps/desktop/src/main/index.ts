// MUST be the first import — populates process.env from env.json before
// any module that reads auth tokens / model overrides / base URLs runs.
import './bootstrap/loadEnv'

import { patchConsole, attachRendererCapture } from './core/logCollector'

// Tap this process's console.* as early as possible so the「日志分析」panel
// captures everything after env load. Idempotent; the file sink opens lazily
// on first write (after app ready), so calling it here is safe. The two
// `[loadEnv]` lines printed by the import above run before this and aren't
// captured — an acceptable gap for the very first startup lines.
patchConsole()

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, Menu, protocol, session, webContents, type MenuItemConstructorOptions } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import { registerIpcHandlers, showMaxTabsDialog } from './ipc/register'
import { createTray, destroyTray } from './tray'
import {
  canAddTab,
  createShellWindow,
  getShellWindow,
  newTab,
  newWebTab
} from './tabRegistry'
import {
  startOpenDesignServices,
  stopOpenDesignServices,
  waitForDaemonReady,
  waitForWebReady
} from './services/openDesignServices'
import { APP_SCHEME, registerAppProtocol } from './services/appProtocol'

const __dirname = dirname(fileURLToPath(import.meta.url))

// app:// 协议必须在 app.whenReady() **之前**声明为 privileged，否则它拿不到
// standard/secure 权限：相对路径 fetch('/api/...')、history pushState、安全上下文
// （getUserMedia/clipboard 等）全部失效。registerSchemesAsPrivileged 只能在 ready
// 前调用一次，所以放在模块顶层。实际的 protocol.handle 在 ready 回调里注册。
//   - standard：URL 按标准解析（有 origin、相对路径解析正确）。
//   - secure：视作安全上下文，允许 Service Worker / 安全 API，且不被混合内容拦。
//   - supportFetchAPI：handler 可返回标准 Response（我们用它读盘 + 反代 daemon）。
//   - stream：支持流式响应（daemon /api/chat 的 SSE）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true
    }
  }
])

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

  // 自定义 viewMenu 而非用 `{ role: 'viewMenu' }`：默认 viewMenu role 自带的
  // 「Toggle Developer Tools / ⌘⌥I」会对当前聚焦的 webContents 以**默认停靠**模式
  // 打开 DevTools，而菜单加速键优先级高于 webContents 的 before-input-event，所以
  // tabRegistry.forceDetachedDevTools 的快捷键拦截根本轮不到执行——表现为「DevTools
  // 仍被全屏 WebContentsView 挡住」。这里把 DevTools 项换成我们自己的 detach 版本，
  // 其余项（reload / zoom / fullscreen）保留默认 role 行为。
  const viewMenu: MenuItemConstructorOptions = {
    label: '&View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      {
        label: 'Toggle Developer Tools',
        accelerator: isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
        click: () => {
          // 对当前聚焦的 webContents（某个 tab 的 WebContentsView，或 shell 窗）
          // 强制 detach 打开/关闭，避开被全屏 view 遮挡。
          const wc = webContents.getFocusedWebContents()
          if (!wc || wc.isDestroyed()) return
          if (wc.isDevToolsOpened()) {
            wc.closeDevTools()
          } else {
            wc.openDevTools({ mode: 'detach' })
          }
        }
      },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    fileMenu,
    { role: 'editMenu' },
    viewMenu,
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

  // Forward every renderer's console into the runtime-log collector so the
  // 「日志分析」panel sees tab / shell / overlay console output too. One hook
  // covers all WebContentsViews (tabs, shell, settings overlay) without
  // touching each creation site; the collector skips the overlay's own
  // console to avoid feeding the panel its own render noise.
  app.on('web-contents-created', (_event, contents) => {
    attachRendererCapture(contents)
  })

  Menu.setApplicationMenu(buildMenu())

  // IPC handlers route to the target engine via event.sender.id ↔
  // tabRegistry, so we register them exactly once at startup —
  // there's no per-tab wiring to refresh.
  registerIpcHandlers()

  // 启动 Open Design 服务（daemon + dev 下 web dev server）。同步返回，
  // 子进程在后台拉起；第二个 tab 等它们就绪后再开（见下方 IIFE）。
  // 必须先于 registerAppProtocol——后者的 resolveWebStaticDir 依赖这里缓存的 repoRoot。
  startOpenDesignServices(__dirname)

  // prod 下注册 app:// 协议 handler，web tab 从磁盘 out/ 读页面、把 /api 反代给
  // daemon（见 appProtocol.ts）。dev 不注册：web tab 走 next dev 的 localhost:3000
  // 保留 HMR，根本不会请求 app://。
  if (!is.dev) {
    registerAppProtocol()
  }

  // Boot the single shell window (tab bar) then open the first tab
  // so the user lands directly in a workspace gate rather than an
  // empty chrome. Both calls are idempotent: createShellWindow
  // returns the existing window on re-entry, and the first newTab
  // is what the user would've done via ⌘T anyway.
  //
  // 第一个 tab = chat 工作区（本仓原有功能），立即打开，不依赖 daemon/web。
  createShellWindow()
  newTab()

  // 第二个 tab = Open Design web。必须等 daemon（+ dev 下 web dev server）
  // 就绪后再开，否则 WebContentsView 会加载到一个还没起好的端口而白屏。
  // 用 IIFE 异步等待，不阻塞 whenReady 的其余初始化（tray 等）。
  void (async () => {
    const daemonOk = await waitForDaemonReady()
    const webOk = await waitForWebReady()
    if (!daemonOk || !webOk) {
      console.warn(
        `[main] Open Design services not ready (daemon=${daemonOk} web=${webOk}); web tab 仍会打开但可能需手动刷新`
      )
    }
    try {
      if (canAddTab()) newWebTab()
    } catch (err) {
      console.warn('[main] newWebTab failed:', err)
    }
  })()

  createTray(() => getShellWindow())

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 窗口全关后重新激活（macOS dock 点击）：重建 shell + chat tab，
      // 并补回 Open Design web tab。和首启不同，这里 daemon/web 早已就绪
      // （startOpenDesignServices 只在 before-quit 时才停），所以无需再等
      // waitForDaemonReady——直接同步补 web tab 即可。chat 先建保证它是
      // 前台，web 在后台（newWebTab 不抢占激活），与首启表现一致。
      createShellWindow()
      newTab()
      try {
        if (canAddTab()) newWebTab()
      } catch (err) {
        console.warn('[main] newWebTab on activate failed:', err)
      }
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
  // 清理 daemon / web dev 子进程，避免退出后变孤儿进程占着 7456 / 3000。
  stopOpenDesignServices()
})
