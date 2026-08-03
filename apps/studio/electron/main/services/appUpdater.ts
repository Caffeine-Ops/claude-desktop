import { app, dialog } from 'electron'
// electron-updater 是 CJS 包且 autoUpdater 导出走 getter（lazy require 平台
// 实现）——Node ESM 的 cjs-module-lexer 探不到 getter 定义的命名导出，
// `import { autoUpdater } from 'electron-updater'` 在 "type": "module" 的
// out-electron 产物里运行时会炸。必须 default import 再解构。
import electronUpdaterPkg from 'electron-updater'
import type { UpdaterState } from '../../shared/ipc-channels'
import { broadcastUpdaterState, setQuitting } from '../tabRegistry'

const { autoUpdater } = electronUpdaterPkg

/**
 * 自动更新服务：自建服务器 generic 源为主 + GitHub 兜底。
 *
 * electron-updater 一次只认一个 feed，没有「多源」概念。我们在 check 阶段
 * 手动做有序 fallback：按 FEEDS 顺序逐个 setFeedURL + checkForUpdates()，
 * 某个源连不上（网络超时 / DNS 失败 / VPS 故障）就静默切下一个，全部耗尽才
 * 落 error 态。第一个「连得上」的源（不管有没有新版）即停在它上，后续
 * autoDownload 的下载也走这个源。
 *
 * 两个源（按 fallback 顺序）：
 *  - self-hosted：我们自己 VPS 上放 latest-*.yml + 安装包的目录 URL
 *    （SELF_HOSTED_FEED_URL）。国内用户访问它比 GitHub 稳定快得多，设为主源；
 *    留空则该源被 usableFeeds() 过滤掉，行为退化成纯 GitHub——没配 URL 时
 *    一切照旧，不会因为空 URL 去连而报错。
 *  - github：electron-builder 打进 Resources 的 app-update.yml 同一套
 *    owner/repo（package.json build.publish），公开仓匿名可读，不带 token。
 *    自建源挂了（域名/证书过期、VPS 宕机、nginx 配置错）时的兜底。
 *  CI 把发给 GitHub Release 的同一批产物 rsync 到 VPS 目录，两边逐字节一致。
 *
 * 策略（不因多源而变）：
 *  - autoDownload：发现新版即后台静默下载，下载完只「提示」不强装——
 *    quitAndInstall 永远由用户点出来（设置页按钮 / 就绪 toast / 菜单对话框）。
 *  - autoInstallOnAppQuit：用户忽略提示直接退出时，退出即顺手装上，
 *    下次启动就是新版（electron-updater 默认行为，显式写出防止误改）。
 *  - **两条安装路径都静默**（2026-08-03 统一）：退出时那条本来就是静默的
 *    （BaseUpdater 的 quit handler 写死 `install(true, false)`），而用户主动
 *    点「立即重启更新」这条以前传的是 isSilent=false，在本项目的
 *    `oneClick:false` 安装器上等于走完整 NSIS 向导（进度页 + 完成页各要点
 *    一次「下一步」）。于是「关掉应用」比「点重启更新」还省事，行为正好
 *    反了。现在 installUpdate 也传 isSilent=true，两条路的观感一致：无窗
 *    安装、装完自动拉起。详见 installUpdate 里的长注释。
 *  - 启动后延迟 15s 首查（让 daemon spawn / 首帧渲染先走完，别跟冷启动抢
 *    网络与 CPU），此后每 10min 复查一次（2026-07-21 用户从 3h 调到
 *    10min，要更快感知新版本）。自建源正常时 GitHub 每轮都不会被打到，
 *    只有自建源连不上才会退到 GitHub——匿名 API 限额 60 次/小时/IP 基本
 *    打不到；若自建源长期故障导致每轮都兜底到 GitHub，10min 间隔=6 次/
 *    小时，仍在余量内，同一 IP 下多个用户共享配额时需留意。
 *
 * 状态是单份 module state：main 是唯一事实源，每次迁移全量推给所有
 * renderer（UPDATER_STATE_CHANGED），renderer 只做整体替换不自己拼装。
 */

const CHECK_INITIAL_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 10 * 60 * 1000

