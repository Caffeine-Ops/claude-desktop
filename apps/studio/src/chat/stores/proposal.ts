import { create } from 'zustand'

import type { ProposalDraftBlock, ProposalKind, SectionVerification } from '@desktop-shared/proposal'
import { appendDraftBlocks, sortSectionsByKind, collapseSingletonSections } from '@desktop-shared/proposal'
import type { ProposalDraftRecord } from '@desktop-shared/ipc-channels'
import { parseGenImageDirectives, genImageDirectiveKey, genImageRawHash } from '@desktop-shared/proposalGenImage'
import { useChatStore } from './chat'

export interface ProposalProduct {
  productLine: string
  product: string
}

export interface ProposalSection {
  // 稳定 id：React key + 增删/重排定位。renderer 浏览器环境可用 crypto.randomUUID()。
  id: string
  markdown: string
  // 该节由「截断恢复」产生：AI 写了起始哨兵但流被截断、无结束哨兵，内容可能不完整。
  // 面板对其打「疑似截断」徽标提示用户复核。正常闭合块不带此标志（undefined）。
  truncated?: boolean
  // 该节属于哪个阶段（封面/目录/正文）。由 appendSections 取自【哨兵块自带的 kind】
  // （AI 用封面/目录/正文哨兵声明），不再依赖 store.phase——这样聊天驱动阶段（phase
  // 未推进）时目录也归到目录区，不会错塞进封面区（重复目录的根因修复）。决定草稿分区
  // 渲染（ProposalPaper）与导出分页（buildProposalMarkdown）。
  kind: ProposalKind
  // 引用落地校验结果（#1）：仅 content 节有意义，由 FusionRuntimeProvider 在该节生成后
  // 异步经 IPC 取回、setSectionVerification 回填。undefined = 尚未校验/校验中（UI 显示
  // 「未校验」灰态）。【不持久化】：不进 ProposalDraftRecord，重开会话后按需重算或留空——
  // 它是派生信号，沉到盘上只会与正文漂移。
  verification?: SectionVerification
  // 该节【AI 生成时的原文】，M-0 埋点的可交付率代理基准：导出时 markdown 与它的字数差
  // = 用户从生成到交付改了多少。appendSections 时设为 AI 产出原文；restore 路径无从知晓
  // 真原文，退而以重建出的 markdown 为基准（编辑量从重开后算起）。updateSection 故意不动它。
  // 【不持久化】：同 verification，是派生信号，不进 ProposalDraftRecord。
  baselineMarkdown?: string
}

// 选区即改的「先审阅后落地」提案，挂在【发起改写那一轮的助手消息 id】下。仅【选区块修订】走此流
// （整章重写/展开/精简/据来源修正/补料等仍即时落地）。由 ThreadView 在对应助手消息下方渲染
// 「原文 vs 改写后」对照 + [应用/放弃/继续改]，用户点「应用」才 spliceBlocks 落地。瞬时 UI 信号，
// 不持久化（重开会话不复现待审阅项，符合直觉——未决的改写不该跨会话留存）。
export interface BlockRevisionReview {
  sectionId: string
  blockRange: { start: number; end: number }
  before: string // 选区覆盖块的原文（splitBlocks 切片 join）
  after: string // AI 改写后正文（去哨兵的干净 markdown）
}

// 选区改写排队项：AI 忙时用户又发起的改写意图。故意【不存最终 blockRange】——排队期间前面的
// 改写可能落地、块序号会漂；排空时才用 selectedText 在最新 markdown 里重定位（resolveRevisionTarget
// → locateBlockRangeByTextWithHint）。
// hintRange = 入队那刻的块区间，【仅】在 selectedText 多处命中时当裁判选最近的一处（CEO 护栏#3），
// 不作主定位。瞬时 UI 信号，不持久化（同 blockReviews/pendingRevision）。
export interface QueuedRevision {
  id: string
  sectionId: string
  selectedText: string
  instruction: string
  hintRange: { start: number; end: number }
}

// 点图工具栏（Task 9）发起改图/生成后的「待审阅」项，挂在数组里（非 blockReviews 那种以助手
// 消息 id 为 key——图片操作不经 SDK 轮，没有 messageId 可挂）。Task 11 在此之上渲染「原图 vs
// 新图」对照卡 + 应用/放弃。id 由 addImageReview 生成（crypto.randomUUID()），供 Task 11 增删。
// 瞬时 UI 信号，不持久化（同 blockReviews：未决的图片改写不该跨会话留存）。
export interface ImageReview {
  id: string
  sectionId: string
  blockIndex: number
  sourcePath?: string // mode='generate'/'directive' 时没有源图，故可空
  resultPath: string
  // 'directive' = genimage 指令块自动生图（配图密度③）：应用=原地替换指令块，丢弃=删指令块，
  // 与 'generate'（追加插入到 blockIndex 之后）落位语义不同，必须分流。
  mode: 'edit' | 'generate' | 'directive'
  // mode='edit' 时，源图在该块内【同路径出现序列】里的下标（0 起，来自 ProposalPaper
  // handlePaperClick 从 DOM 数出的 imgSel.occurrence）——应用时喂给 replaceImageOccurrence
  // 精确定位换哪一张（同一块贴了两张同路径图时不误换）。mode='generate' 没有源图、无意义，
  // 缺省即可（Task 11 应用逻辑按 mode 分流，不读 generate 项的这个字段）。
  occurrence?: number
  // mode='directive'：指令块原文（trim）+ 同内容出现序——落位手术按内容键定位（块序漂移免疫，
  // 见 shared/proposalGenImage.ts 顶注），blockIndex 只用于审阅卡渲染锚定。
  directiveRaw?: string
  directiveOccurrence?: number
  // mode='directive'：图说，落位时作 `![图说](路径)` 的 alt 文字。
  caption?: string
}

