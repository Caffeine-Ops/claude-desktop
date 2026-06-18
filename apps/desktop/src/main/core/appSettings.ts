import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Tiny main-process settings store for preferences that need to survive
 * app restarts AND be readable from the engine before the renderer has
 * mounted (so localStorage in the renderer is not an option).
 *
 * Currently a single field — `cliBackend` — so the file is small, no
 * schema migrations, no locking, no debounce. If this ever grows past
 * a handful of fields, consider switching to `electron-store`.
 *
 * On-disk shape:
 *   {
 *     "cliBackend": "bundled" | "system",
 *     "authLoggedIn": boolean,
 *     "authPhone": string | null,    // masked, e.g. "138****8888"
 *     "authNickname": string | null  // user-editable display name
 *   }
 *
 * Location: `<userData>/settings.json`. Electron maps `userData` to
 * the standard per-OS config directory (`~/Library/Application
 * Support/claude-desktop` on macOS, `%APPDATA%/claude-desktop` on
 * Windows). Corrupt or missing files fall back to defaults — we log
 * a warning and keep going rather than crash the main process.
 */
export type CliBackend = 'bundled' | 'system'

export interface AppSettings {
  cliBackend: CliBackend
  /** Phone-login sign-in flag. The masked phone lives in `authPhone`. */
  authLoggedIn: boolean
  /** Masked phone for display (e.g. "138****8888"); null when signed out. */
  authPhone: string | null
  /** User-editable display name; null when signed out. */
  authNickname: string | null
}

const DEFAULTS: AppSettings = {
  cliBackend: 'bundled',
  authLoggedIn: false,
  authPhone: null,
  authNickname: null
}

let cached: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): AppSettings {
  if (cached) return cached
  const path = settingsPath()
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cached = { ...DEFAULTS, ...normalize(parsed) }
  } catch (err) {
    // ENOENT on first run is expected — log at debug only. Any other
    // error (permission denied, invalid JSON) we surface so the user
    // can fix it; we still fall back to defaults so the app boots.
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      console.warn('[appSettings] load failed — using defaults', {
        path,
        message: e.message
      })
    }
    cached = { ...DEFAULTS }
  }
  return cached
}

/**
 * Defensive field-by-field copy so a malformed file that e.g. sets
 * `cliBackend: 42` doesn't poison the rest of the engine. Unknown keys
 * are dropped; invalid values are coerced to the default for that key.
 */
function normalize(raw: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if (raw.cliBackend === 'bundled' || raw.cliBackend === 'system') {
    out.cliBackend = raw.cliBackend
  }
  if (typeof raw.authLoggedIn === 'boolean') {
    out.authLoggedIn = raw.authLoggedIn
  }
  if (typeof raw.authPhone === 'string' || raw.authPhone === null) {
    out.authPhone = raw.authPhone
  }
  if (typeof raw.authNickname === 'string' || raw.authNickname === null) {
    out.authNickname = raw.authNickname
  }
  return out
}

export function getAppSettings(): AppSettings {
  return { ...load() }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...load(), ...normalize(patch) }
  cached = next
  const path = settingsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    console.error('[appSettings] write failed', { path, message: e.message })
  }
  return { ...next }
}
