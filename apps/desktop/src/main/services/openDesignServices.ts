/**
 * Open Design 服务编排：Electron 主进程拉起 daemon（+ dev 下的 web dev server）。
 *
 * 为什么放在主进程：第二个 tab 用 WebContentsView 加载 Open Design 的 web UI，
 * 而那套 web 依赖一个本地 daemon（Express，apps/daemon）提供 /api、/artifacts、
 * /frames 等。daemon 又是唯一有文件系统/子进程特权的进程。所以 Electron 启动时
 * 必须把它拉起来，否则第二个 tab 是一张调不通 API 的空壳。
 *
 * 几条不变量（改之前务必读懂）：
 *
 *  - **daemon 必须用 node 跑，不是 electron 内置 node、也不是 bun。**
 *    daemon 依赖 better-sqlite3，其 .node 二进制按系统 Node 的 ABI（137 = Node 24）
 *    编译。electron 的 process.execPath 是 Electron 二进制（ABI 不同），用它跑会
 *    dlopen 失败。所以这里显式找系统 `node`（PATH 上的，dev 下是 nvm 的 Node 24）。
 *
 *  - **必须注入 OD_ALLOWED_ORIGINS + OD_WEB_PORT。** daemon 有 origin 校验：默认只
 *    信任与自身同源的请求。web dev server 跑在另一个端口（dev: 3000），跨源调
 *    /api 会被 daemon 403。把 web 的 origin 告诉 daemon 才放行。打包后 web 由
 *    daemon 自己 serve（同源），但 dev 下是分离的两个端口，这步是 dev 模式 403 的
 *    唯一解（历史教训）。
 *
 *  - **dev 才 spawn web dev server；prod 不需要。** prod 下 web 已被构建成静态资源
 *    （apps/web/out），daemon 的 STATIC_DIR 直接 serve，无需独立进程。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'

import { pushLog } from '../core/logCollector'
import type { LogSource } from '../../shared/ipc-channels'

/**
 * Pipe a spawned child's stdout/stderr into the runtime-log collector while
 * still echoing it to our own terminal. Replaces the previous `stdio:
 * 'inherit'`, which gave the child our fds directly so main never saw the
 * bytes — the「日志分析」panel needs the content, not just the terminal.
 *
 * stdin stays inherited; only the two output streams are piped. stderr is
 * tagged `error` level so daemon crashes (e.g. the ECONNREFUSED dump) stand
 * out in the panel.
 */
function pipeChildToCollector(child: ChildProcess, source: LogSource): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    process.stdout.write(text)
    pushLog(source, 'info', text)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    process.stderr.write(text)
    pushLog(source, 'error', text)
  })
}

/** daemon 绑定端口。与 apps/daemon/src/cli.ts 默认值一致。
 *  注意：core/externalMcp.ts 故意不 import 这个常量（避免反向拉进 electron-app
 *  依赖链），而是写死同一个 7456——改这里要同步改那边。 */
export const DAEMON_PORT = 7456
/**
 * dev 下 web dev server（next dev）的端口。**单一源头**——下面 WEB_DEV_ORIGIN、
 * daemon 跨源白名单（OD_ALLOWED_ORIGINS/OD_WEB_PORT）、waitForWebReady 探活、
 * resolveWebTabUrl / resolveWebSettingsUrl 全部派生自它，改这一处即四处一致。
 *
 * 默认 3200（**刻意避开 next 默认 3000**），因为同机常并行跑 open-design 这类
 * 同源 fork，它们也钉 3000；两个 next dev 抢同一端口时，先起的占住、后起的
 * waitForWebReady 会探到那个「冒牌 3000」（返回 200 就算 ready）→ Electron
 * loadURL 加载到别人的页面 = 卡片样式串味。换端口从根上杜绝。
 * 见 sessions/2026-05-24-claude-desktop（open-design 抢 3000 致 Electron 串味）。
 *
 * `OD_WEB_DEV_PORT` 可覆盖（spawnWebDev 会把它作为 PORT 注入 next dev 子进程，
 * 所以 next 真正监听的端口与这里恒等）。
 */
