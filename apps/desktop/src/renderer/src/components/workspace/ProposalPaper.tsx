import { useEffect, useRef, useState } from 'react'
import { useProposalStore, type ProposalSection } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { reviseProposalSection } from '../../lib/sendProposalSectionRevision'
import { SelectionAiBubble } from './SelectionAiBubble'
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

// 判断一个块是否为「段落型」（渲染成 <p>，会被 AssistantMarkdown 的 <p last:mb-0> 清掉底距、需补
// mb-3）。标题/列表/表格/围栏自带外边距，返回 false 不补（避免叠加撑大间距，review V9）。图片行
// ![…] 属段落内容 → 返回 true。判据与 proposalBlocks.splitBlocks 的块首前缀一致。
function blockNeedsGap(blk: string): boolean {
  // 直接测 blk（不 trimStart）：与 splitBlocks 判块首前缀的方式严格一致——它也测原始行、无前导空格容忍，
  // 故缩进的 # / ``` 在 splitBlocks 眼里本就不算标题/围栏，这里同样按段落型处理，判据不分叉（review 复审 Minor#2）。
  return !(
    /^#{1,6}\s/.test(blk) || // 标题（同 HEADING，不容忍前导空格）
    /^\s*(?:[-*+]|\d+[.)])\s/.test(blk) || // 列表（同 LIST_ITEM，容忍前导空格）
    /^\s*\|/.test(blk) || // 表格（同 TABLE_ROW，容忍前导空格）
    blk.startsWith('```') // 围栏代码 / mermaid（同 FENCE，不容忍前导空格）
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
  // 分块结果按 markdown 内容缓存（review 效率）：renderSection 每次渲染都 splitBlocks(sec.markdown)，
  // AI 流式时某节高频变更→整个 ProposalPaper 重渲染→对【所有】章节反复重跑逐行分块。按内容 key 缓存后，
  // 只有内容真变的那节才重解析、其余命中缓存。splitBlocks 是纯函数，按输入缓存安全；>200 条清空防长会话涨。
  const blocksCacheRef = useRef<Map<string, string[]>>(new Map())
  const getBlocks = (markdown: string): string[] => {
    const cache = blocksCacheRef.current
    let b = cache.get(markdown)
    if (!b) {
      b = splitBlocks(markdown)
      if (cache.size > 200) cache.clear()
      cache.set(markdown, b)
    }
    return b
  }
  const [editingId, setEditingId] = useState<string | null>(null)
  // 块级就地手改（命中「改动粒度太粗」）：双击某块 → 只有那一块变 textarea。editingId（整节
  // 源码逃生舱）与 editingBlock 互斥——进整节源码时清块编辑，反之亦然。blockDraft 是就地草稿，
  // 失焦/⌘↵ 提交、Esc 取消；提交时替换该块 → joinBlocks 重拼 → updateSection（走现有防抖写盘）。
  // original：双击进编辑那一刻该块的原文快照，供提交时做「陈旧块保护」（见 commitBlock）。
  const [editingBlock, setEditingBlock] = useState<{
    sectionId: string
    blockIndex: number
    original: string
  } | null>(null)
  const [blockDraft, setBlockDraft] = useState('')
  // Esc 取消标记（review V4）：Esc 只 setEditingBlock(null) 不够——textarea 因重渲染被摘除时浏览器
  // 仍会派发 blur→onBlur→commitBlock 把本应放弃的内容写回。Esc 先置本标记再 blur()，onBlur 识别后跳过提交。
  const cancelBlockRef = useRef(false)
  // 卸载时 flush 未提交的块草稿（review V5）：切工作台面板/切会话会让 ProposalPaper 整体卸载
  // （ProposalDocPanel !show return null），若卸载前未触发 textarea blur，本地 blockDraft 会随之丢失
  // （原整节 textarea 每键即写 store、不会丢）。用 ref 取最新值（[]-deps 的 cleanup 否则捕获初值），
  // 卸载时直接读 store 兜底落盘；沿用 commitBlock 同款守卫（生成中/陈旧块/空草稿都不落盘）。
  const editingBlockRef = useRef(editingBlock)
  editingBlockRef.current = editingBlock
  const blockDraftRef = useRef(blockDraft)
  blockDraftRef.current = blockDraft
  useEffect(() => {
    return () => {
      const eb = editingBlockRef.current
      if (!eb) return
      const pstore = useProposalStore.getState()
      const sid = pstore.sessionId
      const gen = sid ? (useChatStore.getState().perSession[sid]?.streaming ?? false) : false
      if (gen) return // 生成中不落盘，避免覆盖并发 AI 产出（同 commitBlock）
      const draft = blockDraftRef.current
      if (!draft.trim()) return // 清空不落盘（不静默删块，见 commitBlock V8）
      const sec = pstore.sections.find((s) => s.id === eb.sectionId)
      if (!sec) return
      const blocks = splitBlocks(sec.markdown)
      if (eb.blockIndex < 0 || eb.blockIndex >= blocks.length) return
      if (blocks[eb.blockIndex] !== eb.original) return // 陈旧块保护
      if (blocks[eb.blockIndex] === draft) return // 无改动不写
      blocks[eb.blockIndex] = draft
      pstore.updateSection(sec.id, joinBlocks(blocks))
    }
  }, [])

  // 提交块草稿：把 sec 的第 blockIndex 块替换成 blockDraft，重拼回整节 markdown。
  function commitBlock(sec: ProposalSection, blockIndex: number): void {
    // 生成中放弃提交（review V3 上半）：编辑打开后 AI 可能开始新一轮 streaming 修订；
    // onBlur/⌘↵ 若仍写回会覆盖并发写入的 AI 产出。检测到 generating 就只收起编辑态、不落盘。
    if (generating) {
      setEditingBlock(null)
      return
    }
    const blocks = splitBlocks(sec.markdown)
    if (blockIndex < 0 || blockIndex >= blocks.length) {
      setEditingBlock(null)
      return
    }
    // 陈旧块保护（review V3）：块编辑期间若该节被并发的整节 AI 修订整节替换，同一 blockIndex 在新
    // 块切分下已指向语义不同的块；此时用基于旧版内容的 blockDraft 覆盖会踩掉 AI 刚写好的内容。发现
    // 「当前该块 ≠ 打开编辑时快照的原文」即放弃这次手改（AI 新内容更该保留），只收起编辑态。
    if (!editingBlock || editingBlock.original !== blocks[blockIndex]) {
      setEditingBlock(null)
      return
    }
    // 把某块清空 ≠ 删块（review V8）：块级手改无删块语义（删除走整节两步确认 + 3s 自动撤销，
    // design-review F5）。清空即视为放弃本次编辑、保留原块，避免一次失焦静默抹掉一整段（joinBlocks
    // 会把 trim 后为空的块整块过滤掉）。要删掉一段，走整节源码逃生舱显式删。
    if (!blockDraft.trim()) {
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
          // 生成中禁止【打开】整节源码逃生舱（review V2）：某节 blockRange 修订在飞时，若用户开源码框
          // 改动本节使块布局变化，轮末 spliceBlocks 会按旧下标拼进错块、静默覆盖。已打开的仍允许关闭。
          disabled={generating && editingId !== sec.id}
          onClick={() => {
            if (generating && editingId !== sec.id) return
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
              if (editingBlock?.sectionId === sec.id) setEditingBlock(null)
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
        // readOnly={generating}：生成中（尤其某节 blockRange 修订在飞）冻结手改，防止改动使块布局漂移
        // 致轮末 spliceBlocks 拼错块（review V2）；生成结束即恢复可编辑。
        <textarea
          className="min-h-[120px] w-full resize-y rounded-sm bg-accent/5 font-mono text-[13px] leading-[1.8] text-[#1d1d1f] outline-none read-only:opacity-60"
          value={sec.markdown}
          autoFocus
          readOnly={generating}
          onChange={(e) => updateSection(sec.id, e.target.value)}
        />
      ) : (
        // 逐块渲染：DOM 块索引 = splitBlocks 下标（Task 5 选区映射靠 data-block-index）。
        // 双击某块 → 只有那一块进就地编辑；其余块照常渲染（含来源高亮）。getBlocks 按内容缓存分块。
        getBlocks(sec.markdown).map((blk, bi) =>
          editingBlock && editingBlock.sectionId === sec.id && editingBlock.blockIndex === bi ? (
            <textarea
              key={bi}
              className="my-1 min-h-[64px] w-full resize-y rounded-sm bg-accent/5 font-serif text-[14px] leading-[1.95] text-[#1d1d1f] outline-none read-only:opacity-60"
              value={blockDraft}
              autoFocus
              // 生成中冻结手改（与整节逃生舱对称，review 复审 Minor#3）：编辑打开后若 AI 开始 streaming，
              // 键入本会被 commitBlock 的 generating 守卫丢弃，readOnly 提前挡住、不让用户白敲。
              readOnly={generating}
              onChange={(e) => setBlockDraft(e.target.value)}
              // 单一提交路径：一切提交都经 onBlur。⌘↵ 触发 blur() 走提交；Esc 先置 cancel 标记再 blur()，
              // onBlur 识别标记后跳过提交（review V4——否则 Esc 摘除 textarea 触发的 blur 仍会写回）。
              onBlur={() => {
                if (cancelBlockRef.current) {
                  cancelBlockRef.current = false
                  setEditingBlock(null)
                  return
                }
                commitBlock(sec, bi)
              }}
              onKeyDown={(e) => {
                // ⌘↵/Ctrl↵ 提交（经 blur）；Esc 取消（不写回）。普通回车留给多行输入。
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelBlockRef.current = true
                  e.currentTarget.blur()
                }
              }}
            />
          ) : (
            <div
              key={bi}
              data-section-id={sec.id}
              data-block-index={bi}
              // mb-3 只补【段落型块】（review V9）：逐块渲染前整节一个 AssistantMarkdown，段落靠内部
              // <p className="mb-3 last:mb-0"> 撑间距；拆成逐块后段落块只剩单个 <p>=last 子元素→mb-0、
              // 间距全丢，故补回。但标题/列表/表格自带外边距（如 h2 mb-2），若也叠 wrapper mb-3 会因
              // margin-collapse-through 取 max 撑大间距（标题后由 8px 变 12px）——故这类块不补。
              className={(blockNeedsGap(blk) ? 'mb-3 ' : '') + 'rounded-sm hover:bg-accent/[0.03]'}
              // 双击进块级就地手改：读该块源码进草稿、清整节源码逃生舱（互斥）。生成中禁改。
              // 同步记 original=blk 快照，供提交时做陈旧块保护（见 commitBlock）。
              onDoubleClick={() => {
                if (generating) return
                setEditingId(null)
                setBlockDraft(blk)
                setEditingBlock({ sectionId: sec.id, blockIndex: bi, original: blk })
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

  const canvasRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={canvasRef} className="proposal-canvas relative flex-1 overflow-auto py-7">
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
      {/* 选区即改浮层：贴选区尾浮出，作用于选区覆盖的块区间。生成中禁用（与块手改一致）。 */}
      <SelectionAiBubble containerRef={canvasRef} disabled={generating} />
    </div>
  )
}
