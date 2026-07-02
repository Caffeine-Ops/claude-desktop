/**
 * `proposalasset://` 自定义协议 —— 让渲染进程显示草稿资产目录里的产出图
 * （改图/文生图/上传）。与 kbasset:// 的区别只在守卫根目录换成
 * `<userData>/proposal-drafts`（可写区），而非只读的 KB 镜像。
 *
 * 具体实现收口在 localAssetProtocol.ts（与 kbasset:// 共用同一个工厂，评审发现两 handler
 * 曾是逐行克隆）。URL 形：`proposalasset://p/<encodeURIComponent(图的绝对路径)>`，渲染侧由
 * toProposalAssetUrl 构造（见 renderer/lib/proposalAssetUrl.ts）。
 */

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const PROPOSAL_ASSET_SCHEME = 'proposalasset'

import { isPathInsideRoot, registerLocalAssetProtocol } from './localAssetProtocol'

/** 语义化别名，测试/校验豁免谓词沿用此名；实现见 localAssetProtocol.isPathInsideRoot。 */
export function isPathInsideProposalRoot(absPath: string, root: string): boolean {
  return isPathInsideRoot(absPath, root)
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
  await registerLocalAssetProtocol(PROPOSAL_ASSET_SCHEME, () => proposalDraftsRoot())
}
