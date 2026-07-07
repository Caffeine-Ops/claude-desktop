import {
  BrowserWindow,
  WebContentsView,
  shell,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import appIcon from '../../resources/icon.png?asset'
import { ChatEngine, createChatEngine } from './core/engine'
import { getThemeMode, resolveIsDarkTheme, setThemeMode } from './core/appSettings'
import { clearUnread } from './tray'
import { finishSplashThenSettle, loadSplashIntoShell } from './splash'
import { resolveStudioTabUrl } from './services/openDesignServices'
import {
  IPC_CHANNELS,
  type AuthState,
  type ShellMenuAction,
  type TabDescriptor,
  type UpdaterState
} from '../shared/ipc-channels'
import type { KbSyncStatus } from '../shared/kbSyncStatus'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 强制某个 webContents 的 DevTools 以 detach（独立窗口）模式打开。
 *
 * 为什么必须 detach：每个 tab 是一个**覆盖整个 shell 窗口**的 WebContentsView
 * （见下方 activateTab 的 swap 不变量）。Electron 默认 DevTools 以 mode:'right'
 * 内嵌停靠，但停靠区是相对触发它的 webContents 的——而 WebContentsView 不像
 * 普通 BrowserWindow 那样有 DevTools 停靠槽，停靠面板会被 view 自身全屏内容盖住，
 * 表现为「DevTools 被页面挡住」。detach 让 DevTools 单独成窗，不与 view 抢渲染区。
 *
 * 实现：只拦快捷键（⌘⌥I / F12 / ⌘⌥J）自己用 detach 打开。
 *
 * 不要用 `devtools-opened` 事件去「关掉重开成 detach」（历史踩坑）：openDevTools
 * 触发的 devtools-opened 是异步派发的，任何「同步重置的 reentry 标志」都挡不住
 * 递归——close→open→devtools-opened→close→open… 无限循环，主进程日志里那条
 * DevTools 内部的 `presentUI` 噪音会被刷爆（每秒上千行）。快捷键这一条路径已经
 * 覆盖绝大多数打开方式；右键「检查」走默认停靠是可接受的折中，远好过死循环。
 *
 * `resolveTarget`：可选的**重定向**。shell webContents 传入它把 DevTools 指到
 * 当前活跃的 studio tab——shell 自己只是一张静态 splash，检查它没有任何意义，
 * 但启动后键盘焦点可能还落在 shell 上（用户没点过页面），不重定向的话 ⌘⌥I
 * 打开的就是 splash 的 DevTools。返回 null 时回落到 wc 自身。
 */
function forceDetachedDevTools(
  wc: WebContents,
  resolveTarget?: () => WebContents | null
): void {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const isToggle =
      key === 'f12' ||
      // macOS: ⌘⌥I / ⌘⌥J；其它平台 Ctrl+Shift+I / Ctrl+Shift+J
      ((input.meta || input.control) && input.alt && (key === 'i' || key === 'j')) ||
      ((input.control || input.meta) && input.shift && (key === 'i' || key === 'j'))
    if (!isToggle) return
    event.preventDefault()
    const target = resolveTarget?.() ?? wc
    if (target.isDestroyed()) return
    if (target.isDevToolsOpened()) {
      target.closeDevTools()
    } else {
      target.openDevTools({ mode: 'detach' })
    }
  })
}

/**
 * Route http(s) links a page tries to open in a NEW window/tab to the
 * user's default browser, instead of letting Electron spawn a bare
 * frameless child window inside the app (which is what an
 * `<a target="_blank">` or `window.open()` does by default — the user
 * saw a blank `@claude-desktop/desktop` popup when clicking a link the
 * assistant printed).
 *
 * Scope is deliberately narrow:
 *   - We only hook `setWindowOpenHandler` (the new-window path). We do
 *     NOT hook `will-navigate`, because the Open Design web tab / the
 *     settings overlay load a real web app whose own in-app navigation
 *     IS http(s); blanket-redirecting top-level navigation would kick
 *     the app's own router out to the browser. New-window opens, by
 *     contrast, are never part of normal in-app routing here.
 *   - Only `http:` / `https:` go to the external browser. Anything else
 *     (about:, data:, the `app://` custom scheme, devtools:, …) is
 *     denied outright so a crafted link can't ask the OS to launch an
 *     arbitrary handler.
 *
 * Either branch returns `{ action: 'deny' }` so no in-app child window
 * is ever created.
 */