export const WEB_DEV_PORT = Number(process.env.OD_WEB_DEV_PORT) || 3200

/**
 * dev 下 studio dev server（apps/studio，三前端合并的迁移目标，见其 README）的
 * 端口。与 WEB_DEV_PORT 同款「单一源头 + env 注入恒等」机制：spawnStudioDev 把
 * 它作为 STUDIO_DEV_PORT 注入子进程，studio 的 dev script
 * （`next dev -p ${STUDIO_DEV_PORT:-3100}`）读同名变量，next 真正监听的端口与
 * 这里恒等。默认 3100 与 web 的 3200 一样刻意避开 next 默认 3000（3000 被同源
 * fork 抢占串味的教训见 WEB_DEV_PORT 注释）。
 *
 * Phase 1 只有 dev 通路；打包形态（standalone vs static export）等聊天 UI 迁移
 * 完再定，所以没有对应的 app://（prod）分支——prod 下根本不建 studio tab。
 */
export const STUDIO_DEV_PORT = Number(process.env.STUDIO_DEV_PORT) || 3100

const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`
const WEB_DEV_ORIGIN = `http://localhost:${WEB_DEV_PORT}`
const STUDIO_DEV_ORIGIN = `http://localhost:${STUDIO_DEV_PORT}`

let daemonProc: ChildProcess | null = null
let webProc: ChildProcess | null = null
let studioProc: ChildProcess | null = null

/**
 * 启动时算出的仓库根，缓存到模块级，供 resolveWebStaticDir() 复用。
 * app:// 协议 handler（appProtocol.ts）在 ready 后注册时拿不到 selfDir，
 * 靠这个缓存解析 apps/web/out 的磁盘路径。startOpenDesignServices 先于
 * registerAppProtocol 调用，所以读到时一定已填充。
 */
let cachedRepoRoot: string | null = null

/** prod 下 web tab 的 app:// origin。与 appProtocol.ts 的 APP_ORIGIN 保持一致。 */
const APP_PROTOCOL_ORIGIN = 'app://open-design'

/**
 * 定位「仓库根」——即一个能 join('apps','daemon','dist',...) / join('apps','web','out')
 * 找到 daemon bundle、web 静态产物、skills/design-systems 等资源的根目录。
 *
 * - **prod（打包后）**：资源由 electron-builder 的 extraResources 投放到
 *   `process.resourcesPath/prebundled`，内部刻意复刻 monorepo 的 `apps/daemon/dist`、
 *   `apps/web/out`、`skills/` 等布局，让 daemon 的 resolveProjectRoot(__dirname) 算出
 *   的 PROJECT_ROOT 正好落在这个 prebundled 根上（见 prebundle-daemon.mjs）。daemon
 *   的资源安全校验（OD_RESOURCE_ROOT 必须在 PROJECT_ROOT 之下）也因此天然满足。
 * - **dev**：主进程 bundle 在 apps/desktop/out/main，往上三级到仓库根；兜底用 cwd。
 *
 * app.isPackaged 比 is.dev 更权威（is.dev 看的是 ELECTRON_RENDERER_URL，prebundle
 * 阶段未必置位）。
 */
function resolveRepoRoot(selfDir: string): string {
  if (app.isPackaged) {
    const prebundled = join(process.resourcesPath, 'prebundled')
    // prod 必须能找到 daemon bundle；找不到说明打包漏投，直接返回该路径让上层
    // spawnDaemon 的 existsSync 检查报「daemon cli not found」而非静默走 dev 路径。
    return prebundled
  }
  // apps/desktop/out/main → ../../.. = repo 根
  const fromBundle = join(selfDir, '../../..')
  if (existsSync(join(fromBundle, 'apps', 'daemon'))) return fromBundle
  // 兜底：cwd（dev 下 electron-vite 在 apps/desktop 跑，cwd/../.. = 根）
  const fromCwd = join(process.cwd(), '../..')
  if (existsSync(join(fromCwd, 'apps', 'daemon'))) return fromCwd
  return fromBundle
}

