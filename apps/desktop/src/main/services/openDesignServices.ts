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
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { is } from '@electron-toolkit/utils'

/** daemon 绑定端口。与 apps/daemon/src/cli.ts 默认值一致。 */
export const DAEMON_PORT = 7456
/** dev 下 web dev server（next dev）的端口。next 默认 3000。 */
export const WEB_DEV_PORT = 3000

const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`
const WEB_DEV_ORIGIN = `http://localhost:${WEB_DEV_PORT}`

let daemonProc: ChildProcess | null = null
let webProc: ChildProcess | null = null

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
 * 定位 monorepo 仓库根。dev 下主进程 bundle 在 apps/desktop/out/main，
 * 往上三级到仓库根（free-code/cli 的路径解析同款逻辑，见 engine.ts）。
 * prod 下走 process.resourcesPath（打包时 daemon 随 app 资源一起发）。
 */
function resolveRepoRoot(selfDir: string): string {
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
 * ABI 137）编译。所以这里**不能**裸返回 'node' 赌 PATH——GUI 启动的 Electron 继承的
 * 父 shell PATH 可能是别的 nvm 版本（实测踩过：父 shell 是 Node 22/ABI 127，daemon
 * dlopen 那份 ABI 137 的 .node 直接 ERR_DLOPEN_FAILED 崩掉）。
 *
 * 优先级：① OD_NODE_BIN 显式覆盖 → ② 读 .nvmrc 钉的版本，拼 nvm 绝对路径（命中即用，
 * 保证 ABI 与编译期一致）→ ③ 兜底裸 'node'（nvm 布局不存在时退回旧行为，不比从前差）。
 */
function resolveNodeBin(repoRoot: string): string {
  const override = process.env.OD_NODE_BIN
  if (override && existsSync(override)) return override

  // 读仓库根 .nvmrc 钉的版本，拼 ~/.nvm/versions/node/v<ver>/bin/node。
  // .nvmrc 可能写 "24.16.0" 或 "v24.16.0"，统一去掉前缀 v 再补回。
  try {
    const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim()
    if (nvmrc) {
      const ver = nvmrc.replace(/^v/, '')
      const pinned = join(homedir(), '.nvm', 'versions', 'node', `v${ver}`, 'bin', 'node')
      if (existsSync(pinned)) return pinned
      console.warn(`[od-services] .nvmrc 钉 v${ver} 但 ${pinned} 不存在，回退 PATH 上的 node`)
    }
  } catch {
    // 没 .nvmrc 或读不动，回退裸 'node'
  }

  // 兜底：PATH 上找 node。spawn 时 shell:false，给裸 'node' 让 spawn 用 PATH 解析。
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
 * 拉起 daemon 子进程。注入 origin 白名单（含 web dev origin），cwd 设为仓库根
 * 以便 daemon 的 resolveProjectRoot 能找到 skills/design-systems 等资产。
 */
function spawnDaemon(repoRoot: string): void {
  if (daemonProc && !daemonProc.killed) return

  const cliPath = join(repoRoot, 'apps', 'daemon', 'dist', 'cli.js')
  if (!existsSync(cliPath)) {
    console.warn(`[od-services] daemon cli not found at ${cliPath} — skipping spawn`)
    return
  }

  const nodeBin = resolveNodeBin(repoRoot)
  // PATH 兜底：dev 下 GUI 启动的 Electron 可能拿不到 nvm 注入的 PATH，
  // 补上 ~/.nvm 当前 node 目录与 /usr/local/bin、/opt/homebrew/bin。
  const extraPath = [
    join(process.env.HOME ?? '', '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ].join(delimiter)

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
      OD_ALLOWED_ORIGINS: `${WEB_DEV_ORIGIN},http://127.0.0.1:${WEB_DEV_PORT}`,
      OD_WEB_PORT: String(WEB_DEV_PORT),
      OD_PORT: String(DAEMON_PORT)
    },
    stdio: 'inherit'
  })

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
      OD_PORT: String(DAEMON_PORT)
    },
    stdio: 'inherit'
  })

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

/**
 * 主进程启动时调用一次：拉起 daemon（+ dev 下 web）。同步返回，子进程在后台启动；
 * 调用方用 waitForDaemonReady / waitForWebReady 等就绪。
 */
export function startOpenDesignServices(selfDir: string): void {
  const repoRoot = resolveRepoRoot(selfDir)
  // 缓存给 resolveWebStaticDir()（app:// 协议 handler 注册时复用，见上方注释）。
  cachedRepoRoot = repoRoot
  spawnDaemon(repoRoot)
  spawnWebDev(repoRoot)
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

/** 应用退出时清理子进程，避免 daemon/web 变孤儿进程占着端口。 */
export function stopOpenDesignServices(): void {
  for (const proc of [webProc, daemonProc]) {
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
}

/**
 * 第二个 tab 该加载的 web URL。
 *  - dev：web dev server（next dev, localhost:3000）—— 保留 HMR。
 *  - prod：app:// 自定义协议（appProtocol.ts），直接读磁盘 out/，不占端口、
 *    不再让 daemon serve 页面（daemon 只保留作 /api 后端）。结尾的 / 是必需的，
 *    standard scheme 下 app://open-design 不带路径会被当成无 path 而非根。
 */
export function resolveWebTabUrl(): string {
  return is.dev ? WEB_DEV_ORIGIN : `${APP_PROTOCOL_ORIGIN}/`
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
