import { Button } from '@/src/components/ui/button'
import { useWritingStore } from '../../stores/writing'

/**
 * 「原文 vs 改后」对照卡。**AI 不直接改文件**，改动先停在这里等用户裁决——改得不满意
 * 零代价丢掉，不污染定稿。这是用户明确要的那一步（对齐写方案的选区改写体验）。
 */
export function WritingRevisionReviewCard({
  applying,
  onApply,
  onDiscard
}: {
  /** 写盘在飞：禁用两个按钮防重入（一次改写写两遍会撞乐观锁、第二遍必冲突刷屏）。 */
  applying: boolean
  onApply: () => void
  onDiscard: () => void
}): React.JSX.Element | null {
  const review = useWritingStore((s) => s.review)
  if (!review) return null

  return (
    <div className="shrink-0 border-t border-border bg-muted/30 p-3">
      <div className="mb-2 text-[12px] font-medium text-muted-foreground">
        改写结果待确认 · {review.target.sectionName}
      </div>
      {/* 兜底成卡的警示条。作用范围是按位置推断的（精确定位没命中），弱校验挡不住全部错块，
          最后一道闸只能是用户的眼睛——那就明确告诉他该看哪，别让他把「左边这段眼生」读成
          「AI 改得比较狠」。见 WritingRevisionReview.inferred 的注释。 */}
      {review.inferred && (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
          这段是按位置推断出来的，请核对左边确实是你要改的那段。
        </div>
      )}
      {/* 对照区限高可滚：整节被改写时 after 可能上千字，不限高会把纸面整个挤出视口。 */}
      <div className="grid max-h-[40vh] gap-2 overflow-y-auto md:grid-cols-2">
        <div className="rounded border border-border bg-background p-2">
          <div className="mb-1 text-[11px] text-muted-foreground">原文</div>
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
            {review.before}
          </div>
        </div>
        <div className="rounded border border-accent bg-background p-2">
          <div className="mb-1 text-[11px] text-accent">改写后</div>
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
            {review.after}
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={applying} onClick={onApply}>
          {applying ? '写入中…' : '应用'}
        </Button>
        <Button size="sm" variant="ghost" disabled={applying} onClick={onDiscard}>
          放弃
        </Button>
      </div>
    </div>
  )
}
