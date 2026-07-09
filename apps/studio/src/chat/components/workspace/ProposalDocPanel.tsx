import { Fragment, useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { useProposalStore, useProposalWorkspace, type ProposalProduct } from '../../stores/proposal'
import { useProposalStyleStore } from '../../stores/proposalStyle'
import { useChatStore } from '../../stores/chat'
import { listKbProducts } from '../../lib/kbProductMatch'
import type { ProposalExportFormat, ProposalRetrievedPassage } from '@desktop-shared/ipc-channels'
import type { ProposalStyleConfig } from '@desktop-shared/proposalStyle'
import {
  buildProposalMarkdown,
  buildProposalMetric,
  parseGaps,
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END
} from '@desktop-shared/proposal'
import { sendProposalStageMessage } from '../../lib/sendProposalStageMessage'
import { startProposalGapFill } from '../../lib/sendProposalSectionRevision'
import { extractMermaidBlocks, renderMermaidImageMap } from '../../lib/mermaidRender'
import { renderProposalPdfHtml } from '../../lib/renderProposalPdfHtml'
import {
  hasSeenProposalOnboarding,
  markProposalOnboardingSeen,
  shouldShowProposalOnboarding
} from '../../lib/proposalOnboarding'
import { ProposalPaper } from './ProposalPaper'
import { ProposalPreview } from './ProposalPreview'
import { ProposalStyleModal } from './ProposalStyleModal'
import { KbSemanticSearchPanel } from './KbSemanticSearchPanel'
import {
  PencilIcon,
  EyeIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileTextIcon,
  FileIcon,
  FileCodeIcon,
  SlidersIcon,
  XIcon,
  SearchIcon,
  AlertTriangleIcon,
  InfoIcon,
  CheckIcon,
  BookIcon
} from './proposalIcons'

// 阶段序列（模块级常量）：驱动阶段条 stepper 的 done / now / future 三态渲染。
// 顺序即业务硬门顺序（封面→目录→正文），与 stores/proposal 的 phase 推进一致。
const PROPOSAL_PHASES = [
  { key: 'cover', label: '封面' },
  { key: 'toc', label: '目录' },
  { key: 'content', label: '正文' }
] as const

// 取一节的展示标题：正文首个 markdown 标题行（# ～ ######）的文字，用于资料缺失清单里
// 标明「这处缺口在哪一章」。无标题（理论少见）退化为占位串。模块级纯函数，不依赖组件状态。
function sectionTitle(markdown: string): string {
  const m = markdown.match(/^#{1,6}\s+(.+?)\s*$/m)
  return m ? m[1].trim() : '（未命名章节）'
}

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
  // 订阅当前阶段，驱动阶段条高亮（只读）。阶段推进已不在本面板：cover→toc 由 AI 目录
  // 哨兵自动推进，toc→content 由聊天内 AskUserQuestion「确认目录」放行项触发
  // （applyProposalStageConfirm），故本面板不再解构/调用 advancePhase。
  const phase = useProposalStore((s) => s.phase)
  // 阶段门拦截提示：AI 越过「目录确认门」直接吐正文被 appendSections 拦下时非空。订阅以
  // 驱动下方红条提示。clearStageSkip 是稳定引用，从 getState 取、不订阅。
  const stageSkip = useProposalStore((s) => s.stageSkip)
  const { clearStageSkip } = useProposalStore.getState()
  // 草稿写盘失败态（P3-3）：FusionRuntimeProvider.flushProposalSave 落盘失败时置 true、成功置 false。
  // 订阅以驱动下方常驻红条——不像 exportMsg 那样 4s 自动消失，要一直留到下次成功保存（自愈）。
  const draftSaveFailed = useProposalStore((s) => s.draftSaveFailed)
  // 订阅方案会话 ID，用于下方流式状态判断。proposalSid 已是 store 的稳定切片。
  const proposalSid = useProposalStore((s) => s.sessionId)
  // 方案会话流式期间禁止推进阶段：推进按钮会另发一轮 AI 消息，mid-stream 点会和进行中
  // 的那轮叠在一起（重复请求）；待当轮 'end' 落地后再允许推进。（kind 现由哨兵自描述，
  // 不再有「按 phase 错标」之虞，但「别在流式中叠发」仍成立。）
  const generating = useChatStore((s) => (proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false))
  // 资料缺失聚合（P3-2 阶段一）：扫各节正文里 AI 写下的「⚠️ 资料缺失：…」标记，连同所在章节
  // 标题汇成一张清单——把原本散落在正文各处、容易被忽略的缺口，集中暴露在面板顶部供用户复核。
  // 锚定到 sectionId，为阶段二「定点补料续写」预留入口。纯派生，不入 store（随 sections 重算）。
  const gaps = sections.flatMap((sec) =>
    parseGaps(sec.markdown).map((desc) => ({ sectionId: sec.id, title: sectionTitle(sec.markdown), desc }))
  )
  // 状态呼吸灯 badge（重设计）：把「系统在不在干活」从阶段条右侧的灰字提升为标题旁的
  // 活性徽章——生成中亮品牌绿呼吸点、目录等确认转琥珀、未开始中性灰；正文阶段闲置时
  // 干脆不显示（无事发生就别占注意力）。纯派生，随 generating/phase/sections 重算。
  const badge: { text: string; tone: 'live' | 'wait' | 'idle' } | null = generating
    ? {
        text: phase === 'cover' ? '封面撰写中' : phase === 'toc' ? '目录整理中' : '正文撰写中',
        tone: 'live'
      }
    : sections.length === 0
      ? { text: '描述需求即可开始', tone: 'idle' }
      : phase === 'toc'
        ? { text: '等你在聊天里确认', tone: 'wait' }
        : null
  // 开场上手引导（一次性）：草稿为空且没看过时显示「三步走」说明卡。用户发出首条需求、
  // 草稿长出内容（sections 非空）即视为「走过一次」，自动置位；也可点卡上「知道了」手动关。
  // 置位后再开空草稿也不再出现（老用户不打扰）。onboardingSeen 初值读 localStorage。
  const [onboardingSeen, setOnboardingSeen] = useState(hasSeenProposalOnboarding)
  const showOnboarding = shouldShowProposalOnboarding(onboardingSeen, sections.length === 0)
  useEffect(() => {
    if (sections.length > 0 && !onboardingSeen) {
      markProposalOnboardingSeen()
      setOnboardingSeen(true)
    }
  }, [sections.length, onboardingSeen])
  const dismissOnboarding = (): void => {
    markProposalOnboardingSeen()
    setOnboardingSeen(true)
  }
  const phaseIdx = PROPOSAL_PHASES.findIndex((p) => p.key === phase)
  // 底部状态栏的文档体量：字数按去空白字符计（贴近中文「字数」直觉），纯派生不入 store。
  const charCount = sections.reduce((n, s) => n + s.markdown.replace(/\s/g, '').length, 0)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null)
  // 「新建」二次确认：清空是破坏性的（丢掉整份草稿），故点一下先morph成确认条，再点才真清。
  // 内联确认而非 modal——与本工具栏其余轻量控件一致，不为一个动作引一层弹窗。
  const [confirmingNew, setConfirmingNew] = useState(false)
  // 导出下拉菜单（重设计 A）：顶栏唯一导出入口，点开列 Word/PDF/Markdown（各带用途说明）+
  // 「调整样式模板…」。取代旧的「导出 Word 按钮 + ⚙ 两处散落 + 弹窗里又一组导出」的混乱布局。
  // 2026-07-08 起走 ui/dropdown-menu 基件（radix 管开合/outside-dismiss），不再自持 open state。
  // 样式模板弹窗：现退化为【纯调样式】（选模板 + 实时预览 + 微调 + 应用），不再是导出入口——
  // 导出统一收敛到上面的下拉，消除「两处导出」。由下拉里的「调整样式模板…」打开。
  const [styleModalOpen, setStyleModalOpen] = useState(false)
  // 跳阶自动补救计数（方案二·软化 stageSkip）：AI 越过目录门吐正文被阶段门拦时，静默自动重发
  // 「只生成目录」最多两次，不再弹红条暴露内部状态机。两次仍跳阶才露一行温和提示兜底。
  const [autoTocFix, setAutoTocFix] = useState(0)
  // 产品 chip 可增（方案三）：从知识库索引列出全部可选产品，让用户手动追加 matchProducts 没识别
  // 到的产品——把「用哪些产品写」的控制权还给用户（原先只能删 chip、不能增）。
  // 资料缺失清单展开态（P3-2）：默认收起，只露一行「⚠️ 资料缺失 N 处」摘要条，点开看明细。
  const [gapsOpen, setGapsOpen] = useState(false)
  const [allKbProducts, setAllKbProducts] = useState<ProposalProduct[]>([])
  async function loadKbProducts(): Promise<void> {
    try {
      const idx = await window.chatApi.readKbIndex()
      setAllKbProducts(listKbProducts(idx))
    } catch {
      setAllKbProducts([])
    }
  }
  // 语义搜索面板（Task 8）：混合向量+BM25 检索，与「召回预览」BM25 词面互补。
  const [semanticSearchOpen, setSemanticSearchOpen] = useState(false)
  // 召回预览（方案三·只读）：输关键词 + 当前产品集 → 知识库 top 召回片段，让用户看到检索到底命中
  // 什么、判断检索质量、决定要不要加产品。不写盘、不注入提示词，纯探查。
  const [retrievalOpen, setRetrievalOpen] = useState(false)
  const [peekQuery, setPeekQuery] = useState('')
  const [peekLoading, setPeekLoading] = useState(false)
  const [peekResults, setPeekResults] = useState<ProposalRetrievedPassage[] | null>(null)
  // 诊断：本次扫描到的产品资料文件数。0 = 产品与索引对不上（没料可搜）；>0 但结果空 = 词面没命中。
  // 据此把空态分成两种文案，让「为什么没召回」对用户可见，也方便我们排障定位。
  const [peekScanned, setPeekScanned] = useState<number | null>(null)
  async function runPeek(): Promise<void> {
    if (peekLoading) return
    const q = peekQuery.trim()
    if (!q) return
    setPeekLoading(true)
    try {
      const r = await window.chatApi.peekProposalRetrieval({ query: q, products })
      setPeekResults(r.passages)
      setPeekScanned(r.scannedFiles ?? null)
    } catch {
      setPeekResults([])
      setPeekScanned(null)
    } finally {
      setPeekLoading(false)
    }
  }

  useEffect(() => {
    if (!exportMsg) return
    const id = setTimeout(() => setExportMsg(null), 4000)
    return () => clearTimeout(id)
  }, [exportMsg])

  // 跳阶静默补救（方案二）：stageSkip 非空（AI 在目录阶段直接吐正文被阶段门拦下）时，自动重发
  // 「只生成目录」把 AI 拉回，而非弹红条暴露内部状态机。regenerateToc 内部先 clearStageSkip 再
  // 发，故下一轮 stageSkip 归 null、本 effect 不空转；二次仍跳阶（autoTocFix>=2）则停手、改露
  // 温和兜底提示。generating 期间不发（regenerateToc 会和进行中的那轮叠发）。回到 content 阶段
  // （用户已确认目录）后计数清零，下次新方案重新计。
  useEffect(() => {
    if (phase === 'content') {
      if (autoTocFix !== 0) setAutoTocFix(0)
      return
    }
    if (!stageSkip || generating || autoTocFix >= 2) return
    setAutoTocFix((n) => n + 1)
    regenerateToc()
    // regenerateToc / setAutoTocFix 均为稳定调用；deps 只追驱动信号，避免把函数引用塞进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageSkip, phase, generating, autoTocFix])

  // 跳阶补救：AI 在目录阶段直接吐正文被阶段门拦下（stageSkip 非空）、或被流式硬门（①）当场掐断时，
  // 重发指令把 AI 拉回。phase 已是 toc（目录哨兵块经 laterPhase 自动推进），不再 advancePhase。
  // 措辞直指真正缺的那一步——【目录确认】：跳阶的本质不是没生成目录，而是生成后没发起 AskUserQuestion
  // 确认就抢写正文。故既覆盖「目录还没生成」也覆盖「目录已生成但漏了确认」，并硬性要求先发确认卡。
  function regenerateToc(): void {
    clearStageSkip()
    void sendProposalStageMessage(
      `上一轮你跳过了目录确认就开始写正文（已被拦下、未入文档）。请按下列顺序纠正：① 若目录尚未生成，先【只输出章节目录大纲】（有序列表逐章列出），用方案【目录】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.toc} … ${PROPOSAL_DRAFT_END.toc}）；② 然后【必须立即】用 AskUserQuestion 工具发起目录确认（header「确认目录」，首选项「确认目录，开始撰写正文」）。在我确认前【绝对不要】写任何正文。`,
      { displayText: '重新生成目录并等待确认' }
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
      // 预渲 mermaid 图（仅 docx 需要）：main 无 DOM 渲不了 mermaid，故 renderer 渲成 PNG（canvas
      // 栅格、中文不缺字）传给 main 直接嵌入。.md 是纯文本，不需要。
      const mermaidImages =
        format === 'docx' ? await renderMermaidImageMap(extractMermaidBlocks(markdown)) : undefined
      // style 仅 docx 用得到（驱动样式模板）；.md 透传 undefined，main 端忽略。
      const r = await window.chatApi.exportProposal({ markdown, format, style, mermaidImages })
      // 先定导出结果反馈——埋点绝不能影响它（见下）。
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
      // M-0 埋点：仅在真导出（r.path 非 null，非取消）时落一条本地记录。从 getState() 取最新
      // sections（含 baseline/verification）与 sessionId，不依赖闭包旧值。
      // 【旁路化】自带 try/catch + 可选链：埋点是统计信号，它的任何失败（preload 未热更致方法
      // 缺失、buildProposalMetric 异常、IPC reject）都只丢埋点，绝不能冒泡污染【已落盘】的导出
      // 成功反馈——否则用户会看到「导出失败」但文件其实已生成（这正是本次踩的坑）。
      if (r.path) {
        try {
          const { sections: latest, sessionId } = useProposalStore.getState()
          void window.chatApi.logProposalMetric?.(
            buildProposalMetric(latest, { ts: Date.now(), sessionId: sessionId ?? '', format })
          )
        } catch (err) {
          console.warn('[export] metric log failed (non-fatal):', err)
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[export]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExporting(false)
    }
  }

  // 导出 PDF（P2-2）：与 docx 同源——同一 markdown + 样式 + mermaid 图，但走 renderer 端
  // docx-preview 渲 HTML → main printToPDF 的独立链路（main 无 DOM，不能从 markdown 直出 PDF）。
  async function handleExportPdf(style?: ProposalStyleConfig): Promise<void> {
    if (exporting) return
    const markdown = buildProposalMarkdown(sections, { pageBreaks: true })
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '草稿为空，无内容可导出' })
      return
    }
    setExporting(true)
    try {
      const mermaidImages = await renderMermaidImageMap(extractMermaidBlocks(markdown))
      const html = await renderProposalPdfHtml(markdown, style, mermaidImages)
      const r = await window.chatApi.exportProposalPdf({ html, defaultPath: '方案草稿.pdf' })
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[export pdf]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExporting(false)
    }
  }

  if (!show) return null
  return (
    // 只在工作台接管时渲染（show=useProposalWorkspace），故恒为顶替右栏的第 3 列：
    // flex-1 吃满。旧的「返回态 w-96 靠右停靠」分支已随门控统一而消失。
    // relative：作浮动导出 toast（exportMsg，见下方）的定位锚——toast 不再占布局、不再
    // 和其它状态条叠成一堵彩色墙（design-review F3）。
    // proposal-feature：作用域 class，让 index.css 给区内所有可聚焦控件统一补 focus-visible
    // 焦点环（design-review F6）；Paper/Preview/StyleModal 都在本根 DOM 子树内，一处全覆盖。
    <div className="proposal-feature relative flex min-w-0 flex-1 flex-col border-l border-border bg-background text-foreground">
      {/* 顶栏：h-[46px] + hairline /55 与 ChatHeader / slides tab 栏同参——
          分栏各列顶栏底边对齐成一条（2026-07-08 统一，旧 py-2 自适应高
          ≈40px 与左列 46px 错位）。窗口拖拽由根 .window-drag-strip 覆盖
          本列顶部（本栏历来没标过 drag，右列顶部空白拖不动窗口的问题
          顺带修复）；栏内交互控件必须 no-drag 在 strip 上挖洞，否则点击
          被原生拖拽吞掉（globals.css 的 .window-drag-strip 纪律）。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center justify-between gap-2 border-b border-border/55 px-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap text-[13px] font-semibold text-foreground">方案草稿</span>
          {/* 状态呼吸灯：live=品牌绿+ping 扩散点（AI 正在写）、wait=琥珀（等用户确认目录）、
              idle=中性灰（还没开始）。品牌绿是身份/活性色（--brand），刻意不用会随用户
              主题变的 --accent——「在干活」的信号不该跟着主题色跑。 */}
          {badge && (
            <span
              className={
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] ' +
                (badge.tone === 'live'
                  ? 'bg-brand/10 text-brand'
                  : badge.tone === 'wait'
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'bg-muted text-muted-foreground')
              }
            >
              {badge.tone === 'live' ? (
                <span className="relative flex size-1.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                </span>
              ) : (
                <span
                  className={
                    'size-1.5 shrink-0 rounded-full ' +
                    (badge.tone === 'wait' ? 'bg-amber-500' : 'bg-muted-foreground/50')
                  }
                />
              )}
              {badge.text}
            </span>
          )}
        </span>

        {/* 编辑 ｜ 预览 segmented：muted 槽底 + 选中项白卡浮起（bg-card + shadow）——
            原先容器用 card 白底，选中项 bg-background 与之几乎同色，选中态看不出来。
            no-drag：本栏在窗口拖拽带（顶部 46px）内，不挖洞点击会被拖窗吞掉。 */}
        <div className="inline-flex rounded-lg bg-muted p-0.5 [-webkit-app-region:no-drag]">
          <button
            className={
              'inline-flex items-center gap-1 rounded-md px-3 py-1 transition-colors ' +
              (mode === 'edit'
                ? 'bg-card font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground')
            }
            onClick={() => setMode('edit')}
          >
            <PencilIcon /> 编辑
          </button>
          <button
            className={
              'inline-flex items-center gap-1 rounded-md px-3 py-1 transition-colors ' +
              (mode === 'preview'
                ? 'bg-card font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground')
            }
            onClick={() => setMode('preview')}
          >
            <EyeIcon /> 预览
          </button>
        </div>

        {/* no-drag 一次盖住右侧整组（清空草稿 / 导出下拉 trigger）——同 segmented。 */}
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          {/* 再入入口不在此处——面板只在工作台接管时存在，「返回」后整个隐藏，故再入
              由左侧「写方案」卡触发（已 active 时只重开 workspaceOpen、不清草稿）。 */}
          {/* 新建/清空：唯一显式丢弃草稿的入口（reopen/leaveMode 都保草稿，只有这里调 start
              彻底清空并在【当前会话】重开一份空白方案）。二次确认 + 流式期间禁用。 */}
          {confirmingNew ? (
            <span className="mr-1 inline-flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">清空当前草稿？</span>
              <button
                className="rounded bg-rose-500 px-2 py-0.5 text-white hover:bg-rose-600"
                onClick={() => {
                  // proposalSid 在 show=true 时恒非空（门控要求 sessionId===前台会话）；
                  // 仍守一手 null，绝不把 start('') 透出去污染 gating。
                  if (proposalSid) {
                    // 先删盘再清内存：否则清完一刷新/切回，草稿又从盘上 restoreFromDisk 回来。
                    // start() 把 sections 清空，订阅器因空草稿不再写盘，故不会复活该文件。
                    void window.chatApi.deleteProposalDraft({ sessionId: proposalSid })
                    useProposalStore.getState().start(proposalSid)
                  }
                  setConfirmingNew(false)
                }}
              >
                确认清空
              </button>
              <button
                className="rounded px-2 py-0.5 hover:bg-muted"
                onClick={() => setConfirmingNew(false)}
              >
                取消
              </button>
            </span>
          ) : (
            <button
              className="mr-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              // 草稿为空（sections 无内容）时没什么可清，置灰避免空操作 + 误触发二次确认条；
              // 流式期间也禁用（清空和进行中的那轮叠加会乱）。
              disabled={generating || sections.length === 0}
              title={
                generating
                  ? 'AI 生成中，无法清空'
                  : sections.length === 0
                    ? '草稿为空，无需清空'
                    : '清空当前草稿，重新开始一份'
              }
              onClick={() => setConfirmingNew(true)}
            >
              清空草稿
            </button>
          )}
          {/* 导出下拉（重设计 A）：唯一导出入口。三格式各带一句用途说明，让「这个按钮干嘛用」
              一目了然；分隔线下「调整样式模板…」打开纯调样式弹窗。Word/PDF 用当前已生效样式
              （useProposalStyleStore，跨会话持久）；先调样式就先走「调整样式模板…」应用再导出。 */}
          {/* 导出下拉 —— ui/dropdown-menu 基件（2026-07-08 用户定稿：全项目
              下拉菜单统一基件样式）。radix 自带 portal + outside-dismiss，
              旧版的全屏捕获层（连同它的 app-region:no-drag 补丁）与
              proposal-anim-pop 自绘动画随之退役。双行 item（标题+用途说明）
              用 items-start 覆盖基件的 items-center，其余全走基件默认。 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-white shadow-sm hover:opacity-90 disabled:opacity-50"
                disabled={exporting}
                title="导出方案（Word / PDF / Markdown）"
              >
                {exporting ? '导出中…' : (
                  <>
                    导出
                    <ChevronDownIcon />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                className="items-start"
                onSelect={() => {
                  void handleExport('docx', useProposalStyleStore.getState().config)
                }}
              >
                <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">Word（.docx）</span>
                  <span className="block text-[11px] text-muted-foreground">交付客户、可继续编辑</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="items-start"
                onSelect={() => {
                  void handleExportPdf(useProposalStyleStore.getState().config)
                }}
              >
                <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">PDF</span>
                  <span className="block text-[11px] text-muted-foreground">定稿发送、排版固定</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="items-start"
                onSelect={() => {
                  void handleExport('md')
                }}
              >
                <FileCodeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">Markdown</span>
                  <span className="block text-[11px] text-muted-foreground">纯文本、便于版本管理</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-muted-foreground"
                onSelect={() => {
                  setStyleModalOpen(true)
                }}
              >
                <SlidersIcon className="size-4 shrink-0" />
                调整样式模板…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 阶段条：节点 stepper（重设计）——完成=品牌绿实心勾、当前=描边+光环、未来=灰点，
          节点间连线随进度填充。只读状态显示；阶段推进已移到左侧聊天（AI 每完成一阶段用
          AskUserQuestion 发确认卡片，见 applyProposalStageConfirm），本条不承载可点按钮。
          原右侧的「封面撰写中」等活性文字已上移为标题旁呼吸灯 badge——本条只管「走到
          哪一步」，badge 只管「系统在不在干活」，各司其职。 */}
      <div className="flex items-center border-b border-border px-3 py-2">
        {PROPOSAL_PHASES.map((p, i) => (
          <Fragment key={p.key}>
            {i > 0 && (
              <span className="relative mx-2.5 h-0.5 w-9 shrink-0 overflow-hidden rounded-full bg-border">
                <span
                  className={
                    'absolute inset-0 origin-left rounded-full bg-brand transition-transform duration-500 ' +
                    (i <= phaseIdx ? 'scale-x-100' : 'scale-x-0')
                  }
                />
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span
                className={
                  'grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold transition-colors ' +
                  (i < phaseIdx
                    ? 'border-brand bg-brand text-brand-foreground'
                    : i === phaseIdx
                      ? 'border-brand bg-background text-brand ring-[3px] ring-brand/15'
                      : 'border-border bg-muted text-muted-foreground')
                }
              >
                {i < phaseIdx ? <CheckIcon /> : i + 1}
              </span>
              <span
                className={
                  'whitespace-nowrap text-[12px] ' +
                  (i === phaseIdx
                    ? 'font-semibold text-foreground'
                    : i < phaseIdx
                      ? 'text-foreground'
                      : 'text-muted-foreground')
                }
              >
                {p.label}
              </span>
            </span>
          </Fragment>
        ))}
      </div>

      {/* 补救进行中提示（③·根因「莫名一直在思考」）：自动补救（regenerateToc）原本【完全静默】，
          用户只看到 spinner 一直转、不知在干嘛——这正是「一直在思考」体感的来源之一。故凡补救轮
          在飞期间（已触发过补救 autoTocFix>0、且正生成、目录尚未确认）都露一行「正在自动纠正」，
          让「为什么还在转」对用户可见。与下方 autoTocFix>=2 的兜底条天然互斥：本条要 generating=true，
          那条要 stageSkip 非空，而 regenerateToc 发起前已 clearStageSkip，故补救轮在飞时 stageSkip
          必为 null、兜底条不显示；补救轮结束（generating=false）后才轮到兜底条。 */}
      {autoTocFix > 0 && generating && phase !== 'content' && (
        <div className="proposal-anim-fade flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/5 px-3 py-1 text-[11px] text-sky-600">
          <InfoIcon className="shrink-0" />
          <span className="flex-1">AI 跳过了目录确认，正在自动重新整理目录…</span>
        </div>
      )}

      {/* 跳阶提示（方案二·软化）：默认静默自动补救（见上方 effect），不再暴露「AI 跳过目录」
          这种内部状态机斗争。仅当自动补救两次仍跳阶（autoTocFix>=2）才露一行温和兜底 + 手动入口。
          用天蓝（info）而非琥珀（warning）：文案是「正在整理目录，请稍候」属进行中信息、非警告，
          且与下方「资料缺失」琥珀条区分开，避免两条同色彩条叠在一起难辨（design-review F3）。 */}
      {stageSkip && phase !== 'content' && autoTocFix >= 2 && (
        <div className="proposal-anim-fade flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/5 px-3 py-1 text-[11px] text-sky-600">
          <InfoIcon className="shrink-0" />
          <span className="flex-1">正在整理目录，请稍候…若反复未生成，可手动重试。</span>
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={generating}
            onClick={regenerateToc}
            title={generating ? 'AI 生成中，请稍候' : '让 AI 重新只生成目录'}
          >
            重新生成目录
          </button>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={clearStageSkip}
            title="忽略此提示"
            aria-label="忽略此提示"
          >
            <XIcon />
          </button>
        </div>
      )}

      {/* 草稿写盘失败提示（P3-3）已从此处的满宽红条降格进底部状态栏：它是持续状态而非
          事件，放顶部会把文档区往下顶、和跳阶/缺料彩条叠成一堵墙（design-review F3 同源）。 */}

      {/* 资料缺失清单（P3-2 阶段一·让缺失可见）：AI 遇知识库查不到的内容时不编造，而在正文里
          标「⚠️ 资料缺失：…」；这些缺口原本散落正文、易被忽略，这里集中汇成一张清单暴露在顶部。
          仅在有缺口时出现；默认收起为一行摘要，点开看每处缺口在哪一章、缺什么。后续阶段二会在每条
          缺口旁加「补充资料」入口做定点续写——此处先把缺失变可见。 */}
      {gaps.length > 0 && (
        <div className="proposal-anim-fade border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => setGapsOpen((v) => !v)}
            title="知识库未覆盖、AI 未编造的缺口；待补料后续写"
          >
            <AlertTriangleIcon className="shrink-0" />
            <span className="font-medium">资料缺失 {gaps.length} 处</span>
            <span className="text-amber-600/70 dark:text-amber-400/70">
              — 知识库没查到、AI 未编造，待补料
            </span>
            <span className="flex-1" />
            <span className="inline-flex items-center gap-0.5 text-amber-600/80 dark:text-amber-400/80">
              {gapsOpen ? (
                <>
                  收起
                  <ChevronUpIcon />
                </>
              ) : (
                <>
                  展开
                  <ChevronDownIcon />
                </>
              )}
            </span>
          </button>
          {gapsOpen && (
            <ul className="mt-1.5 max-h-60 space-y-1 overflow-auto">
              {gaps.map((g, i) => {
                const key = `${g.sectionId}:${i}`
                return (
                  <li
                    key={key}
                    className="rounded-md border border-amber-500/30 bg-background/60 px-2 py-1"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-muted-foreground">{g.title}</div>
                        <div className="text-foreground/90">{g.desc}</div>
                      </div>
                      {/* 补料入口（改版）：草稿是【只读页】，不在这里就地收资料，也【不会立刻让 AI 跑】。
                          点按钮只把「这一章缺这处」记下、并把焦点移到左侧输入框：输入框上方随即弹一条提示条
                          告诉你缺什么、请你在下方输入这段资料原文（或指认知识库文件）并发送。你发送后 AI 才
                          运行，一轮内把资料并进去、只重写这一章、删掉缺口标记。任何增删改都回对话框执行。
                          流式中禁用（避免和进行中那轮叠发）。 */}
                      <button
                        type="button"
                        className="shrink-0 rounded border border-amber-500/40 px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-500/10 disabled:opacity-40 dark:text-amber-400"
                        disabled={generating}
                        title={
                          generating
                            ? 'AI 生成中，请稍候'
                            : '去左侧对话框补充这处资料——点后在输入框里贴入资料并发送，AI 才会据此续写这一章'
                        }
                        onClick={() => startProposalGapFill(g.sectionId, g.desc)}
                      >
                        去对话框补充
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* 导出反馈：浮动 toast（design-review F3）。原先是顶部一条满宽彩色横幅，会和跳阶/缺料/
          写盘失败几条彩条一起把文档顶下去、叠成一堵墙；它本就是 4s 自动消失的瞬时反馈，最适合
          从布局流里抽走。改为底部居中浮层：不占布局、不挤文档，pointer-events-none 全程不挡点击。
          自动消失仍由上方 useEffect 的 4s 计时器负责。 */}
      {exportMsg && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div
            className={
              'proposal-anim-pop flex max-w-[90%] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] shadow-lg backdrop-blur ' +
              (exportMsg.tone === 'ok'
                ? 'border-emerald-500/40 bg-background/95 text-emerald-600'
                : exportMsg.tone === 'err'
                  ? 'border-rose-500/40 bg-background/95 text-rose-600'
                  : 'border-border bg-background/95 text-muted-foreground')
            }
            title={exportMsg.text}
          >
            {exportMsg.tone === 'ok' ? (
              <CheckIcon className="shrink-0" />
            ) : exportMsg.tone === 'err' ? (
              <AlertTriangleIcon className="shrink-0" />
            ) : (
              <InfoIcon className="shrink-0" />
            )}
            <span className="truncate">{exportMsg.text}</span>
          </div>
        </div>
      )}

      {/* 知识库行（重设计）：加「知识库」语义前缀——产品 chips 裸露一行不解释自己是什么，
          标签先立住「这些 chip 决定 AI 从哪里取料」；chip 换 accent 淡染底（原 bg-muted 灰
          底与画布同色系、存在感过弱）；召回预览/语义搜索收到右端（ml-auto）。
          chip 本身语义不变：方案首发时由 matchProducts 写入，可删纠错，空集 → 整库兜底。 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground">
          <BookIcon />
          知识库
        </span>
        {products.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">未识别到产品，AI 将自行在知识库定位</span>
        ) : (
          products.map((p) => (
            <span
              key={`${p.productLine} ${p.product}`}
              className="inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {p.product}
              {/* 删除 ✕ 仅编辑态：预览页头部只做展示、不做修改（用户要求 2026-07-08）。 */}
              {mode === 'edit' && (
                <button
                  type="button"
                  aria-label={`移除 ${p.product}`}
                  className="grid size-3.5 place-items-center rounded-sm text-muted-foreground hover:bg-accent/20 hover:text-foreground"
                  onClick={() =>
                    setProducts(
                      products.filter((x) => !(x.productLine === p.productLine && x.product === p.product))
                    )
                  }
                >
                  <XIcon />
                </button>
              )}
            </span>
          ))
        )}
        {/* 交互入口（添加产品 + 检索工具）仅编辑态可见：预览页头部只做展示、不做修改，
            要调整产品或探查检索，请回到编辑态、或直接找 AI 对话（用户要求 2026-07-08）。 */}
        {mode === 'edit' && (
          <>
        {/* + 添加产品（方案三·chip 可增）：从 KB 索引列出全部可选产品，补 matchProducts 漏识别的，
            把「用哪些产品写」的决策权交还用户。空集时也显示，便于零识别时手动指定。
            ui/dropdown-menu 基件（2026-07-08 统一）：开合/outside-dismiss 归 radix，
            打开瞬间经 onOpenChange 惰加载 KB 产品清单（原 onClick 逻辑原样搬入）。
            item 收紧到 py-1 + 12px——这是几十项的选择列表不是动作菜单，密度优先。 */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) void loadKbProducts()
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-accent hover:text-accent"
              title="手动添加知识库里的产品"
            >
              + 添加产品
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-72">
            {(() => {
              const picked = new Set(products.map((p) => `${p.productLine}::${p.product}`))
              const avail = allKbProducts.filter(
                (p) => !picked.has(`${p.productLine}::${p.product}`)
              )
              if (avail.length === 0) {
                return (
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    没有更多可添加的产品（或知识库索引为空）
                  </div>
                )
              }
              return avail.map((p) => (
                <DropdownMenuItem
                  key={`${p.productLine}::${p.product}`}
                  className="py-1 text-[12px]"
                  onSelect={() => {
                    setProducts([...products, p])
                  }}
                  title={`${p.productLine} / ${p.product}`}
                >
                  <span className="min-w-0 truncate">
                    <span className="text-muted-foreground">{p.productLine} / </span>
                    {p.product}
                  </span>
                </DropdownMenuItem>
              ))
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 检索工具收右端：与左侧「产品集」分区（chips 是输入、工具是探查），展开中的
            工具亮 accent 淡染底作 on 态——原 dashed 描边样式与「+ 添加产品」同形，会被
            误读成又一个添加入口。 */}
        <span className="ml-auto flex items-center gap-0.5">
          {/* 召回预览开关（方案三·只读）：看知识库针对当前产品/关键词会召回哪些原文片段。 */}
          <button
            type="button"
            className={
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ' +
              (retrievalOpen
                ? 'bg-accent/10 text-accent'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground')
            }
            onClick={() => setRetrievalOpen((v) => !v)}
            title="预览知识库召回片段"
          >
            <SearchIcon /> 召回预览
          </button>
          {/* 语义搜索开关（Task 8）：混合向量+BM25，与召回预览 BM25 词面互补。 */}
          <button
            type="button"
            className={
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ' +
              (semanticSearchOpen
                ? 'bg-accent/10 text-accent'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground')
            }
            onClick={() => setSemanticSearchOpen((v) => !v)}
            title="语义搜索知识库（向量+BM25）"
          >
            <SearchIcon /> 语义搜索
          </button>
        </span>
          </>
        )}
      </div>

      {/* 召回预览面板（方案三·只读）：输关键词 → 显示当前产品集下知识库 top 召回片段。让「检索
          命中什么」对用户可见，不再只靠正文红条反推。 */}
      {retrievalOpen && mode === 'edit' && (
        <div className="proposal-anim-fade space-y-1.5 border-b border-border px-3 py-2">
          {/* 说明文字（方案三）：先讲清这是什么、不影响生成，降低「召不回是不是坏了」的误会。 */}
          <div className="text-[11px] leading-snug text-muted-foreground">
            预览知识库会为关键词从<b>当前选中的产品</b>里挑出哪些原文片段——只读探查，不写盘、不影响实际生成。
            按词面匹配（BM25），关键词尽量贴近资料里的说法。
          </div>
          <div className="flex items-center gap-1">
            <input
              value={peekQuery}
              onChange={(e) => setPeekQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runPeek()
              }}
              placeholder={
                products.length === 0
                  ? '先添加产品，再输关键词预览召回…'
                  : '输入关键词，预览知识库召回片段…'
              }
              className="h-7 flex-1 rounded-md border border-border bg-card px-2 text-[12px] text-foreground outline-none focus:border-accent"
            />
            <button
              type="button"
              className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
              disabled={peekLoading || !peekQuery.trim() || products.length === 0}
              onClick={() => void runPeek()}
            >
              {peekLoading ? '检索中…' : '预览'}
            </button>
          </div>
          {peekResults !== null &&
            (peekResults.length === 0 ? (
              // 空态分三种：null = IPC 调用抛错（多半 dev 没整体重启、新通道还没注册）；
              // 0 = 产品/索引没对上料（不是检索没命中），引导重选产品；>0 = 有料但词面没命中，引导换词。
              <div className="text-[11px] leading-snug text-muted-foreground">
                {peekScanned === null
                  ? '召回服务没响应 —— 召回预览是新功能，需要把 dev 完整重启一次（改了主进程/preload）才会生效。'
                  : peekScanned === 0
                    ? '这些产品在知识库里没有对应的资料文件 —— 多半是产品和索引对不上：删掉上面的产品 chip，用「+ 添加产品」重新从列表里选。'
                    : `扫描了 ${peekScanned} 个资料文件，但没匹配到这个关键词。换个更贴近资料原文的说法再试（按词面匹配，同义词/英文缩写可能召不回）。`}
              </div>
            ) : (
              <div className="max-h-56 space-y-1.5 overflow-auto">
                {peekResults.map((p, i) => (
                  <div key={i} className="rounded-md border border-border bg-card/50 px-2 py-1.5">
                    <div className="mb-0.5 text-[11px] font-medium text-accent">《{p.title}》</div>
                    <div className="max-h-24 overflow-hidden whitespace-pre-wrap text-[11px] leading-snug text-foreground/80">
                      {p.text}
                    </div>
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}

      {/* 语义搜索面板（Task 8）：混合向量+BM25 检索，与召回预览（BM25 词面）互补。
          结果卡含复制引用（剪贴板）+ 打开文档（openPath）。staleIndex → 提示重建。 */}
      {semanticSearchOpen && mode === 'edit' && (
        <KbSemanticSearchPanel products={products} />
      )}

      {/* 分节文档区：ProposalPaper（连续长纸 + 悬停工具条 + 就地编辑）与 ProposalPreview
          （A4 分页预览，与导出 Word 同源）两者【都常驻挂载】，仅用 CSS hidden 切显隐——
          不再 `mode==='edit' ? <A/> : <B/>` 条件渲染（评审 #2）：那会让 ProposalPreview 每次
          切换都卸载、其 lastRendered 缓存随之销毁，「来回切不重复生成」的优化形同虚设、
          每次切预览都从零跑一遍 IPC 生成 docx + 渲染。常驻后缓存存活：内容没变时切回预览
          即时复现已渲染的页面。预览常驻于后台时不能空跑——传 active 闸，非激活不渲染
          （见 ProposalPreview）。 */}
      {showOnboarding ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
          <div className="w-full max-w-xs rounded-2xl border border-border bg-card/60 p-6 text-[13px]">
            <div className="mb-4 flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <span aria-hidden>📄</span> 写方案分三步走
            </div>
            <ol className="mb-4 space-y-1.5 text-muted-foreground">
              <li>① 封面 <span className="text-foreground/50">→ 你确认</span></li>
              <li>② 目录 <span className="text-foreground/50">→ 你确认</span></li>
              <li>③ 正文 <span className="text-foreground/50">→ 逐章生成</span></li>
            </ol>
            <p className="mb-3 text-muted-foreground">每步 AI 会停下来等你，点“确认”才继续。</p>
            <p className="mb-4 text-xs text-muted-foreground/70">↓ 在下方输入框描述你的方案需求</p>
            <button
              type="button"
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={dismissOnboarding}
            >
              知道了
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'edit' ? '' : 'hidden')}>
            <ProposalPaper />
          </div>
          <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'preview' ? '' : 'hidden')}>
            <ProposalPreview active={mode === 'preview'} />
          </div>
        </>
      )}

      {/* 底部状态栏（重设计新增）：保存状态 + 文档体量 + 「真预览」角标。
          - 写盘失败提示从顶部满宽红条降格到这里的常驻红字（title 保留完整说明），
            写盘正常且有内容时显示「已自动保存」绿点，给持续性安心感。
          - 「真预览 · 与导出的 Word 逐像素一致」原是漂浮在预览内容上方的 pill，
            遮文档且与画布争层级；它是常驻元信息，归位状态栏、文档区还给文档。 */}
      {/* 空草稿时整条隐藏：没有保存/体量可言，孤零零一个「真预览」pill 反而像残留物。 */}
      {sections.length > 0 && (
        <div className="flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
          {sections.length > 0 &&
            (draftSaveFailed ? (
              <span
                className="inline-flex items-center gap-1.5 text-rose-500"
                title="草稿写盘失败（磁盘空间/权限/路径问题）。你的修改仍在内存，切换会话或关闭可能丢失；建议先导出备份，问题排除后改动会在下次自动保存时落盘。"
              >
                <AlertTriangleIcon className="shrink-0" />
                草稿未保存（写盘失败）——建议先导出备份
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5" title="草稿改动会自动保存到本机">
                <span className="size-[5px] shrink-0 rounded-full bg-brand" />
                已自动保存
              </span>
            ))}
          {sections.length > 0 && (
            <span className="whitespace-nowrap">
              {sections.length} 节 · 共 {charCount} 字
            </span>
          )}
          {mode === 'preview' && (
            <span className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[10px] text-brand">
              <CheckIcon />
              真预览 · 与导出的 Word 逐像素一致
            </span>
          )}
        </div>
      )}

      {/* 样式模板弹窗（重设计 A：纯调样式、非导出入口）：由「导出 ▾」下拉里的「调整样式模板…」
          打开，点「应用样式」把 draft 提交进 store，之后导出走顶栏下拉。 */}
      <ProposalStyleModal open={styleModalOpen} onClose={() => setStyleModalOpen(false)} />
    </div>
  )
}
