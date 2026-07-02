/**
 * 草稿产出图（改图/文生图/上传）的路径判定与来源推导纯函数。
 *
 * 为什么靠路径而非 markdown schema：产出图与 KB 图一样在 markdown 里只存绝对路径
 * （`![alt](/abs/path.png)`），没有额外字段承载来源。约定「草稿资产目录 + 文件名前缀」
 * 双特征就能无歧义地推出来源，零 schema 变更。见 [[proposal-image-editing 设计 spec]]。
 */

/** 草稿资产落盘根特征：`<userData>/proposal-drafts/<sessionId>/assets/`。 */
export const PROPOSAL_ASSET_MARKER = '/proposal-drafts/'
const ASSETS_SEG = '/assets/'

export type ProposalImageOrigin = 'generated' | 'edited' | 'uploaded'

const PREFIX: Record<ProposalImageOrigin, string> = {
  generated: 'gen',
  edited: 'edit',
  uploaded: 'upload'
}

export function isProposalAssetPath(absPath: string): boolean {
  if (!absPath) return false
  return absPath.includes(PROPOSAL_ASSET_MARKER) && absPath.includes(ASSETS_SEG)
}

export function deriveImageOrigin(absPath: string): ProposalImageOrigin | null {
  if (!isProposalAssetPath(absPath)) return null
  const base = absPath.slice(absPath.lastIndexOf('/') + 1)
  if (base.startsWith('gen-')) return 'generated'
  if (base.startsWith('edit-')) return 'edited'
  if (base.startsWith('upload-')) return 'uploaded'
  return null
}

export function proposalAssetFileName(origin: ProposalImageOrigin, ext: string, ts: number): string {
  return `${PREFIX[origin]}-${ts}.${ext}`
}