/**
 * 找一个能用的系统 node 可执行文件。**不能**用 process.execPath（那是 Electron
 * 二进制，ABI 与 better-sqlite3 不匹配）。
 *
 * 不变量：daemon 的 better-sqlite3 .node 按仓库 .nvmrc 钉的 Node 版本（当前 24 =
 * ABI 137）编译。所以这里**绝不能裸返回 'node' 赌 PATH**——这是踩过两次的坑：
 *  - dev：GUI 启动的 Electron 继承的父 shell PATH 可能是别的 nvm 版本。
 *  - prod：`spawnDaemon` 给 daemon 的 PATH 里拼了 `buildAgentDetectionPath()`，
 *    它枚举了 nvm **所有**版本的 bin（v18/v22/v24…），裸 'node' 会按字典序撞上
 *    **第一个**（v18/v22 而非 v24），ABI 错配 → ERR_DLOPEN_FAILED → daemon 立即
 *    exit 1 → waitForDaemonReady 等满 30s 超时 → web tab「无法连接本地 daemon」+
 *    总启动卡 ~40s。
 *    见 [[2026-05-23-prod缺nvmrc回退裸node撞ABI致daemon起不来]]、
 *    [[2026-05-23-daemon子进程裸node赌PATH撞ABI错配崩溃]]。
 *
 * prod 下 repoRoot == <prebundled>，prebundle-daemon.mjs 已把仓库 .nvmrc 拷进去，
 * 所以这里读 `repoRoot/.nvmrc` 在 dev/prod 都能拿到钉死的版本。
 *
 * 优先级：① OD_NODE_BIN 显式覆盖 → ② **prod：app 自带的 Node**（见下）→
 * ③ 读 .nvmrc 钉的版本，拼 nvm 绝对路径 → ④ 扫 nvm 目录挑最高版本 →
 * ⑤ 实在没有才裸 'node'（赌运行环境，最后手段）。
 *
 * 为什么 prod 必须自带 Node（②）：daemon 的 better-sqlite3 .node 在 CI 按 Node 24
 * （ABI 137）编译，但**用户机器装的 Node 版本不可控**——尤其 Windows 没有 nvm 布局，
 * 旧逻辑会落到裸 'node' 撞上系统 Node 22（ABI 127）→ ERR_DLOPEN_FAILED → daemon
 * 崩。把对应平台的 Node 24 二进制打进包（CI 下载，electron-builder extraResources
 * 投到 <resources>/node-runtime/），daemon 固定用它跑，彻底不赌用户环境。
 * 见 [[2026-05-25-daemon自带Node彻底摆脱用户机器Node版本ABI错配]]。
 */
