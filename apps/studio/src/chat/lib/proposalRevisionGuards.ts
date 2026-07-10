import type { BlockRevisionReview } from '../stores/proposal'

// 目标区间是否与某条【同节】待审阅卡的块区间相交（CEO 护栏#4）。相交=两张卡改重叠块，先后应用
// 会因块数变化令后一张 blockRange 错位。发起前命中即拦下，请用户先处理已有审阅卡。
export function blockRangeOverlapsPendingReview(
  reviews: Record<string, BlockRevisionReview>,
  sectionId: string,
  range: { start: number; end: number }
): boolean {
  for (const r of Object.values(reviews)) {
    if (r.sectionId !== sectionId) continue
    // 闭区间相交：start <= r.end && r.start <= end
    if (range.start <= r.blockRange.end && r.blockRange.start <= range.end) return true
  }
  return false
}
