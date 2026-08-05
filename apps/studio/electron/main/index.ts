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

import {
  app,
  dialog,
  Menu,
  protocol,
  session,
  webContents,
  type BrowserWindow,
  type MenuItemConstructorOptions
} from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'

// TEMP-DEBUG: dev 下开远程调试端口，便于用 Chrome DevTools 连进 web tab 的
// webContents 对比渲染差异。定根后移除。必须在 app ready 前 append。
if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
  app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:9222')
}

import { registerIpcHandlers } from './ipc/register'
import { pushSplashStage } from './splash'
import { createTray, destroyTray } from './tray'
import {
  createShellWindow,
  getActiveTabWebContents,
  getQuitting,
  getShellWindow,
  handleRenderProcessGone,
  handleTabLoadFailure,
  hasActiveRuntimes,
  newStudioTab,
  setQuitting,
  broadcastKbBuildStatus
} from './tabRegistry'
import {
  startOpenDesignServices,
  stopOpenDesignServices,
  waitForDaemonReady,
  waitForStudioReady
} from './services/openDesignServices'
import { APP_SCHEME, registerAppProtocol } from './services/appProtocol'
import { checkForUpdatesInteractive, initAppUpdater } from './services/appUpdater'
import { cleanReplayCache } from './replay/replayPackage'
import { warmPptSkillInBackground } from './services/pptSkillInstaller'
import { ensureRuntimeComponentsInBackground } from './services/componentInstaller'
import { KB_ASSET_SCHEME, registerKbAssetProtocol } from './services/kbAssetProtocol'
import {
  PROPOSAL_ASSET_SCHEME,
  registerProposalAssetProtocol
} from './services/proposalAssetProtocol'
import { BG_ASSET_SCHEME, registerBgAssetProtocol } from './services/bgAssetProtocol'
import { PPT_ASSET_SCHEME, registerPptAssetProtocol } from './services/pptAssetProtocol'
import { WRITING_ASSET_SCHEME, registerWritingAssetProtocol } from './services/writingAssetProtocol'
import { startKbSyncScheduler } from './core/kbSyncScheduler'
import { onKbBuildStatus, scheduleKbBuild } from './core/kbBuildRunner'
import { readKbIndex, kbStoreHasDocs } from './core/kbIndexStore'

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
  },
  // kbasset:// = 知识库镜像内嵌图；proposalasset:// = 写方案草稿产出图；
  // writingasset:// = 写作项目配图（<项目>/images/ 下的 AI 生图与用户放入图）。
  // 以下几个自定义协议都只在 ready 后 protocol.handle（见下方 whenReady 回调），但
  // privileged 声明必须在这里（ready 前、只能一次）——漏声明的自定义协议在 <img src>
  // 里会被当不安全内容拦掉。（2026-08-03 code review Minor 9：此前写死「三者」，
  // 实际这个数组里同类协议已有 5 个，写死的计数会随每次新增而过期，改成不计数的说法。）
  {
    scheme: KB_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  {
    scheme: PROPOSAL_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // bgasset:// = 用户导入的背景主题图（壁纸换肤）。同 kbasset/proposalasset 的
  // 隐私原因：privileged 声明必须在 ready 前、只能一次；实际 handler 在
  // whenReady 里注册（见下方 registerBgAssetProtocol）。
  {
    scheme: BG_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // pptasset:// = ppt-creator 项目产物（svg_output/ 引用的图片、图标库源文件），
  // 供原生 LivePreviewEditor/SourceDeckViewer 直接 <img src>/<use href> 加载，
  // 不必逐个搬字节过 IPC。同上：privileged 声明必须在 ready 前、只能一次。
  {
    scheme: PPT_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // writingasset:// = 写作项目配图。见文件头（本数组开头那条注释）与
  // services/writingAssetProtocol.ts 头注释的取舍说明。
  {
    scheme: WRITING_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

// 存储目录必须**先于** setName 钉死。app.getPath('userData') 此刻仍返回
// 改名前的历史目录，读一次锁进 setPath，之后 setName 改显示名就不会连带
// 把数据目录漂走。顺序反了（先 setName 再读 userData）会读到 Cowork
// 的新目录，等于把用户历史会话丢在旧目录里读不到。
//
// 为什么必须钉：userData（聊天历史 / 会话 / appSettings）默认按 app 显示名
// 组织。dev 下 Electron 用 package.json name → ~/…/@claude-desktop/studio；
// prod 下用 build.productName → ~/…/Claude Desktop。setName('Cowork')
// 后两者都会漂到 …/Cowork，已有数据全部读不到。把当前真实目录读出来
// 原样钉回，dev / prod 各自保住自己的历史数据，显示名与存储目录彻底解耦。
const userDataDir = app.getPath('userData')
app.setPath('userData', userDataDir)

// 应用显示名 = Cowork。覆盖 Electron 默认取名（dev 菜单栏首项/About 会
// 退回进程名 "Electron" 或 package name "@claude-desktop/studio"；prod 取
// build.productName "Claude Desktop"）——显式 setName 让 dev 与 prod 的菜单 /
// 关于 / 退出确认框都统一显示 Cowork。必须在 whenReady 前调用（菜单和
// app 元信息在 ready 时定型）。存储目录已在上面钉死，不受这行影响。
app.setName('Cowork')

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

/**
 * 把工作区窗口带到用户面前：已存在就 restore + show + focus，被销毁了才重建
 * shell + 唯一的 studio tab。
 *
 * 三个调用方共用它：dock / ⌘Tab（app.on('activate')，mac）、托盘的「显示」与
 * 图标单击（Windows 关窗后窗口只是隐藏，托盘是唯一入口）、以及第二实例被拦下
 * 时（second-instance——用户双击桌面图标其实就是想看到窗口）。
 *
 * 重建分支基本只在窗口异常销毁后才走到：服务早已就绪（startOpenDesignServices
 * 只在 before-quit 才停），无需再等探活。
 */
function revealWorkspaceWindow(): BrowserWindow | null {
  const existing = getShellWindow()
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }
  const win = createShellWindow()
  try {
    newStudioTab()
  } catch (err) {
    console.warn('[main] newStudioTab on reveal failed:', err)
  }
  return win
}

/**
 * 单实例锁。窗口关进托盘后（win32，见 tabRegistry 的 close 拦截）应用是
 * 「看不见但活着」的——用户再双击桌面图标就会起第二个实例：两份 daemon 抢同一个
 * 端口、两份 engine 各自 spawn CLI 子进程、appSettings 互相覆盖。拿不到锁的新实例
 * 直接退场，并让已有实例把窗口带到前台（second-instance），这正是用户点图标真正
 * 想要的结果。
 *
 * dev 下**刻意不加锁**：electron-vite 的主进程热重启是「旧进程退出」与「新进程
 * 启动」短暂重叠的，加锁会让重启后的新实例拿不到锁当场自杀，热重载直接废掉。
 */
const isSecondaryInstance = !is.dev && !app.requestSingleInstanceLock()
if (isSecondaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    revealWorkspaceWindow()
  })
}

app.whenReady().then(async () => {
  // 第二实例：锁没拿到，上面已经 app.quit()。ready 与 quit 的竞态下这个回调
  // 仍可能被调度到——直接退场，绝不能让它注册 IPC / 起服务 / 建窗口。
  if (isSecondaryInstance) return

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
    // 页面级加载失败此前完全静默：promote 的 10s 兜底照常把闪屏推到
    // 「马上就好」再盖上一块空 view，看起来跟「启动慢」一模一样。
    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      handleTabLoadFailure(contents, errorCode, errorDescription, validatedURL)
    })
    // preload 抛错会让 window.chatApi 整个缺失，页面随后在第一次调用时炸。
    contents.on('preload-error', (_e, preloadPath, error) => {
      console.error(`[main] preload 执行出错：${preloadPath}`, error)
    })
  })

  // ── 崩溃可观测性（2026-08-03 加）──────────────────────────────
  //
  // 为什么是 app 级而不是挂在每个 webContents 上：渲染进程可能在 view 建好
  // 之前就没了（launch-failed），那时还没有可挂钩子的对象。app 级事件覆盖
  // 全生命周期，且 details 里的 reason/exitCode 正是此前完全拿不到的东西。
  //
  // 这不修任何崩溃的根因，它只保证崩溃**会说话**：在此之前，studio 的透明
  // view 一旦失去渲染进程，用户看到的就是下层原样透出的闪屏，永远停在
  // 「马上就好」，而日志里唯一的痕迹是 main 往死帧广播时抛的
  // 「Render frame was disposed」——靠那个倒推根因极其费劲（2026-08-03
  // Windows 排查实录）。
  app.on('render-process-gone', (_event, contents, details) => {
    handleRenderProcessGone(contents, details)
  })

  // GPU / utility 子进程死亡。渲染进程崩溃常常是 GPU 进程先崩带崩的，
  // 没这一条就分不清「页面自己炸了」和「显卡那边塌了」。
  app.on('child-process-gone', (_event, details) => {
    console.error(
      `[main] 子进程退出：type=${details.type} reason=${details.reason} ` +
        `exitCode=${details.exitCode}${details.name ? ` name=${details.name}` : ''}`
    )
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

  // KB 远程同步调度器：30s 延迟首触 + 每 6h 定时（无 remote 配置时内部静默跳过）。
  // 挂在这里而非独立 IPC handler 里，是因为它是 app 级后台任务，不依赖任何一个 tab。
  startKbSyncScheduler()

  // 构建进度广播：kbBuildRunner 是 app 级单飞行单例（管理页导入/删改触发重建），
  // 与 startKbSyncScheduler 同层订阅——状态变化推给所有能收 IPC 的 renderer（管理页进度条）。
  onKbBuildStatus((s) => broadcastKbBuildStatus(s))

  // 缺索引自愈：kb-store 有原件但 index.json 缺失（迁移/换机灌库后、或 app 更新令索引失效）
  // → 补触发一次构建。构建平时只由写操作触发（导入/删改），没有这个启动兜底，迁移进来的库
  // 会一直建不出索引、管理页恒空（2026-07-07 移植后实测踩到）。已有索引则跳过、不空转。
  if (!readKbIndex() && kbStoreHasDocs()) scheduleKbBuild()

  // kbasset:// 与 proposalasset:// 的实际 handler（privileged 声明在模块顶层，
  // ready 前）。知识库镜像内嵌图 / 写方案草稿产出图靠它们在 <img src> 里显形。
  await registerKbAssetProtocol()
  await registerProposalAssetProtocol()
  await registerBgAssetProtocol()
  await registerPptAssetProtocol()
  await registerWritingAssetProtocol()

  // **studio 单视图**是唯一形态（Phase 4 起，legacy 三 tab 架构已物理下线）：
  // 一个全屏 studio tab，聊天(/chat)、工作画布(/)、设置(/?settings=1)、导航
  // rail 全部由 studio 页面内部渲染。dev 加载 localhost:3100（HMR），prod
  // 加载 app://studio/（static export 读盘 + daemon 反代，见 appProtocol.ts）。
  // shell 窗口自身承载静态闪屏（splash.ts），splash 首帧就绪即 show——studio
  // 首帧就绪后盖上来完成交接（tabRegistry 的 promote 编排）。
  const shellWin = createShellWindow()

  // studio tab 等自己的 dev server ready 再建（prod 下 waitForStudioReady
  // 立即 true），避免 WebContentsView 加载到还没起好的端口而白屏；daemon 的
  // 探活是后台仅日志，不阻塞首屏（聊天 engine 是 lazy spawn，画布的 /api
  // 请求自带重试语义）。用 IIFE 异步等待，不阻塞 whenReady 的其余初始化。
  // 里程碑推进到闪屏：fraction 只增不减（splash 侧 stage 有 max 保护），
  // 文案是给普通用户看的大白话。终点 finish() 不在这里——它属于 studio
  // 首帧真实就绪（tabRegistry 的 promote → finishSplashThenSettle）。
  void (async () => {
    pushSplashStage(shellWin, 0.4, '正在启动引擎…')
    void waitForDaemonReady().then((ok) => {
      if (!ok) console.warn('[main] daemon not ready within timeout')
    })
    const studioOk = await waitForStudioReady()
    if (!studioOk) {
      console.warn('[main] studio dev server not ready; studio 仍会打开但可能需手动刷新')
    }
    pushSplashStage(shellWin, 0.7, '正在准备工作区…')
    try {
      newStudioTab()
    } catch (err) {
      console.warn('[main] newStudioTab failed:', err)
    }
  })()

  // 托盘的目标窗口解析器刻意用 revealWorkspaceWindow 而不是裸 getShellWindow：
  // Windows 上关窗只是隐藏，托盘是回到应用的**唯一**入口——万一窗口真被销毁过
  // （渲染进程连环崩溃之类），裸 getShellWindow 会返回 null，托盘「显示」就成了
  // 点不动的死项，应用变成一个打不开的图标。这里让它有能力把窗口造回来。
  createTray(() => revealWorkspaceWindow())

  // 回放录像解包缓存的后台清理（>14 天未用的目录）。失败静默、不阻塞启动；
  // 被清掉的包重开时自动重新解包，无功能损失。
  void cleanReplayCache()

  // 运行时组件（AI 引擎 / Python 环境）的按需安装。**必须先于下面的 PPT
  // 预热注册**：ensureRuntimeComponents 内部单飞，这里先起头，warmPptSkill
  // 的 preparePython 内部会 await 同一个单飞 promise 去 join 它，而不是抢跑
  // 在它前面拿到一个还没判定完的 pythonHome（2026-08 排查过的竞态：PPT 预热
  // 若先跑，会在 python-runtime 下载/系统检测完成前就拿到 null，回退系统
  // python——若用户机器是 3.13/3.14，直接踩进 python-runtime 本来要躲开的
  // 源码编译卡死坑，表现为「正在准备运行环境」胶囊一直不消失）。
  //
  // AI 引擎是必需品，缺了整个应用不能聊天，所以渲染层那道门是挡住的、不可
  // 关闭的（python-runtime 则不挡，required:false）。
  //
  // 这里仍然 fire-and-forget、不 await —— 挡的是门，不是 whenReady。splash
  // 照常走完、studio 首帧照常出，门在 studio 里立起来。这样即使要下一两分钟，
  // 用户看到的也是一个正常窗口 + 说明清楚的进度层，而不是一个卡在闪屏上的死壳
  // （骨架屏那类「越需要越跑不动」的反模式，errors/ 里有同族记录）。
  //
  // 必须在 registerIpcHandlers() 之后——广播要有落点。
  ensureRuntimeComponentsInBackground()

  // ppt-creator skill 的后台预热：它不再随安装包发布（99MB / 12167 文件），
  // 首次需要时才下载。**刻意不挡启动**——应用照常秒开，只有 PPT 入口在未
  // 就绪时才挡（用户拍板 2026-07-29）；在这里先跑一遍，让「点进去时已经好了」
  // 成为常态。全程在 utilityProcess 里做，不占 main 主线程。
  warmPptSkillInBackground()

  // 自动更新：打包形态才真正初始化（dev 下降级为 supported:false 只读态），
  // 内部自带 15s 延迟首查，不跟冷启动抢资源。
  initAppUpdater()

  app.on('activate', function () {
    // dock 点击 / ⌘Tab 回到 app。macOS 关红叉只是 hide 了窗口（见
    // tabRegistry 的 'close' handler），此时窗口对象、engine、正在跑的
    // fusion-code 子进程全都还在——直接 show 回来，任务和进度原样呈现，
    // 不重建 tab（重建会新起 webContents，旧的迟到 IPC 打到清空的路由表
    // 就是那堆 `unknown tab` 噪音，还有大树重挂载闪烁）。窗口真被销毁时的
    // 重建兜底在 revealWorkspaceWindow 里。
    revealWorkspaceWindow()
  })
})

