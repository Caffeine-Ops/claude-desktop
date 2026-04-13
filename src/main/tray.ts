import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron'
import trayTemplate from '../../resources/trayIconTemplate.png?asset'
import trayIco from '../../resources/icon.ico?asset'
import trayPng from '../../resources/icon.png?asset'

let tray: Tray | null = null

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

export function createTray(window: BrowserWindow): Tray {
  if (tray) return tray

  tray = new Tray(buildIcon())
  tray.setToolTip('Claude Desktop')

  const menu = Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏',
      click: () => toggleWindow(window)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
  tray.on('click', () => toggleWindow(window))

  return tray
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
}
