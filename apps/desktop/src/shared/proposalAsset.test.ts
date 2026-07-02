import { describe, it, expect } from 'bun:test'
import {
  isProposalAssetPath,
  deriveImageOrigin,
  proposalAssetFileName
} from './proposalAsset'

describe('isProposalAssetPath', () => {
  it('proposal-drafts 下的 assets 路径 → true', () => {
    expect(
      isProposalAssetPath('/U/x/Application Support/app/proposal-drafts/sess-1/assets/gen-123.png')
    ).toBe(true)
  })
  it('KB assets 路径 → false（不是草稿资产）', () => {
    expect(isProposalAssetPath('/U/x/app/kb-index/assets/线/img-1.png')).toBe(false)
  })
  it('空串 → false', () => {
    expect(isProposalAssetPath('')).toBe(false)
  })
})

describe('deriveImageOrigin', () => {
  it('gen- 前缀 → generated', () => {
    expect(deriveImageOrigin('/p/proposal-drafts/s/assets/gen-1.png')).toBe('generated')
  })
  it('edit- 前缀 → edited', () => {
    expect(deriveImageOrigin('/p/proposal-drafts/s/assets/edit-1.png')).toBe('edited')
  })
  it('upload- 前缀 → uploaded', () => {
    expect(deriveImageOrigin('/p/proposal-drafts/s/assets/upload-1.png')).toBe('uploaded')
  })
  it('非草稿资产路径 → null', () => {
    expect(deriveImageOrigin('/p/kb-index/assets/img-1.png')).toBeNull()
  })
})

describe('proposalAssetFileName', () => {
  it('generated → gen-<ts>.png', () => {
    expect(proposalAssetFileName('generated', 'png', 1751000000000)).toBe('gen-1751000000000.png')
  })
  it('edited → edit-<ts>.png', () => {
    expect(proposalAssetFileName('edited', 'png', 42)).toBe('edit-42.png')
  })
})