/**
 * 「正在安装」态的可见窗口——置 phase:'installing' 广播之后、真正
 * quitAndInstall 之前的等待时长（2026-08-03）。
 *
 * 它只买一样东西：**一帧渲染**。quitAndInstall 内部是 `install()` 紧跟
 * `setImmediate(() => app.quit())`，同一拍就开始拆窗口；不等这一下，
 * renderer 收到 installing 广播时窗口已经在拆了，那个态永远画不出来，
 * 用户点完按钮看到的就是「界面毫无变化然后突然消失」。380ms 够一帧渲染
 * ＋让眼睛捕捉到状态变化，又短到不会被读成卡顿。
 *
 * **不要以为它能给 engine.dispose 抢时间**（第一版注释在这写错过）：
 * dispose 由 app.quit() 触发，而 app.quit() 在 quitAndInstall 内部、也就
 * 是这段等待*之后*才发生。安装器 spawn 与 app.quit() 是同一拍的两件事，
 * 调大这个常数只会把两者一起推后，对「dispose 跑没跑完」的相对时序零
 * 影响。真正给 dispose 兜底的是 NSIS 那边的宽限：安装器从 Section 开始
 * 有约 2.6s 才会 taskkill /F（allowOnlyOneInstallerInstance.nsh 的
 * _CHECK_APP_RUNNING，isUpdated 时 Sleep 300 + Sleep 1000 → 温和
 * taskkill → Sleep 300 → Sleep 1000 → 才强杀）。
 */
const INSTALL_ACK_DELAY_MS = 380

/**
 * 自建更新源的目录 URL（generic provider 的 base）——指向 VPS 上放
 * latest-mac.yml / latest.yml + 安装包的那个目录，务必以 `/` 结尾，例如
 * 'https://updates.你的域名.com/'。electron-updater 会去 `<url>latest-mac.yml`
 * 读清单、再按清单里的文件名到同目录下载安装包，所以清单和安装包必须同目录。
 *
 * 留空 = 该源不可用，直接退化成 GitHub 单源（usableFeeds 会过滤掉空 URL
 * 的源）。也可用 env.json 里的 SELF_HOSTED_UPDATE_URL 覆盖，免改源码换源。
 */
const SELF_HOSTED_FEED_URL = process.env.SELF_HOSTED_UPDATE_URL ?? ''

type UpdateFeed =
  | { name: 'github'; config: { provider: 'github'; owner: string; repo: string } }
  | { name: 'self-hosted'; config: { provider: 'generic'; url: string } }

/**
 * 源列表即 fallback 顺序：自建服务器优先，GitHub 兜底。owner/repo 与
 * package.json build.publish 及打进去的 app-update.yml 保持一致（改仓库名
 * 要三处一起改）。
 */
const FEEDS: UpdateFeed[] = [
  { name: 'self-hosted', config: { provider: 'generic', url: SELF_HOSTED_FEED_URL } },
  { name: 'github', config: { provider: 'github', owner: 'Caffeine-Ops', repo: 'claude-desktop-releases' } }
]

/** 过滤掉不可用的源（当前只有「自建 URL 为空」一种）。 */
function usableFeeds(): UpdateFeed[] {
  return FEEDS.filter((f) => f.config.provider !== 'generic' || f.config.url.length > 0)
}

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

/**
 * installUpdate 已发起、还没真正退出的窗口期标记。只用于失败复位：
 * quitAndInstall 之后 Squirrel 报错（签名校验失败等）时把 isQuitting
 * 翻回 false，否则残留的真退出标记会让之后的红叉真关窗、杀掉引擎。
 */
let quitForUpdateInitiated = false

/**
 * 一整轮跨源检查是否在进行中——防止 15s 首查与 3h 定时器（或设置页手动点）
 * 并发进入 checkAllFeeds：两个 setFeedURL 交错会把 feed 搅乱。它比只看
 * state.phase 更早置位，堵住「已进入 checkAllFeeds 但首个 checking 事件还
 * 没 fire」的竞态窗口。
 */
let checkCycleActive = false

/**
 * 跨源 fallback 途中标记。为 true 时，单个源的 'error'（连不上/超时）被静默
 * 吞掉、不落 error 态——因为马上要切下一个源重试，UI 应表现为持续「checking」
 * 而不是闪一下「检查失败」。走到最后一个源前会复位它，让最后一个源的失败
 * 正常落 error（见 checkAllFeeds 与 'error' handler）。
 */
let fallbackInFlight = false

/** 切到指定源。dev/unsupported 不会走到这（入口有 supported guard）。 */
function applyFeed(feed: UpdateFeed): void {
  // autoUpdater 是全局单例，setFeedURL 改的是它下一次 check/download 的目标。
  // github 与打进去的 app-update.yml 一致，幂等无害；generic 覆盖成自建 URL。
  autoUpdater.setFeedURL(feed.config)
}

