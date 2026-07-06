/**
 * 草稿产出图（改图/文生图/上传）的路径判定与来源推导纯函数。
 *
 * 为什么靠路径而非 markdown schema：产出图与 KB 图一样在 markdown 里只存绝对路径
 * （`![alt](/abs/path.png)`），没有额外字段承载来源。约定「草稿资产目录 + 文件名前缀」
 * 双特征就能无歧义地推出来源，零 schema 变更。见 [[proposal-image-editing 设计 spec]]。
 *
 * Windows 兼容：`writeProposalImage` 用 `path.join` 落盘，win32 上产出反斜杠路径并原样
 * 存进 markdown（这里不改存储格式，只改判定）。三处消费者（本文件的谓词 + basename 推导、
 * renderer 的 proposalAssetUrl）都必须在反斜杠路径上正确工作，否则 Windows 用户会遇到
 * 「图不转协议 / 溯源角标消失 / 校验误报未接地」。做法：判定前先把 `\` 归一成 `/` 的副本，
 * 原始字符串（含分隔符）不动——因为存储的 markdown、以及 <img src> 用的仍是原路径。
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

/** win32 反斜杠路径 → 正斜杠副本，仅供判定/basename 提取用，不改原始字符串。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function isProposalAssetPath(absPath: string): boolean {
  if (!absPath) return false
  const p = toPosix(absPath)
  return p.includes(PROPOSAL_ASSET_MARKER) && p.includes(ASSETS_SEG)
}

export function deriveImageOrigin(absPath: string): ProposalImageOrigin | null {
  if (!isProposalAssetPath(absPath)) return null
  const p = toPosix(absPath)
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (base.startsWith('gen-')) return 'generated'
  if (base.startsWith('edit-')) return 'edited'
  if (base.startsWith('upload-')) return 'uploaded'
  return null
}

export function proposalAssetFileName(origin: ProposalImageOrigin, ext: string, ts: number): string {
  return `${PREFIX[origin]}-${ts}.${ext}`
}
