import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

import { broadcastScenarioCases } from '../tabRegistry'
import type { ScenarioCaseGallery } from '../../shared/ipc-channels'
import { normalizeScenarioCaseGallery } from './scenarioCasesNormalize'
import type { AuthedGet } from './sub2apiClient'

/**
 * 技能最佳实践案例（SkillCaseShowcase）的远端配置：拉取 → 校验 → 落盘 → 广播。
 *
 * 与 scenarioCatalogService 是同一套模式、同一组约束（磁盘缓存是渲染层的真正
 * 数据源、网络只负责更新它；失败静默且保留旧缓存），刻意没有抽成一个泛型
 * 「远端配置服务」：两份配置的差异点（是否有内置默认表、空值语义、体积上限）
 * 恰恰是各自注释里最要紧的部分，泛型化会把它们藏进参数里。
 *
 * 一个关键差异：**这里没有内置默认表**。缓存为 null 时渲染层直接不显示案例
 * 区，而不是回落到什么内置内容——案例是运营内容，客户端不该自带一份。
 */

/** 整份案例的落盘上限（字节）。图片全是 URL，正常远小于此。 */
const MAX_GALLERY_BYTES = 1024 * 1024

function cachePath(): string {
  return join(app.getPath('userData'), 'scenario-cases.json')
}

let cached: ScenarioCaseGallery | null = null
let loaded = false

/**
 * 内存里那份案例（首次调用时懒加载磁盘缓存）。SCENARIO_CASES_GET 的唯一
 * 数据源——同步、不碰网络。
 */
export function getScenarioCases(): ScenarioCaseGallery | null {
  if (loaded) return cached
  loaded = true
  const path = cachePath()
  if (!existsSync(path)) return null
  try {
    cached = normalizeScenarioCaseGallery(JSON.parse(readFileSync(path, 'utf-8')))
  } catch (err) {
    console.error('[scenarioCases] read cache failed', {
      path,
      message: err instanceof Error ? err.message : String(err)
    })
    cached = null
  }
  return cached
}

/**
 * 后台拉取一次远端案例。由 authService 在 login 成功后、以及冷启动的 profile
 * 刷新里调用（与 refreshScenarioCatalog 并排、同一节奏）。fire-and-forget。
 *
 * 版本没变就什么都不做。
 */
export async function refreshScenarioCases(get: AuthedGet): Promise<void> {
  const result = await get<unknown>('/api/v1/client/scenario-cases')
  if (!result.ok) {
    console.error('[scenarioCases] fetch failed', {
      reason: result.reason,
      message: result.message
    })
    return
  }

  // 后台从未配置过时服务端返回 `data: null`（不是 404），"没配过"是正常状态。
  if (result.data === null || result.data === undefined) return

  const next = normalizeScenarioCaseGallery(result.data)
  if (!next) {
    console.error('[scenarioCases] remote payload rejected (bad shape) — keeping cache')
    return
  }

  const prev = getScenarioCases()
  if (prev && prev.version === next.version) return

  const serialized = JSON.stringify(next)
  if (serialized.length > MAX_GALLERY_BYTES) {
    console.error('[scenarioCases] remote payload too large — keeping cache', {
      bytes: serialized.length
    })
    return
  }

  cached = next
  loaded = true
  try {
    writeFileSync(cachePath(), serialized, 'utf-8')
  } catch (err) {
    console.error('[scenarioCases] write cache failed', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
  console.log('[scenarioCases] applied', { version: next.version, cases: next.cases.length })
  broadcastScenarioCases(next)
}
