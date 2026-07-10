/**
 * 「三阶段上手引导」的判定纯函数测试。
 * 覆盖 seen×sectionsEmpty 四种组合。
 */
import { describe, test, expect } from 'bun:test'
import { shouldShowProposalOnboarding } from './proposalOnboarding'

describe('shouldShowProposalOnboarding', () => {
  test('没看过且草稿为空 → 显示', () => {
    expect(shouldShowProposalOnboarding(false, true)).toBe(true)
  })
  test('没看过但草稿非空 → 不显示', () => {
    expect(shouldShowProposalOnboarding(false, false)).toBe(false)
  })
  test('已看过且草稿为空 → 不显示', () => {
    expect(shouldShowProposalOnboarding(true, true)).toBe(false)
  })
  test('已看过且草稿非空 → 不显示', () => {
    expect(shouldShowProposalOnboarding(true, false)).toBe(false)
  })
})
