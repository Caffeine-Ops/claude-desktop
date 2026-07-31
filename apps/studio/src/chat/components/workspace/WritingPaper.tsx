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
   * 发起一次选区改写。**省略时纸面就是纯只读的**（将来若有只读复用场景，不该冒出改写气泡），
   * 故气泡跟着这个 prop 挂载与否，而不是无条件常驻。
   */
  onRevise?: (target: WritingRevisionTarget, instruction: string) => void
}): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const outlineTotal = useWritingStore((s) => s.outlineTotal)
  const status = useWritingStore((s) => s.status)
  const errMsg = useWritingStore((s) => s.errMsg)
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

  // 扫描 / 读取 IPC 失败。**必须排在下面那条空态分支之前**：status='error' 时 sections 通常
  // 也是空的，若不先拦一道，报错会被伪装成「还没有正文，AI 写完第一节后会自动出现在这里」
  // ——用户看到的是一个永远等不来内容的正常等待态，而 store 里其实躺着一条谁也读不到的
  // errMsg（那个字段此前是「只写不读」的死字段，这就是它的读者）。
  // 权限不足 / 磁盘卸载 / 文件名编码异常这类错误只能靠这条文案暴露出来。
  if (status === 'error' && sections.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="text-[12.5px] leading-relaxed text-muted-foreground">
          读取文稿失败
          {errMsg && (
            <>
              <br />
              <span className="break-all text-rose-600 dark:text-rose-400">{errMsg}</span>
            </>
          )}
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
      {/* 已经有正文、但最近一次轮询读盘失败：不整屏替换成错误页（那会把用户正在看的稿子
          整个抹掉，而这份内容仍然是有效的、只是可能不是最新的），改用一条细提示条说明
          「屏幕上这份可能已经过时」。轮询每 2s 会自愈，条子随之消失。
          sticky 而非普通流内：本组件的根节点就是滚动容器，不 sticky 的话用户往下读几屏
          就再也看不到这条「你看的可能是旧内容」的警告了。 */}
      {status === 'error' && (
        <div className="sticky top-0 z-10 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 backdrop-blur-sm dark:text-amber-400">
          刷新文稿失败，下面显示的可能不是最新内容{errMsg ? `：${errMsg}` : ''}
        </div>
      )}
      {/* writing-paper / writing-block：目前全仓没有对应的 CSS 规则，是留给后续任务
          （选区改写的定位/高亮等）的稳定钩子——不要当成废代码清掉。 */}
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
            总数解析不到时只说「正在写下一节」——显示错的总数比不显示更糟。

            【为什么要判 sections.length >= outlineTotal 这一路】`writing` 的判据是「这一轮有
            写 drafts/ 的文件调用」，它分不清 AI 是在往下写新的一节、还是质检后回头重写第 3 节。
            全文写完（sections.length === outlineTotal）后 AI 回头润色，序号会算成
            `已有 6 节 + 1` = 第 7 节，于是冒出「正在写第 7 节 · 共 6 节」这种越界数字。
            此时正确的信息本来就不是序号（我们并不知道它在改哪一节），换成不带序号的文案。
            **注意判据是 `>`（即 sections.length >= outlineTotal）而不是「夹紧后 == outlineTotal」**：
            后者会把「已写 5 节、正在写第 6 节（共 6 节）」这个完全正常的最后一节也误报成
            「正在修改」——那恰恰是最需要显示进度的一刻。
            残余局限（本次不修）：写到一半时回头改前面某节（如已 4 节 / 共 6 节时重写第 2 节），
            仍会显示「正在写第 5 节」。要根治得让 isWritingInProgress 回传「在写哪个文件」再
            与 sections 比对，属于另一个改动，这里只保证不出越界数字。 */}
        {writing && (
          <div className="mt-6 flex items-center gap-2 text-[12px] text-muted-foreground">
            <div className="size-3 animate-spin rounded-full border-[2px] border-border border-t-accent" />
            {!outlineTotal
              ? '正在写下一节…'
              : sections.length + 1 > outlineTotal
                ? 'AI 正在修改这篇稿子…'
                : `正在写第 ${sections.length + 1} 节 · 共 ${outlineTotal} 节`}
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