function resolveNodeBin(repoRoot: string): string {
  const override = process.env.OD_NODE_BIN
  if (override && existsSync(override)) return override

  // ② prod：app 自带的 Node 24（与 better-sqlite3 编译期 ABI 一致）。
  //    electron-builder 把它投到 process.resourcesPath/node-runtime/。
  if (app.isPackaged) {
    const bundledNode = join(
      process.resourcesPath,
      'node-runtime',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )
    if (existsSync(bundledNode)) return bundledNode
    console.warn(`[od-services] 自带 Node 缺失：${bundledNode}，回退 nvm/裸 node（ABI 可能不匹配）`)
  }

  const nvmNodeDir = join(homedir(), '.nvm', 'versions', 'node')

  // ② 读 .nvmrc 钉的版本，拼 ~/.nvm/versions/node/v<ver>/bin/node。
  // .nvmrc 可能写 "24.16.0" 或 "v24.16.0"，统一去掉前缀 v 再补回。
  try {
    const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim()
    if (nvmrc) {
      const ver = nvmrc.replace(/^v/, '')
      const pinned = join(nvmNodeDir, `v${ver}`, 'bin', 'node')
      if (existsSync(pinned)) return pinned
      console.warn(`[od-services] .nvmrc 钉 v${ver} 但 ${pinned} 不存在，尝试 nvm 最高版本`)
    }
  } catch {
    // 没 .nvmrc 或读不动，落到 ③
  }

  // ③ 扫 nvm 目录挑最高的 major（语义版本降序）。better-sqlite3 通常向上兼容到
  // 更高的 Node major（ABI 单调递增），挑最高比挑字典序第一（可能是 v18）安全得多。
  try {
    const versions = readdirSync(nvmNodeDir)
      .filter((v) => /^v\d+/.test(v))
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number)
        const pb = b.slice(1).split('.').map(Number)
        for (let i = 0; i < 3; i++) {
          if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
        }
        return 0
      })
    for (const v of versions) {
      const cand = join(nvmNodeDir, v, 'bin', 'node')
      if (existsSync(cand)) {
        console.warn(`[od-services] 用 nvm 最高版本 node: ${cand}`)
        return cand
      }
    }
  } catch {
    // 没装 nvm，落到 ④
  }

  // ④ 实在没有 nvm 布局，裸 'node' 赌 PATH（spawn shell:false 用 PATH 解析）。最后手段。
  console.warn('[od-services] 找不到 nvm node，回退裸 node（ABI 可能不匹配）')
  return 'node'
}

/** 找 bun（dev 下 spawn web dev server 用）。 */
function resolveBunBin(): string {
  const override = process.env.OD_BUN_BIN
  if (override && existsSync(override)) return override
  const homeBun = join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
  if (existsSync(homeBun)) return homeBun
  return 'bun'
}

/**
 * 构造一段「补丁 PATH」，拼到 daemon 子进程 PATH 之后，让 daemon 的 agent 检测
 * （detectAgents：probe `claude`/`codex`/`gemini`/`opencode`/`cursor-agent`/…）
 * 能在 GUI 启动场景下找到这些 CLI。
 *
 * 为什么必须补：GUI（Finder/Dock）启动的 Electron 继承的是 launchd 的精简 PATH
 * （`/usr/bin:/bin:/usr/sbin:/sbin`），**不含**用户 shell rc 里注入的 nvm / bun /
 * homebrew / ~/.local/bin 等目录。而本机 agent CLI 恰恰几乎全装在这些目录里
 * （实测：claude→~/.local/bin，gemini→~/.nvm/.../bin，codex/opencode→/opt/homebrew/bin，
 * cursor-agent→~/.local/bin）。不补全 PATH，daemon 的 `which <agent>` 全部 ENOENT，
 * 设置页就报「尚未检测到任何代理」，且每个 agent 都要走完一次失败 probe 拖慢启动。
 *
 * nvm 是按版本分目录的（versions/node/v<x>/bin），用户机上可能有多版本，所以
 * 枚举整个 versions/node/ 把每个版本的 bin 都加进去（哪个版本装了全局 CLI 事先不知）。
 * 全部用 existsSync 守卫，目录不存在就跳过——补丁 PATH 只增不减，不会破坏已有解析。
 */
function buildAgentDetectionPath(): string {
  const home = process.env.HOME ?? homedir()
  const dirs = [
    join(home, '.local', 'bin'), // claude, cursor-agent
    join(home, '.bun', 'bin'), // bun 装的全局 CLI
    '/opt/homebrew/bin', // Apple Silicon homebrew：codex, opencode
    '/usr/local/bin' // Intel homebrew / 手动安装
  ]

  // nvm：枚举每个已安装 Node 版本的 bin（gemini 等 npm 全局 CLI 落在这）。
  const nvmVersions = join(home, '.nvm', 'versions', 'node')
  try {
    for (const ver of readdirSync(nvmVersions)) {
      dirs.push(join(nvmVersions, ver, 'bin'))
    }
  } catch {
    // 没装 nvm 或读不动，跳过
  }

  return dirs.filter((d) => existsSync(d)).join(delimiter)
}

