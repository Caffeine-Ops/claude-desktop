import {
  BrowserWindow,
  WebContentsView,
  shell,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'

import appIcon from '../../resources/icon.png?asset'
import { ChatEngine, createChatEngine } from './core/engine'
import { clearUnread } from './tray'
import { addLogSubscriber, removeLogSubscriber } from './core/logCollector'
import { resolveWebTabUrl, resolveWebSettingsUrl } from './services/openDesignServices'
import {
  IPC_CHANNELS,
  type ShellMenuAction,
  type TabDescriptor,
  type AuthState
} from '../shared/ipc-channels'

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
 */
function forceDetachedDevTools(wc: WebContents): void {
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
    if (wc.isDestroyed()) return
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools()
    } else {
      wc.openDevTools({ mode: 'detach' })
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
 * Height (in CSS px) of the persistent chrome tab strip rendered by
 * the shell window's own webContents (the `?shell=1` renderer), which
 * sits pinned at the very top of the window above every content tab's
 * WebContentsView.
 *
 * History: this used to be 0 — each tab drew its own TabBar inside its
 * workspace header, and the content view filled the whole window. That
 * broke once we added the Open Design web tab: that tab loads an
 * external origin with NO chatApi/tabApi preload, so it can't render a
 * TabBar. Whenever it was foreground the user lost every entry point to
 * switch back. Pinning a single chrome strip — owned by the shell, not
 * any one tab — keeps both pills always visible/clickable regardless of
 * which tab is foreground.
 *
 * Content views are laid out starting at y = TAB_BAR_HEIGHT (see
 * layoutActiveTab) so they sit *below* the strip. The shell's own
 * webContents spans the full window underneath, but only this top band
 * is ever uncovered, so that's all the user sees of it.
 *
 * 44px = the strip's content (28px pills + 8px top/bottom padding)
 * matches the old in-header TabBar rhythm; the macOS traffic lights
 * overlay this band directly (the chrome renderer reserves left padding
 * so nothing collides — same trick the workspace header used).
 */
const TAB_BAR_HEIGHT = 44

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
  /** tab 类型：'chat' 是原有工作区聊天 tab；'web' 是嵌 Open Design web 的 tab。 */
  kind: 'chat' | 'web'
}

let shellWindow: BrowserWindow | null = null
const tabs = new Map<number, TabContext>()
const tabOrder: number[] = []

/**
 * The settings modal's WebContentsView, or null when closed. It's a
 * per-shell-window singleton that, when open, covers the *entire* window
 * (y = 0, over the tab strip and every tab) so the modal can render a
 * dimming backdrop + centered card. The view's background is transparent
 * (same trick the tab views use) so the tab underneath shows through and
 * the renderer's semi-opaque scrim reads as "the window went dark".
 *
 * Reachable from any tab — chat or web — because it sits in the shell's
 * own contentView tree, not inside a tab. See openSettingsView below.
 */
let settingsView: WebContentsView | null = null
let activeTabId: number | null = null

/** True while another workspace tab can still be opened. */
export function canAddTab(): boolean {
  return tabs.size < MAX_TABS
}

/**
 * Create the single shell BrowserWindow. Called once at app startup
 * from `main/index.ts`. The shell's main webContents renders the tab
 * bar (React app keyed by `?shell=1`) and each tab is a
 * WebContentsView layered below.
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
    trafficLightPosition: { x: 14, y: 16 },
    icon: appIcon,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  shellWindow = win
  // DevTools 强制 detach，避免被覆盖全窗的 WebContentsView 遮挡（见函数注释）。
  forceDetachedDevTools(win.webContents)
  attachExternalLinkHandler(win.webContents)

  win.on('ready-to-show', () => {
    win.show()
  })

  const onUserReturned = (): void => clearUnread()
  win.on('focus', onUserReturned)
  win.on('show', onUserReturned)

  // Keep the active tab's view synchronized with the shell content
  // size. `resize` fires for user drags; `enter-full-screen` /
  // `leave-full-screen` on macOS change the content height even
  // without a width change, so we layout on those too.
  win.on('resize', () => {
    layoutActiveTab()
    layoutSettingsView()
  })
  win.on('enter-full-screen', () => {
    layoutActiveTab()
    layoutSettingsView()
    broadcastFullscreen(true)
  })
  win.on('leave-full-screen', () => {
    layoutActiveTab()
    layoutSettingsView()
    broadcastFullscreen(false)
  })

  // Shutdown path: closing the shell is equivalent to quitting the
  // app's UI. Dispose every tab's engine (each disposes its own
  // permission broker + fusion-code children) before the window
  // actually tears down.
  win.on('closed', () => {
    const all = Array.from(tabs.values())
    tabs.clear()
    tabOrder.length = 0
    activeTabId = null
    // The settings overlay (if open) is torn down with the window; just
    // drop our reference so a later close/relayout doesn't touch a dead view.
    settingsView = null
    shellWindow = null
    for (const ctx of all) {
      // web tab 没有 engine —— 跳过。
      void ctx.engine?.dispose().catch((err) => {
        console.warn('[tabRegistry] engine.dispose failed on shell close:', err)
      })
    }
  })

  // Load the renderer with `?shell=1`. main.tsx branches to a
  // no-op ShellApp that renders nothing — the shell's main
  // webContents just needs a valid document for BrowserWindow to
  // stay alive. The tabs' WebContentsViews cover the entire
  // window so the user never sees this empty surface.
  const shellUrl = resolveRendererUrl({ shell: '1' })
  loadIntoWebContents(win.webContents, shellUrl)

  return win
}

/**
 * Create a new tab: spin up a WebContentsView for the workspace
 * renderer, create its engine, attach the view to the shell window,
 * and activate it. The engine defaults its workspace to the OS Desktop
 * at construction (see engine.ts `resolveDefaultWorkspace`), so the new
 * tab opens straight into a usable chat UI with no folder-picker step.
 */
export function newTab(): TabContext {
  if (!shellWindow || shellWindow.isDestroyed()) {
    throw new Error('Shell window is not initialized.')
  }
  // Hard cap so we don't accidentally fork more fusion-code CLI
  // subprocesses than the host can comfortably run. The IPC layer
  // is expected to check `canAddTab()` before invoking and show
  // the user a dialog; this throw is the defense-in-depth catch
  // for any path that bypasses that (HMR reload, direct module
  // reference in tests, …).
  if (!canAddTab()) {
    throw new Error(`Maximum of ${MAX_TABS} tabs already open.`)
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Transparent background so the shell's theme shows through during
  // the brief interval before the renderer paints its first frame.
  view.setBackgroundColor('#00000000')
  forceDetachedDevTools(view.webContents)
  attachExternalLinkHandler(view.webContents)

  const engine = createChatEngine(view.webContents, {
    shouldBumpOnTurnEnd: () => {
      // Don't bump when: shell is focused AND this tab is the active one.
      const shellFocused = !!shellWindow && !shellWindow.isDestroyed() && shellWindow.isFocused()
      const amActive = activeTabId === view.webContents.id
      return !(shellFocused && amActive)
    }
  })

  const ctx: TabContext = {
    view,
    engine,
    title: '智能助手',
    kind: 'chat'
  }
  tabs.set(view.webContents.id, ctx)
  tabOrder.push(view.webContents.id)

  // Broadcast the new pill to existing tabs BEFORE we start loading
  // the new renderer. Without this, the user clicks "+" and sees no
  // feedback until 200-500 ms later when the new renderer finishes
  // painting. With this, the currently-active tab's TabBar gets the
  // inactive pill immediately so the chrome feels responsive.
  broadcastTabList()

  // Load the main workspace renderer (no shell query string). Dev
  // uses the HMR server URL; prod loads the built index.html. The
  // same preload and renderer bundle serve both the tab and the
  // shell — branching on `window.location.search.includes('shell=1')`
  // in the renderer entry decides which root component mounts.
  //
  // Note: the view is NOT added to `contentView` here. activateTab
  // is the single place that mounts/unmounts views from the shell's
  // visual hierarchy, which keeps "one view at a time" as a true
  // invariant (see the comment on activateTab for why).
  const tabUrl = resolveRendererUrl({})
  loadIntoWebContents(view.webContents, tabUrl)

  // Refresh the displayed title whenever the tab's engine commits a
  // workspace (either initial set via the gate, or the renderer's
  // workspace chip). The tabs map is the canonical source for tab
  // labels, which broadcastTabList pushes to the shell renderer.
  view.webContents.on('did-finish-load', () => {
    broadcastTabList()
  })

  // Fan the engine's pending-permission count onto every tab's
  // TabBar. When a background session inside THIS tab triggers a
  // tool-permission request (or the user resolves one), we need
  // every OTHER tab's TabBar to re-render and show / hide the red
  // notification badge. Piggyback on `broadcastTabList()` so the
  // count ships inside TabDescriptor — no new IPC channel needed.
  //
  // Unsubscribe on tab close is implicit: engine.dispose() calls
  // broker.removeAllListeners(), which drops this handler.
  engine.permissionBroker.on('pendingChanged', () => {
    broadcastTabList()
  })

  // Activation policy — the whole point of the deferral below is to
  // keep the previously-active tab on screen until the new renderer
  // is actually ready to draw a TabBar + header. If we swap blindly
  // at creation time, the user sees the chrome disappear for a beat
  // because the new WebContentsView is still blank.
  //
  //   - First boot (no active tab yet): nothing else to show, so we
  //     must activate immediately — otherwise the shell window sits
  //     behind an empty content area forever.
  //   - Subsequent new-tab clicks: keep the previous view attached
  //     and defer `activateTab(newId)` until the new renderer fires
  //     `did-finish-load`. That's the earliest reliable moment React
  //     has mounted the header/TabBar inside the new view, so the
  //     hand-off is seamless.
  if (activeTabId === null) {
    activateTab(view.webContents.id)
  } else {
    const targetId = view.webContents.id
    const promoteIfStillPending = (): void => {
      // Guard against: (a) the tab being closed during load,
      // (b) the user having already switched to this (or another)
      // tab via a click in the meantime. In both cases calling
      // activateTab would be wrong.
      if (!tabs.has(targetId)) return
      if (activeTabId === targetId) return
      activateTab(targetId)
    }
    if (view.webContents.isLoading()) {
      view.webContents.once('did-finish-load', promoteIfStillPending)
    } else {
      // Already loaded — fall through to immediate activation.
      promoteIfStillPending()
    }
    // Safety net: if `did-finish-load` is never emitted for any
    // reason (renderer crash, HMR reconnect swallowing the event)
    // the new tab must still become visible within a bounded time
    // or the user is stuck watching the old tab with a phantom
    // pill in the TabBar.
    setTimeout(promoteIfStillPending, 1500)
  }
  return ctx
}

/**
 * 创建「Open Design web」tab —— 第二个 tab。和 chat tab 的本质区别：
 *
 *  - **不创建 ChatEngine**：它的 webContents 加载的是 Open Design 的 web UI
 *    （dev: localhost:3000 / prod: app://open-design 自定义协议读磁盘，见
 *    appProtocol.ts），那套前端靠本地 daemon 的 HTTP API 工作（prod 下经
 *    app:// handler 反代给 daemon），完全不经过我们的 ChatEngine / fusion-code / IPC。
 *  - **不挂 chatApi preload**：web tab 是个受控的外部 origin，没必要也不应该把
 *    我们的 IPC 桥暴露给它，所以用默认 webPreferences（仍开 contextIsolation、
 *    关 nodeIntegration 以保持沙箱）。
 *  - **标题固定** "工作画布"，不跟随工作区 basename（它没有工作区概念）。
 *
 * 由主进程在 daemon/web 就绪后调用（见 main/index.ts），URL 由
 * openDesignServices.resolveWebTabUrl() 决定。
 */
export function newWebTab(): TabContext {
  if (!shellWindow || shellWindow.isDestroyed()) {
    throw new Error('Shell window is not initialized.')
  }
  if (!canAddTab()) {
    throw new Error(`Maximum of ${MAX_TABS} tabs already open.`)
  }

  const view = new WebContentsView({
    webPreferences: {
      // 不挂 chatApi preload：见上方注释。保持沙箱默认值。
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  view.setBackgroundColor('#00000000')
  forceDetachedDevTools(view.webContents)
  attachExternalLinkHandler(view.webContents)

  const ctx: TabContext = {
    view,
    engine: null,
    title: '工作画布',
    kind: 'web'
  }
  tabs.set(view.webContents.id, ctx)
  tabOrder.push(view.webContents.id)
  broadcastTabList()

  // 加载 Open Design web。dev 走 web dev server（http），prod 走 app:// 自定义协议。
  // 两者都是非 file:// URL，loadIntoWebContents 走 loadURL 分支即可。
  loadIntoWebContents(view.webContents, resolveWebTabUrl())

  view.webContents.on('did-finish-load', () => {
    broadcastTabList()
  })

  // 激活策略与 chat tab **故意不同**：web tab 是 app 启动时由主进程在后台
  // 自动创建的（不是用户点 "+" 触发的），所以它绝不能抢占前台——否则用户
  // 一开 app 就被甩到 Open Design，而那个 tab 没有 TabBar、回不到 chat
  // （历史 bug，见 [[2026-05-23-daemon-origin校验拒跨源致web调api全403]] 同会话）。
  //
  //   - 冷启动时 chat tab 已先建并激活（activeTabId 非空）→ 这里什么都不做，
  //     web tab 安静地留在后台，等用户从顶部常驻 TabBar 点 "Open Design" pill
  //     才切过去（activateTab 由 TAB_SWITCH IPC 调）。
  //   - 万一 web tab 竟成了首个 tab（activeTabId 为空，理论上不该发生，因为
  //     index.ts 保证 chat 先建）——才立即激活，避免窗口空着没有可见内容。
  if (activeTabId === null) {
    activateTab(view.webContents.id)
  }
  // 已有前台 tab（正常路径）：不做 deferred 抢占激活，仅靠上面的
  // did-finish-load → broadcastTabList 让顶部 TabBar 显示出第二个 pill。
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

  // If the settings modal is open, switching tabs just re-added a tab view
  // on top of it — re-raise the overlay so it stays the topmost child.
  if (settingsView && !settingsView.webContents.isDestroyed()) {
    try {
      shellWindow.contentView.addChildView(settingsView)
      layoutSettingsView()
    } catch (err) {
      console.warn('[tabRegistry] re-raise settings on activate failed:', err)
    }
  }

  broadcastTabList()
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
  if (!ctx || ctx.kind !== 'chat') return
  ctx.view.webContents.send(IPC_CHANNELS.SHELL_MENU_ACTION, { action })
}

/** All registered tab contexts, in insertion order. */
export function getAllTabs(): TabContext[] {
  return tabOrder
    .map((id) => tabs.get(id))
    .filter((ctx): ctx is TabContext => ctx !== undefined)
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

function layoutActiveTab(): void {
  if (!shellWindow || shellWindow.isDestroyed() || activeTabId === null) return
  const ctx = tabs.get(activeTabId)
  if (!ctx) return
  const bounds = shellWindow.getContentBounds()
  ctx.view.setBounds({
    x: 0,
    y: TAB_BAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - TAB_BAR_HEIGHT)
  })
}

/** Size the settings overlay to fill the *entire* window (covers the tab
 *  strip too, so the modal's dimming scrim reaches the very top). */
function layoutSettingsView(): void {
  if (!shellWindow || shellWindow.isDestroyed() || !settingsView) return
  const bounds = shellWindow.getContentBounds()
  settingsView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
}

/**
 * Open the settings modal. Lazily creates a transparent WebContentsView
 * that loads the **Open Design web app** with `?settings=1` (the web app
 * boots straight into a full-screen SettingsDialog modal — it paints its
 * own dimming scrim + centered card). The view is added as the topmost
 * child of the shell's contentView so it covers both the tab strip and the
 * active tab, and is sized to the full window. Idempotent: calling it while
 * already open just refocuses.
 *
 * Why the web app and not a desktop-native page: it gives the overlay the
 * full, always-in-sync settings feature set (providers / connectors / MCP /
 * skills / notifications / appearance / …) backed by the daemon, with no
 * reimplementation in the desktop renderer. The overlay gets a minimal
 * `settings` preload exposing only `electronSettings.close()` — the web
 * page calls it to dismiss, and main tears the view down.
 *
 * Works regardless of which tab is active — the overlay lives in the shell
 * tree, not in a tab, so a web tab can summon it just the same.
 */
export function openSettingsView(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return
  if (settingsView && !settingsView.webContents.isDestroyed()) {
    // Already open — bring focus back to it (e.g. the gear was clicked twice).
    settingsView.webContents.focus()
    return
  }

  const view = new WebContentsView({
    webPreferences: {
      // Minimal preload — only `electronSettings.close()`, NOT the full
      // chatApi (this loads the external-origin web app). See settings.ts.
      preload: join(__dirname, '../preload/settings.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Transparent so the dimmed tab shows through the web modal's scrim.
      transparent: true
    }
  })
  view.setBackgroundColor('#00000000')
  forceDetachedDevTools(view.webContents)
  attachExternalLinkHandler(view.webContents)
  settingsView = view

  // Topmost child → paints over the active tab view and the strip.
  shellWindow.contentView.addChildView(view)
  layoutSettingsView()

  // Load the Open Design web app's settings entry (dev: localhost:3000,
  // prod: app://). loadIntoWebContents handles both URL shapes.
  loadIntoWebContents(view.webContents, resolveWebSettingsUrl())

  // Register the overlay as a live log-stream target so the「日志分析」panel
  // receives lines as they're produced. Registering here (not on
  // did-finish-load) is fine: the panel pulls a full snapshot via getLogs on
  // mount, covering anything streamed before its listener attached. Being in
  // the subscriber set also tells attachRendererCapture to skip this view's
  // own console, so the panel doesn't echo its own render noise.
  addLogSubscriber(view.webContents)
}

/**
 * Close the settings modal: detach + destroy the overlay view. Safe to
 * call when already closed (no-op). Triggered by the renderer (scrim
 * click / Escape / ✕) via the SETTINGS_WINDOW_CLOSE IPC.
 */
export function closeSettingsView(): void {
  const view = settingsView
  settingsView = null
  if (!view) return
  // Stop live log pushes to this view before tearing it down. The collector
  // also self-cleans on the webContents' `destroyed` event, but unsubscribing
  // explicitly here keeps the close path unambiguous.
  removeLogSubscriber(view.webContents)
  if (shellWindow && !shellWindow.isDestroyed()) {
    try {
      shellWindow.contentView.removeChildView(view)
    } catch (err) {
      console.warn('[tabRegistry] removeChildView(settings) failed:', err)
    }
  }
  try {
    view.webContents.close()
  } catch (err) {
    console.warn('[tabRegistry] settings view close failed:', err)
  }
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
export function broadcastAppearanceChanged(sourceWebContentsId: number): void {
  // Shell renderer (hosts the gear; harmless if it has no appearance store).
  if (
    shellWindow &&
    !shellWindow.isDestroyed() &&
    shellWindow.webContents.id !== sourceWebContentsId
  ) {
    shellWindow.webContents.send(IPC_CHANNELS.APPEARANCE_CHANGED)
  }

  // Settings overlay — minimal preload, receives the IPC.
  if (
    settingsView &&
    !settingsView.webContents.isDestroyed() &&
    settingsView.webContents.id !== sourceWebContentsId
  ) {
    settingsView.webContents.send(IPC_CHANNELS.APPEARANCE_CHANGED)
  }

  // Tabs: chat tabs get the IPC; web tabs (no preload) get an injected event.
  for (const ctx of tabs.values()) {
    const wc = ctx.view.webContents
    if (wc.isDestroyed() || wc.id === sourceWebContentsId) continue
    if (ctx.kind === 'web') {
      // No preload here — bridge via a window event the web App subscribes to.
      // Best-effort: a tab still loading (no document yet) silently no-ops.
      wc.executeJavaScript(
        "window.dispatchEvent(new CustomEvent('od:appearance-changed'))"
      ).catch(() => {
        /* tab navigating / destroyed mid-call — next mount re-pulls anyway */
      })
    } else {
      wc.send(IPC_CHANNELS.APPEARANCE_CHANGED)
    }
  }
}

/**
 * Broadcast a sign-in-state change to every renderer EXCEPT the writer.
 *
 * Auth (unlike appearance) is a desktop-internal concern, not shared with
 * the embedded web tab, so this is simpler than broadcastAppearanceChanged:
 * we carry the new state in the payload (receivers update their store
 * directly, no follow-up AUTH_GET) and skip web tabs entirely — they have no
 * preload and no interest in desktop sign-in.
 *
 * The shell renderer (login entry) is the main consumer: it learns of a
 * login that happened in a chat tab's modal. Chat tabs receive it too so a
 * logout from the shell account menu propagates to any chat-side UI.
 * `sourceWebContentsId` is the writer — it already updated locally.
 */
export function broadcastAuthChanged(
  sourceWebContentsId: number,
  state: AuthState
): void {
  if (
    shellWindow &&
    !shellWindow.isDestroyed() &&
    shellWindow.webContents.id !== sourceWebContentsId
  ) {
    shellWindow.webContents.send(IPC_CHANNELS.AUTH_CHANGED, state)
  }

  for (const ctx of tabs.values()) {
    const wc = ctx.view.webContents
    if (wc.isDestroyed() || wc.id === sourceWebContentsId) continue
    if (ctx.kind === 'web') continue // no preload; auth is desktop-internal
    wc.send(IPC_CHANNELS.AUTH_CHANGED, state)
  }
}

/**
 * Resolve the renderer URL — dev uses electron-vite's HMR server,
 * production loads the bundled index.html off disk. The returned
 * value is whatever Electron expects for `loadURL` (dev) or the
 * full file:// URL the file loader builds in prod (the caller
 * passes it to `loadIntoWebContents` below which handles both).
 */
function resolveRendererUrl(query: Record<string, string>): string {
  const params = new URLSearchParams(query).toString()
  const suffix = params ? `?${params}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}${suffix}`
  }
  const abs = join(__dirname, '../renderer/index.html')
  // WebContentsView / webContents.loadFile supports query via options,
  // but we normalize to loadURL for a single code path — file:// URL
  // with query works identically in dev and prod.
  return `file://${abs}${suffix}`
}

function loadIntoWebContents(wc: Electron.WebContents, url: string): void {
  if (url.startsWith('file://')) {
    // For file URLs we could use loadFile but it ignores query
    // strings appended via concat — splitting them back out and
    // passing through the `query` option is the only way to keep
    // `?shell=1` intact in production.
    const [filePath, rawQuery] = url.slice('file://'.length).split('?')
    const query = rawQuery
      ? Object.fromEntries(new URLSearchParams(rawQuery))
      : undefined
    void wc.loadFile(filePath!, query ? { query } : undefined)
    return
  }
  void wc.loadURL(url)
}
