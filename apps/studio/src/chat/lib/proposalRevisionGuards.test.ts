import { describe, it, expect } from 'bun:test'
import { blockRangeOverlapsPendingReview } from './proposalRevisionGuards'
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
