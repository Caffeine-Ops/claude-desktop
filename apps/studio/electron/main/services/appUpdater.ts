import { app, dialog } from 'electron'
// electron-updater 是 CJS 包且 autoUpdater 导出走 getter（lazy require 平台
// 实现）——Node ESM 的 cjs-module-lexer 探不到 getter 定义的命名导出，
// `import { autoUpdater } from 'electron-updater'` 在 "type": "module" 的
// out-electron 产物里运行时会炸。必须 default import 再解构。
import electronUpdaterPkg from 'electron-updater'
import type { UpdaterState } from '../../shared/ipc-channels'
import { broadcastUpdaterState } from '../tabRegistry'

const { autoUpdater } = electronUpdaterPkg

/**
 * 自动更新服务（方案 A：公开 release 仓 + electron-updater github provider）。
 *
 * Feed 来自 electron-builder 打进 Resources 的 app-update.yml（owner/repo 即
 * package.json build.publish），仓库公开所以匿名可读，客户端不带任何 token。
 *
 * 策略：
 *  - autoDownload：发现新版即后台静默下载，下载完只「提示」不强装——
 *    quitAndInstall 永远由用户点出来（设置页按钮 / 就绪 toast / 菜单对话框）。
 *  - autoInstallOnAppQuit：用户忽略提示直接退出时，退出即顺手装上，
 *    下次启动就是新版（electron-updater 默认行为，显式写出防止误改）。
 *  - 启动后延迟 15s 首查（让 daemon spawn / 首帧渲染先走完，别跟冷启动抢
 *    网络与 CPU），此后每 4h 复查一次。
 *
 * 状态是单份 module state：main 是唯一事实源，每次迁移全量推给所有
 * renderer（UPDATER_STATE_CHANGED），renderer 只做整体替换不自己拼装。
 */

const CHECK_INITIAL_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let state: UpdaterState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloadPercent: null,
  errorMessage: null,
  // dev / unpackaged 下 electron-updater 没有 app-update.yml 可读，
  // checkForUpdates 直接抛错——整个服务降级为「不支持」只读态。
  supported: app.isPackaged
}

let initialized = false

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch }
  broadcastUpdaterState(state)
}

export function getUpdaterState(): UpdaterState {
  return state
}

/** 检查或下载还在途——electron-updater 不支持并发 check，直接吞掉重复触发。 */
function isInFlight(): boolean {
  return state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'available'
}

/**
 * 触发一次检查并返回触发后的即时快照。结果（available/none/error）走事件
 * 广播，调用方不要 await 出最终结论。
 */
export function checkForUpdates(): UpdaterState {
  if (!state.supported || !initialized || isInFlight() || state.phase === 'ready') {
    return state
  }
  // 事件流会把 phase 推进到 checking；这里不预设，让 checking-for-update
  // 事件成为唯一写入点，避免事件与手写状态互相踩。promise 的 reject 与
  // 'error' 事件是同一个错误的两个出口，catch 只为压掉 unhandled rejection。
  autoUpdater.checkForUpdates().catch(() => {})
  return { ...state, phase: 'checking' }
}

/** 仅在下载就绪后有效；其余相位静默无操作（按钮竞态点击不能炸）。 */
export function installUpdate(): void {
  if (!state.supported || state.phase !== 'ready') return
  // isSilent=false：Windows NSIS 显示安装小窗（用户刚点了「重启安装」，
  // 有反馈比黑屏等待好）；isForceRunAfter=true：装完自动拉起新版。
  // mac（Squirrel.Mac）忽略这两个参数。app.quit() 由 quitAndInstall 内部
  // 触发，走正常退出流：shell closed → engine.dispose（杀 fusion-code 子
  // 进程）→ before-quit 停 daemon。
  autoUpdater.quitAndInstall(false, true)
}

/**
 * 菜单栏「检查更新…」——与设置页共用同一条状态流，但用原生对话框给
 * 同步反馈（菜单没有可驻留的 UI 面）。
 */
export async function checkForUpdatesInteractive(): Promise<void> {
  if (!state.supported) {
    dialog.showMessageBox({
      type: 'info',
      message: '当前是开发模式，无法检查更新',
      detail: '打包安装后的应用才能使用自动更新。'
    }).catch(() => {})
    return
  }
  if (state.phase === 'ready') {
    await promptInstallDialog()
    return
  }
  if (isInFlight()) return
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // 'error' 事件已把 errorMessage 写进 state，这里只负责弹框。
  }
  // checkForUpdates 的 promise 在 available/not-available/error 事件之后
  // 才 resolve，此刻重新取快照就是本次检查的结论。（不能直接读模块级
  // `state`——上面的 early return 让 TS 把它的 phase 收窄成「非 ready」，
  // 而事件在 await 期间改写 state 是 TS 看不见的。）
  const result = getUpdaterState()
  switch (result.phase) {
    case 'none':
      dialog.showMessageBox({
        type: 'info',
        message: '已是最新版本',
        detail: `当前版本 ${result.currentVersion}`
      }).catch(() => {})
      break
    case 'available':
    case 'downloading':
      dialog.showMessageBox({
        type: 'info',
        message: `发现新版本 ${result.availableVersion ?? ''}`,
        detail: '正在后台下载，完成后会提示你重启安装。'
      }).catch(() => {})
      break
    case 'ready':
      await promptInstallDialog()
      break
    case 'error':
      dialog.showMessageBox({
        type: 'warning',
        message: '检查更新失败',
        detail: result.errorMessage ?? '网络错误，请稍后再试。'
      }).catch(() => {})
      break
    default:
      break
  }
}

async function promptInstallDialog(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `新版本 ${state.availableVersion ?? ''} 已就绪`,
    detail: '重启应用即可完成安装。',
    buttons: ['重启并安装', '稍后'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) installUpdate()
}

/**
 * app ready 后调用一次。dev 下只落 supported:false 的状态，不碰
 * electron-updater（它一初始化就要读 app-update.yml）。
 */
export function initAppUpdater(): void {
  if (initialized || !state.supported) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // console 已被 logCollector patch，走它就能进「日志分析」面板。
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', errorMessage: null, downloadPercent: null })
  })
  autoUpdater.on('update-available', (info) => {
    setState({ phase: 'available', availableVersion: info.version, errorMessage: null })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ phase: 'none', availableVersion: null, downloadPercent: null, errorMessage: null })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', downloadPercent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setState({
      phase: 'ready',
      availableVersion: info.version,
      downloadPercent: 100,
      errorMessage: null
    })
  })
  autoUpdater.on('error', (err) => {
    setState({
      phase: 'error',
      downloadPercent: null,
      errorMessage: err instanceof Error ? err.message : String(err)
    })
  })

  setTimeout(() => {
    checkForUpdates()
  }, CHECK_INITIAL_DELAY_MS)
  setInterval(() => {
    // ready 后不再复查：新包已经躺在本地等安装，重复下载没有意义。
    if (state.phase !== 'ready') checkForUpdates()
  }, CHECK_INTERVAL_MS)
}
