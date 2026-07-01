import { useEffect, useRef, useState } from 'react'
import { reviseProposalSectionBlocks } from '../../lib/sendProposalSectionRevision'

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

// 快捷动作只负责把【中文指令模板】填进输入框（用户可再改），真正发起改写永远走「改」按钮/回车。
// prefill 是给人看的自然语言指令（会原样拼进提示词），故写成完整、可直接发送的一句话。
const QUICK: Array<{ label: string; prefill: string }> = [
  { label: '润色', prefill: '请润色这段内容，提升表达的清晰度、流畅度和专业感。' },
  { label: '改写', prefill: '请改写这段内容，换一种更好的组织方式与措辞，让质量更高。' },
  { label: '扩写', prefill: '请扩写这段内容，补充必要的细节、数据或案例，但不要引入知识库之外的内容。' },
  { label: '精简', prefill: '请精简这段内容，删去冗余与重复，只保留要点。' },
  { label: '修复语法', prefill: '请修正这段内容里的语法、错别字与标点问题，保持原意与信息量不变。' },
  { label: '据来源修正', prefill: '请严格依据所引《来源》原文修正这段内容，凡无来源支撑的表述一律删除或改写。' }
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
  // 浮层根节点。用于：一旦焦点进入浮层（尤其是自定义指令输入框），忽略随之而来的 selectionchange，
  // 别把已捕获的 anchor 清掉——否则点输入框聚焦→正文选区塌陷→recompute 判空→气泡消失，字都没法敲。
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 生成中（disabled=generating）：立即收起已存在的气泡、且不订阅选区（review V1）。本 effect 的
    // deps 含 disabled，故 disabled 由 false→true 时会重跑到这里，当场清 anchor 让浮层消失——堵住
    // 「气泡在生成中途仍可见可点、fire() 覆盖在飞的单槽 pendingRevision」的竞态。disabled 回 false
    // 时 effect 再次重跑、恢复订阅。
    if (disabled) {
      setAnchor(null)
      return
    }

    // 用 const 箭头函数而非函数声明：TS 对函数声明（因提升）不把外层 `container` 的
    // 非空窄化带入闭包，箭头函数表达式则可以（不存在提前调用的可能）——避免下面一堆 `container`
    // 误报「possibly null」。
    const recompute = (): void => {
      if (disabled) {
        setAnchor(null)
        return
      }
      // 焦点已在浮层内（点了自定义指令输入框、正在打字）：此时正文选区被浏览器塌陷是【预期】的，
      // anchor 里已存好 sectionId/start/end/selectedText，保持浮层不动，不因这次塌陷把它清掉。
      if (bubbleRef.current?.contains(document.activeElement)) return
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

  // 点快捷动作：只把中文指令模板填进输入框并聚焦（供用户再编辑），【不发起】。聚焦引发的正文
  // 选区塌陷由 recompute 的 bubbleRef 焦点守卫兜住，anchor 不受影响。发起统一走下方 fire()。
  function applyPreset(prefill: string): void {
    setInstruction(prefill)
    inputRef.current?.focus()
  }

  // 关闭浮层（标题栏 × / 底栏「取消」）：清指令、收浮层、清正文选区。
  function close(): void {
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  async function fire(): Promise<void> {
    // 生成中一律不发（review V1 兜底）：disabled 翻真到浮层被上面的 effect 清掉之间有一帧窗口，
    // 此处再挡一次，绝不在别的修订在飞时发起。reviseProposalSectionBlocks 内部还会按 streaming 闸拒绝。
    if (!anchor || disabled) return
    const text = instruction.trim()
    if (!text) return
    await reviseProposalSectionBlocks(
      anchor.sectionId,
      { start: anchor.start, end: anchor.end },
      text,
      anchor.selectedText
    )
    // 发起后收起浮层、清指令与选区。
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={bubbleRef}
      className="proposal-anim-pop absolute z-40 w-80 rounded-xl border border-border bg-background p-3 text-foreground shadow-xl"
      style={{ left: anchor.left, top: anchor.top }}
      // 阻止 mousedown 清掉正文选区（否则点按钮前选区先没了、anchor 失据）——但【放行文本域/输入框】：
      // 对 textarea 若也 preventDefault 会连它的默认聚焦行为一起挡掉，光标进不去、根本没法打字。
      // 文本域聚焦引发的选区塌陷由上面 recompute 的 bubbleRef 焦点守卫兜住，anchor 不会被清。
      onMouseDown={(e) => {
        if (e.target instanceof HTMLElement && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT'))
          return
        e.preventDefault()
      }}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-[13px] font-medium">
          <span className="text-accent">✦</span>
          <span>AI 改写</span>
        </div>
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="关闭"
          onClick={close}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {/* 选中原文预览：最多 4 行，超出以 … 省略（line-clamp）。whitespace-pre-wrap 保留原文换行。 */}
      <div className="mt-2 text-[11px] text-muted-foreground">选中原文</div>
      <div className="mt-1 line-clamp-4 whitespace-pre-wrap break-words rounded-md border-l-2 border-accent bg-muted/40 px-2 py-1.5 text-[12px] leading-[1.4] text-foreground">
        {anchor.selectedText}
      </div>

      {/* 快捷动作：点了只把指令模板填进下方文本域（不发起），可再编辑。 */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground hover:border-accent hover:text-accent"
            onClick={() => applyPreset(q.prefill)}
            title={`填入「${q.label}」指令，可再编辑后点「开始改写」`}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* 指令文本域（放大成多行）。⌘/Ctrl+↵ 发起；单独回车换行。 */}
      <textarea
        ref={inputRef}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && instruction.trim()) {
            e.preventDefault()
            void fire()
          }
        }}
        placeholder="选一个动作填入指令，或直接写：怎么改这段…"
        rows={3}
        className="mt-2.5 min-h-[68px] w-full resize-none rounded-lg border border-border bg-card px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-accent"
      />

      {/* 底栏：取消 / 开始改写（仅此按钮或 ⌘↵ 才真正发起）。 */}
      <div className="mt-2.5 flex items-center justify-between">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={close}
        >
          取消
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-40"
          disabled={!instruction.trim()}
          onClick={() => void fire()}
          title="⌘/Ctrl + 回车"
        >
          <span className="text-[11px]">✦</span>
          开始改写
        </button>
      </div>
    </div>
  )
}
