import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app } from 'electron'

const execFileP = promisify(execFile)

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
 * 所以 prod 下统一把 SDK 的 `executable` 显式指到 app 自带的
 * `<resources>/node-runtime/node[.exe]`（CI 从 nodejs.org 下载打进 extraResources，
 * 与 daemon 共用同一份；见 resolveNodeBin / [[2026-05-25-daemon自带Node彻底摆脱用户机器Node版本ABI错配]]）。
 * 绝对路径绕开 PATH，跨平台一致。注意：这里**不要求** ABI 匹配——SDK 只是用它
 * 执行 claude 的 cli.js 脚本，不加载 better-sqlite3 那类 native 模块。
 *
 * 返回 null 表示「prod 但自带 Node 缺失」或「dev」，调用方应回退到 SDK 默认
 * （dev 下裸 'node' 通常能在 PATH 命中，且 dev 不是 GUI 精简 PATH 场景）。
 */
export function resolveJsRuntimeBin(): string | null {
  const override = process.env.OD_NODE_BIN
  if (override && existsSync(override)) return override

  if (app.isPackaged) {
    const bundledNode = join(
      process.resourcesPath,
      'node-runtime',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )
    if (existsSync(bundledNode)) return bundledNode
    console.warn(`[cliDetect] 自带 Node 缺失：${bundledNode}，SDK executable 回退默认 node`)
  }
  return null
}

/**
 * 把系统 claude 的「可执行入口」规整成一个能被 `node <entry>` 直接跑的 **JS 文件**。
 *
 * 背景：mac/Linux 上系统 claude 是无后缀脚本（shebang 指向 node），SDK 默认
 * `node <script>` 能跑，原样返回即可。但 **Windows 上 npm 全局安装的 claude 是
 * `claude.cmd`**（批处理 shim）——Node 不带 `shell:true` 的 spawn/execFile **无法执行
 * .cmd/.bat**（CVE-2024-27980 之后收紧），传给 SDK 当 `pathToClaudeCodeExecutable`
 * 会被 `node claude.cmd` 调用而 spawn EINVAL。
 *
 * 修法不是给 spawn 加 shell（参数转义/注入面 + 还得各路径单独处理），而是**顺着
 * shim 找到它真正调用的 cli.js**，把那个 JS 路径交给 SDK。npm 生成的 `.cmd` shim 是
 * 固定模板，内部用 `"%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"` 之类指向
 * 真实入口；我们既按标准布局直接拼，也读 .cmd 文本兜底解析。
 *
 * 解析失败（找不到 cli.js）时返回原始路径——让上层照旧尝试，至少错误信息明确，
 * 不静默吞掉。非 .cmd/.exe（mac/Linux 脚本、或已是 .js）一律原样返回，mac 不受影响。
 */
