import { app, nativeTheme } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalize, normalizeImageApi } from './appSettingsNormalize'
import type { AppSettings, CliBackend, ThemeMode } from './appSettingsNormalize'

// Re-export for consumers（类型与纯归一化住 appSettingsNormalize.ts——它无
// electron 依赖，proposal 图片设置的 bun test 在无 electron 进程里跑）。
export { normalizeImageApi }
export type { AppSettings, CliBackend, ThemeMode }

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

/**
 * 读用户上次选的主题档位（无记录时 undefined——调用方回退 nativeTheme）。
 * splash 创建 / shell 窗口初始 backgroundColor 用它，早于 renderer 挂载、
 * daemon 未必在线（见 AppSettings.themeMode 字段注释）。
 */
export function getThemeMode(): ThemeMode | undefined {
  return load().themeMode
}

/** 镜像写入用户主题档位。调用点：tabRegistry.syncShellBackgroundToTheme。 */
export function setThemeMode(mode: ThemeMode): void {
  updateAppSettings({ themeMode: mode })
}

/**
 * 'dark'/'light' 直接判定；'system'（或 undefined，即无记录时的默认档）
 * 落到 nativeTheme.shouldUseDarkColors。tabRegistry（shell 窗口 backgroundColor
 * 初值 + 运行时切主题）与 splash.ts（闪屏深浅色）共用同一判定，保证三处
 * 「什么算暗色」的口径永远一致，不会各自实现出岔口。
 */
export function resolveIsDarkTheme(mode: ThemeMode | string | undefined): boolean {
  return mode === 'dark' || (mode !== 'light' && nativeTheme.shouldUseDarkColors)
}
