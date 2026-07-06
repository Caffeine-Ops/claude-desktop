import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { useProposalStore } from '../../stores/proposal'
import { useProposalStyleStore } from '../../stores/proposalStyle'
import { buildProposalMarkdown } from '@desktop-shared/proposal'
import { extractMermaidBlocks, renderMermaidImageMap } from '../../lib/mermaidRender'
import type { ProposalStyleConfig } from '@desktop-shared/proposalStyle'
import { FileIcon } from './proposalIcons'

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

export function ProposalPreview({
  active,
  styleConfig
}: {
  active: boolean
  // 显式样式（导出弹窗传入其 draft，边调边预览）；省略时用 store 的已生效模板，
  // 故编辑/预览面板默认即「经典正式」。
  styleConfig?: ProposalStyleConfig
}): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  const storeStyle = useProposalStyleStore((s) => s.config)
  const style = styleConfig ?? storeStyle
  // docx-preview 把样式编译成【全局类选择器】（如 `p.<className>_title span{...}`）注入
  // 文档，className 默认写死 'docx'。本组件会被同时挂载两份——编辑/预览面板常驻一份
  // （用 store 的 committed 样式），导出弹窗内再挂一份（用本地 draft 样式）。两份若共用
  // 同一 className，注入的 `p.docx_title span{...}` 选择器完全同名、同特异性，于是按 CSS
  // 「同特异性 DOM 靠后者胜出」相互覆盖：弹窗里改字号生成的新规则会被另一实例那份旧规则
  // 压住，左侧预览钉死在旧样式、改字号不同步（实测根因）。给每个实例一个稳定唯一的
  // className，让各自的规则严格局部、互不干涉。useId 形如 `:r0:`/`«r0»`，含 CSS 类名非法
  // 字符，剥成纯字母数字再用。
  const docxClass = 'docx-' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const hostRef = useRef<HTMLDivElement | null>(null)
  // 滚动容器：用来量「可用宽度」，据此把固定宽度的 A4 页面缩放到刚好放得下。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 缓存键 = markdown + 样式签名：仅 markdown 相同但样式变了（切模板/改字号）也必须
  // 重渲，否则会卡在旧样式的页面上。
  const lastRendered = useRef<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [nonce, setNonce] = useState(0)

  // docx-preview 渲染的是固定宽度的真 A4 页（210mm ≈ 794px）。本预览栏可能窄得多
  // （导出弹窗左栏仅 ~42%），且 .docx-wrapper 用 flex 居中——页面比容器宽时左半会
  // 溢出到容器左界之外、横向滚动也够不着，标题左侧的字被永久裁掉。这里按可用宽度
  // 用 zoom 把整页缩到放得下：zoom 会真正改变布局尺寸（含高度与滚动范围），不像
  // transform:scale 那样缩完留白错位。封顶 1，绝不放大。
  const applyZoom = useCallback(() => {
    const host = hostRef.current
    const scroll = scrollRef.current
    if (!host || !scroll) return
    // 页面 <section> 的 class = 本实例的唯一 docxClass（见 renderAsync 的 className 选项）。
    const page = host.querySelector<HTMLElement>('.' + docxClass)
    if (!page) return
    // 先归一再量：zoom 会改变 offsetWidth，量页固有宽前必须先把 zoom 退回 1。
    // 设值与下面的读/写在同一 JS 任务内同步完成，浏览器不会绘制中间态，无闪烁。
    host.style.setProperty('zoom', '1')
    const pageW = page.offsetWidth
    if (!pageW) return
    const avail = scroll.clientWidth - 16 // 预留少量边距，避免页面贴住滚动条
    const z = Math.min(1, avail / pageW)
    host.style.setProperty('zoom', String(z))
  }, [docxClass])

  // 容器尺寸变化（窗口缩放 / 弹窗宽度变）时重算缩放。
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const ro = new ResizeObserver(() => applyZoom())
    ro.observe(scroll)
    return () => ro.disconnect()
  }, [applyZoom])

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
    // 缓存签名含样式：切模板/改字号后即便 markdown 不变也要重渲。
    const signature = markdown + '\u0000' + JSON.stringify(style)
    if (signature === lastRendered.current) return // 该内容+样式已渲染，跳过

    let cancelled = false
    // 防抖：合并 DEBOUNCE_MS 内的连续 sections 变化（多条消息接连 end / 编辑态连续按键），
    // 只渲染最新一帧。这之前不提前置 loading——保持上一帧（status 仍 ready），等内容落定后
    // run 才翻 loading，避免成簇更新期间每次都闪一下 spinner。
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
        try {
          // 预渲本帧所有 mermaid 图为 PNG（main 无 DOM 渲不了 mermaid；canvas 栅格用同套字体，中文
          // 不缺字）。缓存签名已含 markdown，mermaid 源码变了 markdown 即变、会重渲，故无需额外进签名。
          const mermaidImages = await renderMermaidImageMap(extractMermaidBlocks(markdown))
          if (cancelled) return
          const { bytes } = await window.chatApi.renderProposal({ markdown, style, mermaidImages })
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
            // 渲染页眉页脚：品牌横幅 logo（P2-1）+ 页码都在 header/footer 里，必须开才能在预览
            // 显示，否则「预览=导出」失真（导出有品牌、预览没有）。
            renderHeaders: true,
            renderFooters: true,
            // 每实例唯一 className：docx-preview 据此生成全局类选择器，唯一化后两份预览的
            // 样式严格局部、互不覆盖（见 docxClass 处长注释）。
            className: docxClass
          })
          if (cancelled) return // 已被取代：丢弃 stage，绝不触碰 host
          // 原子替换：此刻才把渲染好的整棵子树搬进 host。Array.from 先固化，避免
          // replaceChildren 在搬运 live NodeList 时边移边塌。
          host.replaceChildren(...Array.from(stage.childNodes))
          applyZoom() // 新页搬进 host 后立刻按容器宽度缩放，避免先以原尺寸闪一帧
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
    // docxClass 每实例稳定不变，列入仅为表明被引用；不会引发额外重渲。
  }, [sections, nonce, active, style, docxClass])

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* 「真预览」角标（原 design-review F8 的浮动 pill）已移入 ProposalDocPanel 底部
          状态栏（2026-07-06 重设计）：它是常驻元信息，漂浮在页面上方会遮挡首页内容、
          且与画布争层级——文档区还给文档。 */}
      <div ref={scrollRef} className="proposal-canvas h-full overflow-auto py-8">
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
      {/* 预览空态（重设计）：一行灰字漂在整片空画布上像坏掉了；补图标 + 第二行动作
          引导（告诉用户出路在编辑模式的左侧对话），与编辑态的三步旅程空态呼应。 */}
      {status === 'empty' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <FileIcon className="size-8 text-muted-foreground/40" />
            <div className="text-[12.5px] leading-relaxed text-muted-foreground">
              草稿为空，暂无可预览内容
              <br />
              切回「编辑」，在左侧对话中开始生成
            </div>
          </div>
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
