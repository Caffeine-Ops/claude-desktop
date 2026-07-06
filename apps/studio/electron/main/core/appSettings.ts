import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalize, normalizeImageApi } from './appSettingsNormalize'
import type { AppSettings, CliBackend } from './appSettingsNormalize'

// Re-export for consumers（类型与纯归一化住 appSettingsNormalize.ts——它无
// electron 依赖，proposal 图片设置的 bun test 在无 electron 进程里跑）。
export { normalizeImageApi }
export type { AppSettings, CliBackend }

/**
 * Tiny main-process settings store for preferences that need to survive
 * app restarts AND be readable from the engine before the renderer has
 * mounted (so localStorage in the renderer is not an option).
 *
 * On-disk shape:
 *   { "cliBackend": "bundled" | "system",
 *     "lastModelByBackend": { ... },
 *     "imageApi": { "apiKey": "...", "baseURL": "...", "model": "..." } }
 *
 * Location: `<userData>/settings.json`. Electron maps `userData` to
 * the standard per-OS config directory (`~/Library/Application
 * Support/claude-desktop` on macOS, `%APPDATA%/claude-desktop` on
 * Windows). Corrupt or missing files fall back to defaults — we log
 * a warning and keep going rather than crash the main process.
 */

const DEFAULTS: AppSettings = {
  cliBackend: 'bundled'
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

/**
 * 读某 backend 上次选的模型（无则 undefined）。engine 构造 / backend 切换时
 * 用它拿当前 backend 的 lastModel 做种子。
 */
export function getLastModel(backend: CliBackend): string | undefined {
  return load().lastModelByBackend?.[backend]
}

/**
 * 写某 backend 上次选的模型（model=null 清该槽，回默认）。合并式：只动目标
 * backend 的槽，另一 backend 的记忆不受影响。
 */
export function setLastModel(backend: CliBackend, model: string | null): void {
  const slot: Partial<Record<CliBackend, string>> = {
    ...load().lastModelByBackend
  }
  if (model) slot[backend] = model
  else delete slot[backend]
  updateAppSettings({ lastModelByBackend: slot })
}
