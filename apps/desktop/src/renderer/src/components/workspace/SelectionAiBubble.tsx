import { useEffect, useRef, useState } from 'react'
import { reviseProposalSectionBlocks } from '../../lib/sendProposalSectionRevision'
import { useProposalStore } from '../../stores/proposal'
import { triggerProposalCitationVerification } from '../../runtime/FusionRuntimeProvider'
import { spliceBlocks } from '@shared/proposalBlocks'

// 选区即改浮层：监听编辑纸面内的选区，选中一段正文后贴选区尾浮出卡片。作用域=选区覆盖的块区间
// （从选区两端向上找最近 data-block-index），替换单位是块（见 proposalBlocks.ts 理由）。
//
// 三态卡片（由 store.editReview 与本地 anchor 共同驱动）：
//   1) 撰写态（anchor 有值）：选原文预览 + 快捷动作 + 指令文本域 + 「开始改写」。
//   2) 改写中态（editReview.status==='working'）：AI 在飞、转圈，卡片跨越「生成中」存活。
//   3) 待审阅态（editReview.status==='ready'）：展示【原文 vs 改写后】对照 + 「采用/放弃」——
//      用户点【采用】才 spliceBlocks 落地，点【放弃】丢弃。改动不即时生效，先审阅后落地。
// editReview 优先于 anchor 渲染：一旦进入改写/审阅，新的选区不再影响卡片（recompute 早退）。

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

// 快捷动作只负责把【中文指令模板】填进输入框（用户可再改），真正发起改写永远走「开始改写」/⌘↵。
// prefill 是给人看的自然语言指令（会原样拼进提示词），故写成完整、可直接发送的一句话。
const QUICK: Array<{ label: string; prefill: string }> = [
  { label: '润色', prefill: '请润色这段内容，提升表达的清晰度、流畅度和专业感。' },
  { label: '改写', prefill: '请改写这段内容，换一种更好的组织方式与措辞，让质量更高。' },
  { label: '扩写', prefill: '请扩写这段内容，补充必要的细节、数据或案例，但不要引入知识库之外的内容。' },
  { label: '精简', prefill: '请精简这段内容，删去冗余与重复，只保留要点。' },
  { label: '修复语法', prefill: '请修正这段内容里的语法、错别字与标点问题，保持原意与信息量不变。' },
  { label: '据来源修正', prefill: '请严格依据所引《来源》原文修正这段内容，凡无来源支撑的表述一律删除或改写。' }
]

