import { useEffect, useRef, useState } from 'react'
import type { ImageReview } from '../../stores/proposal'
import { toKbAssetUrl } from '../../lib/kbAssetUrl'
import { toProposalAssetUrl } from '../../lib/proposalAssetUrl'
import { CheckIcon, TrashIcon, PencilIcon, XIcon, AlertTriangleIcon, SpinnerIcon } from './proposalIcons'

// 改图/生图「先审后落地」对照卡（Task 11）。挂在 ProposalPaper 里对应节的正文之后（就地内联，
// 非浮层——图片改写不像选区改写/点图工具栏那样有一个天然的锚点坐标，且审阅项可能在用户滚动
// 走之后仍需要留在原处等待处理，浮层会跟丢；内联卡片跟着节走，随文档流滚动，符合直觉）。
//
// 本组件是纯展示 + 回调，不碰 store/IPC——落地（应用/放弃）与重新调用 IPC（重改）全由
// ProposalPaper 处理，这里只负责渲染 review 快照与转发用户操作。
//
// src 解析链与 AssistantMarkdown 一致：先试 kbasset://（知识库镜像图），未命中再试
// proposalasset://（草稿产出图/上传图）——两者是互斥的路径特征判定，链式尝试不会误判。
function resolveImageSrc(src: string): string {
  const kbUrl = toKbAssetUrl(src)
  if (kbUrl !== src) return kbUrl
  return toProposalAssetUrl(src)
}

export interface ProposalImageReviewProps {
  review: ImageReview
  onApply: () => void
  onDiscard: () => void
  onRetry: (prompt: string) => void
  // 重改/应用的 IPC 往返期间为 true：三个按钮一律禁用，避免用户在网络请求飞行中重复点击
  // （如应用中途又点重改，或重改两次并发）。
  busy?: boolean
  // 重改失败时的错误信息（未配置 key / 网关异常，同 ProposalImageToolbar 的分流措辞），
  // 由 ProposalPaper 在 onRetry 的 IPC 调用失败后回填；本组件只负责展示，不解析错误原因。
  error?: string | null
  // 「未配置出图 API」类错误的「去设置」直达入口（原生设置页无常驻入口，见
  // ProposalImageToolbar 同名 prop 的注释）。可选：不传则错误只展示文字。
  onOpenSettings?: () => void
}

export function ProposalImageReview({
  review,
  onApply,
  onDiscard,
  onRetry,
  busy = false,
  error = null,
  onOpenSettings
}: ProposalImageReviewProps): React.JSX.Element {
  // 重改展开态：点「重改」后内联展开一个小文本域，⌘/Ctrl+↵ 或点提交都走 onRetry。
  const [retrying, setRetrying] = useState(false)
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (retrying) inputRef.current?.focus()
  }, [retrying])

  // busy 由 false→true（重改请求已发出）：折起输入框，回到「处理中」的按钮态展示，避免用户
  // 对着一个提交了也不会再生效的输入框发呆（同 ProposalImageToolbar/SelectionAiBubble 的纪律）。
  useEffect(() => {
    if (busy) setRetrying(false)
  }, [busy])

  function submitRetry(): void {
    const text = prompt.trim()
    if (!text || busy) return
    onRetry(text)
    setPrompt('')
  }

  const title = review.mode === 'edit' ? '改图预览' : '生成预览'

  return (
    <div className="proposal-anim-pop mb-3 rounded-lg border border-neutral-300 bg-neutral-50 p-2.5">
      {/* 标题栏：× 语义等同「放弃」——审阅卡本就是一次性的临时提议，关闭=不采纳。 */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-neutral-700">{title}</span>
        <button
          type="button"
          className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40"
          title="放弃"
          aria-label="放弃"
          disabled={busy}
          onClick={onDiscard}
        >
          <XIcon />
        </button>
      </div>

      {/* 预览区：edit 模式原图/改后图并排对照；generate/directive 模式只有新图，落位提示按
          mode 说实话（评审 #10）——generate 由 applyImageReview 插到发起时选中段落之后（越界
          才退化节末），directive 原地替换文档中的指令块，都不是「本节末尾」。 */}
      {review.mode === 'edit' ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 text-[11px] text-neutral-500">原图</div>
            <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
              {review.sourcePath ? (
                <img
                  src={resolveImageSrc(review.sourcePath)}
                  alt="原图"
                  className="block h-auto w-full object-contain"
                />
              ) : (
                <div className="flex h-24 items-center justify-center text-[11px] text-neutral-400">
                  无原图
                </div>
              )}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-neutral-500">改后图</div>
            <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
              <img
                src={resolveImageSrc(review.resultPath)}
                alt="改后图"
                className="block h-auto w-full object-contain"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
            <img
              src={resolveImageSrc(review.resultPath)}
              alt="生成图"
              className="block h-auto max-h-72 w-full object-contain"
            />
          </div>
          <div className="mt-1 text-[11px] text-neutral-500">
            {review.mode === 'directive'
              ? '应用后将原地替换文档中的配图指令块'
              : '应用后插入到所选段落之后'}
          </div>
        </div>
      )}

      {/* 重改（retry）飞行中：改图/生图同样是数十秒往返，给转圈 + 说明，别让用户对着静止的
          「处理中…」按钮猜是否在动。busy 也可能来自「应用」——措辞用中性的「处理中」。 */}
      {busy && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-[12px] text-neutral-600">
          <SpinnerIcon className="shrink-0 animate-spin text-accent" />
          <div className="leading-relaxed">
            <div className="font-medium text-neutral-700">
              {review.mode === 'edit' ? 'AI 正在重新改图…' : 'AI 正在重新生成…'}
            </div>
            <div className="text-[11px] text-neutral-400">通常十几秒到半分钟，请勿关闭</div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-1 text-[11px] text-rose-600">
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

      {retrying ? (
        <div className="mt-2">
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) {
                e.preventDefault()
                submitRetry()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setRetrying(false)
                setPrompt('')
              }
            }}
            placeholder={review.mode === 'edit' ? '怎么改这张图，比如：把背景换成白色' : '重新描述想生成的插图'}
            rows={2}
            disabled={busy}
            className="w-full resize-none rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] leading-relaxed text-neutral-800 outline-none focus:border-accent disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              disabled={busy}
              onClick={() => {
                setRetrying(false)
                setPrompt('')
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md bg-neutral-900 px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              disabled={!prompt.trim() || busy}
              onClick={submitRetry}
              title="⌘/Ctrl + 回车"
            >
              {busy ? <span>处理中…</span> : <span>提交</span>}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center justify-end gap-1.5">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[12px] text-neutral-600 hover:border-rose-400 hover:text-rose-500 disabled:opacity-40"
            disabled={busy}
            onClick={onDiscard}
            title="放弃这次结果"
          >
            <TrashIcon />
            <span>放弃</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[12px] text-neutral-600 hover:border-accent hover:text-accent disabled:opacity-40"
            disabled={busy}
            onClick={() => setRetrying(true)}
            title="重新描述指令再来一次"
          >
            <PencilIcon />
            <span>重改</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md bg-neutral-900 px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            disabled={busy}
            onClick={onApply}
            title="采纳这次结果，写入正文"
          >
            {busy ? (
              <span>处理中…</span>
            ) : (
              <>
                <CheckIcon />
                <span>应用</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