// genimage 指令块的生图任务态（配图密度③）。键 = genImageDirectiveKey(sectionId, raw, occurrence)。
// 三重职责：① 幂等 seen 集合——键存在（无论何态）即不再自动发起，防重复烧钱；② 驱动指令块卡片
// 的多态渲染（pending 转圈 / failed 错误+重试 / done 提示看审阅卡 / manual 手动生成）；③ restore
// 重建路径把既存指令块预登记成 manual 哨兵 → 卡片渲染成手动态、autoFire 永不自动补发（终审 I-1）。
// 瞬时 UI 信号，不持久化（与 imageReviews 同重置点清空）。
export interface GenImageJob {
  // manual = restore 重建时预登记的「旧指令块」哨兵（见 seedManualGenImageJobs）：autoFire 视为
  // 已见永不自动发起，卡片渲染成手动生成态；用户点按钮时被 fireGenImageDirective 覆写回 pending。
  status: 'pending' | 'failed' | 'done' | 'manual'
  error?: string
}

// restore 重建路径的预登记：把重建出的 sections 里【当下就存在】的指令块全部登记成 manual 态
// 哨兵，堵住「重开会话后下一轮 end 把陈旧指令块当新块自动补发生图」的扣费泄漏（终审 I-1）。
// 只有【重建之后新产出】的指令块才没有键、才会被 autoFire 自动发起——与「自动发起仅限生成
// 会话进行中的落节时机」的 spec 语义精确对齐。
function seedManualGenImageJobs(sections: ProposalSection[]): Record<string, GenImageJob> {
  const jobs: Record<string, GenImageJob> = {}
  for (const sec of sections) {
    if (sec.kind !== 'content') continue
    for (const d of parseGenImageDirectives(sec.markdown)) {
      jobs[genImageDirectiveKey(sec.id, d.raw, d.occurrence)] = { status: 'manual' }
    }
  }
  return jobs
}

