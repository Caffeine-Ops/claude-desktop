/**
 * 本地资产自定义协议的公共实现——kbasset://（只读 KB 镜像）、proposalasset://（草稿产出图）、
 * pptasset://（ppt-master 项目产物：SVG/图片/图标）。此前是逐行克隆的双胞胎 handler（评审发现）：
 * 任何安全加固（symlink realpath、Windows 大小写前缀、Range 支持…）只会修到其中一个 scheme，
 * 另一个静默保持可穿越/损坏且无任何报警。收口成一个工厂后加固单点生效。
 *
 * URL 形：`<scheme>://<host>/<encodeURIComponent(绝对路径)>`——整条绝对路径编码成单个 path 段，
 * handler 解码还原。授权检查（单根 isPathInsideRoot，或调用方传入的 validate 白名单）+ 存在性
 * 检查后流式读盘；越界 403、缺失 404，绝不抛（协议 handler 抛错会带崩渲染请求）。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

import { mimeForAssetPath } from '../../shared/imageMime'

/**
 * 纯路径守卫（无 fs）：规整后的 absPath 必须落在 root 之内。
 * root 末尾补 sep 再比前缀，避免 /kb-index 命中 /kb-index-evil 这种兄弟目录误判。
 * 空串、规整后逃逸到 root 外 → false。
 */
export function isPathInsideRoot(absPath: string, root: string): boolean {
  if (!absPath || !root) return false
  const abs = normalize(absPath)
  const r = normalize(root)
  return abs === r || abs.startsWith(r + sep)
}

/**
 * 注册一个「绝对路径经守卫后流式读盘」协议。app.whenReady() 之后调用；
 * registerSchemesAsPrivileged 必须已在 ready 前登记过该 scheme（见 index.ts）。
 * resolveRoot 每请求调用（惰性），根目录依赖 app.getPath 的场景无需预热。
 *
 * `validate`（可选）：当调用方没有单一固定根目录可守——pptasset:// 服务的是任意会话的
 * ppt-master 项目目录，main 无法枚举「所有项目根」——传入一个扩展名+路径片段白名单判定
 * 函数，它替代（不是叠加）resolveRoot 的单根检查。三个既有 scheme（kbasset/proposalasset/
 * bgasset）都不传，行为不变。
 */
export async function registerLocalAssetProtocol(
  scheme: string,
  resolveRoot: () => string,
  validate?: (absPath: string) => boolean
): Promise<void> {
  // 动态导入 electron，避免模块顶层加载（保持本文件对 bun test import-safe）。
  const { protocol } = await import('electron')
  protocol.handle(scheme, async (request) => {
    try {
      const url = new URL(request.url)
      // pathname 形如 /<encodeURIComponent(绝对路径)>；去前导 / 再解码还原绝对路径。
      const absPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const authorized = validate ? validate(absPath) : isPathInsideRoot(absPath, resolveRoot())
      if (!authorized) return new Response('Forbidden', { status: 403 })
      const abs = normalize(absPath)
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
      const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
      return new Response(body, { headers: { 'content-type': mimeForAssetPath(abs) } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
