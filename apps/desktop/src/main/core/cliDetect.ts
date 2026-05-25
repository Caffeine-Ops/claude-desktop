import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
    const { stdout } = await execFileP(cmd, ['claude'], { timeout: 2000 })
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
  try {
    const { stdout } = await execFileP(path, ['--version'], {
      timeout: 3000,
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
    console.warn('[cliDetect] --version failed', { path, message: e.message })
    return null
  }
}
