import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron'
import trayTemplate from '../../resources/trayIconTemplate.png?asset'
import trayTemplate2x from '../../resources/trayIconTemplate@2x.png?asset'
import trayIco from '../../resources/icon.ico?asset'
import trayPng from '../../resources/icon.png?asset'

type Lang = 'zh' | 'en'

/**
 * Tiny mirror of the renderer's translation table for strings the
 * main process owns (currently just the tray context menu). Kept in
 * this file deliberately rather than imported from the renderer's
 * `i18n.ts` — the renderer file pulls in zustand and is not safe to
 * eval inside the main process. Keep these two tables in sync by
 * hand; with two languages and two keys the maintenance cost is
 * trivial.
 */
const TRAY_STRINGS: Record<Lang, { show: string; quit: string }> = {
  zh: {
    show: '显示',
    quit: '退出'
  },
  en: {
    show: 'Show',
    quit: 'Quit'
  }
}

let tray: Tray | null = null
/**
 * Resolver that returns the BrowserWindow the tray should target for
 * "Show" / click-to-front actions. In the multi-workspace refactor
 * there is no single "main window" anymore — the tray asks the
 * windowRegistry for the most recently focused workspace window each
 * time the user interacts. Null means "no workspace windows open".
 */
let targetWindowResolver: (() => BrowserWindow | null) | null = null
// Default to Chinese to match the renderer's persisted default. The
// renderer pushes the real value via IPC on mount, so any drift is
// resolved within the first frame after the window is ready.
let currentLang: Lang = 'zh'
// Unread assistant-reply counter. Bumped from the chat-event bridge in
// `ipc/register.ts` when an assistant turn finishes while the window is
// not focused, cleared from the focus/show listeners in `main/index.ts`.
let unreadCount = 0
// Cached tray icon (the platform icon returned by `buildIcon()`).
// 曾配对一个 unreadIcon（未读时换成红点 + setTitle 计数），2026-07-16
// 随「菜单栏红点退役、未读只留 Dock 徽标」删除——tray 图标恒为此 idle 态。
let idleIcon: Electron.NativeImage | null = null

function buildIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    // Bind the 18×18 and 36×36 template PNGs to one logical 18-point image
    // via addRepresentation: macOS would normally auto-pair `name@2x.png` sitting next
    // to `name.png`, but electron-vite's `?asset` pipeline emits hashed
    // filenames, which breaks that filename convention. Explicit
    // representations survive the rename. Template mode (pure black +
    // alpha) lets the menubar tint it for light/dark automatically.
    const img = nativeImage.createEmpty()
    img.addRepresentation({
      scaleFactor: 1.0,
      width: 18,
      height: 18,
      buffer: nativeImage.createFromPath(trayTemplate).toPNG()
    })
    img.addRepresentation({
      scaleFactor: 2.0,
      width: 18,
      height: 18,
      buffer: nativeImage.createFromPath(trayTemplate2x).toPNG()
    })
    img.setTemplateImage(true)
    return img
  }
  if (process.platform === 'win32') {
    return nativeImage.createFromPath(trayIco)
  }
  return nativeImage.createFromPath(trayPng).resize({ width: 22, height: 22 })
}

function showWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function showResolvedWindow(): void {
  if (!targetWindowResolver) return
  const target = targetWindowResolver()
  if (target) showWindow(target)
}

function buildMenu(lang: Lang): Menu {
  const labels = TRAY_STRINGS[lang]
  return Menu.buildFromTemplate([
    {
      label: labels.show,
      click: () => showResolvedWindow()
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        app.quit()
      }
    }
  ])
}

/**
 * Build the tray. `resolver` is called on every user interaction to
 * pick which workspace window to bring forward — in the multi-window
 * world, that's usually the most recently focused one. The tray
 * itself stays a process-level singleton.
 */
export function createTray(resolver: () => BrowserWindow | null): Tray {
  if (tray) return tray

  targetWindowResolver = resolver
  idleIcon = buildIcon()
  tray = new Tray(idleIcon)
  // 跟随 app 显示名（index.ts 已 setName('Cowork')），改名一处生效。
  tray.setToolTip(app.getName())
  tray.setContextMenu(buildMenu(currentLang))
  tray.on('click', () => showResolvedWindow())

  return tray
}

/**
 * Rebuild the tray's context menu against a new language. Called from
 * the LANG_CHANGED IPC handler in `src/main/ipc/register.ts`. Idempotent
 * — passing the current language re-creates the same menu, which is
 * cheap. No-ops when the tray hasn't been created yet (e.g. an early
 * IPC arriving before `createTray` ran), but updates `currentLang` so
 * the eventual `createTray` picks the right value.
 */
export function updateTrayLang(lang: Lang): void {
  currentLang = lang
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(buildMenu(lang))
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
  targetWindowResolver = null
}

/**
 * Bump the unread counter by one and refresh the visible badge. Called
 * from `ipc/register.ts` when an assistant turn finishes while the user
 * isn't looking at the window.
 */
export function bumpUnread(): void {
  unreadCount += 1
  applyUnread()
}

/**
 * Reset the unread counter and refresh the visible badge. Called from
 * `main/index.ts`'s window `focus` / `show` handlers — the moment the
 * user is back on the window, the badge has done its job.
 */
export function clearUnread(): void {
  if (unreadCount === 0) return
  unreadCount = 0
  applyUnread()
}

/**
 * Push the current unread count to the Dock badge (`app.setBadgeCount`,
 * macOS Dock icon; Linux Unity too if the desktop has libdbusmenu, no-op
 * on Windows).
 *
 * 菜单栏 tray 的红点交换 + setTitle 计数已退役（2026-07-16 用户定稿：
 * 「去掉顶部的红色形状，保留 Dock 徽标」）——两处红色徽标同屏重复，
 * 菜单栏那颗又抢眼又常驻在视线顶部，Dock 徽标足以承担「有未读」的
 * 提醒。tray 图标此后恒为 idle 态。历史实现（运行时画红点 NativeImage
 * 双倍率位图 + tray.setImage 交换）见 git 历史的 buildUnreadIcon，若要
 * 恢复从那里找。
 *
 * Windows tray overlays would need `setOverlayIcon` with a generated
 * number-PNG — skipped until we hear a real ask.
 */
function applyUnread(): void {
  app.setBadgeCount(unreadCount)
}