function attachExternalLinkHandler(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

/**
 * Width (in CSS px) of the persistent chrome **navigation rail** rendered
 * by the shell window's own webContents (the `?shell=1` renderer), pinned
 * to the LEFT edge of the window beside every content tab's
 * WebContentsView.
 *
 * History: this band used to be a 44px HORIZONTAL strip pinned to the
 * top (a row of tab pills). It moved to a vertical left rail so the two
 * fixed tabs ("智能助手" / "工作画布") read as a sidebar nav instead of
 * browser tabs — the chat tab's own session list then butts right up
 * against it so the two webContents read as one continuous left column.
 *
 * Why the rail lives in the SHELL and not inside a tab: the Open Design
 * web tab loads an external origin with NO chatApi/tabApi preload, so it
 * can't render nav of its own. Whenever it was foreground the user lost
 * every entry point to switch back. A single shell-owned rail — visible
 * regardless of which tab is foreground — fixes that.
 *
 * Content views are laid out starting at x = NAV_RAIL_WIDTH (see
 * layoutActiveTab) so they sit to the *right* of the rail. The shell's
 * own webContents spans the full window underneath, but only this left
 * band is ever uncovered, so that's all the user sees of it.
 *
 * ⚠️ Phase 4 起这是**死代码**：能画 rail 的 shell renderer 已整体下线
 * （shell 只剩静态 splash），且 'chat' / 'web' kind 的 tab 再无创建入口——
 * layoutActiveTab 只会走 studio 全屏分支。留着仅为 kind 枚举收窄（deferred
 * cleanup）时一并删除。
 */
const NAV_RAIL_WIDTH = 220

/**
 * Maximum number of simultaneously open workspace tabs. Each tab
 * spawns its own fusion-code CLI child process + its own
 * ChatEngine runtime, so the cap is as much about memory / CPU
 * ceiling as UX — nine tabs is also the last count where the
 * collapsed-min-width pill (52px) still fits comfortably inside
 * the narrowest supported window.
 */
export const MAX_TABS = 9

/**
 * Per-tab runtime. One entry per open tab: the WebContentsView that
 * hosts the workspace renderer, the ChatEngine that drives its
 * fusion-code session, and a user-facing title (basename of the
 * chosen workspace, or "智能助手" before the gate has been
 * passed).
 *
 * The registry is keyed by `webContents.id` — the same identifier
 * IPC handlers receive via `event.sender.id` — so
 * `resolveEngine(event)` in register.ts is a direct Map lookup.
 */
interface TabContext {
  view: WebContentsView
  /**
   * 驱动该 tab fusion-code 会话的 ChatEngine。**仅 chat tab 有**；
   * web tab（加载 Open Design web UI 的第二个 tab）没有 engine —— 它的
   * webContents 渲染的是一个外部 origin（dev: localhost:3000 / prod: daemon
   * 同源页面），靠 daemon HTTP API 工作，不经过我们的 ChatEngine / IPC。
   * 所有读 engine 的地方都必须判空。
   */
  engine: ChatEngine | null
  title: string
  /**
   * tab 类型：'chat' 是原有工作区聊天 tab；'web' 是嵌 Open Design web 的 tab；
   * 'studio' 是三前端合并的迁移目标（apps/studio，dev-only，见 newStudioTab）。
   * studio 介于两者之间：像 web 一样加载外部 origin 的 Next 应用，但像 chat
   * 一样挂完整 chatApi preload 并持有自己的 ChatEngine。
   */
  kind: 'chat' | 'web' | 'studio'
}

let shellWindow: BrowserWindow | null = null
const tabs = new Map<number, TabContext>()
const tabOrder: number[] = []

let activeTabId: number | null = null

/**
 * True only during a **real** quit（⌘Q / 菜单退出 / before-quit）。
 *
 * 为什么需要它：macOS 上点红叉的语义是「关闭窗口」而非「退出应用」。默认让
 * `close` 走到 `closed` 会 dispose 掉每个 tab 的 engine——连带 **kill 掉正在
 * 跑的 fusion-code 子进程**（teardownRuntime），用户正在生成的 PPT/长任务被
 * 拦腰截断（`[Request interrupted by user]`）。而 `window-all-closed` 在
 * darwin 上又刻意不 quit，于是进程还挂在 dock、任务却已被杀——最坏组合。
 *
 * 有了这个标志，`close` handler 就能区分两种意图：红叉→只 hide（引擎/子进程
 * 全保留，dock 点一下窗口原样回来）；真退出→放行到 closed 走完整 dispose。
 * `before-quit`（main/index.ts）在退出前置它为 true。
 */
let isQuitting = false

/** Called from main/index.ts `before-quit` so the final window close disposes engines. */
export function setQuitting(v: boolean): void {
  isQuitting = v
}

/** Whether a real quit is already committed (used to avoid re-prompting on re-entrant before-quit). */
export function getQuitting(): boolean {
  return isQuitting
}

/** True while another workspace tab can still be opened. */
export function canAddTab(): boolean {
  return tabs.size < MAX_TABS
}

/**
 * Create the single shell BrowserWindow. Called once at app startup
 * from `main/index.ts`. The shell's own webContents 承载静态闪屏
 * （splash.html，见 splash.ts）——唯一的 studio tab 是层叠其上的
 * WebContentsView（见 newStudioTab）。窗口在 splash 首帧就绪时就 show
 * （loadSplashIntoShell）：用户点图标立即看到带真实启动进度的品牌画面，
 * studio 首帧就绪后被同底色的 view 盖住完成交接（见 newStudioTab 的
 * promote 编排）——历史上窗口一直隐藏到 studio 首帧才出现，dev 下编译
 * 首页的几秒里点了图标毫无反馈，prod 下 did-finish-load ≠ React 画完，
 * show 出来可能仍是一帧空白（「首次启动白屏」，2026-07-06 由此引入闪屏）。
 */
export function createShellWindow(): BrowserWindow {
  if (shellWindow && !shellWindow.isDestroyed()) return shellWindow

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1226,
    minHeight: 778,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    // Traffic lights sit directly over the active tab's renderer
    // header — the renderer's `.header` reserves left padding so
    // the buttons don't overlap any content.
    // y=27：studio tab 的 WebContentsView 全屏 flush（setBounds x0 y0，见
    // layoutActiveTab 的 studio 分支），所以窗口坐标 == renderer 视口坐标。
    // 内容卡 46px 标题栏（含收起态展开图标、标题、AI生成徽标）的垂直中线
    // ≈ 视口 y=33；红绿灯按钮 ⌀12，其 position.y 是按钮顶部，故 33-6=27 让
    // 三者垂直居中对齐（2026-07-05 用户要求）。旧值 16 中线在 22，偏高一截。
    // x=30：整组（红绿灯 + 收起态图标排）离左边缘再放开一档（用户 2026-07-05
    // 要求「整体往右移」）。旧值 14 太贴边。必须与 RailShell 收起态图标排的
    // left-[100px] 联动同增：图标排起点 = 红绿灯净空右缘，两者错位就不成一横。
    trafficLightPosition: { x: 30, y: 27 },
    icon: appIcon,
    // 窗口底色 = renderer 没画出来的每一帧的最终兜底（studio 的
    // WebContentsView 是透明底，见 newStudioTab 的 setBackgroundColor）。
    // 必须跟主题走：写死浅色时，暗色模式下设置 overlay ↔ 主视图这类大树
    // 重挂载的 compositor 空隙帧会透出浅灰白——「面板白闪」（2026-07-04）。
    // 初值优先读用户上次选的 themeMode 镜像（appSettings.json，见其字段
    // 注释）；无记录（首次启动）才落到 OS 主题。运行时用户切主题经
    // APPEARANCE_SET/BROADCAST 调 syncShellBackgroundToTheme 跟随并更新镜像。
    // 亮档 #f6f6f5 = rail 灰面，暗档 #1a1917 = tokens.css 暗档 --background
    // 的 hex 源值。
    backgroundColor: resolveIsDarkTheme(getThemeMode()) ? '#1a1917' : '#f6f6f5'
    // 刻意不给 webPreferences：shell webContents 只承载静态 splash，
    // 不需要 preload / chatApi——Electron 默认（sandbox + contextIsolation +
    // 无 nodeIntegration）就是我们要的最小权限面。
  })

  shellWindow = win
  // DevTools 强制 detach，避免被覆盖全窗的 WebContentsView 遮挡（见函数注释）。
  // shell 上触发的快捷键重定向到活跃 tab——检查一张静态 splash 没有意义。
  forceDetachedDevTools(win.webContents, () => getActiveTabWebContents())
  attachExternalLinkHandler(win.webContents)

  // 窗口的首次 show 在 splash 首帧就绪时（loadSplashIntoShell 里的
  // did-finish-load），activateTab 里的 show 保留作兜底——splash 加载失败时
  // studio 首帧仍能把窗口带出来。刻意不用 'ready-to-show'：它对 loadURL 的
  // data: 页面同样会触发，但语义上我们要的是「splash 画好了」而不是「可以
  // show 了」，did-finish-load 更贴切且与 splashShownAt 计时共用一个锚点。
  loadSplashIntoShell(win)

  const onUserReturned = (): void => clearUnread()
  win.on('focus', onUserReturned)
  win.on('show', onUserReturned)

  // Keep the active tab's view synchronized with the shell content
  // size. `resize` fires for user drags; `enter-full-screen` /
  // `leave-full-screen` on macOS change the content height even
  // without a width change, so we layout on those too.
  win.on('resize', () => {
    layoutActiveTab()
  })
  win.on('enter-full-screen', () => {
    layoutActiveTab()
    broadcastFullscreen(true)
  })
  win.on('leave-full-screen', () => {
    layoutActiveTab()
    broadcastFullscreen(false)
  })

  // macOS 红叉 = 隐藏窗口，不退应用（平台惯例）。拦下 close：非真退出时
  // preventDefault + hide，engine / fusion-code 子进程 / 所有 SessionRuntime
  // 原样存活，正在跑的任务继续在后台推进；dock 点一下经 app.on('activate')
  // 直接 show 回来（见 index.ts，不重建 tab，也就没有 unknown-tab 噪音与
  // 重挂载闪烁）。真退出（⌘Q / 菜单 / before-quit 已置 isQuitting）才放行到
  // 下方 'closed' 走完整 dispose。
  //
  // 其它平台（win/linux）不拦：那里关窗即退应用是惯例，且 window-all-closed
  // 已 app.quit()——保持原语义。
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  // Shutdown path: closing the shell is equivalent to quitting the
  // app's UI. Dispose every tab's engine (each disposes its own
  // permission broker + fusion-code children) before the window
  // actually tears down. macOS 下只有真退出（isQuitting）才走到这里。
  win.on('closed', () => {
    const all = Array.from(tabs.values())
    tabs.clear()
    tabOrder.length = 0
    activeTabId = null
    shellWindow = null
    for (const ctx of all) {
      // web tab 没有 engine —— 跳过。
      void ctx.engine?.dispose().catch((err) => {
        console.warn('[tabRegistry] engine.dispose failed on shell close:', err)
      })
    }
  })

  // shell webContents = 静态闪屏（splash.html）。studio 上屏后它被全屏
  // view 永久盖住；意外的加分是 studio renderer 崩溃时露出来的不再是
  // 窗口纯色而是带 logo 的品牌画面。backgroundColor 仍兜 resize/全屏
  // 切换的间隙帧与 splash 自身加载完成前的空窗。

  return win
}

