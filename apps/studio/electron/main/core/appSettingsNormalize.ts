/**
 * Pure normalization functions for appSettings.
 * Separated from appSettings.ts to be testable without loading the electron module.
 */

import type { ImageApiConfig } from '../services/imageGenService'

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
  /** 写方案出图 API 配置（OpenAI 兼容端点），见 services/imageGenService。 */
  imageApi?: ImageApiConfig
}

/**
 * Normalize imageApi from raw input. Returns undefined if invalid (not an object,
 * apiKey/baseURL not strings). Defaults model to 'gpt-image-2' if missing.
 */
export function normalizeImageApi(raw: unknown): ImageApiConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.apiKey !== 'string' || typeof r.baseURL !== 'string') return undefined
  return {
    apiKey: r.apiKey,
    baseURL: r.baseURL,
    model: typeof r.model === 'string' && r.model ? r.model : 'gpt-image-2'
  }
}

/**
 * Defensive field-by-field normalization so a malformed file doesn't poison
 * the engine. Unknown keys are dropped; invalid values are coerced to defaults.
 */
export function normalize(raw: Partial<AppSettings>): Partial<AppSettings> {
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
  if (raw.imageApi !== undefined) {
    const img = normalizeImageApi(raw.imageApi)
    if (img) out.imageApi = img
  }
  return out
}
