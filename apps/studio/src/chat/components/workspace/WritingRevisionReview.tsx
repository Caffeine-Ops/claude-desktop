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
      {/* 多处命中的警示条：源码级精确匹配本身没有歧义，但这一节里恰好有好几处内容完全相同
          （模板化的段落），机器没法替用户判断该改的是哪一份，只能按「离原选中位置最近」挑一处
          ——挑中的那处可能是错的。见 WritingRevisionReview.ambiguous 的注释。
          文案说「原文那一栏」而不是「左边」：下面的对照区是 md:grid-cols-2，窄窗口下两栏
          竖排，「左边」当场变成「上面」，指错方向的提示比没有提示更糟。 */}
      {review.ambiguous && (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[12px] leading-relaxed text-amber-700 dark:text-amber-400">
          这一节里有多段内容完全相同，已按最接近的位置匹配 —— 请核对原文那一栏确实是你要改的那段。
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