/**
 * 创建「Studio」tab —— 三前端合并的迁移目标（apps/studio，见其 README）。
 * dev-only：prod 下 studio 尚无打包形态，main/index.ts 根本不调这个函数。
 *
 * 与 web tab 的两个刻意区别：
 *
 *  - **挂完整 chatApi preload + 持有自己的 ChatEngine**：Phase 2 聊天 UI 会
 *    迁进 studio，届时页面里的 window.chatApi 调用经 IPC 到 main 后，靠
 *    `getContextForSender`（event.sender.id → tabs Map）路由回本 tab 的
 *    engine——所以 engine 必须现在就随 tab 建好。ChatEngine 是 lazy spawn
 *    （见 engine.ts：冷启动延迟到首次 send），空挂着不起 fusion-code 子进程，
 *    成本只是一个 JS 对象。
 *  - **不带 `?host=desktop` 查询参数**：web tab 靠它识别宿主是因为没有任何
 *    preload 注入；studio 页面检测 `window.chatApi` 存在即知在壳内。
 *
 * 与 chat tab 的区别：布局 flush（layoutActiveTab 的 gap 只给 'chat'）、
 * 标题固定、后台创建不抢前台（激活策略同 newWebTab——它是启动时主进程自动
 * 建的，不是用户点 "+" 触发的）。
 *
 * shell 会话列表（getActiveChatWorkspace/getActiveChatEngine）目前只认
 * kind==='chat'——studio 在 Phase 1 没有聊天 UI，激活它时左栏会话列表为空是
 * 预期行为；Phase 2 迁入聊天后再把那两处放开到 'studio'。
 */
