import { describe, it, expect } from 'bun:test'
import { isPathInsideProposalRoot } from './proposalAssetProtocol'

const ROOT = '/U/x/app/proposal-drafts'

describe('isPathInsideProposalRoot', () => {
  it('根目录内的文件 → true', () => {
    expect(isPathInsideProposalRoot(`${ROOT}/sess-1/assets/gen-1.png`, ROOT)).toBe(true)
  })
  it('根目录本身 → true', () => {
    expect(isPathInsideProposalRoot(ROOT, ROOT)).toBe(true)
  })
  it('兄弟目录 proposal-drafts-evil → false（防前缀误判）', () => {
    expect(isPathInsideProposalRoot('/U/x/app/proposal-drafts-evil/x.png', ROOT)).toBe(false)
  })
  it('逃逸到根外 → false', () => {
    expect(isPathInsideProposalRoot(`${ROOT}/../../etc/passwd`, ROOT)).toBe(false)
  })
  it('空串 → false', () => {
    expect(isPathInsideProposalRoot('', ROOT)).toBe(false)
  })
})