/**
 * 拉起 daemon 子进程。注入 origin 白名单（含 web dev origin），cwd 设为仓库根
 * 以便 daemon 的 resolveProjectRoot 能找到 skills/design-systems 等资产。
 *
 * prod 与 dev 的 daemon 入口/数据布局不同：
 *  - **dev**：跑仓库内 `apps/daemon/dist/cli.js`，数据写仓库 `.od/`，资源就在仓库里。
 *  - **prod**：跑 prebundle 出的单文件 `apps/daemon/dist/daemon-cli.mjs`（esbuild 把
 *    daemon 全部 JS 依赖打成一个 mjs，仅 better-sqlite3/blake3-wasm 留作 external，
 *    随包带原生 .node）。此时必须额外注入：
 *      · OD_BIN —— daemon 自我 spawn 子命令（MCP/artifacts CLI）时用，bundle 后
 *        require.resolve('@open-design/daemon') 失效，靠这个逃生口指回 mjs 自己。
 *      · OD_DATA_DIR —— 项目数据目录。app 资源目录是只读的（/Applications 下），
 *        不能往里写 .od/，所以指到用户可写的 userData。
 *      · OD_RESOURCE_ROOT —— skills/design-systems 等资源根。daemon 有安全校验
 *        （必须在 PROJECT_ROOT 之下），prebundled 布局已让 PROJECT_ROOT == repoRoot，
 *        所以这里传 repoRoot 即合法。
 */
function spawnDaemon(repoRoot: string): void {
  if (daemonProc && !daemonProc.killed) return

  // prod 跑 prebundle 单文件 mjs；dev 跑仓库内 tsc 产物 cli.js。
  const cliPath = app.isPackaged
    ? join(repoRoot, 'apps', 'daemon', 'dist', 'daemon-cli.mjs')
    : join(repoRoot, 'apps', 'daemon', 'dist', 'cli.js')
  if (!existsSync(cliPath)) {
    console.warn(`[od-services] daemon cli not found at ${cliPath} — skipping spawn`)
    return
  }

  const nodeBin = resolveNodeBin(repoRoot)
  const extraPath = buildAgentDetectionPath()

  // prod：项目数据写到用户可写目录（app 资源目录只读）。dev 留空，daemon 默认写
  // 仓库 .od/。提前建好，避免 daemon 首次 mkdir 时 race。
  const prodDataDir = app.isPackaged ? join(app.getPath('userData'), 'od-data') : null
  if (prodDataDir) {
    try {
      mkdirSync(prodDataDir, { recursive: true })
    } catch (err) {
      console.warn('[od-services] failed to create prod data dir:', err)
    }
  }

  daemonProc = spawn(nodeBin, [cliPath, '--no-open'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}${delimiter}${extraPath}`,
      // 关键：放行 web dev origin，否则 dev 下跨源 /api 调用被 daemon 403。
      // 见 [[2026-05-23-daemon-origin校验拒跨源致web调api全403]]
      //
      // 注意：**不能**把 app://open-design 加进这里。daemon 的 origin 校验
      // （origin-validation.ts）只接受 http:// / https://，遇到 app:// 在启动期
      // 直接抛错崩溃（7456 起不来 → 主进程 ECONNREFUSED）。prod 下 app:// 页面的
      // /api 请求由 appProtocol.ts 反代时**剥掉 Origin 头**，daemon 把它当可信的
      // 非浏览器请求放行（server.ts: origin==null → next()），根本不走白名单。
      // studio（apps/studio, dev 3100）的 origin 一并放行：Phase 1 它经自己的
      // next rewrites（服务端代理，无浏览器 Origin 头）调 daemon 不需要白名单，
      // 但 Phase 2/3 迁入的页面直连 daemon（尤其 SSE 流式接口，经 Next 代理会
      // 被 buffering 拖垮）时没有这行就是 403——提前排雷。
      OD_ALLOWED_ORIGINS: `${WEB_DEV_ORIGIN},http://127.0.0.1:${WEB_DEV_PORT},${STUDIO_DEV_ORIGIN},http://127.0.0.1:${STUDIO_DEV_PORT}`,
      OD_WEB_PORT: String(WEB_DEV_PORT),
      OD_PORT: String(DAEMON_PORT),
      // prod 专属：daemon bundle 后的自我定位 + 可写数据目录 + 资源根。dev 不设，
      // 让 daemon 走仓库内默认路径。
      ...(app.isPackaged
        ? {
            OD_BIN: cliPath,
            OD_DATA_DIR: prodDataDir as string,
            OD_RESOURCE_ROOT: repoRoot
          }
        : {})
    },
    // stdin inherited, stdout/stderr piped so the「日志分析」panel can capture
    // the daemon's output (the ECONNREFUSED dump etc.) — pipeChildToCollector
    // still echoes both to our terminal, so `bun run dev` reads the same.
    stdio: ['inherit', 'pipe', 'pipe'],
    // Windows：spawn 一个控制台程序（自带的 node.exe）默认会弹出一个
    // cmd 窗口。windowsHide 让子进程的控制台隐藏，daemon 在后台静默运行。
    // 非 Windows 平台忽略此选项。
    windowsHide: true
  })
  pipeChildToCollector(daemonProc, 'daemon')

  daemonProc.on('exit', (code, signal) => {
    console.log(`[od-services] daemon exited code=${code} signal=${signal}`)
    daemonProc = null
  })
  daemonProc.on('error', (err) => {
    console.warn('[od-services] daemon spawn error:', err)
  })
  console.log(`[od-services] daemon spawned: ${nodeBin} ${cliPath} (cwd=${repoRoot})`)
}

