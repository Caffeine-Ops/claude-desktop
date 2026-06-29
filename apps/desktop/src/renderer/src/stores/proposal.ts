import { create } from 'zustand'

import type { ProposalDraftBlock, ProposalKind, SectionVerification } from '@shared/proposal'
import {
  gateDraftBlocksByPhase,
  isDraftBlockAheadOfPhase,
  laterPhase,
  sortSectionsByKind
} from '@shared/proposal'
import type { ProposalDraftRecord } from '@shared/ipc-channels'
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
  // 定向修订指针：非空时，下一轮 end 的 content 产出【整节替换】该 section（而非 append
  // 新节）。节修订（重写/展开/精简）、据来源修正、截断续写三处共用。瞬时 UI 信号，不
  // 持久化、不进 ProposalDraftRecord——它描述「刚发起的一次定向修订」，重开会话无意义。
  pendingRevision: { sectionId: string } | null
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
  // 推进到目标阶段（cover→toc→content）。只改 phase，不动 sections——已生成的封面/
  // 目录节保持原 kind。按钮在调用本方法后另发推进消息给 AI。
  advancePhase: (to: ProposalKind) => void
  // 清除阶段门拦截提示（用户点关闭、或阶段推进动作 confirmCover/confirmToc 调用以抹掉
  // 陈旧提示）。
  clearStageSkip: () => void
  // 标记/清除「下一轮产出要替换哪一节」。reviseProposalSection 发起修订前置，end 分流后清。
  setPendingRevision: (sectionId: string | null) => void
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
      if (s.consumedDraftIds.has(messageId)) return s
      const consumed = new Set(s.consumedDraftIds)
      consumed.add(messageId)
      // 阶段门护栏：剔除越过「目录确认门」（唯一被 gate 的转换 toc→content）的正文块——
      // AI 在 cover/toc 阶段自行吐 content（用户点「生成目录」后 AI 直接冒正文）时，这些块
      // 【不入文档、不推进 phase】，只把被拦数记进 stageSkip 供面板提示用户先生成确认目录。
      // 没有这道门时，越界 content 块会被「取 max 自动推进」一把把 phase 顶到 content，目录
      // 确认按钮与 confirmToc 的目录回灌全被绕过、目录整段被跳（本次根因）。cover→toc 不是
      // 门，仍允许 AI 哨兵自动推进（聊天驱动封面→目录是设计内行为）；gate 内部据此放行。
      const gate = gateDraftBlocksByPhase(s.phase, blocks)
      let skipped = gate.skippedAhead.length
      // P3-4 内容级幂等兜底：messageId 去重（上面那行）只在【单次运行内】有效——restoreFromDisk
      // 重开会话时 consumedDraftIds 被清空（盘上不存 messageId），若 SDK resume 意外重放某条历史
      // assistant 'end'，messageId 去重会漏、同一段正文被二次 append 成重复节。再加一道「同 kind 且
      // markdown 逐字相同」的块级防线：方案写作里两节正文逐字一致几乎不可能是有意产出，故可安全
      // 当作重放丢弃。key 用 NUL 连接 kind 与 markdown（正文不含 NUL，绝不会把不同内容误判同一）。
      const dupKey = (kind: ProposalKind, markdown: string): string => `${kind}\u0000${markdown}`
      const existingKeys = new Set(s.sections.map((sec) => dupKey(sec.kind, sec.markdown)))
      // kind 取自每个哨兵块自带的标签（AI 在哨兵里声明封面/目录/正文），不再取自全局 phase。
      // 这样无论用户走右侧按钮还是直接在聊天里驱动阶段，草稿都按内容真实归档。
      // baselineMarkdown 在此设为 AI 产出原文，作 M-0 可交付率代理基准（后续 updateSection 不动它）。
      const added: ProposalSection[] = gate.accepted
        .filter((b) => !existingKeys.has(dupKey(b.kind, b.markdown)))
        .map((b) => ({
          id: crypto.randomUUID(),
          markdown: b.markdown,
          kind: b.kind,
          baselineMarkdown: b.markdown
        }))
      // phase 取 gate 算出的「绝不跨门」目标；再叠上被接受的截断残块（laterPhase 不回退）。
      // 截断的越界正文（AI 在目录阶段写了未闭合的正文哨兵）同样被门拦下、记入 skipped。
      let phase = gate.nextPhase
      if (truncated && !existingKeys.has(dupKey(truncated.kind, truncated.markdown))) {
        // 截断残块同样过内容级去重（P3-4）：resume 重放时半截正文也可能二次到达。
        if (isDraftBlockAheadOfPhase(s.phase, truncated.kind)) {
          skipped += 1
        } else {
          added.push({
            id: crypto.randomUUID(),
            markdown: truncated.markdown,
            kind: truncated.kind,
            truncated: true,
            baselineMarkdown: truncated.markdown
          })
          phase = laterPhase(phase, truncated.kind)
        }
      }
      return {
        // sortSectionsByKind：把追加块按阶段序归并回各自区段，维持「同 kind 连续」不变量——
        // 正文阶段 AI 回发的封面块（不被阶段门拦）若直接追加到末尾，会让 buildProposalMarkdown
        // 产生两个封面分节、ProposalPaper 出现两个封面组头、moveSection 失效（评审发现）。稳定
        // 排序，故同 kind 内既有顺序（逐章正文、用户 moveSection 的调整）保持不变。
        sections: sortSectionsByKind([...s.sections, ...added]),
        consumedDraftIds: consumed,
        phase,
        // 本轮有越界块被拦才更新提示；否则保留既有 stageSkip（不被无关轮次悄悄清掉，
        // 由用户关闭或阶段推进动作 confirmCover/confirmToc 清）。
        stageSkip: skipped > 0 ? { count: skipped } : s.stageSkip
      }
    }),
  advancePhase: (to) => set({ phase: to }),
  clearStageSkip: () => set({ stageSkip: null }),
  setPendingRevision: (sectionId) =>
    set({ pendingRevision: sectionId ? { sectionId } : null }),
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
  removeSection: (id) =>
    set((s) => ({ sections: s.sections.filter((sec) => sec.id !== id) })),
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
  reopen: (sessionId) =>
    set({ active: true, sessionId, workspaceOpen: true, stageSkip: null, pendingRevision: null }),
  leaveMode: () => set({ active: false, workspaceOpen: false, pendingRevision: null }),
  restoreFromTranscript: ({ sessionId, sections, consumedDraftIds, phase }) =>
    set({
      active: true,
      sessionId,
      products: [],
      seeded: true,
      consumedDraftIds,
      // 重建时无从知晓 AI 原文，以重建出的 markdown 作埋点基准（编辑量从重开后算起）。
      // sortSectionsByKind 加固：历史 transcript 若含非连续 kind 也归并回区段，保不变量。
      sections: sortSectionsByKind(
        sections.map((s) => ({ ...s, baselineMarkdown: s.baselineMarkdown ?? s.markdown }))
      ),
      phase,
      workspaceOpen: true,
      viewMode: 'preview',
      stageSkip: null,
      pendingRevision: null,
      draftSaveFailed: false
    }),
  restoreFromDisk: (record) =>
    set({
      active: true,
      sessionId: record.sessionId,
      products: record.products,
      seeded: true,
      consumedDraftIds: new Set(),
      // 盘上不存 baselineMarkdown（不持久化）；以盘载 markdown 作埋点基准，编辑量从本次重开算起。
      // sortSectionsByKind 加固：盘载历史若含非连续 kind 也归并回区段，保不变量。
      sections: sortSectionsByKind(
        record.sections.map((s) => ({ ...s, baselineMarkdown: s.markdown }))
      ),
      phase: record.phase,
      workspaceOpen: true,
      viewMode: 'preview',
      stageSkip: null,
      pendingRevision: null,
      draftSaveFailed: false
    }),
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
