import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

import { cn } from '@/src/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/src/components/ui/tooltip'
import { useT, useTFormat } from '../../../i18n'
import { HISTORY_WINDOW_REVEAL_STEP, useChatStore } from '../../../stores/chat'
import { useThreadFindStore } from '../../../stores/threadFind'
import {
  findInMessages,
  revealStepsNeeded,
  stepHit,
  type FindHit
} from '../../../lib/threadFind'
import type { TranscriptMessage } from '../../../lib/exportTranscript'

/**
 * 对话内查找栏（⌘F）。
 *
 * 与 ⌘K 的分工：⌘K（SessionSearchDialog）跨会话找「哪个对话」，走 IPC 搜
 * 磁盘上的 jsonl；本组件只在**眼前这轮对话**里找「哪句话」，搜的是内存里
 * 的消息数组。两者键位、入口、数据源都不同，刻意不合并。
 *
 * 三个不显然的实现点
 * ------------------
 * 1. **搜数据不搜屏幕**。长对话默认只挂载最近 30 条，拿 Chromium 自带的
 *    整页查找只能搜到眼前那一屏（理由详见 lib/threadFind 头注释）。命中
 *    一条还没挂载的早期消息时，这里先把历史窗口揭够次数再滚过去。
 * 2. **不做字符级高亮，只定位到消息**。AI 回复是 markdown 渲染出来的，
 *    要在渲染结果里精确标中那几个字得改渲染管线，成本高一个量级且容易
 *    把代码块 / 表格搞坏。作为补偿，当前命中的整条消息带一层**持续的**
 *    淡底色（见 useFindAnchor 的 FIND_ACTIVE_CLASS）——比「闪一下」更有
 *    用，用户随时看得出自己停在哪条，而不是跳完一愣。
 *
 *    附带好处：剥 markdown 之后字符位置必然与渲染结果对不上（代码块、
 *    表格里更乱），只定位到消息让这种错位完全不可见。
 * 3. **不用 portal**。项目里 portal 出去的子树会脱离 `.chat-app` 豁免、
 *    被画布那套裸元素 reset 填成描边卡片（CLAUDE.md 记了三次事故）。
 *    直接挂在聊天列里就绕开了整类问题。
 */