/**
 * dev 模式拉起 web dev server（next dev）。prod 不调用——web 已静态构建。
 */
function spawnWebDev(repoRoot: string): void {
  if (!is.dev) return
  if (webProc && !webProc.killed) return

  const webDir = join(repoRoot, 'apps', 'web')
  if (!existsSync(join(webDir, 'package.json'))) {
    console.warn(`[od-services] web package not found at ${webDir} — skipping`)
    return
  }

  const bunBin = resolveBunBin()
  webProc = spawn(bunBin, ['run', '--cwd', webDir, 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // 让 next.config 的代理把 /api 指向我们的 daemon 端口。
      OD_PORT: String(DAEMON_PORT),
      // next dev 认 PORT 环境变量。注入 WEB_DEV_PORT 让 next 真正监听的端口与
      // 上面那个被 Electron 探活/加载的常量恒等——否则 next 仍跑默认 3000，
      // Electron 探新端口就连不上（这正是换端口的全部意义所在）。
      PORT: String(WEB_DEV_PORT)
    },
    // 同 daemon：pipe stdout/stderr 进 collector（next dev 的 Local URL /
    // 编译日志），pipeChildToCollector 仍回显到终端。
    stdio: ['inherit', 'pipe', 'pipe'],
    // Windows 隐藏控制台窗口（dev 才走这里，但保持与 daemon 一致）。
    windowsHide: true
  })
  pipeChildToCollector(webProc, 'web')

  webProc.on('exit', (code, signal) => {
    console.log(`[od-services] web dev exited code=${code} signal=${signal}`)
    webProc = null
  })
  webProc.on('error', (err) => {
    console.warn('[od-services] web dev spawn error:', err)
  })
  console.log(`[od-services] web dev spawned: ${bunBin} run --cwd ${webDir} dev`)
}