const CloseIcon = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export function SelectionAiBubble({
  containerRef,
  disabled
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  disabled: boolean
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [instruction, setInstruction] = useState('')
  // 审阅提案（改写中/待审阅）来自 store，跨「生成中」存活；非空时优先于 anchor 渲染。
  const editReview = useProposalStore((s) => s.editReview)
  // 卡片根节点。用于：焦点进入卡片（指令文本域）时忽略随之而来的 selectionchange，别把 anchor 清掉。
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 生成中（disabled=generating）：立即收起【撰写态】卡片、且不订阅选区。改写中/审阅态卡片不受此
    // 影响（由 editReview 驱动、下面渲染分支优先）。disabled 回 false 时 effect 再次重跑、恢复订阅。
    if (disabled) {
      setAnchor(null)
      return
    }

    // 用 const 箭头函数而非函数声明：TS 对函数声明（因提升）不把外层 `container` 的非空窄化带入
    // 闭包，箭头函数表达式则可以——避免下面一堆 `container` 误报「possibly null」。
    const recompute = (): void => {
      if (disabled) {
        setAnchor(null)
        return
      }
      // 审阅流进行中（改写中/待审阅）：卡片由 editReview 接管，选区变化一律不再新建/更新 anchor，
      // 免得用户在审阅时随手划词又弹出撰写态。审阅结束（clearEditReview）后自然恢复。
      if (useProposalStore.getState().editReview) return
      // 焦点已在卡片内（点了指令文本域、正在打字）：正文选区被浏览器塌陷是【预期】的，保持卡片不动。
      if (bubbleRef.current?.contains(document.activeElement)) return
      // 关键语义（用户要求）：卡片一旦弹出，只能靠「取消 / ×」显式关闭，点编辑框以外的地方【不关闭】。
      // 故下面所有「选区无效」的分支一律【保持现有 anchor 不动】(只 return，绝不 setAnchor(null))。
      // recompute 只负责【拿到有效新选区时更新/打开】卡片；关闭只经 close()（取消/×）或 fire() 收尾。
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const text = sel.toString().trim()
      if (!text) return
      const range = sel.getRangeAt(0)
      // 选区必须落在本容器内（别被聊天区/其它面板的选区触发）。
      if (!container.contains(range.commonAncestorContainer)) return
      const a = resolveBlock(range.startContainer)
      const b = resolveBlock(range.endContainer)
      if (!a) return
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

    // 滚动/选区变化都重算（滚动时选区不变但坐标要跟）。点进卡片自身不清（下方 mousedown 拦截）。
    document.addEventListener('selectionchange', recompute)
    container.addEventListener('scroll', recompute)
    return () => {
      document.removeEventListener('selectionchange', recompute)
      container.removeEventListener('scroll', recompute)
    }
  }, [containerRef, disabled])

  // 点快捷动作：只把中文指令模板填进文本域并聚焦（供用户再编辑），【不发起】。聚焦引发的正文选区
  // 塌陷由 recompute 的 bubbleRef 焦点守卫兜住，anchor 不受影响。发起统一走 fire()。
  function applyPreset(prefill: string): void {
    setInstruction(prefill)
    inputRef.current?.focus()
  }

  // 关闭【撰写态】卡片（标题栏 × / 底栏「取消」）：清指令、收卡片、清正文选区。
  function close(): void {
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  async function fire(): Promise<void> {
    if (!anchor || disabled) return
    const text = instruction.trim()
    if (!text) return
    const a = anchor
    const cardAnchor = { left: a.left, top: a.top }
    // 先收撰写态（清指令/anchor/选区），再发起——reviseProposalSectionBlocks 内部会置 editReview
    // 为 'working'，卡片随即切到改写中态（由 editReview 驱动、跨生成存活）。
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
    await reviseProposalSectionBlocks(
      a.sectionId,
      { start: a.start, end: a.end },
      text,
      a.selectedText,
      cardAnchor
    )
  }

  // 采用改写：把 editReview.after 按 blockRange spliceBlocks 落回目标节（reviseSection 重置校验、
  // 更新 baseline、清 truncated），补触发引用落地校验，然后收起卡片。目标节若已不在则仅收起。
  function accept(): void {
    const st = useProposalStore.getState()
    const er = st.editReview
    if (!er || er.status !== 'ready' || er.after == null) return
    const target = st.sections.find((s) => s.id === er.sectionId)
    if (target) {
      const next = spliceBlocks(target.markdown, er.blockRange, er.after)
      st.reviseSection(er.sectionId, next)
      triggerProposalCitationVerification()
    }
    st.clearEditReview()
    window.getSelection()?.removeAllRanges()
  }

  // 放弃改写（审阅态「放弃」/×，或改写中「放弃」）：丢弃提案、原文不动。改写中放弃只收卡片，AI 若
  // 仍在飞，其产出到 end 时因 editReview 已空、setEditReviewResult no-op 而被丢弃（见 end 分流）。
  function discard(): void {
    useProposalStore.getState().clearEditReview()
    window.getSelection()?.removeAllRanges()
  }

  // ——渲染分支：editReview（改写中/待审阅）优先于撰写态 anchor。——

  if (editReview) {
    const er = editReview
    const ready = er.status === 'ready' && er.after != null
    return (
      <div
        ref={bubbleRef}
        className="proposal-anim-pop absolute z-40 w-80 rounded-xl border border-border bg-background p-3 text-foreground shadow-xl"
        style={{ left: er.anchor.left, top: er.anchor.top }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-[13px] font-medium">
            <span className="text-accent">✦</span>
            <span>{ready ? 'AI 改写完成' : 'AI 改写中'}</span>
          </div>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="放弃"
            onClick={discard}
          >
            <CloseIcon />
          </button>
        </div>

        {/* 原文（将被替换） */}
        <div className="mt-2 text-[11px] text-muted-foreground">原文</div>
        <div className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-[12px] leading-[1.5] text-muted-foreground">
          {er.before}
        </div>

        {ready ? (
          <>
            {/* 改写后 */}
            <div className="mt-2.5 text-[11px] font-medium text-accent">改写后</div>
            <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border-l-2 border-accent bg-accent/5 py-1 pl-2 pr-1 text-[12px] leading-[1.5] text-foreground">
              {er.after}
            </div>
            {/* 底栏：放弃 / 采用 */}
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={discard}
              >
                放弃
              </button>
              <button
                type="button"
                className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90"
                onClick={accept}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                采用
              </button>
            </div>
          </>
        ) : (
          // 改写中：转圈 + 放弃逃生口（AI 产出到 end 会因提案已空而被丢弃）。
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-muted border-t-accent" />
              正在改写选中内容…
            </div>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={discard}
            >
              放弃
            </button>
          </div>
        )}
      </div>
    )
  }

  if (!anchor) return null

  return (
    <div
      ref={bubbleRef}
      className="proposal-anim-pop absolute z-40 w-80 rounded-xl border border-border bg-background p-3 text-foreground shadow-xl"
      style={{ left: anchor.left, top: anchor.top }}
      // 阻止 mousedown 清掉正文选区（否则点按钮前选区先没了、anchor 失据）——但【放行文本域/输入框】：
      // 对 textarea 若也 preventDefault 会连它的默认聚焦行为一起挡掉，光标进不去、根本没法打字。
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
          <CloseIcon />
        </button>
      </div>

      {/* 选中原文预览：最多 4 行，超出以 … 省略。无背景色，仅左 accent 竖线作引用感。
          刻意【不用】whitespace-pre-wrap——它与 -webkit-line-clamp(line-clamp-4 展开物) 在
          Chromium 下相冲，会让截断后的第 5 行漏出来；预览里原文换行折叠成空格无妨。 */}
      <div className="mt-2 text-[11px] text-muted-foreground">选中原文</div>
      <div className="mt-1 line-clamp-4 break-words border-l-2 border-accent pl-2 text-[12px] leading-[1.5] text-foreground">
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

      {/* 指令文本域（多行）。⌘/Ctrl+↵ 发起；单独回车换行。 */}
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