export function newStudioTab(): TabContext {
  if (!shellWindow || shellWindow.isDestroyed()) {
    throw new Error('Shell window is not initialized.')
  }
  if (!canAddTab()) {
    throw new Error(`Maximum of ${MAX_TABS} tabs already open.`)
  }

  const view = new WebContentsView({
    webPreferences: {
      // 完整 chatApi preload（同 chat tab）：Phase 2 的聊天 UI 需要 window.chatApi。
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  view.setBackgroundColor('#00000000')
  forceDetachedDevTools(view.webContents)
  attachExternalLinkHandler(view.webContents)

  const engine = createChatEngine(view.webContents, {
    shouldBumpOnTurnEnd: () => {
      const shellFocused = !!shellWindow && !shellWindow.isDestroyed() && shellWindow.isFocused()
      const amActive = activeTabId === view.webContents.id
      return !(shellFocused && amActive)
    }
  })

  const ctx: TabContext = {
    view,
    engine,
    title: 'Studio',
    kind: 'studio'
  }
  tabs.set(view.webContents.id, ctx)
  tabOrder.push(view.webContents.id)
  broadcastTabList()

  // 会话列表 / 权限徽标 fan-out 与 chat tab 一致（Phase 2 迁入聊天后直接生效）。
  engine.on('sessionListChanged', () => {
    if (activeTabId === view.webContents.id) {
      broadcastShellSessionListChanged()
    }
  })
  engine.permissionBroker.on('pendingChanged', () => {
    broadcastTabList()
  })

  void view.webContents.loadURL(resolveStudioTabUrl())

  view.webContents.on('did-finish-load', () => {
    broadcastTabList()
  })

  // 激活策略：单视图首个 tab **defer 到 did-finish-load** 再上屏。
  // studio dev server 探活 200 只代表 HTTP 可服务，dev 下首页还要按需编译
  // 几秒——期间窗口显示的是闪屏（splash.html，随真实里程碑推进度）。上屏前
  // 经 finishSplashThenSettle 收尾：补足最短展示时长（prod 下秒就绪时闪屏
  // 不至于一闪而过）→ 进度冲满 →「马上就好」停一拍，然后 studio view 盖上
  // 来完成交接——双方底色同源（tokens --background ↔ studio html 背景），
  // 交接零跳变。10s 兜底：did-finish-load 万一丢失（HMR reconnect 吞事件），
  // studio 也必须上屏（宁可短暂空白也不能永不出现）。promoting 标志防
  // did-finish-load 与兜底定时器在 settle 的异步窗口里双跑。
  if (activeTabId === null) {
    const targetId = view.webContents.id
    let promoting = false
    const promote = (): void => {
      if (promoting) return
      if (!tabs.has(targetId)) return
      if (activeTabId === targetId) return
      promoting = true
      void finishSplashThenSettle(shellWindow).then(() => {
        // settle 期间 tab 可能被关、窗口可能被销毁——activateTab 自会判。
        activateTab(targetId)
      })
    }
    if (view.webContents.isLoading()) {
      view.webContents.once('did-finish-load', promote)
      setTimeout(promote, 10_000)
    } else {
      promote()
    }
  }
  return ctx
}

/**
 * Bring a tab to the foreground.
 *
 * Instead of relying on `setVisible(false)` to hide the inactive
 * views — which leaves them in `contentView`'s child stack where
 * Electron on some platforms still forwards hit-testing to them —
 * we **swap**: `removeChildView` the currently-active view, then
 * `addChildView` the target. That makes "the shell window has
 * exactly one child view at any moment" a hard invariant, which
 * means clicks on the visible area always go to the right
 * renderer regardless of tab creation order.
 *
 * The views we pull out aren't destroyed — `webContents` stays
 * alive, the fusion-code CLI subprocess keeps running, IPC
 * listeners stay subscribed. They just temporarily leave the
 * visual tree and rejoin when re-activated.
 */
export function activateTab(id: number): void {
  if (!shellWindow || shellWindow.isDestroyed()) return
  const target = tabs.get(id)
  if (!target) return

  // Same-tab re-activate is a no-op — but we still broadcast so
  // any out-of-sync TabBars can refresh from the latest snapshot.
  if (activeTabId === id) {
    broadcastTabList()
    return
  }

  // Detach the previous active view (if any) from the shell's
  // content tree. Swallow errors — the contentView API throws if
  // the view wasn't a child, which can happen on the very first
  // activation after a crash/recreate.
  if (activeTabId !== null) {
    const prev = tabs.get(activeTabId)
    if (prev) {
      try {
        shellWindow.contentView.removeChildView(prev.view)
      } catch (err) {
        console.warn('[tabRegistry] removeChildView on activate failed:', err)
      }
    }
  }

  // Attach the new active view. Idempotent: adding a view that's
  // already a child is a no-op.
  try {
    shellWindow.contentView.addChildView(target.view)
  } catch (err) {
    console.warn('[tabRegistry] addChildView on activate failed:', err)
  }

  activeTabId = id
  layoutActiveTab()

  // 兜底 show：窗口的首次显示正常挂在 splash 首帧（loadSplashIntoShell），
  // 走到这里还不可见 = splash 加载失败/被跳过——studio 首帧就绪时窗口
  // 无论如何都必须出来。
  if (!shellWindow.isVisible()) {
    shellWindow.show()
  }

  // 把键盘焦点主动交给刚上屏的 view。addChildView 不会自动转移焦点——
  // 不 focus 的话，启动后（deferred activate 上屏 studio 时）焦点仍留在
  // shell 的空白 webContents 上：用户不点一下页面就没法打字，⌘⌥I 这类按
  // 焦点分发的快捷键也会落到 shell 而不是 studio。
  target.view.webContents.focus()

  broadcastTabList()
  // The active tab changed, so the shell's session list (which shows the
  // active chat tab's sessions) is now stale — tell it to re-pull.
  broadcastShellSessionListChanged()
}

/**
 * Close a tab: dispose its engine, remove the view from the shell,
 * and activate a neighboring tab. If the last tab is closed, the
 * shell window follows it down — the whole UI is gone, which on
 * macOS means "still running in the background" and on Windows /
 * Linux triggers `window-all-closed` → `app.quit()`.
 */
export async function closeTab(id: number): Promise<void> {
  const ctx = tabs.get(id)
  if (!ctx || !shellWindow || shellWindow.isDestroyed()) return

  // Drop from registry BEFORE disposing so a racing IPC resolve
  // can't see a half-disposed engine.
  tabs.delete(id)
  const orderIdx = tabOrder.indexOf(id)
  if (orderIdx >= 0) tabOrder.splice(orderIdx, 1)

  try {
    shellWindow.contentView.removeChildView(ctx.view)
  } catch (err) {
    console.warn('[tabRegistry] removeChildView failed:', err)
  }

  // web tab 无 engine —— 跳过 dispose。
  await ctx.engine?.dispose().catch((err) => {
    console.warn('[tabRegistry] engine.dispose failed:', err)
  })

  // Destroy the WebContents so Chromium reclaims the process slot.
  // `close()` is the public API; `destroy()` is unavailable on
  // WebContents. If the view was already gone (renderer crashed),
  // swallow the error.
  try {
    ctx.view.webContents.close()
  } catch (err) {
    console.warn('[tabRegistry] view close failed:', err)
  }

  if (activeTabId === id) {
    const next = tabOrder[Math.max(0, orderIdx - 1)] ?? tabOrder[0] ?? null
    if (next !== null && next !== undefined) {
      activateTab(next)
    } else {
      activeTabId = null
      // No tabs left → close the shell (triggers the main's
      // `window-all-closed` path).
      shellWindow.close()
      return
    }
  }

  broadcastTabList()
}

/**
 * Update a tab's display title. Called from engine setWorkspace when
 * the user picks a folder (tab shows the folder's basename) or from
 * the renderer via SET_TAB_TITLE IPC.
 */
export function setTabTitle(id: number, title: string): void {
  const ctx = tabs.get(id)
  if (!ctx) return
  ctx.title = title
  broadcastTabList()
}

/** Returns the TabContext the IPC event came from, or null. */
export function getContextForSender(
  event: IpcMainInvokeEvent
): TabContext | null {
  const id = event.sender.id
  return tabs.get(id) ?? null
}

/** Debug helper — logs sender id + all registered tab ids. */
export function describeSenderMismatch(
  event: IpcMainInvokeEvent
): string {
  const sender = event.sender.id
  const known = tabOrder.join(',')
  const shellId = shellWindow?.webContents.id ?? null
  return `sender=${sender} known=[${known}] shell=${shellId}`
}

/** Returns the BrowserWindow that sent this IPC (always the shell). */
export function getShellWindow(): BrowserWindow | null {
  return shellWindow
}

/**
 * 把 shell 窗口底色同步到主题档位——renderer 没画出来的每一帧（大树重挂载
 * 的 compositor 空隙、resize、全屏切换）露出的就是它，跟错档位就是「白闪/
 * 黑闪」。'system' 按 nativeTheme 解析（见 appSettings.resolveIsDarkTheme）。
 * 调用点：ipc/register.ts 的 APPEARANCE_SET（chat 侧每次主题变化都会 push
 * 到这）与 APPEARANCE_BROADCAST（canvas 直连 daemon 后的 ping）。色值与
 * createShellWindow 的初值同源。
 *
 * 顺手把 themeMode 镜像进 appSettings.json（2026-07-06）：闪屏与本窗口的
 * *下次启动*初值都读它，而不是无条件回退 nativeTheme——否则用户在 app 内
 * 手动选的主题与系统主题不一致时，闪屏/窗口初始底色会用错档位，studio
 * 首帧交接时再"跳变"成正确的一档（观感是重新启动就先闪一下错误的主题）。
 */
export function syncShellBackgroundToTheme(themeMode: string | undefined): void {
  if (themeMode === 'dark' || themeMode === 'light' || themeMode === 'system') {
    setThemeMode(themeMode)
  }
  if (!shellWindow || shellWindow.isDestroyed()) return
  shellWindow.setBackgroundColor(resolveIsDarkTheme(themeMode) ? '#1a1917' : '#f6f6f5')
}

/**
 * 当前活跃 tab（单视图形态下即唯一的 studio tab）的 webContents，没有或已
 * 销毁时返回 null。给「DevTools 该指向谁」这类调用方用：shell webContents
 * 只是静态 splash，任何面向「当前页面」的操作都应该落到这里。
 */
export function getActiveTabWebContents(): WebContents | null {
  if (activeTabId === null) return null
  const ctx = tabs.get(activeTabId)
  if (!ctx || ctx.view.webContents.isDestroyed()) return null
  return ctx.view.webContents
}

/**
 * Forward a settings-menu action from the shell's tab strip to the active
 * chat tab's renderer. The shell can't reach the chat renderer's stores
 * (separate webContents), so it routes through main: we look up the active
 * tab and, if it's a chat tab, send SHELL_MENU_ACTION to its webContents.
 *
 * No-op when the active tab is a web tab (it owns no settings/logs/i18n
 * state) or when there's no active tab — the menu item simply does nothing
 * in that edge case rather than throwing back at the shell.
 */
export function dispatchMenuActionToActiveTab(action: ShellMenuAction): void {
  if (activeTabId === null) return
  const ctx = tabs.get(activeTabId)
  if (!ctx?.engine) return
  ctx.view.webContents.send(IPC_CHANNELS.SHELL_MENU_ACTION, { action })
}

/**
 * The active chat tab's workspace dir, or null when no chat tab is active
 * (web tab foreground / nothing open). Used by the SHELL_SESSION_LIST
 * handler so the shell can list the *active* tab's sessions off disk
 * without owning an engine — listSessions is a stateless workspace scan.
 *
 * 判定用 `!!ctx.engine` 而不是 kind==='chat'：单视图形态下唯一的 tab 是
 * kind='studio'（持有完整 engine），SHELL_SESSION_* 这套通道现在服务的是
 * studio 页面里的 AppRail 会话列表——卡死在 'chat' 会让整条链路对 studio
 * 永远返回空（Phase 2 注释里欠的「放开到 studio」在这里补上）。
 */
export function getActiveChatWorkspace(): string | null {
  if (activeTabId === null) return null
  const ctx = tabs.get(activeTabId)
  if (!ctx?.engine) return null
  return ctx.engine.getWorkspace()
}

/**
 * The active chat tab's engine, or null when no chat tab is active.
 * Companion to getActiveChatWorkspace for the shell's session-mutation
 * handlers (rename/delete): they need the engine to (a) close a live
 * runtime before unlinking its jsonl and (b) emit `sessionListChanged`,
 * whose fan-out (wired in createChatTab above) refreshes both the chat
 * sidebar and the shell list in one shot.
 */
export function getActiveChatEngine(): ChatEngine | null {
  if (activeTabId === null) return null
  const ctx = tabs.get(activeTabId)
  // 同 getActiveChatWorkspace：有 engine 的活跃 tab（studio）即聊天宿主。
  if (!ctx?.engine) return null
  return ctx.engine
}

/**
 * Forward a session-switch request from the shell's session list to the
 * active chat tab's renderer (mirrors dispatchMenuActionToActiveTab). The
 * chat renderer runs its own onSwitchToThread/onSwitchToNewThread so the
 * chat store (setSession / loadSession / sessionLoading) stays in sync —
 * a direct engine call from the shell would skip all of that. `sessionId`
 * null means "new chat". No-op when no chat tab is active.
 */
export function dispatchSessionSwitchToActiveTab(
  sessionId: string | null
): void {
  if (activeTabId === null) return
  const ctx = tabs.get(activeTabId)
  // 有 engine 即聊天宿主（studio tab）。单视图下这条环是「AppRail 点会话
  // → invoke SWITCH_REQUEST → 这里发回同一 webContents → chat 的
  // FusionRuntimeProvider 订阅接住」——发起方和接收方是同一个页面，main
  // 只是把请求正规化成事件（复用 legacy shell rail 的既有链路）。
  if (!ctx?.engine) return
  ctx.view.webContents.send(IPC_CHANNELS.SHELL_SESSION_SWITCH, { sessionId })
}

/**
 * Tell the shell renderer that the active chat tab's session list changed
 * so it re-pulls via SHELL_SESSION_LIST. The plain SESSION_LIST_CHANGED
 * only reaches the chat tab's own webContents; this is the explicit
 * fan-out to the shell (same pattern broadcastTabList uses).
 */
export function broadcastShellSessionListChanged(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return
  shellWindow.webContents.send(IPC_CHANNELS.SHELL_SESSION_LIST_CHANGED)
  // 单视图形态下监听方是 studio 页面里的 AppRail 会话列表（shell 自身只是
  // 空白宿主，上面那条 send 没人听）——按 broadcastTabList 的模式 fan-out
  // 给每个 tab 的 webContents。
  for (const id of tabOrder) {
    const ctx = tabs.get(id)
    if (!ctx || ctx.view.webContents.isDestroyed()) continue
    ctx.view.webContents.send(IPC_CHANNELS.SHELL_SESSION_LIST_CHANGED)
  }
}

/** All registered tab contexts, in insertion order. */
export function getAllTabs(): TabContext[] {
  return tabOrder
    .map((id) => tabs.get(id))
    .filter((ctx): ctx is TabContext => ctx !== undefined)
}

/**
 * 是否有任何 tab 的 engine 还挂着活跃的 fusion-code runtime（pump 未退，
 * handle 或 queue 仍在）。用于 before-quit 决定要不要弹「退出会中断任务」
 * 确认框——没有任何任务在跑时直接静默退出，不打扰用户。
 */
export function hasActiveRuntimes(): boolean {
  for (const ctx of tabs.values()) {
    if (ctx.engine && ctx.engine.listActiveRuntimeIds().length > 0) return true
  }
  return false
}

/** Snapshot suitable for sending to the shell renderer. */
function snapshotTabList(): TabDescriptor[] {
  return tabOrder
    .map((id) => {
      const ctx = tabs.get(id)
      if (!ctx) return null
      return {
        id,
        title: ctx.title,
        // web tab 无 engine / 无工作区概念 —— workspacePath 恒为 null。
        workspacePath: ctx.engine?.getWorkspace() ?? null,
        active: id === activeTabId,
        // Aggregate across every session in this tab's engine.
        // `pendingCount` lives on the per-engine PermissionBroker
        // and is updated by its `pendingChanged` event, which
        // `newTab()` wires into `broadcastTabList()` below.
        // web tab 没有权限请求，恒为 0。
        pendingPermissionCount: ctx.engine?.permissionBroker.pendingCount ?? 0
      }
    })
    .filter((d): d is TabDescriptor => d !== null)
}

/**
 * Return the current tab list. Called from the TAB_LIST_GET IPC
 * handler when the shell renderer mounts — it hydrates the initial
 * state before the first LIST_CHANGED broadcast arrives.
 */
export function listTabs(): TabDescriptor[] {
  return snapshotTabList()
}

export function broadcastTabList(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return

  // 两个 tab 的标题都固定（chat = "智能助手"，web = "工作画布"），不跟随
  // 工作区 basename —— 面向医院信息科用户，固定中文名比文件夹名（如 "Desktop"）
  // 更易懂。标题在各自创建时定死，这里无需再从 engine.getWorkspace() 刷新。
  const list = snapshotTabList()

  // Fan the broadcast out to every renderer that might display the
  // tab strip:
  //
  //   1. The shell webContents — currently renders an empty
  //      ShellApp, but if any future UI bits live in the shell
  //      they'll pick this up for free.
  //   2. Every tab's WebContentsView — each tab's workspace
  //      renderer hosts its own TabBar. Without this fan-out, a
  //      tab's TabBar would be frozen to whatever listTabs()
  //      returned at mount time, which is why switching to an
  //      older tab used to appear to "lose" the newer tabs.
  //
  // Skip destroyed webContents defensively; a view that just lost
  // its renderer (crash / HMR reload mid-broadcast) shows up here
  // as `isDestroyed()` true, and send() would throw on it.
  shellWindow.webContents.send(IPC_CHANNELS.TAB_LIST_CHANGED, list)
  for (const id of tabOrder) {
    const ctx = tabs.get(id)
    if (!ctx) continue
    if (ctx.view.webContents.isDestroyed()) continue
    ctx.view.webContents.send(IPC_CHANNELS.TAB_LIST_CHANGED, list)
  }
}

/** Read the shell window's current fullscreen state, defaulting to
 *  false if the window isn't alive yet (early boot paths). */
export function getShellFullscreen(): boolean {
  if (!shellWindow || shellWindow.isDestroyed()) return false
  return shellWindow.isFullScreen()
}

/** Fan the fullscreen boolean out to every tab renderer + the shell.
 *  Same fan-out pattern as `broadcastTabList` so a tab that was
 *  created while the user was already in fullscreen still learns
 *  the current state on its next `getFullscreen` call — see the
 *  renderer's `main.tsx` hydrate logic. */
function broadcastFullscreen(fullscreen: boolean): void {
  if (!shellWindow || shellWindow.isDestroyed()) return
  shellWindow.webContents.send(IPC_CHANNELS.SHELL_FULLSCREEN_CHANGED, fullscreen)
  for (const id of tabOrder) {
    const ctx = tabs.get(id)
    if (!ctx) continue
    if (ctx.view.webContents.isDestroyed()) continue
    ctx.view.webContents.send(IPC_CHANNELS.SHELL_FULLSCREEN_CHANGED, fullscreen)
  }
}

// Gap (px) left around the CHAT tab's content view so it reads as a floating
// rounded card hovering over the shell surface — the shell nav rail / window
// background shows through the gap. The card's rounding + shadow live in the
// chat renderer's CSS (.app under html[data-surface='chat']); the view itself
// can't round its corners, so it paints transparent and the inset gap reveals
// the shell underneath. Web tabs (工作画布, an external origin) don't float —
// they keep butting against the rail edge with no gap.
const CHAT_CARD_GAP = 8

function layoutActiveTab(): void {
  if (!shellWindow || shellWindow.isDestroyed() || activeTabId === null) return
  const ctx = tabs.get(activeTabId)
  if (!ctx) return
  const bounds = shellWindow.getContentBounds()
  // Content view sits to the RIGHT of the left nav rail: shift x by the
  // rail width and shrink width by the same amount. (Was: shift y / shrink
  // height by TAB_BAR_HEIGHT when the rail was a top strip.)
  //
  // Chat tabs float as a card — inset by CHAT_CARD_GAP on all four sides so
  // the shell shows through the gap (incl. a sliver of rail to the LEFT of
  // the card). Web tabs stay flush (gap 0). Math.max guards a tiny window
  // from producing a negative width/height.
  // studio tab 全屏 flush（x=0，无 rail 偏移无 gap）：单视图形态下导航 rail
  // 由 studio 页面自己渲染（AppRail 组件），shell renderer 的 rail 被整个
  // 盖住。chat/web tab 保持原布局（legacy 三 tab 模式还在用）。
  if (ctx.kind === 'studio') {
    ctx.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
    return
  }
  const gap = ctx.kind === 'chat' ? CHAT_CARD_GAP : 0
  ctx.view.setBounds({
    x: NAV_RAIL_WIDTH + gap,
    y: gap,
    width: Math.max(0, bounds.width - NAV_RAIL_WIDTH - gap * 2),
    height: Math.max(0, bounds.height - gap * 2)
  })
}

/**
 * Tell every other window the shared appearance changed so it re-pulls and
 * re-applies the daemon copy at runtime. Called from the APPEARANCE_SET
 * handler after a successful daemon write (see register.ts).
 *
 * Three classes of target, each reached differently because they don't all
 * carry the same preload:
 *  - **chat tabs + shell** (full `index.mjs` preload): get the APPEARANCE_CHANGED
 *    IPC; their renderer's `onAppearanceChanged` re-runs hydrateAppearanceFromDaemon.
 *  - **settings overlay** (minimal `settings.mjs` preload, still has ipcRenderer):
 *    same IPC channel; the embedded web app re-fetches /api/app-config.
 *  - **web tabs** (NO preload — external origin, see newWebTab): can't receive
 *    IPC at all, so we inject a `window` CustomEvent via executeJavaScript and
 *    the web App listens for `od:appearance-changed`.
 *
 * `sourceWebContentsId` is the writer — skipped on every path. It already
 * applied the change locally; re-pulling would be a wasteful echo, and on the
 * desktop side it would feed the store back what it just pushed (the store's
 * own isHydrating guard assumes we don't do that).
 */
/**
 * Push the full updater state to every renderer that can receive IPC
 * (shell + studio tab). Unlike broadcastAppearanceChanged there is NO
 * skip-the-writer id: updater transitions originate in MAIN
 * (electron-updater events), never in a renderer, so every window is
 * equally "other" — a skip-sender here would recreate the 2026-07-04
 * appearance sync black hole (chat/canvas share one webContents).
 */
export function broadcastUpdaterState(state: UpdaterState): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IPC_CHANNELS.UPDATER_STATE_CHANGED, state)
  }
  for (const ctx of tabs.values()) {
    const wc = ctx.view.webContents
    if (wc.isDestroyed()) continue
    wc.send(IPC_CHANNELS.UPDATER_STATE_CHANGED, state)
  }
}

