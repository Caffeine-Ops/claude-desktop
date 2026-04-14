import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

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
