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
// Cached idle and unread tray icons. The idle one is the platform icon
// returned by `buildIcon()`, captured at tray-creation time so we can
// swap back to it after the badge is cleared without re-resolving the
// asset path. The unread one is the runtime-generated red dot — we
// pay the bitmap-build cost once and re-use the NativeImage for every
// subsequent bump.
let idleIcon: Electron.NativeImage | null = null
let unreadIcon: Electron.NativeImage | null = null

function buildIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    // Bind the 18×18 and 36×36 template PNGs to one logical 18-point image
    // via addRepresentation — same pattern as buildUnreadIcon and for the
    // same reason: macOS would normally auto-pair `name@2x.png` sitting next
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
  // 跟随 app 显示名（index.ts 已 setName('Fusion Work')），改名一处生效。
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
 * Push the current unread count to every surface that can show it:
 *
 *   - **Tray icon swap** (`tray.setImage`): the only way to actually
 *     get a *red* mark in the macOS menubar. `setTitle` text is
 *     forced to the menubar text color (mono black/white), so a "red
 *     badge" can't ride on title alone — we generate a red-dot
 *     NativeImage at runtime and swap it in. When the count drops
 *     back to zero, we restore the cached idle icon.
 *   - **Tray title** (`tray.setTitle`): macOS-only. Shows the count
 *     next to the swapped icon so the user knows *how many* unread,
 *     not just *whether* there are any.
 *   - **Dock badge** (`app.setBadgeCount`): macOS Dock icon. Linux
 *     Unity too if the desktop has libdbusmenu. No-op on Windows.
 *
 * Windows tray overlays would need `setOverlayIcon` with a generated
 * number-PNG — skipped until we hear a real ask.
 */
function applyUnread(): void {
  app.setBadgeCount(unreadCount)
  if (!tray || tray.isDestroyed()) return

  if (unreadCount > 0) {
    if (!unreadIcon) unreadIcon = buildUnreadIcon()
    tray.setImage(unreadIcon)
    if (process.platform === 'darwin') {
      tray.setTitle(` ${unreadCount}`)
    }
  } else {
    if (idleIcon) tray.setImage(idleIcon)
    if (process.platform === 'darwin') {
      tray.setTitle('')
    }
  }
}

/**
 * Draw the red "unread" dot at runtime — a filled circle rendered
 * straight into a premultiplied BGRA bitmap, bound at @1x and @2x via
 * `addRepresentation` so it stays crisp on retina menubars. This used
 * to load two pre-baked PNGs from `resources/`; drawing in code drops
 * the asset files entirely and keeps color/size tweakable in one
 * place. The image is *not* a template — the red must render as red,
 * not be tinted to the menubar text color.
 *
 * Drawing a real composite of "chat icon + red corner dot" runs into
 * macOS template-image color rules — templates are tinted to the
 * menubar text color, so a partial-color overlay can't share an image
 * with a tinted body. Replacing the whole icon with a single red dot
 * sidesteps that entirely and gives an unmistakable "needs attention"
 * signal that works in both light and dark menubars.
 */
function buildUnreadIcon(): Electron.NativeImage {
  const img = nativeImage.createEmpty()
  // #EC443B — close to macOS systemRed; ~13pt disc on a 16pt canvas.
  const RED = 0xec
  const GREEN = 0x44
  const BLUE = 0x3b
  for (const scale of [1, 2] as const) {
    const size = 16 * scale
    // Raw bitmap is BGRA with premultiplied alpha (Chromium N32) —
    // un-premultiplied edge pixels would render with a bright fringe.
    const buf = Buffer.alloc(size * size * 4)
    const center = size / 2
    const radius = 6.5 * scale
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.hypot(x + 0.5 - center, y + 0.5 - center)
        // One physical pixel of anti-aliased falloff at the rim.
        const alpha = Math.max(0, Math.min(1, radius - dist + 0.5))
        if (alpha <= 0) continue
        const i = (y * size + x) * 4
        buf[i] = Math.round(BLUE * alpha)
        buf[i + 1] = Math.round(GREEN * alpha)
        buf[i + 2] = Math.round(RED * alpha)
        buf[i + 3] = Math.round(255 * alpha)
      }
    }
    img.addRepresentation({
      scaleFactor: scale,
      width: 16,
      height: 16,
      buffer: nativeImage
        .createFromBuffer(buf, { width: size, height: size })
        .toPNG()
    })
  }
  return img
}
