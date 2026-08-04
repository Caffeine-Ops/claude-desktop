import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app } from 'electron'

import { componentDir, readComponentRecord } from './componentPaths'

const execFileP = promisify(execFile)

/**
 * 按需下载的 CLI 落点（存在且记账有效时返回一个候选，否则空数组）。
 *
 * 拆成函数而不是内联，是为了让「记账 + readyProbe 双条件」这个判据只有一处：
 * componentInstaller 判断「装没装」用的也是 readComponentRecord。两处用同一个
 * 真相，才不会出现「门说没装好、引擎其实能跑」或反过来。
 */
function downloadedCliCandidate(bundledName: string): string[] {
  try {
    const rec = readComponentRecord('cli', bundledName)
    if (!rec) return []
    return [join(componentDir('cli'), bundledName)]
  } catch {
    // app 尚未 ready 等极早期调用：拿不到 userData 就当作没下载过，别让整条
    // 解析链因为一个可选候选而抛。
    return []
  }
}

/** 按需下载的 python-runtime 落点。判据同 CLI：记账 + 解释器真在盘上。 */
function downloadedPythonCandidate(interpreterRel: string): string[] {
  try {
    const rec = readComponentRecord('python-runtime', interpreterRel)
    return rec ? [componentDir('python-runtime')] : []
  } catch {
    return []
  }
}

/** 「AI 引擎当前可用吗」——与 engine spawn 时用的是同一个解析函数。
 *
 *  为什么门必须用这个而不是「下载装过没有」：只要 resolveBundledCliPath() 解析
 *  得出路径，engine 就起得来，门就不该挡；反之亦然。一个真相、一个函数，杜绝
 *  「门说没准备好、引擎其实能跑」这类自相矛盾。中间态（包里还带二进制）的用户
 *  因此一次门都不会看到——这是拆桥前不打扰任何人的保证。 */
