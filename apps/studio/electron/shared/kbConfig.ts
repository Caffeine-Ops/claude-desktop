/**
 * kb-config.json 的解析（shared 纯函数，kbIndexStore 负责读写文件）。
 * 防御解析延续 kbIndexStore 既有哲学：任何残缺都退安全默认值，绝不抛——
 * 配置文件损坏的代价只能是「回到未配置状态」，不能是应用起不来。
 * remote 残缺时只废 remote 不连坐 kbRoot：两个字段语义独立。
 */
export interface KbRemoteConfig {
  baseUrl: string
  /** 本期恒 "default"；多团队多 KB 的口子（spec 扩展口子 #3） */
  kbId: string
}

export type KbMode = 'managed' | 'remote'

export interface KbConfig {
  /** null = 未配置/旧版配置（P2 迁移引导消费）。managed=主编机可写，remote=只读同步。 */
  mode: KbMode | null
  /** 旧「本地文件夹」模式的根目录。已废弃，仅保留读取供 P2 一次性迁移引导。 */
  kbRoot: string | null
  remote: KbRemoteConfig | null
}

export function parseKbConfig(raw: string | null): KbConfig {
  const empty: KbConfig = { mode: null, kbRoot: null, remote: null }
  if (!raw) return empty
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof obj !== 'object' || obj === null) return empty
  const o = obj as Record<string, unknown>
  const mode = o.mode === 'managed' || o.mode === 'remote' ? o.mode : null
  const kbRoot = typeof o.kbRoot === 'string' && o.kbRoot.length > 0 ? o.kbRoot : null
  let remote: KbRemoteConfig | null = null
  if (typeof o.remote === 'object' && o.remote !== null) {
    const r = o.remote as Record<string, unknown>
    if (typeof r.baseUrl === 'string' && r.baseUrl.length > 0 && typeof r.kbId === 'string' && r.kbId.length > 0) {
      remote = { baseUrl: r.baseUrl, kbId: r.kbId }
    }
  }
  return { mode, kbRoot, remote }
}
