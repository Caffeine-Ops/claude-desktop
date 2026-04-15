import {
  BrowserWindow,
  WebContentsView,
  type IpcMainInvokeEvent
} from 'electron'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'

import appIcon from '../../resources/icon.png?asset'
import { ChatEngine, createChatEngine } from './core/engine'
import { clearUnread } from './tray'
import { IPC_CHANNELS, type TabDescriptor } from '../shared/ipc-channels'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The shell window no longer reserves any vertical band for a
 * chrome-style tab bar — each tab's workspace renderer draws its
 * own tab strip inside its existing `<header>` row, right next to
 * the panel toggle buttons. That means the WebContentsView fills
 * the entire shell window and macOS traffic lights overlay the
 * tab renderer directly (the renderer's `.header` reserves
 * padding on the left so nothing collides).
 */
const TAB_BAR_HEIGHT = 0

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
 * chosen workspace, or "New workspace" before the gate has been
 * passed).
 *
 * The registry is keyed by `webContents.id` — the same identifier
 * IPC handlers receive via `event.sender.id` — so
 * `resolveEngine(event)` in register.ts is a direct Map lookup.
 */
interface TabContext {
  view: WebContentsView
  engine: ChatEngine
  title: string
}

let shellWindow: BrowserWindow | null = null
const tabs = new Map<number, TabContext>()
const tabOrder: number[] = []
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
  win.on('resize', () => layoutActiveTab())
  win.on('enter-full-screen', () => layoutActiveTab())
  win.on('leave-full-screen', () => layoutActiveTab())

  // Shutdown path: closing the shell is equivalent to quitting the
  // app's UI. Dispose every tab's engine (each disposes its own
  // permission broker + fusion-code children) before the window
  // actually tears down.
  win.on('closed', () => {
    const all = Array.from(tabs.values())
    tabs.clear()
    tabOrder.length = 0
    activeTabId = null
    shellWindow = null
    for (const ctx of all) {
      void ctx.engine.dispose().catch((err) => {
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
 * and activate it. The renderer will show the WorkspaceGate until
 * the user picks a folder, after which the engine's `setWorkspace`
 * locks this tab to that directory.
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
    title: 'New Workspace'
  }
  tabs.set(view.webContents.id, ctx)
  tabOrder.push(view.webContents.id)

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

  activateTab(view.webContents.id)
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

  await ctx.engine.dispose().catch((err) => {
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
        workspacePath: ctx.engine.getWorkspace(),
        active: id === activeTabId
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

function broadcastTabList(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return

  // Refresh titles from each engine's live workspace first so the
  // snapshot we send out reflects the latest basename labels.
  for (const id of tabOrder) {
    const ctx = tabs.get(id)
    if (!ctx) continue
    const ws = ctx.engine.getWorkspace()
    if (ws) {
      const name = basename(ws) || ws
      if (ctx.title !== name) ctx.title = name
    }
  }

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
