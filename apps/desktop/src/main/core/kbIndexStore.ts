/**
 * Knowledge-base path configuration and index reader (main-process side).
 *
 * Two responsibilities:
 *  1. Persist / read the KB config in `userData/kb-config.json`.
 *     This is a simple JSON file — no migration needed because it only ever
 *     holds `{ kbRoot?: string, remote?: KbRemoteConfig }` and we parse
 *     defensively (parsing itself lives in `../../shared/kbConfig` so it's
 *     bun-testable without pulling in Electron).
 *  2. Read the built index from `userData/kb-index/index.json`.
 *     The file is written by the Phase-A build script; this module just
 *     reads it and returns the typed result (or null when absent).
 *
 * All paths are computed lazily via `app.getPath('userData')` so this file
 * can be imported at module level without triggering Electron's "app not
 * ready" error — the path is only resolved when an IPC handler actually
 * calls one of these functions, by which point `app.ready` has fired.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { KbIndex } from '../../shared/kbIndex'
import type { KbConfig, KbRemoteConfig } from '../../shared/kbConfig'
import { parseKbConfig } from '../../shared/kbConfig'

/** Absolute path to the KB path config file. Evaluated lazily. */
const configPath = (): string => join(app.getPath('userData'), 'kb-config.json')

/**
 * The fixed output directory where the Phase-A build script drops
 * `index.json` and mirrored assets. Exposed so the IPC handler can
 * return it alongside `kbRoot` in a single round-trip — the renderer
 * needs both values to build the settings UI.
 */
export const kbOutDir = (): string => join(app.getPath('userData'), 'kb-index')

/** 读整份 KB 配置。文件缺失/损坏 → 全空配置（防御哲学见 parseKbConfig）。 */
export function getKbConfig(): KbConfig {
  const p = configPath()
  return parseKbConfig(existsSync(p) ? readFileSync(p, 'utf8') : null)
}

/**
 * Read the persisted KB root path. Returns null when the config file
 * doesn't exist yet or when it can't be parsed (e.g. corrupted JSON).
 */
export function getKbRoot(): string | null {
  return getKbConfig().kbRoot
}

/**
 * 读-合并-写：早期实现整文件覆盖 {kbRoot}，remote 字段加入后那样写会把远程配置
 * 静默抹掉（用户改一次本地路径 = 断开服务器），必须合并。setKbRemote 同理。
 * Throws on filesystem error (e.g. userData dir not writable) — the
 * IPC handler lets that surface as an invoke rejection so the renderer
 * can show an error toast.
 */
export function setKbRoot(kbRoot: string): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, kbRoot }), 'utf8')
}

/** 持久化远程配置（或清空为 null）。同样走读-合并-写，理由见 setKbRoot 注释。 */
export function setKbRemote(remote: KbRemoteConfig | null): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, remote }), 'utf8')
}

/**
 * Read the built knowledge-base index from `outDir/index.json`.
 * Returns null when the file doesn't exist (index not yet built) or
 * when JSON.parse fails (index file partially written). The renderer
 * treats null as "not ready" and shows the build CTA.
 */
export function readKbIndex(): KbIndex | null {
  const p = join(kbOutDir(), 'index.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as KbIndex
  } catch {
    return null
  }
}
