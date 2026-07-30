import { useMemo } from 'react'

import { joinWritingSections, shouldPageBreak } from '@desktop-shared/writing'
import { renderProposalPdfHtml } from '../../lib/renderProposalPdfHtml'
import { writingStyleFor } from '../../lib/writingGenreStyle'
import { useWritingStore } from '../../stores/writing'
import { PreviewStateOverlay } from './PreviewStateOverlay'
// 与方案端空态用**同一个**图标：两处预览的空态视觉语言统一，别在这里另选一个图标
// 平白造出新的差异（图标定义住在 proposalIcons 是历史位置，不代表它只归方案用）。
import { FileIcon } from './proposalIcons'
import { usePreviewFrame } from './usePreviewFrame'

/**
 * 打印预览。两条分支：
 *  - 微信：main 生成内联 HTML，塞进 375px 手机宽容器。**与「复制公众号 HTML」是同一份字符串**，
 *    所见即所得。
 *  - 其余：走与导出 PDF 完全相同的引擎（renderProposalPdfHtml → renderProposalPdf →
 *    隐藏窗口 printToPDF），预览看的就是导出物本身，分页逐字节一致。
 *
 * 防抖 / cancelled 闸门 / objectURL 回收 / 签名缓存 / active 门控 / 重试这六件事全在
 * usePreviewFrame 里（与 ProposalPreview 共用一份，那些机制是两边一起踩坑踩出来的，事故
 * 记录见该文件头注释）。
 * 本文件只剩写作端真正特有的东西：体裁分支的渲染管线、微信手机宽容器、样式降级警示条。
 */
type WritingFrame = {
  /** A4 体裁：PDF blob 的 objectURL。微信体裁固定 null——hook 借此把上一帧残留的 PDF revoke 掉。 */
  objectUrl: string | null
  /** 微信体裁：main 生成的内联 HTML。 */
  html?: string
  /**
   * 样式 JSON 读不到、main 降级用了内置兜底样式时为 true——用户看到的排版与真实导出的
   * 公众号 HTML 可能不一致，必须在 UI 上说出来，不能静默换一套样式（这正是预览与导出同源
   * 存在的意义）。
   */
  styleFallback?: boolean
}

export function WritingPreview({ active }: { active: boolean }): React.JSX.Element {
  const sections = useWritingStore((s) => s.sections)
  const genre = useWritingStore((s) => s.genre)

  // !active 时不拼接：本组件常驻挂载（WritingDocPanel 用 hidden 类切换以保住签名缓存），
  // 文稿 tab 编辑期间 sections 每变一次都不该在这里白拼一遍长 markdown。
  const markdown = useMemo(
    () => (active ? joinWritingSections(sections, { pageBreaks: shouldPageBreak(genre) }) : ''),
    [sections, genre, active]
  )
  // 体裁进签名：同一份 markdown 换体裁后产出完全不同（样式甚至输出形态都变），必须重渲。
  const signature = useMemo(() => (markdown ? `${genre}:${markdown}` : null), [genre, markdown])

  const { status, errMsg, frame, retry } = usePreviewFrame<WritingFrame>({
    active,
    signature,
    render: async (isCancelled) => {
      if (genre === 'wechat') {
        const r = await window.chatApi.writingWechatHtml({
          markdown,
          styleName: 'wechat-default'
        })
        if (!r.ok) throw new Error(r.error)
        // objectUrl: null 不只是「这条路径没有 PDF」——它同时是让 hook 回收上一帧 PDF blob 的
        // 手段。跨体裁切换（A4 → 微信）后那份 PDF 再也不会显示，只会白占内存（F1 曾是真 bug：
        // 停留在微信体裁期间旧 PDF 既不显示也不 revoke）。
        return { objectUrl: null, html: r.html, styleFallback: r.styleFallback }
      }
      // renderProposalPdfHtml 的第三个参数（预渲的 mermaid 图）是给方案文档用的；写作体裁
      // 不支持 mermaid 代码块，显式传 undefined——它不是可选参数，漏传会挂在 typecheck 上。
      const html = await renderProposalPdfHtml(markdown, writingStyleFor(genre), undefined)
      // 已被更新的一帧取代：提前退出，省掉后面那次昂贵的 printToPDF。返回值本身无意义——
      // hook 拿到结果后还会再查一次 cancelled 并整份丢弃，这里只是不做无用功。
      if (isCancelled()) return { objectUrl: null }
      const { bytes } = await window.chatApi.renderProposalPdf({ html })
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
      return { objectUrl: URL.createObjectURL(blob) }
    }
  })

  return (
    <div className="relative flex-1 overflow-hidden">
      {genre === 'wechat' ? (
        <div className="h-full overflow-y-auto bg-neutral-100 py-6 dark:bg-neutral-900">
          {/* F2：main 已降级用内置兜底样式时必须说出来——用户看到的排版与真实导出的公众号
              HTML 可能不一样，静默换一套样式正是这个功能最该避免的事。纯 div，不是交互元素，
              无需 shadcn 原语。 */}
          {frame?.styleFallback && (
            <div className="mx-auto mb-3 w-[375px] rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">
              样式文件未找到，当前用内置样式预览——与实际导出可能有差异
            </div>
          )}
          <div
            className="mx-auto w-[375px] bg-white p-4 text-black shadow"
            // 内容由 main 从 markdown 生成、只输出白名单标签且正文已转义（见 writingWechat.ts）
            dangerouslySetInnerHTML={{ __html: frame?.html ?? '' }}
          />
        </div>
      ) : (
        frame?.objectUrl && (
          <iframe
            key={frame.objectUrl}
            src={frame.objectUrl}
            title="文稿预览"
            className="h-full w-full border-0"
          />
        )
      )}

      <PreviewStateOverlay
        status={status}
        errMsg={errMsg}
        loadingText="正在生成预览…"
        onRetry={retry}
        // 空态补图标 + 动作引导（与方案端对齐）：一行灰字漂在整片空画布上像功能坏了，
        // 用户不知道出路在哪。第二行指向的是「文稿」而非方案端的「编辑」——两边的 tab
        // 本来就叫不同名字，照抄文案会指向一个这里不存在的按钮。
        empty={
          <div className="flex flex-col items-center gap-3 text-center">
            <FileIcon className="size-8 text-muted-foreground/40" />
            <div className="text-[12.5px] leading-relaxed text-muted-foreground">
              还没有正文可预览
              <br />
              切回「文稿」，在左侧对话中让 AI 开始写
            </div>
          </div>
        }
      />
    </div>
  )
}
