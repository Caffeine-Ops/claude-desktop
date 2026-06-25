import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { useProposalStore } from '../../stores/proposal'
import { buildProposalMarkdown } from '@shared/proposal'

/**
 * 预览态：把当前草稿拼成 markdown → 走与「导出 Word」完全相同的引擎
 * (renderProposal IPC → markdownToDocxBuffer) 生成真 .docx → docx-preview
 * 渲染成一页页 A4（真分页）。故预览分页 = 导出成品逐像素一致。
 *
 * 渲染异步：生成 + 渲染期间显示 spinner；失败显示错误态可重试；空草稿显示空态。
 * lastRendered 缓存上次成功渲染的 markdown，未变则跳过重渲（来回切 tab 不重复生成）。
 * effect 只依赖 [sections, nonce]——nonce 仅由「重试」自增，避免把 status 放进依赖
 * 造成的重渲循环。
 *
 * 并发与防抖（两个曾经的真 bug，务必一起看）：
 *  1) 离屏渲染 + 原子替换：docx-preview 的 renderAsync 内部会 `host.innerHTML=''`
 *     后追加、且一旦开始不可中断。若直接渲染进 host，一个已被取代（cancelled）的旧
 *     渲染只要比新渲染晚完成，就会把旧内容刷回 host——而 cancelled 检查只在 await
 *     之后才生效、拦不住 renderAsync 内部那次 DOM 改写。于是 host 显示旧页、
 *     lastRendered/status 却记成最新，guard 从此跳过重渲，预览永久卡在旧页。修法：
 *     渲染进一个「离屏」detached <div>，渲染完、过了 cancelled 闸门之后才整体搬进
 *     host。旧渲染永远碰不到 host。（docx-preview 的分页是按 XML 结构切的、不量 DOM，
 *     故离屏渲染与挂在 host 渲染逐像素等价。）
 *  2) 防抖：sections 并非逐 token 变——它只在每条 assistant 消息的 'end' 整批更新
 *     （appendSections，一次可加该消息的多个哨兵块），加上「逐部分推进」时多条消息会
 *     接连 end、以及编辑态 textarea 改字（updateSection 每次按键）。这些更新可能成簇到来，
 *     若每次都全量「IPC 生成 docx + 解析渲染」会冲击主进程、叠加并发、host 反复闪白。
 *     这里合并 DEBOUNCE_MS 内的连续变化，只在内容稳定后渲染最新一帧；成簇更新期间预览
 *     保持上一帧（不闪 spinner）。
 */
// 防抖窗口：成簇的 sections 变更（连续多条消息 end / 连续按键）通常间隔很短，
// 300ms 足以等到一簇落定再渲。
const DEBOUNCE_MS = 300
type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export function ProposalPreview({ active }: { active: boolean }): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const lastRendered = useRef<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    // 常驻但隐藏（在编辑态后台）时不空跑：ProposalDocPanel 让本组件常驻以保住
    // lastRendered 缓存，但只有当前是预览视图（active）才该生成/渲染。否则流式期间
    // 用户在编辑态，这里也会每次 sections 变都白跑一遍 IPC+渲染（评审 #2/#6）。
    if (!active) return
    // 与「导出 Word」同源：用 buildProposalMarkdown 在 kind 边界插分页标记，
    // 故预览的封面/目录/正文分页与最终 Word 逐像素一致。
    const markdown = buildProposalMarkdown(sections, { pageBreaks: true })
    if (!markdown) {
      lastRendered.current = null
      if (hostRef.current) hostRef.current.innerHTML = ''
      setStatus('empty')
      return
    }
    if (markdown === lastRendered.current) return // 该内容已渲染，跳过

    let cancelled = false
    // 防抖：合并 DEBOUNCE_MS 内的连续 sections 变化（多条消息接连 end / 编辑态连续按键），
    // 只渲染最新一帧。这之前不提前置 loading——保持上一帧（status 仍 ready），等内容落定后
    // run 才翻 loading，避免成簇更新期间每次都闪一下 spinner。
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
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
          // 渲染进「离屏」detached 容器（见顶部注释 1）：renderAsync 会 stage.innerHTML=''
          // 后追加，碰不到 host；样式节点也注入在 stage 内（第 3 参 undefined → styleContainer
          // 回退到第 2 参），随 stage 一起搬运、scope 不外泄。
          const stage = document.createElement('div')
          // inWrapper + breakPages：得到带页间留白、阴影、真分页的 A4 页面。
          await renderAsync(blob, stage, undefined, {
            inWrapper: true,
            breakPages: true,
            ignoreWidth: false,
            ignoreHeight: false,
            className: 'docx'
          })
          if (cancelled) return // 已被取代：丢弃 stage，绝不触碰 host
          // 原子替换：此刻才把渲染好的整棵子树搬进 host。Array.from 先固化，避免
          // replaceChildren 在搬运 live NodeList 时边移边塌。
          host.replaceChildren(...Array.from(stage.childNodes))
          lastRendered.current = markdown
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
  }, [sections, nonce, active])

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
