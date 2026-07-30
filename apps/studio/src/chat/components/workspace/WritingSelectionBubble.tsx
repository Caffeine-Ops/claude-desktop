import { useEffect, useRef, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { Textarea } from '@/src/components/ui/textarea'
import { MAX_WRITING_REVISION_QUEUE, useWritingStore } from '../../stores/writing'
import { resolveSelectionScope, type WritingBlockRef } from '../../lib/writingSelection'
import type { WritingRevisionTarget } from '../../lib/writingRevision'

interface Anchor {
  target: WritingRevisionTarget
  /** 相对滚动容器的定位（容器 relative + 自身滚动，与 proposal 的 SelectionAiBubble 同一套范式）。 */
  left: number
  top: number
}

/** 从选区端点向上找带 data-block-index 的块容器，读出「哪一节的第几块」。 */
function resolveBlock(node: Node | null): WritingBlockRef | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  const blk = el?.closest<HTMLElement>('[data-block-index]')
  if (!blk) return null
  const sectionName = blk.getAttribute('data-section-name')
  const idx = blk.getAttribute('data-block-index')
  if (sectionName == null || idx == null) return null
  return { sectionName, blockIndex: Number(idx) }
}

/**
 * 选区即改浮层。选中纸面上的文字后贴选区尾浮出，收一句指令发给 AI。
 *
 * **作用域是块，不是精确字符区间**：屏幕上选的是渲染后的纯文本，文件里是 markdown 源码
 * （含 `**加粗**`、列表符号），两者字符位置不对应，硬映射极易错位。选半句实际改整段，是刻意的。
 *
 * **跨节选区吸附到起点所在的那一节**：跨节改写要同时写两个文件、两把乐观锁，第一版不支持。
 * 判定本身是纯逻辑，抽在 `lib/writingSelection.ts` 并有测试覆盖。
 *
 * **浮层只能显式关闭**（取消 / 发起 / 换了个新选区），选区塌陷一律不关——这不是洁癖：
 * 点进下面的指令输入框会让浏览器把正文选区收掉，随之而来的 selectionchange 若按「选区没了
 * 就收浮层」处理，用户刚要打字浮层就消失，功能整个不可用（proposal 的 SelectionAiBubble
 * 踩过并留了同款守卫）。故下面所有「选区无效」分支都只 return，绝不 setAnchor(null)。
 */
export function WritingSelectionBubble({
  containerRef,
  busy,
  onSubmit
}: {
  containerRef: React.RefObject<HTMLElement | null>
  /** AI 忙 / 已有一条改写在飞：此时点「改写」是入队而非直发，按钮文案据此变。仅影响文案，
   *  真正的路由在 WritingDocPanel 的 submitRevision 里现读 store 决定（避免渲染期快照过期）。 */
  busy: boolean
  onSubmit: (target: WritingRevisionTarget, instruction: string) => void
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [text, setText] = useState('')
  const queueLen = useWritingStore((s) => s.queue.length)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    function recompute(): void {
      // 焦点已在浮层内（正在指令框里打字）：正文选区被浏览器塌陷是预期的，保持浮层不动。
      if (bubbleRef.current?.contains(document.activeElement)) return
      const sel = window.getSelection()
      const container = containerRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) return
      const selectedText = sel.toString().trim()
      if (!selectedText) return
      const range = sel.getRangeAt(0)
      // 选区必须落在纸面容器内，别被聊天区 / 别的面板的选区触发。
      if (!container.contains(range.commonAncestorContainer)) return
      const scope = resolveSelectionScope(
        resolveBlock(range.startContainer),
        resolveBlock(range.endContainer)
      )
      if (!scope) return
      const rect = range.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      setAnchor({
        target: { sectionName: scope.sectionName, range: scope.range, selectedText },
        // 加上容器自身的滚动量：absolute 子节点的包含块是容器的 padding box，它随内容一起滚，
        // 故坐标要写成「内容坐标系」的值，滚动时浮层自然跟着走、无需在 scroll 上重算。
        left: rect.left - box.left + container.scrollLeft,
        top: rect.bottom - box.top + container.scrollTop + 6
      })
    }
    document.addEventListener('selectionchange', recompute)
    return () => document.removeEventListener('selectionchange', recompute)
  }, [containerRef])

  if (!anchor) return null

  const full = queueLen >= MAX_WRITING_REVISION_QUEUE

  function close(): void {
    setText('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  function fire(): void {
    if (!anchor || full) return
    const instruction = text.trim()
    if (!instruction) return
    onSubmit(anchor.target, instruction)
    close()
  }

  return (
    <div
      ref={bubbleRef}
      className="absolute z-20 w-[300px] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-lg"
      style={{ left: anchor.left, top: anchor.top }}
      // 阻止 mousedown 清掉正文选区（否则点按钮前选区先没了、anchor 失据），但放行文本域
      // ——对 textarea 也 preventDefault 会连默认聚焦一起挡掉，光标进不去、根本没法打字。
      onMouseDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.tagName === 'TEXTAREA') return
        e.preventDefault()
      }}
    >
      <div className="mb-1.5 text-[11px] text-muted-foreground">选中原文</div>
      {/* 不用 whitespace-pre-wrap：它与 line-clamp 在 Chromium 下相冲，截断后会漏出多余一行。 */}
      <div className="mb-2 line-clamp-3 break-words border-l-2 border-accent pl-2 text-[12px] leading-[1.5]">
        {anchor.target.selectedText}
      </div>
      <Textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            fire()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        placeholder="想怎么改？例如：改口语一点"
        className="min-h-[60px] text-[13px]"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {full
            ? `排队已满（${MAX_WRITING_REVISION_QUEUE}）`
            : queueLen > 0
              ? `${queueLen} 条排队中`
              : ''}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!text.trim() || full}
            onClick={fire}
            title={busy ? 'AI 正忙，这条会排队等它写完' : '⌘/Ctrl + 回车'}
          >
            {busy ? '排队改写' : '改写'}
          </Button>
        </div>
      </div>
    </div>
  )
}
