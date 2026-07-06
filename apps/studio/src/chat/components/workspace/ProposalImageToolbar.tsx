import { useEffect, useRef, useState } from 'react'
import { PencilIcon, ImageIcon, TrashIcon, CheckIcon, XIcon, AlertTriangleIcon, SpinnerIcon } from './proposalIcons'

// 点图浮动工具栏（Task 9）：编辑态点中一张图后，在其右上角浮出 [改图][换图][删除]。定位靠
// ProposalPaper 算好的 left/top（与 SelectionAiBubble 同一套「容器相对坐标」范式），本组件
// 只负责渲染与自身内部状态（改图指令输入 / loading / error），不碰选区、不碰 store——落地动作
// 全经 props 回调交给 ProposalPaper（它持有 sections/sessionId/addImageReview）。
//
// data-image-toolbar：供 ProposalPaper 的「点击别处关闭」判断排除自身（同 SelectionAiBubble
// 用 bubbleRef.contains 的思路，这里改用 data 属性——本组件不需要向上暴露 DOM ref）。

export interface ProposalImageToolbarProps {
  // 容器相对坐标：右上角锚点。样式用 translate(-100%) 把浮层右边对齐到 anchorLeft，
  // 故调用方不必预知浮层自身宽度（同 SelectionAiBubble 的定位取舍）。
  anchorLeft: number
  anchorTop: number
  // 生成中（AI 正在流式产出）禁用一切操作——与块编辑/选区改写同一条「生成中冻结手改」纪律。
  disabled: boolean
  onEdit: (prompt: string) => Promise<{ ok: true } | { ok: false; message: string }>
  // 换图（Task 10 已接通）：点击弹原生文件选择框，选中后用新图替换这张。null 仅在「正弹着
  // 选择框」的短暂窗口内传入（父组件用它防重入双击），不再是「功能未落地」的永久占位——
  // 故下方按钮的禁用提示文案也相应改为「处理中」而非「即将支持」。
  onReplace: (() => void) | null
  onDelete: () => void
  onClose: () => void
  // 「未配置出图 API」类错误的「去设置」直达入口。为什么必须有：右上角齿轮打开的是 Open
  // Design 的 web 设置弹窗，承载出图 API 表单的原生设置页没有常驻入口（GUI 走查发现），
  // 错误提示里的这个按钮就是用户唯一能走到的路。可选：不传则错误只展示文字。
  onOpenSettings?: () => void
}

export function ProposalImageToolbar({
  anchorLeft,
  anchorTop,
  disabled,
  onEdit,
  onReplace,
  onDelete,
  onClose,
  onOpenSettings
}: ProposalImageToolbarProps): React.JSX.Element {
  // mode: 'buttons' 三键常态；'editing' 展开改图指令输入框。
  const [mode, setMode] = useState<'buttons' | 'editing'>('buttons')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (mode === 'editing') inputRef.current?.focus()
  }, [mode])

  // 生成中途被上层冻结（disabled 由 false→true）：收起展开态，避免用户对着一个提交了也会被
  // 内部守卫拒绝的输入框发呆（与 SelectionAiBubble 的同款处理一致）。
  useEffect(() => {
    if (disabled) {
      setMode('buttons')
      setError(null)
    }
  }, [disabled])

  async function submit(): Promise<void> {
    const text = prompt.trim()
    if (!text || loading) return
    setLoading(true)
    setError(null)
    const result = await onEdit(text)
    setLoading(false)
    if (result.ok) {
      // 成功：交给 Task 11 的审阅卡去呈现「原图 vs 新图」，工具栏本身收起。
      setPrompt('')
      setMode('buttons')
      onClose()
    } else {
      setError(result.message)
    }
  }

  const iconBtn =
    'grid size-7 place-items-center rounded-md border border-border bg-card text-[13px] text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-30 disabled:hover:border-border disabled:hover:text-muted-foreground'

  return (
    <div
      data-image-toolbar
      className="proposal-anim-pop absolute z-40 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
      style={{ left: anchorLeft, top: anchorTop, transform: 'translate(-100%, 0)' }}
      // 与 SelectionAiBubble 同款取舍：mousedown 默认 preventDefault 防止点按钮前正文选区/
      // 图片选中态被意外打断，但放行 textarea 自身的聚焦，否则光标进不去打不了字。
      onMouseDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.tagName === 'TEXTAREA') return
        e.preventDefault()
      }}
    >
      {mode === 'buttons' ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={iconBtn}
            disabled={disabled}
            title="改图（AI 按指令改这张图）"
            aria-label="改图"
            onClick={() => setMode('editing')}
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            className={iconBtn}
            disabled={disabled || !onReplace}
            title={onReplace ? '换图' : '换图·处理中'}
            aria-label="换图"
            onClick={() => onReplace?.()}
          >
            <ImageIcon />
          </button>
          <button
            type="button"
            className={
              'grid size-7 place-items-center rounded-md border border-border bg-card text-[13px] text-rose-500 hover:border-rose-400 disabled:opacity-30'
            }
            disabled={disabled}
            title="删除这张图"
            aria-label="删除"
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
          <button
            type="button"
            className={iconBtn}
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>
      ) : (
        <div className="w-72 p-1">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-foreground">改图指令</span>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="取消"
              aria-label="取消"
              disabled={loading}
              onClick={() => {
                setMode('buttons')
                setError(null)
              }}
            >
              <XIcon />
            </button>
          </div>
          {/* 改图是秒级到数十秒的网络往返，纯按钮文字变「改图中…」反馈太弱（GUI 走查：等太久
              不知在不在动）。loading 时用转圈 + 说明文字的独立块替换输入区，明确「在处理、别关」。 */}
          {loading && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[12px] text-foreground">
              <SpinnerIcon className="shrink-0 animate-spin text-accent" />
              <div className="leading-relaxed">
                <div className="font-medium text-foreground">AI 正在改这张图…</div>
                <div className="text-[11px] text-muted-foreground">通常十几秒到半分钟，请勿关闭</div>
              </div>
            </div>
          )}
          {!loading && (
          <>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) {
                e.preventDefault()
                void submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setMode('buttons')
                setError(null)
              }
            }}
            placeholder="怎么改这张图，比如：把背景换成白色"
            rows={2}
            disabled={loading}
            className="mt-1.5 w-full resize-none rounded-md border border-border bg-card px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus:border-accent disabled:opacity-60"
          />
          {error && (
            <div className="mt-1.5 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-1 text-[11px] text-rose-600">
              <AlertTriangleIcon className="mt-0.5 shrink-0" />
              <span>
                {error}
                {onOpenSettings && error.includes('设置') && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="ml-1 underline underline-offset-2 hover:text-rose-700"
                  >
                    去设置
                  </button>
                )}
              </span>
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setMode('buttons')
                setError(null)
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-[12px] font-medium text-background hover:opacity-90 disabled:opacity-40"
              disabled={!prompt.trim()}
              onClick={() => void submit()}
              title="⌘/Ctrl + 回车"
            >
              <CheckIcon />
              <span>提交</span>
            </button>
          </div>
          </>
          )}
        </div>
      )}
    </div>
  )
}