/**
 * 按 FEEDS 顺序逐个源做 check，连不上就 fallback 到下一个。
 *
 * 关键时序：autoUpdater.checkForUpdates() 的 promise 成功 resolve（不管有没
 * 有新版）就说明这个源连得上——停在它，后续 autoDownload 的下载也走它。
 * reject 说明这个源挂了 → 切下一个。中间源失败期间 fallbackInFlight=true
 * 抑制 'error' 事件避免中途闪错；轮到最后一个源前放开抑制，让它的失败
 * 正常落 error 态。
 *
 * 只在 check 阶段做 fallback：这覆盖最有价值的场景（自建源整个连不上，比如
 * 域名/证书过期、VPS 宕机、nginx 配置错），退回 GitHub 兜底。下载阶段的失败
 * （sha512、断流）不跨源重来，落 error 由用户手动重试——重试会重新走这里、
 * 重新选源。
 */
async function checkAllFeeds(): Promise<void> {
  const feeds = usableFeeds()
  checkCycleActive = true
  fallbackInFlight = feeds.length > 1
  try {
    for (let i = 0; i < feeds.length; i++) {
      // 最后一个源之前放开抑制：它若也失败，'error' 事件要能落地。
      if (i === feeds.length - 1) fallbackInFlight = false
      applyFeed(feeds[i])
      try {
        await autoUpdater.checkForUpdates()
        // resolve = 这个源连得上，本轮结束（有无新版走事件流）。
        if (i > 0) console.log(`[updater] feed fallback 命中：${feeds[i].name}`)
        return
      } catch {
        // 这个源连不上；不是最后一个就继续切。最后一个的失败已由 'error'
        // handler 写进 state，这里直接走完循环结束。
        if (i < feeds.length - 1) {
          console.log(`[updater] feed 连不上，fallback：${feeds[i].name} → ${feeds[i + 1].name}`)
        }
      }
    }
  } finally {
    checkCycleActive = false
    fallbackInFlight = false
  }
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch }
  broadcastUpdaterState(state)
}

export function getUpdaterState(): UpdaterState {
  return state
}

/**
 * 检查/下载/安装还在途——electron-updater 不支持并发 check，直接吞掉重复
 * 触发。'installing' 也算在途：那时 app 已在退出路上，再起一轮跨源 check
 * 只会在拆到一半的进程里制造无人消费的 IPC 广播。
 */
function isInFlight(): boolean {
  return (
    state.phase === 'checking' ||
    state.phase === 'downloading' ||
    state.phase === 'available' ||
    state.phase === 'installing'
  )
}

/**
 * 触发一次检查并返回触发后的即时快照。结果（available/none/error）走事件
 * 广播，调用方不要 await 出最终结论。
 */
export function checkForUpdates(): UpdaterState {
  if (!state.supported || !initialized || checkCycleActive || isInFlight() || state.phase === 'ready') {
    return state
  }
  // checkAllFeeds 内部串行试各源；事件流把 phase 推进到 checking，这里不预设，
  // 让 checking-for-update 事件成为唯一写入点，避免事件与手写状态互相踩。
  // 不 await：结论走事件广播；catch 压掉最后一个源失败时冒上来的 rejection。
  void checkAllFeeds().catch(() => {})
  return { ...state, phase: 'checking' }
}

