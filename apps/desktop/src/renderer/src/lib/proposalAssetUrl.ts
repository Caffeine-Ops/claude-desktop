/**
 * 把 markdown 里的「草稿产出图绝对路径」转成 `proposalasset://` URL 供 <img> 加载。
 * 与 toKbAssetUrl 并列：KB 图含 /kb-index/assets/ 特征、走 kbasset；产出图含
 * /proposal-drafts/ + /assets/ 特征、走本函数。只在渲染时转，不改存储 markdown。
 *
 * 判定谓词复用 shared/proposalAsset 的 isProposalAssetPath（而非本地重复一份 '/'-硬编码
 * 判断）：一是 DRY，二是它内部做了 Windows 反斜杠归一化，win32 上产出的反斜杠路径也能正确
 * 识别。URL 里仍编码原始 src（保留分隔符），因为主进程 protocol handler 按原样 decode 后
 * 直接落盘路径比对，不能被这里悄悄改写。
 */
import { isProposalAssetPath } from '../../../shared/proposalAsset'

export function toProposalAssetUrl(src: string): string {
  if (!src) return src
  if (isProposalAssetPath(src)) {
    return `proposalasset://p/${encodeURIComponent(src)}`
  }
  return src
}