export function FindBar(): React.JSX.Element | null {
  const open = useThreadFindStore((s) => s.open)
  const query = useThreadFindStore((s) => s.query)
  const current = useThreadFindStore((s) => s.current)
  const focusSeq = useThreadFindStore((s) => s.focusSeq)
  const setQuery = useThreadFindStore((s) => s.setQuery)
  const setCurrent = useThreadFindStore((s) => s.setCurrent)
  const closeFind = useThreadFindStore((s) => s.closeFind)
  const setActiveMessageIndex = useThreadFindStore((s) => s.setActiveMessageIndex)

  const messages = useChatStore((s) => s.messages)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const t = useT()
  const tf = useTFormat()

  // 命中列表是「消息 + 词」的纯派生值，不进 store（存进去流式追加时会立刻
  // 过期，见 stores/threadFind 头注释）。messages 在流式中每帧都换引用，
  // 所以 useMemo 的收益主要在「用户敲键但消息没动」的那一侧。
  const hits: FindHit[] = useMemo(
    () => findInMessages(messages as unknown as readonly TranscriptMessage[], query),
    [messages, query]
  )

  const jumpTo = useCallback(
    (hitIndex: number): void => {
      const hit = hits[hitIndex]
      if (!hit) return
      setCurrent(hitIndex)
      setActiveMessageIndex(hit.messageIndex)

      // 目标还没挂进 DOM 时先把历史窗口揭够。这里**绕开**了
      // EarlierMessagesGate 那套 ResizeObserver 滚动补偿——它是为「用户点
      // 按钮、视线要留在原地」设计的，而我们紧接着就要滚到别处去，补偿纯属
      // 白做（而且两套滚动会打架）。
      const steps = revealStepsNeeded(
        useChatStore.getState().historyWindowStart,
        hit.messageIndex,
        HISTORY_WINDOW_REVEAL_STEP
      )
      const reveal = useChatStore.getState().revealEarlierMessages
      for (let i = 0; i < steps; i++) reveal()

      // 揭开后那批消息要等 React 渲染完才有 DOM 节点。双 rAF：第一拍等
      // React 把这次 setState 刷进 DOM，第二拍等布局稳定（一次揭 80 条，
      // 单拍里 offsetTop 还在变，滚过去会偏）。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-find-index="${hit.messageIndex}"]`)
          // behavior 用瞬时而非 smooth：连按「下一个」时平滑滚动会排队，
          // 计数已经跳到第 5 条、画面还在往第 3 条爬。浏览器 ⌘F 也是瞬时跳。
          el?.scrollIntoView({ block: 'center' })
        })
      })
    },
    [hits, setCurrent, setActiveMessageIndex]
  )

  const step = useCallback(
    (dir: 1 | -1): void => {
      const next = stepHit(current, hits.length, dir)
      if (next < 0) return
      jumpTo(next)
    },
    [current, hits.length, jumpTo]
  )

  // 打开 / 再次按 ⌘F 时聚焦并全选。依赖 focusSeq 而不是 open：栏已经开着
  // 时 open 不变，effect 不会重跑，表现成「第二次按 ⌘F 没反应」。
  useEffect(() => {
    if (!open) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [open, focusSeq])

  // 边打边跳到第一个命中（⌘F 的既有行为，Chrome / Safari 都这样）。
  //
  // 不这么做的话：敲完词得再按一次回车才动，而计数已经先写着「1/2」了——
  // 用户会以为自己已经停在第 1 条上，其实画面还在原地（真机走查当场看到的
  // 就是这个错觉）。`current < 0` 的门控让它只在「刚打开 / 刚改词」时跳一次，
  // 之后用户自己上下翻不会被拽回第一条。
  useEffect(() => {
    if (!open || current >= 0 || hits.length === 0) return
    jumpTo(0)
  }, [open, current, hits, jumpTo])

  if (!open) return null

  const total = hits.length
  const hasQuery = query.trim().length > 0

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border/60 bg-card/80 px-3 py-1.5',
        'backdrop-blur-xl',
        // 顶部 46px 是全局窗口拖拽带（见 globals.css 的 .window-drag-strip）。
        // 本栏在顶栏之下、按说在带外，但顶栏高度一旦调整就会压进去——整条
        // 挖掉 no-drag 比事后排查「查找栏点不动」便宜。
        '[-webkit-app-region:no-drag]'
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('findPlaceholder')}
        // data-slot：逃开画布那套裸 input reset。本组件虽在 .chat-app 下
        // （reset 的 :where 豁免里有它），但多一道保险不花钱——这类样式
        // 泄漏坏起来是静默的。
        data-slot="find-input"
        className={cn(
          'min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none',
          'placeholder:text-muted-foreground/70'
        )}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // 必须拦住冒泡：ThinkingSpinner 在 window 上听 Esc 中断当前回合
            // （ThinkingSpinner.tsx 的 onKey）。焦点在查找框里时 Esc 该关
            // 查找栏，不该把正在生成的回复掐掉。焦点不在框里时这个 handler
            // 不跑，Esc 照旧中断——按焦点归属分，两边都对。
            e.preventDefault()
            e.stopPropagation()
            closeFind()
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
            return
          }
          // ↑↓ 也走上下跳转：手已经在键盘上时比够 Shift 顺。
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            step(1)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            step(-1)
          }
        }}
      />

      {/* 计数。按**消息条数**而不是出现次数——定位只到消息级，同一条里的
          第 2、3 次出现跳过去画面不会动（见 lib/threadFind 的 FindHit 注释）。
          空词时整个计数不显示，免得一打开就挂个刺眼的「0 条」。 */}
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
        {!hasQuery
          ? ''
          : total === 0
            ? t('findNoMatch')
            : // Math.max：自动跳那一拍生效前 current 还是 -1，显示「0/2」
              // 会闪一下。有命中时第一条就是 1，兜到 1 不会说谎。
              tf('findCount', { current: Math.max(1, current + 1), total })}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('findPrev')}
            disabled={total === 0}
            className={findBarButtonClass()}
            onClick={() => step(-1)}
          >
            <ChevronUp className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('findPrevHint')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('findNext')}
            disabled={total === 0}
            className={findBarButtonClass()}
            onClick={() => step(1)}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('findNextHint')}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('findClose')}
            className={findBarButtonClass()}
            onClick={closeFind}
          >
            <X className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('findCloseHint')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** 查找栏那三颗图标钮的外观。比消息动作栏的 size-7 小一档——这是一条
 *  28px 高的工具条，塞不下同尺寸的钮。 */
function findBarButtonClass(): string {
  return cn(
    'flex size-6 shrink-0 items-center justify-center rounded transition-colors',
    'text-muted-foreground hover:bg-hover hover:text-foreground',
    'disabled:pointer-events-none disabled:opacity-40'
  )
}
