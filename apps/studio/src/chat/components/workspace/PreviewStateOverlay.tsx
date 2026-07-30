import { cn } from '@/src/lib/utils'

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
   * 空态正文（外层的居中容器由本组件给）。两边内容本就不同：写作端一行灰字，方案端是
   * 图标 + 两行引导。整块由调用方传入。
   */
  empty: React.ReactNode
  /**
   * 传了才渲染「重试」按钮。目前只有方案端传——写作端历史上没有这个按钮，本次纯去重
   * 重构刻意保持原样，待体验统一时再补。
   */
  onRetry?: () => void
}): React.JSX.Element | null {
  if (status === 'loading') {
    return (
      <div className="absolute inset-0 grid place-items-center bg-neutral-200/80 dark:bg-neutral-900/80">
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
      <div className="absolute inset-0 grid place-items-center">
        {/* gap 跟随「有没有重试按钮」：三个元素时留 12px、两个时留 8px，正是两边原先各自的
            取值（方案端 gap-3 / 写作端 gap-2）。这是「元素多了间距大一点」的效果描述，
            不是区分调用方身份的开关。 */}
        <div
          className={cn(
            'flex max-w-[80%] flex-col items-center text-center',
            onRetry ? 'gap-3' : 'gap-2'
          )}
        >
          <div className="text-[13px] text-rose-500">预览生成失败</div>
          <div className="text-[11px] text-muted-foreground">{errMsg}</div>
          {onRetry && (
            // 裸 <button> 在此处安全：本组件属于 chat 树（.chat-app 下），canvas 的裸元素
            // reset 带 `:where(:not([data-slot], .chat-app *))` 守卫，不会把它填成描边卡片。
            <button
              className="rounded border border-border px-3 py-1 text-[12px] hover:border-accent"
              onClick={onRetry}
            >
              重试
            </button>
          )}
        </div>
      </div>
    )
  }

  return null
}
