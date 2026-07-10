import type { BlockRevisionReview } from '../stores/proposal'
import { locateBlockRangeByTextWithHint } from '@desktop-shared/proposalBlocks'

// 目标区间是否与某条【同节】待审阅卡的块区间相交（护栏#4）。相交=两张卡改重叠块，先后应用
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

// 一次改写发起前的统一判定（复审 H1/H2/M4 收口）：把「按选中文字在最新 markdown 里重定位块区间」
// 与「审阅卡重叠拦截」合成一步，直发路径（SelectionAiBubble.fire 即时发起）与排队路径
// （drainRevisionQueue 排空）【共用同一判定】——此前重叠拦截只加在直发分支、排队分支绕过，是
// 草稿被改错块的根因（H1）；直发分支又直接信可能过期的 anchor 块序号、AI 整节重写后会改错段落
// （H2）。改由这里统一：一律按 selectedText 重定位（带 hint 距离上限，M4），再查重叠。
//   - 'ok'：range 是重定位后的最新块区间，可安全发起；
//   - 'missing'：选中文字在最新草稿里已找不到（被删/大改）→ 上层跳过并提示，绝不拿旧序号硬改；
//   - 'overlap'：与某条待确认审阅卡重叠 → 上层拦下，请用户先处理那张卡。
export type RevisionTarget =
  | { status: 'ok'; range: { start: number; end: number } }
  | { status: 'missing' }
  | { status: 'overlap' }

export function resolveRevisionTarget(params: {
  markdown: string
  blockReviews: Record<string, BlockRevisionReview>
  sectionId: string
  selectedText: string
  hintRange: { start: number; end: number }
}): RevisionTarget {
  const range = locateBlockRangeByTextWithHint(params.markdown, params.selectedText, params.hintRange)
  if (!range) return { status: 'missing' }
  if (blockRangeOverlapsPendingReview(params.blockReviews, params.sectionId, range)) return { status: 'overlap' }
  return { status: 'ok', range }
}