app.on('window-all-closed', () => {
  // darwin：平台惯例，窗口全关不退应用（dock 图标常驻）。
  //
  // win32：关窗走 hide（见 tabRegistry 的 close 拦截），正常路径根本到不了
  //   这里。能到这里只有两种情况——① 真退出，此时 quit 流程已在跑，什么都不做
  //   即可；② 窗口异常销毁（渲染进程连环崩溃之类），这时**刻意不 quit**：托盘
  //   还在，用户点一下就能把窗口重建回来（revealWorkspaceWindow），后台正在跑
  //   的任务不该因为一次窗口异常被连锅端掉。
  //
  // linux：托盘在不少桌面环境不显示（见 tabRegistry 的 close 注释），窗口没了
  //   就真的没有入口了——保持「关窗即退」的原语义。
  if (process.platform === 'linux') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  // 真退出意图（⌘Q / 菜单退出 / 托盘「退出」/ 更新重启 / app.quit()）。mac 红叉
  // 与 Windows 的 X 都走 hide 分支，永远到不了这里（见 tabRegistry 的 'close'
  // handler），所以这里的确认框只在用户真想退应用时弹。
  //
  // 有活跃任务才拦一道：退出会 dispose 每个 engine → kill 正在跑的
  // fusion-code 子进程，把用户正在生成的 PPT/长任务拦腰截断。给一个原生
  // 确认框，用户点「退出」才真退、点「取消」preventDefault 留下（且不置
  // isQuitting，下次红叉仍走 hide，语义不被这次犹豫污染）。没有任何任务在
  // 跑时直接静默退出，不打扰。
  if (!getQuitting() && hasActiveRuntimes()) {
    const parent = getShellWindow()
    // 窗口可能被红叉隐藏了（任务仍在后台跑），此时 ⌘Q 弹的 sheet 会挂在
    // 隐藏窗口上看不见——先亮出来再弹，确保确认框可见。
    if (parent && !parent.isDestroyed() && !parent.isVisible()) {
      parent.show()
    }
    const opts = {
      type: 'warning' as const,
      buttons: ['取消', '退出'],
      defaultId: 1,
      cancelId: 0,
      // macOS 弹窗把 message 当粗体首行、detail 当正文
      message: `确定要退出 ${app.getName()} 吗？`,
      detail: '所有正在运行的任务都将被中断。',
      noLink: true
    }
    // parent 存在时挂成窗口模态（sheet 从标题栏滑下），否则 app 级模态
    const choice =
      parent && !parent.isDestroyed()
        ? dialog.showMessageBoxSync(parent, opts)
        : dialog.showMessageBoxSync(opts)
    if (choice === 0) {
      // 取消退出：阻止本次 quit，保持窗口与所有任务原样。
      event.preventDefault()
      return
    }
  }

  // 确认退出（或本就无任务）：解锁窗口的 close 拦截，让接下来的 window close
  // 真正走到 tabRegistry 的 'closed' → dispose 每个 engine（杀 fusion-code
  // 子进程），并清理后台服务。
  setQuitting(true)
  destroyTray()
  // 清理 daemon / web dev 子进程，避免退出后变孤儿进程占着 7456 / 3000。
  stopOpenDesignServices()
})
