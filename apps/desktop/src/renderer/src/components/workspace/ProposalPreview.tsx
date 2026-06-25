import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { useProposalStore } from '../../stores/proposal'

/**
 * 预览态：把当前草稿拼成 markdown → 走与「导出 Word」完全相同的引擎
 * (renderProposal IPC → markdownToDocxBuffer) 生成真 .docx → docx-preview
 * 渲染成一页页 A4（真分页）。故预览分页 = 导出成品逐像素一致。
 *
 * 渲染异步：生成 + 渲染期间显示 spinner；失败显示错误态可重试；空草稿显示空态。
 * lastRendered 缓存上次成功渲染的 markdown，未变则跳过重渲（来回切 tab 不重复生成）。
 * effect 只依赖 [sections, nonce]——nonce 仅由「重试」自增，避免把 status 放进依赖
 * 造成的重渲循环。
 */
type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export function ProposalPreview(): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const lastRendered = useRef<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const markdown = sections.map((s) => s.markdown).join('\n\n').trim()
    if (!markdown) {
      lastRendered.current = null
      if (hostRef.current) hostRef.current.innerHTML = ''
      setStatus('empty')
      return
    }
    if (markdown === lastRendered.current) return // 该内容已渲染，跳过

    let cancelled = false
    setStatus('loading')
    // 提前清空 host：避免被取代的渲染在 renderAsync 中途被 cancelled 后，status 卡在 loading 而 host 残留半渲染态
    if (hostRef.current) hostRef.current.innerHTML = ''
    void (async () => {
      try {
        const { bytes } = await window.chatApi.renderProposal({ markdown })
        if (cancelled) return
        const host = hostRef.current
        if (!host) return
        // Wrap in a fresh Uint8Array backed by a concrete ArrayBuffer so TypeScript's
        // BlobPart constraint is satisfied — IPC returns Uint8Array<ArrayBufferLike>
        // which TS strict-lib rejects directly as a BlobPart.
        const blob = new Blob([new Uint8Array(bytes)], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        })
        // inWrapper + breakPages：得到带页间留白、阴影、真分页的 A4 页面。
        // 样式注入限定在 host 容器内（renderAsync 第 2 参即挂载容器），卸载/重渲前
        // 清空 innerHTML，避免污染应用其它部分。
        await renderAsync(blob, host, undefined, {
          inWrapper: true,
          breakPages: true,
          ignoreWidth: false,
          ignoreHeight: false,
          className: 'docx'
        })
        if (cancelled) return
        lastRendered.current = markdown
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setErrMsg(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sections, nonce])

  return (
    <div className="relative flex-1 overflow-hidden">
      <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white backdrop-blur">
        ▤ 真预览 · 与最终导出的 Word 逐像素一致
      </div>
      <div className="h-full overflow-auto bg-neutral-200 py-8 dark:bg-neutral-900">
        <div ref={hostRef} className="proposal-docx-host" />
      </div>

      {status === 'loading' && (
        <div className="absolute inset-0 grid place-items-center bg-neutral-200/80 dark:bg-neutral-900/80">
          <div className="flex flex-col items-center gap-3">
            <div className="size-6 animate-spin rounded-full border-[2.5px] border-border border-t-accent" />
            <div className="text-[12px] text-muted-foreground">正在生成 .docx 并渲染分页…</div>
          </div>
        </div>
      )}
      {status === 'empty' && (
        <div className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
          草稿为空，无可预览内容
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex max-w-[80%] flex-col items-center gap-3 text-center">
            <div className="text-[13px] text-rose-500">预览生成失败</div>
            <div className="text-[11px] text-muted-foreground">{errMsg}</div>
            <button
              className="rounded border border-border px-3 py-1 text-[12px] hover:border-accent"
              onClick={() => {
                lastRendered.current = null
                setNonce((n) => n + 1)
              }}
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
