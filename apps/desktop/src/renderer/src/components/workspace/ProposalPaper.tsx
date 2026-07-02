import { useEffect, useRef, useState } from 'react'
import { useProposalStore, type ProposalSection, type ImageReview } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { reviseProposalSection } from '../../lib/sendProposalSectionRevision'
import { SelectionAiBubble } from './SelectionAiBubble'
import { ProposalImageToolbar } from './ProposalImageToolbar'
import { ProposalImageReview } from './ProposalImageReview'
import type { ProposalKind } from '@shared/proposal'
import { splitBlocks, joinBlocks } from '@shared/proposalBlocks'
import {
  removeImageOccurrence,
  replaceImageOccurrence,
  applyImageReplacementWithDrift
} from '@shared/proposalImageOps'
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
  InfoIcon,
  XIcon,
  ImagePlusIcon,
  UploadIcon
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

// 点图工具栏「删除」的字符串手术本身（含 Finding 1 的空格粘连修复、Finding 2 的同路径按第 N
// 次出现删除）已抽到 shared/proposalImageOps.ts（纯函数、有 bun test 覆盖）——renderer 这层
// 只负责从 DOM 数出「点中的是第几个同路径出现」（见 handlePaperClick）并调用它。
//
// 应用改图审阅项（Task 11）用的「带漂移容错 + 歧义守卫」落点逻辑（含 preferredIndex 命中优先、
// 未命中时扫描其余块、恰好一个候选才落地、多候选/零候选一律 no-op）同样已抽到
// shared/proposalImageOps.ts 的 applyImageReplacementWithDrift（有 bun test 覆盖，见该文件
// 顶部注释），下面 applyImageReview 直接调用。

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
  // 这几个 action 是 zustand 稳定引用、永不变——从 getState() 一次性取出、不订阅，
  // 避免每次 store 更新（如流式 append 新节）都白跑一遍 selector。
  const { updateSection, removeSection, moveSection, addImageReview } = useProposalStore.getState()
  // imageReviews 需要订阅（Task 11）：改图/生图产出待审阅项要驱动重渲染出对照卡，
  // 不能像上面几个稳定 action 那样只取一次。
  const imageReviews = useProposalStore((s) => s.imageReviews)
  const proposalSid = useProposalStore((s) => s.sessionId)
  const generating = useChatStore((s) =>
    proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false
  )
  // 分块结果按 markdown 内容缓存（review 效率）：renderSection 每次渲染都 splitBlocks(sec.markdown)，
  // AI 流式时某节高频变更→整个 ProposalPaper 重渲染→对【所有】章节反复重跑逐行分块。按内容 key 缓存后，
  // 只有内容真变的那节才重解析、其余命中缓存。splitBlocks 是纯函数，按输入缓存安全；>200 条清空防长会话涨。
  // 编辑纸面的滚动容器：既是 SelectionAiBubble 的定位参照系，也是点图工具栏（下方）的定位参照系
  // ——两者都用「容器相对坐标 + 容器自身 relative」的同一套定位范式，故提到函数顶部与其它 ref 并列。
  const canvasRef = useRef<HTMLDivElement | null>(null)
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

  // 点图浮动工具栏（Task 9）：点中编辑态某图 → 记录它所在的节/块 + 源图绝对路径（来自 img 的
  // data-raw-src，见 AssistantMarkdown 的注释——react-markdown 解析时已代我们剥好 <> 与 title
  // 后缀，值与 shared/proposal.parseImages 抽出的 path 精确一致，无需再自行正则解析一遍）。
  // anchorLeft/anchorTop 是容器（canvasRef）相对坐标，与 SelectionAiBubble 同一套定位范式。
  const [imgSel, setImgSel] = useState<{
    sectionId: string
    blockIndex: number
    sourcePath: string
    // 该块内、路径与 sourcePath 相同的图片里，点中的是第几个（0 起）——同一块贴了两张同路径图
    // 时用来区分删哪一张（Finding 2），在 handlePaperClick 里从 DOM 数出来，纯字符串手术
    // 侧（proposalImageOps.removeImageOccurrence）不掺 DOM，只认这个下标。
    occurrence: number
    anchorLeft: number
    anchorTop: number
  } | null>(null)

  // 生成中 / 进了整节源码逃生舱 / 进了块级就地编辑：三者都可能让当前选中的图片从 DOM 里消失
  // （generating 时其它路径可能并发改写本节；editingId/editingBlock 打开会把渲染内容换成
  // textarea），此时工具栏若还挂着旧坐标就是悬空的，一律收起（与 SelectionAiBubble 收到
  // disabled 就清 anchor 是同一条纪律）。imageGenSel（Task 10 生图输入卡）同理一并收起。
  useEffect(() => {
    if (generating || editingId || editingBlock) {
      setImgSel(null)
      setImageGenSel(null)
    }
  }, [generating, editingId, editingBlock])

  // 生图入口（Task 10）：节工具条「生成图片」点开的内联卡片状态。同一时刻只可能有一张卡片
  // 展开（单选，与 editingBlock 同款「单槽」范式），故 prompt/loading/error 不必按 sectionId
  // 建 Map——切换到另一节的卡片时旧状态自然被 setImageGenSel 的新值连带清空（见下方按钮逻辑）。
  const [imageGenSel, setImageGenSel] = useState<{ sectionId: string } | null>(null)
  const [imageGenPrompt, setImageGenPrompt] = useState('')
  const [imageGenLoading, setImageGenLoading] = useState(false)
  const [imageGenError, setImageGenError] = useState<string | null>(null)

  // 换图进行中（Task 10）：换图按钮点击后弹原生文件选择框，期间置 true 防止重入（用户快速
  // 双击再次弹出第二个对话框）。不做成 UI loading 态——原生对话框本身是模态的，用户能感知
  // 「点了之后弹了个框」，不需要额外的按钮态反馈。
  const [replacingImage, setReplacingImage] = useState(false)

  // 上传入口（Task 10）：按 sectionId 记「正在上传中」（禁用该节的上传按钮防重入）与「上传失败」
  // 瞬时错误提示（4s 自动消失，同 confirmDeleteId 的定时收起范式）。上传本身不经审阅（用户已
  // 选定文件），故没有 loading 文案态之外的中间状态。
  const [uploadingSectionId, setUploadingSectionId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<{ sectionId: string; message: string } | null>(
    null
  )
  useEffect(() => {
    if (!uploadError) return
    const id = setTimeout(() => setUploadError(null), 4000)
    return () => clearTimeout(id)
  }, [uploadError])

  // 改图/生图审阅卡（Task 11）：多张卡可能同时挂着（不同节的改图/生图各自独立发起），按
  // review.id 建 map 记「重改中」与「重改失败」，而非单槽状态——否则一张卡在重改会把另一张卡
  // 的按钮也锁住。
  const [reviewBusy, setReviewBusy] = useState<Record<string, boolean>>({})
  const [reviewError, setReviewError] = useState<Record<string, string | null>>({})
  // 清理陈旧条目：review 一旦从 imageReviews 里消失（应用/放弃/重改成功后旧 id 被替换），对应
  // 的 busy/error 记录就该一并清掉，否则重改用同一图再次触发相同 sourcePath 时若 id 复用
  // （理论上 crypto.randomUUID 不会重复，但心智上仍希望 map 不无限增长）会残留陈旧展示。以
  // imageReviews 的当前 id 集合为准做一次性 diff，是自动化清理点，不必在每个删除路径手动同步。
  useEffect(() => {
    const ids = new Set(imageReviews.map((r) => r.id))
    setReviewBusy((m) => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const k of Object.keys(m)) {
        if (ids.has(k)) next[k] = m[k]
        else changed = true
      }
      return changed ? next : m
    })
    setReviewError((m) => {
      let changed = false
      const next: Record<string, string | null> = {}
      for (const k of Object.keys(m)) {
        if (ids.has(k)) next[k] = m[k]
        else changed = true
      }
      return changed ? next : m
    })
  }, [imageReviews])

  // 应用（Task 11）：edit 模式把新图路径换回原图所在块（见 applyImageReplacementWithDrift 顶部
  // 注释——preferredIndex 命中优先，未命中时按「恰好一个候选」的歧义守卫扫描其余块）；generate
  // 模式在节末尾追加一个新图块（与 handleImageUpload 同一条落盘路径）。节已被删除（审阅悬而
  // 未决期间用户删了整节）则无处落地，只清审阅项、不报错——静默丢弃优于抛错阻断。
  function applyImageReview(review: ImageReview): void {
    const pstore = useProposalStore.getState()
    const sec = pstore.sections.find((s) => s.id === review.sectionId)
    if (!sec) {
      pstore.removeImageReview(review.id)
      return
    }
    if (review.mode === 'generate') {
      const blocks = splitBlocks(sec.markdown)
      blocks.push(`![生成图](${review.resultPath})`)
      pstore.updateSection(sec.id, joinBlocks(blocks))
      pstore.removeImageReview(review.id)
      return
    }
    // mode === 'edit'：sourcePath 按契约总存在（addImageReview 的两处 edit 调用点都带它），
    // 缺失属数据不一致，防御性丢弃而非用 ! 断言硬来。
    if (!review.sourcePath) {
      pstore.removeImageReview(review.id)
      return
    }
    const blocks = splitBlocks(sec.markdown)
    if (blocks.length === 0) {
      pstore.removeImageReview(review.id)
      return
    }
    const { blocks: next, changed } = applyImageReplacementWithDrift(
      blocks,
      review.blockIndex,
      review.sourcePath,
      review.occurrence ?? 0,
      review.resultPath
    )
    if (changed) {
      pstore.updateSection(sec.id, joinBlocks(next))
    } else {
      // 原图既不在 preferredIndex、其余块里也数不出恰好一个候选（漂移到找不到 / 歧义），
      // 应用被放弃。审阅项照样摘除（不留僵尸卡），但这一步是「用户点了应用却什么也没发生」，
      // 不能悄无声息——控制台留痕，方便用户反馈「应用没反应」时靠 devtools 定位（同
      // WorkspaceTreePanel openFile 失败的既有先例：本处也没有 toast 槽位，不为这一个
      // 边缘场景新起一套 toast 机制）。
      console.warn('[proposal] 应用改图失败：原图已不在本节，已放弃该修订', {
        reviewId: review.id,
        sectionId: review.sectionId,
        sourcePath: review.sourcePath,
        occurrence: review.occurrence ?? 0
      })
    }
    pstore.removeImageReview(review.id)
  }

  // 放弃：只摘审阅项，产出图文件留在磁盘（随草稿区一并清理，不即时删盘——同一图片可能已被
  // 别处复用，误删风险由「不做即时删除」规避，Step 3 既定策略）。
  function discardImageReview(id: string): void {
    useProposalStore.getState().removeImageReview(id)
  }

  // 重改：对同一 mode 重发同一条 Task 7 IPC，成功则原子替换审阅项（先摘旧、再以同样的落点
  // 字段插入新的一条，旧卡即被新卡取代，不会一闪而过地同时出现两张）；失败把错误留在原卡上、
  // busy 收回，供用户再试或改用「放弃」。
  async function retryImageReview(review: ImageReview, prompt: string): Promise<void> {
    if (!proposalSid) {
      setReviewError((m) => ({ ...m, [review.id]: '当前没有方案会话，请稍后重试' }))
      return
    }
    if (review.mode === 'edit' && !review.sourcePath) {
      setReviewError((m) => ({ ...m, [review.id]: '缺少原图信息，无法重改' }))
      return
    }
    setReviewBusy((m) => ({ ...m, [review.id]: true }))
    setReviewError((m) => ({ ...m, [review.id]: null }))
    try {
      const { path } =
        review.mode === 'edit'
          ? await window.chatApi.proposalImageEdit({
              sessionId: proposalSid,
              sourcePath: review.sourcePath as string,
              prompt
            })
          : await window.chatApi.proposalImageGenerate({ sessionId: proposalSid, prompt })
      const pstore = useProposalStore.getState()
      pstore.removeImageReview(review.id)
      pstore.addImageReview({
        sectionId: review.sectionId,
        blockIndex: review.blockIndex,
        sourcePath: review.sourcePath,
        resultPath: path,
        mode: review.mode,
        occurrence: review.occurrence
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const friendly = message.includes('未配置')
        ? '尚未配置出图 API，请到设置里填写 key 与地址后再试。'
        : review.mode === 'edit'
          ? '改图失败，请稍后重试。'
          : '生成失败，请稍后重试。'
      setReviewError((m) => ({ ...m, [review.id]: friendly }))
    } finally {
      setReviewBusy((m) => ({ ...m, [review.id]: false }))
    }
  }

  // 点击别处关闭：真正的判定在 mousedown（早于 click），但只处理「关闭」——「选中新图片」这个
  // 更新交给下面 handlePaperClick 的 onClick 做。命中工具栏自身（data-image-toolbar）或某张图
  // （马上会被 handlePaperClick 处理成新选中项）都不在这里清空，否则会先清后设、多余的中间态。
  useEffect(() => {
    if (!imgSel) return
    function onDocMouseDown(e: MouseEvent): void {
      // 同 SelectionAiBubble 的 resolveBlock：e.target 理论上可能是非 Element 节点（罕见），
      // instanceof 窄化后再 closest，避免对非 Element 调用 closest 报错。
      const target = e.target instanceof Element ? e.target : null
      if (!target) return
      if (target.closest('[data-image-toolbar]')) return
      if (target.closest('img[data-raw-src]')) return
      setImgSel(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [imgSel])

  // 纸面点击委派：只关心点没点中一张（可点的）图。图片渲染在 AssistantMarkdown 深处，逐块加
  // 监听器成本高也没必要——冒泡到滚动容器上统一判定即可，命中才 setImgSel，否则原样放行（不
  // 吞事件、不 stopPropagation），不影响块双击进编辑/选区即改等既有交互。
  function handlePaperClick(e: React.MouseEvent<HTMLDivElement>): void {
    if (generating) return
    if (!(e.target instanceof Element)) return
    const img = e.target.closest('img[data-raw-src]')
    if (!img) return
    const blockEl = img.closest<HTMLElement>('[data-block-index]')
    if (!blockEl) return
    const sectionId = blockEl.getAttribute('data-section-id')
    const idxAttr = blockEl.getAttribute('data-block-index')
    const sourcePath = img.getAttribute('data-raw-src')
    if (sectionId == null || idxAttr == null || !sourcePath) return
    const container = canvasRef.current
    if (!container) return
    // 数「点中的是第几个同路径出现」（Finding 2）：在同一块元素范围内，遍历所有 data-raw-src
    // 图片节点，数清楚排在被点中的 img 前面、且路径相同的有几个——即该图在同路径序列里的下标
    // （0 起）。querySelectorAll 按文档序返回，与 markdown 源码里 `![](path)` 的出现顺序一致
    // （DOM 渲染顺序 = 源码顺序，未被任何 CSS 重排），故这个下标能直接喂给
    // removeImageOccurrence 的 occurrence 参数。
    let occurrence = 0
    for (const el of blockEl.querySelectorAll<HTMLElement>('img[data-raw-src]')) {
      if (el === img) break
      if (el.getAttribute('data-raw-src') === sourcePath) occurrence++
    }
    const rect = img.getBoundingClientRect()
    const cRect = container.getBoundingClientRect()
    setImgSel({
      sectionId,
      blockIndex: Number(idxAttr),
      sourcePath,
      occurrence,
      // 右上角：右边界对齐图片右边（浮层自身用 translate(-100%) 靠右），上边缘贴图片顶部再下探
      // 一点，视觉上像一枚浮在图片右上角的胶囊，不完全盖住图（与 Step1 要求「绝对定位在图右上角」一致）。
      anchorLeft: rect.right - cRect.left + container.scrollLeft,
      anchorTop: rect.top - cRect.top + container.scrollTop + 6
    })
  }

  // 改图：调 Task 7 的 IPC，成功则把「原图 vs 新图」登记进 imageReviews（Task 11 消费）。
  // 失败按错误信息分流成两类可读提示（未配置 key → 引导去设置；其它 → 建议稍后重试），返回给
  // 工具栏自己展示、不抛出——工具栏据返回值决定是否保留输入框允许重试。
  async function handleImageEdit(
    sectionId: string,
    blockIndex: number,
    sourcePath: string,
    occurrence: number,
    prompt: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!proposalSid) return { ok: false, message: '当前没有方案会话，请稍后重试' }
    try {
      const { path } = await window.chatApi.proposalImageEdit({
        sessionId: proposalSid,
        sourcePath,
        prompt
      })
      addImageReview({
        sectionId,
        blockIndex,
        sourcePath,
        resultPath: path,
        mode: 'edit',
        occurrence
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('未配置')) {
        return { ok: false, message: '尚未配置出图 API，请到设置里填写 key 与地址后再试。' }
      }
      return { ok: false, message: '改图失败，请稍后重试。' }
    }
  }

  // 删除：从该图所在块的 markdown 里摘掉这一段 `![...](sourcePath)`，其余内容原样保留，
  // 重拼回整节后走 updateSection（与块级手改同一条落盘路径）。若该块已不是当初点击时的样子
  // （如生成中被并发改写）——找不到匹配的图片则整块原样不动，只收起工具栏（不误删无关内容）。
  // occurrence 来自点击时刻在 DOM 里数出的「同路径第几个」（见 handlePaperClick），传给纯函数
  // removeImageOccurrence 精确摘掉那一个，而不是总摘第一个同路径匹配（Finding 2）。
  function handleImageDelete(
    sectionId: string,
    blockIndex: number,
    sourcePath: string,
    occurrence: number
  ): void {
    const sec = sections.find((s) => s.id === sectionId)
    if (!sec) {
      setImgSel(null)
      return
    }
    const blocks = splitBlocks(sec.markdown)
    if (blockIndex < 0 || blockIndex >= blocks.length) {
      setImgSel(null)
      return
    }
    const original = blocks[blockIndex]
    const stripped = removeImageOccurrence(original, sourcePath, occurrence)
    if (stripped !== original) {
      blocks[blockIndex] = stripped
      updateSection(sec.id, joinBlocks(blocks))
    }
    setImgSel(null)
  }

  // 生图（Task 10）：节工具条「生成图片」卡片提交时调用。与改图（handleImageEdit）走同一条
  // Task 7 IPC + 同一套错误分流约定，唯一区别是没有 sourcePath（凭空生成，非改写既有图）、
  // blockIndex 取该节【当前】最后一块的下标——不是原图所在块，而是给 Task 11 审阅卡一个默认
  // 的「插入到此处」落点（该节末尾）。proposalImageGenerate 是秒级网络调用，await 期间双击块
  // 编辑并不受「生图中」状态门控，该节完全可能被并发改写；若沿用提交时刻闭包捕获的 sections
  // 会拿着陈旧块数算出错的 blockIndex（同 handleImageUpload/handleImageReplace 的顾虑，而非
  // 同步无 await 的 handleImageDelete）。故 await 后重新从 store 取最新 sections 再算下标。
  async function handleImageGenerate(
    sectionId: string,
    prompt: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!proposalSid) return { ok: false, message: '当前没有方案会话，请稍后重试' }
    try {
      const { path } = await window.chatApi.proposalImageGenerate({
        sessionId: proposalSid,
        prompt
      })
      const pstore = useProposalStore.getState()
      const sec = pstore.sections.find((s) => s.id === sectionId)
      if (!sec) return { ok: true } // 节已被删除：生成已完成但无处插入，静默丢弃（不报错误）
      const blockIndex = Math.max(splitBlocks(sec.markdown).length - 1, 0)
      pstore.addImageReview({ sectionId, blockIndex, resultPath: path, mode: 'generate' })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('未配置')) {
        return { ok: false, message: '尚未配置出图 API，请到设置里填写 key 与地址后再试。' }
      }
      return { ok: false, message: '生成失败，请稍后重试。' }
    }
  }

  // 生图卡片的提交按钮/⌘↵ 都走这里：套「loading→await→关卡片或留错误」的固定流程，
  // 与 ProposalImageToolbar 内部 submit() 同款节奏，只是这里的卡片状态提到了父组件（单槽）。
  async function submitImageGen(sectionId: string): Promise<void> {
    const text = imageGenPrompt.trim()
    if (!text || imageGenLoading) return
    setImageGenLoading(true)
    setImageGenError(null)
    const result = await handleImageGenerate(sectionId, text)
    setImageGenLoading(false)
    if (result.ok) {
      setImageGenSel(null)
      setImageGenPrompt('')
    } else {
      setImageGenError(result.message)
    }
  }

  // 上传（Task 10）：直接插入，不经审阅（用户已经手动选定了文件，不像生成/改图那样需要「原图
  // vs 新图」对照确认）。插到该节末尾成一个新块，走与其它手改同一条 updateSection 落盘路径。
  // 完成态（含用户取消）时重新从 store 取最新 sections——上传是原生模态对话框，用户挑文件可能
  // 耗时数秒到数十秒，这期间该节完全可能被并发的 AI 修订/其它手改替换掉，若沿用点击那一刻闭包
  // 捕获的 sec 会拿着陈旧 markdown 覆盖掉期间的新内容（同 handleImageReplace 的顾虑）。
  async function handleImageUpload(sectionId: string): Promise<void> {
    if (!proposalSid || uploadingSectionId) return
    setUploadingSectionId(sectionId)
    setUploadError(null)
    try {
      const result = await window.chatApi.proposalImageUpload({ sessionId: proposalSid })
      if (!result) return // 用户取消：静默无操作
      const pstore = useProposalStore.getState()
      const sec = pstore.sections.find((s) => s.id === sectionId)
      if (!sec) return
      const blocks = splitBlocks(sec.markdown)
      blocks.push(`![上传图](${result.path})`)
      pstore.updateSection(sectionId, joinBlocks(blocks))
    } catch (err) {
      console.warn('[ProposalPaper] proposalImageUpload failed:', err)
      setUploadError({ sectionId, message: '上传失败，请稍后重试。' })
    } finally {
      setUploadingSectionId(null)
    }
  }

  // 换图（Task 10）：点图工具栏「换图」按钮的落地实现。复用同一条上传 IPC（用户挑文件），
  // 拿到新路径后用 replaceImageOccurrence 精确替换点中的那一张（occurrence 同删除时的下标
  // 来源）。完成态重新从 store 取最新 sections，理由同 handleImageUpload（原生对话框耗时，
  // 期间该块可能被并发改写；点击时刻闭包捕获的 blocks 会是陈旧快照）。找不到匹配（块已变）
  // 则不落盘，只收起工具栏，不误改无关内容。
  async function handleImageReplace(
    sectionId: string,
    blockIndex: number,
    sourcePath: string,
    occurrence: number
  ): Promise<void> {
    if (!proposalSid) return
    setReplacingImage(true)
    try {
      const result = await window.chatApi.proposalImageUpload({ sessionId: proposalSid })
      if (!result) return // 用户取消：保留原图，不做任何改动
      const pstore = useProposalStore.getState()
      const sec = pstore.sections.find((s) => s.id === sectionId)
      if (!sec) return
      const blocks = splitBlocks(sec.markdown)
      if (blockIndex < 0 || blockIndex >= blocks.length) return
      const original = blocks[blockIndex]
      const replaced = replaceImageOccurrence(original, sourcePath, occurrence, result.path)
      if (replaced !== original) {
        blocks[blockIndex] = replaced
        pstore.updateSection(sectionId, joinBlocks(blocks))
      }
    } catch (err) {
      console.warn('[ProposalPaper] proposalImageUpload (replace) failed:', err)
    } finally {
      setReplacingImage(false)
      setImgSel(null)
    }
  }

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
            {/* 生图/上传（Task 10）：仅正文节——docx 导出只给正文节嵌图（封面/目录另有专属模板槽
                位），封面/目录插了图导出也不会体现，故不在这两类 kind 上给这两个入口造成落空的期望。 */}
            <button
              className={toolBtn}
              disabled={generating}
              onClick={() => {
                if (imageGenSel?.sectionId === sec.id) {
                  setImageGenSel(null)
                } else {
                  setImageGenSel({ sectionId: sec.id })
                  setImageGenPrompt('')
                  setImageGenError(null)
                }
              }}
              title="生成图片（AI 按文字描述生成一张插图，插入本节末尾前需确认）"
              aria-label="生成图片"
            >
              <ImagePlusIcon />
            </button>
            <button
              className={toolBtn}
              disabled={generating || uploadingSectionId === sec.id}
              onClick={() => void handleImageUpload(sec.id)}
              title="上传本地图片，插入到本节末尾"
              aria-label="上传图片"
            >
              <UploadIcon />
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

      {/* 上传失败瞬时提示（Task 10）：4s 自动消失（见 uploadError 的 useEffect），成功态不需要
          提示——上传图直接可见地出现在本节末尾，本身就是最好的反馈。 */}
      {uploadError?.sectionId === sec.id && (
        <div className="mb-1 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600">
          <AlertTriangleIcon className="mt-0.5 shrink-0" />
          <span>{uploadError.message}</span>
        </div>
      )}

      {/* 生图输入卡（Task 10）：点「生成图片」展开，样式抄 ProposalImageToolbar 的「改图指令」
          展开态（同一套「标题栏 + 取消 × / 文本域 / 错误条 / 取消·提交」骨架），区别是这里是
          节内嵌入的 banner 而非浮层——生图入口挂在节工具条（纸面右侧外边距）而非某张具体图片
          上，没有一个可锚定的「图片右上角」，故用同一容器内的流式卡片，不引入额外的坐标换算。 */}
      {imageGenSel?.sectionId === sec.id && (
        <div className="mb-2 rounded-md border border-neutral-300 bg-neutral-50 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-neutral-700">生成图片</span>
            <button
              type="button"
              className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              title="取消"
              aria-label="取消"
              onClick={() => {
                setImageGenSel(null)
                setImageGenPrompt('')
                setImageGenError(null)
              }}
            >
              <XIcon />
            </button>
          </div>
          <textarea
            autoFocus
            value={imageGenPrompt}
            onChange={(e) => setImageGenPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && imageGenPrompt.trim()) {
                e.preventDefault()
                void submitImageGen(sec.id)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setImageGenSel(null)
                setImageGenPrompt('')
                setImageGenError(null)
              }
            }}
            placeholder="描述想生成的插图，比如：一张展示产品架构的示意图"
            rows={2}
            disabled={imageGenLoading}
            className="mt-1.5 w-full resize-none rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] leading-relaxed text-neutral-800 outline-none focus:border-accent disabled:opacity-60"
          />
          {imageGenError && (
            <div className="mt-1.5 flex items-start gap-1 rounded bg-rose-500/10 px-1.5 py-1 text-[11px] text-rose-600">
              <AlertTriangleIcon className="mt-0.5 shrink-0" />
              <span>{imageGenError}</span>
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              onClick={() => {
                setImageGenSel(null)
                setImageGenPrompt('')
                setImageGenError(null)
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md bg-neutral-900 px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              disabled={!imageGenPrompt.trim() || imageGenLoading}
              onClick={() => void submitImageGen(sec.id)}
              title="⌘/Ctrl + 回车"
            >
              {imageGenLoading ? (
                <span>生成中…</span>
              ) : (
                <>
                  <CheckIcon />
                  <span>生成</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

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

      {/* 改图/生图审阅卡（Task 11）：挂在本节正文之后、区段边界之前——就地内联而非浮层，理由见
          ProposalImageReview.tsx 顶部注释。同一节可能同时挂多张（并发对不同图各自发起改图/生图），
          按 imageReviews 数组原样顺序渲染，不做单选收窄。 */}
      {imageReviews
        .filter((r) => r.sectionId === sec.id)
        .map((review) => (
          <ProposalImageReview
            key={review.id}
            review={review}
            busy={Boolean(reviewBusy[review.id]) || generating}
            error={reviewError[review.id] ?? null}
            onApply={() => applyImageReview(review)}
            onDiscard={() => discardImageReview(review.id)}
            onRetry={(prompt) => void retryImageReview(review, prompt)}
          />
        ))}
    </section>
    )
  }

  return (
    <div
      ref={canvasRef}
      className="proposal-canvas relative flex-1 overflow-auto py-7"
      onClick={handlePaperClick}
    >
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
      {/* 点图浮动工具栏（Task 9）：点中一张图后浮出，右上角贴图。换图（Task 10）现已接通：传
          null 只在「正弹着上传框」时短暂出现（replacingImage=true），让工具栏渲染成禁用态防重入
          点击，而非「即将支持」的永久占位。 */}
      {imgSel && (
        <ProposalImageToolbar
          anchorLeft={imgSel.anchorLeft}
          anchorTop={imgSel.anchorTop}
          disabled={generating}
          onEdit={(prompt) =>
            handleImageEdit(
              imgSel.sectionId,
              imgSel.blockIndex,
              imgSel.sourcePath,
              imgSel.occurrence,
              prompt
            )
          }
          onReplace={
            replacingImage
              ? null
              : () =>
                  void handleImageReplace(
                    imgSel.sectionId,
                    imgSel.blockIndex,
                    imgSel.sourcePath,
                    imgSel.occurrence
                  )
          }
          onDelete={() =>
            handleImageDelete(imgSel.sectionId, imgSel.blockIndex, imgSel.sourcePath, imgSel.occurrence)
          }
          onClose={() => setImgSel(null)}
        />
      )}
    </div>
  )
}
