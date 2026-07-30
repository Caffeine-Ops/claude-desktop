import { useMemo, useRef } from 'react'

import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { cn } from '@/src/lib/utils'
import { useWritingStore } from '../../stores/writing'
import { paperSkinClass } from '../../lib/writingGenreStyle'
import type { WritingRevisionTarget } from '../../lib/writingRevision'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { WritingSelectionBubble } from './WritingSelectionBubble'

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
  busy = false,
  onRevise
}: {
  /**
   * 这一轮 AI 是不是正在往当前文档源里落字（`useWritingInProgress()`，见 stores/writing.ts）
   * ——**不是**会话级的 `streaming`。会话级 streaming 在一轮 assistant 消息的 start~end 之间
   * 恒真，AI 跑无关 shell / 回答问题时也是真；全文写完后用户提问会让骨架误挂着「正在写
   * 第 N 节」。调用方（WritingDocPanel）已经做了这次收窄，这里只管消费布尔值。
   */
  writing: boolean
  /** AI 忙 / 已有一条改写在飞——只影响气泡按钮文案（「排队改写」），路由由调用方现读 store 决定。 */
  busy?: boolean
  /**
   * 发起一次选区改写。**省略时纸面就是纯只读的**（打印预览 tab 复用纸面时不该冒出改写气泡），
   * 故气泡跟着这个 prop 挂载与否，而不是无条件常驻。
   */
  onRevise?: (target: WritingRevisionTarget, instruction: string) => void
}): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const outlineTotal = useWritingStore((s) => s.outlineTotal)
  const status = useWritingStore((s) => s.status)
  // 滚动容器：既是选区气泡的定位参照系（容器 relative），也是「选区必须落在纸面内」的判据。
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
      ref={scrollRef}
      // relative：选区气泡是它的 absolute 子节点，靠这层建立包含块（气泡坐标已含 scrollTop，
      // 故会随内容一起滚，不需要在 scroll 上重算）。
      className="relative flex-1 overflow-y-auto"
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

      {/* 选区即改浮层。挂在滚动容器内（而非 portal 到 body）：坐标是容器相对的，随内容滚动
          天然对齐；也免了 portal 子树脱离 .chat-app 豁免后要给每个交互元素补 data-slot
          的那一串坑（见 CLAUDE.md 样式铁律）。 */}
      {onRevise && (
        <WritingSelectionBubble containerRef={scrollRef} busy={busy} onSubmit={onRevise} />
      )}
    </div>
  )
}
