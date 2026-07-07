import { app, BrowserWindow } from 'electron'
import splashHtml from './splash.html?raw'
import { getThemeMode, resolveIsDarkTheme } from './core/appSettings'

/**
 * 首启闪屏（splash.html）的 main 侧封装。
 *
 * 为什么存在：窗口首次 show 挂在 activateTab（studio 首帧就绪），dev 下
 * Next 编译首页的几秒里窗口干脆不存在（用户点了图标没有任何反馈），prod
 * 下 did-finish-load ≠ React 画完，show 出来可能仍是一帧空白——「首次启动
 * 白屏」。闪屏补的就是这段空窗：窗口带着品牌画面立即出现，进度随真实
 * 启动里程碑推进，studio 首帧就绪后被同底色的 view 直接盖住完成交接。
 *
 * 为什么是 data: URL 而不是 loadFile：?raw import 让 splash.html 变成
 * main bundle 里的字符串，零构建配置、无 extraResources、dev/prod 同一
 * 条路径。data: 的 opaque origin 只咬第三方脚本/Cookie（2026-06-24 的
 * Intercom 白屏坑），对这张零请求的纯内联页面无碍。
 *
 * 页面契约（splash.html 的 window.__splash）：
 *   stage(fraction, text) — 推里程碑；finish() — 冲满 + 「马上就好」。
 * 推送走 executeJavaScript 而不是 IPC：shell webContents 刻意无 preload
 * （最小权限面，见 createShellWindow），为一张启动画面开 IPC 通道不值。
 */

/** splash 首帧可见的时刻（did-finish-load）；null = 尚未展示。 */
let splashShownAt: number | null = null

/**
 * prod 下 app://studio 几乎秒就绪，闪屏若只闪 <1s 就消失反而像一次抖动；
 * 展示不足此时长时 reveal 会补足等待。dev 下编译远超它，等待恒为 0。
 */
const SPLASH_MIN_SHOW_MS = 900

/** finish()（进度冲满 240ms + 文案换「马上就好」）到 studio 上屏的间隔。 */
const SPLASH_SETTLE_MS = 420

/**
 * 把闪屏装进 shell 窗口并在其首帧就绪时把窗口带出来。
 * 在 createShellWindow 里调用一次。
 */
export function loadSplashIntoShell(win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    splashShownAt = Date.now()
    // 窗口的首次 show 从「studio 首帧」提前到「splash 首帧」：用户点图标
    // 立即看到带进度的品牌画面。activateTab 里的 show 保留作兜底（splash
    // 加载失败时 studio 首帧仍能把窗口带出来）。
    if (!win.isVisible()) win.show()
  })
  // 深浅色档位：优先用户上次选的 themeMode 镜像（appSettings.json），无记录
  // （首次启动）才落到 OS 当前值。'data-theme' 显式属性而非只靠 CSS 的
  // prefers-color-scheme——后者只能跟系统，用户在 app 内手动选的主题与系统
  // 不一致时会显示错误档位、再在 studio 首帧交接时"跳变"回正确档位
  // （2026-07-06，与 createShellWindow 的 backgroundColor 同一根因同一解法）。
  const isDark = resolveIsDarkTheme(getThemeMode())
  // replaceAll 而非 replace：占位符若在文件里出现多于一处（曾在头部注释里
  // 写了字面量），replace 只换第一个匹配，真占位符原样上屏。
  const html = splashHtml
    .replaceAll('__APP_VERSION__', app.getVersion())
    .replaceAll('__THEME_ATTR__', isDark ? ' data-theme="dark"' : ' data-theme="light"')
  void win
    .loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf-8').toString('base64'))
    .catch((err) => console.warn('[splash] load failed:', err))
}

/**
 * 推一个启动里程碑到闪屏。fraction ∈ [0,1]，text 是给用户看的大白话。
 * 页面未加载完时 executeJavaScript 会排队到加载后执行；`?.` 兜没有
 * __splash 的极端情况——丢一个纯装饰性的进度推送无害，不值得报错。
 */
export function pushSplashStage(win: BrowserWindow | null, fraction: number, text: string): void {
  if (!win || win.isDestroyed()) return
  void win.webContents
    .executeJavaScript(`window.__splash?.stage(${JSON.stringify(fraction)}, ${JSON.stringify(text)})`)
    .catch(() => {})
}

/**
 * 收尾编排：补足最短展示时长 → 进度冲满 → 停 SETTLE_MS 让眼睛确认完成感。
 * resolve 后调用方再把 studio view 盖上来（见 newStudioTab 的 promote）。
 * splash 从未展示过（加载失败/被跳过）时立即 resolve——闪屏永远不能反过来
 * 阻塞 studio 上屏。
 */
export async function finishSplashThenSettle(win: BrowserWindow | null): Promise<void> {
  if (!win || win.isDestroyed() || splashShownAt === null) return
  const shownFor = Date.now() - splashShownAt
  if (shownFor < SPLASH_MIN_SHOW_MS) {
    await new Promise((r) => setTimeout(r, SPLASH_MIN_SHOW_MS - shownFor))
  }
  if (win.isDestroyed()) return
  void win.webContents.executeJavaScript('window.__splash?.finish()').catch(() => {})
  await new Promise((r) => setTimeout(r, SPLASH_SETTLE_MS))
}
