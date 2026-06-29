import { useEffect, useState } from 'react'
import { useProposalStore, useProposalWorkspace } from '../../stores/proposal'
import { useProposalStyleStore } from '../../stores/proposalStyle'
import { useChatStore } from '../../stores/chat'
import type { ProposalExportFormat } from '@shared/ipc-channels'
import type { ProposalStyleConfig } from '@shared/proposalStyle'
import {
  buildProposalMarkdown,
  buildProposalMetric,
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END
} from '@shared/proposal'
import { sendProposalStageMessage } from '../../lib/sendProposalStageMessage'
import { extractMermaidBlocks, renderMermaidImageMap } from '../../lib/mermaidRender'
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
  // 阶段门拦截提示：AI 越过「目录确认门」直接吐正文被 appendSections 拦下时非空。订阅以
  // 驱动下方红条提示。clearStageSkip 是稳定引用，从 getState 取、不订阅。
  const stageSkip = useProposalStore((s) => s.stageSkip)
  const { clearStageSkip } = useProposalStore.getState()
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
  // 「新建」二次确认：清空是破坏性的（丢掉整份草稿），故点一下先morph成确认条，再点才真清。
  // 内联确认而非 modal——与本工具栏其余轻量控件一致，不为一个动作引一层弹窗。
  const [confirmingNew, setConfirmingNew] = useState(false)
  // 「导出 Word」改为先弹样式模板面板（选模板 + 实时预览 + 微调），用户在弹窗里点导出
  // 才真正落盘。.md 仍直出（纯文本无样式）。
  const [styleModalOpen, setStyleModalOpen] = useState(false)
  // 跳阶自动补救计数（方案二·软化 stageSkip）：AI 越过目录门吐正文被阶段门拦时，静默自动重发
  // 「只生成目录」最多两次，不再弹红条暴露内部状态机。两次仍跳阶才露一行温和提示兜底。
  const [autoTocFix, setAutoTocFix] = useState(0)

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

  // 阶段一→二：先把 phase 推到 toc（驱动阶段条/按钮 UI），再让 AI 生成目录大纲。
  // 归档不再靠 phase 而靠哨兵类型，故消息里点名【目录哨兵】，让 AI 用对那对标记。
  function confirmCover(): void {
    clearStageSkip()
    advancePhase('toc')
    void sendProposalStageMessage(
      `封面已确认。请进入【阶段二·目录】：参考知识库里该产品的资料结构与售前方案常见章节，给出一份章节目录大纲（有序列表逐章列出），用方案【目录】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.toc} … ${PROPOSAL_DRAFT_END.toc}）。`
    )
  }
  // 跳阶补救：AI 在目录阶段直接吐正文被阶段门拦下（stageSkip 非空）时，重发「只生成目录」
  // 指令把 AI 拉回目录。phase 已是 toc（confirmCover 推进过），不再 advancePhase。
  function regenerateToc(): void {
    clearStageSkip()
    void sendProposalStageMessage(
      `上一轮直接写了正文、跳过了目录。请【先只输出章节目录大纲】（有序列表逐章列出），用方案【目录】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.toc} … ${PROPOSAL_DRAFT_END.toc}）；目录经我确认前不要写正文。`
    )
  }
  // 阶段二→三：把已确认的目录正文带给 AI（目录驱动正文），phase 推到 content。
  function confirmToc(): void {
    clearStageSkip()
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
              className="mr-1 rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
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
          {/* 导出 Word：一键直出，用已生效样式（useProposalStyleStore，跨会话持久），不再
              强制过样式弹窗（方案二·导出一键化）。要调样式/导出 .md 走右侧 ⚙。 */}
          <button
            className="rounded bg-accent px-2 py-0.5 text-white hover:opacity-90 disabled:opacity-50"
            disabled={exporting}
            onClick={() => void handleExport('docx', useProposalStyleStore.getState().config)}
          >
            {exporting ? '导出中…' : '导出 Word'}
          </button>
          {/* 样式 / 更多导出：开样式弹窗微调模板，.md 也归位在弹窗里（从主栏移出）。 */}
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => setStyleModalOpen(true)}
            title="样式模板与更多导出选项"
          >
            ⚙
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

      {/* 跳阶提示（方案二·软化）：默认静默自动补救（见上方 effect），不再暴露「AI 跳过目录」
          这种内部状态机斗争。仅当自动补救两次仍跳阶（autoTocFix>=2）才露一行温和兜底 + 手动入口。 */}
      {stageSkip && phase !== 'content' && autoTocFix >= 2 && (
        <div className="flex items-center gap-2 border-b border-border bg-amber-500/5 px-3 py-1 text-[11px] text-amber-600">
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
          >
            ✕
          </button>
        </div>
      )}

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
        onExportMd={() => void handleExport('md')}
      />
    </div>
  )
}