export function isCliAvailable(): boolean {
  try {
    resolveBundledCliPath()
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the absolute path of the bundled fusion-code CLI binary. Pure
 * env + path resolution — no engine instance state — so it can be called
 * from any context (the per-engine CLI_BACKEND_GET handler AND the
 * engine-free settings-overlay handler both use it). Throws with the list
 * of tried locations when the binary can't be found.
 *
 * Kept in sync with ChatEngine.resolveFusionCliPath(), which delegates here.
 */
export function resolveBundledCliPath(): string {
  const envOverride = process.env.FUSION_CODE_CLI_PATH
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new Error(
        `FUSION_CODE_CLI_PATH is set to "${envOverride}" but that file does not exist.`
      )
    }
    return envOverride
  }

  const selfDir = dirname(fileURLToPath(import.meta.url))
  const bundledName =
    process.platform === 'win32' ? 'fusion-code-cli.exe' : 'fusion-code-cli'
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  const candidates = [
    // 按需下载的那一份，**刻意排在 resourcesPath 之前**。
    //
    // 顺序即「谁覆盖谁」。放后面的话，任何一个 Resources 里还带着旧二进制的包
    // （升级路径、或拆桥后的回滚）都会永远用不上新下载的版本。放前面则三种形态
    // 都对：新包（Resources 无二进制）命中这条；老包升上来且用户下过 → 命中这条，
    // 拿到的是新的，正是想要的；老包且从没下过 → 落到下面的 resourcesPath 照旧
    // 能用——**这正是「先接下载、后拆桥」的中间态不翻车的保证**。
    //
    // 代价：下载的那份若被杀软删了一半，会挡住本来可用的 Resources 兜底。所以判据
    // 是 readComponentRecord（记账 + readyProbe 双条件）而不是裸 existsSync，
    // 且 componentInstaller 的启动自检还会对它跑一次结构走查，不过就当作未安装。
    ...downloadedCliCandidate(bundledName),
    ...(resourcesPath ? [resolve(resourcesPath, bundledName)] : []),
    resolve(process.cwd(), '../free-code/cli'),
    resolve(process.cwd(), '../../../free-code/cli'),
    resolve(selfDir, '../../../free-code/cli'),
    resolve(selfDir, '../../../../free-code/cli'),
    resolve(selfDir, '../../../../../free-code/cli')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(
    'Fusion Code CLI binary not found. Tried:\n' +
      candidates.map((c) => `  - ${c}`).join('\n') +
      '\nSet FUSION_CODE_CLI_PATH in env.json (or the shell) to override.'
  )
}

/**
 * Resolve an absolute path to a Node binary that can *execute a .js entry*.
 *
 * 为什么需要：claude-agent-sdk 不直接 spawn 我们给的 cli 路径，而是
 * `spawn(executable, [...executableArgs, pathToClaudeCodeExecutable, ...flags])`，
 * 其中 `executable` 默认取 `process.versions.bun ? 'bun' : 'node'` —— 在打包后的
 * Electron 主进程里 `process.versions.bun` 是 undefined，于是退化成裸字符串
 * `'node'`。Windows 上 GUI 启动的 Electron 继承的是 launchd/精简 PATH，往往**没有
 * node.exe**（用户机器的 Node 在别处、或根本没装），`spawn('node', …)` 直接
 * `spawn EINVAL`（errno -4071），系统 claude 这条路彻底起不来。
 * 见 [[2026-05-25-windows系统claude.cmd经SDK裸node-spawn-EINVAL]]、
 * [[2026-05-23-GUI启动Electron精简PATH致agent检测全失败]]。
 *
 * 所以 prod 下统一把 SDK 的 `executable` 显式指到 **Electron 自身**
 * （process.execPath）——它内嵌的 node 就是我们要的运行时，绝对路径绕开 PATH、
 * 跨平台一致、且必然存在。注意：这里**不要求** ABI 匹配——SDK 只是用它执行
 * claude 的 cli.js 脚本，不加载任何 native 模块。
 *
 * 历史（2026-07-15 前）：这里曾返回 app 自带的 `<resources>/node-runtime/node`。
 * 那份独立 Node 是为 daemon 的 better-sqlite3 ABI 对齐而打包的；daemon 迁到
 * node:sqlite 去掉 native 依赖后，node-runtime 整个不再打包，此处随之改用
 * process.execPath。
 *
 * 关键：Electron 二进制默认会启动 GUI 模式，必须让调用方在 spawn 时设置
 * `ELECTRON_RUN_AS_NODE=1` 才会以纯 node 跑那个 .js（见 engine.ts SDK env 注入，
 * 用 isElectronJsRuntime() 判断）。
 *
 * 返回 null 表示「dev」——dev 下裸 'node' 通常能在 PATH 命中，SDK 走默认即可，
 * 无需强指 Electron（也避免 dev 下给 SDK 设 ELECTRON_RUN_AS_NODE 的额外分支）。
 */
export function resolveJsRuntimeBin(): string | null {
  const override = process.env.OD_NODE_BIN
  if (override && existsSync(override)) return override

  if (app.isPackaged) {
    // Electron 自身。以 ELECTRON_RUN_AS_NODE=1 模式跑（engine.ts SDK env 负责设）。
    return process.execPath
  }
  return null
}

/**
 * jsRuntimeBin 是否为 Electron 自身（SDK 需以 ELECTRON_RUN_AS_NODE 模式 spawn 它）。
 * OD_NODE_BIN 覆盖成真·node 时返回 false，不该设该 env。
 */
export function isElectronJsRuntime(jsRuntimeBin: string | null): boolean {
  return jsRuntimeBin === process.execPath
}

/**
 * 把系统 claude 的「可执行入口」规整成一个 SDK 能直接 spawn 的真实目标。
 *
 * 背景：mac/Linux 上系统 claude 是原生二进制（或无后缀脚本），SDK 直接 spawn 即可，
 * 原样返回。但 **Windows 上 npm 全局安装的 claude 是 `claude.cmd`**（批处理 shim）——
 * Node 不带 `shell:true` 的 spawn/execFile **无法执行 .cmd/.bat**（CVE-2024-27980 之后
 * 收紧），SDK 的 Fx() 又把 `.cmd`（不以 .js/.mjs/.ts 结尾）当 native binary 裸 spawn
 * → spawn EINVAL（errno -4071）。见 [[2026-05-25-windows系统claude.cmd经SDK裸node-spawn-EINVAL]]。
 *
 * 关键：现代 `@anthropic-ai/claude-code`（≥2.x）的 npm 包 `bin` 字段指向
 * `bin/claude.exe`——一个 **bun 编译的原生二进制**，postinstall 从平台包
 * (`@anthropic-ai/claude-code-win32-x64`) 复制真二进制覆盖占位符。**它没有 cli.js**。
 * 所以 .cmd shim 内部调的是 `node_modules\@anthropic-ai\claude-code\bin\claude.exe`，
 * 而非旧版的 `node ...\cli.js`。
 *
 * 修法：把 .cmd 解析成它真正调用的目标——**优先 bin/claude.exe（现代，真二进制，
 * SDK 直接 spawn .exe 合法不报错），cli.js 作为旧版兜底**。两条都按标准 npm 布局直接
 * 拼，再读 .cmd 文本兜底（同时匹配 .exe 和 .js 字面量路径）。
 *
 * 返回 .exe 时上层 engine 不会套 `executable: node`（那只给 .js 入口），SDK 直接 spawn
 * 这个 exe。解析失败时返回原始 .cmd——让上层照旧尝试，错误信息明确不静默吞。非 .cmd/.bat
 * （mac/Linux 脚本、原生二进制、或已是 .js）一律原样返回，mac 不受影响。
 */
export function resolveSystemClaudeJsEntry(cliPath: string): string {
  // 非 Windows shim（mac/Linux 脚本、原生二进制、已是 .js）→ 原样返回。
  // 只对 Windows 的 .cmd/.bat/.ps1 做解析。
  if (!/\.(cmd|bat|ps1)$/i.test(cliPath)) return cliPath

  const dir = dirname(cliPath)
  const pkgBin = join(dir, 'node_modules', '@anthropic-ai', 'claude-code')

  // ① 标准 npm 全局布局，按优先级直接拼真实入口（claude.cmd 与 node_modules 同级）：
  //    - 现代（≥2.x）：bin/claude.exe（postinstall 复制的原生二进制，真 spawn 目标）
  //    - 旧版：cli.js / cli.mjs（node 跑的 JS 入口）
  const candidates = [
    join(pkgBin, 'bin', 'claude.exe'),
    join(pkgBin, 'cli.js'),
    join(pkgBin, 'cli.mjs')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  // ② 读 .cmd shim 文本兜底：shim 里会出现 "...\bin\claude.exe" 或 "...\cli.js" 字面量。
  //    抠出第一个含 claude-code 且以 .exe/.js/.mjs 结尾的路径片段，相对 dir 解析。
  //    .exe 优先于 .js（现代包二者不会并存，但万一布局异常，真二进制更稳）。
  try {
    const text = readFileSync(cliPath, 'utf8')
    const m =
      text.match(/[^"'\s]*claude-code[^"'\s]*\.exe/i) ||
      text.match(/[^"'\s]*claude-code[^"'\s]*\.m?js/i)
    if (m) {
      const raw = m[0].replace(/%~?dp0%\\?/i, '').replace(/^["']|["']$/g, '')
      const resolved = resolve(dir, raw)
      if (existsSync(resolved)) return resolved
    }
  } catch {
    // 读不动 shim（权限/编码）→ 落到原样返回
  }

  console.warn(
    `[cliDetect] 无法从 ${cliPath} 解析出 claude.exe/cli.js，原样交给 SDK（Windows 上可能 spawn EINVAL）`
  )
  return cliPath
}

// resolveBundledSkillsPluginDir 本体已抽到 skillsDir.ts（electron-free）——
// proposalPrompt.ts 运行期读 skills/proposal-writer 模板要用它，且其 bun test
// 在无 electron 的进程里跑，依赖链上不允许出现本文件顶部的 electron import。
// 这里 re-export 保住既有 import 路径（seedSkills/engine 等）。
export {
  resolveBundledSkillsPluginDir,
  resolveCoworkPluginEntries,
  type CoworkPluginEntry
} from './skillsDir'

/**
 * Resolve the bundled standalone Python *home* directory (the dir holding
 * `bin/python3` on mac/Linux, `python.exe` on Windows). The ppt-creator skill is
 * a Python skill: its scripts shell out via `python3 ${SKILL_DIR}/scripts/...`
 * and need ~18 deps with native extensions (PyMuPDF/Pillow/numpy). We ship a
 * pinned 3.12 runtime (python-build-standalone, CI download — see build.yml)
 * rather than betting on the user's machine python3, which may be absent or a
 * too-new version with no cp31x wheels (the py3.14 source-build hang — see
 * [[2026-05-25-py314-无wheel-venv编译卡死]]).
 *
 * This home is NOT used to run anything directly. It is injected into the
 * fusion-code child env as `PPT_MASTER_PYTHON_HOME`; the skill's
 * `bin/ensure-python.sh` reads it to pick the base interpreter when it creates
 * the per-user venv at `~/.ppt-master/venv`. When this returns null (dev
 * without a local runtime, or a platform we don't bundle), the bootstrap falls
 * back to system python3.12/3.11 on its own — never an error here.
 *
 * dev/prod split mirrors resolveJsRuntimeBin():
 *   - prod (packaged): electron-builder copies `python-runtime/<platform>` →
 *     `<resourcesPath>/python-runtime` (extraResources, see package.json).
 *   - dev: use the in-repo `apps/studio/python-runtime/<platform>` if a dev
 *     populated it (normally absent in dev — bootstrap then uses system python).
 *
 * `PPT_MASTER_PYTHON_HOME` env overrides everything for diagnostics.
 */
export function resolveBundledPythonHome(): string | null {
  const envOverride = process.env.PPT_MASTER_PYTHON_HOME
  if (envOverride) return existsSync(envOverride) ? envOverride : null

  const platformDir = process.platform === 'win32' ? 'win' : 'mac'
  const interpreterRel =
    process.platform === 'win32' ? 'python.exe' : join('bin', 'python3')

  const selfDir = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  const candidates = [
    // 按需下载的那一份，同 resolveBundledCliPath 的理由排在 resourcesPath 之前。
    // 注意它**没有平台子层**（一台机器只有一种平台），与随包/dev 的
    // `<platform>/` 布局不同——现有的 resourcesPath 候选本就不带平台子层，模式一致。
    ...downloadedPythonCandidate(interpreterRel),
    ...(resourcesPath ? [resolve(resourcesPath, 'python-runtime')] : []),
    resolve(selfDir, '../../python-runtime', platformDir),
    resolve(process.cwd(), 'python-runtime', platformDir),
    resolve(process.cwd(), 'apps/studio/python-runtime', platformDir)
  ]
  for (const p of candidates) {
    // Only return a home whose interpreter actually exists — a half-populated
    // dir would make the bootstrap think it has a runtime and then fail.
    if (existsSync(join(p, interpreterRel))) return p
  }
  return null
}

/**
 * 系统已安装的 Python home（满足 `resolveBundledPythonHome()` 同款契约形状：
 * mac `<home>/bin/python3`、win `<home>\python.exe`）。ppt-creator/writing/
 * spreadsheets 三个 skill 的 `ensure-python.sh|cmd` 消费的是这个契约，不是
 * python 本身——检测函数复用同一形状，脚本零改动即可接受注入。
 *
 * **版本闸门只认 3.11 / 3.12**：python-runtime 组件存在的唯一理由就是躲开
 * ≥3.13 没有预编译 wheel、pip 退化源码编译卡死的坑（见上面 resolveBundledPythonHome
 * 注释引用的 [[2026-05-25-py314-无wheel-venv编译卡死]]）。检测到 3.13+ 必须
 * 视为「没有可用的系统 python」、照旧下载 70MB 的捆绑 runtime——宽版本闸门
 * 省下的下载流量远不值一次离奇的 pip 编译失败。
 */
export interface SystemPythonHome {
  home: string
  version: '3.11' | '3.12'
}

const SYSTEM_PYTHON_CACHE_TTL_MS = 30_000
let systemPythonCache: { info: SystemPythonHome | null; ts: number } | null = null

/** 供将来「用户装了/卸了 python」场景强制重扫，同 invalidateCache() 的用途。 */
export function invalidateSystemPythonCache(): void {
  systemPythonCache = null
}

/**
 * 同步、零 spawn 扫描版本化安装路径。componentInstaller 的
 * `getRuntimeComponentsState()` 在冷启动同步路径里调用（splash 还压着的
 * 那几毫秒），不能有任何 execFile/spawn。30s TTL 缓存对齐 detectSystemClaude
 * 的纪律，避免同一秒内的多次 IPC 轮询重复做文件系统 IO。
 *
 * `COWORK_DISABLE_SYSTEM_PYTHON=1`（env.json / 远端下发）是杀开关：线上发现
 * 某类系统 python 有问题时，不发版即可整体退回「只用捆绑 runtime」的旧行为。
 */
export function detectSystemPythonHomeSync(): SystemPythonHome | null {
  if (process.env.COWORK_DISABLE_SYSTEM_PYTHON === '1') return null
  if (systemPythonCache && Date.now() - systemPythonCache.ts < SYSTEM_PYTHON_CACHE_TTL_MS) {
    return systemPythonCache.info
  }
  const info = scanSystemPythonHomes()
  systemPythonCache = { info, ts: Date.now() }
  return info
}

function scanSystemPythonHomes(): SystemPythonHome | null {
  const versions: ReadonlyArray<'3.12' | '3.11'> = ['3.12', '3.11']

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    for (const version of versions) {
      const tag = version.replace('.', '')
      const homes = [
        ...(localAppData ? [join(localAppData, 'Programs', 'Python', `Python${tag}`)] : []),
        `C:\\Program Files\\Python${tag}`,
        `C:\\Python${tag}`
      ]
      for (const home of homes) {
        if (existsSync(join(home, 'python.exe'))) return { home, version }
      }
    }
    // py launcher 注册的安装本就落在上面几个目录，不额外做 `py -0p` 之类的
    // spawn 探测——这里必须保持同步零 spawn。
    return null
  }

  // mac：python.org 安装器 + Homebrew keg（注意不能用裸 /opt/homebrew 当
  // home——`bin/python3` 在那层可能指向任意版本，必须钻进 keg 内的
  // Framework 路径让目录名与版本号严格对应）。
  for (const version of versions) {
    const homes = [
      `/Library/Frameworks/Python.framework/Versions/${version}`,
      `/opt/homebrew/opt/python@${version}/Frameworks/Python.framework/Versions/${version}`,
      `/usr/local/opt/python@${version}/Frameworks/Python.framework/Versions/${version}`
    ]
    for (const home of homes) {
      if (existsSync(join(home, 'bin', 'python3'))) return { home, version }
    }
  }

  // pyenv：目录名带 patch 号（3.12.7），取每个大版本下最高 patch。故意不进
  // shims（~/.pyenv/shims/python3）——那是依赖 pyenv shell 环境的转发脚本，
  // existsSync 能过但脱离 PATH 时不可执行，会让脚本以为有解释器结果一跑就炸。
  try {
    const pyenvVersionsDir = join(homedir(), '.pyenv', 'versions')
    const entries = readdirSync(pyenvVersionsDir)
    for (const version of versions) {
      const matches = entries.filter((e) => e.startsWith(`${version}.`)).sort()
      const best = matches[matches.length - 1]
      if (best) {
        const home = join(pyenvVersionsDir, best)
        if (existsSync(join(home, 'bin', 'python3'))) return { home, version }
      }
    }
  } catch {
    /* 没装 pyenv，目录不存在——忽略，不是错误 */
  }

  return null
}

/**
 * 异步验真：`existsSync` 过的目录里，解释器可能已损坏或被系统隔离（企业
 * 杀软/macOS Gatekeeper 隔离属性），existsSync 看不出这些。只在
 * componentInstaller 决定「跳过 70MB 下载」前调用——宁可多花几百毫秒验证，
 * 也不能让一个假 ready 的系统 python 换来 venv 建不出来的胶囊卡死。
 */
export async function verifySystemPython(info: SystemPythonHome): Promise<boolean> {
  const interpreter =
    process.platform === 'win32' ? join(info.home, 'python.exe') : join(info.home, 'bin', 'python3')
  try {
    const { stdout } = await execFileP(interpreter, ['--version'], {
      timeout: 3000,
      windowsHide: true
    })
    // Python ≥3.4 把 --version 输出打到 stdout（早期版本打 stderr，但我们
    // 只认 3.11/3.12，不用兼容那个年代）。
    const match = stdout.match(/Python (\d+)\.(\d+)/)
    return match ? `${match[1]}.${match[2]}` === info.version : false
  } catch {
    return false
  }
}

/**
 * 「PPT_MASTER_PYTHON_HOME 该注入什么」与「python 组件是否就绪」的唯一入口：
 * 捆绑/已下载的 runtime 优先，其次系统检测到的 python。isComponentAvailable
 * 与 engine.ts/pptSkillInstaller.ts 的注入侧必须共用这一个函数——同
 * isCliAvailable 的纪律，杜绝「组件说就绪、实际注入 null」的自相矛盾。
 */
export function resolveEffectivePythonHome(): string | null {
  return resolveBundledPythonHome() ?? detectSystemPythonHomeSync()?.home ?? null
}

/**
 * Detection layer for the user's system-installed Claude Code CLI.
 *
 * When the "CLI backend" setting is flipped to `system`, the engine
 * points the Agent SDK at whatever `claude` binary this module locates
 * instead of the bundled fusion-code. Resolution order:
 *
 *   1. PATH lookup via `which claude` / `where claude` — fastest win
 *      when the user has a shell-installed binary (homebrew / npm).
 *   2. A hand-maintained list of common install locations that `which`
 *      often misses: `~/.claude/local/claude` (official installer),
 *      `~/.local/bin/claude` (pip / pipx / user-site scripts),
 *      `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`,
 *      `%APPDATA%\npm\claude.cmd` on Windows.
 *
 * On the first hit, we spawn `<path> --version` with a 3s timeout and
 * parse a `1.2.3` shape from the output. Returning the version lets the
 * settings UI warn the user if their local install is older than the
 * fusion-code baseline (currently v2.1.90, tracked in build.yml). A
 * `null` return means "no system claude installed" and the settings
 * UI greys out the "system" radio option.
 *
 * Results are cached in-module for 30 seconds so repeated IPC polls
 * from the settings page don't hammer the subprocess spawn path. Call
 * `invalidateCache()` if a future feature needs to force a re-scan
 * (e.g. the user adds `~/.local/bin` to PATH while the app is open).
 */
export interface SystemClaudeInfo {
  path: string
  version: string | null
}

const CACHE_TTL_MS = 30_000
let cache: { info: SystemClaudeInfo | null; ts: number } | null = null

export function invalidateCache(): void {
  cache = null
}

export async function detectSystemClaude(): Promise<SystemClaudeInfo | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.info
  }
  const info = await detectUncached()
  cache = { info, ts: Date.now() }
  return info
}

async function detectUncached(): Promise<SystemClaudeInfo | null> {
  const path = (await findViaPath()) ?? findInCommonPaths()
  if (!path) return null
  const version = await getVersion(path)
  return { path, version }
}

/**
 * `which claude` on POSIX, `where claude` on Windows. Both print the
 * resolved absolute path to stdout and exit 0; non-zero exit means
 * "not on PATH" and we swallow the error silently.
 */
async function findViaPath(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileP(cmd, ['claude'], { timeout: 2000, windowsHide: true })
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  } catch {
    /* not on PATH — fall through to common-paths scan */
  }
  return null
}

/**
 * Synchronous, PATH-independent detection of the system `claude` binary.
 *
 * Only scans the hand-maintained common install locations via `existsSync`
 * (no `which`, no subprocess, no async). Used as a SPAWN-TIME fallback by
 * the engine: the async `detectSystemClaude()` result is cached on the
 * engine instance only when the *engine-backed* CLI_BACKEND_GET IPC runs,
 * but the settings OVERLAY uses the engine-free SETTINGS_CLI_BACKEND_GET
 * path — so after toggling backend from the overlay, the engine's
 * `cachedSystemClaudePath` can still be null at spawn. This lets
 * `resolveCliPath` recover the path synchronously instead of silently
 * falling back to bundled fusion-code (which would keep using csdn).
 *
 * Returns null only when claude truly isn't in any known location; the
 * common case (`~/.local/bin/claude`, official installer, homebrew) is
 * covered without depending on the GUI process's stripped PATH.
 */
export function detectSystemClaudeSync(): string | null {
  return findInCommonPaths()
}

function findInCommonPaths(): string | null {
  const home = homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
          join(home, 'AppData', 'Roaming', 'npm', 'claude.exe'),
          join(home, '.claude', 'local', 'claude.exe')
        ]
      : [
          join(home, '.claude', 'local', 'claude'),
          join(home, '.local', 'bin', 'claude'),
          '/usr/local/bin/claude',
          '/opt/homebrew/bin/claude',
          '/usr/bin/claude'
        ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Parse the `x.y.z` from whatever `claude --version` prints. Upstream
 * claude-code currently prints `1.2.3 (Claude Code)`; fusion-code
 * mirrors the same shape. We accept any leading "v" and take the first
 * semver-looking token we find so schema drift in the surrounding
 * chrome doesn't break detection.
 */
async function getVersion(path: string): Promise<string | null> {
  // Windows 上 path 可能是 claude.cmd（批处理 shim）。execFile 不带 shell 跑不了
  // .cmd → spawn EINVAL。解析成真实入口绕开 .cmd：
  //   - 现代 claude → bin/claude.exe（真二进制）：直接 execFile 它，不套 node。
  //   - 旧版 claude → cli.js：用 node 跑。
  // usesNode 只认 .js/.mjs（决定要不要 node 前缀），不能用 `entry !== path`——那对
  // .exe 会误判成要 node 跑。非 Windows / 已是脚本时 entry === path，行为不变。
  const entry = resolveSystemClaudeJsEntry(path)
  const usesNode = /\.m?js$/i.test(entry)
  const runtime = usesNode ? resolveJsRuntimeBin() : null
  const file = usesNode ? (runtime ?? 'node') : entry
  const args = usesNode ? [entry, '--version'] : ['--version']
  try {
    const { stdout } = await execFileP(file, args, {
      timeout: 3000,
      windowsHide: true,
      // Some claude installers wrap the binary in a shell script that
      // sources config on startup — keep env pristine to avoid
      // accidentally inheriting ANTHROPIC_AUTH_TOKEN from the Electron
      // parent, which could leak credentials into a stray log line.
      env: { ...process.env, NO_COLOR: '1' }
    })
    const match = stdout.match(/v?(\d+\.\d+\.\d+)/)
    return match?.[1] ?? null
  } catch (err) {
    const e = err as ExecFileException
    console.warn('[cliDetect] --version failed', { path, file, message: e.message })
    return null
  }
}
