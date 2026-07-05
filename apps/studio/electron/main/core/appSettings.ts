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
 *   { "cliBackend": "bundled" | "system" }
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
  /**
   * 用户上次在 composer 模型 chip 里选的模型 id，**按 backend 分开存**
   * （2026-07-05）。持久化是为了重开应用 / 切回某 backend 时 chip 立即显示
   * 上次的模型，而不是空占位「模型」。
   *
   * 为什么按 backend 分槽：fusion-code 是 gpt 系列、system claude 是 Claude
   * 系列，模型体系完全不同。若只存一份全局 lastModel，从 system 选了 haiku
   * 再切到 fusion-code，chip 还显 haiku 但 gpt 菜单里没这个模型、选中态也对
   * 不上（2026-07-05 实锤 bug）。分槽后各 backend 各记各的，切回来各自恢复。
   * 某槽 undefined = 该 backend 没手动选过 / 已清回默认。
   */
  lastModelByBackend?: Partial<Record<CliBackend, string>>
}

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
  // lastModelByBackend：逐槽收非空字符串；无效槽丢弃。整体非对象则丢。
  if (raw.lastModelByBackend && typeof raw.lastModelByBackend === 'object') {
    const src = raw.lastModelByBackend
    const slot: Partial<Record<CliBackend, string>> = {}
    for (const key of ['bundled', 'system'] as const) {
      const v = src[key]
      if (typeof v === 'string' && v.length > 0) slot[key] = v
    }
    if (Object.keys(slot).length > 0) out.lastModelByBackend = slot
  }
  // 旧扁平 lastModel（迁移前的字段）**直接丢弃不迁移**：无法知道它是在哪个
  // backend 选的，硬塞进某槽可能把 Claude 模型放进 gpt 槽（反之亦然）造成新
  // 的不匹配。丢弃后两槽从干净开始，用户下次选一次即重新记住，代价极小。
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