/**
 * dev 模式拉起 studio dev server（next dev）。prod 不调用——studio 尚无打包
 * 形态（Phase 1，见 STUDIO_DEV_PORT 注释）。结构与 spawnWebDev 完全同构，
 * 差异只有目录、端口 env 名（STUDIO_DEV_PORT，被 studio dev script 的
 * `-p ${STUDIO_DEV_PORT:-3100}` 读取）和 collector 标签。
 */
function spawnStudioDev(repoRoot: string): void {
  if (!is.dev) return
  if (studioProc && !studioProc.killed) return

  const studioDir = join(repoRoot, 'apps', 'studio')
  if (!existsSync(join(studioDir, 'package.json'))) {
    console.warn(`[od-services] studio package not found at ${studioDir} — skipping`)
    return
  }

  const bunBin = resolveBunBin()
  studioProc = spawn(bunBin, ['run', '--cwd', studioDir, 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // 让 studio next.config 的 rewrites 把 /api、/artifacts 指向我们的 daemon。
      OD_PORT: String(DAEMON_PORT),
      // studio dev script 用 `-p ${STUDIO_DEV_PORT:-3100}`（flag 优先于 PORT env，
      // 所以这里注入的是同名 shell 变量而非 PORT）——保证监听端口与探活/加载
      // 用的 STUDIO_DEV_PORT 常量恒等。
      STUDIO_DEV_PORT: String(STUDIO_DEV_PORT),
      // studio 的 /canvas 路由用 iframe 嵌 web（Phase 3 真迁移完成前的过渡
      // 形态）。NEXT_PUBLIC_ 前缀让 next 在编译期内联给客户端代码——studio
      // 页面自己不知道壳侧的 WEB_DEV_PORT 常量，靠这条 env 传递。
      NEXT_PUBLIC_OD_WEB_ORIGIN: WEB_DEV_ORIGIN
    },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true
  })
  pipeChildToCollector(studioProc, 'studio')

  studioProc.on('exit', (code, signal) => {
    console.log(`[od-services] studio dev exited code=${code} signal=${signal}`)
    studioProc = null
  })
  studioProc.on('error', (err) => {
    console.warn('[od-services] studio dev spawn error:', err)
  })
  console.log(`[od-services] studio dev spawned: ${bunBin} run --cwd ${studioDir} dev`)
}

/**
 * 轮询 daemon 健康端点直到返回 200，或超时。第二个 tab 在此 resolve 后才加载，
 * 避免加载到一个还没起好的 web/daemon 而白屏。
 */
