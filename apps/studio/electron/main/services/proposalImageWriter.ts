/**
 * 出图落盘 helper：把 service（imageGenService.ts）产出的 Buffer 存进草稿资产目录，
 * 返回绝对路径。文件名前缀编码来源（Task 1 proposalAsset.ts 约定：gen-/edit-/upload-），
 * 落在 `<userData>/proposal-drafts/<sessionId>/assets/` 下，可被 proposalasset:// 协议加载
 * （守卫根目录见 proposalAssetProtocol.ts）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { proposalAssetFileName, type ProposalImageOrigin } from '../../shared/proposalAsset'

/**
 * 纯拼路径（可测，不碰 fs、不 import electron）。保持这个函数零依赖是为了让
 * `bun test` 能直接加载本模块——顶层 import electron 会在 bun 环境炸掉。
 */
export function assetPathFor(
  root: string,
  sessionId: string,
  origin: ProposalImageOrigin,
  ext: string,
  ts: number
): string {
  return join(root, sessionId, 'assets', proposalAssetFileName(origin, ext, ts))
}

/**
 * 落盘：mkdir -p `<root>/<sessionId>/assets/` 后写文件，返回绝对路径。
 * `proposalDraftsRoot` 动态 import——它顶层 require('electron')，若本文件顶层引入会让
 * `assetPathFor` 也间接依赖 electron，破坏上面「bun test import-safe」的约定。
 */
export async function writeProposalImage(
  sessionId: string,
  origin: ProposalImageOrigin,
  bytes: Buffer,
  ext = 'png'
): Promise<string> {
  const { proposalDraftsRoot } = await import('./proposalAssetProtocol')
  const root = proposalDraftsRoot()
  const ts = Date.now()
  const abs = assetPathFor(root, sessionId, origin, ext, ts)
  await mkdir(join(root, sessionId, 'assets'), { recursive: true })
  await writeFile(abs, bytes)
  return abs
}
