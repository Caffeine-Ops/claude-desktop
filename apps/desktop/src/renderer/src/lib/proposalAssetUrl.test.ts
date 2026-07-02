import { describe, it, expect } from 'bun:test'

import { toProposalAssetUrl } from './proposalAssetUrl'

describe('toProposalAssetUrl', () => {
  it('草稿资产绝对路径 → proposalasset:// 编码 URL', () => {
    const p = '/U/x/app/proposal-drafts/sess-1/assets/gen-123.png'
    expect(toProposalAssetUrl(p)).toBe(`proposalasset://p/${encodeURIComponent(p)}`)
  })
  it('KB 图路径原样返回（交给 kbasset 处理）', () => {
    const p = '/U/x/app/kb-index/assets/img-1.png'
    expect(toProposalAssetUrl(p)).toBe(p)
  })
  it('http 图原样返回', () => {
    expect(toProposalAssetUrl('https://e.com/a.png')).toBe('https://e.com/a.png')
  })
})
