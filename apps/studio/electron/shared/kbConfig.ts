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
  /**
   * 「全部文件」扫描的自定义目录（绝对路径，去重保序）。用户经系统文件夹
   * 选择器添加——macOS 上「用户主动选中」本身就是授权动作，无需额外弹权限。
   */
  localDocsExtraDirs: string[]
  /**
   * 被用户停用的预设扫描目录（'downloads' | 'desktop'）。预设目录路径不落盘
   * （随系统本地化经 app.getPath 动态解析），只记「哪个被关了」。
   */
  localDocsDisabledPresets: string[]
}

/** 防御式 string[] 解析：非数组/非字符串项/空串一律丢弃（哲学同 parseKbConfig 头注释）。 */
function parseStringArray(v: unknown, allow?: ReadonlySet<string>): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (allow && !allow.has(item)) continue
    if (!out.includes(item)) out.push(item)
  }
  return out
}

const LOCAL_DOCS_PRESET_KEYS: ReadonlySet<string> = new Set(['downloads', 'desktop'])

export function parseKbConfig(raw: string | null): KbConfig {
  const empty: KbConfig = {
    mode: null,
    kbRoot: null,
    remote: null,
    localDocsExtraDirs: [],
    localDocsDisabledPresets: []
  }
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
  // 新字段必须进 KbConfig 本体：kbIndexStore 的 setter 全是「读-合并-写整文件」
  // （{ ...cur, patch }），parse 时丢弃的字段会在下一次任意 setter 落盘时被抹掉。
  return {
    mode,
    kbRoot,
    remote,
    localDocsExtraDirs: parseStringArray(o.localDocsExtraDirs),
    localDocsDisabledPresets: parseStringArray(o.localDocsDisabledPresets, LOCAL_DOCS_PRESET_KEYS)
  }
}