export async function waitForDaemonReady(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DAEMON_ORIGIN}/api/skills`, {
        headers: { Origin: WEB_DEV_ORIGIN }
      })
      if (res.ok) return true
    } catch {
      // daemon 还没起好，继续轮询
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** dev 下额外等 web dev server ready（next dev 冷启动）。 */
export async function waitForWebReady(timeoutMs = 30_000): Promise<boolean> {
  if (!is.dev) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(WEB_DEV_ORIGIN)
      if (res.ok) return true
    } catch {
      // 继续轮询
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** dev 下等 studio dev server ready（next dev 冷启动）。与 waitForWebReady 同构。 */
export async function waitForStudioReady(timeoutMs = 30_000): Promise<boolean> {
  if (!is.dev) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(STUDIO_DEV_ORIGIN)
      if (res.ok) return true
    } catch {
      // 继续轮询
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * 主进程启动时调用一次：拉起 daemon（+ dev 下 web、studio）。同步返回，子进程
 * 在后台启动；调用方用 waitForDaemonReady / waitForWebReady / waitForStudioReady
 * 等就绪。
 */
export function startOpenDesignServices(selfDir: string): void {
  const repoRoot = resolveRepoRoot(selfDir)
  // 缓存给 resolveWebStaticDir()（app:// 协议 handler 注册时复用，见上方注释）。
  cachedRepoRoot = repoRoot
  spawnDaemon(repoRoot)
  spawnWebDev(repoRoot)
  spawnStudioDev(repoRoot)
}

/**
 * prod 下 web 静态产物（next export 写到 apps/web/out）的磁盘目录。
 * 与 daemon 的 STATIC_DIR（server.ts: PROJECT_ROOT/apps/web/out）同一处，
 * 只是这里由 desktop 进程直接读盘喂给 app:// 协议，不再经过 daemon 的 HTTP。
 *
 * cachedRepoRoot 由 startOpenDesignServices 在 ready 早期填充；万一未填充
 * （理论上不会，调用顺序保证），回退到当前模块往上推算，至少不抛。
 */
export function resolveWebStaticDir(): string {
  const root = cachedRepoRoot ?? join(process.cwd(), '..', '..')
  return join(root, 'apps', 'web', 'out')
}

/** 应用退出时清理子进程，避免 daemon/web/studio 变孤儿进程占着端口。 */
export function stopOpenDesignServices(): void {
  for (const proc of [webProc, studioProc, daemonProc]) {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM')
      } catch (err) {
        console.warn('[od-services] kill failed:', err)
      }
    }
  }
  daemonProc = null
  webProc = null
  studioProc = null
}

/**
 * 第二个 tab 该加载的 web URL。
 *  - dev：web dev server（next dev, localhost:3000）—— 保留 HMR。
 *  - prod：app:// 自定义协议（appProtocol.ts），直接读磁盘 out/，不占端口、
 *    不再让 daemon serve 页面（daemon 只保留作 /api 后端）。结尾的 / 是必需的，
 *    standard scheme 下 app://open-design 不带路径会被当成无 path 而非根。
 *
 * 末尾的 `?host=desktop` 是给嵌入的 web 应用的「我在桌面壳里」信号：这个
 * web tab **故意不挂任何 preload**（见 newWebTab 注释），所以 web 端没有
 * 任何注入的全局对象（`__od__` / `electronSettings` / `chatApi` 全都没有）
 * 可供识别宿主——只能靠 URL 查询参数。web 端 EntryShell 读到它后会隐藏
 * 自己的设置齿轮，避免和 shell 顶栏常驻的设置入口（UserInfoBar）重复。
 * 沿用 resolveWebSettingsUrl 的 `?settings=1` 同款查询参数约定。
 */
export function resolveWebTabUrl(): string {
  return is.dev
    ? `${WEB_DEV_ORIGIN}/?host=desktop`
    : `${APP_PROTOCOL_ORIGIN}/?host=desktop`
}

/**
 * URL for the embedded settings overlay — the same Open Design web app as
 * the web tab, but loaded with `?settings=1` so it boots straight into a
 * full-screen SettingsDialog modal (see apps/web App.tsx). Reusing the web
 * app means the settings overlay has the full, always-in-sync feature set
 * (providers / connectors / MCP / skills / notifications / …) backed by the
 * daemon, with zero reimplementation in the desktop renderer.
 *
 * dev keeps the next-dev origin (HMR); prod uses the app:// protocol root
 * with the query appended.
 */
export function resolveWebSettingsUrl(): string {
  return is.dev
    ? `${WEB_DEV_ORIGIN}/?settings=1`
    : `${APP_PROTOCOL_ORIGIN}/?settings=1`
}

/**
 * studio tab 该加载的 URL。**只有 dev 分支**：studio 是三前端合并的迁移目标
 * （apps/studio/README.md），Phase 1 尚无打包形态，prod 下调用方（main/index.ts）
 * 根本不建 studio tab，所以这里不需要（也还没法）给出 prod URL。打包形态
 * （standalone server vs static export 回退）在聊天 UI 迁移完成后决定。
 *
 * 不带 `?host=desktop`：web tab 需要它是因为不挂 preload、只能靠 URL 识别宿主；
 * studio tab 挂完整 chatApi preload（见 tabRegistry.newStudioTab），页面检测
 * `window.chatApi` 存在即知宿主，无需查询参数。
 */
export function resolveStudioTabUrl(): string {
  return `${STUDIO_DEV_ORIGIN}/`
}
