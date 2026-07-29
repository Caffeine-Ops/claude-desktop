import { useMemo } from 'react'

import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { cn } from '@/src/lib/utils'
import { useWritingStore } from '../../stores/writing'
import { paperSkinClass } from '../../lib/writingGenreStyle'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

/**
 * 文稿态纸面。**只读**——第一版不做手动改字（见 spec「明确不做」），一切修改经 AI 改写通道。
 *
 * 逐块渲染（块 = 一个标题/段落/列表/表格/围栏代码，切法见 proposalBlocks.ts）而不是把整节
 * 丢给一个 markdown 组件：块的 DOM 边界就是选区改写的定位锚点——`data-section-name` +
 * `data-block-index` 让选区两端能向上 closest() 找到「选中了哪一节的哪几块」。整节渲染时
 * 这个映射无从建立。
 */
export function WritingPaper({
  writing,
  onSelectionChange
}: {
  /**
   * 这一轮 AI 是不是正在往当前文档源里落字（`useWritingInProgress()`，见 stores/writing.ts）
   * ——**不是**会话级的 `streaming`。会话级 streaming 在一轮 assistant 消息的 start~end 之间
   * 恒真，AI 跑无关 shell / 回答问题时也是真；全文写完后用户提问会让骨架误挂着「正在写
   * 第 N 节」。调用方（WritingDocPanel）已经做了这次收窄，这里只管消费布尔值。
   */
  writing: boolean
  onSelectionChange?: () => void
}): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const outlineTotal = useWritingStore((s) => s.outlineTotal)
  const status = useWritingStore((s) => s.status)

  // 每节切块。sections 变才重算——流式期间 2s 一次，代价可忽略。
  const blocks = useMemo(
    () => sections.map((s) => ({ name: s.name, items: splitBlocks(s.markdown) })),
    [sections]
  )

  if (status === 'missing') {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          写作项目目录已不存在
          <br />
          可能被移动或删除了
        </div>
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          还没有正文
          <br />
          AI 写完第一节后会自动出现在这里
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex-1 overflow-y-auto"
      onMouseUp={onSelectionChange}
      onKeyUp={onSelectionChange}
    >
      {/* writing-paper / writing-block：目前全仓没有对应的 CSS 规则，是留给后续任务
          （打印预览的样式对齐、选区改写的定位/高亮）的稳定钩子——不要当成废代码清掉。 */}
      <div className={cn('writing-paper', paperSkinClass(genre))}>
        {blocks.map((sec) =>
          sec.items.map((block, i) => (
            <div
              key={`${sec.name}:${i}`}
              data-section-name={sec.name}
              data-block-index={i}
              className="writing-block"
            >
              <AssistantMarkdown text={block} />
            </div>
          ))
        )}

        {/* 进度骨架：节级实时的代价是写一节的几十秒里页面不动，用它告诉用户「在写、还剩几节」。
            总数解析不到时只说「正在写下一节」——显示错的总数比不显示更糟。 */}
        {writing && (
          <div className="mt-6 flex items-center gap-2 text-[12px] text-muted-foreground">
            <div className="size-3 animate-spin rounded-full border-[2px] border-border border-t-accent" />
            {outlineTotal
              ? `正在写第 ${sections.length + 1} 节 · 共 ${outlineTotal} 节`
              : '正在写下一节…'}
          </div>
        )}
      </div>
    </div>
  )
}