/**
 * Push the full auth state to every renderer that can receive IPC. 同
 * broadcastUpdaterState：无 skip-the-writer id——登录虽由某个 renderer
 * 发起，但它靠 AUTH_LOGIN 的 resolve 值更新自己，广播这边多收一次
 * 整体替换是幂等的；跳 sender 反而会在 chat/canvas 共享 webContents
 * 的形态下复刻 2026-07-04 的 appearance 同步黑洞。
 */
export function broadcastAuthState(state: AuthState): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IPC_CHANNELS.AUTH_STATE_CHANGED, state)
  }
  for (const ctx of tabs.values()) {
    const wc = ctx.view.webContents
    if (wc.isDestroyed()) continue
    wc.send(IPC_CHANNELS.AUTH_STATE_CHANGED, state)
  }
}

/**
 * Push KB sync status to every renderer that can receive IPC. Like
 * broadcastUpdaterState there is NO skip-the-writer id — sync transitions
 * originate in MAIN (kbSyncScheduler), never a renderer write, so every
 * window is equally "other". Web tabs are skipped outright: they have no
 * preload AND no KB UI to update, so there's nothing to reach.
 */
export function broadcastKbSyncStatus(payload: KbSyncStatus): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IPC_CHANNELS.KB_SYNC_STATUS, payload)
  }
  for (const ctx of tabs.values()) {
    if (ctx.kind === 'web') continue
    const wc = ctx.view.webContents
    if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.KB_SYNC_STATUS, payload)
  }
}

export function broadcastAppearanceChanged(sourceWebContentsId: number): void {
  // Shell renderer (hosts the gear; harmless if it has no appearance store).
  if (
    shellWindow &&
    !shellWindow.isDestroyed() &&
    shellWindow.webContents.id !== sourceWebContentsId
  ) {
    shellWindow.webContents.send(IPC_CHANNELS.APPEARANCE_CHANGED)
  }

  // Tabs：单视图形态只剩 studio tab（完整 preload），直接走 IPC。
  // （legacy 的 settings overlay / web tab executeJavaScript 分支已随
  // Phase 4 物理下线。）
  for (const ctx of tabs.values()) {
    const wc = ctx.view.webContents
    if (wc.isDestroyed() || wc.id === sourceWebContentsId) continue
    wc.send(IPC_CHANNELS.APPEARANCE_CHANGED)
  }
}

