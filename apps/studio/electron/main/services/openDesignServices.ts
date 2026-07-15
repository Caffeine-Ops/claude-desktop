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
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
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
let studioProc: ChildProcess | null = null

/**
 * 启动时算出的仓库根，缓存到模块级，供 resolveWebStaticDir() 复用。
 * app:// 协议 handler（appProtocol.ts）在 ready 后注册时拿不到 selfDir，
 * 靠这个缓存解析 apps/web/out 的磁盘路径。startOpenDesignServices 先于
 * registerAppProtocol 调用，所以读到时一定已填充。
 */
let cachedRepoRoot: string | null = null

/**
 * 定位「仓库根」——即一个能 join('apps','daemon','dist',...) / join('apps','web','out')
 * 找到 daemon bundle、web 静态产物、skills/design-systems 等资源的根目录。
 *
 * - **prod（打包后）**：资源由 electron-builder 的 extraResources 投放到
 *   `process.resourcesPath/prebundled`，内部刻意复刻 monorepo 的 `apps/daemon/dist`、
 *   `apps/web/out`、`skills/` 等布局，让 daemon 的 resolveProjectRoot(__dirname) 算出
 *   的 PROJECT_ROOT 正好落在这个 prebundled 根上（见 prebundle-daemon.mjs）。daemon
 *   的资源安全校验（OD_RESOURCE_ROOT 必须在 PROJECT_ROOT 之下）也因此天然满足。
 * - **dev**：主进程 bundle 在 apps/studio/out-electron/main（上四级=仓库根）；
 *   兜底用 cwd（cwd = apps/studio，上两级=仓库根）。
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
  // apps/studio/out-electron/main → 上四级 = repo 根（旧 desktop 布局是
  // 上三级；并包后 bundle 深了一层，这里跟着改——算错也有 cwd 兜底守住）
  const fromBundle = join(selfDir, '../../../..')
  if (existsSync(join(fromBundle, 'apps', 'daemon'))) return fromBundle
  // 兜底：cwd（dev 下 electron-vite 在 apps/studio 跑，cwd/../.. = 根）
  const fromCwd = join(process.cwd(), '../..')
  if (existsSync(join(fromCwd, 'apps', 'daemon'))) return fromCwd
  return fromBundle
}

/**
 * 解析出一个跑 daemon 的 JS 运行时可执行文件。
 *
 * **历史大反转（2026-07-15）**：本函数以前**刻意避开** process.execPath（Electron
 * 二进制），因为 daemon 的 better-sqlite3 .node 死绑 Node ABI，Electron 内嵌 node 的
 * ABI（148）与之不符会 ERR_DLOPEN_FAILED。为此项目打包了一份独立的 node-runtime
 * （ABI 与 better-sqlite3 对齐），并层层回退到 nvm 版本，全为「拿到 ABI 正确的 node」。
 *
 * 现在 daemon **没有任何 native 模块**了——SQLite 层已迁到 node:sqlite（Node 24 内置，
 * 零 native 编译，无 ABI 可谈）。于是 ABI 匹配这个约束整个消失，process.execPath 从
 * 「禁忌」变成「首选」：Electron 43 内嵌 node 24.17 满足 node:sqlite 的运行要求
 * （≥22.5，无标志），且它必然存在、不赌用户环境、不占安装包额外体积。
 *
 * 用 ELECTRON_RUN_AS_NODE=1（由 spawnDaemon 注入）让 Electron 以纯 node 模式跑 daemon。
 *
 * 优先级：① OD_NODE_BIN 显式覆盖（逃生口 / 特殊调试）→ ② process.execPath
 * （Electron 自身，dev/prod 统一，主路径）。
 */
function resolveNodeBin(_repoRoot: string): string {
  const override = process.env.OD_NODE_BIN
  if (override && existsSync(override)) return override

  // Electron 自身，以 ELECTRON_RUN_AS_NODE 模式跑（spawnDaemon 负责设该 env）。
  // dev（bun run dev 起的 electron-vite）与 prod（打包 app）下 process.execPath 都
  // 指向 Electron 二进制，其内嵌 node 24 满足 node:sqlite；无 native 依赖，无需 ABI 对齐。
  return process.execPath
}

