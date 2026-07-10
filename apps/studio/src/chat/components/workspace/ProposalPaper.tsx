import { Fragment, useEffect, useRef, useState } from 'react'
import { useProposalStore, type ProposalSection, type ImageReview } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { reviseProposalSection } from '../../lib/sendProposalSectionRevision'
import { friendlyImageError } from '../../lib/imageErrorText'
import { SelectionAiBubble } from './SelectionAiBubble'
import { ProposalImageToolbar } from './ProposalImageToolbar'
import { ProposalImageReview } from './ProposalImageReview'
import { Tip } from './ProposalTooltip'
import type { ProposalKind } from '@desktop-shared/proposal'
import { splitBlocks, joinBlocks } from '@desktop-shared/proposalBlocks'
import {
  removeImageOccurrence,
  replaceImageOccurrence,
  applyImageReplacementWithDrift
} from '@desktop-shared/proposalImageOps'
import {
  isGenImageDirectiveBlock,
  parseGenImageBlock,
  genImageDirectiveKey,
  replaceGenImageDirectiveBlock,
  removeGenImageDirectiveBlock
} from '@desktop-shared/proposalGenImage'
import { fireGenImageDirective, buildGenImagePrompt } from '../../lib/proposalGenImageFire'
import { GenImageDirectiveCard } from './GenImageDirectiveCard'
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
  GripIcon
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
    <Tip label="让 AI 只依据所引《来源》原文重写本段，删掉无来源支撑的表述">
      <button
        className="ml-1 whitespace-nowrap underline hover:text-rose-800 disabled:opacity-40"
        disabled={generating}
        onClick={() => void reviseProposalSection(sec.id, 'fixSource')}
      >
        据来源修正
      </button>
    </Tip>
  )
  if (v.degraded) {
    return (
      <div className="mb-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
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
 * 编辑态：Notion 式通铺文档列（2026-07-06 重设计定稿，用户选型「通铺 + 黑体」）。
 * 此前是「灰画布 + A4 白纸 + 宋体」的 Word 隐喻——那套纸感现在完整保留在预览态
 * （ProposalPreview 才承诺与导出 Word 逐像素一致），编辑态回归屏幕舒适：
 *  - 画布即面板背景（bg-background），内容列 768px 居中，黑体（继承 app sans）、
 *    颜色一律语义 token 跟随明暗主题——旧 .proposal-paper 的纸墨 token 覆盖已随
 *    白纸一起退役（main.css）。
 *  - 悬停某节 → 左 gutter 浮出 ⋮⋮ 手柄，点开节操作菜单（AI 修订/源码逃生舱/
 *    移动/删除）；动作 handler 与禁用逻辑与旧右缘工具条完全同源，只换交互外衣。
 *  - 单节编辑仍是 editingId 单选 + textarea 就地改字。
 * 保留现有「哨兵→分节」数据模型，本次重设计不动任何 store 语义。
 */
export function ProposalPaper(): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  // 这几个 action 是 zustand 稳定引用、永不变——从 getState() 一次性取出、不订阅，
  // 避免每次 store 更新（如流式 append 新节）都白跑一遍 selector。
  const { updateSection, removeSection, moveSection, addImageReview } = useProposalStore.getState()
  // imageReviews 需要订阅（Task 11）：改图/生图产出待审阅项要驱动重渲染出对照卡，
  // 不能像上面几个稳定 action 那样只取一次。
  const imageReviews = useProposalStore((s) => s.imageReviews)
  // genimage 任务态：驱动指令块卡片的三态渲染（配图密度③）。
  const genImageJobs = useProposalStore((s) => s.genImageJobs)
  const proposalSid = useProposalStore((s) => s.sessionId)
  // 改写排队（Task 2/4/5）：队列可视化 + 丢弃提示条。两者都要订阅——入队/出队/取消、
  // 及护栏拦截写入 notice 时都得驱动这块小面板重渲染。removeRevision/setRevisionQueueNotice
  // 是稳定 action，用时从 getState() 取即可（下方渲染里直接调）。
  const revisionQueue = useProposalStore((s) => s.revisionQueue)
  const revisionQueueNotice = useProposalStore((s) => s.revisionQueueNotice)
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
  // 节操作菜单（2026-07-06 编辑器通铺重设计）：节级工具条从纸张右缘的按钮列改为左 gutter
  // 的 ⋮⋮ 手柄 + 下拉菜单（Notion 语法）。同一时刻至多开一个；动作 handler 全部复用原工具条
  // 的（AI 修订/源码逃生舱/上移下移/删除二次确认），只换交互外衣不动语义。
  const [menuSecId, setMenuSecId] = useState<string | null>(null)

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
  // disabled 就清 anchor 是同一条纪律）。
  useEffect(() => {
    if (generating || editingId || editingBlock) {
      setImgSel(null)
    }
  }, [generating, editingId, editingBlock])

  // 换图进行中（Task 10）：换图按钮点击后弹原生文件选择框，期间置 true 防止重入（用户快速
  // 双击再次弹出第二个对话框）。不做成 UI loading 态——原生对话框本身是模态的，用户能感知
  // 「点了之后弹了个框」，不需要额外的按钮态反馈。
  const [replacingImage, setReplacingImage] = useState(false)

  // 上传/生图入口现内联在选区弹框（SelectionAiBubble）里，不再挂节工具条——生图卡与上传按钮
  // 已从右侧竖条移走（用户要求：图片操作应在「选中某段文字的弹出框」内，且插到选中段落之后）。
  // uploadingSectionId 仍作跨节的上传防重入闸（handleImageUpload 内部用），弹框自身另有 imgBusy。
  const [uploadingSectionId, setUploadingSectionId] = useState<string | null>(null)

  // 改图/生图审阅卡（Task 11）：多张卡可能同时挂着（不同节的改图/生图各自独立发起），按
  // review.id 建 map 记「重改中」与「重改失败」，而非单槽状态——否则一张卡在重改会把另一张卡
  // 的按钮也锁住。
  const [reviewBusy, setReviewBusy] = useState<Record<string, boolean>>({})
  const [reviewError, setReviewError] = useState<Record<string, string | null>>({})
  // 新审阅卡登记后要滚进可视区（GUI 走查反馈：卡贴在原图下方，但原图本身可能在长节里滚出屏外，
  // 改完图找不到结果）。记下刚生成的 review id，等它挂载出 DOM（data-review-id）后平滑滚到中央——
  // 审阅本就是「看着原图对比改后图」，把用户带回原图位置是符合预期的默认行为，不突兀。
  const [scrollToReviewId, setScrollToReviewId] = useState<string | null>(null)
  // 用 layout 后一帧再滚：卡片刚 set 进 imageReviews 时对应 DOM 尚未 paint，querySelector 会落空；
  // 放到 effect（DOM 已提交）里查，命中即滚、随后清标记（一次性，避免后续无关重渲染重复滚动）。
  useEffect(() => {
    if (!scrollToReviewId) return
    const el = canvasRef.current?.querySelector(`[data-review-id="${scrollToReviewId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setScrollToReviewId(null)
  }, [scrollToReviewId, imageReviews])
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
    if (review.mode === 'directive') {
      // 应用 = 用生成图原地替换指令块。按内容键（directiveRaw+occurrence）定位而非 blockIndex
      // ——审阅悬而未决期间块序可能漂移（见 shared/proposalGenImage.ts 顶注）。
      if (!review.directiveRaw) {
        pstore.removeImageReview(review.id)
        return
      }
      const blocks = splitBlocks(sec.markdown)
      const { blocks: next, changed } = replaceGenImageDirectiveBlock(
        blocks,
        review.directiveRaw,
        review.directiveOccurrence ?? 0,
        `![${review.caption ?? '配图'}](${review.resultPath})`
      )
      if (changed) {
        pstore.updateSection(sec.id, joinBlocks(next))
      } else {
        // 内容键失配（用户手改了指令文本/已删，或同内容多实例的兄弟卡先被处理而本卡未及重编
        // 号的历史残留）。生成图是已付费产物，不能随卡片一起无声蒸发（评审 #4）——退化为
        // generate 同款「插到 blockIndex 后」（越界夹紧到节末），图落进文档，位置不满意用户
        // 在编辑态点图可删。
        console.warn('[proposal] 应用配图：指令块已不在本节（被手改或删除），退化为就近插入', {
          reviewId: review.id,
          sectionId: review.sectionId
        })
        const at = Math.min(Math.max(review.blockIndex + 1, 0), blocks.length)
        const withImg = blocks.slice()
        withImg.splice(at, 0, `![${review.caption ?? '配图'}](${review.resultPath})`)
        pstore.updateSection(sec.id, joinBlocks(withImg))
      }
      // 簿记（评审 #4）：兄弟审阅卡 occurrence 前移 + 清最高序任务键。changed=false（块已被
      // 手删）时块数同样已经少了一个实例，簿记照做，任务表才跟得上现实。
      pstore.onGenImageDirectiveRemoved(sec.id, review.directiveRaw, review.directiveOccurrence ?? 0)
      pstore.removeImageReview(review.id)
      return
    }
    if (review.mode === 'generate') {
      // 插到「选中段落之后」：blockIndex 是发起时选区末块的下标，图插在其后一位（clamp 到合法
      // 区间——审阅悬而未决期间该节可能被并发改写、块数变少，越界则退化为追加到节末）。
      const blocks = splitBlocks(sec.markdown)
      const at = Math.min(Math.max(review.blockIndex + 1, 0), blocks.length)
      blocks.splice(at, 0, `![生成图](${review.resultPath})`)
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

  // 放弃：摘审阅项；directive 模式额外把指令块从草稿里删掉（spec：丢弃 = 删除整个指令块——
  // 指令已被用户明确否决，留着会反复渲染「已生成」卡造成状态错乱）。产出图文件留在磁盘（随
  // 草稿区一并清理，不即时删盘——既定策略，见原注释）。
  function discardImageReview(review: ImageReview): void {
    const pstore = useProposalStore.getState()
    if (review.mode === 'directive' && review.directiveRaw) {
      const sec = pstore.sections.find((s) => s.id === review.sectionId)
      if (sec) {
        const { blocks: next, changed } = removeGenImageDirectiveBlock(
          splitBlocks(sec.markdown),
          review.directiveRaw,
          review.directiveOccurrence ?? 0
        )
        if (changed) pstore.updateSection(sec.id, joinBlocks(next))
        // 簿记与 applyImageReview 对称（评审 #4）：兄弟卡重编号 + 清最高序任务键。丢弃即用户
        // 否决这条指令——键清掉后 AI 之后重新产出同内容指令块仍能自动发起，不会被 done 残键
        // 永久拦下（评审 strand 场景）。
        pstore.onGenImageDirectiveRemoved(sec.id, review.directiveRaw, review.directiveOccurrence ?? 0)
      }
    }
    pstore.removeImageReview(review.id)
  }

  // 「去设置」直达：打开设置页（出图 API 表单所在）。studio 的 openSettings 不带
  // 分类参数（分类是 SettingsView 内部 local state）——定位到具体分类待设置页
  // 迁移收口后再接，先保证入口可达。
  function openImageApiSettings(): void {
    useSettingsStore.getState().openSettings()
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
      // directive 重改：用户在输入框里写的是新构图描述，必须回炉 buildGenImagePrompt 重新裹上
      // 统一风格套件（扁平商务/蓝色系/白底/中文短标签/无水印）与「为售前建设方案绘制…」框架
      // ——首次自动发起就是这么拼的（评审 #9：裸发用户文本会让重改产物与其它 directive 图
      // 风格脱节，且这些约束用户没写过、也无从补回）。generate 模式首发就是裸 prompt（选区
      // 弹框直发），重试保持一致不裹。
      const finalPrompt =
        review.mode === 'directive'
          ? buildGenImagePrompt({ caption: review.caption ?? '配图', prompt })
          : prompt
      const { path } =
        review.mode === 'edit'
          ? await window.chatApi.proposalImageEdit({
              sessionId: proposalSid,
              sourcePath: review.sourcePath as string,
              prompt
            })
          : await window.chatApi.proposalImageGenerate({ sessionId: proposalSid, prompt: finalPrompt })
      const pstore = useProposalStore.getState()
      pstore.removeImageReview(review.id)
      const id = pstore.addImageReview({
        sectionId: review.sectionId,
        blockIndex: review.blockIndex,
        sourcePath: review.sourcePath,
        resultPath: path,
        mode: review.mode,
        occurrence: review.occurrence,
        directiveRaw: review.directiveRaw,
        directiveOccurrence: review.directiveOccurrence,
        caption: review.caption
      })
      setScrollToReviewId(id)
    } catch (err) {
      setReviewError((m) => ({ ...m, [review.id]: friendlyImageError(err, review.mode) }))
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
      const id = addImageReview({
        sectionId,
        blockIndex,
        sourcePath,
        resultPath: path,
        mode: 'edit',
        occurrence
      })
      setScrollToReviewId(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: friendlyImageError(err, 'edit') }
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

  // 生图（Task 10）：选区弹框「生成图片」提交时调用（弹框自持 loading/error/prompt UI）。与改图
  // （handleImageEdit）走同一条 Task 7 IPC + 同一套错误分流约定，区别是没有 sourcePath（凭空
  // 生成，非改写既有图）。insertAfter=选区末块下标：审阅卡就锚在该块下方、应用时图插到其后一位。
  // proposalImageGenerate 是秒级网络调用，await 期间该节完全可能被并发改写，故 await 后重新从
  // store 取最新 sections 校验节仍在；下标越界的兜底交给 applyImageReview 落地时 clamp。
  async function handleImageGenerate(
    sectionId: string,
    insertAfter: number,
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
      const id = pstore.addImageReview({
        sectionId,
        blockIndex: insertAfter,
        resultPath: path,
        mode: 'generate'
      })
      setScrollToReviewId(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: friendlyImageError(err, 'generate') }
    }
  }

  // 上传（Task 10）：直接插入，不经审阅（用户已经手动选定了文件，不像生成/改图那样需要「原图
  // vs 新图」对照确认）。插到「选中段落之后」（insertAfter+1，clamp 到合法区间），走与其它手改
  // 同一条 updateSection 落盘路径。完成态（含用户取消）时重新从 store 取最新 sections——上传是
  // 原生模态对话框，用户挑文件可能耗时数秒到数十秒，这期间该节完全可能被并发的 AI 修订/其它
  // 手改替换掉，若沿用点击那一刻闭包捕获的 sec 会拿着陈旧 markdown 覆盖掉期间的新内容。返回
  // ok/error 交给选区弹框展示（用户取消视为 ok=静默收起，仅真失败才 ok:false 留错误）。
  async function handleImageUpload(
    sectionId: string,
    insertAfter: number
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!proposalSid || uploadingSectionId) return { ok: true }
    setUploadingSectionId(sectionId)
    try {
      const result = await window.chatApi.proposalImageUpload({ sessionId: proposalSid })
      if (!result) return { ok: true } // 用户取消：静默无操作
      const pstore = useProposalStore.getState()
      const sec = pstore.sections.find((s) => s.id === sectionId)
      if (!sec) return { ok: true }
      const blocks = splitBlocks(sec.markdown)
      const at = Math.min(Math.max(insertAfter + 1, 0), blocks.length)
      blocks.splice(at, 0, `![上传图](${result.path})`)
      pstore.updateSection(sectionId, joinBlocks(blocks))
      return { ok: true }
    } catch (err) {
      console.warn('[ProposalPaper] proposalImageUpload failed:', err)
      return { ok: false, message: '上传失败，请稍后重试。' }
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

  // 节操作菜单项的公共样式（通铺重设计）：Notion 式 popover 菜单项——图标 + 文字，
  // hover 淡染，禁用降透明。禁用项保留 pointer-events 以便 title 提示仍可见。
  const menuItem =
    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent'

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
    // 改图/生图审阅卡（Task 11）：卡片就地锚定在其 blockIndex 对应块的正下方——改图的对照卡紧跟
    // 原图、生图的预览卡紧跟节末块，用户不用滚到节尾找卡（GUI 走查反馈：长节里卡「跑到了别处」）。
    // blockIndex 越界（登记后该节被并发改写、块数变少）时退回节尾兜底渲染，卡不丢。
    const secReviews = imageReviews.filter((r) => r.sectionId === sec.id)
    // secBlocks 只算一次、后面块渲染循环与越界判断共用同一个数组（getBlocks 有内容缓存，但
    // 循环内每块重复调用仍是不必要的函数调用开销，性能纪律）。
    const secBlocks = getBlocks(sec.markdown)
    const secBlockCount = secBlocks.length
    const renderReviewCard = (review: ImageReview): React.JSX.Element => (
      // data-review-id：新卡登记后 scrollToReviewId effect 靠它定位 DOM 滚进可视区（见上方注释）。
      <div key={review.id} data-review-id={review.id}>
        <ProposalImageReview
          review={review}
          busy={Boolean(reviewBusy[review.id]) || generating}
          error={reviewError[review.id] ?? null}
          onApply={() => applyImageReview(review)}
          onDiscard={() => discardImageReview(review)}
          onRetry={(prompt) => void retryImageReview(review, prompt)}
          onOpenSettings={openImageApiSettings}
        />
      </div>
    )
    return (
    <section
      key={sec.id}
      className={
        'group relative rounded-md py-0.5 transition-colors ' +
        // 菜单开着时节体淡染，指明「菜单作用于这一节」（Notion 同款反馈）。
        (menuSecId === sec.id ? 'bg-accent/5' : '')
      }
    >
      {/* 节手柄（通铺重设计）：⋮⋮ 停靠在通铺列的左 padding 里（列 px-12=48px，手柄 24px 在
          -left-9 处不出列、任意面板宽不溢出）。可见性沿用原工具条的规则：默认透明，hover 本节
          或键盘聚焦（focus-within）时淡入——opacity 而非 hidden，键盘用户才能 Tab 到并唤出；
          透明态 pointer-events-none 不拦正文点击（design-review F4）。菜单打开时强制可见。 */}
      <div
        className={
          'absolute -left-9 top-1 transition-opacity duration-150 ' +
          (menuSecId === sec.id
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100')
        }
      >
        <Tip label="节操作（AI 修订 / 移动 / 删除）">
          <button
            className={
              'grid size-6 place-items-center rounded-md hover:bg-muted hover:text-foreground ' +
              (menuSecId === sec.id ? 'bg-muted text-foreground' : 'text-muted-foreground')
            }
            onClick={() => {
              setConfirmDeleteId(null)
              setMenuSecId(menuSecId === sec.id ? null : sec.id)
            }}
            aria-label="节操作菜单"
            aria-expanded={menuSecId === sec.id}
          >
            <GripIcon />
          </button>
        </Tip>
        {menuSecId === sec.id && (
          <>
            {/* 点击空白处关闭（全屏透明捕获层，置于菜单下方）——与导出下拉同款模式。 */}
            <button
              type="button"
              aria-label="关闭节操作菜单"
              tabIndex={-1}
              className="fixed inset-0 z-20 cursor-default"
              onClick={() => {
                setMenuSecId(null)
                setConfirmDeleteId(null)
              }}
            />
            <div className="proposal-anim-pop absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
              {/* AI 修订组：仅正文节（封面/目录无修订语义）。发起【整节替换】式重写，流式中禁用。 */}
              {sec.kind === 'content' && (
                <>
                  <Tip label="让 AI 整节重写这一章，替换现有内容">
                    <button
                      className={menuItem}
                      disabled={generating}
                      onClick={() => {
                        setMenuSecId(null)
                        void reviseProposalSection(sec.id, 'rewrite')
                      }}
                    >
                      <RotateCwIcon className="shrink-0 text-muted-foreground" />
                      AI 重写本章
                    </button>
                  </Tip>
                  <Tip label="让 AI 在原有基础上补充细节、把这一章写得更详尽">
                    <button
                      className={menuItem}
                      disabled={generating}
                      onClick={() => {
                        setMenuSecId(null)
                        void reviseProposalSection(sec.id, 'expand')
                      }}
                    >
                      <PlusIcon className="shrink-0 text-muted-foreground" />
                      AI 展开（更详尽）
                    </button>
                  </Tip>
                  <Tip label="让 AI 删去冗余与重复、精简这一章">
                    <button
                      className={menuItem}
                      disabled={generating}
                      onClick={() => {
                        setMenuSecId(null)
                        void reviseProposalSection(sec.id, 'shorten')
                      }}
                    >
                      <MinusIcon className="shrink-0 text-muted-foreground" />
                      AI 精简（去冗余）
                    </button>
                  </Tip>
                  <div className="my-1 h-px bg-border" />
                  {/* 生成图片/上传图片入口在选区弹框（SelectionAiBubble）——图片操作需要「插到
                      哪里」的落点，选中段落天然就是那个锚点。 */}
                </>
              )}
              <Tip label="直接编辑这一节的 Markdown 源码，用于修表格、批量替换等场景">
                <button
                  className={menuItem}
                  // 生成中禁止【打开】整节源码逃生舱（review V2）：某节 blockRange 修订在飞时，若用户开
                  // 源码框改动本节使块布局变化，轮末 spliceBlocks 会按旧下标拼进错块、静默覆盖。已打开
                  // 的仍允许关闭。
                  disabled={generating && editingId !== sec.id}
                  onClick={() => {
                    if (generating && editingId !== sec.id) return
                    setEditingBlock(null)
                    setEditingId(editingId === sec.id ? null : sec.id)
                    setMenuSecId(null)
                  }}
                >
                  {editingId === sec.id ? (
                    <CheckIcon className="shrink-0 text-muted-foreground" />
                  ) : (
                    <PencilIcon className="shrink-0 text-muted-foreground" />
                  )}
                  {editingId === sec.id ? '完成源码编辑' : '编辑整节源码（逃生舱）'}
                </button>
              </Tip>
              {/* 上移/下移不关菜单：连续排序时不必反复重开。禁用逻辑与 moveSection 的
                  同 kind 约束精确对齐（见 canMoveUp/Down 注释）。 */}
              <Tip label="把这一节和上一节交换位置（仅同区段内）">
                <button
                  className={menuItem}
                  disabled={!canMoveUp}
                  onClick={() => moveSection(sec.id, 'up')}
                >
                  <ArrowUpIcon className="shrink-0 text-muted-foreground" />
                  上移
                </button>
              </Tip>
              <Tip label="把这一节和下一节交换位置（仅同区段内）">
                <button
                  className={menuItem}
                  disabled={!canMoveDown}
                  onClick={() => moveSection(sec.id, 'down')}
                >
                  <ArrowDownIcon className="shrink-0 text-muted-foreground" />
                  下移
                </button>
              </Tip>
              {/* 分隔线：把不可逆的「删除」与上方动作分组隔开，降低误触（design-review F5）。
                  两步确认保留：第一击武装成红底确认项（3s 无操作自动撤销，见 confirmDeleteId
                  effect），第二击才真删。 */}
              <div className="my-1 h-px bg-border" />
              {confirmDeleteId === sec.id ? (
                <Tip label="再点一次，永久删除本节（3 秒后自动取消）">
                  <button
                    className="flex w-full items-center gap-2 rounded-md bg-rose-500 px-2.5 py-1.5 text-left text-[12px] font-medium text-white"
                    onClick={() => {
                      if (editingId === sec.id) setEditingId(null)
                      if (editingBlock?.sectionId === sec.id) setEditingBlock(null)
                      removeSection(sec.id)
                      setConfirmDeleteId(null)
                      setMenuSecId(null)
                    }}
                  >
                    <CheckIcon className="shrink-0" />
                    再点一次确认删除
                  </button>
                </Tip>
              ) : (
                <Tip label="删除本节（需再点一次确认）">
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-rose-500 hover:bg-rose-500/10"
                    onClick={() => setConfirmDeleteId(sec.id)}
                  >
                    <TrashIcon className="shrink-0" />
                    删除本节
                  </button>
                </Tip>
              )}
            </div>
          </>
        )}
      </div>

      {sec.truncated && (
        <div className="mb-1 flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600">
          <span>这一段较长，生成被中断，内容可能不完整。</span>
          {/* 续写只对正文节有意义（reviseProposalSection 对非 content 直接 no-op）；封面/目录极少
              截断，若真发生则只提示不给按钮，避免一个点了没反应的死按钮。 */}
          {sec.kind === 'content' && (
            <Tip label="让 AI 接着把这一段被中断的内容写完">
              <button
                className="whitespace-nowrap underline hover:text-amber-800 disabled:opacity-40"
                disabled={generating}
                onClick={() => void reviseProposalSection(sec.id, 'resume')}
              >
                继续写完
              </button>
            </Tip>
          )}
        </div>
      )}

      {renderVerification(sec, generating)}

      {editingId === sec.id ? (
        // 整节源码逃生舱：改坏的表格、批量替换等场景。默认不再是主路径。
        // readOnly={generating}：生成中（尤其某节 blockRange 修订在飞）冻结手改，防止改动使块布局漂移
        // 致轮末 spliceBlocks 拼错块（review V2）；生成结束即恢复可编辑。
        <textarea
          className="min-h-[120px] w-full resize-y rounded-sm bg-accent/5 font-mono text-[13px] leading-[1.8] text-foreground outline-none read-only:opacity-60"
          value={sec.markdown}
          autoFocus
          readOnly={generating}
          onChange={(e) => updateSection(sec.id, e.target.value)}
        />
      ) : (
        // 逐块渲染：DOM 块索引 = splitBlocks 下标（Task 5 选区映射靠 data-block-index）。
        // 双击某块 → 只有那一块进就地编辑；其余块照常渲染（含来源高亮）。secBlocks 已在上方按
        // 内容缓存分块一次，这里直接复用，不在循环里重复调用 getBlocks（性能纪律）。
        secBlocks.map((blk, bi) => (
          <Fragment key={bi}>
          {editingBlock && editingBlock.sectionId === sec.id && editingBlock.blockIndex === bi ? (
            <textarea
              className="my-1 min-h-[64px] w-full resize-y rounded-sm bg-accent/5 text-[14.5px] leading-[1.85] text-foreground outline-none read-only:opacity-60"
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
          ) : isGenImageDirectiveBlock(blk) ? (
            // genimage 指令块（配图密度③）：不当普通段落渲染，换成卡片。不给 data-block-index
            // ——它不参与文字选区与点图交互；双击编辑对指令块无意义，走整节源码逃生舱即可。
            (() => {
              // occurrence：同内容指令块按块序数第几个（与 parseGenImageDirectives / fireGenImageDirective
              // 的口径一致）。secBlocks 已在上面按内容缓存分块一次，这里复用，不重新 splitBlocks。
              let occ = 0
              for (let k = 0; k < bi; k++) {
                if (secBlocks[k].trim() === blk.trim()) occ++
              }
              const content = parseGenImageBlock(blk)
              const key = genImageDirectiveKey(sec.id, blk.trim(), occ)
              // hasReview：job done 但对应审阅卡是否还在（reopen/leaveMode 清 imageReviews、保
              // genImageJobs 的不对称搁浅态，见 GenImageDirectiveCard 顶注）。按内容键 + occurrence
              // 匹配，与 applyImageReview/discardImageReview 的落位判据一致。
              const hasReview = secReviews.some(
                (r) =>
                  r.mode === 'directive' &&
                  r.directiveRaw === blk.trim() &&
                  (r.directiveOccurrence ?? 0) === occ
              )
              return (
                <GenImageDirectiveCard
                  caption={content?.caption ?? '配图'}
                  job={genImageJobs[key]}
                  hasReview={hasReview}
                  generating={generating}
                  onGenerate={() => {
                    if (!proposalSid || !content) return
                    void fireGenImageDirective(proposalSid, sec.id, {
                      ...content,
                      blockIndex: bi,
                      occurrence: occ,
                      raw: blk.trim()
                    })
                  }}
                  onOpenSettings={openImageApiSettings}
                />
              )
            })()
          ) : (
            <div
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
          )}
          {/* 本块名下的审阅卡：紧跟锚定块渲染（改图卡贴原图、生图卡贴节末块）。同一块可挂多张
              （并发对同块多图各自发起改图），按 imageReviews 数组原样顺序渲染，不做单选收窄。 */}
          {secReviews.filter((r) => r.blockIndex === bi).map(renderReviewCard)}
          </Fragment>
        ))
      )}

      {/* 审阅卡兜底渲染（就地内联而非浮层，理由见 ProposalImageReview.tsx 顶部注释）：
          - 整节源码逃生舱打开时逐块渲染整体缺席，全部卡退到节尾，卡不随 textarea 消失；
          - blockIndex 越界（登记后该节被并发改写、块数变少）时同样退到节尾。 */}
      {(editingId === sec.id
        ? secReviews
        : secReviews.filter((r) => r.blockIndex < 0 || r.blockIndex >= secBlockCount)
      ).map(renderReviewCard)}
    </section>
    )
  }

  return (
    <div
      // 通铺画布：不再挂 .proposal-canvas 灰底（那是预览态的 Word 画布），编辑态画布即
      // 面板背景（bg-background），文档「坐在」应用里而非「印在」纸上。
      ref={canvasRef}
      className="relative flex-1 overflow-auto bg-background py-6"
      onClick={handlePaperClick}
    >
      {/* 改写排队面板 + 丢弃提示条（Task 5）：sticky 贴在画布顶部，AI 忙时排的改写在这里
          可见、可取消；护栏拦下（队列满/冲突）的提示也落这。对齐正文列宽（768px + px-12），
          与下方内容左右对齐。裸 <button> 会被 canvas 全局 reset 填成描边卡片，故都加 data-slot
          逃逸（见 CLAUDE.md 样式铁律）。仅在有内容要展示时占位，空时不占高。 */}
      {(revisionQueue.length > 0 || revisionQueueNotice) && (
        <div className="sticky top-0 z-30 mx-auto mb-4 w-[min(768px,100%)] px-12">
          {revisionQueueNotice && (
            <div className="mb-2 flex items-start gap-1 rounded bg-amber-500/10 px-2 py-1 text-[12px] text-amber-700 dark:text-amber-400">
              <span>{revisionQueueNotice}</span>
              <Tip label="知道了，关闭这条提示">
                <button
                  type="button"
                  data-slot="queue-notice-close"
                  className="ml-auto shrink-0 hover:underline"
                  onClick={() => useProposalStore.getState().setRevisionQueueNotice(null)}
                >
                  知道了
                </button>
              </Tip>
            </div>
          )}
          {revisionQueue.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 p-2 text-[12px] shadow-sm backdrop-blur">
              <div className="mb-1 font-medium text-muted-foreground">改写排队中（{revisionQueue.length}）</div>
              {revisionQueue.map((r, i) => (
                <div key={r.id} className="flex items-center gap-2 py-0.5">
                  <span className="shrink-0 text-muted-foreground">{i + 1}.</span>
                  <span className="truncate">{r.instruction}</span>
                  <Tip label="取消这条排队中的改写">
                    <button
                      type="button"
                      data-slot="queue-cancel"
                      className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => useProposalStore.getState().removeRevision(r.id)}
                    >
                      取消
                    </button>
                  </Tip>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {sections.length === 0 && !generating ? (
        /* 空态（重设计）：不再渲染一张空白纸 + 一行「等待 AI 起草…」灰字，改为画布上
           居中的三步旅程引导——叠纸插画（品牌绿封面色块）+ 标题 + 三阶段卡片，把
           「封面→目录→正文、每步由你确认」的心智模型在动笔前就交给用户。用 chat 语义
           token（bg-card 等）而非纸墨色：本块在 .proposal-paper 之外、直接坐在画布上，
           要跟随明暗主题。生成一旦开始即切到下方的纸张骨架分支。 */
        <div className="grid min-h-full place-items-center px-8">
          <div className="max-w-md py-8 text-center">
            <div aria-hidden className="relative mx-auto mb-7 h-40 w-[8.25rem]">
              <div className="absolute inset-0 -translate-x-2 translate-y-1 -rotate-[5deg] rounded-lg border border-border/60 bg-card opacity-50 shadow-sm" />
              <div className="absolute inset-0 translate-x-1.5 translate-y-0.5 rotate-[3deg] rounded-lg border border-border/60 bg-card opacity-70 shadow-sm" />
              <div className="absolute inset-0 flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-4 shadow-md">
                <div className="mb-1 h-9 rounded-md bg-brand/80" />
                <div className="h-1.5 w-3/5 rounded-full bg-muted" />
                <div className="h-1.5 w-[85%] rounded-full bg-muted" />
                <div className="h-1.5 w-2/5 rounded-full bg-muted" />
              </div>
            </div>
            <h2 className="mb-2 text-[15px] font-semibold text-foreground">从封面开始你的方案</h2>
            <p className="mb-7 text-[12px] leading-relaxed text-muted-foreground">
              在左侧对话里说明客户与需求，AI 会检索知识库，
              按三个阶段逐步生成完整方案，每一步都由你确认。
            </p>
            <div className="grid grid-cols-3 gap-2 text-left">
              {[
                { step: '第 1 步', name: '封面', desc: '项目名称、客户与日期' },
                { step: '第 2 步', name: '目录', desc: '章节大纲，确认后动笔' },
                { step: '第 3 步', name: '正文', desc: '逐章撰写，可随时修订' }
              ].map((j, i) => (
                <div
                  key={j.name}
                  className={
                    'rounded-xl border bg-card p-3 ' +
                    /* 空态必在封面阶段（有内容即非空态），首卡即当前步，静态高亮即可。 */
                    (i === 0 ? 'border-brand/40 ring-[3px] ring-brand/10' : 'border-border')
                  }
                >
                  <div className="mb-1 text-[10px] font-semibold tracking-wide text-brand">{j.step}</div>
                  <div className="mb-0.5 text-[12.5px] font-semibold text-card-foreground">{j.name}</div>
                  <div className="text-[11px] leading-snug text-muted-foreground">{j.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
      /* 通铺内容列（2026-07-06 编辑器重设计）：白纸浮卡换成 Notion 式通铺——画布即文档、
         内容列 768px 居中、黑体（继承 app sans）。左右 px-12 是节手柄的 gutter（手柄 -left-9
         落在其中）。「Word 纸感」完整保留在预览态（那边才承诺与导出逐像素一致），编辑态
         回归屏幕舒适。颜色一律语义 token：通铺后内容坐在 app 背景上，必须跟随明暗主题
         （bg-white 暗档白块，踩过）。 */
      <div className="mx-auto w-[min(768px,100%)] px-12 pb-24 pt-4 text-[15px] leading-[1.85] text-foreground">
        {sections.length === 0 ? (
          /* 撰写中骨架：sections 只在每条消息 end 才整批落地，首轮生成期间列面会长时间
             全空——脉动骨架行给出「正在写」的活性反馈，替代原先孤零零一行灰字。 */
          <div className="py-6">
            <div aria-hidden className="animate-pulse">
              <div className="mb-10 h-7 w-1/2 rounded bg-muted" />
              <div className="mb-3.5 h-3 w-[90%] rounded bg-muted" />
              <div className="mb-3.5 h-3 w-[82%] rounded bg-muted" />
              <div className="h-3 w-3/4 rounded bg-muted" />
            </div>
            <div className="mt-9 text-center text-[12px] text-muted-foreground">
              AI 正在撰写，完成的部分会陆续出现…
            </div>
          </div>
        ) : (
          (() => {
            let running = -1 // 跨组累计全局下标，喂给 renderSection 做首尾禁用判断
            return groups.map((g, gi) => (
              // key 用组下标而非 g.kind：组下标在本次渲染中永远唯一且与 sections 顺序一致。
              // （moveSection 现已限制为同 kind 组内交换，sections 始终按 kind 连续、每 kind
              //  至多一组，故 g.kind 理论上也唯一；仍用组下标作 key，对未来放宽移动规则更稳健。）
              <div key={gi} className={(gi > 0 ? 'mt-9 ' : '') + 'mb-2'}>
                {/* kind 分组标签（通铺重设计）：灰字+底边线升级为 pill + 细线——通铺后没有
                    纸张分节，分组标记要立得住又不抢正文（Notion 式轻分隔）。 */}
                <div className="mb-2.5 flex select-none items-center gap-2.5">
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground">
                    {KIND_LABEL[g.kind]}
                  </span>
                  <span className="h-px flex-1 bg-border/60" />
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
      )}
      {/* 选区即改浮层：贴选区尾浮出，作用于选区覆盖的块区间。生成中禁用（与块手改一致）。 */}
      <SelectionAiBubble
        containerRef={canvasRef}
        disabled={generating}
        // 图片入口（生成/上传）内联在弹框里，仅正文节可用（docx 只给正文节嵌图）；插到选中段落之后。
        resolveSectionKind={(id) => sections.find((s) => s.id === id)?.kind}
        onGenerateImage={handleImageGenerate}
        onUploadImage={handleImageUpload}
        onOpenSettings={openImageApiSettings}
      />
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
          onOpenSettings={openImageApiSettings}
        />
      )}
    </div>
  )
}
