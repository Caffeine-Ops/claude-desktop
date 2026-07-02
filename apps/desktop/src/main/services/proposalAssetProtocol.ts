/**
 * `proposalasset://` 自定义协议 —— 让渲染进程显示草稿资产目录里的产出图
 * （改图/文生图/上传）。与 kbAssetProtocol.ts 同构，区别只在守卫根目录换成
 * `<userData>/proposal-drafts`（可写区），而非只读的 KB 镜像。
 *
 * URL 形：`proposalasset://p/<encodeURIComponent(图的绝对路径)>`，渲染侧由
 * toProposalAssetUrl 构造（见 renderer/lib/proposalAssetUrl.ts）。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const PROPOSAL_ASSET_SCHEME = 'proposalasset'

/** 纯前缀守卫（无 fs）：规整后的 absPath 必须落在 root 之内。root 末尾补 sep 防兄弟目录误判。 */
export function isPathInsideProposalRoot(absPath: string, root: string): boolean {
  if (!absPath || !root) return false
  const abs = normalize(absPath)
  const r = normalize(root)
  return abs === r || abs.startsWith(r + sep)
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function mimeFor(filePath: string): string {
  const idx = filePath.lastIndexOf('.')
  if (idx === -1) return 'application/octet-stream'
  return MIME[filePath.slice(idx).toLowerCase()] ?? 'application/octet-stream'
}

/** `<userData>/proposal-drafts`（惰性取，避免模块加载期 "app not ready"，且顶层对 bun test 保持 import-safe）。 */
export function proposalDraftsRoot(): string {
  // 函数内 require 而非顶层 import electron，避免模块加载期依赖 electron（影响 bun test）。
  const { app } = require('electron') as typeof import('electron')
  const { join } = require('node:path') as typeof import('node:path')
  return join(app.getPath('userData'), 'proposal-drafts')
}

/**
 * 注册 proposalasset:// handler。app.whenReady() 之后调用一次；registerSchemesAsPrivileged
 * 必须已在 ready 前跑过（见 index.ts）。命中 → 流式读盘；越界/不存在 → 404，绝不抛。
 */
export async function registerProposalAssetProtocol(): Promise<void> {
  const { protocol } = await import('electron')
  protocol.handle(PROPOSAL_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const absPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const root = proposalDraftsRoot()
      if (!isPathInsideProposalRoot(absPath, root)) return new Response('Forbidden', { status: 403 })
      const abs = normalize(absPath)
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
      const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
      return new Response(body, { headers: { 'content-type': mimeFor(abs) } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