interface ProposalState {
  active: boolean
  // 方案绑定的会话 ID——只有该 session 的 send 才带 proposalMode=true，
  // 只有该 session 的 end 事件输出才被累积进 sections。
  // null 表示当前没有活跃方案会话。
  sessionId: string | null
  // 本次方案识别到的产品集（可空）。发送时由 matchProducts 写入，chip 删除时更新。
  // 收窄检索范围用：空 = 退回整个镜像根目录由 AI 自行 Grep 定位。
  products: ProposalProduct[]
  // 是否已对「首发用户文本」做过产品匹配播种。一旦为真，后续 turn 一律复用 products
  // （即便为空），不再重复 readKbIndex/matchProducts、也不会在会话中途忽然命中而
  // 骤然收窄检索范围。零命中也算已播种——这正是修复点：原来用 products.length===0 当
  // 「未播种」，零命中时会每个 turn 反复重匹配并可能突变。chip 删除走 setProducts，
  // 不触碰本标志（用户清空 chip 后仍维持已播种、不重新匹配）。
  seeded: boolean
  // 已累积进 sections 的 assistant 消息 id 集合。end 事件可能对同一 messageId
  // 二次触发（异常路径重发等）；按 id 去重，避免同一段正文被重复 append 进节。
  consumedDraftIds: Set<string>
  // 分节草稿：每个 AI 哨兵块一节（旧的 docMarkdown/setDoc 单串路径已移除）。
  sections: ProposalSection[]
  // 当前生成阶段，封面→目录→正文有序推进，是给哨兵块打 kind 与驱动阶段条 UI 的
  // 单一真相源。start() 起为 'cover'。cover→toc 由 AI 目录哨兵块经 laterPhase 自动推进；
  // toc→content 由用户在聊天里点选 AskUserQuestion 的「确认目录」放行项时，经
  // applyProposalStageConfirm 调 advancePhase('content') 推进（不再有右侧确认按钮）。
  phase: ProposalKind
  // 方案工作台是否接管布局（撤对话历史栏 + 可折叠对话列 + 宽纸张区）。
  // 与 active 分离：「返回」只关工作台、不销毁草稿，可再入。start() 时置 true。
  workspaceOpen: boolean
  // 文档面板「编辑｜预览」视图。提到 store 而非 ProposalDocPanel 本地 state：面板在
  // 前台会话切走时会整体卸载（!show → return null），本地 state 会被重置回默认态，
  // 用户切回会被悄悄拽回。放 store 里跨卸载存活（评审 #3）。
  // 默认值为 'preview'（进页面先看预览，可经切换按钮切到 'edit'）——见各初始化点。
  viewMode: 'edit' | 'preview'
  // 阶段门拦截提示：AI 越过「目录确认门」（唯一被 gate 的转换 toc→content）直接吐正文、
  // 被 appendSections 的阶段门拦下时，记本轮被拦的越界块数，供面板显示一行红字提示用户
  // 「AI 跳过了目录，请先生成确认目录」。null=无待提示。纯 UI 瞬时信号，不持久化、不进
  // ProposalDraftRecord——它描述的是「刚发生的一次跳阶」，重开会话无意义。
  stageSkip: { count: number } | null
  // 定向修订指针：非空时下一轮 end 的 content 产出替换目标节。blockRange 缺省=整节替换
  // （节重写/展开/精简/据来源修正/截断续写/补料，向后兼容）；blockRange 存在=只替换该节的
  // 第 [start,end] 块（选区即改），由 FusionRuntimeProvider end 分流 spliceBlocks 拼回。瞬时
  // UI 信号，不持久化。
  pendingRevision: { sectionId: string; blockRange?: { start: number; end: number } } | null
  // 资料缺失·待补料标记：用户在【只读】草稿里点某处缺口的「去对话框补充」按钮时置，记住「这一章
  // 有这处缺口正等你在对话框里补料」。语义与交互——点按钮【不发任何消息给 AI】（不让 AI 在用户
  // 还没给资料时就空跑），只置本标记：① 左侧输入框上方据它弹一条提示条，把「缺什么」告诉用户、
  // 请其在下方输入这段资料并发送；② 用户发送那条消息时，onNew 发送收口据本标记把用户原文【包进
  // 「只重写这一章、删缺口标记、按溯源规则标来源」的指令】发给引擎，并置 pendingRevision 让 end
  // 分流整节替换、随即清掉本标记。故 AI 只在用户真正给了资料后才运行、且一轮内完成重写（复用成熟
  // 的 pendingRevision 替换机制，不产生重复章节）。gapDesc 同时用于提示条文案与重写指令。瞬时 UI
  // 信号，不持久化。
  pendingGapFill: { sectionId: string; gapDesc: string } | null
  // 选区即改的待审阅提案，key=发起那轮的助手消息 id。非空项由 ThreadView 在该消息下渲染对照+按钮，
  // 应用才落地。瞬时 UI 信号，不持久化。可同时挂多条（不同消息各自独立审阅）。
  blockReviews: Record<string, BlockRevisionReview>
  // 选区改写排队（FIFO）：AI 生成中用户又发起的改写按顺序排这里，一轮 end 后排空函数取队头串行发。
  // 见 QueuedRevision 顶注。瞬时 UI 信号，不持久化，与 blockReviews 同重置点清空。
  revisionQueue: QueuedRevision[]
  // 排队项被跳过的可见提示（CEO 护栏#2·零静默失败）：重定位失败/目标节已删时，排空函数置一句文案，
  // 面板据此显示一行黄字（用户看得见"我排的某个改写没执行"），而非只往 console 里 warn 后静默丢。
  // 纯瞬时 UI 信号，用户手动关或下次成功排空时清。
  revisionQueueNotice: string | null
  // 点图工具栏（Task 9）发起的改图/换图/生图「待审阅」项列表，Task 11 据此渲染对照卡。同
  // blockReviews：瞬时 UI 信号，不持久化，在与 blockReviews 相同的重置点一并清空。
  imageReviews: ImageReview[]
  genImageJobs: Record<string, GenImageJob>
  // 草稿写盘是否处于失败态（P3-3）：flushProposalSave 拿到 {ok:false} 或 IPC 抛错时置 true，
  // 下次成功落盘置 false。面板据此显示「草稿未保存」常驻提示——写盘失败（磁盘满/权限/路径）
  // 原本是 fire-and-forget 静默吞掉，用户误以为已存、切走就丢。非阻塞、不持久化，纯运行时
  // 健壮性信号；重开/新建方案各路径都清回 false（旧会话的失败态不泄漏到新草稿）。
  draftSaveFailed: boolean
  start: (sessionId: string) => void
  setProducts: (products: ProposalProduct[]) => void
  // 首发播种：写入产品集并置 seeded=true（与 setProducts 区分——后者是 chip 编辑）。
  seedProducts: (products: ProposalProduct[]) => void
  markDraftConsumed: (messageId: string) => void
  // 哨兵块 → 节：messageId 去重后，每块成一节追加到尾部，kind 取自块自带标签。truncated
  // 为截断恢复的残块（非空时）额外追加一节并标记 truncated:true，避免半截正文被静默丢弃（B2）。
  appendSections: (
    messageId: string,
    blocks: ProposalDraftBlock[],
    truncated?: ProposalDraftBlock | null
  ) => void
  // 轮内增量同步：把当前在飞消息里【已闭合】的哨兵块即时入库，不必等轮末 'end'。AskUserQuestion
  // 暂停确认时由 FusionRuntimeProvider 调用——AI 在一个 SDK 轮里生成封面/目录后用 AskUserQuestion
  // 暂停、该轮 'end' 迟迟不到，期间右侧草稿会一直空（用户报的 bug）。只靠内容级去重幂等、不碰
  // messageId（同消息余下块仍由轮末 appendSections 入库）；不传截断残文（半截轮末才入库）。
  syncSections: (blocks: ProposalDraftBlock[]) => void
  // 推进到目标阶段（cover→toc→content）。只改 phase，不动 sections——已生成的封面/
  // 目录节保持原 kind。按钮在调用本方法后另发推进消息给 AI。
  advancePhase: (to: ProposalKind) => void
  // 清除阶段门拦截提示（用户点关闭、或阶段推进动作 confirmCover/confirmToc 调用以抹掉
  // 陈旧提示）。
  clearStageSkip: () => void
  // 标记/清除「下一轮产出要替换哪一节」。reviseProposalSection 发起修订前置，end 分流后清。
  setPendingRevision: (
    pending: { sectionId: string; blockRange?: { start: number; end: number } } | null
  ) => void
  // 置/清待补料标记。startProposalGapFill 点缺口「去对话框补充」时置；onNew 发送收口在用户发出
  // 那条补料消息时消费并清（见 FusionRuntimeProvider onNew）。也用于提示条的显隐与取消。
  setPendingGapFill: (pending: { sectionId: string; gapDesc: string } | null) => void
  // 选区即改·审阅项增删。addBlockReview：end 分流把「原文 vs 改写后」登记到该轮助手消息 id 下。
  // removeBlockReview：用户点应用/放弃、或「继续改」发起新一轮时，撤掉旧项。
  addBlockReview: (messageId: string, review: BlockRevisionReview) => void
  removeBlockReview: (messageId: string) => void
  // 选区改写排队增删。enqueue 返回稳定 id 供 UI 取消；dequeue 弹队头供排空函数；clear 用于各重置点。
  enqueueRevision: (item: Omit<QueuedRevision, 'id'>) => string
  dequeueRevision: () => QueuedRevision | null
  removeRevision: (id: string) => void
  clearRevisionQueue: () => void
  setRevisionQueueNotice: (notice: string | null) => void
  // 点图工具栏·审阅项增删（Task 9 产出、Task 11 消费）。addImageReview 生成并返回稳定 id
  // （调用方目前不必用，但契约要求返回，供 Task 11 未来精确定位/去重）。
  addImageReview: (review: Omit<ImageReview, 'id'>) => string
  removeImageReview: (id: string) => void
  // genimage 任务态登记/更新（配图密度③）。整表清空走各 reset 点，不提供任意删除——
  // 唯一的定点清理入口是下面的 onGenImageDirectiveRemoved。
  setGenImageJob: (key: string, job: GenImageJob) => void
  // 指令块被应用/丢弃（从草稿里移除一个 (sectionId, raw) 的实例）后的簿记（评审 #4）：
  // ① 同节同内容、occurrence 更大的兄弟审阅卡就地减一——否则块重编号后旧 occurrence 越界，
  //    「应用」静默 no-op、已付费生成图被丢弃；
  // ② 删掉该 (sectionId, raw) 下 occurrence 最大的任务键——任务表与剩余块数对齐，幸存块的
  //    键继续命中各自任务；单实例场景键被清空后，AI 之后重新产出同内容指令块才能再次自动
  //    发起（否则 done 残键让 autoFire 永久跳过、卡片还挂着误导性的「已失效」文案）。
  onGenImageDirectiveRemoved: (sectionId: string, raw: string, occurrence: number) => void
  // 标记/清除草稿写盘失败态（P3-3）。flushProposalSave 落盘后调用：失败 true、成功 false。
  setDraftSaveFailed: (failed: boolean) => void
  // 用 AI 新产出整节替换指定节：同步把 baselineMarkdown 也更新成新原文（否则 M-0 埋点会把
  // 「AI 重写」误算成用户编辑量），并重置 verification=undefined 触发重校验、清 truncated。
  reviseSection: (id: string, markdown: string) => void
  updateSection: (id: string, markdown: string) => void
  // 回填某节的引用校验结果（#1）。section 可能已被删/重排，故按 id 查找；找不到则 no-op。
  setSectionVerification: (id: string, verification: SectionVerification) => void
  removeSection: (id: string) => void
  moveSection: (id: string, dir: 'up' | 'down') => void
  setWorkspaceOpen: (open: boolean) => void
  setViewMode: (mode: 'edit' | 'preview') => void
  // 再入：把方案重绑到给定会话并重开工作台，但【绝不动】sections/products/phase/seeded。
  // 「返回」后重新进入时调它——哪怕中途切过会话致 sessionId 与前台漂移、或误点别的场景
  // 卡致 active 被关，reopen 都把方案重绑到【当前前台会话】再打开，草稿原样保留。这是
  // 「再入永不丢草稿」的落点，取代旧的「条件不满足就 start()」——start 会清空 sections。
  reopen: (sessionId: string) => void
  // 退出方案模式但【保留草稿数据】：切到别的场景卡时用。关掉 active/workspaceOpen 以防
  // proposalMode 泄漏进普通会话，但 sections/products/phase 原样留存，仍可由 reopen 再入。
  // 与 reset 的区别：reset 是用户显式丢弃（彻底清空），leaveMode 只是「收起、不丢」。
  leaveMode: () => void
  // 从已保存的 transcript 重建草稿（app 重启 / 打开历史方案会话时用）。草稿正文都带哨兵
  // 存进了会话 JSONL，但 sections 只活在内存、从不持久化——故重开历史会话需据 transcript
  // 重建。整体替换当前草稿状态并接管工作台；调用方（FusionRuntimeProvider）已前置判断
  // 「内存里没有该会话的未保存草稿」才调它，故这里直接 set、不合并。products 无法从
  // transcript 还原（发送时才 matchProducts）→ 置空 + seeded=true（不再中途重匹配）；
  // consumedDraftIds 填入所有已归档消息 id，使它们若再触发 live 'end' 不被二次累积。
  restoreFromTranscript: (payload: {
    sessionId: string
    sections: ProposalSection[]
    consumedDraftIds: Set<string>
    phase: ProposalKind
  }) => void
  // 从磁盘持久草稿恢复（载入优先级第 2 级，盘上有记录时用）。整体替换草稿状态并接管
  // 工作台。products/phase/sections 全来自盘上（含用户手改）；consumedDraftIds 置空集
  // （单次运行内去重即可，resume 不重放历史 end）；seeded=true 不再中途重匹配产品。
  restoreFromDisk: (record: ProposalDraftRecord) => void
  reset: () => void
}