/** 仅在下载就绪后有效；其余相位静默无操作（按钮竞态点击不能炸）。 */
export async function installUpdate(): Promise<void> {
  // guard 必须先于任何状态写入：phase 一旦被推到 'installing' 就不再是
  // 'ready'，顺序反了会让第二次点击穿过 guard 走到 quitAndInstall。
  if (!state.supported || state.phase !== 'ready') return
  // 点击确认：先广播 installing 让 UI 立刻有反应，再等一帧渲染时间。
  // 这是 Windows 改静默安装后唯一的可见反馈（NSIS 不再出向导窗口），
  // 见 INSTALL_ACK_DELAY_MS 的注释。
  setState({ phase: 'installing', errorMessage: null })
  await new Promise((resolve) => setTimeout(resolve, INSTALL_ACK_DELAY_MS))
  //
  // ── 从这里到 quitAndInstall 之间不许再出现 await ──
  //
  // setQuitting(true) 与 quitAndInstall 之间每多一段异步等待，就多一段
  // 「isQuitting=true 但没有任何 quit 在途」的窗口期：这期间 mac 用户点
  // 红叉会穿过 tabRegistry 的 close 拦截（那道拦截正是靠 isQuitting=false
  // 判定「红叉=hide」的），窗口真被关掉、每个 engine 走 dispose 杀光
  // fusion-code 子进程，而 app 还活着——留下一个没有窗口的空壳进程。
  // 所以渲染等待要放在置位**之前**（2026-08-03 加 installing 态时差点
  // 把这个不变量写坏）。
  //
  // 必须先置真退出标记，再调 quitAndInstall。两个原因（2026-07-13 事故）：
  //
  // 1. mac 的 quitAndInstall（Squirrel.Mac）**不走 before-quit**——Electron
  //    原生实现是「对所有窗口调 window.close()，等 window-all-closed 再重启
  //    安装」。而 tabRegistry 的 close 拦截（红叉=hide 不退出）在
  //    isQuitting=false 时会把这次 close preventDefault 掉：窗口只是被隐藏，
  //    window-all-closed 永不触发，进程卡死、更新永远装不上。
  // 2. win/linux 走 app.quit() → before-quit，那里有活跃任务时会弹「确定
  //    退出吗」确认框——用户刚点了「立即重启更新」，不该再拦一道；且此时
  //    NSIS 安装器已被 spawn，取消退出反而会跟安装器打架。
  //
  // 先置位后，close 放行 → closed 走完整 dispose（杀 fusion-code 子进程），
  // 随后的 app.quit() 进 before-quit 时 getQuitting() 已 true，跳过确认框、
  // 照常 destroyTray + stopOpenDesignServices，清理链一个不少。
  quitForUpdateInitiated = true
  setQuitting(true)
  //
  // isSilent=true（2026-08-03 从 false 改过来）：Windows NSIS 拿到 `/S`，
  // 无窗安装。**这一位不是「要不要显示进度」，而是「走不走向导」**——
  // 本项目 nsis 配置是 `oneClick:false`（为了首装能选安装目录），
  // electron-builder 据此生成的是 assistedInstaller.nsh 那套 MUI2 向导；
  // 不带 `/S` 跑起来就是完整向导，而 `--updated` 只跳得掉许可页与目录页
  // （assistedInstaller.nsh 的 skipPageIfUpdated），INSTFILES 进度页与
  // FINISH 完成页是无条件的，用户被迫点两次「下一步」才装得上。
  // 旧注释里「显示安装小窗」是 oneClick 安装器的形态，assisted 下拿不到。
  //
  // isForceRunAfter=true：装完自动拉起新版。静默模式下这条走的是
  // installSection.nsh 的 `${if} ${isForceRun} ${andIf} ${Silent}` →
  // doStartApp 分支（非静默时改由 FINISH 页的「运行」勾选框负责，所以
  // 「静默」和「装完自动重启」必须一起给，只给 `/S` 会装完不启动）。
  // 注意 6.8.9 的 BaseUpdater 有一层转发：
  // `install(isSilent, isSilent ? isForceRunAfter : autoRunAppAfterInstall)`
  // ——只有 isSilent=true 时我们传的 isForceRunAfter 才真正生效。
  //
  // mac（Squirrel.Mac）两个参数都忽略：MacUpdater.quitAndInstall() 压根
  // 不接参数，行为与改动前逐字节相同。
  autoUpdater.quitAndInstall(true, true)
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
  if (checkCycleActive || isInFlight()) return
  try {
    await checkAllFeeds()
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
  if (response === 0) await installUpdate()
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
    // fallback 途中（还有下一个源要试）：吞掉这个源的失败，别闪 error 态，
    // 让 checkAllFeeds 继续切源。轮到最后一个源时 fallbackInFlight 已复位。
    if (fallbackInFlight) return
    if (quitForUpdateInitiated) {
      // 重启安装发起后失败（签名校验、staged 包损坏等）：撤销真退出标记，
      // 别让残留的 isQuitting 把用户之后的红叉变成真关窗杀引擎。
      //
      // 此时 phase 是 'installing'，下面统一落到 'error'——app 没退成、
      // 窗口还在，用户看得到失败原因。不回退成 'ready'：那会让 UI 显示
      // 一个可以再点的「立即重启更新」，而刚刚失败的原因（包坏了/签名不
      // 对）多半会原样复现。下一轮 check 会重新判定，包若完好会自己回到
      // ready（electron-updater 的 downloadedUpdateHelper 缓存还在，不必
      // 重新下整包）。
      quitForUpdateInitiated = false
      setQuitting(false)
    }
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
    // installing 更是：进程正在退出，别在拆到一半的 main 里起新一轮跨源
    // check（checkForUpdates 的 isInFlight 也挡着，这里是第二道）。
    if (state.phase !== 'ready' && state.phase !== 'installing') checkForUpdates()
  }, CHECK_INTERVAL_MS)
}
