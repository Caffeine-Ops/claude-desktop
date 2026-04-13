import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron'
import trayTemplate from '../../resources/trayIconTemplate.png?asset'
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
const TRAY_STRINGS: Record<Lang, { showHide: string; quit: string }> = {
  zh: {
    showHide: '显示 / 隐藏',
    quit: '退出'
  },
  en: {
    showHide: 'Show / Hide',
    quit: 'Quit'
  }
}

let tray: Tray | null = null
let trayWindow: BrowserWindow | null = null
// Default to Chinese to match the renderer's persisted default. The
// renderer pushes the real value via IPC on mount, so any drift is
// resolved within the first frame after the window is ready.
let currentLang: Lang = 'zh'

function buildIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(trayTemplate)
    img.setTemplateImage(true)
    return img
  }
  if (process.platform === 'win32') {
    return nativeImage.createFromPath(trayIco)
  }
  return nativeImage.createFromPath(trayPng).resize({ width: 22, height: 22 })
}

function toggleWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isVisible() && window.isFocused()) {
    window.hide()
  } else {
    window.show()
    window.focus()
  }
}

function buildMenu(window: BrowserWindow, lang: Lang): Menu {
  const labels = TRAY_STRINGS[lang]
  return Menu.buildFromTemplate([
    {
      label: labels.showHide,
      click: () => toggleWindow(window)
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

export function createTray(window: BrowserWindow): Tray {
  if (tray) return tray

  trayWindow = window
  tray = new Tray(buildIcon())
  tray.setToolTip('Claude Desktop')
  tray.setContextMenu(buildMenu(window, currentLang))
  tray.on('click', () => toggleWindow(window))

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
  if (!tray || tray.isDestroyed() || !trayWindow || trayWindow.isDestroyed()) {
    return
  }
  tray.setContextMenu(buildMenu(trayWindow, lang))
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
  trayWindow = null
}
