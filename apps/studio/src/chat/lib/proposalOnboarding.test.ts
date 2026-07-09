import { describe, it, expect } from 'bun:test'
import { shouldShowProposalOnboarding } from './proposalOnboarding'

describe('shouldShowProposalOnboarding', () => {
  it('没看过 + 草稿为空 → 显示', () => {
    expect(shouldShowProposalOnboarding(false, true)).toBe(true)
  })
  it('没看过 + 草稿有内容 → 不显示（被内容替换）', () => {
    expect(shouldShowProposalOnboarding(false, false)).toBe(false)
  })
  it('看过 + 草稿为空 → 不显示（老用户不打扰）', () => {
    expect(shouldShowProposalOnboarding(true, true)).toBe(false)
  })
  it('看过 + 草稿有内容 → 不显示', () => {
    expect(shouldShowProposalOnboarding(true, false)).toBe(false)
  })
})
