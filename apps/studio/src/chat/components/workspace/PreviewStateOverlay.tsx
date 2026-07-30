import type { PreviewStatus } from './usePreviewFrame'

/**
 * 预览的 loading / empty / error 三层遮罩。WritingPreview 与 ProposalPreview 原本各写了
 * 一份，markup 逐个 class 相同、只有文案和空态内容不同——那类重复的代价是「谁改一边就
 * 两边不一致」，故收成一处。
 *
 * 与 usePreviewFrame 的分工：hook 管「什么时候是哪个状态」，本组件只管「那个状态长什么样」，
 * 一行逻辑都不放。三态互斥，都不命中时渲染 null（ready 态由调用方自己画产出）。
 *
 * 差异一律走 props，且**只接受「我要什么效果」式的参数，不接受「我是写作还是方案」式的开关**：
 * 空态整块交给调用方（相当于插槽），比堆 emptyIcon / emptyLine2 之类的布尔陷阱干净得多。
 */

/**
 * 半透明幕布，**loading 与 error 两态共用**。
 *
 * 为什么这两态必须有幕布、空态必须没有：渲染新帧期间（loading）与渲染失败后（error），
 * 上一帧的产出都还留在下层没被清掉——这是「不闪空白」的刻意设计（见 usePreviewFrame）。
 * 不盖幕布的话文案会直接叠在上一帧的 PDF 正文上，红字压黑字几乎读不清（error 态原先就是
 * 这样：两个预览组件历史上都只给 loading 加了幕布，漏了 error，2026-07-30 修）。而空态的
 * 下层本来就是空的，加幕布只会平白糊掉背景色。
 *
 * 抽成常量而不是两处各写一份：这两处的取值没有任何理由分岔，而「两份拷贝迟早走偏」正是
 * 本组件存在的理由——它自己内部就不该再留同类隐患。
 */
const SCRIM = 'bg-neutral-200/80 dark:bg-neutral-900/80'

export function PreviewStateOverlay({
  status,
  errMsg,
  loadingText,
  empty,
  onRetry
}: {
  status: PreviewStatus
  errMsg: string
  loadingText: string
  /**
   * 空态正文（外层的居中容器由本组件给）。两边都是「图标 + 两行引导」，但第二行指向各自的
   * tab 名（写作是「文稿」、方案是「编辑」），文案不能共用，故整块由调用方传入。
   */
  empty: React.ReactNode
  /**
   * 「重试」按钮的动作。**必填**：两处预览的错误都是可重试的（重跑同一份内容的渲染），
   * 没有理由让其中一处的用户卡在死错误上。曾经写作端没有这个按钮，那时本组件的错误态
   * 有过 `onRetry ? 'gap-3' : 'gap-2'` 的分支；两边统一后没有调用方走「无按钮」那条，
   * 分支随之删除——真出现「不可重试的预览」再把可选性加回来即可。
   */
  onRetry: () => void
}): React.JSX.Element | null {
  if (status === 'loading') {
    return (
      <div className={`absolute inset-0 grid place-items-center ${SCRIM}`}>
        <div className="flex flex-col items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-[2.5px] border-border border-t-accent" />
          <div className="text-[12px] text-muted-foreground">{loadingText}</div>
        </div>
      </div>
    )
  }

  if (status === 'empty') {
    return <div className="absolute inset-0 grid place-items-center">{empty}</div>
  }

  if (status === 'error') {
    return (
      <div className={`absolute inset-0 grid place-items-center ${SCRIM}`}>
        {/* 错误信息坐实体卡片里，不是裸文字浮在幕布上。幕布只有 80% 不透明，剩下 20% 足以让
            下层 PDF 的正文透上来糊住红字，「重试」按钮本身还是透明底、字会直接和 PDF 文字重叠
            （只加幕布时实测仍难读）。错误是需要**阅读并据此操作**的内容，给它不透明底 —— 这也
            是它与 loading 的区别：后者只是个短暂提示，不必挡住下层。 */}
        <div className="flex max-w-[80%] flex-col items-center gap-3 rounded-lg border border-border bg-card px-5 py-4 text-center shadow-sm">
          <div className="text-[13px] text-rose-500">预览生成失败</div>
          <div className="text-[11px] text-muted-foreground">{errMsg}</div>
          {/* 裸 <button> 在此处安全：本组件属于 chat 树（.chat-app 下），canvas 的裸元素
              reset 带 `:where(:not([data-slot], .chat-app *))` 守卫，不会把它填成描边卡片。 */}
          <button
            className="rounded border border-border px-3 py-1 text-[12px] hover:border-accent"
            onClick={onRetry}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  return null
}
