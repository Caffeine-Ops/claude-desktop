import { useEffect, useState } from 'react'
import { useProposalStore, type ProposalSection } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { reviseProposalSection } from '../../lib/sendProposalSectionRevision'
import type { ProposalKind } from '@shared/proposal'
import { splitBlocks, joinBlocks } from '@shared/proposalBlocks'
import {
  RotateCwIcon,
  PlusIcon,
  MinusIcon,
  CheckIcon,
  PencilIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
  AlertTriangleIcon,
  InfoIcon
} from './proposalIcons'

/**
 * 引用落地校验（#1）的节级提示条。仅对正文节（content）渲染：
 *  - verification 尚未回填（undefined）→ 不渲染（校验中，避免闪烁）。
 *  - degraded → 灰「未校验」（索引缺失/异常，≠「无编造」，绝不报绿）。
 *  - 有 file-not-found / unsupported → 红，逐文件列出，提示人工核对。
 *  - citedFileCount===0 → 红「本段未引用任何来源」。
 *  - 全 supported 且有引用 → 淡绿「N 处来源已核对」，给正向反馈。
 * 封面/目录节不标来源（提示词规则 3），一律不渲染。
 */
function renderVerification(sec: ProposalSection, generating: boolean): React.JSX.Element | null {
  if (sec.kind !== 'content') return null
  const v = sec.verification
  if (!v) return null
  // 「据来源修正」：把发现的溯源问题接回 AI——只依据所引《来源》原文重写本节（方案一·闭环）。
  // 流式中禁用，避免与进行中的那轮叠发。措辞产品化：不再向用户暴露 trigram/重叠率/索引等工程词。
  const fixBtn = (
    <button
      className="ml-1 whitespace-nowrap underline hover:text-rose-800 disabled:opacity-40"
      disabled={generating}
      onClick={() => void reviseProposalSection(sec.id, 'fixSource')}
    >
      据来源修正
    </button>
  )
  if (v.degraded) {
    return (
      <div className="mb-1 rounded bg-neutral-500/10 px-1.5 py-0.5 text-[11px] text-neutral-500">
        来源核对暂不可用
      </div>
    )
  }
  if (v.citedFileCount === 0) {
    return (
      <div className="mb-1 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
        <AlertTriangleIcon className="mt-0.5 shrink-0" />
        <span>本段未标注来源，建议补充或核对是否凭空生成{fixBtn}</span>
      </div>
    )
  }
  const notFound = [...new Set(v.verdicts.filter((d) => d.status === 'file-not-found').map((d) => d.file))]
  const unsupported = [...new Set(v.verdicts.filter((d) => d.status === 'unsupported').map((d) => d.file))]
  const ungroundedImgs = [...new Set((v.imageVerdicts ?? []).filter((d) => d.status === 'ungrounded').map((d) => d.path))]
  // 用户补料（P3-2 阶段二）：引用《用户补充资料》的条数（按出现处计，可多处）。非 KB、不红
  // 不绿，单独一行中性蓝条明示「据你补充的资料、不在知识库、请自行确认」，在红/绿态下都附带显示。
  const suppliedCount = v.verdicts.filter((d) => d.status === 'user-supplied').length
  // 绿灯只数【真 KB 文件】（排除补料保留名后去重）——补料无从 trigram 核对，不该混进「已核对」计数。
  const kbFileCount = new Set(
    v.verdicts.filter((d) => d.status !== 'user-supplied').map((d) => d.file)
  ).size
  const suppliedLine =
    suppliedCount > 0 ? (
      <div className="flex items-start gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-600">
        <InfoIcon className="mt-0.5 shrink-0" />
        <span>有 {suppliedCount} 处据你补充的资料撰写（不在知识库，请自行确认准确性）</span>
      </div>
    ) : null
  if (notFound.length === 0 && unsupported.length === 0 && ungroundedImgs.length === 0) {
    return (
      <div className="mb-1 space-y-0.5">
        {/* KB 来源全部核对通过才报绿；补料不参与「已核对」绿灯（它无从 trigram 核对），单列蓝条。 */}
        {kbFileCount > 0 && (
          <div className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600">
            <CheckIcon className="shrink-0" />
            {kbFileCount} 处来源已核对
          </div>
        )}
        {suppliedLine}
      </div>
    )
  }
  return (
    <div className="mb-1 space-y-0.5">
      {unsupported.length > 0 && (
        <div className="flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          <AlertTriangleIcon className="mt-0.5 shrink-0" />
          <span>这段内容在{unsupported.map((f) => `《${f}》`).join('、')}里没找到对应依据，建议核对或{fixBtn}</span>
        </div>
      )}
      {notFound.length > 0 && (
        <div className="flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          <AlertTriangleIcon className="mt-0.5 shrink-0" />
          <span>引用的{notFound.map((f) => `《${f}》`).join('、')}不在当前知识库，来源待确认</span>
        </div>
      )}
      {ungroundedImgs.length > 0 && (
        <div className="flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          <AlertTriangleIcon className="mt-0.5 shrink-0" />
          <span>有 {ungroundedImgs.length} 张配图与本段来源不符，建议替换</span>
        </div>
      )}
      {suppliedLine}
    </div>
  )
}