export function resolveSystemClaudeJsEntry(cliPath: string): string {
  // 已经是 JS 入口（含 dev 下的无后缀脚本由 node 经 shebang 跑）→ 原样返回。
  // 只对 Windows 的 .cmd/.bat/.exe shim 做解析。
  if (!/\.(cmd|bat|ps1)$/i.test(cliPath)) return cliPath

  const dir = dirname(cliPath)

  // ① 标准 npm 全局布局：<npmPrefix>\node_modules\@anthropic-ai\claude-code\cli.js
  //    （claude.cmd 与 node_modules 同级）。也覆盖未来可能的 cli.mjs。
  const standard = [
    join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs')
  ]
  for (const p of standard) {
    if (existsSync(p)) return p
  }

  // ② 读 .cmd shim 文本兜底：npm shim 里会出现 "...\cli.js" 的字面量路径。
  //    抠出第一个以 .js/.mjs 结尾、含 claude-code 的路径片段，相对 dir 解析。
  try {
    const text = readFileSync(cliPath, 'utf8')
    const m = text.match(/[^"'\s]*claude-code[^"'\s]*\.m?js/i)
    if (m) {
      const raw = m[0].replace(/%~?dp0%\\?/i, '').replace(/^["']|["']$/g, '')
      const resolved = resolve(dir, raw)
      if (existsSync(resolved)) return resolved
    }
  } catch {
    // 读不动 shim（权限/编码）→ 落到原样返回
  }

  console.warn(
    `[cliDetect] 无法从 ${cliPath} 解析出 cli.js，原样交给 SDK（Windows 上可能 spawn EINVAL）`
  )
  return cliPath
}

/**
 * Resolve the repo-root `skills/` directory, packaged as a local fusion-code
 * plugin (it carries `skills/.claude-plugin/plugin.json` with `"skills":
 * "./"`, so every immediate `skills/<name>/SKILL.md` subdir registers as the
 * plugin skill `claude-desktop:<name>`). The engine feeds the returned path
 * into the SDK `query()` `plugins` option so these skills become `/`-triggerable
 * in the chat tab — distinct from the daemon's own `/api/skills` surface, which
 * reads the same directory but over HTTP for the Settings → Skills panel.
 *
 * dev/prod split mirrors resolveBundledCliPath():
 *   - prod (packaged .app): electron-builder's extraResources copies the repo
 *     `skills/` into `<resourcesPath>/prebundled/skills` (see
 *     prebundle-daemon.mjs RESOURCE_DIRS). resolveRepoRoot() in
 *     openDesignServices.ts lands daemon PROJECT_ROOT on that same prebundled
 *     root, so the two consumers stay in lockstep.
 *   - dev: walk up from this bundle (apps/desktop/out/main) / cwd to the repo
 *     root and use its live `skills/`.
 *
 * Returns null when no `skills/` dir is found (the plugins option is then
 * simply omitted — the SDK wires no extra plugin, never an error). The
 * `FUSION_CODE_SKILLS_DIR` env overrides everything for diagnostics.
 */
export function resolveBundledSkillsPluginDir(): string | null {
  const envOverride = process.env.FUSION_CODE_SKILLS_DIR
  if (envOverride) return existsSync(envOverride) ? envOverride : null

  const selfDir = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, 'prebundled', 'skills')] : []),
    resolve(process.cwd(), '../../skills'),
    resolve(process.cwd(), '../../../skills'),
    resolve(selfDir, '../../../skills'),
    resolve(selfDir, '../../../../skills')
  ]
  for (const p of candidates) {
    // Require the plugin manifest, not just the dir — a bare skills/ without
    // `.claude-plugin/plugin.json` would make fusion-code's `--plugin` reject
    // it, so only return a path that will actually load.
    if (existsSync(join(p, '.claude-plugin', 'plugin.json'))) return p
  }
  return null
}

/**
 * Resolve the bundled standalone Python *home* directory (the dir holding
 * `bin/python3` on mac/Linux, `python.exe` on Windows). The ppt-master skill is
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
 *   - dev: use the in-repo `apps/desktop/python-runtime/<platform>` if a dev
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
    ...(resourcesPath ? [resolve(resourcesPath, 'python-runtime')] : []),
    resolve(selfDir, '../../python-runtime', platformDir),
    resolve(process.cwd(), 'python-runtime', platformDir),
    resolve(process.cwd(), 'apps/desktop/python-runtime', platformDir)
  ]
  for (const p of candidates) {
    // Only return a home whose interpreter actually exists — a half-populated
    // dir would make the bootstrap think it has a runtime and then fail.
    if (existsSync(join(p, interpreterRel))) return p
  }
  return null
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
  // .cmd → spawn EINVAL。解析到真实 cli.js 后用 node 跑它，绕开 .cmd。非 Windows /
  // 已是 JS 的情况下 entry === path，行为不变。
  const entry = resolveSystemClaudeJsEntry(path)
  const runtime = resolveJsRuntimeBin()
  const usesNode = entry !== path || (runtime !== null && /\.m?js$/i.test(entry))
  const file = usesNode ? (runtime ?? 'node') : path
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