/** nodeBin 是否为 Electron 自身（需以 ELECTRON_RUN_AS_NODE 模式跑）。 */
function isElectronRunAsNode(nodeBin: string): boolean {
  // OD_NODE_BIN 覆盖成真·node 时不是 Electron，不该设 ELECTRON_RUN_AS_NODE。
  return nodeBin === process.execPath
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
  // 当 nodeBin 是 Electron 自身时，用 ELECTRON_RUN_AS_NODE=1 让它以纯 node 模式跑 daemon。
  // 孙进程传播由 daemon 侧已有机制正确处理，无需在此 delete：
  //  · daemon 自我 spawn 子命令（od mcp 等，走 process.execPath=Electron）时，
  //    mcp-routes.ts 探测 `ELECTRON_RUN_AS_NODE === '1'` 并**主动传播**给孙进程
  //    （mcp-install-info.ts），让孙进程也用同一个 Electron-as-node 跑——正是所需。
  //  · daemon spawn 第三方二进制（agent CLI / git / ffmpeg）时，即便继承了该 env 也
  //    无害：ELECTRON_RUN_AS_NODE 只改变 **Electron 二进制自身** 被启动时的行为，对
  //    非 Electron 程序完全无意义、被忽略。
  const runAsNodeEnv = isElectronRunAsNode(nodeBin) ? { ELECTRON_RUN_AS_NODE: '1' } : {}

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
      ...runAsNodeEnv,
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
 * dev 模式拉起 studio 前端 dev server（next dev）。prod 不调用——prod 走
 * static export + app://studio 读盘。
 *
 * 脚本名必须是 `dev:next` 而不是 `dev`：desktop 并包后 studio 包的 `dev`
 * 是 electron-vite dev（整个桌面应用的入口），在这里 spawn `dev` 会让 main
 * 递归拉起第二个 Electron 实例。Next 侧的独立入口固定叫 dev:next。
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
  studioProc = spawn(bunBin, ['run', '--cwd', studioDir, 'dev:next'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // 让 studio next.config 的 rewrites 把 /api、/artifacts 指向我们的 daemon。
      OD_PORT: String(DAEMON_PORT),
      // studio 的 dev:next script 用 `-p ${STUDIO_DEV_PORT:-3100}`（flag 优先于
      // PORT env，所以这里注入的是同名 shell 变量而非 PORT）——保证监听端口
      // 与探活/加载用的 STUDIO_DEV_PORT 常量恒等。
      STUDIO_DEV_PORT: String(STUDIO_DEV_PORT)
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
  console.log(`[od-services] studio dev spawned: ${bunBin} run --cwd ${studioDir} dev:next`)
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
  spawnStudioDev(repoRoot)
}

/**
 * prod 下 studio 静态产物（next export 写到 apps/studio/out）的磁盘目录。
 * 与 resolveWebStaticDir 同款逻辑；prebundle-daemon.mjs 把它拷进
 * prebundled/apps/studio/out，打包后 repoRoot 指向 prebundled 根时路径不变。
 */
export function resolveStudioStaticDir(): string {
  const root = cachedRepoRoot ?? join(process.cwd(), '..', '..')
  return join(root, 'apps', 'studio', 'out')
}

/** 应用退出时清理子进程，避免 daemon/web/studio 变孤儿进程占着端口。 */
export function stopOpenDesignServices(): void {
  for (const proc of [studioProc, daemonProc]) {
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM')
      } catch (err) {
        console.warn('[od-services] kill failed:', err)
      }
    }
  }
  daemonProc = null
  studioProc = null
}

/**
 * studio tab 该加载的 URL。
 *  - dev：studio dev server（next dev, localhost:3100）—— 保留 HMR。
 *  - prod：app://studio 自定义协议（appProtocol.ts 按 host 分发到
 *    apps/studio/out），与 web tab 的 app://open-design 同一 handler、
 *    同一套反代/SPA fallback。结尾 / 必需（standard scheme 规则同
 *    resolveWebTabUrl 注释）。
 *
 * 不带 `?host=desktop`：web tab 需要它是因为不挂 preload、只能靠 URL 识别宿主；
 * studio tab 挂完整 chatApi preload（见 tabRegistry.newStudioTab），页面检测
 * `window.chatApi` 存在即知宿主，无需查询参数。
 */
export function resolveStudioTabUrl(): string {
  return is.dev ? `${STUDIO_DEV_ORIGIN}/chat` : 'app://studio/chat'
}
