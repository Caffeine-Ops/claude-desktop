import { useEffect, useState } from 'react'
import { useProposalStore, useProposalWorkspace } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import type { ProposalExportFormat } from '@shared/ipc-channels'
import type { ProposalStyleConfig } from '@shared/proposalStyle'
import { buildProposalMarkdown, PROPOSAL_DRAFT_BEGIN, PROPOSAL_DRAFT_END } from '@shared/proposal'
import { sendProposalStageMessage } from '../../lib/sendProposalStageMessage'
import { ProposalPaper } from './ProposalPaper'
import { ProposalPreview } from './ProposalPreview'
import { ProposalStyleModal } from './ProposalStyleModal'

export function ProposalDocPanel(): React.JSX.Element | null {
  // 与 App.tsx 隐藏右栏同一门控：仅当方案工作台接管时（active+前台+workspaceOpen）显示。
  // 改自旧的 useProposalForeground——点「返回」(workspaceOpen=false) 后本面板须隐藏、把
  // 右栏让回 Todos+文件树，而草稿不丢（active 仍真），再入由左侧「写方案」卡触发。两栏
  // 必须严格互斥同进同出，故与 App.tsx 右栏门控统一为 useProposalWorkspace。
  const show = useProposalWorkspace()
  // 「编辑｜预览」视图提到 store——面板在前台会话切走时会整体卸载，本地 state 会丢、
  // 切回被拽回编辑态（评审 #3）。store 化后跨卸载存活。
  const mode = useProposalStore((s) => s.viewMode)
  const setMode = useProposalStore((s) => s.setViewMode)
  // 只订阅会变的状态切片（sections / products）。下面 4 个 action 是 zustand 稳定引用、
  // 永不变，单独 selector 订阅纯属空跑（store 每次更新都白跑一遍）——改从 getState()
  // 一次性取出、不订阅（C5）。
  const sections = useProposalStore((s) => s.sections)
  const products = useProposalStore((s) => s.products)
  const { setProducts } = useProposalStore.getState()
  // 订阅当前阶段，驱动阶段条高亮与推进按钮渲染。advancePhase 是 zustand 稳定引用，
  // 从 getState() 取——不订阅（避免 phase 每次变化都多跑一遍 selector）。
  const phase = useProposalStore((s) => s.phase)
  const { advancePhase } = useProposalStore.getState()
  // 订阅方案会话 ID，用于下方流式状态判断。proposalSid 已是 store 的稳定切片。
  const proposalSid = useProposalStore((s) => s.sessionId)
  // 方案会话流式期间禁止推进阶段：推进按钮会另发一轮 AI 消息，mid-stream 点会和进行中
  // 的那轮叠在一起（重复请求）；待当轮 'end' 落地后再允许推进。（kind 现由哨兵自描述，
  // 不再有「按 phase 错标」之虞，但「别在流式中叠发」仍成立。）
  const generating = useChatStore((s) => (proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false))
  // 各区是否已有非空内容，决定推进按钮是否可用（空区或仅空白 → 禁用，避免误推进）。
  // 注：用 .trim().length > 0 而非仅 .some(kind===X)——纯空白区段依然无法驱动 AI 生成。
  const hasCover = sections.some((s) => s.kind === 'cover' && s.markdown.trim().length > 0)
  const hasToc = sections.some((s) => s.kind === 'toc' && s.markdown.trim().length > 0)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null)
  // 「导出 Word」改为先弹样式模板面板（选模板 + 实时预览 + 微调），用户在弹窗里点导出
  // 才真正落盘。.md 仍直出（纯文本无样式）。
  const [styleModalOpen, setStyleModalOpen] = useState(false)

  useEffect(() => {
    if (!exportMsg) return
    const id = setTimeout(() => setExportMsg(null), 4000)
    return () => clearTimeout(id)
  }, [exportMsg])

  // 阶段一→二：先把 phase 推到 toc（驱动阶段条/按钮 UI），再让 AI 生成目录大纲。
  // 归档不再靠 phase 而靠哨兵类型，故消息里点名【目录哨兵】，让 AI 用对那对标记。
  function confirmCover(): void {
    advancePhase('toc')
    void sendProposalStageMessage(
      `封面已确认。请进入【阶段二·目录】：参考知识库里该产品的资料结构与售前方案常见章节，给出一份章节目录大纲（有序列表逐章列出），用方案【目录】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.toc} … ${PROPOSAL_DRAFT_END.toc}）。`
    )
  }
  // 阶段二→三：把已确认的目录正文带给 AI（目录驱动正文），phase 推到 content。
  function confirmToc(): void {
    const tocMd = buildProposalMarkdown(
      sections.filter((s) => s.kind === 'toc'),
      { pageBreaks: false }
    )
    advancePhase('content')
    void sendProposalStageMessage(
      `目录已确认，最终目录如下：\n\n${tocMd}\n\n请进入【阶段三·正文】：严格按上面目录逐章撰写正文，章节标题与顺序以目录为准，一次聚焦一章，每章用方案【正文】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.content} … ${PROPOSAL_DRAFT_END.content}）。`
    )
  }

  async function handleExport(
    format: ProposalExportFormat,
    style?: ProposalStyleConfig
  ): Promise<void> {
    if (exporting) return
    // docx 走分页标记（kind 边界分页）；.md 是纯文本，不插标记（否则注释外漏）。
    const markdown = buildProposalMarkdown(sections, { pageBreaks: format === 'docx' })
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '草稿为空，无内容可导出' })
      return
    }
    setExporting(true)
    try {
      // style 仅 docx 用得到（驱动样式模板）；.md 透传 undefined，main 端忽略。
      const r = await window.chatApi.exportProposal({ markdown, format, style })
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[export]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExporting(false)
    }
  }

  if (!show) return null
  return (
    // 只在工作台接管时渲染（show=useProposalWorkspace），故恒为顶替右栏的第 3 列：
    // flex-1 吃满。旧的「返回态 w-96 靠右停靠」分支已随门控统一而消失。
    <div className="flex min-w-0 flex-1 flex-col border-l border-border bg-background text-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">方案草稿</span>

        {/* 编辑 ｜ 预览 segmented */}
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          <button
            className={
              'rounded-md px-3 py-1 ' +
              (mode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
            }
            onClick={() => setMode('edit')}
          >
            ✎ 编辑
          </button>
          <button
            className={
              'rounded-md px-3 py-1 ' +
              (mode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
            }
            onClick={() => setMode('preview')}
          >
            ▤ 预览
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* 再入入口不在此处——面板只在工作台接管时存在，「返回」后整个隐藏，故再入
              由左侧「写方案」卡触发（已 active 时只重开 workspaceOpen、不清草稿）。 */}
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => setStyleModalOpen(true)}
          >
            {exporting ? '导出中…' : '导出 Word'}
          </button>
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => {
              void handleExport('md')
            }}
          >
            .md
          </button>
        </div>
      </div>

      {/* 阶段条：封面 → 目录 → 正文，显式按钮门控推进，一次只推进一阶段。 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span className={phase === 'cover' ? 'font-medium text-foreground' : 'text-muted-foreground'}>① 封面</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'toc' ? 'font-medium text-foreground' : 'text-muted-foreground'}>② 目录</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'content' ? 'font-medium text-foreground' : 'text-muted-foreground'}>③ 正文</span>
        <span className="flex-1" />
        {phase === 'cover' && (
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={generating || !hasCover}
            onClick={confirmCover}
            title={generating ? 'AI 生成中，请稍候' : hasCover ? '' : '封面尚未生成'}
          >
            确认封面，生成目录
          </button>
        )}
        {phase === 'toc' && (
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={generating || !hasToc}
            onClick={confirmToc}
            title={generating ? 'AI 生成中，请稍候' : hasToc ? '' : '目录尚未生成'}
          >
            确认目录，开始正文
          </button>
        )}
        {phase === 'content' && <span className="text-muted-foreground">正文撰写中</span>}
      </div>

      {exportMsg && (
        <div
          className={
            'truncate border-b border-border px-3 pb-1.5 pt-1 text-[11px] ' +
            (exportMsg.tone === 'ok'
              ? 'text-emerald-500'
              : exportMsg.tone === 'err'
                ? 'text-rose-500'
                : 'text-muted-foreground')
          }
          title={exportMsg.text}
        >
          {exportMsg.text}
        </div>
      )}

      {/* 识别到的产品 chip：方案首发时由 matchProducts 写入，可删纠错。空集 → 提示整库兜底。 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
        {products.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">未识别到产品，AI 将自行在知识库定位</span>
        ) : (
          products.map((p) => (
            <span
              key={`${p.productLine} ${p.product}`}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {p.product}
              <button
                type="button"
                aria-label={`移除 ${p.product}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setProducts(
                    products.filter((x) => !(x.productLine === p.productLine && x.product === p.product))
                  )
                }
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      {/* 分节文档区：ProposalPaper（连续长纸 + 悬停工具条 + 就地编辑）与 ProposalPreview
          （A4 分页预览，与导出 Word 同源）两者【都常驻挂载】，仅用 CSS hidden 切显隐——
          不再 `mode==='edit' ? <A/> : <B/>` 条件渲染（评审 #2）：那会让 ProposalPreview 每次
          切换都卸载、其 lastRendered 缓存随之销毁，「来回切不重复生成」的优化形同虚设、
          每次切预览都从零跑一遍 IPC 生成 docx + 渲染。常驻后缓存存活：内容没变时切回预览
          即时复现已渲染的页面。预览常驻于后台时不能空跑——传 active 闸，非激活不渲染
          （见 ProposalPreview）。 */}
      <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'edit' ? '' : 'hidden')}>
        <ProposalPaper />
      </div>
      <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'preview' ? '' : 'hidden')}>
        <ProposalPreview active={mode === 'preview'} />
      </div>

      {/* 导出样式模板弹窗：弹窗内点「导出 Word」时提交 draft 样式并走 handleExport('docx', style)。 */}
      <ProposalStyleModal
        open={styleModalOpen}
        onClose={() => setStyleModalOpen(false)}
        onExport={(style) => {
          void handleExport('docx', style)
        }}
      />
    </div>
  )
}
