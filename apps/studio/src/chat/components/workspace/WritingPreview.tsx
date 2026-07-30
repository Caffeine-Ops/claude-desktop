import { useEffect, useRef, useState } from 'react'

import { joinWritingSections, shouldPageBreak } from '@desktop-shared/writing'
import { renderProposalPdfHtml } from '../../lib/renderProposalPdfHtml'
import { writingStyleFor } from '../../lib/writingGenreStyle'
import { useWritingStore } from '../../stores/writing'

/** 防抖窗口：节级更新是成簇到来的（一条消息 end 可能同时刷出多节），300ms 足以等一簇落定。 */
const DEBOUNCE_MS = 300

type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * 打印预览。两条分支：
 *  - 微信：main 生成内联 HTML，塞进 375px 手机宽容器。**与「复制公众号 HTML」是同一份字符串**，
 *    所见即所得。
 *  - 其余：走与导出 PDF 完全相同的引擎（renderProposalPdfHtml → renderProposalPdf →
 *    隐藏窗口 printToPDF），预览看的就是导出物本身，分页逐字节一致。
 *
 * 两个必守的点，都是 proposal 预览踩出来的（完整事故记录见 ProposalPreview.tsx 头注释）：
 *  1) **objectURL 原子替换 + cancelled 闸门**：一次渲染要过多个 await，期间可能被更新的一帧取代。
 *     只有过了最后一道 cancelled 检查才把新 URL 换进 iframe 并 revoke 旧的。
 *  2) **防抖期间保持上一帧**，不提前翻 loading——否则成簇更新时一直闪 spinner。
 */
export function WritingPreview({ active }: { active: boolean }): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [wechatHtml, setWechatHtml] = useState<string>('')
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const urlRef = useRef<string | null>(null)
  // 缓存键 = 体裁 + markdown。切走再切回（active 变化）不应触发重渲——只要内容没变就复用上一帧。
  const lastRendered = useRef<string | null>(null)

  function swapPdfUrl(next: string | null): void {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setPdfUrl(next)
  }

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  useEffect(() => {
    // 常驻但隐藏时不空跑：WritingDocPanel 用 hidden 类而非条件卸载挂载本组件（保住
    // lastRendered 缓存），但只有真正切到这个 tab 才该生成/渲染，否则文稿 tab 编辑期间
    // 这里也会每次 sections 变都白跑一遍 PDF/微信 HTML 生成。
    if (!active) return
    const markdown = joinWritingSections(sections, { pageBreaks: shouldPageBreak(genre) })
    if (!markdown) {
      lastRendered.current = null
      swapPdfUrl(null)
      setWechatHtml('')
      setStatus('empty')
      return
    }
    const signature = `${genre}:${markdown}`
    if (signature === lastRendered.current) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
        try {
          if (genre === 'wechat') {
            const r = await window.chatApi.writingWechatHtml({
              markdown,
              styleName: 'wechat-default'
            })
            if (cancelled) return
            if (!r.ok) throw new Error(r.error)
            setWechatHtml(r.html)
          } else {
            // renderProposalPdfHtml 的第三个参数（预渲的 mermaid 图）是给方案文档用的；
            // 写作体裁不支持 mermaid 代码块，显式传 undefined——它不是可选参数，漏传会挂在
            // typecheck 上（任务书原稿的调用少写了这个参数）。
            const html = await renderProposalPdfHtml(markdown, writingStyleFor(genre), undefined)
            if (cancelled) return
            const { bytes } = await window.chatApi.renderProposalPdf({ html })
            if (cancelled) return
            const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
            if (cancelled) return
            swapPdfUrl(URL.createObjectURL(blob))
          }
          lastRendered.current = signature
          setStatus('ready')
        } catch (err) {
          if (cancelled) return
          setErrMsg(err instanceof Error ? err.message : String(err))
          setStatus('error')
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sections, genre, active])

  return (
    <div className="relative flex-1 overflow-hidden">
      {genre === 'wechat' ? (
        <div className="h-full overflow-y-auto bg-neutral-100 py-6 dark:bg-neutral-900">
          <div
            className="mx-auto w-[375px] bg-white p-4 text-black shadow"
            // 内容由 main 从 markdown 生成、只输出白名单标签且正文已转义（见 writingWechat.ts）
            dangerouslySetInnerHTML={{ __html: wechatHtml }}
          />
        </div>
      ) : (
        pdfUrl && (
          <iframe key={pdfUrl} src={pdfUrl} title="文稿预览" className="h-full w-full border-0" />
        )
      )}

      {status === 'loading' && (
        <div className="absolute inset-0 grid place-items-center bg-neutral-200/80 dark:bg-neutral-900/80">
          <div className="flex flex-col items-center gap-3">
            <div className="size-6 animate-spin rounded-full border-[2.5px] border-border border-t-accent" />
            <div className="text-[12px] text-muted-foreground">正在生成预览…</div>
          </div>
        </div>
      )}
      {status === 'empty' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-[12.5px] text-muted-foreground">还没有正文可预览</div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex max-w-[80%] flex-col items-center gap-2 text-center">
            <div className="text-[13px] text-rose-500">预览生成失败</div>
            <div className="text-[11px] text-muted-foreground">{errMsg}</div>
          </div>
        </div>
      )}
    </div>
  )
}
