/**
 * 知识库远程同步的 manifest 协议（shared：main / preload / scripts 三方共用）。
 *
 * 为什么 path 处理不 import node:path：本文件编进 web tsconfig（renderer 也可能
 * 引用类型），不许出现 Node 模块。平台分隔符由调用方注入（main 侧传 path.sep），
 * 保持本模块纯字符串逻辑、bun test 直测无环境依赖。
 *
 * 安全约定：路径逃逸（.. 段、绝对路径、反斜杠、空段）在 parse 期整份拒收——
 * 让「恶意/损坏 manifest 中止整轮同步」在最早的关口生效（spec 错误处理表），
 * 引擎侧 isPathInsideRoot 只是纵深防御的第二道。
 */

export interface KbManifestFile {
  /** 相对制品根的 POSIX 路径（与 build-kb-index 的 relPath 同源） */
  path: string
  sha1: string
  size: number
}

export interface KbManifest {
  schemaVersion: 1
  kbId: string
  name: string
  builtAtMs: number
  files: KbManifestFile[]
}

/** 单条相对路径是否安全：非空、无 .. 段、非绝对、不含反斜杠与空段。 */
function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/') || p.includes('\\')) return false
  const segs = p.split('/')
  return segs.every((s) => s.length > 0 && s !== '..' && s !== '.')
}

export function parseKbManifest(raw: unknown): KbManifest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (m.schemaVersion !== 1) return null
  if (typeof m.kbId !== 'string' || m.kbId.length === 0) return null
  if (typeof m.name !== 'string') return null
  if (typeof m.builtAtMs !== 'number') return null
  if (!Array.isArray(m.files)) return null
  for (const f of m.files) {
    if (typeof f !== 'object' || f === null) return null
    const e = f as Record<string, unknown>
    if (!isSafeRelPath(e.path)) return null
    if (typeof e.sha1 !== 'string' || e.sha1.length === 0) return null
    if (typeof e.size !== 'number' || !Number.isFinite(e.size) || e.size < 0) return null
  }
  return raw as KbManifest
}

/**
 * POSIX manifest path → 平台路径。sep 参数化（默认 '/'）：main 侧传 node:path 的
 * sep；测试与 web 侧零 Node 依赖。
 */
export function manifestPathToPlatform(p: string, sep: string = '/'): string {
  return p.split('/').join(sep)
}

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export function kbManifestUrl(baseUrl: string, kbId: string): string {
  return `${trimTrailingSlash(baseUrl)}/kb/${encodeURIComponent(kbId)}/manifest.json`
}

/** 逐段 encodeURIComponent——路径全中文，整串 encode 会把 / 也吃掉。 */
export function kbFileUrl(baseUrl: string, kbId: string, posixPath: string): string {
  const encoded = posixPath.split('/').map(encodeURIComponent).join('/')
  return `${trimTrailingSlash(baseUrl)}/kb/${encodeURIComponent(kbId)}/${encoded}`
}
