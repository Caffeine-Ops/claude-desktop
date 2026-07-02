/**
 * 把 markdown 里的「草稿产出图绝对路径」转成 `proposalasset://` URL 供 <img> 加载。
 * 与 toKbAssetUrl 并列：KB 图含 /kb-index/assets/ 特征、走 kbasset；产出图含
 * /proposal-drafts/ + /assets/ 特征、走本函数。只在渲染时转，不改存储 markdown。
 */
import { PROPOSAL_ASSET_MARKER } from '../../../shared/proposalAsset'

export function toProposalAssetUrl(src: string): string {
  if (!src) return src
  if (src.includes(PROPOSAL_ASSET_MARKER) && src.includes('/assets/')) {
    return `proposalasset://p/${encodeURIComponent(src)}`
  }
  return src
}
