// MUST be the first import — populates process.env from env.json before
// any module that reads auth tokens / model overrides / base URLs runs.
import './bootstrap/loadEnv'

import { patchConsole, patchProcessEvents, attachRendererCapture } from './core/logCollector'

// Tap this process's console.* as early as possible so the「日志分析」panel
// captures everything after env load. Idempotent; the file sink opens lazily
// on first write (after app ready), so calling it here is safe. The two
// `[loadEnv]` lines printed by the import above run before this and aren't
// captured — an acceptable gap for the very first startup lines.
patchConsole()
// Also tap process-level signals (unhandledRejection / uncaughtException /
// process warnings) — they write straight to stderr without touching
// console.*, so before this they only ever flashed by in the terminal.
patchProcessEvents()

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, Menu, protocol, session, webContents, type MenuItemConstructorOptions } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'

// TEMP-DEBUG: dev 下开远程调试端口，便于用 Chrome DevTools 连进 web tab 的
// webContents 对比渲染差异。定根后移除。必须在 app ready 前 append。
if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
  app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:9222')
}

import { registerIpcHandlers } from './ipc/register'
import { createTray, destroyTray } from './tray'
import {
  createShellWindow,
  getActiveTabWebContents,
  getShellWindow,
  newStudioTab
} from './tabRegistry'
import {
  startOpenDesignServices,
  stopOpenDesignServices,
  waitForDaemonReady,
  waitForStudioReady
} from './services/openDesignServices'
import { APP_SCHEME, registerAppProtocol } from './services/appProtocol'
import { checkForUpdatesInteractive, initAppUpdater } from './services/appUpdater'

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

  // 「检查更新…」：mac 放 app 菜单（About 下面，平台惯例位），其余平台放
  // File 菜单。结论用原生对话框反馈（见 checkForUpdatesInteractive）——
  // 菜单没有可驻留的状态面，弹框是同步反馈的唯一去处；设置页的
  // 「更新应用」section 与它共用同一条 main 侧状态流。
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: isMac ? '检查更新…' : '检查更新',
    click: () => {
      void checkForUpdatesInteractive()
    }
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: '&File',
    submenu: [
      // 「New Tab / ⌘T」已随 legacy 多 tab 架构下线（Phase 4）：单视图形态
      // 全 app 只有一个全屏 studio tab，多开没有意义。
      ...(isMac ? [] : [checkForUpdatesItem, { type: 'separator' } as MenuItemConstructorOptions]),
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
          // **优先指向活跃的 studio tab**，其次才是聚焦的 webContents。
          // 单视图形态下用户想检查的永远是 studio 页面；而聚焦的 webContents
          // 很可能是 shell 的静态 splash（启动后焦点默认在它上面）甚至某个
          // DevTools 窗口自身——按焦点分发会打开错误目标。detach 打开，
          // 避开被全屏 view 遮挡。
          const wc = getActiveTabWebContents() ?? webContents.getFocusedWebContents()
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

  // mac app 菜单：展开默认 appMenu role 只为在 About 后插「检查更新…」，
  // 其余项与 Electron 默认 appMenu 逐项一致（少一项都会丢平台标配行为）。
  const macAppMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      checkForUpdatesItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    { role: 'editMenu' },
    viewMenu,
    { role: 'windowMenu' }
  ]

  return Menu.buildFromTemplate(template)
}

app.whenReady().then(async () => {
  // 与 package.json build.appId 保持一致（Windows AUMID，通知/任务栏分组
  // 按它归属）。2026-07-05 随 appId 一起从 com.anthropic.* 改名，见
  // package.json 的 //note-appId。
  electronApp.setAppUserModelId('com.caffeineops.claude-desktop')

  // Electron's default permission policy denies every getUserMedia
  // call, which kills the dictation adapter before the first chunk.
  // Auto-approve `media` (mic + camera) for our own app origin —
  // this is a single-origin desktop app, there's no untrusted third
  // party whose requests would need gating. Same reasoning for
  // `clipboard-sanitized-write` (code-block copy / file-tree copy) and
  // `notifications`.
  //
  // `notifications` 必须在这里放行，否则设置页「桌面通知」永远拒权限：UI 跑在
  // app://studio（prod）/ localhost（dev）这类源里，渲染层调 Notification.
  // requestPermission() 会走到本 handler，不放行就直接 denied，而 Electron 应用
  // 里用户根本没有浏览器「站点设置」可去手动开启 → 功能死路。放行后 Electron 把
  // Web Notification 自动转成 macOS 系统通知（无需额外主进程 Notification 代码）。
  const ses = session.defaultSession
  const ALLOWED_PERMISSIONS = new Set([
    'media',
    'clipboard-sanitized-write',
    'notifications',
  ])
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission)
  })

  // 刻意不用 optimizer.watchWindowShortcuts：它把 F12/⌘R 绑在 BrowserWindow
  // 自身的 webContents 上——单视图形态下那是静态 splash，毫无检查价值；dev 下
  // 它的 F12 处理不看 event.defaultPrevented，会和 forceDetachedDevTools 的
  // 重定向双开 DevTools（splash undocked + studio detach 各一个）。DevTools
  // 快捷键统一走菜单加速键 + forceDetachedDevTools（都指向活跃 studio tab）。

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

  // **studio 单视图**是唯一形态（Phase 4 起，legacy 三 tab 架构已物理下线）：
  // 一个全屏 studio tab，聊天(/chat)、工作画布(/)、设置(/?settings=1)、导航
  // rail 全部由 studio 页面内部渲染。dev 加载 localhost:3100（HMR），prod
  // 加载 app://studio/（static export 读盘 + daemon 反代，见 appProtocol.ts）。
  // shell 窗口自身不加载任何内容，且保持隐藏直到 studio 首帧就绪
  // （tabRegistry.activateTab 里 show）——用户看到的第一帧就是 studio。
  createShellWindow()

  // studio tab 等自己的 dev server ready 再建（prod 下 waitForStudioReady
  // 立即 true），避免 WebContentsView 加载到还没起好的端口而白屏；daemon 的
  // 探活是后台仅日志，不阻塞首屏（聊天 engine 是 lazy spawn，画布的 /api
  // 请求自带重试语义）。用 IIFE 异步等待，不阻塞 whenReady 的其余初始化。
  void (async () => {
    void waitForDaemonReady().then((ok) => {
      if (!ok) console.warn('[main] daemon not ready within timeout')
    })
    const studioOk = await waitForStudioReady()
    if (!studioOk) {
      console.warn('[main] studio dev server not ready; studio 仍会打开但可能需手动刷新')
    }
    try {
      newStudioTab()
    } catch (err) {
      console.warn('[main] newStudioTab failed:', err)
    }
  })()

  createTray(() => getShellWindow())

  // 自动更新：打包形态才真正初始化（dev 下降级为 supported:false 只读态），
  // 内部自带 15s 延迟首查，不跟冷启动抢资源。
  initAppUpdater()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 窗口全关后重新激活（macOS dock 点击）：重建 shell + 唯一的 studio
      // tab。服务早已就绪（startOpenDesignServices 只在 before-quit 时才停），
      // 无需再等探活。
      createShellWindow()
      try {
        newStudioTab()
      } catch (err) {
        console.warn('[main] newStudioTab on activate failed:', err)
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
