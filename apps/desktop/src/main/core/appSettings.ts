import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getActiveTenantId } from './authStore'
import { tenantPaths } from './tenantPaths'

/**
 * 每租户应用偏好。文件位于 <userData>/tenants/<activeTenantId>/settings.json。
 * 登录态本身不在这里（见 authStore.ts / auth.json）——那是定位本文件所需的前置，
 * 不能再塞回来，否则又变回鸡生蛋。
 *
 * 未登录（无 activeTenantId）时：读返回 DEFAULTS、写是 no-op（没有租户目录可落）。
 * 切换租户时 authStore.activateTenant() 会调用 invalidateSettingsCache()，
 * 使下一次读重新从新租户的文件加载。
 */
export type CliBackend = 'bundled' | 'system'

export interface AppSettings {
  cliBackend: CliBackend
}

const DEFAULTS: AppSettings = {
  cliBackend: 'bundled'
}

let cached: AppSettings | null = null

function settingsPath(): string | null {
  const tid = getActiveTenantId()
  return tid ? tenantPaths(tid).settingsPath : null
}

function load(): AppSettings {
  if (cached) return cached
  const path = settingsPath()
  if (!path) {
    // 未登录——返回默认，且不缓存（登录后路径会变）。
    return { ...DEFAULTS }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings>
    cached = { ...DEFAULTS, ...normalize(parsed) }
  } catch (err) {
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

function normalize(raw: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if (raw.cliBackend === 'bundled' || raw.cliBackend === 'system') {
    out.cliBackend = raw.cliBackend
  }
  return out
}

export function getAppSettings(): AppSettings {
  return { ...load() }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const path = settingsPath()
  if (!path) {
    // 未登录时不该有人写设置（UI 被登录墙挡住）；防御性地 no-op。
    console.warn('[appSettings] update ignored — no active tenant')
    return { ...DEFAULTS }
  }
  const next = { ...load(), ...normalize(patch) }
  cached = next
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error('[appSettings] write failed', { path, message: (err as Error).message })
  }
  return { ...next }
}

/** 切换租户时调用，丢弃当前租户的缓存，下一次读重新加载新租户文件。 */
export function invalidateSettingsCache(): void {
  cached = null
}