/**
 * 草稿块 → 节工厂：注入给 appendDraftBlocks（shared 不依赖 crypto）。生成稳定 id（React key），
 * 把 AI 产出原文记进 baselineMarkdown（M-0 可交付率代理基准，后续 updateSection 不动它），
 * 截断恢复的残块带 truncated:true（面板打「疑似截断」徽标）。appendSections 与 syncSections 共用。
 */
const makeDraftSection = (
  block: ProposalDraftBlock,
  opts: { truncated?: boolean }
): ProposalSection => ({
  id: crypto.randomUUID(),
  markdown: block.markdown,
  kind: block.kind,
  baselineMarkdown: block.markdown,
  ...(opts.truncated ? { truncated: true } : {})
})

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  sessionId: null,
  products: [],
  seeded: false,
  consumedDraftIds: new Set(),
  sections: [],
  phase: 'cover',
  workspaceOpen: false,
  viewMode: 'preview',
  stageSkip: null,
  pendingRevision: null,
  pendingGapFill: null,
  blockReviews: {},
  revisionQueue: [],
  revisionQueueNotice: null,
  imageReviews: [],
  genImageJobs: {},
  draftSaveFailed: false,
  start: (sessionId) =>
    set({
      active: true,
      sessionId,
      products: [],
      seeded: false,
      consumedDraftIds: new Set(),
      sections: [],
      phase: 'cover',
      workspaceOpen: true,
      viewMode: 'preview',
      stageSkip: null,
      pendingRevision: null,
      pendingGapFill: null,
      blockReviews: {},
      revisionQueue: [],
      revisionQueueNotice: null,
      imageReviews: [],
      genImageJobs: {},
      draftSaveFailed: false
    }),
  setProducts: (products) => set({ products }),
  seedProducts: (products) => set({ products, seeded: true }),
  markDraftConsumed: (messageId) =>
    set((s) => {
      const next = new Set(s.consumedDraftIds)
      next.add(messageId)
      return { consumedDraftIds: next }
    }),
  appendSections: (messageId, blocks, truncated) =>
    set((s) => {
      // 消息级去重：end 对同一 messageId 二次触发时不重复入节（沿用原 consumedDraftIds 语义）。
      // 内容级幂等兜底（同 kind+markdown 去重）由 appendDraftBlocks 内部承担，故 messageId 去重
      // 失效（restoreFromDisk 清空 + SDK resume 重放）时仍不会重复入节。
      if (s.consumedDraftIds.has(messageId)) return s
      const consumed = new Set(s.consumedDraftIds)
      consumed.add(messageId)
      // 阶段门护栏 + 内容级去重 + 按阶段序归并，全在 appendDraftBlocks 里（shared，与 syncSections
      // 同源）。这里只额外做 messageId 记账——轮末 'end' 的权威入库路径。
      const next = appendDraftBlocks(s, blocks, truncated ?? null, makeDraftSection)
      return {
        sections: next.sections,
        consumedDraftIds: consumed,
        phase: next.phase,
        stageSkip: next.stageSkip
      }
    }),
  syncSections: (blocks) =>
    set((s) => {
      // 轮内增量同步：AI 在一个 SDK 轮里生成封面/目录后用 AskUserQuestion 暂停确认，该轮的
      // 'end'（appendSections 的触发点）要等模型彻底停下才到——期间右侧草稿一直空（用户报的
      // 「对话说生成封面了、右侧还是空的」根因，详见 shared/proposal.ts appendDraftBlocks 注释）。
      // 故在每次 AskUserQuestion 暂停时即时同步当前已闭合的哨兵块进草稿。
      //
      // 【不消费 messageId】：同一条消息后续还会产出目录/正文，轮末 appendSections 仍要按该
      // messageId 处理余下的块；本方法只靠 appendDraftBlocks 的内容级去重保证不重复入节。
      // 【pendingRevision 态下不介入】：那是「下一轮 content 整节替换某节」的定向修订流，由 end
      // 分流（reviseSection）处理；此时轮内 append 会把修订产出错当新节追加，与替换冲突。
      // 【截断残文传 null】：半截内容轮末才正式入库，轮内当节加会在闭合后重复（见 reducer 注释）。
      if (!s.active || s.pendingRevision) return s
      const next = appendDraftBlocks(s, blocks, null, makeDraftSection)
      return { sections: next.sections, phase: next.phase, stageSkip: next.stageSkip }
    }),
  advancePhase: (to) => set({ phase: to }),
  clearStageSkip: () => set({ stageSkip: null }),
  setPendingRevision: (pending) => set({ pendingRevision: pending }),
  setPendingGapFill: (pending) => set({ pendingGapFill: pending }),
  addBlockReview: (messageId, review) =>
    set((s) => ({ blockReviews: { ...s.blockReviews, [messageId]: review } })),
  removeBlockReview: (messageId) =>
    set((s) => {
      if (!(messageId in s.blockReviews)) return s
      const next = { ...s.blockReviews }
      delete next[messageId]
      return { blockReviews: next }
    }),
  enqueueRevision: (item) => {
    const id = crypto.randomUUID()
    set((s) => ({ revisionQueue: [...s.revisionQueue, { ...item, id }] }))
    return id
  },
  dequeueRevision: () => {
    let head: QueuedRevision | null = null
    set((s) => {
      if (s.revisionQueue.length === 0) return s
      head = s.revisionQueue[0]
      return { revisionQueue: s.revisionQueue.slice(1) }
    })
    return head
  },
  removeRevision: (id) =>
    set((s) => {
      const next = s.revisionQueue.filter((r) => r.id !== id)
      if (next.length === s.revisionQueue.length) return s
      return { revisionQueue: next }
    }),
  clearRevisionQueue: () => set({ revisionQueue: [] }),
  setRevisionQueueNotice: (notice) => set({ revisionQueueNotice: notice }),
  addImageReview: (review) => {
    const id = crypto.randomUUID()
    set((s) => ({ imageReviews: [...s.imageReviews, { ...review, id }] }))
    return id
  },
  removeImageReview: (id) =>
    set((s) => ({ imageReviews: s.imageReviews.filter((r) => r.id !== id) })),
  setGenImageJob: (key, job) =>
    set((s) => ({ genImageJobs: { ...s.genImageJobs, [key]: job } })),
  onGenImageDirectiveRemoved: (sectionId, raw, occurrence) =>
    set((s) => {
      // ① 兄弟审阅卡重编号：块少了一个，更靠后的同内容实例整体前移一位。
      const reviews = s.imageReviews.map((r) =>
        r.mode === 'directive' &&
        r.sectionId === sectionId &&
        r.directiveRaw === raw &&
        (r.directiveOccurrence ?? 0) > occurrence
          ? { ...r, directiveOccurrence: (r.directiveOccurrence ?? 0) - 1 }
          : r
      )
      // ② 删 (sectionId, raw) 下 occurrence 最大的任务键。删「最大」而非「被移除的那个」：
      // 幸存块重编号后落在 0..n-2，恰好继续命中原有低序键（状态与内容都同源，任意实例互换
      // 语义等价——同内容指令生成的图只差随机种子）；被腾出的最高序键才是真正失配的那个。
      // 代价是并发在飞的最高序 fire 回调可能把键再写回来（孤儿键，只多占一格配额），比起
      // done 残键永久锁死自动发起 + 卡片挂错误文案，取前者。
      const h = genImageRawHash(raw)
      const prefix = `${sectionId}#`
      const suffix = `#${h}`
      let maxKey: string | null = null
      let maxOcc = -1
      for (const k of Object.keys(s.genImageJobs)) {
        if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue
        const occ = Number(k.slice(prefix.length, k.length - suffix.length))
        if (Number.isInteger(occ) && occ > maxOcc) {
          maxOcc = occ
          maxKey = k
        }
      }
      if (maxKey === null) return { imageReviews: reviews }
      const jobs = { ...s.genImageJobs }
      delete jobs[maxKey]
      return { imageReviews: reviews, genImageJobs: jobs }
    }),
  setDraftSaveFailed: (failed) => set({ draftSaveFailed: failed }),
  reviseSection: (id, markdown) =>
    set((s) => ({
      sections: s.sections.map((sec) =>
        sec.id === id
          ? { ...sec, markdown, baselineMarkdown: markdown, verification: undefined, truncated: false }
          : sec
      )
    })),
  updateSection: (id, markdown) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.id === id ? { ...sec, markdown } : sec))
    })),
  setSectionVerification: (id, verification) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.id === id ? { ...sec, verification } : sec))
    })),
  // 删节要连带清掉挂在该节上的待审阅改图项（Finding 4）：imageReviews 靠 sectionId 关联章节，
  // 节被删后若不过滤，孤儿 review 会继续渲染对照卡——「应用」时 applyImageReview 的
  // `sections.find` 落空、静默清项（表现尚可），但「放弃」前它会一直挂在 UI 上指向一个已经
  // 不存在的节，属于状态不一致，删节这一步就该顺手清干净。blockReviews 以 messageId 为键、
  // 不含 sectionId 关联，不受此次修复影响。
  removeSection: (id) =>
    set((s) => {
      // genImageJobs 键 = `${sectionId}#...`（见 GenImageJob 顶注/genImageDirectiveKey），
      // 节删除后同 imageReviews 一并清理挂在该节上的任务态，避免孤儿键误判为「已发起过」。
      const jobs: Record<string, GenImageJob> = {}
      for (const [k, v] of Object.entries(s.genImageJobs)) {
        if (!k.startsWith(`${id}#`)) jobs[k] = v
      }
      return {
        sections: s.sections.filter((sec) => sec.id !== id),
        imageReviews: s.imageReviews.filter((r) => r.sectionId !== id),
        genImageJobs: jobs
      }
    }),
  moveSection: (id, dir) =>
    set((s) => {
      const i = s.sections.findIndex((sec) => sec.id === id)
      if (i < 0) return s
      const j = dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= s.sections.length) return s // 越界 no-op
      // 仅允许同 kind 组内移动：sections 天然按 kind 连续（appendSections 按阶段顺序
      // 追加，phase 只前进），跨 kind 交换会打破「同 kind 连续」不变量，进而让
      // buildProposalMarkdown 在错误边界插分页、ProposalPaper 出现两个不相邻的同 kind
      // 分区标题（评审发现 1）。封面/目录/正文是有序阶段，跨区移动一节本就无意义，
      // 故邻居 kind 不同时 no-op；同 kind 内交换则保持连续性。
      if (s.sections[i].kind !== s.sections[j].kind) return s
      const next = s.sections.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return { sections: next }
    }),
  setWorkspaceOpen: (open) => set({ workspaceOpen: open }),
  setViewMode: (mode) => set({ viewMode: mode }),
  // 再入清陈旧跳阶提示：stageSkip 描述「刚发生的一次跳阶」，再入一个旧会话时无意义。
  // genImageJobs 刻意【不】清（与 imageReviews 不对称）：imageReviews 是「未决提议」，跨离开/
  // 再入不该留存；genImageJobs 是【幂等记录】，生命周期必须跟随 sections——sections 在
  // reopen/leaveMode 存活，job 表就必须存活，否则未应用的旧指令块会在同会话下一次 end/
  // inflight-sync 被当新指令自动重发（重复扣费+重复审阅卡）。start/reset/restoreFromTranscript/
  // restoreFromDisk 四处照旧清空（那些路径 sections 也被清/重建，section id 全新，旧键本就成孤儿）。
  // 这个不对称也有代价：job 已 done 但 imageReviews 被清空时，对应审阅卡（连同它绑定的
  // resultPath）会一并丢失、搁浅成「说已完成却无卡可审」。由指令块卡片的「重新生成」兜底
  // （见 GenImageDirectiveCard 的 hasReview 分支），不在这里另开状态机。
  reopen: (sessionId) =>
    set({
      active: true,
      sessionId,
      workspaceOpen: true,
      stageSkip: null,
      pendingRevision: null,
      pendingGapFill: null,
      blockReviews: {},
      revisionQueue: [],
      revisionQueueNotice: null,
      imageReviews: []
    }),
  // genImageJobs 不清的理由同 reopen（幂等记录随 sections 存活，防再入后旧指令自动重发）。
  leaveMode: () =>
    set({
      active: false,
      workspaceOpen: false,
      pendingRevision: null,
      pendingGapFill: null,
      blockReviews: {},
      revisionQueue: [],
      revisionQueueNotice: null,
      imageReviews: []
    }),
  restoreFromTranscript: ({ sessionId, sections, consumedDraftIds, phase }) => {
    // 重建时无从知晓 AI 原文，以重建出的 markdown 作埋点基准（编辑量从重开后算起）。
    // collapseSingletonSections：transcript 含历史多版封面/目录（用户调整过）时只留最后一版，
    // 否则重建出两份封面（实时路径已修、重建路径会复发的根因）。sortSectionsByKind：折叠后再
    // 按阶段序归并回区段，保「同 kind 连续」不变量。
    const finalSections = sortSectionsByKind(
      collapseSingletonSections(
        sections.map((s) => ({ ...s, baselineMarkdown: s.baselineMarkdown ?? s.markdown }))
      )
    )
    set({
      active: true,
      sessionId,
      products: [],
      seeded: true,
      consumedDraftIds,
      sections: finalSections,
      phase,
      workspaceOpen: true,
      viewMode: 'preview',
      stageSkip: null,
      pendingRevision: null,
      pendingGapFill: null,
      blockReviews: {},
      revisionQueue: [],
      revisionQueueNotice: null,
      imageReviews: [],
      // 对【最终放进 state 的那份 sections】（折叠+归并之后）预登记 manual 哨兵（终审 I-1）——
      // 若对折叠前的数组登记，被 collapseSingletonSections 丢弃的旧版封面/目录键会成孤儿，
      // 而幸存下来的那份反而没有键、下一轮 end 仍会被 autoFire 误当新块补发生图。
      genImageJobs: seedManualGenImageJobs(finalSections),
      draftSaveFailed: false
    })
  },
  restoreFromDisk: (record) => {
    // 盘上不存 baselineMarkdown（不持久化）；以盘载 markdown 作埋点基准，编辑量从本次重开算起。
    // collapseSingletonSections：旧版本遗留的脏草稿（盘上已存两份封面/目录）恢复时折叠成最后一版；
    // sortSectionsByKind：折叠后再按阶段序归并回区段，保「同 kind 连续」不变量。
    const finalSections = sortSectionsByKind(
      collapseSingletonSections(record.sections.map((s) => ({ ...s, baselineMarkdown: s.markdown })))
    )
    set({
      active: true,
      sessionId: record.sessionId,
      products: record.products,
      seeded: true,
      consumedDraftIds: new Set(),
      sections: finalSections,
      phase: record.phase,
      workspaceOpen: true,
      viewMode: 'preview',
      stageSkip: null,
      pendingRevision: null,
      pendingGapFill: null,
      blockReviews: {},
      revisionQueue: [],
      revisionQueueNotice: null,
      imageReviews: [],
      // 同 restoreFromTranscript：必须对折叠+归并后的最终 sections 预登记，避免孤儿键/漏登记。
      genImageJobs: seedManualGenImageJobs(finalSections),
      draftSaveFailed: false
    })
  },
  reset: () =>
    set({
      active: false,
      sessionId: null,
      products: [],
      seeded: false,
      consumedDraftIds: new Set(),
      sections: [],
      phase: 'cover',
      workspaceOpen: false,
      viewMode: 'preview',
      stageSkip: null,
      pendingRevision: null,
      pendingGapFill: null,
      blockReviews: {},
      revisionQueue: [],
      revisionQueueNotice: null,
      imageReviews: [],
      genImageJobs: {},
      draftSaveFailed: false
    })
}))

