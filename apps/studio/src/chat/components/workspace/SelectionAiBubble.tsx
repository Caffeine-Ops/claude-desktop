import { useEffect, useRef, useState } from 'react'
import { reviseProposalSectionBlocks } from '../../lib/sendProposalSectionRevision'
import { resolveRevisionTarget } from '../../lib/proposalRevisionGuards'
import { useProposalStore } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import type { ProposalKind } from '@desktop-shared/proposal'
import { ImagePlusIcon, UploadIcon, SpinnerIcon, AlertTriangleIcon } from './proposalIcons'
import { Tip } from './ProposalTooltip'

// 排队软上限（复审 L8：常量与提示文案共用同一个数，改一处即改两处，绝不自相矛盾）。
const MAX_REVISION_QUEUE = 10

// 选区即改浮层：监听编辑纸面内的选区，选中一段文字后贴选区尾浮出气泡。作用域=选区覆盖的
// 块区间（从选区两端向上找最近 data-block-index），替换单位是块（见 proposalBlocks.ts 理由）。
// 正文/封面/目录节的选区均生效（封面/目录也支持选区即改，溯源措辞在 dispatch 侧按节类型分叉）；
// 空选区 / disabled（生成中）不显；跨节选区吸附到起点所在节（见下方 recompute）。

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
  disabled,
  resolveSectionKind,
  onGenerateImage,
  onUploadImage,
  onOpenSettings
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  disabled: boolean
  // 选区所在节的 kind：仅正文节（content）才给「生成/上传图片」入口（docx 只给正文节嵌图，
  // 封面/目录插图导出不体现）。找不到返回 undefined，按非正文处理（不显图片入口）。
  resolveSectionKind: (sectionId: string) => ProposalKind | undefined
  // 生成/上传图片：均由父组件（ProposalPaper）落地。insertAfter=选区末块下标，图插到其后一位。
  // 返回 ok/error 供本组件展示错误（用户取消上传也算 ok=静默收起）。
  onGenerateImage: (
    sectionId: string,
    insertAfter: number,
    prompt: string
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  onUploadImage: (
    sectionId: string,
    insertAfter: number
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  // 「未配置出图 API」错误的「去设置」直达（原生设置页无常驻入口，见 ProposalImageToolbar 同名 prop）。
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [instruction, setInstruction] = useState('')
  // 图片子模式：'rewrite' 默认（AI 改写）；'genimage' 展开生图 prompt 输入。上传无 prompt，直接
  // 在 rewrite 模式下点按钮即弹原生对话框，不切模式。imgBusy/imgError 覆盖生成与上传两条路径。
  const [mode, setMode] = useState<'rewrite' | 'genimage'>('rewrite')
  const [imgPrompt, setImgPrompt] = useState('')
  const [imgBusy, setImgBusy] = useState(false)
  const [imgError, setImgError] = useState<string | null>(null)
  // 浮层根节点。用于：一旦焦点进入浮层（尤其是自定义指令输入框），忽略随之而来的 selectionchange，
  // 别把已捕获的 anchor 清掉——否则点输入框聚焦→正文选区塌陷→recompute 判空→气泡消失，字都没法敲。
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const imgInputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 生成中【不再】清 anchor / 停订阅：排队改写需要用户在 AI 忙时仍能选新段落。fire() 会按 disabled
    // 分流——忙时入队、闲时直发（见下）。原先这里清 anchor 是"忙时锁死"的成因，排队方案下移除。

    // 用 const 箭头函数而非函数声明：TS 对函数声明（因提升）不把外层 `container` 的
    // 非空窄化带入闭包，箭头函数表达式则可以（不存在提前调用的可能）——避免下面一堆 `container`
    // 误报「possibly null」。
    const recompute = (): void => {
      // 生成中【不再】清 anchor / 停订阅（同上）：忙时也照常拿新选区，fire() 分流入队。
      // 焦点已在浮层内（点了指令文本域、正在打字）：此时正文选区被浏览器塌陷是【预期】的，保持浮层不动。
      if (bubbleRef.current?.contains(document.activeElement)) return
      // 关键语义（用户要求）：浮层一旦弹出，只能靠「取消 / ×」显式关闭，点编辑框以外的地方【不关闭】。
      // 故下面所有「选区无效」的分支一律【保持现有 anchor 不动】(只 return，绝不 setAnchor(null))——
      // 点外面→选区塌陷时浮层原地留存。recompute 只负责【拿到有效新选区时更新/打开】浮层；关闭只经
      // close()（取消/×）或 fire() 收尾。生成中亦然（排队方案下不再有 disabled 早退）。
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

    // 滚动/选区变化都重算（滚动时选区不变但坐标要跟）。点进气泡自身不清（下方 mousedown 拦截）。
    document.addEventListener('selectionchange', recompute)
    container.addEventListener('scroll', recompute)
    return () => {
      document.removeEventListener('selectionchange', recompute)
      container.removeEventListener('scroll', recompute)
    }
  }, [containerRef, disabled])

  // 选区移到另一节：把图片子模式与其输入/错误复位（回到 AI 改写），避免上一节残留的生图态串台。
  // 不动 imgBusy——一次在飞的生成/上传不应被选区变化打断（且焦点守卫下选区通常不会在飞行中变）。
  useEffect(() => {
    setMode('rewrite')
    setImgPrompt('')
    setImgError(null)
  }, [anchor?.sectionId])

  // 进入 genimage 模式自动聚焦 prompt 文本域（塌陷的正文选区由焦点守卫兜住，anchor 不受影响）。
  useEffect(() => {
    if (mode === 'genimage') imgInputRef.current?.focus()
  }, [mode])

  if (!anchor) return null

  // 选区所在节是否正文节：决定是否给「生成/上传图片」入口。
  const isContent = resolveSectionKind(anchor.sectionId) === 'content'

  // 点快捷动作：只把中文指令模板填进输入框并聚焦（供用户再编辑），【不发起】。聚焦引发的正文
  // 选区塌陷由 recompute 的 bubbleRef 焦点守卫兜住，anchor 不受影响。发起统一走下方 fire()。
  function applyPreset(prefill: string): void {
    setInstruction(prefill)
    inputRef.current?.focus()
  }

  // 关闭浮层（标题栏 × / 底栏「取消」）：清指令、图片子模式态、收浮层、清正文选区。
  function close(): void {
    setInstruction('')
    setMode('rewrite')
    setImgPrompt('')
    setImgError(null)
    setImgBusy(false)
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  // 上传图片：捕获 sectionId/end（await 期间闭包安全），弹原生对话框→父组件插到选区之后。成功
  // /取消都收起浮层；仅真失败留错误。imgBusy 期间禁用重入。
  async function fireUpload(): Promise<void> {
    if (!anchor || imgBusy) return
    const { sectionId, end } = anchor
    setImgBusy(true)
    setImgError(null)
    const result = await onUploadImage(sectionId, end)
    setImgBusy(false)
    if (result.ok) close()
    else setImgError(result.message)
  }

  // 生成图片：同上，附 prompt。成功收起（审阅卡会在选区处出现并自动滚入视野）；失败留错误。
  async function fireGenerate(): Promise<void> {
    if (!anchor || imgBusy) return
    const text = imgPrompt.trim()
    if (!text) return
    const { sectionId, end } = anchor
    setImgBusy(true)
    setImgError(null)
    const result = await onGenerateImage(sectionId, end, text)
    setImgBusy(false)
    if (result.ok) close()
    else setImgError(result.message)
  }

  async function fire(): Promise<void> {
    if (!anchor) return
    const text = instruction.trim()
    if (!text) return
    // 路由用【现读的 streaming】而非渲染期的 disabled prop（复审 M6）：streaming 刚翻真、气泡还没
    // 重渲染那一帧点「开始改写」，若信旧 prop=false 会走直发→撞 dispatch 的 streaming 守卫静默 no-op、
    // 指令和选区凭空消失。现读关掉这个竞态窗口（getState 与 dispatch 内的读同步背靠背、中间无 await）。
    const ps = useProposalStore.getState()
    const sid = ps.sessionId
    const streamingNow = sid ? (useChatStore.getState().perSession[sid]?.streaming ?? false) : false
    if (streamingNow) {
      // 生成中：入队，等当前轮结束由 drainRevisionQueue 串行发起。软上限见 MAX_REVISION_QUEUE。
      if (ps.revisionQueue.length >= MAX_REVISION_QUEUE) {
        ps.setRevisionQueueNotice(`排队已满（上限 ${MAX_REVISION_QUEUE} 个），请等几个跑完再排`)
        return // 不入队、不清 anchor
      }
      ps.enqueueRevision({
        sectionId: anchor.sectionId,
        selectedText: anchor.selectedText,
        instruction: text,
        hintRange: { start: anchor.start, end: anchor.end }
      })
    } else {
      // 直发：用 resolveRevisionTarget 按【选中文字】在最新 markdown 里重定位（复审 H2：不再信可能
      // 已过期的 anchor 块序号——AI 若在这期间整节重写过，旧序号会指到别的段落），并顺带做审阅卡重叠
      // 拦截（护栏#4，与排队路径同一判定，复审 H1）。
      const sec = ps.sections.find((s) => s.id === anchor.sectionId)
      if (!sec) return
      const target = resolveRevisionTarget({
        markdown: sec.markdown,
        blockReviews: ps.blockReviews,
        sectionId: anchor.sectionId,
        selectedText: anchor.selectedText,
        hintRange: { start: anchor.start, end: anchor.end }
      })
      if (target.status === 'missing') {
        ps.setRevisionQueueNotice('选中的文字已变化，请重新选择这段再改')
        return // 不发起、不清 anchor
      }
      if (target.status === 'overlap') {
        ps.setRevisionQueueNotice('这段还有待确认的改写，请先「应用」或「放弃」它，再改这几段')
        return // 不发起、不清 anchor
      }
      await reviseProposalSectionBlocks(anchor.sectionId, target.range, text, anchor.selectedText)
    }
    // 发起/入队后收起浮层、清指令与选区。
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
          <span>{mode === 'genimage' ? '生成图片' : disabled ? 'AI 改写 · 排队中' : 'AI 改写'}</span>
        </div>
        <Tip label="关闭这个改写框">
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="关闭"
            onClick={close}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </Tip>
      </div>

      {/* 选中原文预览：最多 4 行，超出以 … 省略。无背景色，仅左 accent 竖线作引用感。
          刻意【不用】whitespace-pre-wrap——它与 -webkit-line-clamp(line-clamp-4 展开物) 在
          Chromium 下相冲，会让截断后的第 5 行漏出来；预览里原文换行折叠成空格无妨。 */}
      <div className="mt-2 text-[11px] text-muted-foreground">
        {mode === 'genimage' ? '插图将插入到选中段落之后' : '选中原文'}
      </div>
      <div className="mt-1 line-clamp-4 break-words border-l-2 border-accent pl-2 text-[12px] leading-[1.5] text-foreground">
        {anchor.selectedText}
      </div>

      {mode === 'rewrite' ? (
        <>
          {/* 快捷动作：点了只把指令模板填进下方文本域（不发起），可再编辑。 */}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <Tip key={q.label} label={`填入「${q.label}」指令，可再编辑后点「开始改写」`}>
                <button
                  type="button"
                  className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground hover:border-accent hover:text-accent"
                  onClick={() => applyPreset(q.prefill)}
                >
                  {q.label}
                </button>
              </Tip>
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
            <Tip label="取消，关闭这个改写框">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={close}
              >
                取消
              </button>
            </Tip>
            <Tip label={disabled ? 'AI 忙，先排队；轮到即改（快捷键 ⌘/Ctrl + 回车）' : '按指令改写选中内容（快捷键 ⌘/Ctrl + 回车）'}>
              <button
                type="button"
                className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-40"
                disabled={!instruction.trim()}
                onClick={() => void fire()}
              >
                <span className="text-[11px]">✦</span>
                {disabled ? '排队改写' : '开始改写'}
              </button>
            </Tip>
          </div>

          {/* 插入图片（仅正文节）：生成图片切到 genimage 子模式填 prompt；上传图片直接弹原生对话框。
              两者都插到「选中段落之后」。与 AI 改写共处一框——图片操作也需要一个「插到哪」的锚点，
              选中段落天然就是它。 */}
          {isContent && (
            <>
              <div className="my-2.5 h-px w-full bg-border" />
              {imgError && (
                <div className="mb-1.5 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-1 text-[11px] text-rose-600">
                  <AlertTriangleIcon className="mt-0.5 shrink-0" />
                  <span>
                    {imgError}
                    {imgError.includes('设置') && (
                      <Tip label="打开设置页，填写出图 API 配置">
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="ml-1 underline underline-offset-2 hover:text-rose-700"
                        >
                          去设置
                        </button>
                      </Tip>
                    )}
                  </span>
                </div>
              )}
              {imgBusy ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-[12px] text-muted-foreground">
                  <SpinnerIcon className="shrink-0 animate-spin text-accent" />
                  <span>正在打开上传…</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <div className="mr-auto text-[11px] text-muted-foreground">插入图片</div>
                  {/* 图片入口本次不排队：生成中禁用，避免用户误以为图片也会排队（改写才排队）。 */}
                  <Tip label="AI 按文字描述生成一张插图，插入选中段落之后（落地前可确认）">
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground"
                      disabled={disabled}
                      onClick={() => {
                        setImgError(null)
                        setMode('genimage')
                      }}
                    >
                      <ImagePlusIcon />
                      <span>生成图片</span>
                    </button>
                  </Tip>
                  <Tip label="上传本地图片，插入选中段落之后">
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground"
                      disabled={disabled}
                      onClick={() => void fireUpload()}
                    >
                      <UploadIcon />
                      <span>上传图片</span>
                    </button>
                  </Tip>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {/* genimage 子模式：生图 prompt 输入 + 转圈说明。⌘/Ctrl+↵ 发起。 */}
          {imgError && (
            <div className="mt-2 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-1 text-[11px] text-rose-600">
              <AlertTriangleIcon className="mt-0.5 shrink-0" />
              <span>
                {imgError}
                {imgError.includes('设置') && (
                  <Tip label="打开设置页，填写出图 API 配置">
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="ml-1 underline underline-offset-2 hover:text-rose-700"
                    >
                      去设置
                    </button>
                  </Tip>
                )}
              </span>
            </div>
          )}
          {imgBusy ? (
            <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-[12px] text-muted-foreground">
              <SpinnerIcon className="shrink-0 animate-spin text-accent" />
              <div className="leading-relaxed">
                <div className="font-medium text-foreground">AI 正在生成插图…</div>
                <div className="text-[11px] text-muted-foreground">通常十几秒到半分钟，请勿关闭</div>
              </div>
            </div>
          ) : (
            <textarea
              ref={imgInputRef}
              value={imgPrompt}
              onChange={(e) => setImgPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && imgPrompt.trim()) {
                  e.preventDefault()
                  void fireGenerate()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setMode('rewrite')
                  setImgPrompt('')
                  setImgError(null)
                }
              }}
              placeholder="描述想生成的插图，比如：一张展示产品架构的示意图"
              rows={3}
              className="mt-2.5 min-h-[68px] w-full resize-none rounded-lg border border-border bg-card px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-accent"
            />
          )}
          <div className="mt-2.5 flex items-center justify-between">
            <Tip label="返回 AI 改写">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                disabled={imgBusy}
                onClick={() => {
                  setMode('rewrite')
                  setImgPrompt('')
                  setImgError(null)
                }}
              >
                返回
              </button>
            </Tip>
            <Tip label="按描述生成插图（快捷键 ⌘/Ctrl + 回车）">
              <button
                type="button"
                className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-40"
                disabled={!imgPrompt.trim() || imgBusy}
                onClick={() => void fireGenerate()}
              >
                <ImagePlusIcon />
                生成图片
              </button>
            </Tip>
          </div>
        </>
      )}
    </div>
  )
}
