/**
 * `kbasset://` 自定义协议 —— 让桌面渲染进程能显示知识库镜像里的本地图片（方案预览嵌图）。
 *
 * 为什么不用 file:// 直读：渲染进程 file:// 图常被 webSecurity 拦；且需要严格的路径逃逸
 * 防护，不能让 `kbasset://kb/<../../etc/passwd>` 读到 kb-index 目录外的任意文件。照
 * `appProtocol.ts`（app://）的范式：注册为 standard+secure scheme（见 index.ts 的
 * registerSchemesAsPrivileged），handler 解码绝对路径、校验仍在 kbOutDir 内、再流式读盘。
 *
 * URL 形：`kbasset://kb/<encodeURIComponent(图的绝对路径)>`。整条绝对路径编码成单个 path
 * 段（encodeURIComponent 把 `/` 编成 %2F），handler 解码还原。渲染侧由 toKbAssetUrl 构造。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const KB_ASSET_SCHEME = 'kbasset'

/**
 * 纯路径守卫（无 fs）：规整后的 absPath 必须落在 kbRoot 之内。
 * kbRoot 末尾补 sep 再比前缀，避免 /kb-index 命中 /kb-index-evil 这种兄弟目录误判。
 * 空串、规整后逃逸到 kbRoot 外 → false。
 */
export function isPathInsideKbRoot(absPath: string, kbRoot: string): boolean {
  if (!absPath || !kbRoot) return false
  const abs = normalize(absPath)
  const root = normalize(kbRoot)
  return abs === root || abs.startsWith(root + sep)
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * 注册 kbasset:// handler。app.whenReady() 之后调用一次；registerSchemesAsPrivileged 必须
 * 已在 ready 前跑过（见 index.ts）。命中 → 流式读盘；越界/不存在 → 404，绝不抛。
 */
export function registerKbAssetProtocol(): void {
  // 动态导入 electron 和 kbOutDir，避免模块顶层加载（影响测试）。该函数只在 app.ready 回调里调用，
  // 那时 electron 和 app 都已加载完毕。
  void (async () => {
    const { protocol } = await import('electron')
    const { kbOutDir } = await import('../core/kbIndexStore')

    protocol.handle(KB_ASSET_SCHEME, async (request) => {
      try {
        const url = new URL(request.url)
        // pathname 形如 /<encodeURIComponent(绝对路径)>；去前导 / 再解码还原绝对路径。
        const absPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        const root = kbOutDir()
        if (!isPathInsideKbRoot(absPath, root)) return new Response('Forbidden', { status: 403 })
        const abs = normalize(absPath)
        if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
        const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
        return new Response(body, { headers: { 'content-type': mimeFor(abs) } })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    })
  })()
}