/**
 * 方案 UI 是否应对【当前前台会话】显示。
 *
 * `active` 只说明「存在一个方案会话」，但一个 tab 内可切换前台会话——若只看
 * `active`，切到别的（普通）会话后右栏 Todos/工作区仍被隐藏、草稿面板还显示着
 * 旧会话的内容（评审 #8）。所以必须再校验方案绑定的 sessionId 与 chat store 的
 * 前台 sessionId 一致。null（尚无会话）一律为 false。
 *
 * 跨 store 派生：chat.ts 不 import 本文件，单向依赖无环。布局（App.tsx 隐藏右栏）
 * 与面板（ProposalDocPanel 是否渲染）都用它，保证两者同进同出、不会一个显一个藏。
 */
export function useProposalForeground(): boolean {
  const active = useProposalStore((s) => s.active)
  const proposalSid = useProposalStore((s) => s.sessionId)
  const foregroundSid = useChatStore((s) => s.sessionId)
  return active && proposalSid !== null && proposalSid === foregroundSid
}

/**
 * 方案工作台是否应接管布局。在「前台是方案会话」(useProposalForeground) 之上再叠加
 * workspaceOpen——「返回」把 workspaceOpen 置 false 即退出接管、回到正常三栏，但
 * sections/products 仍在，可由再入按钮重新打开。与 useProposalForeground 分离，确保
 * 「返回」不等于销毁草稿。
 */
export function useProposalWorkspace(): boolean {
  const foreground = useProposalForeground()
  const open = useProposalStore((s) => s.workspaceOpen)
  return foreground && open
}