/**
 * 编辑态：一张连续的 A4 宽长纸，分节无缝拼接、向下滚动不分页。
 * 保留现有「哨兵→分节」数据模型，仅把卡片堆叠换皮成纸面：
 *  - 去卡片边框/底色，节正文用 AssistantMarkdown 渲染；白纸黑字靠 .proposal-paper
 *    作用域覆盖前景 token（见 index.css），无需逐元素 !important。
 *  - 悬停某节 → 右侧外边距浮出工具条（编辑/上移/下移/删除），不占正文宽度、不破坏纸面。
 *  - 单节编辑仍是 editingId 单选 + textarea，但 textarea 白底衬线、无框，就地改字。
 *
 * 工具条按钮用显式中性色（非主题 token）——因为 .proposal-paper 把 token 覆盖成纸墨色，
 * 若按钮也用 text-foreground 会变成白纸上的浅色控件、对比过低。
 */
export function ProposalPaper(): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  // 这三个 action 是 zustand 稳定引用、永不变——从 getState() 一次性取出、不订阅，
  // 避免每次 store 更新（如流式 append 新节）都白跑一遍 selector。
  const { updateSection, removeSection, moveSection } = useProposalStore.getState()
  const proposalSid = useProposalStore((s) => s.sessionId)
  const generating = useChatStore((s) =>
    proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  // 块级就地手改（命中「改动粒度太粗」）：双击某块 → 只有那一块变 textarea。editingId（整节
  // 源码逃生舱）与 editingBlock 互斥——进整节源码时清块编辑，反之亦然。blockDraft 是就地草稿，
  // 失焦/⌘↵ 提交、Esc 取消；提交时替换该块 → joinBlocks 重拼 → updateSection（走现有防抖写盘）。
  const [editingBlock, setEditingBlock] = useState<{ sectionId: string; blockIndex: number } | null>(null)
  const [blockDraft, setBlockDraft] = useState('')

  // 提交块草稿：把 sec 的第 blockIndex 块替换成 blockDraft，重拼回整节 markdown。
  function commitBlock(sec: ProposalSection, blockIndex: number): void {
    const blocks = splitBlocks(sec.markdown)
    if (blockIndex < 0 || blockIndex >= blocks.length) {
      setEditingBlock(null)
      return
    }
    blocks[blockIndex] = blockDraft
    updateSection(sec.id, joinBlocks(blocks))
    setEditingBlock(null)
  }
  // 删除二次确认（design-review F5）：删除不可逆，且在窄工具条里紧挨「下移」键易误触。点一下
  // 不立即删，而是把该节的删除键「武装」成红底确认态，再点才真删；3 秒无操作自动撤销，避免卡在
  // 武装态。复用 DocPanel「清空草稿」同款就地两步确认，不为单节删除引一层 modal。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  useEffect(() => {
    if (!confirmDeleteId) return
    const id = setTimeout(() => setConfirmDeleteId(null), 3000)
    return () => clearTimeout(id)
  }, [confirmDeleteId])

  const toolBtn =
    'grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-neutral-600 hover:border-accent hover:text-accent disabled:opacity-30'

  // 中文区名：每个 kind 对应面板里显示的分区标题。
  const KIND_LABEL: Record<ProposalKind, string> = {
    cover: '封面',
    toc: '目录',
    content: '正文'
  }
  // 保持 sections 原有顺序的前提下按 kind 切组（同 kind 连续，故顺序天然分块）。
  const groups: Array<{ kind: ProposalKind; items: typeof sections }> = []
  for (const sec of sections) {
    const last = groups[groups.length - 1]
    if (last && last.kind === sec.kind) last.items.push(sec)
    else groups.push({ kind: sec.kind, items: [sec] })
  }

  // 单节渲染辅助：参数用「全局下标」定位邻居。上移/下移按 kind 边界禁用——moveSection 只
  // 在【同 kind 内】交换（跨区段移动被 no-op，见其注释），故按钮可用性必须与之精确对齐：
  // 邻居同 kind 才亮、否则置灰。原先按「全局首尾」判断（globalIndex===0 / ===length-1）会让
  // 正文区第一章的「上移」亮着却点击无效（邻居是目录、被 moveSection 静默 no-op，P1-3 缺陷）。
  const renderSection = (sec: (typeof sections)[number], globalIndex: number): React.JSX.Element => {
    const canMoveUp = globalIndex > 0 && sections[globalIndex - 1].kind === sec.kind
    const canMoveDown =
      globalIndex < sections.length - 1 && sections[globalIndex + 1].kind === sec.kind
    return (
    <section key={sec.id} className="group relative py-0.5">
      {/* 节级工具条：停靠在纸张右侧内边距里（.proposal-paper 的 px-[clamp(28px,6%,76px)]，下限
          28px，刚好容下 24px 的按钮列）。旧值 -right-[58px] 探到纸外，窄面板（外边距仅 24px）会
          溢出、被外层 overflow-auto 裁掉或触发横向滚动；改 -right-[26px] 锚进纸内右 padding，
          任意面板宽都不溢出。可见性：默认透明，hover 本节或键盘聚焦其中按钮（focus-within）时淡入
          ——用 opacity 而非 hidden，键盘用户才能 Tab 到并唤出、且能做过渡；透明态 pointer-events-none
          不拦纸面点击（design-review F4）。 */}
      <div className="pointer-events-none absolute -right-[26px] top-1.5 flex flex-col gap-1 opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        {/* AI 修订组：仅正文节（封面/目录无修订语义）。点击发起【整节替换】式重写，流式中禁用。 */}
        {sec.kind === 'content' && (
          <>
            <button
              className={toolBtn}
              disabled={generating}
              onClick={() => void reviseProposalSection(sec.id, 'rewrite')}
              title="AI 重写本章"
              aria-label="AI 重写本章"
            >
              <RotateCwIcon />
            </button>
            <button
              className={toolBtn}
              disabled={generating}
              onClick={() => void reviseProposalSection(sec.id, 'expand')}
              title="AI 展开（更详尽）"
              aria-label="AI 展开本章"
            >
              <PlusIcon />
            </button>
            <button
              className={toolBtn}
              disabled={generating}
              onClick={() => void reviseProposalSection(sec.id, 'shorten')}
              title="AI 精简（去冗余）"
              aria-label="AI 精简本章"
            >
              <MinusIcon />
            </button>
          </>
        )}
        <button
          className={toolBtn}
          onClick={() => {
            setEditingBlock(null)
            setEditingId(editingId === sec.id ? null : sec.id)
          }}
          title={editingId === sec.id ? '完成整节源码编辑' : '编辑整节 Markdown 源码（逃生舱）'}
          aria-label={editingId === sec.id ? '完成' : '编辑整节源码'}
        >
          {editingId === sec.id ? <CheckIcon /> : <PencilIcon />}
        </button>
        <button
          className={toolBtn}
          disabled={!canMoveUp}
          onClick={() => moveSection(sec.id, 'up')}
          title={canMoveUp ? '上移' : '已是本区段第一节，不能跨区段上移'}
          aria-label="上移"
        >
          <ArrowUpIcon />
        </button>
        <button
          className={toolBtn}
          disabled={!canMoveDown}
          onClick={() => moveSection(sec.id, 'down')}
          title={canMoveDown ? '下移' : '已是本区段最后一节，不能跨区段下移'}
          aria-label="下移"
        >
          <ArrowDownIcon />
        </button>
        {/* 分隔线：把不可逆的「删除」与上方移动/编辑键分组隔开，降低误触（design-review F5）。 */}
        <div className="my-0.5 h-px w-full bg-neutral-200" />
        {confirmDeleteId === sec.id ? (
          <button
            className="grid size-6 place-items-center rounded-md border border-rose-500 bg-rose-500 text-[12px] text-white"
            onClick={() => {
              if (editingId === sec.id) setEditingId(null)
              removeSection(sec.id)
              setConfirmDeleteId(null)
            }}
            title="再次点击确认删除（或点别处、稍候自动取消）"
            aria-label="确认删除"
          >
            <CheckIcon />
          </button>
        ) : (
          <button
            className="grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-rose-500 hover:border-rose-400"
            onClick={() => setConfirmDeleteId(sec.id)}
            title="删除本节（需再次点击确认）"
            aria-label="删除"
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {sec.truncated && (
        <div className="mb-1 flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600">
          <span>这一段较长，生成被中断，内容可能不完整。</span>
          {/* 续写只对正文节有意义（reviseProposalSection 对非 content 直接 no-op）；封面/目录极少
              截断，若真发生则只提示不给按钮，避免一个点了没反应的死按钮。 */}
          {sec.kind === 'content' && (
            <button
              className="whitespace-nowrap underline hover:text-amber-800 disabled:opacity-40"
              disabled={generating}
              onClick={() => void reviseProposalSection(sec.id, 'resume')}
            >
              继续写完
            </button>
          )}
        </div>
      )}

      {renderVerification(sec, generating)}

      {editingId === sec.id ? (
        // 整节源码逃生舱：改坏的表格、批量替换等场景。默认不再是主路径。
        <textarea
          className="min-h-[120px] w-full resize-y rounded-sm bg-accent/5 font-mono text-[13px] leading-[1.8] text-[#1d1d1f] outline-none"
          value={sec.markdown}
          autoFocus
          onChange={(e) => updateSection(sec.id, e.target.value)}
        />
      ) : (
        // 逐块渲染：DOM 块索引 = splitBlocks 下标（Task 5 选区映射靠 data-block-index）。
        // 双击某块 → 只有那一块进就地编辑；其余块照常渲染（含来源高亮）。
        splitBlocks(sec.markdown).map((blk, bi) =>
          editingBlock && editingBlock.sectionId === sec.id && editingBlock.blockIndex === bi ? (
            <textarea
              key={bi}
              className="my-1 min-h-[64px] w-full resize-y rounded-sm bg-accent/5 font-serif text-[14px] leading-[1.95] text-[#1d1d1f] outline-none"
              value={blockDraft}
              autoFocus
              onChange={(e) => setBlockDraft(e.target.value)}
              onBlur={() => commitBlock(sec, bi)}
              onKeyDown={(e) => {
                // ⌘↵/Ctrl↵ 提交；Esc 取消（不写回）。普通回车留给多行输入。
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  commitBlock(sec, bi)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingBlock(null)
                }
              }}
            />
          ) : (
            <div
              key={bi}
              data-section-id={sec.id}
              data-block-index={bi}
              className="rounded-sm hover:bg-accent/[0.03]"
              // 双击进块级就地手改：读该块源码进草稿、清整节源码逃生舱（互斥）。生成中禁改。
              onDoubleClick={() => {
                if (generating) return
                setEditingId(null)
                setBlockDraft(blk)
                setEditingBlock({ sectionId: sec.id, blockIndex: bi })
              }}
            >
              <AssistantMarkdown text={blk} highlightCitations />
            </div>
          )
        )
      )}
    </section>
    )
  }

  return (
    <div className="proposal-canvas flex-1 overflow-auto py-7">
      <div className="proposal-paper mx-auto w-[min(794px,calc(100%-48px))] rounded-sm bg-white px-[clamp(28px,6%,76px)] py-16 text-[#1d1d1f] shadow-[0_1px_0_rgba(0,0,0,0.04),0_12px_34px_rgba(0,0,0,0.30)]">
        {sections.length === 0 ? (
          <div className="text-center text-[13px] text-neutral-400">
            {generating ? '方案正在生成，完成的部分会陆续出现在这里…' : '等待 AI 起草…'}
          </div>
        ) : (
          (() => {
            let running = -1 // 跨组累计全局下标，喂给 renderSection 做首尾禁用判断
            return groups.map((g, gi) => (
              // key 用组下标而非 g.kind：组下标在本次渲染中永远唯一且与 sections 顺序一致。
              // （moveSection 现已限制为同 kind 组内交换，sections 始终按 kind 连续、每 kind
              //  至多一组，故 g.kind 理论上也唯一；仍用组下标作 key，对未来放宽移动规则更稳健。）
              <div key={gi} className="mb-2">
                <div className="mb-1 border-b border-neutral-200 pb-0.5 text-[11px] font-medium tracking-wide text-neutral-400">
                  {KIND_LABEL[g.kind]}
                </div>
                {g.items.map((sec) => {
                  running += 1
                  return renderSection(sec, running)
                })}
              </div>
            ))
          })()
        )}
      </div>
    </div>
  )
}
