import { describe, it, expect } from 'bun:test'
import { blockRangeOverlapsPendingReview, resolveRevisionTarget } from './proposalRevisionGuards'
import type { BlockRevisionReview } from '../stores/proposal'

const mk = (sectionId: string, start: number, end: number): BlockRevisionReview => ({
  sectionId, blockRange: { start, end }, before: 'x', after: 'y'
})

describe('blockRangeOverlapsPendingReview', () => {
  const reviews = { m1: mk('sec-1', 2, 4) }

  it('同节区间相交：true', () => {
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-1', { start: 3, end: 5 })).toBe(true)
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-1', { start: 4, end: 4 })).toBe(true)
  })
  it('同节区间不相交：false', () => {
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-1', { start: 5, end: 6 })).toBe(false)
  })
  it('异节：false', () => {
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-2', { start: 2, end: 4 })).toBe(false)
  })
  it('无待审阅：false', () => {
    expect(blockRangeOverlapsPendingReview({}, 'sec-1', { start: 2, end: 4 })).toBe(false)
  })
})

describe('resolveRevisionTarget', () => {
  const md = ['甲段。', '乙段。', '丙段。'].join('\n\n')

  it('文字命中且无重叠：ok + 重定位后的 range', () => {
    const r = resolveRevisionTarget({
      markdown: md,
      blockReviews: {},
      sectionId: 'sec-1',
      selectedText: '乙段。',
      hintRange: { start: 1, end: 1 }
    })
    expect(r).toEqual({ status: 'ok', range: { start: 1, end: 1 } })
  })

  it('文字找不到（被删/大改）：missing——绝不拿旧序号硬改（复审 H2）', () => {
    const r = resolveRevisionTarget({
      markdown: md,
      blockReviews: {},
      sectionId: 'sec-1',
      selectedText: '这段已经不存在了',
      hintRange: { start: 1, end: 1 }
    })
    expect(r).toEqual({ status: 'missing' })
  })

  it('命中块与待审阅卡重叠：overlap——排队路径也走这条拦截（复审 H1）', () => {
    const r = resolveRevisionTarget({
      markdown: md,
      blockReviews: { m1: mk('sec-1', 1, 1) }, // 块 1 已有待确认卡
      sectionId: 'sec-1',
      selectedText: '乙段。', // 定位到块 1，与卡重叠
      hintRange: { start: 1, end: 1 }
    })
    expect(r).toEqual({ status: 'overlap' })
  })
})
