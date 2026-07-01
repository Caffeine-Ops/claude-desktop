import { useEffect, useState } from 'react'
import { reviseProposalSectionBlocks, type BlockReviseAction } from '../../lib/sendProposalSectionRevision'

// 选区即改浮层：监听编辑纸面内的选区，选中一段正文文字后贴选区尾浮出气泡。作用域=选区覆盖的
// 块区间（从选区两端向上找最近 data-block-index），替换单位是块（见 proposalBlocks.ts 理由）。
// 只对同一节 content 内的选区生效；跨节 / 封面目录 / 空选区 / disabled（生成中）一律不显。

interface Anchor {
  sectionId: string
  start: number
  end: number
  selectedText: string
  // 相对滚动容器的定位（容器为 relative）。
  left: number
  top: number
}

// 从选区端点节点向上找最近带 data-block-index 的块容器，读出 sectionId + blockIndex。
function resolveBlock(node: Node | null): { sectionId: string; blockIndex: number } | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  const blk = el?.closest<HTMLElement>('[data-block-index]')
  if (!blk) return null
  const sectionId = blk.getAttribute('data-section-id')
  const idx = blk.getAttribute('data-block-index')
  if (sectionId == null || idx == null) return null
  return { sectionId, blockIndex: Number(idx) }
}

const QUICK: Array<{ action: Exclude<BlockReviseAction, 'custom'>; label: string }> = [
  { action: 'polish', label: '润色' },
  { action: 'shorten', label: '精简' },
  { action: 'expand', label: '扩写' },
  { action: 'rewrite', label: '改写' },
  { action: 'fixSource', label: '据来源修正' }
]

export function SelectionAiBubble({
  containerRef,
  disabled
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  disabled: boolean
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [instruction, setInstruction] = useState('')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 用 const 箭头函数而非函数声明：TS 对函数声明（因提升）不把外层 `container` 的
    // 非空窄化带入闭包，箭头函数表达式则可以（不存在提前调用的可能）——避免下面一堆 `container`
    // 误报「possibly null」。
    const recompute = (): void => {
      if (disabled) {
        setAnchor(null)
        return
      }
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setAnchor(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setAnchor(null)
        return
      }
      const range = sel.getRangeAt(0)
      // 选区必须落在本容器内（别被聊天区/其它面板的选区触发）。
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null)
        return
      }
      const a = resolveBlock(range.startContainer)
      const b = resolveBlock(range.endContainer)
      if (!a) {
        setAnchor(null)
        return
      }
      // 跨节选区：吸附到起点所在节，end 夹到该节内（b 若在别节则退化为单块起点）。
      const sameSection = b && b.sectionId === a.sectionId
      const start = Math.min(a.blockIndex, sameSection ? b.blockIndex : a.blockIndex)
      const end = Math.max(a.blockIndex, sameSection ? b.blockIndex : a.blockIndex)
      // 定位：选区包围盒尾部，换算成容器相对坐标（容器 relative + 自身滚动）。
      const rect = range.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      setAnchor({
        sectionId: a.sectionId,
        start,
        end,
        selectedText: text,
        left: rect.left - cRect.left + container.scrollLeft,
        top: rect.bottom - cRect.top + container.scrollTop + 6
      })
    }

    // 滚动/选区变化都重算（滚动时选区不变但坐标要跟）。点进气泡自身不清（下方 mousedown 拦截）。
    document.addEventListener('selectionchange', recompute)
    container.addEventListener('scroll', recompute)
    return () => {
      document.removeEventListener('selectionchange', recompute)
      container.removeEventListener('scroll', recompute)
    }
  }, [containerRef, disabled])

  if (!anchor) return null

  async function fire(action: BlockReviseAction): Promise<void> {
    if (!anchor) return
    await reviseProposalSectionBlocks(
      anchor.sectionId,
      { start: anchor.start, end: anchor.end },
      action,
      anchor.selectedText,
      action === 'custom' ? instruction : undefined
    )
    // 发起后收起浮层、清指令与选区。
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      className="proposal-anim-pop absolute z-40 w-72 rounded-lg border border-border bg-background p-1.5 text-foreground shadow-lg"
      style={{ left: anchor.left, top: anchor.top }}
      // 阻止 mousedown 清掉选区（否则点按钮前选区先没了）。
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1 text-accent">
        <span className="px-1 text-[12px]">✦</span>
        {QUICK.map((q) => (
          <button
            key={q.action}
            type="button"
            className="rounded px-1.5 py-0.5 text-[12px] text-foreground hover:bg-muted"
            onClick={() => void fire(q.action)}
            title={`让 AI ${q.label}选中的这段`}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && instruction.trim()) {
              e.preventDefault()
              void fire('custom')
            }
          }}
          placeholder="告诉 AI 怎么改这段…"
          className="h-7 flex-1 rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-accent"
        />
        <button
          type="button"
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
          disabled={!instruction.trim()}
          onClick={() => void fire('custom')}
        >
          改
        </button>
      </div>
    </div>
  )
}
